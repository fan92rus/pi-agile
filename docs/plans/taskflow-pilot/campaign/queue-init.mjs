#!/usr/bin/env node
/** Initialize the campaign queue from the selected bd leaf ids. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const fail = (message) => { console.error(`QUEUE INIT FAIL: ${message}`); process.exit(1); };
const [configPath] = process.argv.slice(2);
if (!configPath) fail('usage: node queue-init.mjs <config.json>');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const [bin, ...prefix] = String(config.bdBin || 'bd').match(/\S+/g) || ['bd'];
const bd = (args) => spawnSync(bin, [...prefix, ...args], {
  cwd: config.repo, encoding: 'utf8', shell: false, windowsHide: true,
});
for (const taskId of config.initialTasks || []) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(taskId))) fail(`unsafe task id ${taskId}`);
  const labeled = bd(['label', 'add', String(taskId), 'tf-queued']);
  if (labeled.error || labeled.status !== 0) {
    fail(`bd label add failed for ${taskId}: ${labeled.stderr || labeled.error?.message || 'unknown error'}`);
  }
  const released = bd(['label', 'remove', String(taskId), 'tf-needs-lead']);
  if (released.error || released.status !== 0) {
    fail(`bd label remove failed for ${taskId}: ${released.stderr || released.error?.message || 'unknown error'}`);
  }
}
const queue = {
  version: 2,
  pending: [...(config.initialTasks || [])],
  active: [],
  completed: [],
  decisionDir: config.decisionDir,
  createdAt: new Date().toISOString(),
};
fs.mkdirSync(path.dirname(config.queuePath), { recursive: true });
fs.writeFileSync(config.queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(queue)}\n`);
