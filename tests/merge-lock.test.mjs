import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withLock, releaseLock } from '../docs/plans/taskflow-pilot/mvp/scripts/merge-lock.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockModule = path.join(repoRoot, 'docs', 'plans', 'taskflow-pilot', 'mvp', 'scripts', 'merge-lock.mjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'merge-lock-test-'));
}

function writeOwner(dir, pid) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner.json'), `${JSON.stringify({ pid, createdAt: Date.now() })}\n`);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(dir, old, old);
}

test('live owner lock is never evicted as stale', async () => {
  const dir = tempDir();
  const lock = path.join(dir, 'live.lock');
  try {
    writeOwner(lock, process.pid);
    await assert.rejects(
      withLock(lock, () => {}, { waitMs: 300, staleMs: 1, graceMs: 1 }),
      /timed out waiting for merge lock/,
    );
    const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
    assert.equal(owner.pid, process.pid);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dead owner lock is evicted and reacquired', async () => {
  const dir = tempDir();
  const lock = path.join(dir, 'dead.lock');
  try {
    writeOwner(lock, 2_147_483_647);
    await withLock(lock, async () => {
      const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
      assert.equal(owner.pid, process.pid);
    }, { waitMs: 1000, staleMs: 1, graceMs: 1 });
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release refuses to delete a lock owned by a different token', () => {
  const dir = tempDir();
  const lock = path.join(dir, 'token.lock');
  try {
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify({ pid: process.pid, token: 'owner-b' })}\n`);
    assert.equal(releaseLock(lock, 'owner-a'), false);
    assert.equal(fs.existsSync(lock), true);
    assert.equal(releaseLock(lock, 'owner-b'), true);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unreadable owner file is never evicted', async () => {
  const dir = tempDir();
  const lock = path.join(dir, 'unreadable.lock');
  try {
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), '{not json');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    await assert.rejects(
      withLock(lock, () => {}, { waitMs: 300, staleMs: 1, graceMs: 1 }),
      /timed out waiting for merge lock/,
    );
    assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), '{not json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing owner lock is kept until the stale timeout', async () => {
  const dir = tempDir();
  const lock = path.join(dir, 'missing.lock');
  try {
    fs.mkdirSync(lock, { recursive: true });
    await assert.rejects(
      withLock(lock, () => {}, { waitMs: 300, staleMs: 60_000, graceMs: 1 }),
      /timed out waiting for merge lock/,
    );
    assert.equal(fs.existsSync(lock), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent stale eviction lets one waiter acquire at a time', () => {
  const dir = tempDir();
  const lock = path.join(dir, 'race.lock');
  const runner = path.join(dir, 'runner.mjs');
  try {
    writeOwner(lock, 2_147_483_647);
    fs.writeFileSync(runner, [
      `import fs from 'node:fs';`,
      `import { withLock } from ${JSON.stringify(pathToFileURL(lockModule).href)};`,
      `const claim = process.argv[2];`,
      `await withLock(${JSON.stringify(lock)}, async () => {`,
      `  fs.writeFileSync(claim, String(process.pid));`,
      `  await new Promise((resolve) => setTimeout(resolve, 200));`,
      `}, { waitMs: 5000, staleMs: 1, graceMs: 1 });`,
      '',
    ].join('\n'));
    const claims = [path.join(dir, 'claim-1'), path.join(dir, 'claim-2')];
    const runs = claims.map((claim) => spawnSync(process.execPath, [runner, claim], { encoding: 'utf8', timeout: 10_000 }));
    for (const run of runs) assert.equal(run.status, 0, run.stderr);
    const owners = claims.map((claim) => fs.readFileSync(claim, 'utf8'));
    assert.notEqual(owners[0], owners[1]);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
