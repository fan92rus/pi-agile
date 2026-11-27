import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

function run(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `git exited ${r.status}`).trim());
  return r.stdout.trim();
}
function fail(message) { console.error(`MERGE GATE FAIL: ${message}`); process.exit(1); }
try {
  const repo = process.env.TF_MVP_REPO;
  const branch = process.env.TF_MVP_BRANCH;
  if (!repo || !branch) throw new Error('TF_MVP_REPO and TF_MVP_BRANCH are required');
  if (run(['status', '--porcelain'], repo)) throw new Error('base repo is not clean');
  const sha = run(['rev-parse', branch], repo);
  const reviewedFile = join(process.env.TF_MVP_WORKTREE_CWD || '', '.taskflow-mvp', 'reviewed-sha.txt');
  const reviewed = existsSync(reviewedFile) ? readFileSync(reviewedFile, 'utf8').trim() : (process.env.TF_MVP_REVIEWED_SHA || '').trim();
  if (!reviewed || sha !== reviewed) throw new Error('branch SHA differs from reviewed SHA');
  if (!/^GATES OK\s*$/m.test(process.env.TF_MVP_GATES_OUTPUT || '')) throw new Error('gates are not OK');
  for (const key of ['TF_MVP_REVIEW2_CORRECTNESS_JSON', 'TF_MVP_REVIEW2_GUARDRAILS_JSON']) {
    const review = JSON.parse(process.env[key] || 'null');
    if (review?.verdict !== 'pass') throw new Error(`${key} verdict is not pass`);
  }
  if (!/^RECHECK OK(?: \(no diff\))?\s*$/m.test(process.env.TF_MVP_RECHECK_OUTPUT || '')) throw new Error('recheck is not OK');
  console.log('MERGE GATE OK');
} catch (e) { fail(e.message); }
