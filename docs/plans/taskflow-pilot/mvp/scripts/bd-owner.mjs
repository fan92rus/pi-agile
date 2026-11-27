import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
const bdCmd = (process.env.TF_MVP_BD_BIN || 'bd').match(/\S+/g) || ['bd'];
try {
  const id = process.env.TF_MVP_TASK_ID;
  const commitFile = join(process.env.TF_MVP_WORKTREE_CWD || process.cwd(), '.taskflow-mvp', 'merge-commit.txt');
  const commit = process.env.TF_MVP_COMMIT || (existsSync(commitFile) ? readFileSync(commitFile, 'utf8').trim() : '');
  if (!id) throw new Error('TF_MVP_TASK_ID is required');
  if (!commit) throw new Error('TF_MVP_COMMIT is not set; refusing to close before merge');
  const r = spawnSync(bdCmd[0], [...bdCmd.slice(1), 'close', id, '--comment', `taskflow MVP: ${commit}`], { cwd: process.env.TF_MVP_REPO || process.cwd(), encoding: 'utf8', shell: false, windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `bd exited ${r.status}`).trim());
  const dir = join(process.env.TF_MVP_WORKTREE_CWD || process.cwd(), '.taskflow-mvp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bd-owner.json'), `${JSON.stringify({ closed: true, id, commit }, null, 2)}\n`, 'utf8');
  console.log('BD CLOSE OK');
} catch (e) { console.error(`BD CLOSE FAIL: ${e.message}`); process.exit(1); }
