#!/usr/bin/env node
/**
 * Generate a taskflow MVP flow for one real bd leaf.
 *
 * Reads `bd show <taskId> --json`, derives filesHint/acceptance/criteria from
 * the issue description, fills the static flow template and writes a ready
 * flow file plus its input artifacts outside the base repo.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const fail = (message) => { console.error(`make-task-flow: ${message}`); process.exit(1); };

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
const templatePath = path.resolve(here, '..', 'flow.json');
const opts = parseArgs(process.argv.slice(2));

const taskId = opts.taskId || fail('--taskId is required');
const repo = path.resolve(opts.repo || process.cwd()).replaceAll('\\', '/');
const worktree = path.resolve(opts.worktree || fail('--worktree is required')).replaceAll('\\', '/');
const branch = opts.branch || `tf-leaf-mvp/${taskId}`;
const bdBin = opts.bdBin || (process.platform === 'win32' ? 'C:/tools/bd.exe' : 'bd');
const testCommand = opts.testCommand || 'npm test';
const sessionId = opts.sessionId || `tf-leaf-mvp-${taskId}-worker`;
const out = path.resolve(opts.out || path.join(repo, '.pi', 'taskflows', `tf-leaf-mvp-${taskId}.json`)).replaceAll('\\', '/');
const artifactsDir = path.resolve(
  opts.artifactsDir || path.join(os.tmpdir(), 'tf-leaf-mvp-real', taskId),
).replaceAll('\\', '/');
fs.mkdirSync(artifactsDir, { recursive: true });

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
  const ends = MARKERS
    .map((marker) => rest.indexOf(marker))
    .filter((at) => at >= 0);
  return rest.slice(0, ends.length ? Math.min(...ends) : rest.length).trim();
}

const filesHint = opts.filesHint
  || field(['Files:']).replace(/\.$/, '')
      .split(/[,;]/).map((s) => s.trim()).filter(Boolean).join(',')
  || fail('filesHint not provided and no Files: field found in bd description');
const acceptanceClause = field(['Acceptance:']) || fail('no Acceptance: field found in bd description');
const measure = field(['Метод измерения:']);

const acceptanceFile = path.join(artifactsDir, 'acceptance.md').replaceAll('\\', '/');
const criteriaFile = path.join(artifactsDir, 'criteria.md').replaceAll('\\', '/');

const acceptance = [
  `# Acceptance — ${taskId}`,
  '',
  `- Title: ${issue.title}`,
  `- Acceptance: ${acceptanceClause}`,
  `- Allowed files: ${filesHint}`,
  measure ? `- Measurement: ${measure}` : null,
  '- Do not call bd, commit, or push from the worker.',
  '',
  'Review only the written code criterion. Repository-state and worker-behavior checks belong to deterministic script phases.',
  '',
].filter((x) => x !== null).join('\n');
const criteria = [
  `# Review criteria — ${taskId}`,
  '',
  `1. The implementation satisfies: ${acceptanceClause}`,
  `2. Diff stays within: ${filesHint}.`,
  '3. No bd calls, commits, pushes, or changes under `.beads/` or `.taskflow-mvp/` appear in the diff.',
  '4. Tests and gates are verified by script phases; do not block on those as reviewer inference.',
  '5. Return JSON only: {"verdict":"pass|block","blockers":[...],"evidence":["file:line"]}.',
  '',
].join('\n');
fs.writeFileSync(acceptanceFile, acceptance, 'utf8');
fs.writeFileSync(criteriaFile, criteria, 'utf8');

let source = fs.readFileSync(templatePath, 'utf8');
const runnerPath = path.resolve(here, 'phase-runner.mjs').replaceAll('\\', '/');
source = source
  .replaceAll('D:/Documents/Repositories/pi-agile/docs/plans/taskflow-pilot/mvp/scripts/phase-runner.mjs', runnerPath)
  .replaceAll('D:/tmp/tf-leaf-mvp-repo', repo)
  .replaceAll('D:/tmp/tf-leaf-mvp-worktrees/8en', worktree)
  .replace('"name": "tf-leaf-mvp"', `"name": "tf-leaf-mvp-${taskId}"`);
const flow = JSON.parse(source);
Object.assign(flow.args, {
  taskId: { ...flow.args.taskId, default: taskId },
  repo: { ...flow.args.repo, default: repo },
  worktreeCwd: { ...flow.args.worktreeCwd, default: worktree },
  branch: { ...flow.args.branch, default: branch },
  filesHint: { ...flow.args.filesHint, default: filesHint },
  acceptanceFile: { ...flow.args.acceptanceFile, default: acceptanceFile },
  criteriaFile: { ...flow.args.criteriaFile, default: criteriaFile },
  testCommand: { ...flow.args.testCommand, default: testCommand },
  sessionId: { ...flow.args.sessionId, default: sessionId },
  forceEscalation: { ...flow.args.forceEscalation, default: 'false' },
  bdBin: { ...flow.args.bdBin, default: bdBin },
});

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(flow, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  flow: out,
  taskId,
  repo,
  worktree,
  branch,
  filesHint,
  acceptanceFile,
  criteriaFile,
  bdBin,
  testCommand,
}, null, 2));
