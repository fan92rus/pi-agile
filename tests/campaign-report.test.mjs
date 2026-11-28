import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'docs', 'plans', 'taskflow-pilot', 'campaign', 'report.mjs');

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-report-'));
}

function run(repo, taskList, campaignName) {
  const args = [script, repo, taskList];
  if (campaignName) args.push(campaignName);
  return spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', windowsHide: true });
}

function result(status) {
  return {
    status,
    commit: status === 'merged' ? 'abc123' : null,
    merged: status === 'merged',
    bdClosed: status === 'merged',
    needsAttention: status === 'merged' ? null : 'attention',
    blockers: status === 'merged' ? [] : ['blocker'],
  };
}

test('campaign report prints a merged summary and writes the campaign artifact', () => {
  const repo = tempRepo();
  try {
    const results = path.join(repo, '.pi', 'taskflows', 'results');
    fs.mkdirSync(results, { recursive: true });
    fs.writeFileSync(path.join(results, 'T-OK.json'), JSON.stringify(result('merged')));

    const runResult = run(repo, 'T-OK', 'wave-ok');
    assert.equal(runResult.status, 0, runResult.stderr);
    const printed = JSON.parse(runResult.stdout);
    assert.equal(printed.status, 'merged');
    assert.equal(printed.tasks[0].taskId, 'T-OK');

    const artifact = JSON.parse(fs.readFileSync(path.join(results, 'campaign-wave-ok.json'), 'utf8'));
    assert.deepEqual(artifact, printed);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('campaign report writes the artifact even when a leaf failed', () => {
  const repo = tempRepo();
  try {
    const results = path.join(repo, '.pi', 'taskflows', 'results');
    fs.mkdirSync(results, { recursive: true });
    fs.writeFileSync(path.join(results, 'T-OK.json'), JSON.stringify(result('merged')));
    fs.writeFileSync(path.join(results, 'T-BAD.json'), JSON.stringify(result('failed')));

    const runResult = run(repo, 'T-OK,T-BAD', 'wave-bad');
    assert.equal(runResult.status, 1);
    const printed = JSON.parse(runResult.stdout);
    assert.equal(printed.status, 'failed');
    assert.equal(printed.tasks[1].needsAttention, 'attention');

    const artifact = JSON.parse(fs.readFileSync(path.join(results, 'campaign-wave-bad.json'), 'utf8'));
    assert.deepEqual(artifact, printed);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('campaign report creates the results directory for the artifact', () => {
  const repo = tempRepo();
  try {
    const runResult = run(repo, 'T-MISSING', 'wave-missing');
    assert.equal(runResult.status, 1);
    const printed = JSON.parse(runResult.stdout);
    assert.equal(printed.status, 'failed');
    assert.equal(printed.tasks[0].status, 'missing');

    const artifact = path.join(repo, '.pi', 'taskflows', 'results', 'campaign-wave-missing.json');
    assert.ok(fs.existsSync(artifact));
    assert.deepEqual(JSON.parse(fs.readFileSync(artifact, 'utf8')), printed);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('campaign report rejects an unsafe campaign name before printing', () => {
  const repo = tempRepo();
  try {
    const runResult = run(repo, 'T-OK', '../escape');
    assert.notEqual(runResult.status, 0);
    assert.equal(runResult.stdout, '');
    assert.match(runResult.stderr, /campaignName must contain only/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('campaign report rejects unsafe task ids', () => {
  const repo = tempRepo();
  try {
    const runResult = run(repo, '../secret', 'wave-unsafe');
    assert.notEqual(runResult.status, 0);
    assert.equal(runResult.stdout, '');
    assert.match(runResult.stderr, /task ids must contain only/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
