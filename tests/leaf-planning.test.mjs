import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve('docs/plans/taskflow-pilot/mvp/scripts');

function shim(dir, calls) {
  const file = path.join(dir, 'bd.mjs');
  fs.writeFileSync(file, [
    'import fs from "node:fs";',
    `const calls = ${JSON.stringify(calls)};`,
    'const args = process.argv.slice(2);',
    'fs.appendFileSync(process.env.BD_CALLS_FILE || "calls.log", JSON.stringify(args) + "\\n");',
    'const ready = [{id:"leaf-1",status:"open",title:"Leaf",description:"Files: a.mjs Acceptance: works"}];',
    'const created = {id:"child-1"};',
    'process.stdout.write(JSON.stringify(args[0] === "ready" ? ready : created));',
    '',
  ].join('\n'));
  return `node ${file.replaceAll('\\', '/')}`;
}

test('generated leaf passes planner wiring without mutating the current task', () => {
  const flow = JSON.parse(fs.readFileSync('docs/plans/taskflow-pilot/mvp/flow.json', 'utf8'));
  const context = flow.phases.find((phase) => phase.id === 'planning-context');
  const plan = flow.phases.find((phase) => phase.id === 'plan');
  const apply = flow.phases.find((phase) => phase.id === 'plan-apply');
  assert.ok(context.run.includes('plan-backlog'));
  assert.deepEqual(plan.tools, ['read']);
  assert.ok(apply.run.includes('TF_MVP_TASK_ID={args.taskId}'));
  assert.ok(apply.run.includes('TF_MVP_QUEUE_PARENT={args.queueParent}'));
  assert.ok(apply.run.includes('TF_MVP_QUEUE_PATH={args.queuePath}'));
  assert.ok(flow.args.plannerModel);
  assert.ok(flow.args.queueParent);
  assert.ok(flow.args.queuePath);
});

test('plan-backlog writes a read-only context artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-planning-backlog-'));
  try {
    const worktree = path.join(dir, 'worktree');
    fs.mkdirSync(path.join(worktree, '.taskflow-mvp'), { recursive: true });
    const callsFile = path.join(dir, 'calls.log');
    const bdBin = shim(dir, callsFile);
    const result = spawnSync(process.execPath, [path.join(root, 'plan-backlog.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TF_MVP_BD_BIN: bdBin,
        TF_MVP_REPO: dir,
        TF_MVP_WORKTREE_CWD: worktree,
        TF_MVP_TASK_ID: 'parent-1',
        BD_CALLS_FILE: callsFile,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(fs.readFileSync(path.join(worktree, '.taskflow-mvp', 'planning-context.json'), 'utf8'));
    assert.equal(context.currentTaskId, 'parent-1');
    assert.deepEqual(context.backlog.map((row) => row.id), ['leaf-1']);
    const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls, [['ready', '--json']]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('plan-apply creates only new children and records the decision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-planning-apply-'));
  try {
    const worktree = path.join(dir, 'worktree');
    fs.mkdirSync(path.join(worktree, '.taskflow-mvp'), { recursive: true });
    const queuePath = path.join(dir, 'queue.json');
    fs.writeFileSync(queuePath, JSON.stringify({ version: 2, pending: [], active: [], completed: [] }));
    const callsFile = path.join(dir, 'calls.log');
    const bdBin = shim(dir, callsFile);
    const planning = {
      action: 'needsLeadDecision',
      reason: 'needs scope',
      leadQuestion: 'Which module owns this?',
      children: [{ title: 'Follow-up', description: 'Files: b.mjs Acceptance: done' }],
    };
    const result = spawnSync(process.execPath, [path.join(root, 'plan-apply.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TF_MVP_BD_BIN: bdBin,
        TF_MVP_REPO: dir,
        TF_MVP_WORKTREE_CWD: worktree,
        TF_MVP_FLOW_PROJECT_ROOT: dir,
        TF_MVP_TASK_ID: 'parent-1',
        TF_MVP_QUEUE_PARENT: 'epic-1',
        TF_MVP_QUEUE_PATH: queuePath,
        TF_MVP_PLANNING_JSON: JSON.stringify(planning),
        BD_CALLS_FILE: callsFile,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const decision = JSON.parse(fs.readFileSync(path.join(worktree, '.taskflow-mvp', 'planning.json'), 'utf8'));
    assert.equal(decision.action, 'needsLeadDecision');
    assert.deepEqual(decision.childIds, ['child-1']);
    assert.ok(fs.existsSync(path.join(dir, '.pi', 'taskflows', 'lead-decisions', 'child-1.json')));
    const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(calls.some((args) => args[0] === 'create'));
    assert.ok(calls.some((args) => args[0] === 'label' && args.includes('tf-needs-lead')));
    assert.ok(!calls.some((args) => ['close', 'reopen', 'update'].includes(args[0]) && args.includes('parent-1')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
