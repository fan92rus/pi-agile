#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [repo, taskList, campaignName] = process.argv.slice(2);
if (!repo || !taskList) {
  console.error('usage: node report.mjs <repo> <taskId,taskId,...> [campaignName]');
  process.exit(1);
}
const tasks = taskList.split(',').map((id) => id.trim()).filter(Boolean);
const resultsDir = path.join(repo, '.pi', 'taskflows', 'results');
const rows = [];
let failed = tasks.length === 0;
if (failed) rows.push({ status: 'invalid-task-list', reason: 'task list must contain at least one task' });
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
const summary = { status: failed ? 'failed' : 'merged', tasks: rows };
const output = JSON.stringify(summary, null, 2);
console.log(output);
if (campaignName) {
  if (path.basename(campaignName) !== campaignName || campaignName === '.' || campaignName === '..' || /[\\/]/.test(campaignName)) {
    console.error('campaignName must be a single filename component');
    process.exit(1);
  }
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, `campaign-${campaignName}.json`), `${output}\n`);
}
if (failed) process.exit(1);
