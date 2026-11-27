import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const fail = (message) => { console.error(`CLEANUP FAIL: ${message}`); process.exit(1); };
const run = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });

try {
  const repo = process.env.TF_MVP_REPO;
  const worktree = process.env.TF_MVP_WORKTREE_CWD;
  const branch = process.env.TF_MVP_BRANCH;
  const taskId = process.env.TF_MVP_TASK_ID || 'leaf';
  if (!repo || !worktree || !branch) throw new Error('TF_MVP_REPO, TF_MVP_WORKTREE_CWD and TF_MVP_BRANCH are required');
  if (!/^(?!\.\.?$)[A-Za-z0-9._-]+$/.test(taskId)) throw new Error(`unsafe task id: ${taskId}`);

  const result = path.join(worktree, '.taskflow-mvp', 'result.json');
  const copied = path.join(repo, '.pi', 'taskflows', 'results', `${taskId}.json`);
  if (!fs.existsSync(result)) throw new Error(`result artifact missing: ${result}`);
  fs.mkdirSync(path.dirname(copied), { recursive: true });
  fs.copyFileSync(result, copied);
  if (!fs.readFileSync(copied).equals(fs.readFileSync(result))) throw new Error('result artifact copy verification failed');

  if (fs.existsSync(worktree)) {
    const removed = run(repo, ['worktree', 'remove', '--force', worktree]);
    if (removed.error || removed.status !== 0) {
      throw new Error((removed.stderr || removed.error?.message || `git worktree remove exited ${removed.status}`).trim());
    }
  }
  const pruned = run(repo, ['worktree', 'prune']);
  if (pruned.error || pruned.status !== 0) {
    throw new Error((pruned.stderr || pruned.error?.message || `git worktree prune exited ${pruned.status}`).trim());
  }
  const dropped = run(repo, ['branch', '-D', branch]);
  if (dropped.error || dropped.status !== 0) {
    const message = (dropped.stderr || dropped.error?.message || '').trim();
    if (!/not found|no such branch/i.test(message)) throw new Error(message || `git branch -D exited ${dropped.status}`);
  }
  console.log('CLEANUP OK');
} catch (e) {
  fail(e.message);
}
