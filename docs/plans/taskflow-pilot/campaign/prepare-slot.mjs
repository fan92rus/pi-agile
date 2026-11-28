#!/usr/bin/env node
/** Select the next queued bd leaf and regenerate this slot's saved flow. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const fail = (message) => { console.error(`PREPARE SLOT FAIL: ${message}`); process.exit(1); };
const [configPath, slotArg] = process.argv.slice(2);
const slotIndex = Number(slotArg || 0);
if (!configPath || !Number.isInteger(slotIndex) || slotIndex < 0) fail('usage: node prepare-slot.mjs <config.json> <slotIndex>');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const queue = JSON.parse(fs.readFileSync(config.queuePath, 'utf8'));
const [bin, ...prefix] = String(config.bdBin || 'bd').match(/\S+/g) || ['bd'];
const bd = (args) => spawnSync(bin, [...prefix, ...args], {
  cwd: config.repo, encoding: 'utf8', shell: false, windowsHide: true,
});

// Resolve lead decisions before selecting work. A parked task stays invisible
// until the leading agent writes <decisionDir>/<taskId>.json.
const decisionDir = config.decisionDir || path.join(config.flowProjectRoot, '.pi', 'taskflows', 'lead-decisions');
if (fs.existsSync(decisionDir)) {
  for (const file of fs.readdirSync(decisionDir).filter((name) => name.endsWith('.json')).sort()) {
    let decision;
    try { decision = JSON.parse(fs.readFileSync(path.join(decisionDir, file), 'utf8')); }
    catch { fail(`invalid lead decision file ${file}`); }
    const taskId = String(decision.taskId || path.basename(file, '.json'));
    if (!/^[A-Za-z0-9._-]+$/.test(taskId)) fail(`unsafe lead decision task id ${taskId}`);
    for (const args of [
      ['label', 'remove', taskId, 'tf-needs-lead'],
      ['label', 'add', taskId, 'tf-queued'],
      ['update', taskId, '--append-notes', `Lead decision: ${String(decision.instructions || decision.decision || 'approved')}`],
    ]) {
      const applied = bd(args);
      if (applied.error || applied.status !== 0) {
        fail(`lead decision bd ${args.join(' ')} failed: ${applied.stderr || applied.error?.message || 'unknown error'}`);
      }
    }
    if (!queue.pending.includes(taskId) && !queue.active.includes(taskId) && !queue.completed.includes(taskId)) {
      queue.pending.push(taskId);
    }
    fs.renameSync(path.join(decisionDir, file), path.join(decisionDir, `${file}.applied`));
  }
}

const eligible = (row) => {
  const description = String(row?.description || '');
  return row?.id && row.status !== 'closed'
    && /(?:Files:|Файлы:)/.test(description) && description.includes('Acceptance:');
};
queue.skipped = Array.isArray(queue.skipped) ? queue.skipped : [];
let taskId = null;
while (queue.pending.length) {
  const candidate = String(queue.pending[0]);
  const shown = bd(['show', candidate, '--json']);
  if (shown.error || shown.status !== 0) {
    queue.pending.shift();
    queue.skipped.push({ id: candidate, reason: shown.stderr || shown.error?.message || 'bd show failed' });
    continue;
  }
  let parsed;
  try { parsed = JSON.parse(shown.stdout); } catch {
    queue.pending.shift();
    queue.skipped.push({ id: candidate, reason: 'invalid bd show JSON' });
    continue;
  }
  const issue = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!eligible(issue)) {
    queue.pending.shift();
    queue.skipped.push({ id: candidate, reason: 'not an eligible open code leaf' });
    continue;
  }
  queue.pending.shift();
  taskId = candidate;
  break;
}

const slotName = config.slots[slotIndex];
if (!slotName || !/^[A-Za-z0-9._-]+$/.test(slotName)) fail(`unsafe slot name at index ${slotIndex}`);
const slotFlowPath = path.join(config.flowProjectRoot, '.pi', 'taskflows', `${slotName}.json`);
fs.mkdirSync(path.dirname(slotFlowPath), { recursive: true });

if (taskId) {
  const worktree = path.join(config.worktreeRoot, taskId);
  const args = [
    '--taskId', taskId,
    '--flowName', slotName,
    '--repo', config.repo,
    '--worktree', worktree,
    '--branch', `${config.branchPrefix}/${taskId}`,
    '--bdBin', config.bdBin,
    '--mergeLock', config.mergeLock,
    '--testCommand', config.testCommand,
    '--maxCycles', String(config.maxCycles),
    '--reuseReviewerSession', String(config.reuseReviewerSession),
    '--reviewerModel', config.reviewerModel,
    '--plannerModel', config.plannerModel,
    '--queuePath', config.queuePath,
  ];
  if (config.queueParent) args.push('--queueParent', config.queueParent);
  args.push('--out', slotFlowPath);
  const generated = spawnSync(process.execPath, [config.leafGenerator, ...args], {
    cwd: config.repo, encoding: 'utf8', shell: false, windowsHide: true,
  });
  if (generated.error || generated.status !== 0) fail(`leaf generator failed for ${taskId}: ${generated.stderr || generated.error?.message || 'unknown error'}`);
  queue.active.push(taskId);
  const artifact = { slot: slotIndex, phaseId: `leaf-slot-${slotIndex}`, taskId, ready: true };
  fs.writeFileSync(path.join(config.slotArtifactDir, `${slotName}.json`), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  fs.writeFileSync(config.queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
} else {
  const noopFlow = {
    name: slotName,
    phases: [{
      id: 'idle',
      type: 'script',
      run: ['node', '-e', 'console.log(JSON.stringify({status:"idle"}))'],
      output: 'json',
      final: true,
    }],
  };
  fs.writeFileSync(slotFlowPath, `${JSON.stringify(noopFlow, null, 2)}\n`, 'utf8');
  const artifact = { slot: slotIndex, phaseId: `leaf-slot-${slotIndex}`, taskId: null, ready: false };
  fs.writeFileSync(path.join(config.slotArtifactDir, `${slotName}.json`), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  fs.writeFileSync(config.queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
}
