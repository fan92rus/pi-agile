import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve('docs/plans/taskflow-pilot/mvp/scripts');
test('generated plan-apply phase passes the parent task id', () => {
  const flow = JSON.parse(fs.readFileSync('docs/plans/taskflow-pilot/mvp/flow.json', 'utf8'));
  const phase = flow.phases.find((step) => step.id === 'plan-apply');
  assert.ok(phase.run.includes('TF_MVP_TASK_ID={args.taskId}'));
});
test('planning scripts accept TF_MVP configuration arguments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-planning-'));
  const bd = path.join(dir, process.platform === 'win32' ? 'bd.cmd' : 'bd');
  if (process.platform === 'win32') {
    fs.writeFileSync(bd, '@echo off\r\nif "%1"=="ready" (echo [{"id":"leaf-1","status":"open","description":"Files: a Acceptance: b"}]& exit /b 0)\r\necho {"id":"child-1"}\r\n');
  } else {
    fs.writeFileSync(bd, `#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.includes('ready') ? [{id:'leaf-1',status:'open',description:'Files: a\\nAcceptance: b'}] : {id:'child-1'}))\n`);
    fs.chmodSync(bd, 0o755);
  }
  const backlog = spawnSync(process.execPath, [path.join(root, 'plan-backlog.mjs'), `TF_MVP_REPO=${dir}`, `TF_MVP_BD_BIN=${bd}`], { encoding: 'utf8' });
  assert.equal(backlog.status, 0, backlog.stderr);
  assert.deepEqual(JSON.parse(backlog.stdout).map((row) => row.id), ['leaf-1']);
  const apply = spawnSync(process.execPath, [path.join(root, 'plan-apply.mjs'), `TF_MVP_REPO=${dir}`, `TF_MVP_BD_BIN=${bd}`, 'TF_MVP_TASK_ID=parent'], { encoding: 'utf8' });
  assert.equal(apply.status, 0, apply.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});
