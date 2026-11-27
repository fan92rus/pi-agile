import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const fail = (m) => { console.error(`GATES FAIL: ${m}`); process.exit(1); };
const mode = process.argv[2];
if (!['full', 'quick'].includes(mode)) fail('mode must be full or quick');
const cwd = process.env.TF_MVP_WORKTREE_CWD || process.cwd();
const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
const baseFile = path.join(cwd, '.taskflow-mvp', 'base-sha.txt');
if (!fs.existsSync(baseFile)) fail('base SHA file missing');
const base = fs.readFileSync(baseFile, 'utf8').trim();
const diff = git(['diff', '--name-only', base, '--', '.']);
if (diff.error || diff.status !== 0) fail(`git diff failed: ${diff.stderr || diff.error?.message}`);
const files = diff.stdout.split(/\r?\n/).filter(Boolean).map(s => s.replaceAll('\\', '/'));
const hints = (process.env.TF_MVP_FILES_HINT || '').split(',').map(s => s.trim().replaceAll('\\', '/')).filter(Boolean);
for (const file of files) {
  if (file.startsWith('.beads/') || file.startsWith('.taskflow-mvp/')) fail(`forbidden changed file: ${file}`);
  if (!hints.some(h => file === h || file.startsWith(`${h.replace(/\/$/, '')}/`))) fail(`file outside filesHint: ${file}`);
}
const commits = git(['rev-list', '--count', `${base}..HEAD`]);
if (commits.error || commits.status !== 0 || Number(commits.stdout.trim()) > 0) fail('commits exist above base SHA');
if (mode === 'full') {
  const raw = process.env.TF_MVP_TEST_COMMAND || 'npm test';
  const parts = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const argv = parts.map(s => s.replace(/^(['"])(.*)\1$/, '$2'));
  if (!argv.length) fail('testCommand is empty');
  const executable = process.platform === 'win32' && argv[0] === 'npm' ? 'npm.cmd' : argv[0];
  const useShell = process.platform === 'win32' && executable.endsWith('.cmd');
  const test = spawnSync(executable, argv.slice(1), { cwd, encoding: 'utf8', shell: useShell, windowsHide: true });
  const log = `${test.stdout || ''}${test.stderr || ''}`;
  fs.mkdirSync(path.join(cwd, '.taskflow-mvp'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.taskflow-mvp', 'gates.log'), log, 'utf8');
  if (test.error || test.status !== 0) fail(`tests failed: ${(test.error?.message || `exit ${test.status}`).trim()}`);
}
console.log('GATES OK');
