#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const positional = process.argv.slice(2);
const envArgs = Object.fromEntries(positional.filter((arg) => arg.startsWith('TF_MVP_')).map((arg) => {
  const split = arg.indexOf('=');
  return split < 0 ? [arg, ''] : [arg.slice(0, split), arg.slice(split + 1)];
}));
const [bdBin = envArgs.TF_MVP_BD_BIN || 'bd', repo = envArgs.TF_MVP_REPO || envArgs.TF_MVP_WORKTREE_CWD || process.cwd()] = positional.filter((arg) => !arg.startsWith('TF_MVP_'));
const result = spawnSync(bdBin, ['ready', '--json'], { cwd: repo, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
if (result.error || result.status !== 0) throw new Error(`bd ready failed: ${result.stderr || result.error?.message}`);
let rows;
try { rows = JSON.parse(result.stdout); } catch { throw new Error('bd ready returned invalid JSON'); }
const leaves = (Array.isArray(rows) ? rows : []).filter((row) => row?.id && row.status !== 'closed' && /(?:Files:|Файлы:)/.test(row.description || '') && /Acceptance:/.test(row.description || ''));
const planningContextPath = path.join(envArgs.TF_MVP_WORKTREE_CWD || repo, '.taskflow-mvp', 'planning-context.json');
fs.mkdirSync(path.dirname(planningContextPath), { recursive: true });
fs.writeFileSync(planningContextPath, `${JSON.stringify(leaves, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(leaves));
