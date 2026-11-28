#!/usr/bin/env node
/**
 * Apply a read-only planner decision.
 *
 * This is the ONLY phase allowed to call bd create. It never updates, closes,
 * reopens or edits the current leaf: it only creates follow-up beads and writes
 * queue/decision artifacts. The planner agent itself has no shell or bd tools.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const fail = (message) => { console.error(`PLAN APPLY FAIL: ${message}`); process.exit(1); };
function commandParts(value) {
  const parts = String(value || 'bd').match(/\S+/g) || ['bd'];
  return [parts[0], parts.slice(1)];
}
function parsePlanning(raw) {
  if (!raw) return { action: 'none', reason: 'planner produced no output' };
  let text = String(raw).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') throw new Error('not an object');
    return value;
  } catch (e) {
    return { action: 'none', reason: `planner output was not JSON: ${e.message}` };
  }
}

const bdBin = process.env.TF_MVP_BD_BIN || 'bd';
const repo = process.env.TF_MVP_REPO || process.env.TF_MVP_WORKTREE_CWD || process.cwd();
const worktree = process.env.TF_MVP_WORKTREE_CWD || repo;
const flowRoot = process.env.TF_MVP_FLOW_PROJECT_ROOT || repo;
const taskId = process.env.TF_MVP_TASK_ID || '';
const queueParent = process.env.TF_MVP_QUEUE_PARENT || '';
const queuePath = process.env.TF_MVP_QUEUE_PATH || '';
const planning = parsePlanning(process.env.TF_MVP_PLANNING_JSON);
const [bin, prefix] = commandParts(bdBin);
const bd = (args) => spawnSync(bin, [...prefix, ...args], {
  cwd: repo, encoding: 'utf8', shell: false, windowsHide: true,
});

const action = ['none', 'spawn', 'needsLeadDecision'].includes(planning.action) ? planning.action : 'none';
const children = Array.isArray(planning.children) ? planning.children.slice(0, 3) : [];
const validDescription = (value) => {
  const text = String(value || '');
  return /(?:Files:|Файлы:)/.test(text) && text.includes('Acceptance:');
};
if ((action === 'spawn' || action === 'needsLeadDecision') && children.some((child) => !child?.title || !validDescription(child.description))) {
  fail('planner children must have title and a description with Files:/Файлы: and Acceptance:');
}

const created = [];
for (const child of action === 'none' ? [] : children) {
  const queued = action === 'spawn';
  const description = `${String(child.description).trim()}\n\nSplitFrom: ${taskId}\nQueueState: ${queued ? 'queued' : 'needsLeadDecision'}\n`;
  const args = ['create', '--title', String(child.title), '-d', description, '--json'];
  if (queueParent && /^[A-Za-z0-9._-]+$/.test(queueParent)) args.push('--parent', queueParent);
  const result = bd(args);
  if (result.error || result.status !== 0) fail(`bd create failed: ${result.stderr || result.error?.message || 'unknown error'}`);
  let createdIssue;
  try {
    const parsed = JSON.parse(result.stdout);
    createdIssue = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch { fail('bd create returned invalid JSON'); }
  const id = createdIssue?.id;
  if (!id || !/^[A-Za-z0-9._-]+$/.test(String(id))) fail('bd create did not return a safe issue id');
  const label = queued ? 'tf-queued' : 'tf-needs-lead';
  const labeled = bd(['label', 'add', String(id), label]);
  if (labeled.error || labeled.status !== 0) fail(`bd label add failed for ${id}: ${labeled.stderr || labeled.error?.message || 'unknown error'}`);
  created.push(String(id));
  if (!queued) {
    const decisionsDir = path.join(flowRoot, '.pi', 'taskflows', 'lead-decisions');
    fs.mkdirSync(decisionsDir, { recursive: true });
    fs.writeFileSync(path.join(decisionsDir, `${id}.json`), `${JSON.stringify({
      taskId: String(id),
      splitFrom: taskId,
      question: String(planning.leadQuestion || planning.reason || 'Lead decision required'),
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
  }
}

if (created.length && queuePath && fs.existsSync(queuePath)) {
  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  if (Array.isArray(queue.pending)) {
    for (const id of created) {
      if (action === 'spawn' && !queue.pending.includes(id)) queue.pending.push(id);
    }
    fs.writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
  }
}

const dir = path.join(worktree, '.taskflow-mvp');
fs.mkdirSync(dir, { recursive: true });
const report = {
  action,
  reason: String(planning.reason || ''),
  childIds: created,
  leadQuestion: action === 'needsLeadDecision' ? String(planning.leadQuestion || planning.reason || '') : null,
  createdAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(dir, 'planning.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report)}\n`);
