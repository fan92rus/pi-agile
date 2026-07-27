/**
 * Smoke test: verify pi-agile modules load and basic functions work.
 * Run with: node --experimental-strip-types tests/smoke.test.mjs
 */
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const EXT_DIR = path.join(import.meta.dirname, "..", "extensions", "pi-agile");

async function importModule(relPath) {
  const fullPath = path.join(EXT_DIR, relPath);
  return import(pathToFileURL(fullPath).href);
}

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ❌ ${name}: ${e.message}`);
  }
}

console.log("# pi-agile smoke tests\n");

// ── knowledge.ts ──────────────────────────────────────────────────
console.log("## knowledge.ts");

const { KnowledgeBase } = await importModule(path.join("parallel", "knowledge.ts"));

await test("KnowledgeBase loads empty file", () => {
  const kb = new KnowledgeBase();
  const tmpDir = path.join(import.meta.dirname, "tmp-kb-test");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpDir, ".agile"), { recursive: true });
  kb.load(tmpDir);
  assert.strictEqual(kb.formatLessons(), "(none yet)");
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await test("KnowledgeBase append + save + reload", () => {
  const kb = new KnowledgeBase();
  const tmpDir = path.join(import.meta.dirname, "tmp-kb-test2");
  fs.rmSync(tmpDir, { recursive: true, force: true });

  kb.append({ type: "lesson", sprint: 1, ts: "2026-07-27", finding: "Test lesson" });
  kb.append({ type: "dead_end", sprint: 1, ts: "2026-07-27", approach: "bad", do_not_retry: "bad approach" });
  kb.save(tmpDir);

  const kb2 = new KnowledgeBase();
  kb2.load(tmpDir);
  assert.ok(kb2.formatLessons().includes("Test lesson"), "lesson should be present");
  assert.ok(kb2.formatDeadEnds().includes("bad approach"), "dead_end should be present");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await test("KnowledgeBase formatAll returns empty when no entries", () => {
  const kb = new KnowledgeBase();
  assert.strictEqual(kb.formatAll(), "");
});

// ── sprint.ts ────────────────────────────────────────────────────
console.log("\n## sprint.ts");

const { SprintStore } = await importModule(path.join("parallel", "sprint.ts"));

await test("SprintStore create + save + load", () => {
  const tmpDir = path.join(import.meta.dirname, "tmp-sprint-test");
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const store = new SprintStore();
  const sprint = store.create(tmpDir, 1, "Test goal");
  assert.strictEqual(sprint.id, 1);
  assert.strictEqual(sprint.goal, "Test goal");
  assert.strictEqual(sprint.status, "planning");

  // Reload
  const store2 = new SprintStore();
  const loaded = store2.load(tmpDir, 1);
  assert.ok(loaded, "sprint should load");
  assert.strictEqual(loaded.goal, "Test goal");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await test("SprintStore task lifecycle", () => {
  const tmpDir = path.join(import.meta.dirname, "tmp-sprint-test2");
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const store = new SprintStore();
  const sprint = store.create(tmpDir, 1, "Test");
  store.addTask(sprint, { bd_id: "bd-1", title: "Task 1", status: "backlog" });

  assert.strictEqual(sprint.tasks.length, 1);
  assert.strictEqual(sprint.tasks[0].branch, "feat/bd-1");
  assert.strictEqual(sprint.tasks[0].review_rounds, 0);

  store.markRework(sprint, "bd-1");
  assert.strictEqual(sprint.tasks[0].status, "rework");

  store.markDone(sprint, "bd-1");
  assert.strictEqual(sprint.tasks[0].status, "done");
  assert.strictEqual(sprint.tasks[0].final_verdict, "approved");

  const vel = store.computeVelocity(sprint);
  assert.strictEqual(vel.done, 1);
  assert.strictEqual(vel.attempted, 1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await test("SprintStore findLastSprintId", () => {
  const tmpDir = path.join(import.meta.dirname, "tmp-sprint-test3");
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const store = new SprintStore();
  assert.strictEqual(store.findLastSprintId(tmpDir), 0);

  store.create(tmpDir, 1, "S1");
  store.create(tmpDir, 3, "S3");
  store.create(tmpDir, 2, "S2");

  const store2 = new SprintStore();
  assert.strictEqual(store2.findLastSprintId(tmpDir), 3);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── review.ts ────────────────────────────────────────────────────
console.log("\n## review.ts");

const { buildReviewerTask, buildWorkerTask, parseReviewVerdict } = await importModule(path.join("parallel", "review.ts"));

await test("buildWorkerTask includes constraints and dead-ends", () => {
  const task = buildWorkerTask("Fix bug", "Fix the bug", undefined, "rule1", "deadend1");
  assert.ok(task.includes("Fix bug"));
  assert.ok(task.includes("rule1"));
  assert.ok(task.includes("deadend1"));
  assert.ok(task.includes("conventional commit"));
});

await test("buildReviewerTask includes diff and dimensions", () => {
  const task = buildReviewerTask("Title", "Desc", "diff content", "constraints", "patterns", "deep");
  assert.ok(task.includes("diff content"));
  assert.ok(task.includes("Architecture"));
  assert.ok(task.includes("Security"));
  assert.ok(task.includes("approved") || task.includes("rework"));
});

await test("parseReviewVerdict extracts JSON verdict", () => {
  const response = 'Some text\n```json\n{"status":"approved","dimensions":{},"action_items":[],"lessons":["learned"]}\n```\nMore text';
  const verdict = parseReviewVerdict(response);
  assert.strictEqual(verdict.status, "approved");
  assert.strictEqual(verdict.lessons.length, 1);
  assert.strictEqual(verdict.lessons[0], "learned");
});

await test("parseReviewVerdict falls back on bad JSON", () => {
  const verdict = parseReviewVerdict("This looks approved to me!");
  assert.ok(verdict.status === "approved" || verdict.status === "rework");
});

await test("parseReviewVerdict detects blocked", () => {
  const verdict = parseReviewVerdict('{"status":"blocked","dimensions":{},"action_items":["fundamental flaw"],"lessons":[]}');
  assert.strictEqual(verdict.status, "blocked");
});

// ── observer.ts ──────────────────────────────────────────────────
console.log("\n## observer.ts");

const { createObserverState, runSprintObserver, trackConstraintViolation, trackTaskTransition, DEFAULT_OBSERVER_CONFIG } = await importModule("observer.ts");

await test("runSprintObserver detects blocked sprint", () => {
  const state = { id: 1, goal: "test", status: "active", tasks: [
    { bd_id: "1", title: "t1", status: "blocked", review_rounds: 0, branch: "feat/1" },
  ], started_at: "2026-07-27" };
  const obs = createObserverState();
  const steers = runSprintObserver(state, obs, DEFAULT_OBSERVER_CONFIG);
  const blocked = steers.find(s => s.type === "all_blocked");
  assert.ok(blocked, "should detect all_blocked");
});

await test("runSprintObserver detects stagnation", () => {
  const state = { id: 1, goal: "test", status: "active", tasks: [
    { bd_id: "1", title: "t1", status: "rework", review_rounds: 3, branch: "feat/1" },
  ], started_at: "2026-07-27" };
  const obs = createObserverState();
  trackTaskTransition(obs, "1", "rework");
  trackTaskTransition(obs, "1", "rework");
  trackTaskTransition(obs, "1", "rework");
  const steers = runSprintObserver(state, obs, DEFAULT_OBSERVER_CONFIG);
  const stagnation = steers.find(s => s.type === "stagnation");
  assert.ok(stagnation, "should detect stagnation");
});

await test("trackConstraintViolation increments", () => {
  const obs = createObserverState();
  trackConstraintViolation(obs, "rule1");
  trackConstraintViolation(obs, "rule1");
  trackConstraintViolation(obs, "rule1");
  assert.strictEqual(obs.constraintViolations.get("rule1"), 3);
});

// ── index.ts: parseBdShow ────────────────────────────────────────
console.log("\n## index.ts: parseBdShow");

// We can't import index.ts directly (needs pi runtime), but parseBdShow is standalone.
// Test the regex logic inline by re-implementing minimally.
await test("parseBdShow extracts title from bd output", () => {
  const bdOutput = `○ agile-test-9do · Fix hardcoded credentials in auth.js   [● P2 · OPEN]
Owner: fan92rus · Type: task
Created: 2026-07-27 · Updated: 2026-07-27

DESCRIPTION
Replace hardcoded password check with proper credential validation`;

  const firstLine = bdOutput.split("\n")[0] ?? "";
  const titleMatch = firstLine.match(/·\s+(.+?)\s+\[/);
  assert.ok(titleMatch, "title regex should match");
  assert.strictEqual(titleMatch[1].trim(), "Fix hardcoded credentials in auth.js");
});

await test("parseBdShow extracts description section", () => {
  const bdOutput = `○ agile-test-9do · Some task   [● P2 · OPEN]

DESCRIPTION
Replace hardcoded password check with proper credential validation

ACCEPTANCE CRITERIA
No hardcoded secrets`;

  const descMatch = bdOutput.match(/DESCRIPTION\n([\s\S]*?)(?:\n[A-Z]|$)/);
  assert.ok(descMatch, "description regex should match");
  assert.ok(descMatch[1].includes("Replace hardcoded"));
});

// ── Summary ──────────────────────────────────────────────────────
console.log(`\n# Results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
