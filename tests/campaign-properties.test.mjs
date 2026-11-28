import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve('.');
const campaignDir = path.join(repoRoot, 'docs', 'plans', 'taskflow-pilot', 'campaign');
const mvpScripts = path.join(repoRoot, 'docs', 'plans', 'taskflow-pilot', 'mvp', 'scripts');
const leafGenerator = path.join(mvpScripts, 'make-task-flow.mjs');
const CASES = 24;

function seededRandom(seed) {
  let state = (seed >>> 0) || 1;
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
  return {
    int: (n) => Math.floor(next() * n),
    pick: (items) => items[Math.floor(next() * items.length)],
    shuffle: (items) => [...items].sort(() => next() - 0.5),
  };
}

function writeBdShim(dir, issues, createIds) {
  const shim = path.join(dir, 'bd.mjs');
  fs.writeFileSync(shim, [
    'import fs from "node:fs";',
    `const issues = ${JSON.stringify(issues)};`,
    `const createIds = ${JSON.stringify(createIds)};`,
    'const args = process.argv.slice(2);',
    'if (process.env.BD_CALLS_FILE) fs.appendFileSync(process.env.BD_CALLS_FILE, JSON.stringify(args) + "\\n");',
    'if (args[0] === "ready") { process.stdout.write(JSON.stringify(Object.values(issues).filter((x) => x.status === "open"))); process.exit(0); }',
    'if (args[0] === "show") { const issue = issues[args[1]]; if (!issue) { console.error("issue not found: " + args[1]); process.exit(1); } process.stdout.write(JSON.stringify(issue)); process.exit(0); }',
    'if (args[0] === "create") { const n = Number(fs.existsSync(process.env.BD_COUNTER || "") ? fs.readFileSync(process.env.BD_COUNTER, "utf8") : "0"); fs.writeFileSync(process.env.BD_COUNTER || (process.env.BD_COUNTER = "counter"), String(n + 1)); process.stdout.write(JSON.stringify({ id: createIds[n] })); process.exit(0); }',
    'process.exit(0);',
    '',
  ].join('\n'));
  return `node ${shim.replaceAll('\\', '/')}`;
}

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-properties-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeQueue(file, queue) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

test('property: prepare-slot never loses or duplicates queue ids', (t) => {
  const ids = ['P-A', 'P-B', 'P-C', 'P-D', 'P-E'];
  for (let seed = 1; seed <= CASES; seed += 1) {
    const rnd = seededRandom(seed);
    const fx = temp();
    try {
      const prepared = ids.map((id) => ({
        id,
        status: rnd.int(5) === 0 ? 'closed' : 'open',
        title: id,
        description: rnd.int(4) === 0 ? 'no markers here' : 'Files: a.mjs Acceptance: works',
      }));
      const issues = Object.fromEntries(prepared.map((issue) => [issue.id, issue]));
      const bdBin = writeBdShim(fx.dir, issues, []);
      const decisionDir = path.join(fx.dir, 'decisions');
      fs.mkdirSync(decisionDir, { recursive: true });
      const queuePath = path.join(fx.dir, 'queue.json');
      const original = rnd.shuffle(ids).slice(0, 1 + rnd.int(ids.length));
      const active = rnd.shuffle(ids.filter((id) => !original.includes(id))).slice(0, rnd.int(2));
      writeQueue(queuePath, { version: 2, pending: original, active, completed: [], skipped: [] });
      const configPath = path.join(fx.dir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        repo: fx.dir, bdBin, queuePath, decisionDir,
        flowProjectRoot: fx.dir, slotArtifactDir: path.join(fx.dir, 'slots'),
        leafGenerator, worktreeRoot: path.join(fx.dir, 'worktrees'),
        branchPrefix: 'tf-prop', testCommand: 'npm test', maxCycles: 1,
        reuseReviewerSession: 'false', reviewerModel: 'r', plannerModel: 'p',
        mergeLock: path.join(fx.dir, 'lock'), queueParent: '', slots: ['tf-prop-slot'],
      }));
      fs.mkdirSync(path.join(fx.dir, 'slots'), { recursive: true });
      const result = spawnSync(process.execPath, [path.join(campaignDir, 'prepare-slot.mjs'), configPath, '0'], { encoding: 'utf8' });
      assert.equal(result.status, 0, `seed ${seed}: ${result.stderr}`);
      const queue = readJson(queuePath);
      const buckets = [queue.pending, queue.active, queue.completed, queue.skipped.map((row) => row.id)].flat();
      assert.equal(new Set(buckets).size, buckets.length, `seed ${seed}: duplicate id in queue buckets`);
      assert.deepEqual([...buckets].sort(), [...new Set([...original, ...active])].sort(), `seed ${seed}: id lost from queue`);
      const selection = JSON.parse(result.stdout);
      const hasEligible = original.some((id) => issues[id]?.status === 'open' && /(?:Files:|Файлы:)/.test(issues[id].description) && issues[id].description.includes('Acceptance:'));
      if (hasEligible) assert.equal(selection.ready, true, `seed ${seed}: eligible queued task was not selected`);
      if (selection.ready) {
        assert.ok(original.includes(selection.taskId), `seed ${seed}: selected id was not in pending`);
        const issue = issues[selection.taskId];
        assert.equal(issue.status, 'open', `seed ${seed}: selected closed task`);
        assert.match(issue.description, /(?:Files:|Файлы:)/, `seed ${seed}: selected task without Files`);
        assert.match(issue.description, /Acceptance:/, `seed ${seed}: selected task without Acceptance`);
      } else {
        assert.equal(queue.skipped.length, new Set(original).size, `seed ${seed}: every unusable id must be recorded`);
      }
    } finally { fx.cleanup(); }
  }
  t.diagnostic(`checked ${CASES} seeded queue states`);
});

test('property: dynamic-report status matches queue cleanliness and task results', (t) => {
  for (let seed = 1; seed <= CASES; seed += 1) {
    const rnd = seededRandom(seed + 1000);
    const fx = temp();
    try {
      const ids = ['R-A', 'R-B', 'R-C'];
      const tasks = ids.slice(0, 1 + rnd.int(ids.length));
      const queuePath = path.join(fx.dir, 'queue.json');
      const scenario = seed % 3;
      const active = scenario === 2 ? rnd.pick([[tasks[0]], ['R-X']]) : [];
      const pending = scenario === 2 ? ['R-Y'] : [];
      const skipped = scenario === 2 ? [{ id: 'R-Z', reason: 'bad' }] : [];
      const completed = rnd.pick([[], ['R-C']]);
      writeQueue(queuePath, { version: 2, pending, active, completed, skipped });
      const resultsDir = path.join(fx.dir, '.pi', 'taskflows', 'results');
      fs.mkdirSync(resultsDir, { recursive: true });
      const slotArtifactDir = path.join(fx.dir, 'slots');
      fs.mkdirSync(slotArtifactDir, { recursive: true });
      for (const [index, taskId] of tasks.entries()) {
        const merged = scenario === 0 ? true : scenario === 1 ? false : rnd.int(4) !== 0;
        fs.writeFileSync(path.join(resultsDir, `${taskId}.json`), JSON.stringify({
          status: merged ? 'merged' : 'failed', merged, bdClosed: merged,
          blockers: merged ? [] : ['x'], needsAttention: merged ? null : 'x',
        }));
        fs.writeFileSync(path.join(slotArtifactDir, `slot-${index}.json`), JSON.stringify({
          slot: index, phaseId: `leaf-slot-${index}`, taskId, ready: true,
        }));
      }
      const configPath = path.join(fx.dir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        name: `prop-${seed}`, repo: fx.dir, flowProjectRoot: fx.dir,
        queuePath, slotArtifactDir, dynamicReportScript: path.join(campaignDir, 'dynamic-report.mjs'),
        slots: tasks.map((_, index) => `slot-${index}`),
      }));
      const result = spawnSync(process.execPath, [path.join(campaignDir, 'dynamic-report.mjs'), configPath], { encoding: 'utf8' });
      assert.equal(result.error, undefined, `seed ${seed}: ${result.error?.message || 'spawn error'}`);
      assert.match(result.stdout, /^\{/, `seed ${seed}: report stdout was not JSON: ${result.stderr}`);
      let summary;
      try { summary = JSON.parse(result.stdout); }
      catch (e) { assert.fail(`seed ${seed}: invalid report JSON: ${e.message}`); }
      const artifact = readJson(path.join(resultsDir, `campaign-prop-${seed}.json`));
      assert.deepEqual(artifact, summary, `seed ${seed}: artifact differs from stdout`);
      const allMerged = tasks.every((taskId) => readJson(path.join(resultsDir, `${taskId}.json`)).merged);
      const clean = !summary.queue.pending.length && !summary.queue.active.length && !summary.queue.skipped.length;
      assert.equal(summary.status, allMerged && clean ? 'merged' : 'failed', `seed ${seed}: wrong status`);
      assert.equal(result.status, summary.status === 'merged' ? 0 : 1, `seed ${seed}: wrong exit code`);
      if (!clean) assert.match(summary.reason, /queue is not clean/, `seed ${seed}: missing queue reason`);
      else if (!allMerged) assert.match(summary.reason, /leaf results failed/, `seed ${seed}: missing result reason`);
    } finally { fx.cleanup(); }
  }
  t.diagnostic(`checked ${CASES} seeded report states`);
});

test('property: planner output never mutates the current task', (t) => {
  for (let seed = 1; seed <= CASES; seed += 1) {
    const rnd = seededRandom(seed + 2000);
    const fx = temp();
    try {
      const action = ['none', 'spawn', 'needsLeadDecision'][seed % 3];
      const childCount = action === 'none' ? rnd.int(4) : 1 + rnd.int(3);
      const createIds = Array.from({ length: childCount }, (_, index) => `CHILD-${seed}-${index}`);
      const callsFile = path.join(fx.dir, 'calls.log');
      const bdBin = writeBdShim(fx.dir, {}, createIds);
      const queuePath = path.join(fx.dir, 'queue.json');
      writeQueue(queuePath, { version: 2, pending: [], active: [], completed: [], skipped: [] });
      const worktree = path.join(fx.dir, 'worktree');
      fs.mkdirSync(path.join(worktree, '.taskflow-mvp'), { recursive: true });
      const planning = {
        action,
        reason: 'property case',
        leadQuestion: 'proceed?',
        children: createIds.map((id) => ({ title: id, description: 'Files: a.mjs Acceptance: works' })),
      };
      const result = spawnSync(process.execPath, [path.join(mvpScripts, 'plan-apply.mjs')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          TF_MVP_BD_BIN: bdBin,
          TF_MVP_REPO: fx.dir,
          TF_MVP_WORKTREE_CWD: worktree,
          TF_MVP_FLOW_PROJECT_ROOT: fx.dir,
          TF_MVP_TASK_ID: `PARENT-${seed}`,
          TF_MVP_QUEUE_PARENT: 'EPIC-1',
          TF_MVP_QUEUE_PATH: queuePath,
          TF_MVP_PLANNING_JSON: JSON.stringify(planning),
          BD_CALLS_FILE: callsFile,
          BD_COUNTER: path.join(fx.dir, 'counter'),
        },
      });
      assert.equal(result.status, 0, `seed ${seed}: ${result.stderr}`);
      const decision = readJson(path.join(worktree, '.taskflow-mvp', 'planning.json'));
      assert.equal(decision.action, action, `seed ${seed}: action changed`);
      const expected = action === 'none' ? 0 : childCount;
      assert.equal(decision.childIds.length, expected, `seed ${seed}: wrong child count`);
      const queue = readJson(queuePath);
      if (action === 'spawn') assert.deepEqual(queue.pending.sort(), createIds.sort(), `seed ${seed}: spawned children not queued`);
      else assert.deepEqual(queue.pending, [], `seed ${seed}: parked children entered queue`);
      const decisionsDir = path.join(fx.dir, '.pi', 'taskflows', 'lead-decisions');
      const parked = fs.existsSync(decisionsDir) ? fs.readdirSync(decisionsDir).filter((name) => name.endsWith('.json')) : [];
      assert.equal(parked.length, action === 'needsLeadDecision' ? expected : 0, `seed ${seed}: wrong decision file count`);
      const calls = (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8') : '').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.ok(!calls.some((args) => ['close', 'reopen', 'update'].includes(args[0]) && args.includes(`PARENT-${seed}`)), `seed ${seed}: current task mutated`);
    } finally { fx.cleanup(); }
  }
  t.diagnostic(`checked ${CASES} seeded planner decisions`);
});
