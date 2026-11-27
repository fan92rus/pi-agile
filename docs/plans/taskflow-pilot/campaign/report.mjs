#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [repo, taskList] = process.argv.slice(2);
if (!repo || !taskList) {
  console.error('usage: node report.mjs <repo> <taskId,taskId,...>');
  process.exit(1);
}
const tasks = taskList.split(',').map((id) => id.trim()).filter(Boolean);
const resultsDir = path.join(repo, '.pi', 'taskflows', 'results');
const rows = [];
let failed = false;
for (const taskId of tasks) {
  const file = path.join(resultsDir, `${taskId}.json`);
  if (!fs.existsSync(file)) {
    rows.push({ taskId, status: 'missing', file });
    failed = true;
    continue;
  }
  let result;
  try { result = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch {
    rows.push({ taskId, status: 'invalid-json', file });
    failed = true;
    continue;
  }
  const ok = result.status === 'merged' && result.merged === true && result.bdClosed === true
    && !result.needsAttention && (!result.blockers || result.blockers.length === 0);
  if (!ok) failed = true;
  rows.push({
    taskId,
    status: result.status,
    commit: result.commit || null,
    merged: result.merged === true,
    bdClosed: result.bdClosed === true,
    needsAttention: result.needsAttention || null,
    blockers: result.blockers || [],
  });
}
console.log(JSON.stringify({ status: failed ? 'failed' : 'merged', tasks: rows }, null, 2));
if (failed) process.exit(1);
