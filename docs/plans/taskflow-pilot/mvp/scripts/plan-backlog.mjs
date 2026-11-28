#!/usr/bin/env node
/** Read-only backlog snapshot for the leaf planning phase. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function commandParts(value) {
  const parts = String(value || 'bd').match(/\S+/g) || ['bd'];
  return [parts[0], parts.slice(1)];
}

const bdBin = process.env.TF_MVP_BD_BIN || 'bd';
const repo = process.env.TF_MVP_REPO || process.env.TF_MVP_WORKTREE_CWD || process.cwd();
const worktree = process.env.TF_MVP_WORKTREE_CWD || repo;
const currentId = process.env.TF_MVP_TASK_ID || '';
const [bin, prefix] = commandParts(bdBin);
const result = spawnSync(bin, [...prefix, 'ready', '--json'], {
  cwd: repo, encoding: 'utf8', shell: false, windowsHide: true,
});
if (result.error || result.status !== 0) {
  throw new Error(`bd ready failed: ${result.stderr || result.error?.message || 'unknown error'}`);
}
let rows;
try { rows = JSON.parse(result.stdout); } catch { throw new Error('bd ready returned invalid JSON'); }
const eligible = (row) => {
  const description = String(row?.description || '');
  return row?.id && row.id !== currentId && row.status !== 'closed'
    && /(?:Files:|Файлы:)/.test(description) && description.includes('Acceptance:');
};
const backlog = (Array.isArray(rows) ? rows : []).filter(eligible).map((row) => ({
  id: String(row.id),
  title: String(row.title || ''),
  description: String(row.description || '').slice(0, 1200),
}));
const dir = path.join(worktree, '.taskflow-mvp');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'planning-context.json'), `${JSON.stringify({
  currentTaskId: currentId,
  generatedAt: new Date().toISOString(),
  backlog,
}, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ count: backlog.length, currentTaskId: currentId })}\n`);
