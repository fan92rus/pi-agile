#!/usr/bin/env node
/**
 * Build a campaign flow from bd leaves by reusing the generated one-task MVP.
 *
 * static mode: one saved leaf flow per initial leaf.
 * dynamic mode: a static chain of slots; each slot regenerates its saved flow
 * from the current bd queue, so leaves created during the run can be executed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const fail = (message) => { console.error(`make-campaign-flow: ${message}`); process.exit(1); };
const slash = (p) => String(p).replaceAll('\\', '/');
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) fail(`unexpected argument: ${key}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) fail(`missing value for ${key}`);
    opts[name] = value;
    i += 1;
  }
  return opts;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const campaignDir = here;
const pilotDir = path.resolve(campaignDir, '..');
const leafGenerator = slash(path.join(pilotDir, 'mvp', 'scripts', 'make-task-flow.mjs'));
const reportScript = slash(path.join(campaignDir, 'report.mjs'));
const dynamicReportScript = slash(path.join(campaignDir, 'dynamic-report.mjs'));
const queueInitScript = slash(path.join(campaignDir, 'queue-init.mjs'));
const prepareSlotScript = slash(path.join(campaignDir, 'prepare-slot.mjs'));
const flowProjectRoot = slash(path.resolve(campaignDir, '../../../..'));

const opts = parseArgs(process.argv.slice(2));
const repo = slash(path.resolve(opts.repo || process.cwd()));
const bdBin = opts.bdBin || (process.platform === 'win32' ? 'C:/tools/bd.exe' : 'bd');
const worktreeRoot = slash(path.resolve(opts.worktreeRoot || path.join(path.parse(repo).root, 'tmp', 'tf-campaign-worktrees')));
const mode = opts.mode || 'static';
if (!['static', 'dynamic'].includes(mode)) fail('--mode must be static or dynamic');
const branchPrefix = opts.branchPrefix || 'tf-campaign';
const testCommand = opts.testCommand || 'npm test';
const maxCycles = Number(opts.maxCycles || 3);
if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 20) fail('--maxCycles must be an integer from 1 to 20');
const slots = Number(opts.slots || 10);
if (!Number.isInteger(slots) || slots < 1 || slots > 50) fail('--slots must be an integer from 1 to 50');
const reuseReviewerSession = String(opts.reuseReviewerSession || 'false');
if (!['true', 'false'].includes(reuseReviewerSession)) fail('--reuseReviewerSession must be true or false');
const reviewerModel = opts.reviewerModel || 'opencode-go/hy4-flash-free';
const plannerModel = opts.plannerModel || 'openai-codex/gpt-6-luna';
for (const [label, value] of [['--reviewerModel', reviewerModel], ['--plannerModel', plannerModel]]) {
  if (!/^[^\s]+$/.test(value)) fail(`${label} must be a non-empty model id without whitespace`);
}
const concurrency = Number(opts.concurrency || 3);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) fail('--concurrency must be an integer from 1 to 4');
if (mode === 'dynamic' && concurrency !== 1) fail('--concurrency must be 1 in dynamic mode');
const repoKey = createHash('sha256').update(repo).digest('hex').slice(0, 12);
const mergeLock = slash(path.resolve(opts.mergeLock || path.join(os.tmpdir(), `tf-leaf-mvp-merge-${repoKey}.lock`)));
const name = opts.name || 'tf-campaign-mvp';
if (!/^(?!\.\.?$)[A-Za-z0-9._-]+$/.test(name)) fail('--name contains unsafe characters');
const out = slash(path.resolve(opts.out || path.join(repo, '.pi', 'taskflows', `${name}.json`)));

const bdParts = bdBin.match(/\S+/g) || ['bd'];
function bd(args) {
  const result = spawnSync(bdParts[0], [...bdParts.slice(1), ...args], {
    cwd: repo, encoding: 'utf8', shell: false, windowsHide: true,
  });
  if (result.error || result.status !== 0) fail(`bd ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout;
}
function eligible(row) {
  const description = String(row?.description || '');
  return row?.id && row?.status !== 'closed' && /(?:Files:|Файлы:)/.test(description) && description.includes('Acceptance:');
}

if (opts.tasks && opts.epic) fail('--tasks and --epic cannot be used together');
let tasks;
if (opts.tasks) {
  const taskIds = [...new Set(opts.tasks.split(',').map((id) => id.trim()).filter(Boolean))];
  tasks = taskIds.map((id) => {
      try { return JSON.parse(bd(['show', id, '--json'])); }
      catch { fail(`invalid bd show JSON for ${id}`); }
    })
    .map((row) => Array.isArray(row) ? row[0] : row);
} else if (opts.epic) {
  let children;
  try { children = JSON.parse(bd(['children', opts.epic, '--json'])); }
  catch { fail(`bd children returned invalid JSON for ${opts.epic}`); }
  tasks = (Array.isArray(children) ? children : []).filter((row) => row?.id).filter((row) => {
    let descendants;
    try { descendants = JSON.parse(bd(['children', String(row.id), '--json'])); }
    catch { fail(`bd children returned invalid JSON for ${row.id}`); }
    return Array.isArray(descendants) && descendants.length === 0 && eligible(row);
  });
} else {
  let rows;
  try { rows = JSON.parse(bd(['ready', '--json'])); }
  catch { fail('bd ready returned invalid JSON'); }
  tasks = (Array.isArray(rows) ? rows : []).filter(eligible);
}
for (const row of tasks) {
  if (!eligible(row)) fail(`task ${row?.id || '?'} is not an eligible code leaf`);
}
if (!tasks.length) fail('no eligible bd leaves found');
const taskIds = tasks.map((row) => String(row.id));
for (const taskId of taskIds) {
  if (!/^(?!\.\.?$)[A-Za-z0-9._-]+$/.test(taskId)) fail(`unsafe task id: ${taskId}`);
}

let queueParent = opts.queueParent || opts.epic || '';
if (!queueParent && tasks[0]?.dependencies) {
  const parent = tasks[0].dependencies.find((dep) => dep?.type === 'parent-child' || dep?.dependency_type === 'parent-child');
  if (parent?.id) queueParent = String(parent.id);
}

fs.mkdirSync(path.join(path.parse(out).dir), { recursive: true });
const phases = [];
const flowArgs = {
  taskIds: {
    type: 'string',
    default: taskIds.join(','),
    description: 'CSV of initial campaign task ids',
  },
};

if (mode === 'static') {
  for (const taskId of taskIds) {
    const leafFlowName = `tf-leaf-mvp-${taskId}`;
    const worktree = slash(path.join(worktreeRoot, taskId));
    const genArgs = [
      '--taskId', taskId,
      '--repo', repo,
      '--worktree', worktree,
      '--branch', `${branchPrefix}/${taskId}`,
      '--bdBin', bdBin,
      '--mergeLock', mergeLock,
      '--testCommand', testCommand,
      '--maxCycles', String(maxCycles),
      '--reuseReviewerSession', reuseReviewerSession,
      '--reviewerModel', reviewerModel,
      '--plannerModel', plannerModel,
    ];
    if (queueParent) genArgs.push('--queueParent', queueParent);
    genArgs.push('--out', slash(path.join(repo, '.pi', 'taskflows', `${leafFlowName}.json`)));
    const generated = spawnSync(process.execPath, [leafGenerator, ...genArgs], { cwd: repo, encoding: 'utf8' });
    if (generated.error || generated.status !== 0) fail(`leaf generator failed for ${taskId}: ${(generated.stderr || generated.error?.message || '').trim()}`);
    phases.push({
      id: `leaf-${taskId}`,
      type: 'flow',
      use: leafFlowName,
      with: { repo, worktreeCwd: worktree },
      output: 'json',
    });
  }
  phases.push({
    id: 'campaign-report',
    type: 'script',
    run: ['node', reportScript, repo, '{args.taskIds}', name, flowProjectRoot],
    timeout: 60000,
    dependsOn: phases.map((phase) => phase.id),
    final: true,
  });
} else {
  const slotArtifactDir = slash(path.join(repo, '.pi', 'taskflows', `slots-${name}`));
  const queuePath = slash(path.join(repo, '.pi', 'taskflows', `queue-${name}.json`));
  const decisionDir = slash(path.join(flowProjectRoot, '.pi', 'taskflows', 'lead-decisions'));
  const configPath = slash(path.join(slotArtifactDir, 'config.json'));
  const slotsNames = Array.from({ length: slots }, (_, index) => `tf-dynamic-slot-${name}-${index}`);
  const config = {
    name, mode, repo, bdBin, worktreeRoot, branchPrefix, testCommand, maxCycles,
    slots: slotsNames, slotsCount: slots, reuseReviewerSession, reviewerModel,
    plannerModel, mergeLock, queueParent, queuePath, decisionDir, flowProjectRoot,
    leafGenerator, queueInitScript, prepareSlotScript, dynamicReportScript,
    slotArtifactDir, initialTasks: taskIds,
  };
  fs.mkdirSync(slotArtifactDir, { recursive: true });
  fs.mkdirSync(decisionDir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  for (const slotName of slotsNames) {
    const noopFlow = {
      name: slotName,
      phases: [{
        id: 'idle',
        type: 'script',
        run: ['node', '-e', 'console.log(JSON.stringify({status:"idle"}))'],
        output: 'json',
        final: true,
      }],
    };
    fs.writeFileSync(slash(path.join(flowProjectRoot, '.pi', 'taskflows', `${slotName}.json`)), `${JSON.stringify(noopFlow, null, 2)}\n`, 'utf8');
  }
  flowArgs.configPath = { type: 'string', default: configPath, description: 'dynamic campaign config' };
  phases.push({
    id: 'queue-init',
    type: 'script',
    run: ['node', queueInitScript, configPath],
    timeout: 60000,
  });
  let previous = 'queue-init';
  for (let index = 0; index < slots; index += 1) {
    const prepareId = `prepare-slot-${index}`;
    const leafId = `leaf-slot-${index}`;
    phases.push({
      id: prepareId,
      type: 'script',
      run: ['node', prepareSlotScript, configPath, String(index)],
      timeout: 300000,
      dependsOn: [previous],
    });
    phases.push({
      id: leafId,
      type: 'flow',
      use: slotsNames[index],
      with: { repo, worktreeCwd: slash(path.join(worktreeRoot, `slot-${index}`)) },
      output: 'json',
      dependsOn: [prepareId],
    });
    previous = leafId;
  }
  phases.push({
    id: 'campaign-report',
    type: 'script',
    run: ['node', dynamicReportScript, configPath],
    timeout: 60000,
    dependsOn: [previous],
    final: true,
  });
}

const campaignJson = `${JSON.stringify({
  name,
  concurrency: mode === 'dynamic' ? 1 : concurrency,
  strictInterpolation: false,
  args: flowArgs,
  phases,
}, null, 2)}\n`;
fs.writeFileSync(out, campaignJson, 'utf8');
const hostCampaignPath = slash(path.join(flowProjectRoot, '.pi', 'taskflows', `${name}.json`));
if (out !== hostCampaignPath) {
  fs.mkdirSync(path.dirname(hostCampaignPath), { recursive: true });
  fs.writeFileSync(hostCampaignPath, campaignJson, 'utf8');
}
console.log(JSON.stringify({
  flow: out,
  name,
  mode,
  tasks: taskIds,
  slots: mode === 'dynamic' ? slots : null,
  concurrency: mode === 'dynamic' ? 1 : concurrency,
  maxCycles,
  reuseReviewerSession,
  reviewerModel,
  plannerModel,
  queueParent,
  flowProjectRoot,
  worktreeRoot,
  mergeLock,
}, null, 2));
