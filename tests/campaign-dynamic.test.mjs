import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve('.');
const campaignScript = path.join(repoRoot, 'docs', 'plans', 'taskflow-pilot', 'campaign', 'make-campaign-flow.mjs');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-dynamic-'));
  const pilot = path.join(dir, 'docs', 'plans', 'taskflow-pilot');
  fs.mkdirSync(pilot, { recursive: true });
  for (const part of ['campaign', 'mvp']) {
    fs.cpSync(path.join(repoRoot, 'docs', 'plans', 'taskflow-pilot', part), path.join(pilot, part), { recursive: true });
  }
  const shim = path.join(dir, 'bd.mjs');
  fs.writeFileSync(shim, [
    'const issues = {',
    '  "D-1": { id: "D-1", status: "open", title: "One", description: "Files: a.mjs Acceptance: works", dependencies: [{ id: "E-1", type: "parent-child" }] },',
    '  "D-2": { id: "D-2", status: "open", title: "Two", description: "Files: b.mjs Acceptance: works", dependencies: [{ id: "E-1", type: "parent-child" }] },',
    '};',
    'const args = process.argv.slice(2);',
    'if (args[0] === "ready") { console.log(JSON.stringify(Object.values(issues))); process.exit(0); }',
    'if (args[0] === "show") { console.log(JSON.stringify(issues[args[1]])); process.exit(0); }',
    'if (args[0] === "label" || args[0] === "update") { process.exit(0); }',
    'process.exit(1);',
    '',
  ].join('\n'));
  return { dir, bdBin: `node ${shim.replaceAll('\\', '/')}` };
}

test('dynamic mode emits a static slot chain and a config artifact', () => {
  const fx = fixture();
  try {
    const out = path.join(fx.dir, 'dynamic.json');
    const result = spawnSync(process.execPath, [campaignScript,
      '--repo', fx.dir, '--bdBin', fx.bdBin, '--tasks', 'D-1,D-2',
      '--mode', 'dynamic', '--slots', '2', '--concurrency', '1', '--name', 'dyn', '--out', out,
    ], { cwd: fx.dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const flow = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(flow.concurrency, 1);
    assert.equal(flow.mode, undefined);
    assert.deepEqual(flow.phases.map((phase) => phase.id), [
      'queue-init',
      'prepare-slot-0', 'leaf-slot-0',
      'prepare-slot-1', 'leaf-slot-1',
      'campaign-report',
    ]);
    assert.equal(flow.phases[2].use, 'tf-dynamic-slot-dyn-0');
    assert.equal(flow.phases[4].use, 'tf-dynamic-slot-dyn-1');
    assert.ok(flow.args.configPath.default.endsWith('config.json'));
    const config = JSON.parse(fs.readFileSync(flow.args.configPath.default, 'utf8'));
    assert.equal(config.queueParent, 'E-1');
    assert.deepEqual(config.initialTasks, ['D-1', 'D-2']);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('queue helpers allocate each queued task once and idle remaining slots', () => {
  const fx = fixture();
  try {
    const out = path.join(fx.dir, 'dynamic.json');
    const generated = spawnSync(process.execPath, [campaignScript,
      '--repo', fx.dir, '--bdBin', fx.bdBin, '--tasks', 'D-1,D-2',
      '--mode', 'dynamic', '--slots', '3', '--concurrency', '1', '--name', 'dynq', '--out', out,
    ], { cwd: fx.dir, encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const flow = JSON.parse(fs.readFileSync(out, 'utf8'));
    const configPath = flow.args.configPath.default;
    const run = (script, ...args) => spawnSync(process.execPath, [path.join(repoRoot, 'docs', 'plans', 'taskflow-pilot', 'campaign', script), configPath, ...args], { encoding: 'utf8' });
    assert.equal(run('queue-init.mjs').status, 0);
    const first = run('prepare-slot.mjs', '0');
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout).taskId, 'D-1');
    const second = run('prepare-slot.mjs', '1');
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout).taskId, 'D-2');
    const third = run('prepare-slot.mjs', '2');
    assert.equal(third.status, 0, third.stderr);
    assert.equal(JSON.parse(third.stdout).ready, false);
    const q = JSON.parse(fs.readFileSync(path.join(fx.dir, '.pi', 'taskflows', 'queue-dynq.json'), 'utf8'));
    assert.deepEqual(q.active, ['D-1', 'D-2']);
    assert.deepEqual(q.pending, []);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('dynamic report drains completed queue items and succeeds', () => {
  const fx = fixture();
  try {
    const out = path.join(fx.dir, 'dynamic.json');
    const generated = spawnSync(process.execPath, [campaignScript,
      '--repo', fx.dir, '--bdBin', fx.bdBin, '--tasks', 'D-1',
      '--mode', 'dynamic', '--slots', '1', '--concurrency', '1', '--name', 'dyndone', '--out', out,
    ], { cwd: fx.dir, encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const flow = JSON.parse(fs.readFileSync(out, 'utf8'));
    const configPath = flow.args.configPath.default;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const qPath = path.join(fx.dir, '.pi', 'taskflows', 'queue-dyndone.json');
    fs.writeFileSync(qPath, JSON.stringify({ version: 2, pending: [], active: ['D-1'], completed: [], skipped: [] }));
    const slotName = config.slots[0];
    fs.mkdirSync(path.join(fx.dir, '.pi', 'taskflows', 'results'), { recursive: true });
    fs.writeFileSync(path.join(config.slotArtifactDir, `${slotName}.json`), JSON.stringify({
      slot: 0, phaseId: 'leaf-slot-0', taskId: 'D-1', ready: true,
    }));
    fs.writeFileSync(path.join(fx.dir, '.pi', 'taskflows', 'results', 'D-1.json'), JSON.stringify({
      status: 'merged', merged: true, bdClosed: true, blockers: [], needsAttention: null,
    }));
    const report = spawnSync(process.execPath, [config.dynamicReportScript, configPath], { encoding: 'utf8' });
    assert.equal(report.status, 0, report.stderr);
    const summary = JSON.parse(report.stdout);
    assert.equal(summary.status, 'merged');
    assert.deepEqual(summary.queue.active, []);
    assert.deepEqual(summary.queue.completed, ['D-1']);
    const queue = JSON.parse(fs.readFileSync(qPath, 'utf8'));
    assert.deepEqual(queue.completed, ['D-1']);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('unusable queued ids are recorded as skipped instead of silently lost', () => {
  const fx = fixture();
  try {
    const out = path.join(fx.dir, 'dynamic.json');
    const generated = spawnSync(process.execPath, [campaignScript,
      '--repo', fx.dir, '--bdBin', fx.bdBin, '--tasks', 'D-1',
      '--mode', 'dynamic', '--slots', '1', '--concurrency', '1', '--name', 'dynskip', '--out', out,
    ], { cwd: fx.dir, encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const flow = JSON.parse(fs.readFileSync(out, 'utf8'));
    const configPath = flow.args.configPath.default;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const qPath = path.join(fx.dir, '.pi', 'taskflows', 'queue-dynskip.json');
    fs.writeFileSync(qPath, JSON.stringify({ version: 2, pending: ['MISSING-1'], active: [], completed: [], skipped: [] }));
    const prepare = spawnSync(process.execPath, [
      path.join(repoRoot, 'docs', 'plans', 'taskflow-pilot', 'campaign', 'prepare-slot.mjs'),
      configPath, '0',
    ], { encoding: 'utf8' });
    assert.equal(prepare.status, 0, prepare.stderr);
    assert.equal(JSON.parse(prepare.stdout).ready, false);
    const queue = JSON.parse(fs.readFileSync(qPath, 'utf8'));
    assert.deepEqual(queue.skipped.map((row) => row.id), ['MISSING-1']);
    assert.deepEqual(queue.pending, []);
    const report = spawnSync(process.execPath, [
      config.dynamicReportScript, configPath,
    ], { encoding: 'utf8' });
    assert.notEqual(report.status, 0);
    const summary = JSON.parse(report.stdout);
    assert.deepEqual(summary.queue.skipped.map((row) => row.id), ['MISSING-1']);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('dynamic report fails when a valid task is mixed with a skipped queue id', () => {
  const fx = fixture();
  try {
    const out = path.join(fx.dir, 'dynamic.json');
    const generated = spawnSync(process.execPath, [campaignScript,
      '--repo', fx.dir, '--bdBin', fx.bdBin, '--tasks', 'D-1',
      '--mode', 'dynamic', '--slots', '1', '--concurrency', '1', '--name', 'dynmix', '--out', out,
    ], { cwd: fx.dir, encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const flow = JSON.parse(fs.readFileSync(out, 'utf8'));
    const configPath = flow.args.configPath.default;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const qPath = path.join(fx.dir, '.pi', 'taskflows', 'queue-dynmix.json');
    fs.writeFileSync(qPath, JSON.stringify({
      version: 2, pending: [], active: [], completed: ['D-1'], skipped: [{ id: 'BAD-1', reason: 'not eligible' }],
    }));
    fs.mkdirSync(path.join(fx.dir, '.pi', 'taskflows', 'results'), { recursive: true });
    fs.writeFileSync(path.join(config.slotArtifactDir, `${config.slots[0]}.json`), JSON.stringify({
      slot: 0, phaseId: 'leaf-slot-0', taskId: 'D-1', ready: true,
    }));
    fs.writeFileSync(path.join(fx.dir, '.pi', 'taskflows', 'results', 'D-1.json'), JSON.stringify({
      status: 'merged', merged: true, bdClosed: true, blockers: [], needsAttention: null,
    }));
    const report = spawnSync(process.execPath, [config.dynamicReportScript, configPath], { encoding: 'utf8' });
    assert.notEqual(report.status, 0);
    const summary = JSON.parse(report.stdout);
    assert.equal(summary.status, 'failed');
    assert.match(summary.reason, /1 skipped/);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('lead decisions release parked tasks before slot selection', () => {
  const fx = fixture();
  try {
    const out = path.join(fx.dir, 'dynamic.json');
    const generated = spawnSync(process.execPath, [campaignScript,
      '--repo', fx.dir, '--bdBin', fx.bdBin, '--tasks', 'D-1',
      '--mode', 'dynamic', '--slots', '1', '--concurrency', '1', '--name', 'dynlead', '--out', out,
    ], { cwd: fx.dir, encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const flow = JSON.parse(fs.readFileSync(out, 'utf8'));
    const config = JSON.parse(fs.readFileSync(flow.args.configPath.default, 'utf8'));
    fs.writeFileSync(path.join(config.decisionDir, 'D-2.json'), JSON.stringify({
      taskId: 'D-2', instructions: 'proceed with b.mjs',
    }));
    const qPath = path.join(fx.dir, '.pi', 'taskflows', 'queue-dynlead.json');
    fs.writeFileSync(qPath, JSON.stringify({ version: 2, pending: [], active: [], completed: [] }));
    const prepare = spawnSync(process.execPath, [
      path.join(repoRoot, 'docs', 'plans', 'taskflow-pilot', 'campaign', 'prepare-slot.mjs'),
      flow.args.configPath.default, '0',
    ], { encoding: 'utf8' });
    assert.equal(prepare.status, 0, prepare.stderr);
    assert.equal(JSON.parse(prepare.stdout).taskId, 'D-2');
    assert.ok(fs.existsSync(path.join(config.decisionDir, 'D-2.json.applied')));
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});
