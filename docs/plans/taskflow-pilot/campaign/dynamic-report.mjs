#!/usr/bin/env node
/** Summarize the dynamic campaign from slot artifacts. */
import fs from 'node:fs';
import path from 'node:path';
import { writeCampaignReport } from './report.mjs';

const fail = (message) => { console.error(`DYNAMIC REPORT FAIL: ${message}`); process.exit(1); };
function campaignArtifactPath(config) {
  return path.join(config.repo, '.pi', 'taskflows', 'results', `campaign-${config.name}.json`);
}
const [configPath] = process.argv.slice(2);
if (!configPath) fail('usage: node dynamic-report.mjs <config.json>');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const queuePath = config.queuePath;
const queue = fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, 'utf8')) : {};
const isMerged = (result) => result?.status === 'merged' && result?.merged === true
  && result?.bdClosed === true && !result?.needsAttention && (!result?.blockers || result.blockers.length === 0);
const resultsDir = path.join(config.repo, '.pi', 'taskflows', 'results');
for (const id of [...(queue.active || [])]) {
  const resultFile = path.join(resultsDir, `${id}.json`);
  if (!fs.existsSync(resultFile)) continue;
  let result;
  try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { continue; }
  if (!isMerged(result)) continue;
  queue.active = (queue.active || []).filter((active) => active !== id);
  queue.completed = queue.completed || [];
  if (!queue.completed.includes(id)) queue.completed.push(id);
}
if (fs.existsSync(queuePath)) fs.writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
const queueState = {
  pending: queue.pending || [],
  active: queue.active || [],
  completed: queue.completed || [],
  skipped: queue.skipped || [],
};
const taskIds = [];
const usageMap = {};
for (const slotName of config.slots || []) {
  const file = path.join(config.slotArtifactDir, `${slotName}.json`);
  if (!fs.existsSync(file)) continue;
  const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!artifact.taskId) continue;
  taskIds.push(artifact.taskId);
  usageMap[artifact.taskId] = artifact.phaseId || `leaf-slot-${artifact.slot}`;
}
if (!taskIds.length) {
  const empty = { status: 'failed', tasks: [], tokens: { fresh: 0, cacheRead: 0 }, queue: queueState, reason: 'no dynamic slot selected a task' };
  const output = `${JSON.stringify(empty, null, 2)}\n`;
  fs.mkdirSync(path.join(config.repo, '.pi', 'taskflows', 'results'), { recursive: true });
  fs.writeFileSync(path.join(config.repo, '.pi', 'taskflows', 'results', `campaign-${config.name}.json`), output, 'utf8');
  process.stdout.write(output);
  process.exit(1);
}
const { summary, failed } = writeCampaignReport({
  repo: config.repo,
  taskIds,
  campaignName: config.name,
  flowRoot: config.flowProjectRoot,
  usageMap,
});
summary.queue = queueState;
if (queueState.pending.length || queueState.active.length || queueState.skipped.length) {
  summary.status = 'failed';
  summary.reason = `campaign queue is not clean: ${queueState.pending.length} pending, ${queueState.active.length} active, ${queueState.skipped.length} skipped`;
} else if (summary.status === 'failed') {
  summary.reason = 'one or more leaf results failed';
}
const output = `${JSON.stringify(summary, null, 2)}\n`;
fs.writeFileSync(campaignArtifactPath(config), output, 'utf8');
process.stdout.write(output);
if (failed || summary.status === 'failed') process.exit(1);
