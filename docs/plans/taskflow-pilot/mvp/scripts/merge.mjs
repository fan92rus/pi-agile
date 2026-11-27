import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

function run(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `git exited ${r.status}`).trim());
  return r.stdout.trim();
}
function test(command, cwd) {
  const parts = command.match(/(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|\S+)/g) || [];
  const args = parts.slice(1).map(part => part.replace(/^(?:"([\\s\\S]*)"|'([\\s\\S]*)')$/, '$1$2'));
  if (!parts.length) throw new Error('testCommand is empty');
  const executable = parts[0].replace(/^(?:"([\\s\\S]*)"|'([\\s\\S]*)')$/, '$1$2');
  const r = spawnSync(executable, args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`testCommand failed (${r.status}): ${(r.stderr || r.stdout || '').trim()}`);
}
try {
  const repo = process.env.TF_MVP_REPO;
  const worktree = process.env.TF_MVP_WORKTREE_CWD;
  const branch = process.env.TF_MVP_BRANCH;
  const command = process.env.TF_MVP_TEST_COMMAND || 'npm test';
  if (!repo || !worktree || !branch) throw new Error('TF_MVP_REPO, TF_MVP_WORKTREE_CWD, and TF_MVP_BRANCH are required');
  const baseSha = readFileSync(join(worktree, '.taskflow-mvp', 'base-sha.txt'), 'utf8').trim();
  if (!baseSha) throw new Error('saved base SHA is empty');
  const changed = run(['diff', '--name-only', baseSha, '--', '.'], worktree).split(/\r?\n/).filter(Boolean);
  const forbidden = changed.filter(file => file.startsWith('.beads/') || file.startsWith('.taskflow-mvp/'));
  if (forbidden.length) throw new Error(`forbidden files in merge commit: ${forbidden.join(', ')}`);
  if (changed.length) {
    run(['add', '--', ...changed], worktree);
    run(['commit', '-m', `taskflow MVP: ${process.env.TF_MVP_TASK_ID || 'leaf'}`], worktree);
  }
  const baseBranch = run(['branch', '--show-current'], repo);
  if (!baseBranch) throw new Error('base repo is in detached HEAD state');
  run(['checkout', baseBranch], repo);
  run(['rebase', baseSha], worktree);
  test(command, worktree);
  run(['merge', '--no-edit', '--no-ff', branch], repo);
  const sha = run(['rev-parse', 'HEAD'], repo);
  mkdirSync(join(worktree, '.taskflow-mvp'), { recursive: true });
  writeFileSync(join(worktree, '.taskflow-mvp', 'merge-commit.txt'), `${sha}\n`, 'utf8');
  process.env.TF_MVP_COMMIT = sha;
  console.log(`MERGE OK ${sha}`);
} catch (e) { console.error(`MERGE FAIL: ${e.message}`); process.exit(1); }
