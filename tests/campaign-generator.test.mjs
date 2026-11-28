import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-generator-'));
  const pilot = path.join(dir, 'docs', 'plans', 'taskflow-pilot');
  fs.mkdirSync(pilot, { recursive: true });
  for (const part of ['campaign', 'mvp']) {
    fs.cpSync(path.join(repoRoot, 'docs', 'plans', 'taskflow-pilot', part), path.join(pilot, part), { recursive: true });
  }
  const shim = path.join(dir, 'bd-shim.mjs');
  const description = 'Files: a.mjs Acceptance: keep one leaf method measurement npm test';
  const russianDescription = 'Файлы: b.mjs Acceptance: keep another leaf';
  fs.writeFileSync(shim, [
    'const issues = {',
    `  "T-A": { id: "T-A", status: "open", title: "A", description: ${JSON.stringify(description)} },`,
    `  "T-CLOSED": { id: "T-CLOSED", status: "closed", title: "Closed", description: ${JSON.stringify(description)} },`,
    `  "T-RU": { id: "T-RU", status: "open", title: "Russian", description: ${JSON.stringify(russianDescription)} },`,
    `  "T-NOACC": { id: "T-NOACC", status: "open", title: "No acceptance", description: "Files: c.mjs" },`,
    `  "E-1": { id: "E-1", status: "open", title: "Epic", description: "" },`,
    `  "E-BAD": { id: "E-BAD", status: "open", title: "Broken epic", description: "" },`,
    `  "E-NOACC": { id: "E-NOACC", status: "open", title: "Ineligible epic", description: "" },`,
    '};',
    'const args = process.argv.slice(2);',
    'if (args[0] === "ready") { console.log(JSON.stringify([issues["T-A"]])); process.exit(0); }',
    'if (args[0] === "children" && args[1] === "E-BAD") { console.log("{bad"); process.exit(0); }',
    'if (args[0] === "children" && args[1] === "E-NOACC") { console.log(JSON.stringify([issues["T-NOACC"]])); process.exit(0); }',
    'if (args[0] === "children") { console.log(JSON.stringify(args[1] === "E-1" ? [issues["T-A"], issues["T-RU"]] : [])); process.exit(0); }',
    'if (args[0] === "show") { const issue = issues[args[1]]; if (!issue) process.exit(1); console.log(JSON.stringify(issue)); process.exit(0); }',
    'process.exit(1);',
    '',
  ].join('\n'));
  const generator = path.join(pilot, 'campaign', 'make-campaign-flow.mjs');
  const bdBin = `node ${shim.replaceAll('\\', '/')}`;
  return { dir, generator, bdBin };
}

function generate(fx, taskIds, name, extraArgs = []) {
  const out = path.join(fx.dir, `${name}.json`);
  const result = spawnSync(process.execPath, [
    fx.generator,
    '--repo', fx.dir,
    '--bdBin', fx.bdBin,
    '--worktreeRoot', path.join(fx.dir, 'worktrees'),
    '--tasks', taskIds,
    '--name', name,
    '--out', out,
    ...extraArgs,
  ], { cwd: fx.dir, encoding: 'utf8', windowsHide: true });
  return { result, out };
}

test('generator deduplicates explicit tasks and records the unique ids', () => {
  const fx = fixture();
  try {
    const { result, out } = generate(fx, 'T-A,T-A', 'tf-dedupe');
    assert.equal(result.status, 0, result.stderr);
    const flow = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(flow.args.taskIds.default, 'T-A');
    const leafPhase = flow.phases.find((phase) => phase.type === 'flow');
    assert.ok(leafPhase);
    const reportPhase = flow.phases.find((phase) => phase.id === 'campaign-report');
    assert.equal(reportPhase.run[3], '{args.taskIds}');
    assert.equal(reportPhase.run.at(-2), 'tf-dedupe');
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('epic selects direct child leaves and writes host campaign copy', () => {
  const fx = fixture();
  try {
    const out = path.join(fx.dir, 'outside.json');
    const result = spawnSync(process.execPath, [fx.generator, '--repo', fx.dir, '--bdBin', fx.bdBin, '--epic', 'E-1', '--name', 'epic-flow', '--out', out], { cwd: fx.dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const flow = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(flow.args.taskIds.default, 'T-A,T-RU');
    const hostCopy = path.join(fx.dir, '.pi', 'taskflows', 'epic-flow.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(hostCopy, 'utf8')), flow);
    const leaf = JSON.parse(fs.readFileSync(path.join(fx.dir, '.pi', 'taskflows', 'tf-leaf-mvp-T-RU.json'), 'utf8'));
    assert.match(leaf.args.filesHint.default, /b\.mjs/);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('generated leaf uses cheap reviewers and skips clean final cycles', () => {
  const fx = fixture();
  try {
    const { result } = generate(fx, 'T-A', 'tf-clean');
    assert.equal(result.status, 0, result.stderr);
    const leafPath = path.join(fx.dir, '.pi', 'taskflows', 'tf-leaf-mvp-T-A.json');
    const leaf = JSON.parse(fs.readFileSync(leafPath, 'utf8'));
    for (const phase of leaf.phases.filter((p) => /^review/.test(p.id))) {
      assert.equal(phase.model, 'opencode-go/hy4-flash-free');
    }
    assert.ok(leaf.phases.find((phase) => phase.id === 'review-gate'));
    assert.equal(leaf.phases.find((phase) => phase.id === 'fix').when, '{steps.review-gate.json.needsFix} == true');
    assert.equal(leaf.phases.find((phase) => phase.id === 'final-cycles').when, '{steps.review-gate.json.finalCycleNeeded} == true');
    const cycle = JSON.parse(fs.readFileSync(path.join(fx.dir, '.pi', 'taskflows', 'mvp-final-cycle-T-A.json'), 'utf8'));
    for (const phase of cycle.phases.filter((p) => /^review/.test(p.id))) {
      assert.equal(phase.cache.scope, 'cross-run');
      assert.deepEqual(phase.cache.fingerprint, ['file:.taskflow-mvp/review-fingerprint.txt']);
    }
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('reviewer session reuse disables cross-run cache in final cycles', () => {
  const fx = fixture();
  try {
    const { result } = generate(fx, 'T-A', 'tf-reuse', ['--reuseReviewerSession', 'true']);
    assert.equal(result.status, 0, result.stderr);
    const cycle = JSON.parse(fs.readFileSync(path.join(fx.dir, '.pi', 'taskflows', 'mvp-final-cycle-T-A.json'), 'utf8'));
    for (const phase of cycle.phases.filter((p) => /^review/.test(p.id))) {
      assert.equal(phase.cache, undefined);
      assert.ok(phase.session);
    }
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('generator fails closed on broken epic children JSON', () => {
  const fx = fixture();
  try {
    const out = path.join(fx.dir, 'bad-children.json');
    const result = spawnSync(process.execPath, [fx.generator, '--repo', fx.dir, '--bdBin', fx.bdBin, '--epic', 'E-BAD', '--name', 'bad-children', '--out', out], { cwd: fx.dir, encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bd children returned invalid JSON for E-BAD/);
    assert.equal(fs.existsSync(out), false);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('generator fails when an epic has no eligible code leaves', () => {
  const fx = fixture();
  try {
    const out = path.join(fx.dir, 'no-eligible.json');
    const result = spawnSync(process.execPath, [fx.generator, '--repo', fx.dir, '--bdBin', fx.bdBin, '--epic', 'E-NOACC', '--name', 'no-eligible', '--out', out], { cwd: fx.dir, encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no eligible bd leaves found/);
    assert.equal(fs.existsSync(out), false);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('generator rejects an ineligible explicit task before writing output', () => {
  const fx = fixture();
  try {
    const { result, out } = generate(fx, 'T-CLOSED,T-A', 'tf-reject');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not an eligible code leaf/);
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});
