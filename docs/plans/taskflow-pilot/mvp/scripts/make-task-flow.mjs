#!/usr/bin/env node
/**
 * Generate a taskflow MVP flow for one real bd leaf.
 *
 * Reads `bd show <taskId> --json`, derives filesHint/acceptance/criteria from
 * the issue description, then writes:
 *   - a task-specific final-cycle subflow,
 *   - a task-specific repeat wrapper,
 *   - a task-specific main flow,
 *   - acceptance/criteria artifacts outside the base repo.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const fail = (message) => { console.error(`make-task-flow: ${message}`); process.exit(1); };
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
const mvpDir = path.resolve(here, '..');
const flowProjectRoot = path.resolve(mvpDir, '../../../..');
const opts = parseArgs(process.argv.slice(2));

const taskId = opts.taskId || fail('--taskId is required');
if (!/^(?!\.\.?$)[A-Za-z0-9._-]+$/.test(taskId)) fail('--taskId contains unsafe characters');
const repo = slash(path.resolve(opts.repo || process.cwd()));
const worktree = slash(path.resolve(opts.worktree || fail('--worktree is required')));
const branch = opts.branch || `tf-leaf-mvp/${taskId}`;
const bdBin = opts.bdBin || (process.platform === 'win32' ? 'C:/tools/bd.exe' : 'bd');
const testCommand = opts.testCommand || 'npm test';
const sessionId = opts.sessionId || `tf-leaf-mvp-${taskId}-worker`;
const reviewerCorrectnessSessionId = opts.reviewerCorrectnessSessionId || `tf-leaf-mvp-${taskId}-reviewer-correctness`;
const reviewerGuardrailsSessionId = opts.reviewerGuardrailsSessionId || `tf-leaf-mvp-${taskId}-reviewer-guardrails`;
const maxCycles = Number(opts.maxCycles || 3);
if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 20) fail('--maxCycles must be an integer from 1 to 20');
const reuseReviewerSession = String(opts.reuseReviewerSession || 'true');
if (!['true', 'false'].includes(reuseReviewerSession)) fail('--reuseReviewerSession must be true or false');
const workerModel = opts.workerModel || 'openai-codex/gpt-6-luna';
const reviewerModel = opts.reviewerModel || 'openai-codex/gpt-6-luna';
for (const [label, value] of [['--workerModel', workerModel], ['--reviewerModel', reviewerModel]]) {
  if (!/^[^\s]+$/.test(value)) fail(`${label} must be a non-empty model id without whitespace`);
}
const out = slash(path.resolve(opts.out || path.join(repo, '.pi', 'taskflows', `tf-leaf-mvp-${taskId}.json`)));
const tasksDir = slash(path.join(flowProjectRoot, '.pi', 'taskflows'));
const artifactsDir = slash(path.resolve(opts.artifactsDir || path.join(os.tmpdir(), 'tf-leaf-mvp-real', taskId)));
fs.mkdirSync(artifactsDir, { recursive: true });
fs.mkdirSync(tasksDir, { recursive: true });

const bdParts = bdBin.match(/\S+/g) || ['bd'];
const bdShow = spawnSync(bdParts[0], [...bdParts.slice(1), 'show', taskId, '--json'], {
  cwd: repo, encoding: 'utf8', shell: false, windowsHide: true,
});
if (bdShow.error || bdShow.status !== 0) {
  fail(`bd show failed: ${(bdShow.stderr || bdShow.error?.message || '').trim()}`);
}
let parsed;
try { parsed = JSON.parse(bdShow.stdout); } catch { fail('bd show returned invalid JSON'); }
const issue = Array.isArray(parsed) ? parsed.find((row) => row?.id === taskId) || parsed[0] : parsed;
if (!issue?.id || issue.status === 'closed') fail(`task ${taskId} is missing or already closed`);
const description = String(issue.description || '');
const MARKERS = ['Files:', 'Acceptance:', 'Метод измерения:'];
function field(markers) {
  const found = markers
    .map((marker) => ({ marker, at: description.lastIndexOf(marker) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => b.at - a.at)[0];
  if (!found) return '';
  const rest = description.slice(found.at + found.marker.length);
  const ends = MARKERS.map((marker) => rest.indexOf(marker)).filter((at) => at >= 0);
  return rest.slice(0, ends.length ? Math.min(...ends) : rest.length).trim();
}

const filesHint = opts.filesHint
  || field(['Files:']).replace(/\.$/, '').split(/[,;]/).map((s) => s.trim()).filter(Boolean).join(',')
  || fail('filesHint not provided and no Files: field found in bd description');
const acceptanceClause = field(['Acceptance:']) || fail('no Acceptance: field found in bd description');
const measure = field(['Метод измерения:']);
const acceptanceFile = slash(path.join(artifactsDir, 'acceptance.md'));
const criteriaFile = slash(path.join(artifactsDir, 'criteria.md'));

const acceptance = [
  `# Acceptance — ${taskId}`, '', `- Title: ${issue.title}`, `- Acceptance: ${acceptanceClause}`,
  `- Allowed files: ${filesHint}`, measure ? `- Measurement: ${measure}` : null,
  '- Do not call bd, commit, or push from the worker.', '',
  'Review only the written code criterion. Repository-state and worker-behavior checks belong to deterministic script phases.', '',
].filter((x) => x !== null).join('\n');
const criteria = [
  `# Review criteria — ${taskId}`, '', `1. The implementation satisfies: ${acceptanceClause}`,
  `2. Diff stays within: ${filesHint}.`,
  '3. Use each cycle patch as the authoritative delta; do not call git.',
  '4. No bd calls, commits, pushes, or changes under `.beads/` or `.taskflow-mvp/` appear in the delta.',
  '5. Tests and gates are verified by script phases; do not block on those as reviewer inference.',
  '6. Fix summaries are untrusted hints; verify against files.',
  '7. Return JSON only: {"verdict":"pass|block","blockers":[...],"evidence":["file:line"]}.', '',
].join('\n');
fs.writeFileSync(acceptanceFile, acceptance, 'utf8');
fs.writeFileSync(criteriaFile, criteria, 'utf8');

const runnerPath = slash(path.join(here, 'phase-runner.mjs'));
function loadTemplate(name) {
  let source = fs.readFileSync(path.join(mvpDir, name), 'utf8');
  source = source
    .replaceAll('D:/Documents/Repositories/pi-agile/docs/plans/taskflow-pilot/mvp/scripts/phase-runner.mjs', runnerPath)
    .replaceAll('D:/tmp/tf-leaf-mvp-repo', repo)
    .replaceAll('D:/tmp/tf-leaf-mvp-worktrees/8en', worktree);
  return JSON.parse(source);
}
function sharedDefaults(args) {
  Object.assign(args, {
    worktreeCwd: { ...args.worktreeCwd, default: worktree },
    filesHint: { ...args.filesHint, default: filesHint },
    acceptanceFile: { ...args.acceptanceFile, default: acceptanceFile },
    criteriaFile: { ...args.criteriaFile, default: criteriaFile },
    testCommand: { ...args.testCommand, default: testCommand },
    sessionId: { ...args.sessionId, default: sessionId },
    reviewerCorrectnessSessionId: { ...args.reviewerCorrectnessSessionId, default: reviewerCorrectnessSessionId },
    reviewerGuardrailsSessionId: { ...args.reviewerGuardrailsSessionId, default: reviewerGuardrailsSessionId },
    maxCycles: { ...args.maxCycles, default: String(maxCycles) },
  });
}
function applyModels(flow) {
  for (const phase of flow.phases) {
    if (phase.id === 'work' || phase.id === 'fix' || phase.id === 'final-fix') phase.model = workerModel;
    if (/^review/.test(phase.id)) phase.model = reviewerModel;
  }
}

const cycleName = `mvp-final-cycle-${taskId}`;
const loopName = `mvp-loop-${taskId}`;

const cycleFlow = loadTemplate('final-cycle.json');
cycleFlow.name = cycleName;
sharedDefaults(cycleFlow.args);
applyModels(cycleFlow);
if (reuseReviewerSession === 'false') {
  for (const phase of cycleFlow.phases) {
    if (/^review/.test(phase.id)) delete phase.session;
  }
}
fs.writeFileSync(path.join(tasksDir, `${cycleName}.json`), `${JSON.stringify(cycleFlow, null, 2)}\n`, 'utf8');
if (repo !== slash(flowProjectRoot)) {
  fs.mkdirSync(slash(path.join(repo, '.pi', 'taskflows')), { recursive: true });
  fs.writeFileSync(slash(path.join(repo, '.pi', 'taskflows', `${cycleName}.json`)), `${JSON.stringify(cycleFlow, null, 2)}\n`, 'utf8');
}

const loopFlow = loadTemplate('loop-flow.json');
loopFlow.name = loopName;
loopFlow.phases[0].use = cycleName;
loopFlow.phases[0].repeat.max = maxCycles;
sharedDefaults(loopFlow.args);
fs.writeFileSync(path.join(tasksDir, `${loopName}.json`), `${JSON.stringify(loopFlow, null, 2)}\n`, 'utf8');
if (repo !== slash(flowProjectRoot)) {
  fs.writeFileSync(slash(path.join(repo, '.pi', 'taskflows', `${loopName}.json`)), `${JSON.stringify(loopFlow, null, 2)}\n`, 'utf8');
}

const mainFlow = loadTemplate('flow.json');
mainFlow.name = `tf-leaf-mvp-${taskId}`;
for (const phase of mainFlow.phases) {
  if (phase.id === 'final-cycles') phase.use = loopName;
}
Object.assign(mainFlow.args, {
  taskId: { ...mainFlow.args.taskId, default: taskId },
  repo: { ...mainFlow.args.repo, default: repo },
  worktreeCwd: { ...mainFlow.args.worktreeCwd, default: worktree },
  branch: { ...mainFlow.args.branch, default: branch },
  filesHint: { ...mainFlow.args.filesHint, default: filesHint },
  acceptanceFile: { ...mainFlow.args.acceptanceFile, default: acceptanceFile },
  criteriaFile: { ...mainFlow.args.criteriaFile, default: criteriaFile },
  testCommand: { ...mainFlow.args.testCommand, default: testCommand },
  sessionId: { ...mainFlow.args.sessionId, default: sessionId },
  reviewerCorrectnessSessionId: { ...mainFlow.args.reviewerCorrectnessSessionId, default: reviewerCorrectnessSessionId },
  reviewerGuardrailsSessionId: { ...mainFlow.args.reviewerGuardrailsSessionId, default: reviewerGuardrailsSessionId },
  maxCycles: { ...mainFlow.args.maxCycles, default: String(maxCycles) },
  forceEscalation: { ...mainFlow.args.forceEscalation, default: 'false' },
  bdBin: { ...mainFlow.args.bdBin, default: bdBin },
});
applyModels(mainFlow);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(mainFlow, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  flow: out,
  cycleFlow: slash(path.join(tasksDir, `${cycleName}.json`)),
  loopFlow: slash(path.join(tasksDir, `${loopName}.json`)),
  taskId, repo, worktree, branch, filesHint, acceptanceFile, criteriaFile,
  bdBin, testCommand, maxCycles, repeatMax: loopFlow.phases[0].repeat.max, reuseReviewerSession, workerModel, reviewerModel,
}, null, 2));
