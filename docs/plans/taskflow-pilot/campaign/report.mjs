#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAFE_ID = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;
function newestRunState(flowRoot, campaignName) {
  if (!campaignName) return null;
  const dir = path.join(flowRoot || '.', '.pi', 'taskflows', 'runs', campaignName);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, files[0].name), 'utf8')); } catch { return null; }
}
function tokensOf(result, usage) {
  const fresh = Number(result?.freshTokens ?? ((Number(usage?.input) || 0) + (Number(usage?.output) || 0))) || 0;
  const cacheRead = Number(result?.cacheReadTokens ?? (Number(usage?.cacheRead) || 0)) || 0;
  return { fresh, cacheRead };
}

/** Write the campaign summary artifact and return it. usageMap maps taskId -> run-state phase id. */
export function writeCampaignReport({ repo, taskIds, campaignName, flowRoot, usageMap = {} }) {
  const tasks = Array.isArray(taskIds) ? taskIds : String(taskIds || '').split(',').map((id) => id.trim()).filter(Boolean);
  if (campaignName && !SAFE_ID.test(campaignName)) throw new Error('campaignName must contain only letters, digits, dot, underscore or dash');
  if (tasks.some((taskId) => !SAFE_ID.test(taskId))) throw new Error('task ids must contain only letters, digits, dot, underscore or dash');
  const runState = newestRunState(flowRoot || repo, campaignName);
  const resultsDir = path.join(repo, '.pi', 'taskflows', 'results');
  const rows = [];
  const tokens = { fresh: 0, cacheRead: 0 };
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
    const phaseId = usageMap[taskId] || `leaf-${taskId}`;
    const usage = runState?.phases?.[phaseId]?.usage;
    const hasUsage = Boolean(usage && typeof usage === 'object');
    const campaignTokens = hasUsage ? tokensOf({}, usage) : null;
    const leafTokens = hasUsage ? campaignTokens : tokensOf(result, null);
    if (hasUsage) {
      result.freshTokens = campaignTokens.fresh;
      result.cacheReadTokens = campaignTokens.cacheRead;
      fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    }
    tokens.fresh += leafTokens.fresh;
    tokens.cacheRead += leafTokens.cacheRead;
    rows.push({
      taskId,
      status: result.status,
      commit: result.commit || null,
      merged: result.merged === true,
      bdClosed: result.bdClosed === true,
      needsAttention: result.needsAttention || null,
      blockers: result.blockers || [],
      planning: result.planning || null,
      tokens: leafTokens,
    });
  }
  const summary = { status: failed ? 'failed' : 'merged', tasks: rows, tokens };
  const output = JSON.stringify(summary, null, 2);
  if (campaignName) {
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, `campaign-${campaignName}.json`), `${output}\n`);
  }
  return { summary, failed };
}

function main() {
  const [repo, taskList, campaignName, flowRoot] = process.argv.slice(2);
  if (!repo || !taskList) {
    console.error('usage: node report.mjs <repo> <taskId,taskId,...> [campaignName] [flowRoot]');
    process.exit(1);
  }
  try {
    const { summary, failed } = writeCampaignReport({ repo, taskIds: taskList, campaignName, flowRoot });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (failed) process.exit(1);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
