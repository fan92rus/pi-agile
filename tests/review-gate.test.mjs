import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = path.join(repoRoot, 'docs', 'plans', 'taskflow-pilot', 'mvp', 'scripts');
const script = path.join(scriptsDir, 'review-gate.mjs');

function run(cwd, blockers, reviews = {}) {
  const dir = path.join(cwd, '.taskflow-mvp');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'blockers.json'), `${JSON.stringify({ needsFix: blockers.length > 0, blockers }, null, 2)}\n`);
  return spawnSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      TF_MVP_WORKTREE_CWD: cwd,
      TF_MVP_REVIEW_CORRECTNESS_JSON: JSON.stringify(reviews.correctness || { verdict: 'pass', blockers: [], evidence: [] }),
      TF_MVP_REVIEW_GUARDRAILS_JSON: JSON.stringify(reviews.guardrails || { verdict: 'pass', blockers: [], evidence: [] }),
    },
  });
}

test('review gate skips the final cycle when both initial reviews pass', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'review-gate-clean-'));
  try {
    const result = run(cwd, []);
    assert.equal(result.status, 0, result.stderr);
    const gate = JSON.parse(result.stdout);
    assert.equal(gate.initialPass, true);
    assert.equal(gate.needsFix, false);
    assert.equal(gate.skipFinal, true);
    assert.equal(gate.finalCycleNeeded, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('review gate does not trust a pass verdict that still lists blockers', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'review-gate-contradiction-'));
  try {
    const result = run(cwd, [], {
      correctness: { verdict: 'pass', blockers: ['contradictory blocker'], evidence: [] },
    });
    assert.equal(result.status, 0, result.stderr);
    const gate = JSON.parse(result.stdout);
    assert.equal(gate.initialPass, false);
    assert.equal(gate.needsFix, true);
    assert.equal(gate.skipFinal, false);
    assert.deepEqual(gate.blockers, ['[-correctness] contradictory blocker']);
    const stored = JSON.parse(fs.readFileSync(path.join(cwd, '.taskflow-mvp', 'blockers.json'), 'utf8'));
    assert.deepEqual(stored.blockers, gate.blockers);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('cycle aggregate rejects a pass verdict that still lists blockers', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cycle-aggregate-'));
  try {
    const result = spawnSync(process.execPath, [path.join(scriptsDir, 'cycle-aggregate.mjs')], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        TF_MVP_WORKTREE_CWD: cwd,
        TF_MVP_CYCLE: '1',
        TF_MVP_MAX_CYCLES: '3',
        TF_MVP_REVIEW_CORRECTNESS_JSON: JSON.stringify({ verdict: 'pass', blockers: ['severe correctness bug'], evidence: [] }),
        TF_MVP_REVIEW_GUARDRAILS_JSON: JSON.stringify({ verdict: 'pass', blockers: [], evidence: [] }),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const aggregate = JSON.parse(result.stdout);
    assert.equal(aggregate.done, false);
    assert.deepEqual(aggregate.blockers, ['[-correctness] severe correctness bug']);
    const stored = JSON.parse(fs.readFileSync(path.join(cwd, '.taskflow-mvp', 'blockers-cycle-1.json'), 'utf8'));
    assert.equal(stored.needsFix, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('rework input rejects a pass verdict that still lists blockers', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rework-input-'));
  try {
    const result = spawnSync(process.execPath, [path.join(scriptsDir, 'rework-input.mjs')], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        TF_MVP_WORKTREE_CWD: cwd,
        TF_MVP_REVIEW_CORRECTNESS_JSON: JSON.stringify({ verdict: 'pass', blockers: ['contradictory'], evidence: [] }),
        TF_MVP_REVIEW_GUARDRAILS_JSON: JSON.stringify({ verdict: 'pass', blockers: [], evidence: [] }),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'NEEDS FIX');
    const stored = JSON.parse(fs.readFileSync(path.join(cwd, '.taskflow-mvp', 'blockers.json'), 'utf8'));
    assert.deepEqual(stored.blockers, ['[-correctness] contradictory']);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

function mergeGateFixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-gate-'));
  const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(cwd, 'README.md'), 'ok\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'init');
  git('branch', 'tf-test');
  fs.writeFileSync(path.join(cwd, '.git', 'info', 'exclude'), '.taskflow-mvp/\n');
  const sha = git('rev-parse', 'tf-test').stdout.trim();
  const dir = path.join(cwd, '.taskflow-mvp');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviewed-sha.txt'), `${sha}\n`);
  return cwd;
}

function runMergeGate(cwd, gate, finalRaw) {
  const dir = path.join(cwd, '.taskflow-mvp');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review-gate.json'), `${JSON.stringify(gate, null, 2)}\n`);
  return spawnSync(process.execPath, [path.join(scriptsDir, 'merge-gate.mjs')], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      TF_MVP_REPO: cwd,
      TF_MVP_WORKTREE_CWD: cwd,
      TF_MVP_BRANCH: 'tf-test',
      TF_MVP_GATES_OUTPUT: 'GATES OK',
      TF_MVP_RECHECK_OUTPUT: 'RECHECK OK (no diff)',
      TF_MVP_FINAL_CYCLE_JSON: finalRaw,
      TF_MVP_REVIEW_GATE_JSON: JSON.stringify(gate),
    },
  });
}

test('merge gate accepts the unresolved placeholder left by a skipped final cycle', () => {
  const cwd = mergeGateFixture();
  try {
    const gate = { initialPass: true, skipFinal: true, finalCycleNeeded: false, blockers: [], needsAttention: null };
    const result = runMergeGate(cwd, gate, '{steps.final-cycles.output}');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MERGE GATE OK/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('merge gate rejects malformed final-cycle output', () => {
  const cwd = mergeGateFixture();
  try {
    const gate = { initialPass: true, skipFinal: true, finalCycleNeeded: false, blockers: [], needsAttention: null };
    const result = runMergeGate(cwd, gate, '{not json');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not valid JSON/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('merge gate rejects missing final-cycle output when a cycle was required', () => {
  const cwd = mergeGateFixture();
  try {
    const gate = { initialPass: false, skipFinal: false, finalCycleNeeded: true, blockers: ['x'], needsAttention: null };
    const result = runMergeGate(cwd, gate, '');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cycle was required/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('review gate requests fix and final cycle when blockers remain', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'review-gate-blocked-'));
  try {
    const result = run(cwd, [], {
      correctness: { verdict: 'block', blockers: ['missing marker'], evidence: [] },
    });
    assert.equal(result.status, 0, result.stderr);
    const gate = JSON.parse(result.stdout);
    assert.equal(gate.needsFix, true);
    assert.equal(gate.skipFinal, false);
    assert.equal(gate.finalCycleNeeded, true);
    assert.deepEqual(gate.blockers, ['[-correctness] missing marker']);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
