import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

function jsonEnv(name) {
  const value = process.env[name];
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}
function artifact(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return readFileSync(path, 'utf8').trim(); }
}
try {
  const root = process.env.TF_MVP_WORKTREE_CWD || process.cwd();
  const dir = join(root, '.taskflow-mvp');
  const taskId = process.env.TF_MVP_TASK_ID || artifact(join(dir, 'task.json'))?.id || '';
  const worker = artifact(join(dir, 'worker.json'));
  const blockersData = artifact(join(dir, 'blockers-final.json')) || artifact(join(dir, 'blockers.json'));
  const gates = process.env.TF_MVP_GATES_OUTPUT || artifact(join(dir, 'gates.log')) || '';
  const recheck = process.env.TF_MVP_RECHECK_OUTPUT || '';
  const commit = process.env.TF_MVP_COMMIT || (existsSync(join(dir, 'merge-commit.txt')) ? readFileSync(join(dir, 'merge-commit.txt'), 'utf8').trim() : '');
  const blockers = Array.isArray(blockersData?.blockers) ? blockersData.blockers : [];
  let mergeVerified = false;
  if (commit) {
    const repo = process.env.TF_MVP_REPO || root;
    const branch = process.env.TF_MVP_BRANCH || '';
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: repo, encoding: 'utf8', shell: false, windowsHide: true });
    const subject = spawnSync('git', ['log', '-1', '--format=%s', commit], { cwd: repo, encoding: 'utf8', shell: false, windowsHide: true });
    const identity = spawnSync('git', ['rev-parse', `${commit}^{commit}`], { cwd: repo, encoding: 'utf8', shell: false, windowsHide: true });
    const owner = artifact(join(dir, 'bd-owner.json'));
    mergeVerified = !ancestor.error && ancestor.status === 0
      && !subject.error && subject.status === 0
      && !identity.error && identity.status === 0 && identity.stdout.trim() === commit
      && subject.stdout.includes(`Merge branch '${branch}'`)
      && owner?.closed === true
      && owner?.commit === commit;
  }
  const status = mergeVerified ? 'merged' : blockersData?.needsFix ? 'blocked' : 'failed';
  const report = {
    taskId,
    status,
    commit,
    merged: status === 'merged',
    bdClosed: Boolean(artifact(join(dir, 'bd-owner.json'))?.closed) && mergeVerified,
    blockers,
    needsAttention: status === 'merged' ? null : (blockers.join('; ') || worker?.error || String(gates || recheck || 'Taskflow did not complete successfully')),
    freshTokens: Number(process.env.TF_MVP_FRESH_TOKENS || 0),
    cacheReadTokens: Number(process.env.TF_MVP_CACHE_READ_TOKENS || 0)
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report));
} catch (e) { console.error(`REPORT FAIL: ${e.message}`); process.exit(1); }
