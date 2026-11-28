#!/usr/bin/env node
/**
 * Build a campaign flow from bd leaves by reusing the generated one-task MVP.
 *
 * No new execution engine: every leaf is a saved tf-leaf-mvp flow, and the
 * campaign is a Taskflow DAG with one `flow` phase per leaf.
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
const flowProjectRoot = slash(path.resolve(campaignDir, '../../../..'));

const opts = parseArgs(process.argv.slice(2));
const repo = slash(path.resolve(opts.repo || process.cwd()));
const bdBin = opts.bdBin || (process.platform === 'win32' ? 'C:/tools/bd.exe' : 'bd');
const worktreeRoot = slash(path.resolve(opts.worktreeRoot || path.join(repo, '.taskflow-mvp', 'worktrees')));
const mode = opts.mode || 'static';
if (!['static', 'dynamic'].includes(mode)) fail('--mode must be static or dynamic');
const branchPrefix = opts.branchPrefix || 'tf-campaign';
const testCommand = opts.testCommand || 'npm test';
const maxCycles = Number(opts.maxCycles || 3);
if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 20) fail('--maxCycles must be an integer from 1 to 20');
const reuseReviewerSession = String(opts.reuseReviewerSession || 'false');
if (!['true', 'false'].includes(reuseReviewerSession)) fail('--reuseReviewerSession must be true or false');
const reviewerModel = opts.reviewerModel || 'opencode-go/hy4-flash-free';
if (!/^[^\s]+$/.test(reviewerModel)) fail('--reviewerModel must be a non-empty model id without whitespace');
const concurrency = Number(opts.concurrency || 3);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) fail('--concurrency must be an integer from 1 to 4');
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

fs.mkdirSync(path.join(path.parse(out).dir), { recursive: true });
const phases = [];
for (const row of tasks) {
  const taskId = String(row.id);
  if (!/^(?!\.\.?$)[A-Za-z0-9._-]+$/.test(taskId)) fail(`unsafe task id: ${taskId}`);
  const leafFlowName = `tf-leaf-mvp-${taskId}`;
  const worktree = slash(path.join(worktreeRoot, taskId));
  const args = [
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
    '--out', slash(path.join(repo, '.pi', 'taskflows', `${leafFlowName}.json`)),
  ];
  const generated = spawnSync(process.execPath, [leafGenerator, ...args], { cwd: repo, encoding: 'utf8' });
  if (generated.error || generated.status !== 0) fail(`leaf generator failed for ${taskId}: ${(generated.stderr || generated.error?.message || '').trim()}`);
  phases.push({
    id: `leaf-${taskId}`,
    type: 'flow',
    use: leafFlowName,
    with: { repo, worktreeCwd: worktree },
    output: 'json',
  });
}

if (mode === 'dynamic') {
  const queuePath = slash(path.join(repo, '.taskflow-mvp', `queue-${name}.json`));
  const queueInit = slash(path.join(campaignDir, 'queue-init.mjs'));
  const prepareSlot = slash(path.join(campaignDir, 'prepare-slot.mjs'));
  const dynamicReport = slash(path.join(campaignDir, 'dynamic-report.mjs'));
  phases.unshift({ id: 'queue-init', type: 'script', run: ['node', queueInit, queuePath, ...tasks.map((row) => String(row.id))], timeout: 60000 });
  for (let index = 0; index < tasks.length; index += 1) {
    const leafId = `leaf-${tasks[index].id}`;
    const prepareId = `prepare-slot-${index}`;
    const phase = phases.find((entry) => entry.id === leafId);
    phase.with.queuePath = queuePath;
    phase.with.slot = index;
    phase.dependsOn = [prepareId];
    phases.push({ id: prepareId, type: 'script', run: ['node', prepareSlot, queuePath], timeout: 60000, dependsOn: ['queue-init'] });
  }
  phases.push({ id: 'dynamic-report', type: 'script', run: ['node', dynamicReport, queuePath], timeout: 60000, dependsOn: phases.filter((phase) => phase.type === 'flow').map((phase) => phase.id) });
}
const leafIds = phases.filter((phase) => phase.type === 'flow').map((phase) => phase.id);
phases.push({
  id: 'campaign-report',
  type: 'script',
  run: ['node', reportScript, repo, '{args.taskIds}', name, flowProjectRoot],
  timeout: 60000,
  dependsOn: leafIds,
  final: true,
});

const flow = {
  name,
  concurrency,
  strictInterpolation: false,
  args: {
    taskIds: {
      type: 'string',
      default: tasks.map((row) => String(row.id)).join(','),
      description: 'CSV of campaign task ids',
    },
  },
  phases,
};
const campaignJson = `${JSON.stringify(flow, null, 2)}\n`;
fs.writeFileSync(out, campaignJson, 'utf8');
const hostCampaignPath = slash(path.join(flowProjectRoot, '.pi', 'taskflows', `${name}.json`));
if (out !== hostCampaignPath) {
  fs.mkdirSync(path.dirname(hostCampaignPath), { recursive: true });
  fs.writeFileSync(hostCampaignPath, campaignJson, 'utf8');
}
console.log(JSON.stringify({
  flow: out,
  name,
  tasks: tasks.map((row) => String(row.id)),
  concurrency,
  maxCycles,
  reuseReviewerSession,
  reviewerModel,
  flowProjectRoot,
  worktreeRoot,
  mergeLock,
}, null, 2));
