import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const campaign = path.resolve('docs/plans/taskflow-pilot/campaign');
test('queue helpers initialize, allocate, and report dynamic slots', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-dynamic-'));
  const queue = path.join(dir, 'queue.json');
  const run = (script, ...args) => spawnSync(process.execPath, [path.join(campaign, script), ...args], { encoding: 'utf8' });
  let result = run('queue-init.mjs', queue, 'a', 'b');
  assert.equal(result.status, 0, result.stderr);
  result = run('prepare-slot.mjs', queue);
  assert.deepEqual(JSON.parse(result.stdout), { ready: true, taskId: 'a' });
  result = run('dynamic-report.mjs', queue);
  assert.deepEqual(JSON.parse(result.stdout), { pending: ['b'], active: ['a'], completed: [] });
  fs.rmSync(dir, { recursive: true, force: true });
});
