#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const positional = process.argv.slice(2);
const envArgs = Object.fromEntries(positional.filter((arg) => arg.startsWith('TF_MVP_')).map((arg) => {
  const split = arg.indexOf('=');
  return split < 0 ? [arg, ''] : [arg.slice(0, split), arg.slice(split + 1)];
}));
const values = positional.filter((arg) => !arg.startsWith('TF_MVP_'));
const [bdBin = envArgs.TF_MVP_BD_BIN || 'bd', taskId = envArgs.TF_MVP_TASK_ID, repo = envArgs.TF_MVP_REPO || envArgs.TF_MVP_WORKTREE_CWD || process.cwd()] = values;
if (!taskId) throw new Error('usage: plan-apply.mjs <bd-bin> <task-id> [repo]');
const result = spawnSync(bdBin, ['create', '--parent', taskId, '--json'], { cwd: repo, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
if (result.error || result.status !== 0) throw new Error(`bd create failed: ${result.stderr || result.error?.message}`);
let issue;
try { issue = JSON.parse(result.stdout); } catch { throw new Error('bd create returned invalid JSON'); }
const id = issue.id || issue[0]?.id;
if (!id) throw new Error('bd create response did not contain an issue id');
process.stdout.write(`${JSON.stringify({ id })}\n`);
