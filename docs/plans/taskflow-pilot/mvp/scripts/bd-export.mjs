import { spawnSync } from 'node:child_process';
import process from 'node:process';

function run(command, args, cwd) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `${command} exited ${r.status}`).trim());
  return r.stdout.trim();
}
const bdCmd = (process.env.TF_MVP_BD_BIN || 'bd').match(/\S+/g) || ['bd'];
const allowedBeadsPath = (p) => p === '.beads' || p === '.beads/' || p === '.beads/issues.jsonl';
try {
  const repo = process.env.TF_MVP_REPO;
  if (!repo) throw new Error('TF_MVP_REPO is required');
  const before = run('git', ['status', '--porcelain'], repo);
  const unexpectedBefore = before.split(/\r?\n/).filter(Boolean).map(line => line.slice(3)).filter(path => !allowedBeadsPath(path));
  if (unexpectedBefore.length) throw new Error(`base repo dirty before bd export: ${unexpectedBefore.join(', ')}`);
  run(bdCmd[0], [...bdCmd.slice(1), 'export'], repo);
  const status = run('git', ['status', '--porcelain'], repo);
  const paths = status.split(/\r?\n/).filter(Boolean).map(line => line.slice(3));
  const unexpected = paths.filter(path => !allowedBeadsPath(path));
  if (unexpected.length) throw new Error(`bd export changed unexpected files: ${unexpected.join(', ')}`);
  if (paths.length) {
    run('git', ['add', '--', '.beads/issues.jsonl'], repo);
    run('git', ['commit', '-m', 'chore: export beads issues'], repo);
  }
  const sha = run('git', ['rev-parse', 'HEAD'], repo);
  console.log(`BD EXPORT OK ${sha}`);
} catch (e) { console.error(`BD EXPORT FAIL: ${e.message}`); process.exit(1); }
