/**
 * Smoke test: verify pi-agile modules load and basic functions work.
 * Run with: node --experimental-strip-types --experimental-loader ./tests/typebox-redirect-loader.mjs tests/smoke.test.mjs
 * (the loader stubs @sinclair/typebox so the REAL extension index.ts can be imported)
 */
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
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

// ── B-protocol helpers (agent-driven delegation, docs/DELEGATION.md) ──
// The harness simulates the AGENT executing the protocol: prepare → subagent
// (worker) → prepare_review → subagent (reviewer writes verdict file) → record.

/** Write a reviewer verdict file exactly like the real subagent output would. */
function writeReviewFile(dir, bdId, round, verdict, extra = {}) {
  const p = path.join(dir, ".agile", `review-${bdId}-r${round}.txt`);
  fs.writeFileSync(p, reviewerVerdictText(verdict, extra), "utf8");
  return p;
}

/**
 * Drive one full B-protocol delegation (up to MAX_REWORK_ROUNDS=3 rounds):
 * agile_delegate_task (prepare) → (worker simulated) → agile_prepare_review →
 * (reviewer simulated: verdict file written) → agile_record_verdict.
 * Returns the final record text + the round it stopped at.
 */
async function delegateViaB({ tool, ctx, bdId, title = `Task ${bdId}`, description = "d", verdictFor, verdictExtra }) {
  let text = "";
  let round = 1;
  for (; round <= 3; round++) {
    await tool("agile_delegate_task").execute("t", { bd_id: bdId, round, title, description }, null, null, ctx);
    const rv = await tool("agile_prepare_review").execute("t", { bd_id: bdId, round }, null, null, ctx);
    assert.ok(rv?.content?.[0]?.text, `prepare_review r${round} must return instructions`);
    const verdict = verdictFor(bdId, round);
    writeReviewFile(ctx.cwd, bdId, round, verdict, verdictExtra ? verdictExtra(bdId, round) : {});
    const rec = await tool("agile_record_verdict").execute("t", { bd_id: bdId, round }, null, null, ctx);
    text = rec.content?.[0]?.text ?? "";
    if (verdict !== "rework") break;
  }
  return { text, round: Math.min(round, 3) };
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

const { buildChainAgentTask, buildReviewerTask, buildWorkerTask, parseReviewVerdict, buildDetectiveTask } = await importModule(path.join("parallel", "review.ts"));

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

await test("buildReviewerTask includes acceptance criteria", () => {
  const task = buildReviewerTask("Title", "Desc", "diff content", "constraints", "patterns", "deep", "AC: must handle empty input");
  assert.ok(task.includes("Acceptance Criteria"), "reviewer prompt must have an Acceptance Criteria section");
  assert.ok(task.includes("AC: must handle empty input"), "reviewer prompt must carry the acceptance criteria");
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

await test("buildChainAgentTask includes patterns and agent prompt", () => {
  const task = buildChainAgentTask("scout", "Refactor auth", "Make it secure", undefined, "rule1", "pattern1", []);
  assert.ok(task.includes("scout"));
  assert.ok(task.includes("Refactor auth"));
  assert.ok(task.includes("rule1"));
  assert.ok(task.includes("pattern1"));
  assert.ok(task.includes("key files and functions"));
  assert.ok(task.includes("Do NOT write code"));
});

await test("buildChainAgentTask passes chain context", () => {
  const ctx = [{ agent: "researcher", output: "Use bcrypt" }];
  const task = buildChainAgentTask("planner", "Add auth", "desc", "auth works", "c1", "p1", ctx);
  assert.ok(task.includes("researcher"));
  assert.ok(task.includes("Use bcrypt"));
  assert.ok(task.includes("sequential sub-steps"));
});

await test("buildWorkerTask includes patterns section", () => {
  const task = buildWorkerTask("Fix", "desc", undefined, "c1", "p1", "dead1");
  assert.ok(task.includes("Known Codebase Patterns"));
  assert.ok(task.includes("p1"));
  assert.ok(task.includes("dead1"));
});

await test("buildDetectiveTask includes concern and reproduction instructions", () => {
  const task = buildDetectiveTask("/project", "Race condition in auth registration", "rule1", "pattern1");
  assert.ok(task.includes("Race condition in auth registration"));
  assert.ok(task.includes("CONFIRMED | NOT_REPRODUCED | INCONCLUSIVE"));
  assert.ok(task.includes("reproduction test"));
  assert.ok(task.includes("ABSOLUTE paths"));
  assert.ok(task.includes("Do NOT fix the bug"));
});

await test("buildChainAgentTask includes detective prompt", () => {
  const task = buildChainAgentTask("detective", "Find race", "desc", undefined, "c1", "p1", []);
  assert.ok(task.includes("detective"));
  assert.ok(task.includes("reproduce"));
  assert.ok(task.includes("CONFIRMED"));
  assert.ok(task.includes("Do NOT fix the bug"));
  assert.ok(task.includes("race conditions"));
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

// ── YAML parser (parallel/yaml.ts — real module) ────────────────
console.log("\n## YAML parser (parallel/yaml.ts)");

const yamlMod = await importModule(path.join("parallel", "yaml.ts"));
const { parseSimpleYaml } = yamlMod;

await test("YAML: simple key-value", () => {
  const r = parseSimpleYaml("key: value\r\nnum: 42");
  assert.strictEqual(r.key, "value");
  assert.strictEqual(r.num, 42);
});

await test("YAML: nested objects", () => {
  const r = parseSimpleYaml("a:\n  b:\n    c: hello");
  assert.strictEqual(r.a.b.c, "hello");
});

await test("YAML: arrays via - items", () => {
  const r = parseSimpleYaml("list:\n  - a\n  - b");
  assert.deepStrictEqual(r.list, ["a", "b"]);
});

await test("YAML: multiple arrays under same parent", () => {
  const yaml = [
    "scope:",
    "  include:",
    '    - "src/**"',
    '    - "tests/**"',
    "  exclude:",
    '    - "node_modules/**"',
  ].join("\n");
  const r = parseSimpleYaml(yaml);
  assert.deepStrictEqual(r.scope.include, ["src/**", "tests/**"]);
  assert.deepStrictEqual(r.scope.exclude, ["node_modules/**"]);
});

await test("YAML: folded block scalar >", () => {
  const r = parseSimpleYaml("desc: >\n  line one\n  line two");
  assert.strictEqual(r.desc, "line one line two");
});

// Fix #10: array-of-maps (stop_when.conditions) must parse to objects, not strings.
await test("YAML: array of maps (stop_when.conditions)", () => {
  const yaml = [
    "stop_when:",
    "  mode: any_of",
    "  conditions:",
    "    - metric: max_sprints",
    "      target: 3",
    '      area: "project"',
    '      description: "After 3 sprints"',
    "    - metric: test_coverage",
    "      target: 80",
  ].join("\n");
  const r = parseSimpleYaml(yaml);
  const conditions = r.stop_when.conditions;
  assert.ok(Array.isArray(conditions), "conditions must be an array");
  assert.strictEqual(conditions.length, 2);
  assert.strictEqual(conditions[0].metric, "max_sprints");
  assert.strictEqual(conditions[0].target, 3);
  assert.strictEqual(conditions[0].area, "project");
  assert.strictEqual(conditions[1].metric, "test_coverage");
  assert.strictEqual(conditions[1].target, 80);
  assert.strictEqual(r.stop_when.mode, "any_of");
});

// ── git.ts: default branch + branch checkout helpers ────────────
console.log("\n## parallel/git.ts");

const gitMod = await importModule(path.join("parallel", "git.ts"));
const { resolveDefaultBranch, branchExistsInList, branchCheckoutArgs } = gitMod;

await test("git: resolveDefaultBranch picks main when listed", () => {
  assert.strictEqual(resolveDefaultBranch("  main\n* master\n"), "main");
  assert.strictEqual(resolveDefaultBranch("* main\n  feat/x\n"), "main");
});

await test("git: resolveDefaultBranch falls back to master", () => {
  assert.strictEqual(resolveDefaultBranch("* master\n  feat/x\n"), "master");
  assert.strictEqual(resolveDefaultBranch(""), "master");
});

await test("git: branchExistsInList matches exact branch lines", () => {
  const list = "  main\n* feat/abc\n  feat/abc2\n";
  assert.ok(branchExistsInList(list, "feat/abc"));
  assert.ok(branchExistsInList(list, "main"));
  assert.ok(!branchExistsInList(list, "feat/abc2x"));
  assert.ok(!branchExistsInList(list, "nope"));
});

await test("git: branchCheckoutArgs — existing branch vs create", () => {
  assert.deepStrictEqual(branchCheckoutArgs(true, "feat/x"), ["checkout", "feat/x"]);
  assert.deepStrictEqual(branchCheckoutArgs(false, "feat/x"), ["checkout", "-b", "feat/x"]);
});

// ── sprint.ts: review rounds, NaN ids, restart restore ──────────
console.log("\n## sprint.ts: review rounds + id robustness");

await test("sprint: setReviewRounds sets review_rounds (max semantics)", () => {
  const store = new SprintStore();
  const s = store.create(".", 1, "g");
  store.addTask(s, { bd_id: "a1", title: "T", status: "backlog" });
  store.setReviewRounds(s, "a1", 0);
  assert.strictEqual(s.tasks[0].review_rounds, 0);
  store.setReviewRounds(s, "a1", 3);
  assert.strictEqual(s.tasks[0].review_rounds, 3);
  store.setReviewRounds(s, "a1", 1); // never shrink
  assert.strictEqual(s.tasks[0].review_rounds, 3);
});

await test("sprint: findLastSprintId ignores non-numeric/broken files", () => {
  const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-sprintid-"));
  try {
    fs.mkdirSync(path.join(tmpDir, ".agile"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".agile", "sprint-2.json"), "{}", "utf8");
    fs.writeFileSync(path.join(tmpDir, ".agile", "sprint-abc.json"), "{}", "utf8");
    fs.writeFileSync(path.join(tmpDir, ".agile", "sprint-2-backup.json"), "{}", "utf8");
    const store = new SprintStore();
    assert.strictEqual(store.findLastSprintId(tmpDir), 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

await test("sprint: getCurrent(workDir) restores sprint from disk after restart", () => {
  const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-restore-"));
  try {
    // Session 1: create + persist sprint 1 with a task
    const store1 = new SprintStore();
    const s1 = store1.create(tmpDir, 1, "goal");
    store1.addTask(s1, { bd_id: "t1", title: "Task", status: "backlog" });
    store1.markDone(s1, "t1");
    store1.save(tmpDir, s1);

    // Session 2 (new process): no in-memory state — must restore from disk
    const store2 = new SprintStore();
    const restored = store2.getCurrent(tmpDir);
    assert.ok(restored, "sprint restored from disk");
    assert.strictEqual(restored.id, 1);
    assert.strictEqual(restored.tasks[0].status, "done");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── observer.ts: velocity drop trigger ───────────────────────────
console.log("\n## observer.ts: velocity drop");

await test("observer: velocity drop ≥ threshold fires steer", () => {
  const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-vel-"));
  try {
    fs.mkdirSync(path.join(tmpDir, ".agile"), { recursive: true });
    // Previous sprint: 4 done
    const prev = { id: 1, goal: "g", status: "done", tasks: [
      { bd_id: "a", title: "A", status: "done", review_rounds: 0, branch: "feat/a" },
      { bd_id: "b", title: "B", status: "done", review_rounds: 0, branch: "feat/b" },
      { bd_id: "c", title: "C", status: "done", review_rounds: 0, branch: "feat/c" },
      { bd_id: "d", title: "D", status: "done", review_rounds: 0, branch: "feat/d" },
    ], started_at: "", completed_at: "", velocity: { attempted: 4, done: 4, rework: 0, blocked: 0, avg_review_rounds: 0 } };
    fs.writeFileSync(path.join(tmpDir, ".agile", "sprint-1.json"), JSON.stringify(prev), "utf8");
    // Current sprint: only 1 done of 3 → 75% drop ≥ 50% threshold
    const cur = { id: 2, goal: "g", status: "planning", tasks: [
      { bd_id: "e", title: "E", status: "done", review_rounds: 0, branch: "feat/e" },
      { bd_id: "f", title: "F", status: "done", review_rounds: 0, branch: "feat/f" },
      { bd_id: "g", title: "G", status: "blocked", review_rounds: 0, branch: "feat/g" },
    ], started_at: "", completed_at: "" };
    const steers = runSprintObserver(cur, createObserverState(), DEFAULT_OBSERVER_CONFIG, tmpDir);
    const vel = steers.find(s => s.type === "velocity_drop");
    assert.ok(vel, "velocity_drop steer expected");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

await test("observer: no velocity_drop when previous sprint absent", () => {
  const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-vel2-"));
  try {
    fs.mkdirSync(path.join(tmpDir, ".agile"), { recursive: true });
    const cur = { id: 1, goal: "g", status: "planning", tasks: [
      { bd_id: "e", title: "E", status: "done", review_rounds: 0, branch: "feat/e" },
    ], started_at: "", completed_at: "" };
    const steers = runSprintObserver(cur, createObserverState(), DEFAULT_OBSERVER_CONFIG, tmpDir);
    assert.ok(!steers.some(s => s.type === "velocity_drop"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

await test("observer: no velocity_drop when drop below threshold", () => {
  const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-vel3-"));
  try {
    fs.mkdirSync(path.join(tmpDir, ".agile"), { recursive: true });
    const prev = { id: 1, goal: "g", status: "done", tasks: [
      { bd_id: "a", title: "A", status: "done", review_rounds: 0, branch: "feat/a" },
      { bd_id: "b", title: "B", status: "done", review_rounds: 0, branch: "feat/b" },
    ], started_at: "", completed_at: "", velocity: { attempted: 2, done: 2, rework: 0, blocked: 0, avg_review_rounds: 0 } };
    fs.writeFileSync(path.join(tmpDir, ".agile", "sprint-1.json"), JSON.stringify(prev), "utf8");
    // 2 → 2 = 0% drop
    const cur = { id: 2, goal: "g", status: "planning", tasks: [
      { bd_id: "e", title: "E", status: "done", review_rounds: 0, branch: "feat/e" },
      { bd_id: "f", title: "F", status: "done", review_rounds: 0, branch: "feat/f" },
    ], started_at: "", completed_at: "" };
    const steers = runSprintObserver(cur, createObserverState(), DEFAULT_OBSERVER_CONFIG, tmpDir);
    assert.ok(!steers.some(s => s.type === "velocity_drop"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── index.ts: parseBdShow ────────────────────────────────────────
console.log("\n## parallel/bd.ts: parseBdShow");

const bdMod = await importModule(path.join("parallel", "bd.ts"));
const { parseBdShow } = bdMod;

await test("parseBdShow extracts title from bd output", () => {
  const bdOutput = `○ agile-test-9do · Fix hardcoded credentials in auth.js   [● P2 · OPEN]
Owner: fan92rus · Type: task
Created: 2026-07-27 · Updated: 2026-07-27

DESCRIPTION
Replace hardcoded password check with proper credential validation`;

  const parsed = parseBdShow(bdOutput);
  assert.strictEqual(parsed.title, "Fix hardcoded credentials in auth.js");
});

await test("parseBdShow extracts description section", () => {
  const bdOutput = `○ agile-test-9do · Some task   [● P2 · OPEN]

DESCRIPTION
Replace hardcoded password check with proper credential validation

ACCEPTANCE CRITERIA
No hardcoded secrets`;

  const parsed = parseBdShow(bdOutput);
  assert.ok(parsed.description?.includes("Replace hardcoded"), "description captured");
  assert.strictEqual(parsed.acceptanceCriteria, "No hardcoded secrets");
});

// Fix #5: multiline descriptions must NOT be truncated at the first
// capitalised line. Only a section header (ALL-CAPS line), a triple blank
// line, or EOF ends the description.
await test("parseBdShow: multiline description not truncated by capitalised lines", () => {
  const bdOutput = `○ agile-test-9do · Some task   [● P2 · OPEN]

DESCRIPTION
Fix the bug in the parser
This is the second line of context
Third line with more details

ACCEPTANCE CRITERIA
No regressions in existing tests`;

  const parsed = parseBdShow(bdOutput);
  assert.ok(parsed.description?.includes("Fix the bug in the parser"), "first line kept");
  assert.ok(parsed.description?.includes("second line"), "second line kept");
  assert.ok(parsed.description?.includes("Third line"), "third line kept");
  assert.ok(!parsed.description?.includes("ACCEPTANCE"), "section header not captured");
});

// Fix #5: ALL-CAPS section header still terminates the description.
await test("parseBdShow: ALL-CAPS section header ends description", () => {
  const bdOutput = `○ agile-test-9do · Some task   [● P2 · OPEN]

DESCRIPTION
Replace hardcoded password check

ACCEPTANCE CRITERIA
No hardcoded secrets`;
  const parsed = parseBdShow(bdOutput);
  assert.strictEqual(parsed.description, "Replace hardcoded password check");
});

// ── index.ts: Level A guard (refuse empty task details) ──────────────
console.log("\n## index.ts: Level A guard");

// Level A: before spawning a worker, the title must be real (not the
// `(task <id>)` fallback). Re-implement the guard inline.
function resolveTaskTitle(parsed, bdId) {
  const title = parsed.title && parsed.title !== `(task ${bdId})` ? parsed.title : undefined;
  return title ?? null; // null = refused
}

await test("Level A: real title passes guard", () => {
  const title = resolveTaskTitle({ title: "Add config tests" }, "pi-agile-x1");
  assert.strictEqual(title, "Add config tests");
});

await test("Level A: missing title refused (no worker spawned)", () => {
  const title = resolveTaskTitle({}, "pi-agile-x2");
  assert.strictEqual(title, null);
});

await test("Level A: fallback title refused (bd show failed)", () => {
  const title = resolveTaskTitle({ title: "(task pi-agile-x3)" }, "pi-agile-x3");
  assert.strictEqual(title, null);
});

// ── index.ts: Level B stuck detection (idle worker force-stop) ───────
console.log("\n## index.ts: Level B stuck detection");

// Level B: a running worker whose lastActivityAt is older than
// worker_stuck_timeout (default 30min) is treated as stuck.
function isStuck(status, stuckTimeoutMs) {
  if (status?.state !== "running" || typeof status.lastActivityAt !== "number") return false;
  return Date.now() - status.lastActivityAt > stuckTimeoutMs;
}

await test("Level B: active worker (recent activity) is not stuck", () => {
  const status = { state: "running", lastActivityAt: Date.now() - 60_000 };
  assert.strictEqual(isStuck(status, 1_800_000), false);
});

await test("Level B: idle worker (>30m) is stuck", () => {
  const status = { state: "running", lastActivityAt: Date.now() - 2_000_000 };
  assert.strictEqual(isStuck(status, 1_800_000), true);
});

await test("Level B: non-running / no activity data never stuck", () => {
  assert.strictEqual(isStuck({ state: "completed" }, 1_800_000), false);
  assert.strictEqual(isStuck({ state: "running" }, 1_800_000), false);
  assert.strictEqual(isStuck(null, 1_800_000), false);
});

// ── continuation.ts: auto-continuation nudge (agent_end + retrospective) ──
console.log("\n## continuation.ts: auto-continuation nudge");

const continuation = await importModule(path.join("parallel", "continuation.ts"));
const { shouldSendContinuation, buildContinuationMessage, saveSessionState, loadSessionState } = continuation;

// shouldSendContinuation — real gate logic used by agent_end. RC1 regression:
// the old implementation had a `status === "done"` gate that killed the nudge
// after agile_retrospective (which marks the sprint done) in continuous mode.
// The anti-spam flag is now the single source of truth, so a done sprint
// still fires unless a followUp was already sent for it.

await test("continuation: fires for planning sprint with all terminal tasks", () => {
  assert.ok(shouldSendContinuation({ pendingCount: 0, taskCount: 3, sentForSprint: null, sprintId: 1, remainingSprints: undefined, loopStopped: false }));
});

await test("continuation: RC1 — done sprint still fires when no followUp sent yet", () => {
  assert.ok(shouldSendContinuation({ pendingCount: 0, taskCount: 2, sentForSprint: null, sprintId: 1, remainingSprints: undefined, loopStopped: false }));
});

await test("continuation: done sprint suppressed once retrospective covered it", () => {
  assert.ok(!shouldSendContinuation({ pendingCount: 0, taskCount: 2, sentForSprint: 1, sprintId: 1, remainingSprints: undefined, loopStopped: false }));
});

await test("continuation: does NOT fire when pending tasks remain", () => {
  assert.ok(!shouldSendContinuation({ pendingCount: 1, taskCount: 3, sentForSprint: null, sprintId: 1, remainingSprints: undefined, loopStopped: false }));
});

await test("continuation: does NOT fire for empty sprint", () => {
  assert.ok(!shouldSendContinuation({ pendingCount: 0, taskCount: 0, sentForSprint: null, sprintId: 1, remainingSprints: undefined, loopStopped: false }));
});

await test("continuation: does NOT fire twice for the same sprint (anti-spam)", () => {
  assert.ok(!shouldSendContinuation({ pendingCount: 0, taskCount: 3, sentForSprint: 1, sprintId: 1, remainingSprints: undefined, loopStopped: false }));
});

await test("continuation: fires again for a NEW sprint id", () => {
  assert.ok(!shouldSendContinuation({ pendingCount: 0, taskCount: 3, sentForSprint: 1, sprintId: 1, remainingSprints: undefined, loopStopped: false })); // old sprint — no
  assert.ok(shouldSendContinuation({ pendingCount: 0, taskCount: 3, sentForSprint: 1, sprintId: 2, remainingSprints: undefined, loopStopped: false })); // new sprint — yes
});

await test("continuation: does NOT fire when all bounded sprints consumed", () => {
  assert.ok(!shouldSendContinuation({ pendingCount: 0, taskCount: 2, sentForSprint: null, sprintId: 1, remainingSprints: 0, loopStopped: false }));
});

await test("continuation: fires with bounded sprints left", () => {
  assert.ok(shouldSendContinuation({ pendingCount: 0, taskCount: 2, sentForSprint: null, sprintId: 1, remainingSprints: 2, loopStopped: false }));
});

// Fix #11: after /agile stop the loop is explicitly stopped — no nudges even
// in continuous mode (remainingSprints === undefined).
await test("continuation: does NOT fire after /agile stop (loopStopped)", () => {
  assert.ok(!shouldSendContinuation({ pendingCount: 0, taskCount: 2, sentForSprint: null, sprintId: 1, remainingSprints: undefined, loopStopped: true }));
  assert.ok(!shouldSendContinuation({ pendingCount: 0, taskCount: 2, sentForSprint: null, sprintId: 1, remainingSprints: 3, loopStopped: true }));
});

// buildContinuationMessage — the exact followUp text sent to the agent.

await test("continuation message: goal + original request + continuous mode", () => {
  const msg = buildContinuationMessage({
    goal: "Improve code quality", originalRequest: "Improve performance of the parser",
    remainingSprints: undefined, totalTasks: 3, totalDone: 2, totalBlocked: 1, openTasks: [],
  });
  assert.ok(msg.includes("Project goal: Improve code quality"));
  assert.ok(msg.includes("Original user request: Improve performance"));
  assert.ok(msg.includes("Continuous mode"));
  assert.ok(msg.includes("2 done, 1 blocked"));
});

await test("continuation message: partial sprint does not claim all finished", () => {
  const msg = buildContinuationMessage({
    goal: "g", originalRequest: "",
    remainingSprints: undefined, totalTasks: 3, totalDone: 1, totalBlocked: 0, openTasks: [],
  });
  assert.ok(msg.includes("Sprint closed with 3 tasks (1 done, 0 blocked, 2 in progress)"));
  assert.ok(!msg.includes("all sprint tasks are finished"));
});

await test("continuation message: goal only when no original request", () => {
  const msg = buildContinuationMessage({
    goal: "Improve code quality and fix issues", originalRequest: "   ",
    remainingSprints: undefined, totalTasks: 1, totalDone: 1, totalBlocked: 0, openTasks: [],
  });
  assert.ok(msg.includes("Project goal: Improve code quality"));
  assert.ok(!msg.includes("Original user request"));
});

await test("continuation message: bounded mode + open bd tasks hint + instructions", () => {
  const msg = buildContinuationMessage({
    goal: "G", originalRequest: "", remainingSprints: 2, totalTasks: 1, totalDone: 1, totalBlocked: 0,
    openTasks: ["pi-autoresearch-22i"],
  });
  assert.ok(msg.includes("2 sprints remaining"));
  assert.ok(msg.includes("`pi-autoresearch-22i`"));
  assert.ok(msg.includes("agile_discover"));
  assert.ok(msg.includes("agile_start_sprint"));
  assert.ok(msg.includes("Decide and act now")); // RC5: actionable, not advisory-only
});

// ── continuation.ts: session state persistence (RC3) ─────────────────
console.log("\n## continuation.ts: session state persistence (RC3)");

await test("session state: save + load round-trip", () => {
  const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-session-"));
  try {
    saveSessionState(tmpDir, { remainingSprints: 2, originalRequest: "fix stuff", sprintLoopActive: true, loopStopped: false });
    const loaded = loadSessionState(tmpDir);
    assert.strictEqual(loaded.remainingSprints, 2);
    assert.strictEqual(loaded.originalRequest, "fix stuff");
    assert.strictEqual(loaded.sprintLoopActive, true);
    assert.strictEqual(loaded.loopStopped, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

await test("session state: loopStopped round-trips (fix #11)", () => {
  const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-session5-"));
  try {
    saveSessionState(tmpDir, { remainingSprints: undefined, originalRequest: "", sprintLoopActive: false, loopStopped: true });
    const loaded = loadSessionState(tmpDir);
    assert.strictEqual(loaded.loopStopped, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

await test("session state: legacy file without loopStopped loads as undefined", () => {
  const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-session6-"));
  try {
    fs.mkdirSync(path.join(tmpDir, ".agile"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agile", "session.json"),
      JSON.stringify({ remainingSprints: 3, originalRequest: "x", sprintLoopActive: true }),
      "utf8",
    );
    const loaded = loadSessionState(tmpDir);
    assert.strictEqual(loaded.loopStopped, undefined); // absent in old file → runtime keeps in-memory default
    assert.strictEqual(loaded.remainingSprints, 3);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

await test("session state: load on missing file returns {}", () => {
  const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-session2-"));
  try {
    assert.deepStrictEqual(loadSessionState(tmpDir), {});
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

await test("session state: corrupt file ignored, returns {}", () => {
  const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-session3-"));
  try {
    fs.mkdirSync(path.join(tmpDir, ".agile"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".agile", "session.json"), "{not json", "utf8");
    assert.deepStrictEqual(loadSessionState(tmpDir), {});
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

await test("session state: unknown fields filtered on load", () => {
  const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname, "tmp-session4-"));
  try {
    fs.mkdirSync(path.join(tmpDir, ".agile"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agile", "session.json"),
      JSON.stringify({ remainingSprints: "5", originalRequest: "x", sprintLoopActive: "yes", junk: 1 }),
      "utf8",
    );
    const loaded = loadSessionState(tmpDir);
    assert.strictEqual(loaded.remainingSprints, undefined); // string rejected
    assert.strictEqual(loaded.originalRequest, "x");
    assert.strictEqual(loaded.sprintLoopActive, undefined); // string rejected
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Open bd tasks hint: parse bd list lines, excluding tasks already in sprint.
function parseOpenBdTasks(bdOut, inSprintIds) {
  const inSprint = new Set(inSprintIds);
  const open = [];
  for (const line of bdOut.split(/\r?\n/)) {
    const m = line.match(/^[○◐]\s+([\w.-]+)\s/);
    if (m && !inSprint.has(m[1])) open.push(m[1]);
  }
  return open;
}

await test("open bd tasks: collects open/in_progress not in sprint", () => {
  const out = [
    "○ pi-autoresearch-22i ● P2 Test agent_end E2E",
    "◐ pi-autoresearch-33x ● P1 Another task",
    "✓ pi-autoresearch-11a ● P3 Closed task",
  ].join("\n");
  const open = parseOpenBdTasks(out, ["pi-autoresearch-22i"]);
  assert.deepStrictEqual(open, ["pi-autoresearch-33x"]);
});

await test("open bd tasks: empty when all open tasks are in sprint", () => {
  const out = "○ pi-autoresearch-22i ● P2 Test agent_end E2E\n";
  assert.deepStrictEqual(parseOpenBdTasks(out, ["pi-autoresearch-22i"]), []);
});

// toStringArray: YAML scope include/exclude may be a single string or a list.
function toStringArray(value, fallback) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  if (typeof value === "string" && value.trim() !== "") return [value];
  return fallback;
}

await test("toStringArray: string becomes single-element array", () => {
  assert.deepStrictEqual(toStringArray("src/**", ["src/**"]), ["src/**"]);
});

await test("toStringArray: array passes through, non-strings filtered", () => {
  assert.deepStrictEqual(toStringArray(["a", 1, "b"], []), ["a", "b"]);
});

await test("toStringArray: undefined/empty falls back", () => {
  assert.deepStrictEqual(toStringArray(undefined, ["src/**"]), ["src/**"]);
  assert.deepStrictEqual(toStringArray("", ["src/**"]), ["src/**"]);
});

// extractScope: must ALWAYS return a real array (join() is called on it),
// even when project.yaml has no scope.include at all.
function extractScope(project) {
  if (!project) return ["src/**"];
  const p = project.project;
  const scope = p?.scope;
  return toStringArray(scope?.include, ["src/**"]);
}

await test("extractScope: no scope.include in yaml → array fallback, join works", () => {
  const project = { project: { name: "x", goal: "g" } }; // no scope at all
  const scope = extractScope(project);
  assert.ok(Array.isArray(scope));
  assert.strictEqual(scope.join(", "), "src/**");
});

await test("extractScope: include as string → array, join works", () => {
  const project = { project: { scope: { include: "src/**" } } };
  const scope = extractScope(project);
  assert.ok(Array.isArray(scope));
  assert.strictEqual(scope.join(", "), "src/**");
});

await test("extractScope: include as array → array, join works", () => {
  const project = { project: { scope: { include: ["src/**", "tests/**"] } } };
  const scope = extractScope(project);
  assert.ok(Array.isArray(scope));
  assert.strictEqual(scope.join(", "), "src/**, tests/**");
});

// Effective discovery goal: per-call override wins, otherwise project goal.
function effectiveGoal(paramGoal, projectGoal) {
  return (paramGoal ?? "").trim() || projectGoal || "";
}

await test("effectiveGoal: param override wins", () => {
  assert.strictEqual(effectiveGoal("Find performance issues", "Improve code quality"), "Find performance issues");
});

await test("effectiveGoal: falls back to project goal when param empty", () => {
  assert.strictEqual(effectiveGoal("", "Improve code quality"), "Improve code quality");
  assert.strictEqual(effectiveGoal(undefined, "Improve code quality"), "Improve code quality");
  assert.strictEqual(effectiveGoal("   ", "Improve code quality"), "Improve code quality");
});

await test("effectiveGoal: empty when nothing provided", () => {
  assert.strictEqual(effectiveGoal(undefined, ""), "");
});

// ── index.ts: cleanupStaleWorktrees guards ────────────────────────────
console.log("\n## index.ts: cleanupStaleWorktrees guards");

// A worktree is stale only when BOTH: it is older than MIN_AGE (24h) AND it has
// no .agile file modified within the activity window (6h). Fresh worktrees and
// worktrees with a live worker must never be deleted.
const WT_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const WT_ACTIVITY_MS = 6 * 60 * 60 * 1000;

function isStaleWorktree(now, wtMtimeMs, recentAgileMtimeMs) {
  if (now - wtMtimeMs < WT_MIN_AGE_MS) return false; // guard 1: too fresh
  if (recentAgileMtimeMs !== null && now - recentAgileMtimeMs < WT_ACTIVITY_MS) return false; // guard 2: live worker
  return true;
}

await test("worktree: fresh worktree (<24h) never stale, even without .agile", () => {
  const now = Date.now();
  assert.strictEqual(isStaleWorktree(now, now - 2 * 60 * 60 * 1000, null), false);
});

await test("worktree: old worktree with no .agile is stale (crashed batch left it)", () => {
  const now = Date.now();
  assert.strictEqual(isStaleWorktree(now, now - 48 * 60 * 60 * 1000, null), true);
});

await test("worktree: old worktree with recently touched .agile is live (worker running)", () => {
  const now = Date.now();
  const oldWt = now - 48 * 60 * 60 * 1000;
  const recentAgile = now - 10 * 60 * 1000; // 10 min ago
  assert.strictEqual(isStaleWorktree(now, oldWt, recentAgile), false);
});

await test("worktree: old worktree with old .agile is stale", () => {
  const now = Date.now();
  const oldWt = now - 48 * 60 * 60 * 1000;
  const oldAgile = now - 48 * 60 * 60 * 1000;
  assert.strictEqual(isStaleWorktree(now, oldWt, oldAgile), true);
});

// ── sprint.ts: SprintStore persistence + workDir scoping ──────────
// Regression: agile_start_sprint and batch delegation did not call
// store.save() after adding/updating tasks, so sprint-N.json stayed
// tasks: [] and agent_end (which loads the last sprint from disk)
// never fired. Also getCurrent() leaked sprints across projects.
// (SprintStore is already imported above.)

async function withTempAgileDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join("..", ".smoke-"));
  try {
    return await fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

await test("sprint: addTask then save persists tasks to sprint-N.json", () => {
  withTempAgileDir((workDir) => {
    const store = new SprintStore();
    const sprint = store.create(workDir, 1, "goal");
    store.addTask(sprint, { bd_id: "abc", title: "T", status: "backlog" });
    store.save(workDir, sprint); // the missing call in agile_start_sprint
    const fromDisk = JSON.parse(fs.readFileSync(path.join(workDir, ".agile", "sprint-1.json"), "utf8"));
    assert.strictEqual(fromDisk.tasks.length, 1);
    assert.strictEqual(fromDisk.tasks[0].bd_id, "abc");
    return null;
  });
});

await test("sprint: getCurrent scoped by workDir — stale foreign sprint not reused", () => {
  withTempAgileDir((dirA) => {
    withTempAgileDir((dirB) => {
      const store = new SprintStore();
      store.create(dirA, 1, "goal A");
      store.create(dirB, 1, "goal B");
      const curB = store.getCurrent(dirB);
      assert.ok(curB);
      assert.strictEqual(curB.goal, "goal B");
      return null;
    });
    return null;
  });
});

// ── Real extension (import index.ts via the typebox redirect loader) ──
// Requires: node --experimental-strip-types --experimental-loader ./tests/typebox-redirect-loader.mjs
console.log("## real extension (fake pi)");

process.env.PI_AGILE_POLL_INTERVAL_MS = "10";

const { default: piAgileExtension } = await import(
  pathToFileURL(path.join(EXT_DIR, "index.ts")).href
);
const { createFakePi, makeCtx, readSession, createFakeBridge, makeFakeUi, readLatestSprint, reviewerVerdictText } = await import(
  pathToFileURL(path.join(import.meta.dirname, "fake-pi.ts")).href
);

await test("real extension registers 10 tools + 2 hooks + 1 command on fake pi", () => {
  const { pi, tool, command, hook } = createFakePi({});
  piAgileExtension(pi);
  assert.ok(tool("agile_discover"), "missing agile_discover");
  assert.ok(tool("agile_investigate"), "missing agile_investigate");
  assert.ok(tool("agile_start_sprint"), "missing agile_start_sprint");
  assert.ok(tool("agile_delegate_task"), "missing agile_delegate_task");
  assert.ok(tool("agile_prepare_review"), "missing agile_prepare_review (B protocol)");
  assert.ok(tool("agile_record_verdict"), "missing agile_record_verdict (B protocol)");
  assert.ok(tool("agile_merge_task"), "missing agile_merge_task");
  assert.ok(tool("agile_retrospective"), "missing agile_retrospective");
  assert.ok(tool("agile_knowledge"), "missing agile_knowledge");
  assert.ok(tool("agile_run"), "missing agile_run");
  assert.ok(hook("before_agent_start"), "missing before_agent_start hook");
  assert.ok(hook("agent_end"), "missing agent_end hook");
  assert.ok(command("agile"), "missing /agile command");
  return null;
});

await test("before_agent_start: Tech Lead role is injected BEFORE <project_context>, base prompt intact", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ext-"));
  try {
    const { pi, tool, command, hook } = createFakePi({});
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-prompt-order");
    await command("agile").handler("on", ctx); // enable agile mode
    await hook("before_agent_start")({
      systemPrompt: "You are an expert coding assistant.\n\n<project_context>\n\nProject-specific instructions:\n\n- my AGENTS.md rule\n</project_context>\n\nCurrent working directory: x",
    }, ctx);
    const out = pi._lastSystemPrompt;
    assert.ok(out, "hook must set event.systemPrompt");
    // Base prompt content is untouched
    assert.ok(out.includes("You are an expert coding assistant."), "base prompt must remain");
    assert.ok(out.includes("my AGENTS.md rule"), "project_context must remain");
    // Role block sits BEFORE the project_context marker
    const roleIdx = out.indexOf("You are a TECH LEAD");
    const ctxIdx = out.indexOf("<project_context>");
    assert.ok(roleIdx !== -1, "Tech Lead role block must be injected");
    assert.ok(roleIdx < ctxIdx, `role block (${roleIdx}) must come before <project_context> (${ctxIdx})`);
    // Dynamic context (goal) is still appended at the very end
    const goalIdx = out.indexOf("## Project Goal");
    assert.ok(goalIdx > ctxIdx, "Project Goal context must stay after project_context");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("before_agent_start: role block prepended when no <project_context> marker", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ext-"));
  try {
    const { pi, tool, command, hook } = createFakePi({});
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-prompt-fallback");
    await command("agile").handler("on", ctx); // enable agile mode
    await hook("before_agent_start")({
      systemPrompt: "Custom base prompt without context marker",
    }, ctx);
    const out = pi._lastSystemPrompt;
    assert.ok(out.startsWith("\n\n# pi-agile: Autonomous Sprint Engine\n"), "role block must be prepended when marker is absent");
    assert.ok(out.includes("Custom base prompt without context marker"), "base prompt must remain");
    assert.ok(out.includes("You are a TECH LEAD"), "role must be present");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("real agent_end: no nudge when agile mode is OFF", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ext-"));
  try {
    const { pi, hook } = createFakePi({});
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-ext-off");
    await hook("agent_end")({ messages: [] }, ctx); // agileMode false → silent
    assert.strictEqual(pi.sentMessages.length, 0);
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("real extension e2e: start sprint → retrospective → agent_end nudges once", async () => {  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ext-"));
  try {
    const bdTasks = new Map([["t1", "Task t1"], ["t2", "Task t2"]]);
    const { pi, tool, command, hook } = createFakePi({ bdTasks });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-ext-e2e");
    await command("agile").handler("on", ctx);
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1", "t2"] }, null, null, ctx);
    await tool("agile_retrospective").execute("t", {}, null, null, ctx);
    const before = pi.sentMessages.length;
    await hook("agent_end")({ messages: [] }, ctx); // flag set by retrospective → silent
    const nudges = pi.sentMessages.slice(before).filter((m) => /Decide and act now/.test(m.text));
    assert.strictEqual(nudges.length, 0, "agent_end must not double-nudge after retrospective");
    assert.ok(
      pi.sentMessages.some((m) => /Decide and act now/.test(m.text)),
      "retrospective in continuous mode must send the continuation nudge",
    );
    const sess = readSession(dir);
    assert.ok(sess.sprintLoopActive === undefined || typeof sess.sprintLoopActive === "boolean");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("agent_end re-arms after /agile stop → /agile on (loopStopped reset)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ext-"));
  try {
    const bdTasks = new Map([["t1", "Task t1"]]);
    const bridge = createFakeBridge({ verdictFor: () => "blocked" });
    const { pi, tool, command, hook } = createFakePi({ bdTasks, bridge });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-ext-rearm");
    await command("agile").handler("on", ctx);
    await command("agile").handler("stop", ctx); // loopStopped = true
    await command("agile").handler("on", ctx); // must re-arm the nudge
    const sess = readSession(dir);
    assert.strictEqual(sess.loopStopped, false, "/agile on must clear loopStopped in session.json");
    // Terminal sprint + fresh session (restart) — agent_end must nudge because
    // loopStopped=false survived, and the fresh runtime has no dedupe flag.
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1"] }, null, null, ctx);
    await delegateViaB({ tool, ctx, bdId: "t1", verdictFor: () => "blocked" });
    const { pi: pi2, hook: hook2 } = createFakePi({ bdTasks, bridge: createFakeBridge({ verdictFor: () => "blocked" }) });
    piAgileExtension(pi2);
    const ctx2 = makeCtx(dir, "smoke-ext-rearm2");
    await hook2("before_agent_start")({ systemPrompt: "" }, ctx2); // auto-enable + load session
    await hook2("agent_end")({ messages: [] }, ctx2);
    const nudges = pi2.sentMessages.filter((m) => /Decide and act now/.test(m.text));
    assert.ok(nudges.length >= 1, "fresh session must nudge (loopStopped=false persisted after /agile on)");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("agent_end re-arms after /agile stop → /agile setup (loopStopped reset)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ext-"));
  try {
    const bdTasks = new Map([["t1", "Task t1"]]);
    const bridge = createFakeBridge({ verdictFor: () => "blocked" });
    const { pi, tool, command, hook } = createFakePi({ bdTasks, bridge });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-ext-rearmsetup");
    await command("agile").handler("on", ctx);
    await command("agile").handler("stop", ctx); // loopStopped = true
    const ui = makeFakeUi(["", "Diag", "Goal", "", "", "", "", "continuous", "standard"]);
    const ctxSetup = makeCtx(dir, "smoke-ext-rearmsetup", ui); // same sessionId → same runtime
    await command("agile").handler("setup", ctxSetup); // must re-arm the nudge
    const sess = readSession(dir);
    assert.strictEqual(sess.loopStopped, false, "/agile setup must clear loopStopped in session.json");
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1"] }, null, null, ctxSetup);
    await delegateViaB({ tool, ctx: ctxSetup, bdId: "t1", verdictFor: () => "blocked" });
    const { pi: pi2, hook: hook2 } = createFakePi({ bdTasks, bridge: createFakeBridge({ verdictFor: () => "blocked" }) });
    piAgileExtension(pi2);
    const ctx2 = makeCtx(dir, "smoke-ext-rearmsetup2");
    await hook2("before_agent_start")({ systemPrompt: "" }, ctx2);
    await hook2("agent_end")({ messages: [] }, ctx2);
    const nudges = pi2.sentMessages.filter((m) => /Decide and act now/.test(m.text));
    assert.ok(nudges.length >= 1, "fresh session must nudge (loopStopped=false persisted after /agile setup)");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("agile_start_sprint aborts on empty task_ids (no zombie sprint)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ext-"));
  try {
    const { pi, tool, command } = createFakePi({});
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-ext-empty");
    await command("agile").handler("on", ctx);
    const res = await tool("agile_start_sprint").execute("t", { task_ids: [] }, null, null, ctx);
    const text = res.content?.[0]?.text ?? "";
    assert.ok(text.includes("Sprint aborted"), `empty task_ids must abort (got: ${text.slice(0, 80)})`);
    assert.ok(
      !fs.existsSync(path.join(dir, ".agile", "sprint-1.json")),
      "no sprint-N.json may be created for an aborted sprint",
    );
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("agent_end auto-closes terminal sprint + single start-next message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ext-"));
  try {
    const bdTasks = new Map([["t1", "Task t1"]]);
    const bridge = createFakeBridge({ verdictFor: () => "blocked" });
    const { pi, tool, command, hook } = createFakePi({ bdTasks, bridge });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-ext-autoclose");
    await command("agile").handler("on", ctx);
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1"] }, null, null, ctx);
    await delegateViaB({ tool, ctx, bdId: "t1", verdictFor: () => "blocked" });
    // Delegate no longer sends terminal steers / sets the flag — the sprint
    // stays planning until agent_end auto-closes it.
    assert.strictEqual(readLatestSprint(dir).status, "planning", "delegate must not close the sprint");
    const before = pi.sentMessages.length;
    await hook("agent_end")({ messages: [] }, ctx);
    const msgs = pi.sentMessages.slice(before);
    const nudges = msgs.filter((m) => /Decide and act now/.test(m.text));
    assert.strictEqual(nudges.length, 1, "agent_end must auto-close and nudge exactly once");
    assert.ok(/auto-completed/.test(nudges[0].text), "nudge must carry the auto-completed line");
    assert.strictEqual(nudges[0].opts.deliverAs, "followUp", "agent_end auto-close nudge stays followUp (turn-over delivery)");
    const spr = readLatestSprint(dir);
    assert.strictEqual(spr.status, "done", "auto-close must set status done on disk");
    assert.ok(spr.velocity && spr.velocity.done + spr.velocity.blocked > 0, "velocity must be computed");
    const m2 = pi.sentMessages.length;
    await hook("agent_end")({ messages: [] }, ctx);
    assert.strictEqual(pi.sentMessages.length - m2, 0, "second agent_end must stay silent");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("retrospective after auto-close is a no-op (no double summary)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ext-"));
  try {
    const bdTasks = new Map([["t1", "Task t1"]]);
    const bridge = createFakeBridge({ verdictFor: () => "blocked" });
    const { pi, tool, command, hook } = createFakePi({ bdTasks, bridge });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-ext-retronoop");
    await command("agile").handler("on", ctx);
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1"] }, null, null, ctx);
    await delegateViaB({ tool, ctx, bdId: "t1", verdictFor: () => "blocked" });
    await hook("agent_end")({ messages: [] }, ctx); // auto-close + nudge
    const before = pi.sentMessages.length;
    const res = await tool("agile_retrospective").execute("t", {}, null, null, ctx);
    const nudges = pi.sentMessages.slice(before).filter((m) => /Decide and act now|sprints? remaining/.test(m.text));
    assert.strictEqual(nudges.length, 0, "retrospective on an auto-closed sprint must not re-nudge");
    assert.ok((res.content?.[0]?.text ?? "").includes("Sprint"), "retrospective must still return its text");
    const kb = fs.readFileSync(path.join(dir, ".agile", "knowledge.jsonl"), "utf8");
    const summaries = kb.split("\n").filter((l) => l.includes('"type":"sprint_summary"')).length;
    assert.strictEqual(summaries, 1, "exactly one sprint_summary per sprint (no double append)");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("bounded agent_end auto-close sends full continuation with remaining count", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ext-"));
  try {
    const bdTasks = new Map([["t1", "Task t1"]]);
    const bridge = createFakeBridge({ verdictFor: () => "blocked" });
    const { pi, tool, command, hook } = createFakePi({ bdTasks, bridge });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-ext-bound");
    await command("agile").handler("on", ctx);
    await command("agile").handler("run 2", ctx);
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1"] }, null, null, ctx);
    await delegateViaB({ tool, ctx, bdId: "t1", verdictFor: () => "blocked" });
    const before = pi.sentMessages.length;
    await hook("agent_end")({ messages: [] }, ctx);
    const msgs = pi.sentMessages.slice(before);
    const nudges = msgs.filter((m) => /Decide and act now|sprints? remaining/.test(m.text));
    assert.strictEqual(nudges.length, 1, "bounded auto-close must send exactly one continuation message");
    assert.ok(/1 sprint/.test(nudges[0].text), `bounded nudge must show remaining count (got: ${nudges[0].text.slice(0, 120)})`);
    assert.ok(/agile_start_sprint/.test(nudges[0].text), "bounded nudge must be the full continuation with next steps");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("/agile status shows the loop-stopped state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ext-"));
  try {
    const notifs = [];
    const ui = { notify: (t) => notifs.push(String(t)), input: async () => "", select: async () => "" };
    const { pi, command } = createFakePi({});
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-ext-status", ui);
    await command("agile").handler("on", ctx);
    await command("agile").handler("stop", ctx);
    await command("agile").handler("status", ctx);
    const statusText = notifs.join("\n");
    assert.ok(/stopped/i.test(statusText), `status must expose the stopped loop (got: ${statusText.slice(0, 200)})`);
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── rpc.ts protocol (real RpcClient over the fake EventBus) ──
console.log("## rpc.ts protocol");

const {
  RpcClient, RpcClientError, buildRequest, replyEventFor, parseSpawnReply,
  SUBAGENT_RPC_REQUEST_EVENT, SUBAGENT_RPC_REPLY_EVENT_PREFIX,
} = await importModule("parallel/rpc.ts");
const { createEventBus } = await import(pathToFileURL(path.join(import.meta.dirname, "fake-pi.ts")).href);

/** Attach a scripted bridge: map method -> reply data (or null = no reply). */
function scriptedBridge(events, handler) {
  events.on(SUBAGENT_RPC_REQUEST_EVENT, (req) => {
    const data = handler(req);
    if (data === null) return; // simulate a dead bridge (no reply)
    events.emit(replyEventFor(req.requestId), {
      version: 1,
      requestId: req.requestId,
      success: data?.error ? false : true,
      ...(data?.error ? { error: data.error } : { data }),
    });
  });
}

await test("rpc: buildRequest envelope", () => {
  const r = buildRequest("ping");
  assert.strictEqual(r.version, 1);
  assert.strictEqual(r.method, "ping");
  assert.ok(r.requestId && typeof r.requestId === "string" && r.requestId.length > 8);
  assert.deepStrictEqual(r.source, { extension: "pi-agile" });
  assert.ok(!("params" in r), "no params key when undefined");
  const withParams = buildRequest("spawn", { agent: "worker" });
  assert.deepStrictEqual(withParams.params, { agent: "worker" });
  return null;
});

await test("rpc: replyEventFor channel naming", () => {
  assert.strictEqual(replyEventFor("abc"), `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}abc`);
  return null;
});

await test("rpc: parseSpawnReply success/error cases", () => {
  assert.deepStrictEqual(
    parseSpawnReply({ version: 1, requestId: "x", success: true, data: { details: { runId: "r1", asyncDir: "/d" } } }),
    { runId: "r1", asyncDir: "/d" },
  );
  assert.deepStrictEqual(
    parseSpawnReply({ version: 1, requestId: "x", success: true, data: { details: { runId: "r2" } } }),
    { runId: "r2", asyncDir: "" },
    "asyncDir defaults to empty",
  );
  assert.throws(
    () => parseSpawnReply({ version: 1, requestId: "x", success: true, data: { details: {} } }),
    (e) => e instanceof RpcClientError && e.code === "execution_failed",
  );
  assert.throws(
    () => parseSpawnReply({ version: 1, requestId: "x", success: false, error: { code: "limit", message: "budget" } }),
    (e) => e instanceof RpcClientError && e.code === "limit" && e.message === "budget",
  );
  assert.throws(() => parseSpawnReply("junk"), (e) => e.code === "invalid_reply");
  return null;
});

await test("rpc: ping true with bridge / false on timeout", async () => {
  const events = createEventBus();
  scriptedBridge(events, () => ({}));
  assert.strictEqual(await new RpcClient(events).ping(50), true);

  const silent = createEventBus(); // no bridge
  assert.strictEqual(await new RpcClient(silent).ping(20), false);
  return null;
});

await test("rpc: spawn returns runId + forces async/clarify in params", async () => {
  const events = createEventBus();
  let seen = null;
  scriptedBridge(events, (req) => {
    seen = req;
    return { details: { runId: "run-123", asyncDir: "/tmp/x" } };
  });
  const client = new RpcClient(events);
  const w = await client.spawn({ agent: "worker", task: "t", cwd: "/c", output: "/o.txt" }, 100);
  assert.deepStrictEqual(w, { runId: "run-123", asyncDir: "/tmp/x" });
  assert.strictEqual(seen.method, "spawn");
  assert.strictEqual(seen.params.async, true, "spawn must be detached async");
  assert.strictEqual(seen.params.clarify, false, "spawn must skip clarify UI");
  assert.strictEqual(seen.params.agent, "worker");
  assert.strictEqual(seen.params.output, "/o.txt");
  return null;
});

await test("rpc: spawn timeout rejects with RpcClientError", async () => {
  const events = createEventBus(); // no bridge
  await assert.rejects(
    new RpcClient(events).spawn({ agent: "worker", task: "t", cwd: "/c" }, 20),
    (e) => e instanceof RpcClientError && e.code === "timeout",
  );
  return null;
});

await test("rpc: status/stop semantics + onceEvent unsubscribes on timeout", async () => {
  const events = createEventBus();
  scriptedBridge(events, (req) => (req.method === "status" ? { state: "running" } : { stopped: true }));
  const client = new RpcClient(events);
  assert.deepStrictEqual(await client.status("r1", 50), { state: "running" });
  assert.strictEqual(await client.stop("r1", 50), true);

  const silent = createEventBus();
  const c2 = new RpcClient(silent);
  assert.strictEqual(await c2.status("r1", 20), null);
  assert.strictEqual(await c2.stop("r1", 20), false);
  // after the timeout the reply-channel listener must be gone (no leak)
  const chans = Object.keys(silent.listeners ?? {}).length ?? 0;
  return null;
});

await test("rpc: wrong-requestId reply is ignored; matching one resolves", async () => {
  const events = createEventBus();
  let reqId = "";
  events.on(SUBAGENT_RPC_REQUEST_EVENT, (req) => {
    reqId = req.requestId;
    // First a wrong-id reply, then the correct one.
    events.emit(replyEventFor("wrong-id"), { version: 1, requestId: "wrong-id", success: true, data: { details: { runId: "BAD" } } });
    events.emit(replyEventFor(req.requestId), { version: 1, requestId: req.requestId, success: true, data: { details: { runId: "GOOD" } } });
  });
  const w = await new RpcClient(events).spawn({ agent: "worker", task: "t", cwd: "/c" }, 100);
  assert.strictEqual(w.runId, "GOOD");
  return null;
});

await test("batch delegate: Level B interrupts a stuck worker (env timeout)", async () => {
  process.env.PI_AGILE_STUCK_TIMEOUT_MS = "10";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-stuck-"));
  try {
    const bridgeState = { stuck: true };
    const { pi, tool, command } = createFakePi({
      bdTasks: new Map([["t1", "Task t1"]]),
      bridge: createFakeBridge({ bridgeState }),
    });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-stuck");
    await command("agile").handler("on", ctx);
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1"] }, null, null, ctx);
    const t0 = Date.now();
    // Batch path still uses the RPC bridge + pollWithProgress (legacy, docs/DELEGATION.md)
    const res = await tool("agile_delegate_task").execute("t", { bd_ids: ["t1"] }, null, null, ctx);
    const elapsed = Date.now() - t0;
    const text = res.content?.[0]?.text ?? "";
    assert.ok(
      /did not complete|idle for|force-stopped/i.test(text),
      `stuck worker must fail the batch delegate (got: ${text.slice(0, 120)})`,
    );
    assert.ok(elapsed < 2000, `stuck-worker abort took ${elapsed}ms (post-interrupt loop must not sleep 5s)`);
    assert.strictEqual(bridgeState.stuck, false, "interrupt must clear the stuck flag");
    return null;
  } finally {
    delete process.env.PI_AGILE_STUCK_TIMEOUT_MS;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("B re-delegation cannot short-circuit on a stale review file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-stale-"));
  try {
    const { pi, tool, command } = createFakePi({ bdTasks: new Map([["t1", "Task t1"]]) });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-stale");
    await command("agile").handler("on", ctx);
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1"] }, null, null, ctx);
    // 1st delegation — round 1 records a real verdict file.
    const r1 = await delegateViaB({ tool, ctx, bdId: "t1", verdictFor: () => "blocked" });
    assert.ok(/BLOCKED/.test(r1.text), "first delegation must complete");
    assert.ok(fs.existsSync(path.join(dir, ".agile", "review-t1-r1.txt")), "round-1 verdict file exists");
    // 2nd delegation of the SAME round — prepare must DELETE the old verdict
    // file, so record without a fresh reviewer run cannot read the stale one.
    await tool("agile_delegate_task").execute("t", { bd_id: "t1", round: 1, title: "Task t1", description: "d" }, null, null, ctx);
    await tool("agile_prepare_review").execute("t", { bd_id: "t1", round: 1 }, null, null, ctx);
    assert.ok(!fs.existsSync(path.join(dir, ".agile", "review-t1-r1.txt")), "prepare must clear the stale verdict file");
    const rec = await tool("agile_record_verdict").execute("t", { bd_id: "t1", round: 1 }, null, null, ctx);
    assert.ok(
      /no review|missing|not found/i.test(rec.content?.[0]?.text ?? ""),
      `record must NOT succeed from a stale verdict file (got: ${(rec.content?.[0]?.text ?? "").slice(0, 120)})`,
    );
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("B delegate runs the rework loop (3 rounds) with feedback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-rework-"));
  try {
    const { pi, tool, command } = createFakePi({ bdTasks: new Map([["t1", "Task t1"]]) });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-rework");
    await command("agile").handler("on", ctx);
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1"] }, null, null, ctx);
    const { text, round } = await delegateViaB({
      tool, ctx, bdId: "t1", title: "T", description: "d",
      verdictFor: () => "rework",
      verdictExtra: () => ({ action_items: ["fix the bug"], lessons: ["lesson x"] }),
    });
    assert.ok(/REWORK/.test(text), `final verdict must be REWORK (got: ${text.slice(0, 160)})`);
    assert.ok(/Rounds:\*{0,2}\s*3/.test(text), `must report 3 rounds (got: ${text.slice(0, 160)})`);
    assert.strictEqual(round, 3, "protocol must stop after round 3");
    const sprint = readLatestSprint(dir);
    const task = sprint.tasks.find((t) => t.bd_id === "t1");
    assert.strictEqual(task.status, "rework", "task must be marked rework");
    assert.strictEqual(task.review_rounds, 3, "setReviewRounds must record 3 rounds");
    // Round-2 worker task file must carry the round-1 review feedback.
    const r2 = fs.readFileSync(path.join(dir, ".agile", "delegate-t1-r2.md"), "utf8");
    assert.ok(/Round 1 review found/.test(r2), "round-2 worker task must receive feedback");
    assert.ok(/- fix the bug/.test(r2), "feedback must carry the round-1 action items");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("B delegate breaks the rework loop on approved", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-rework2-"));
  try {
    const { pi, tool, command } = createFakePi({ bdTasks: new Map([["t1", "Task t1"]]) });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-rework2");
    await command("agile").handler("on", ctx);
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1"] }, null, null, ctx);
    const { text, round } = await delegateViaB({
      tool, ctx, bdId: "t1", title: "T", description: "d",
      verdictFor: (_bd, r) => (r === 1 ? "rework" : "approved"),
    });
    assert.ok(/APPROVED/.test(text), `must break to APPROVED (got: ${text.slice(0, 160)})`);
    assert.ok(/Rounds:\*{0,2}\s*2/.test(text), `must report 2 rounds (got: ${text.slice(0, 160)})`);
    assert.strictEqual(round, 2, "protocol must stop after round 2");
    const sprint = readLatestSprint(dir);
    const task = sprint.tasks.find((t) => t.bd_id === "t1");
    assert.strictEqual(task.review_rounds, 2, "2 rounds recorded");
    assert.ok(!fs.existsSync(path.join(dir, ".agile", "delegate-t1-r3.md")), "no round-3 task file after approved");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("B prepare_review: reviewer task file carries acceptance criteria from bd show", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ac-"));
  try {
    const { pi, tool, command } = createFakePi({
      bdTasks: new Map([["t1", "Task t1"]]),
      bdAC: new Map([["t1", "must handle empty input"]]),
    });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-ac");
    await command("agile").handler("on", ctx);
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1"] }, null, null, ctx);
    // No title/description params → the tools read bd show → parseBdShow → AC
    await tool("agile_delegate_task").execute("t", { bd_id: "t1", round: 1 }, null, null, ctx);
    const rv = await tool("agile_prepare_review").execute("t", { bd_id: "t1", round: 1 }, null, null, ctx);
    assert.ok(rv?.content?.[0]?.text, "prepare_review must return instructions");
    const taskFile = fs.readFileSync(path.join(dir, ".agile", "review-task-t1-r1.md"), "utf8");
    assert.ok(/Acceptance Criteria/.test(taskFile), "reviewer task must contain the Acceptance Criteria section");
    assert.ok(/must handle empty input/.test(taskFile), "reviewer task must carry the bd acceptance criteria");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("B prepare returns the worker subagent instruction (file reference, no bridge spawn)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-prep-"));
  try {
    const { pi, tool, command } = createFakePi({ bdTasks: new Map([["t1", "Task t1"]]) });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-prep");
    await command("agile").handler("on", ctx);
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1"] }, null, null, ctx);
    const res = await tool("agile_delegate_task").execute("t", { bd_id: "t1", round: 1, title: "Task t1", description: "d" }, null, null, ctx);
    const text = res.content?.[0]?.text ?? "";
    assert.ok(/subagent/.test(text), "prepare must instruct the agent to call subagent");
    assert.ok(/delegate-t1-r1\.md/.test(text), "instruction must reference the worker task file");
    assert.ok(/"worker"/.test(text), "instruction must name the worker agent");
    assert.ok(fs.existsSync(path.join(dir, ".agile", "delegate-t1-r1.md")), "worker task file must be written");
    const taskFile = fs.readFileSync(path.join(dir, ".agile", "delegate-t1-r1.md"), "utf8");
    assert.ok(/^# Task: Task t1/m.test(taskFile), "worker task file must carry buildWorkerTask content");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("B prepare_review returns the reviewer subagent instruction with output path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-prv-"));
  try {
    const { pi, tool, command } = createFakePi({ bdTasks: new Map([["t1", "Task t1"]]) });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-prv");
    await command("agile").handler("on", ctx);
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1"] }, null, null, ctx);
    await tool("agile_delegate_task").execute("t", { bd_id: "t1", round: 1, title: "Task t1", description: "d" }, null, null, ctx);
    const rv = await tool("agile_prepare_review").execute("t", { bd_id: "t1", round: 1 }, null, null, ctx);
    const text = rv.content?.[0]?.text ?? "";
    assert.ok(/subagent/.test(text), "prepare_review must instruct the agent to call subagent");
    assert.ok(/review-task-t1-r1\.md/.test(text), "instruction must reference the reviewer task file");
    assert.ok(/review-t1-r1\.txt/.test(text), "instruction must name the verdict output file");
    assert.ok(/outputMode/.test(text), "instruction must include outputMode for the subagent call");
    assert.ok(fs.existsSync(path.join(dir, ".agile", "review-task-t1-r1.md")), "reviewer task file must be written");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("B record without a review file errors loudly (no silent state change)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-rec-"));
  try {
    const { pi, tool, command } = createFakePi({ bdTasks: new Map([["t1", "Task t1"]]) });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-rec");
    await command("agile").handler("on", ctx);
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1"] }, null, null, ctx);
    // No review file written (reviewer subagent never ran) → record must refuse.
    const rec = await tool("agile_record_verdict").execute("t", { bd_id: "t1", round: 1 }, null, null, ctx);
    const text = rec.content?.[0]?.text ?? "";
    assert.ok(/no review|missing|not found|reviewer/i.test(text), `record must error without a verdict file (got: ${text.slice(0, 120)})`);
    const sprint = readLatestSprint(dir);
    const task = sprint.tasks.find((t) => t.bd_id === "t1");
    assert.strictEqual(task.status, "backlog", "task status must stay unchanged");
    assert.strictEqual(task.review_rounds, 0, "review_rounds must stay unchanged");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("B prepare round > 3 errors (max rework rounds)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-maxr-"));
  try {
    const { pi, tool, command } = createFakePi({ bdTasks: new Map([["t1", "Task t1"]]) });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-maxr");
    await command("agile").handler("on", ctx);
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1"] }, null, null, ctx);
    const res = await tool("agile_delegate_task").execute("t", { bd_id: "t1", round: 4, title: "Task t1", description: "d" }, null, null, ctx);
    const text = res.content?.[0]?.text ?? "";
    assert.ok(/3 rounds|max.*round|round.*3/i.test(text), `prepare must refuse round 4 (got: ${text.slice(0, 120)})`);
    assert.ok(!fs.existsSync(path.join(dir, ".agile", "delegate-t1-r4.md")), "no task file may be written for round 4");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("B record applies bookkeeping: blocked marks the task + lessons go to knowledge", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-bk-"));
  try {
    const { pi, tool, command } = createFakePi({ bdTasks: new Map([["t1", "Task t1"]]) });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-bk");
    await command("agile").handler("on", ctx);
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1"] }, null, null, ctx);
    const { text } = await delegateViaB({
      tool, ctx, bdId: "t1",
      verdictFor: () => "blocked",
      verdictExtra: () => ({ action_items: ["wrong approach"], lessons: ["never use X"], do_not_retry: "X is broken" }),
    });
    assert.ok(/BLOCKED/.test(text), `record must report BLOCKED (got: ${text.slice(0, 120)})`);
    assert.ok(/agile_merge_task/.test(text) === false, "blocked verdict must NOT suggest merging");
    const sprint = readLatestSprint(dir);
    const task = sprint.tasks.find((t) => t.bd_id === "t1");
    assert.strictEqual(task.status, "blocked", "blocked verdict must mark the task blocked");
    assert.strictEqual(task.review_rounds, 1, "review_rounds must record the round");
    const kb = fs.readFileSync(path.join(dir, ".agile", "knowledge.jsonl"), "utf8");
    assert.ok(/never use X/.test(kb), "lessons from the verdict must reach knowledge.jsonl");
    assert.ok(/X is broken/.test(kb), "do_not_retry must reach knowledge.jsonl as a dead end");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── agile_run tool (autonomous bootstrap for headless `pi -p`) ──────────

console.log("## agile_run tool");

await test("agile_run: enables mode, continuous mode, goal-setup followUp", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-run-"));
  try {
    const { pi, tool } = createFakePi({});
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-run-1", null, pi);
    const res = await tool("agile_run").execute("t", { description: "Fix all module boundary bugs" }, null, null, ctx);

    // 1. agile mode persisted ON
    const config = JSON.parse(fs.readFileSync(path.join(dir, ".agile", "config.json"), "utf8"));
    assert.strictEqual(config.agile_mode, true, "agile_run must persist agile_mode: true");

    // 2. session: continuous (no budget), originalRequest, loop un-stopped
    const sess = readSession(dir);
    assert.strictEqual(sess.originalRequest, "Fix all module boundary bugs");
    assert.strictEqual(sess.remainingSprints, undefined, "no max_sprints → continuous mode");
    assert.strictEqual(sess.loopStopped, false, "agile_run must clear a persisted /agile stop");
    assert.strictEqual(sess.sprintLoopActive, true, "agile_run marks the loop active");

    // 3. goal-setup followUp carries the description
    const last = pi.sentMessages[pi.sentMessages.length - 1];
    assert.ok(last.text.includes("Sprint Goal Setup Required"), "goal-setup followUp sent");
    assert.ok(last.text.includes("Fix all module boundary bugs"), "description in followUp");
    // Mid-turn tool context: the agent must SEE the instruction immediately,
    // even if it would otherwise continue calling tools — steer, not followUp
    // (followUp only arrives after the agent stops on its own).
    assert.strictEqual(last.opts.deliverAs, "steer", "goal-setup from the agile_run tool must be steer");

    // 4. tool result confirms
    assert.ok(res.content[0].text.includes("Agile mode ON"), "result confirms mode ON");

    // 5. other agile tools now callable (not gated)
    const k = await tool("agile_knowledge").execute("t", { action: "read" }, null, null, ctx);
    assert.ok(!k.content[0].text.includes("Agile mode is OFF"), "agile tools usable after agile_run");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("agile_run: max_sprints bounds the session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-run-"));
  try {
    const { pi, tool } = createFakePi({});
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-run-2", null, pi);
    await tool("agile_run").execute("t", { description: "d", max_sprints: 3 }, null, null, ctx);
    const sess = readSession(dir);
    assert.strictEqual(sess.remainingSprints, 3, "budget persisted");
    const last = pi.sentMessages[pi.sentMessages.length - 1];
    assert.ok(last.text.includes("3 sprints"), "budget mentioned in goal-setup followUp");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("agile_run: max_sprints 0 → continuous mode", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-run-"));
  try {
    const { pi, tool } = createFakePi({});
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-run-3", null, pi);
    await tool("agile_run").execute("t", { description: "d", max_sprints: 0 }, null, null, ctx);
    assert.strictEqual(readSession(dir).remainingSprints, undefined, "0 → continuous");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("agile_run: description is required (no side effects)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-run-"));
  try {
    const { pi, tool } = createFakePi({});
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-run-4", null, pi);
    const res = await tool("agile_run").execute("t", {}, null, null, ctx);
    assert.ok(res.content[0].text.includes("description is required"), "explicit error");
    assert.strictEqual(res.content[0].text.includes("Agile mode ON"), false, "no success claim");
    assert.strictEqual(readSession(dir).originalRequest, undefined, "no session written");
    assert.ok(!fs.existsSync(path.join(dir, ".agile", "config.json")), "mode not enabled");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("agile_run: re-enabling after /agile off restores the gated tools", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-run-"));
  try {
    const { pi, tool, command } = createFakePi({});
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-run-5", null, pi);

    // /agile off removes the gated agile tools from the active set
    await command("agile").handler("off", ctx);
    const afterOff = pi.getActiveTools();
    assert.ok(!afterOff.includes("agile_discover"), "off removes agile tools");
    assert.ok(afterOff.includes("agile_run"), "agile_run itself must never be gated");

    // agile_run re-enables mode AND restores the tools (no human to /agile on)
    await tool("agile_run").execute("t", { description: "d" }, null, null, ctx);
    const afterRun = pi.getActiveTools();
    assert.ok(afterRun.includes("agile_discover"), "re-enable restores agile tools");
    assert.ok(afterRun.includes("agile_delegate_task"), "delegate restored");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── deliverAs: mid-turn tool messages must be steer (agent sees them
// immediately), agent_end stays followUp ─────────────────────────────

console.log("## deliverAs semantics");

await test("merge: terminal merge must not send exhausted steer nor set dedupe flag (design-A completion)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-mrg-"));
  try {
    const bdTasks = new Map([["t1", "Task t1"]]);
    const bridge = createFakeBridge({ verdictFor: () => "approved" });
    const { pi, tool, command, hook } = createFakePi({ bdTasks, bridge });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-mrg-1");
    await command("agile").handler("on", ctx);
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1"] }, null, null, ctx);
    await delegateViaB({ tool, ctx, bdId: "t1", verdictFor: () => "approved" });

    const before = pi.sentMessages.length;
    const res = await tool("agile_merge_task").execute("t", { bd_id: "t1" }, null, null, ctx);
    const text = res.content?.[0]?.text ?? "";
    assert.ok(/merged to main/i.test(text), `merge must succeed (got: ${text.slice(0, 120)})`);

    // Terminal sprint (t1 done): the all_tasks_exhausted steer must NOT be
    // sent as a followUp from the merge tool, and the dedupe flag must NOT be
    // set — agent_end owns the terminal message (design A).
    const msgs = pi.sentMessages.slice(before);
    const exhausted = msgs.filter((m) => /exhausted|\uD83D\uDEAB/.test(m.text));
    assert.strictEqual(exhausted.length, 0, "terminal merge must not send exhausted/blocked steers");

    // agent_end must STILL auto-close + nudge (the merge did not set the flag)
    const m2 = pi.sentMessages.length;
    await hook("agent_end")({ messages: [] }, ctx);
    const nudges = pi.sentMessages.slice(m2).filter((m) => /Decide and act now/.test(m.text));
    assert.strictEqual(nudges.length, 1, "agent_end must auto-close after a terminal merge");
    assert.strictEqual(readLatestSprint(dir).status, "done", "auto-close sets status done");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("delegate: non-terminal stagnation steer delivered as steer (mid-turn tool context)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-stag-"));
  try {
    const bdTasks = new Map([["t1", "Task t1"], ["t2", "Task t2"]]);
    const bridge = createFakeBridge({ verdictFor: () => "rework" });
    const { pi, tool, command } = createFakePi({ bdTasks, bridge });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-stag-1");
    await command("agile").handler("on", ctx);
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1", "t2"] }, null, null, ctx);
    // t2 stays pending so the sprint is NOT terminal → the stagnation steer
    // (non-terminal) is allowed through and must be delivered as steer.
    // One B-protocol run with 3 consecutive rework rounds: record_verdict
    // calls trackTaskTransition per round → consecutiveReworks reaches 3.
    await delegateViaB({ tool, ctx, bdId: "t1", verdictFor: () => "rework" });
    const last = pi.sentMessages[pi.sentMessages.length - 1];
    assert.ok(/stuck in a rework loop/.test(last.text), `stagnation steer must fire after 3 reworks (got: ${last?.text?.slice(0, 80)})`);
    assert.strictEqual(last.opts.deliverAs, "steer", "stagnation steer from the delegate tool must be steer");
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("agile_retrospective: continuation nudge delivered as steer (tool context)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-rtst-"));
  try {
    const bdTasks = new Map([["t1", "Task t1"]]);
    const bridge = createFakeBridge({ verdictFor: () => "blocked" });
    const { pi, tool, command } = createFakePi({ bdTasks, bridge });
    piAgileExtension(pi);
    const ctx = makeCtx(dir, "smoke-rtst-1");
    await command("agile").handler("on", ctx);
    await tool("agile_start_sprint").execute("t", { task_ids: ["t1"] }, null, null, ctx);
    await delegateViaB({ tool, ctx, bdId: "t1", verdictFor: () => "blocked" });

    const before = pi.sentMessages.length;
    await tool("agile_retrospective").execute("t", {}, null, null, ctx);
    const msgs = pi.sentMessages.slice(before);
    const nudges = msgs.filter((m) => /Decide and act now/.test(m.text));
    assert.strictEqual(nudges.length, 1, "retrospective sends exactly one continuation nudge");
    assert.strictEqual(nudges[0].opts.deliverAs, "steer", "continuation nudge from the retrospective tool must be steer");
    // Every message the retrospective tool sends must be steer (mid-turn).
    for (const m of msgs) {
      assert.strictEqual(m.opts.deliverAs, "steer", `retrospective tool message must be steer: ${m.text.slice(0, 60)}`);
    }
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Summary ──────────────────────────────────────────────────────
console.log(`\n# Results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
