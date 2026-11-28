#!/usr/bin/env node
/** Summarize the dynamic campaign from slot artifacts. */
import fs from 'node:fs';
import path from 'node:path';
import { writeCampaignReport } from './report.mjs';

const fail = (message) => { console.error(`DYNAMIC REPORT FAIL: ${message}`); process.exit(1); };
const [configPath] = process.argv.slice(2);
if (!configPath) fail('usage: node dynamic-report.mjs <config.json>');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
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
  const empty = { status: 'failed', tasks: [], tokens: { fresh: 0, cacheRead: 0 }, reason: 'no dynamic slot selected a task' };
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
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (failed) process.exit(1);
