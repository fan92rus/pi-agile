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

// ── YAML parser ──────────────────────────────────────────────
console.log("\n## YAML parser");

function parseSimpleYaml(text) {
  const result = {};
  const lines = text.split('\n');
  const stack = [{ indent: -1, obj: result }];
  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i].replace(/\r$/, '');
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) { i++; continue; }
    const indent = rawLine.length - rawLine.trimStart().length;
    const content = rawLine.trim();
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) { stack.pop(); }
    const current = stack[stack.length - 1].obj;
    if (content.startsWith('- ')) {
      const value = content.slice(2).trim();
      const topObj = stack[stack.length - 1].obj;
      const topKeys = Object.keys(topObj);
      if (stack.length > 1 && topKeys.length === 0) {
        const parent = stack[stack.length - 2].obj;
        const parentKeys = Object.keys(parent);
        for (let k = parentKeys.length - 1; k >= 0; k--) {
          if (parent[parentKeys[k]] === topObj) {
            parent[parentKeys[k]] = [parseYamlValue(value)];
            stack.pop();
            break;
          }
        }
      } else {
        for (let k = topKeys.length - 1; k >= 0; k--) {
          if (Array.isArray(topObj[topKeys[k]])) {
            topObj[topKeys[k]].push(parseYamlValue(value));
            break;
          }
        }
      }
      i++;
    } else if (content.includes(':')) {
      const colonIdx = content.indexOf(':');
      const key = content.slice(0, colonIdx).trim();
      const valueStr = content.slice(colonIdx + 1).trim();
      if (valueStr === '') {
        current[key] = {};
        stack.push({ indent, obj: current[key] });
        i++;
      } else if (valueStr === '>' || valueStr === '|') {
        const blockLines = [];
        const blockIndent = indent + 2;
        i++;
        while (i < lines.length) {
          const nextLine = lines[i].replace(/\r$/, '');
          if (nextLine.trim() === '' && i + 1 < lines.length) { blockLines.push(''); i++; continue; }
          const nextIndent = nextLine.length - nextLine.trimStart().length;
          if (nextIndent > indent) {
            blockLines.push(nextLine.slice(Math.min(blockIndent, nextIndent)).trimEnd());
            i++;
          } else { break; }
        }
        current[key] = valueStr === '>' ? blockLines.join(' ').trim() : blockLines.join('\n');
      } else {
        current[key] = parseYamlValue(valueStr);
        i++;
      }
    } else { i++; }
  }
  return result;
}
function parseYamlValue(s) {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  if (t === 'true') return true; if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  return t;
}

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

// ── index.ts: agent_end continuation intent ──────────────────────────
console.log("\n## index.ts: agent_end continuation intent");

// Logic under test: agent_end followUp always shows the project goal and
// appends the original request when one was given. Re-implement the logic.
function buildContextLines(originalRequest, goal) {
  const lines = [`Project goal: ${goal}`];
  if (originalRequest.trim()) {
    lines.push(`Original user request: ${originalRequest}`);
  }
  return lines;
}

await test("agent_end context: shows goal and original request", () => {
  const lines = buildContextLines("Improve performance of the parser", "Improve code quality");
  const joined = lines.join("\n");
  assert.ok(joined.includes("Project goal: Improve code quality"));
  assert.ok(joined.includes("Original user request: Improve performance"));
  assert.strictEqual(lines.length, 2);
});

await test("agent_end context: goal only when no original request", () => {
  const lines = buildContextLines("", "Improve code quality and fix issues");
  const joined = lines.join("\n");
  assert.ok(joined.includes("Project goal: Improve code quality"));
  assert.strictEqual(lines.length, 1);
});

// agent_end guard conditions: sprints never become "active" (only planning/done),
// so the guard must be against "done", and the anti-spam flag must gate repeats.
function agentEndShouldFire(sprintStatus, tasks, sentForSprint, sprintId) {
  if (sprintStatus === "done") return false;
  const pending = tasks.filter((t) => t.status !== "done" && t.status !== "blocked");
  if (pending.length > 0) return false;
  if (tasks.length === 0) return false;
  if (sentForSprint === sprintId) return false; // already nudged for this sprint
  return true;
}

await test("agent_end fires for planning sprint with all terminal tasks", () => {
  const tasks = [
    { status: "done" },
    { status: "blocked" },
    { status: "done" },
  ];
  assert.ok(agentEndShouldFire("planning", tasks, null, 1));
});

await test("agent_end does NOT fire for completed sprint (status done)", () => {
  const tasks = [{ status: "done" }];
  assert.ok(!agentEndShouldFire("done", tasks, null, 1));
});

await test("agent_end does NOT fire when pending tasks remain", () => {
  const tasks = [{ status: "done" }, { status: "in_progress" }];
  assert.ok(!agentEndShouldFire("planning", tasks, null, 1));
});

await test("agent_end does NOT fire twice for the same sprint (anti-spam)", () => {
  const tasks = [{ status: "done" }];
  assert.ok(agentEndShouldFire("planning", tasks, null, 1));
  assert.ok(!agentEndShouldFire("planning", tasks, 1, 1));
});

await test("agent_end fires again for a NEW sprint id", () => {
  const tasks = [{ status: "done" }];
  assert.ok(!agentEndShouldFire("planning", tasks, 1, 1)); // old sprint — no
  assert.ok(agentEndShouldFire("planning", tasks, 1, 2)); // new sprint — yes
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

// ── Summary ──────────────────────────────────────────────────────
console.log(`\n# Results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
