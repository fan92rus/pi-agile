import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { hasConflictMarkers, resolveUnionConflicts } from './merge-resolution.mjs';

function run(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `git exited ${r.status}`).trim());
  return r.stdout.trim();
}
function runAllow(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  if (r.error) throw r.error;
  return r;
}
function test(command, cwd) {
  const parts = command.match(/(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|\S+)/g) || [];
  const args = parts.slice(1).map(part => part.replace(/^(?:"([\\s\\S]*)"|'([\\s\\S]*)')$/, '$1$2'));
  if (!parts.length) throw new Error('testCommand is empty');
  const executable = parts[0].replace(/^(?:"([\\s\\S]*)"|'([\\s\\S]*)')$/, '$1$2');
  const spawnExecutable = process.platform === 'win32' && executable === 'npm' ? 'npm.cmd' : executable;
  const useShell = process.platform === 'win32' && spawnExecutable.endsWith('.cmd');
  const r = spawnSync(spawnExecutable, args, { cwd, encoding: 'utf8', shell: useShell, windowsHide: true });
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
  // bd close/export can leave .beads staged or unstaged even under the lock.
  // Commit it before merging so git merge never refuses to overwrite it.
  if (runAllow(['status', '--porcelain', '--', '.beads/'], repo).stdout.trim()) {
    run(['add', '--', '.beads/'], repo);
    run(['commit', '-m', 'chore(bd): export issues before merge'], repo);
  }
  run(['rebase', baseSha], worktree);
  test(command, worktree);
  const merged = runAllow(['merge', '--no-edit', '--no-ff', branch], repo);
  if (merged.status !== 0) {
    const conflicts = runAllow(['diff', '--name-only', '--diff-filter=U'], repo).stdout.split(/\r?\n/).filter(Boolean);
    if (conflicts.length) {
      const resolvedFiles = [];
      const unresolved = [];
      for (const file of conflicts) {
        const absolute = join(repo, file);
        let content;
        try { content = readFileSync(absolute, 'utf8'); }
        catch { unresolved.push(file); continue; }
        if (!hasConflictMarkers(content)) { unresolved.push(file); continue; }
        try {
          writeFileSync(absolute, resolveUnionConflicts(content), 'utf8');
          run(['add', '--', file], repo);
          resolvedFiles.push(file);
        } catch { unresolved.push(file); }
      }
      if (resolvedFiles.length) {
        writeFileSync(join(worktree, '.taskflow-mvp', 'merge-resolution.json'), `${JSON.stringify({ status: 'union-resolved', files: resolvedFiles, branch }, null, 2)}\n`, 'utf8');
      }
      if (unresolved.length) {
        writeFileSync(join(worktree, '.taskflow-mvp', 'merge-conflict.json'), `${JSON.stringify({ status: 'conflict', files: unresolved, branch }, null, 2)}\n`, 'utf8');
        runAllow(['merge', '--abort'], repo);
        throw new Error(`unresolved merge conflict in ${unresolved.join(', ')}; resolve manually or rerun a conflict workflow`);
      }
      try { test(command, repo); }
      catch (error) {
        runAllow(['merge', '--abort'], repo);
        throw error;
      }
      const committed = runAllow(['commit', '--no-edit'], repo);
      if (committed.status !== 0) {
        runAllow(['merge', '--abort'], repo);
        throw new Error((committed.stderr || committed.stdout || `git commit exited ${committed.status}`).trim());
      }
    } else {
      throw new Error((merged.stderr || merged.stdout || `git merge exited ${merged.status}`).trim());
    }
  }
  const sha = run(['rev-parse', 'HEAD'], repo);
  mkdirSync(join(worktree, '.taskflow-mvp'), { recursive: true });
  writeFileSync(join(worktree, '.taskflow-mvp', 'merge-commit.txt'), `${sha}\n`, 'utf8');
  process.env.TF_MVP_COMMIT = sha;
  console.log(`MERGE OK ${sha}`);
} catch (e) { console.error(`MERGE FAIL: ${e.message}`); process.exit(1); }
