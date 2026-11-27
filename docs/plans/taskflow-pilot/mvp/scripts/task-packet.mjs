import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const fail = (m) => { console.error(m); process.exit(1); };
const bdCmd = (process.env.TF_MVP_BD_BIN || 'bd').match(/\S+/g) || ['bd'];
const { TF_MVP_REPO: repo, TF_MVP_WORKTREE_CWD: cwd, TF_MVP_TASK_ID: taskId, TF_MVP_ACCEPTANCE_FILE: acceptance } = process.env;
if (![repo, cwd, taskId, acceptance].every(Boolean)) fail('Missing required TF_MVP_* environment variable');
const result = spawnSync(bdCmd[0], [...bdCmd.slice(1), 'show', taskId, '--json'], { cwd: repo, encoding: 'utf8', shell: false, windowsHide: true });
if (result.error || result.status !== 0) fail(`bd show failed: ${(result.stderr || result.error?.message || '').trim()}`);
let task;
try { task = JSON.parse(result.stdout); } catch { fail('bd show returned invalid JSON'); }
const dir = path.join(cwd, '.taskflow-mvp');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'task.json'), `${JSON.stringify(task, null, 2)}\n`, 'utf8');
fs.copyFileSync(acceptance, path.join(dir, 'acceptance.txt'));
console.log('TASK PACKET OK');
