import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const fail = (message) => { console.error(message); process.exit(1); };
const bdCmd = (process.env.TF_MVP_BD_BIN || 'bd').match(/\S+/g) || ['bd'];
const { TF_MVP_REPO: repo, TF_MVP_WORKTREE_CWD: worktree, TF_MVP_BRANCH: branch, TF_MVP_TASK_ID: taskId, TF_MVP_ACCEPTANCE_FILE: acceptance, TF_MVP_CRITERIA_FILE: criteria } = process.env;
if (![repo, worktree, branch, taskId, acceptance, criteria].every(Boolean)) fail('Missing required TF_MVP_* environment variable');
const run = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
const clean = run(repo, ['status', '--porcelain']);
if (clean.error || clean.status !== 0 || clean.stdout.trim()) fail('Base repo must be clean');
for (const [label, file] of [['taskId', taskId], ['acceptanceFile', acceptance], ['criteriaFile', criteria]]) {
  if (label === 'taskId') {
    const result = spawnSync(bdCmd[0], [...bdCmd.slice(1), 'show', file, '--json'], { cwd: repo, encoding: 'utf8', shell: false, windowsHide: true });
    if (result.error || result.status !== 0) fail(`Task does not exist: ${file}`);
  } else if (!fs.existsSync(file)) fail(`${label} does not exist: ${file}`);
}
if (!fs.existsSync(worktree)) {
  const added = run(repo, ['worktree', 'add', '-b', branch, worktree, 'HEAD']);
  if (added.error || added.status !== 0) fail(`Could not create worktree: ${(added.stderr || added.error?.message || '').trim()}`);
}
const sha = run(repo, ['rev-parse', 'HEAD']);
if (sha.error || sha.status !== 0) fail('Could not resolve base HEAD');
const metadata = path.join(worktree, '.taskflow-mvp');
fs.mkdirSync(metadata, { recursive: true });
fs.writeFileSync(path.join(metadata, 'base-sha.txt'), `${sha.stdout.trim()}\n`, 'utf8');
console.log('PREFLIGHT OK');
