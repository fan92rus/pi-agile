/**
 * PBT (Property-Based Testing) — state-machine model of the pi-agile system.
 * Run with: node --experimental-strip-types tests/pbt.test.mjs
 *
 * The model drives the REAL modules (SprintStore, continuation gates, observer,
 * session persistence, yaml/bd parsers) through deterministic random action
 * sequences that mirror what index.ts does: startSprint → delegate verdicts →
 * retrospective → agent_end → /agile run|stop → restart → corruption.
 * After EVERY action a battery of invariants must hold; any violation is a
 * real bug (with a shrunk minimal repro).
 *
 * No external deps: seeded PRNG (mulberry32) + prefix-shrinking.
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const EXT_DIR = path.join(import.meta.dirname, "..", "extensions", "pi-agile");
const importMod = (rel) => import(pathToFileURL(path.join(EXT_DIR, rel)).href);

const { SprintStore } = await importMod("parallel/sprint.ts");
const { shouldSendContinuation, buildContinuationMessage, saveSessionState, loadSessionState } =
  await importMod("parallel/continuation.ts");
const { createObserverState, runSprintObserver, trackTaskTransition, DEFAULT_OBSERVER_CONFIG } =
  await importMod("observer.ts");
const { parseSimpleYaml } = await importMod("parallel/yaml.ts");
const { parseBdShow } = await importMod("parallel/bd.ts");

// ──────────────────────────────────────────────────────────────────────
// Tiny PBT harness: seeded PRNG + generators + forAll with prefix shrink
// ──────────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const genInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
const genPick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

let pbtPass = 0;
let pbtFail = 0;
const pbtFailures = [];

/** Run `run(rng, seed, maxActions)` for `seeds` seeds; shrink failures to a minimal prefix. */
async function forAll({ seeds = 60, maxActions = 120, name, run }) {
  for (let seed = 0; seed < seeds; seed++) {
    try {
      run(mulberry32(seed), seed, maxActions);
      pbtPass++;
    } catch (e) {
      pbtFail++;
      const repro = shrinkPrefix(run, seed, maxActions);
      const log = repro?.log?.length ? `\n       actions: ${repro.log.join(" → ")}` : "";
      pbtFailures.push({ name, seed, message: e.message, log: repro?.log ?? null });
      console.error(`  ❌ ${name} [seed=${seed}]${log}\n     ${e.message}`);
    }
  }
}

/** Find the shortest action prefix (by maxActions) that still fails. */
function shrinkPrefix(run, seed, maxActions) {
  let lo = 1;
  let hi = maxActions;
  let best = null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      run(mulberry32(seed), seed, mid);
      lo = mid + 1;
    } catch (e) {
      best = { log: e.log ?? null };
      hi = mid;
    }
  }
  return best;
}

// ──────────────────────────────────────────────────────────────────────
// State machine model — mirrors index.ts orchestration, real modules underneath
// ──────────────────────────────────────────────────────────────────────

const CONTINUATION_TYPES = new Set([
  "sprint_completed", "all_tasks_exhausted", "continuation", "remaining", "all_completed",
]);
const TERMINAL = new Set(["done", "blocked"]);
const ALLOWED_STATUSES = new Set(["backlog", "in_progress", "in_review", "done", "rework", "blocked"]);

class SprintSystem {
  constructor(dir, rng) {
    this.dir = dir;
    this.rng = rng;
    this.store = new SprintStore();
    this.obs = createObserverState();
    this.runtime = { remainingSprints: undefined, loopStopped: false, sprintLoopActive: false, agentEndSentForSprint: null };
    this.boundedInitial = undefined;
    this.nudges = 0;
    this.retrospectives = 0;
    this.log = [];
    this.nextBdId = 1;
    this.continuationPerAction = 0; // continuation-type messages during current action
    this.lastAction = null;
  }

  // ---- helpers -------------------------------------------------------

  currentSprint() {
    return this.store.getCurrent(this.dir); // mirrors agent_end/retrospective getCurrent(workDir)
  }

  sendContinuationMessage(sprint, kind) {
    if (CONTINUATION_TYPES.has(kind)) this.continuationPerAction++;
    if (kind === "continuation") {
      this.nudges++;
      this.runtime.agentEndSentForSprint = sprint.id; // maybeSendContinuation: optimistic flag
    }
  }

  record(kind) {
    this.log.push(kind);
    this.lastAction = kind;
  }

  // ---- actions (each mirrors an index.ts path) -----------------------

  startSprint() {
    // mirrors agile_start_sprint: create + addTask (titles verified) + save + reset flag
    const id = this.store.findLastSprintId(this.dir) + 1;
    const nTasks = genInt(this.rng, 0, 4);
    const sprint = this.store.create(this.dir, id, "goal g");
    for (let i = 0; i < nTasks; i++) {
      const bdId = `t${this.nextBdId++}`;
      this.store.addTask(sprint, { bd_id: bdId, title: `Task ${bdId}`, description: `desc ${bdId}`, status: "backlog" });
    }
    this.store.save(this.dir, sprint);
    this.runtime.agentEndSentForSprint = null; // mirrors agile_start_sprint reset
    this.record(`startSprint#${id}(${nTasks})`);
  }

  delegate() {
    // mirrors verdict application in agile_delegate_task / executeBatchTasks
    const sprint = this.currentSprint();
    if (!sprint) return;
    const pend = sprint.tasks.filter((t) => t.status === "backlog" || t.status === "rework");
    if (pend.length === 0) return;
    const t = genPick(this.rng, pend);
    const rounds = 1 + (this.rng() < 0.3 ? 1 : 0);
    this.store.setReviewRounds(sprint, t.bd_id, rounds);
    const verdict = this.rng() < 0.55 ? "approved" : this.rng() < 0.75 ? "rework" : "blocked";
    if (verdict === "approved") {
      this.store.markDone(sprint, t.bd_id);
      trackTaskTransition(this.obs, t.bd_id, "done");
    } else if (verdict === "rework") {
      this.store.markRework(sprint, t.bd_id);
      trackTaskTransition(this.obs, t.bd_id, "rework");
    } else {
      this.store.markBlocked(sprint, t.bd_id);
      trackTaskTransition(this.obs, t.bd_id, "blocked");
    }
    this.store.save(this.dir, sprint); // mirrors index.ts save after transitions
    this.record(`delegate(${t.bd_id}→${verdict},r${rounds})`);
  }

  retrospective() {
    // mirrors agile_retrospective (completeSprint + decrement + followUps + observer)
    const sprint = this.currentSprint();
    if (!sprint) return;
    // PBT find: retrospective twice on the same sprint must be a no-op for the
    // budget/messages (agent error) — otherwise the budget double-decrements
    // and the continuation nudge fires twice.
    const alreadyCompleted = sprint.status === "done";
    sprint.velocity = this.store.computeVelocity(sprint);
    this.store.completeSprint(sprint, this.dir);
    if (!alreadyCompleted) this.retrospectives++;
    this.continuationPerAction = 0;

    const obsSteers = runSprintObserver(
      sprint, this.obs,
      { reworkStuckThreshold: 3, constraintSpamThreshold: 3, velocityDropThreshold: 50, observerEnabled: true },
      this.dir,
    );
    // index.ts sends each observer steer as a followUp…
    const willSendOwn = !alreadyCompleted && (this.runtime.remainingSprints !== undefined || !this.runtime.loopStopped);
    for (const st of obsSteers) {
      // …but continuation-type steers duplicate the followUp we send below (Fix).
      if (willSendOwn && CONTINUATION_TYPES.has(st.type)) continue;
      this.sendContinuationMessage(sprint, st.type);
    }

    if (!alreadyCompleted) {
      if (this.runtime.remainingSprints !== undefined) {
        this.runtime.remainingSprints--;
        this.runtime.agentEndSentForSprint = sprint.id;
        if (this.runtime.remainingSprints <= 0) {
          this.runtime.sprintLoopActive = false;
          this.sendContinuationMessage(sprint, "all_completed");
        } else {
          this.sendContinuationMessage(sprint, "remaining");
        }
      } else if (!this.runtime.loopStopped) {
        this.sendContinuationMessage(sprint, "continuation");
      }
    }
    this.record(`retrospective#${sprint.id}${alreadyCompleted ? "(dup)" : ""}`);
  }

  agentEnd() {
    // mirrors the agent_end hook: gate + maybeSendContinuation
    const sprint = this.currentSprint();
    if (!sprint) return;
    this.continuationPerAction = 0;
    const pending = sprint.tasks.filter((t) => !TERMINAL.has(t.status));
    const should = shouldSendContinuation({
      pendingCount: pending.length,
      taskCount: sprint.tasks.length,
      sentForSprint: this.runtime.agentEndSentForSprint,
      sprintId: sprint.id,
      remainingSprints: this.runtime.remainingSprints,
      loopStopped: this.runtime.loopStopped,
    });
    if (should) {
      const msg = buildContinuationMessage({
        goal: "goal g",
        originalRequest: this.runtime.originalRequest ?? "",
        remainingSprints: this.runtime.remainingSprints,
        totalTasks: sprint.tasks.length,
        totalDone: sprint.tasks.filter((t) => t.status === "done").length,
        totalBlocked: sprint.tasks.filter((t) => t.status === "blocked").length,
        openTasks: [],
      });
      assert.ok(msg && msg.length > 10, "continuation message must be non-empty");
      this.sendContinuationMessage(sprint, "continuation");
    }
    this.record(`agentEnd#${sprint.id}`);
  }

  runBounded() {
    // mirrors /agile run N
    const n = genInt(this.rng, 1, 4);
    this.runtime.remainingSprints = n;
    this.runtime.loopStopped = false;
    this.runtime.sprintLoopActive = true;
    this.boundedInitial = n;
    this.record(`runBounded(${n})`);
  }

  runContinuous() {
    // mirrors /agile run <desc> (no count) / continuous mode
    this.runtime.remainingSprints = undefined;
    this.runtime.loopStopped = false;
    this.runtime.sprintLoopActive = true;
    this.record("runContinuous");
  }

  stop() {
    // mirrors /agile stop
    this.runtime.remainingSprints = undefined;
    this.runtime.sprintLoopActive = false;
    this.runtime.loopStopped = true;
    this.record("stop");
  }

  restart() {
    // mirrors a fresh pi session: new in-memory store, session state from disk
    this.store = new SprintStore();
    this.record("restart");
  }

  corruptSession() {
    // arbitrary garbage into .agile/session.json — must never throw on load
    const file = path.join(this.dir, ".agile", "session.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const garbage = genPick(this.rng, ["{not json", "[]", "null", "42", "\u0000\xff\xfe", JSON.stringify({ remainingSprints: "NaN", loopStopped: "yes" }), ""]);
    fs.writeFileSync(file, garbage, "utf8");
    this.record("corruptSession");
  }

  corruptSprintFile() {
    // garbage into the newest sprint file — getCurrent must degrade, not crash
    const id = this.store.findLastSprintId(this.dir);
    if (id <= 0) return;
    const file = path.join(this.dir, ".agile", `sprint-${id}.json`);
    fs.writeFileSync(file, "{torn write", "utf8");
    this.record(`corruptSprint#${id}`);
  }
}

const WEIGHTS = [
  ["startSprint", 6], ["delegate", 12], ["retrospective", 4], ["agentEnd", 9],
  ["runBounded", 2], ["runContinuous", 2], ["stop", 2], ["restart", 2],
  ["corruptSession", 1], ["corruptSprintFile", 2],
];

function pickAction(rng) {
  const total = WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let roll = rng() * total;
  for (const [name, w] of WEIGHTS) {
    roll -= w;
    if (roll <= 0) return name;
  }
  return "agentEnd";
}

// ──────────────────────────────────────────────────────────────────────
// Invariants (checked after EVERY action in EVERY scenario)
// ──────────────────────────────────────────────────────────────────────

function checkInvariants(sys) {
  const sprint = sys.currentSprint();

  // P1 persist-echo: disk state === in-memory state (the 97bf88d bug class:
  // a path that mutates the sprint without save()).
  if (sprint) {
    const file = path.join(sys.dir, ".agile", `sprint-${sprint.id}.json`);
    assert.ok(fs.existsSync(file), "P1: sprint file missing after mutation");
    let disk;
    try {
      disk = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // torn write from corruptSprintFile — skip echo (handled by P2 recovery)
      disk = null;
    }
    if (disk) {
      assert.deepStrictEqual(disk, JSON.parse(JSON.stringify(sprint)), "P1: disk state != in-memory state");
    }
  }

  // P2 status legality
  for (const t of sprint?.tasks ?? []) {
    assert.ok(ALLOWED_STATUSES.has(t.status), `P2: illegal status ${t.status}`);
    assert.ok(typeof t.review_rounds === "number" && t.review_rounds >= 0, "P2: review_rounds negative/NaN");
    assert.ok(t.bd_id && t.title, "P2: task missing bd_id/title");
  }

  // P2c recovery (only after a restart — in-memory state is authoritative while
  // the same store lives on): getCurrent must return the latest PARSEABLE sprint;
  // a torn write on the newest sprint-N.json must not hide older valid sprints.
  if (sys.lastAction && sys.lastAction.startsWith("restart")) {
    const agileDir = path.join(sys.dir, ".agile");
    let latestValidId = 0;
    if (fs.existsSync(agileDir)) {
      // numeric sort desc — string sort would put "sprint-9" after "sprint-10"
      const files = fs.readdirSync(agileDir).filter((f) => /^sprint-(\d+)\.json$/.test(f));
      files.sort((a, b) => parseInt(b.replace("sprint-", ""), 10) - parseInt(a.replace("sprint-", ""), 10));
      for (const f of files) {
        try {
          JSON.parse(fs.readFileSync(path.join(agileDir, f), "utf8"));
          latestValidId = parseInt(f.replace("sprint-", ""), 10);
          break;
        } catch { /* corrupt — try older */ }
      }
    }
    const cur = sys.currentSprint();
    if (latestValidId > 0) {
      assert.ok(cur && cur.id === latestValidId, `P2c: expected recovery to sprint ${latestValidId}, got ${cur ? cur.id : "null"}`);
    } else {
      assert.strictEqual(cur, null, "P2c: no valid sprint file but getCurrent returned one");
    }
  }

  // P4 anti-spam: continuation flag makes agent_end idempotent per sprint
  if (sprint && sys.runtime.agentEndSentForSprint === sprint.id) {
    const pending = sprint.tasks.filter((t) => !TERMINAL.has(t.status));
    const should = shouldSendContinuation({
      pendingCount: pending.length,
      taskCount: sprint.tasks.length,
      sentForSprint: sprint.id,
      sprintId: sprint.id,
      remainingSprints: sys.runtime.remainingSprints,
      loopStopped: sys.runtime.loopStopped,
    });
    assert.strictEqual(should, false, "P4: gate fires despite agentEndSentForSprint === sprintId");
  }

  // P5 stop silence: after /agile stop no continuation anywhere
  if (sys.runtime.loopStopped) {
    const s = sys.currentSprint();
    if (s) {
      const pending = s.tasks.filter((t) => !TERMINAL.has(t.status));
      assert.strictEqual(
        shouldSendContinuation({
          pendingCount: pending.length, taskCount: s.tasks.length,
          sentForSprint: null, sprintId: s.id,
          remainingSprints: undefined, loopStopped: true,
        }),
        false,
        "P5: gate fires after /agile stop",
      );
    }
  }

  // P7 budget: bounded loop never exceeds its initial sprint budget
  if (sys.boundedInitial !== undefined && sys.runtime.remainingSprints !== undefined) {
    assert.ok(
      sys.runtime.remainingSprints <= sys.boundedInitial,
      `P7: remainingSprints (${sys.runtime.remainingSprints}) grew above initial budget (${sys.boundedInitial})`,
    );
  }

  // P8 no double continuation message within a single action
  assert.ok(sys.continuationPerAction <= 1, `P8: ${sys.continuationPerAction} continuation messages in one action`);

  // P11 velocity sanity (current sprint — older sprints are frozen after
  // completeSprint; scanning all of them every action was the perf bottleneck)
  if (sprint?.velocity) {
    const v = sprint.velocity;
    assert.ok(v.done >= 0 && v.rework >= 0 && v.blocked >= 0, "P11: negative velocity");
    assert.ok(v.done + v.rework + v.blocked <= v.attempted, "P11: velocity sums exceed attempted");
    assert.ok(v.avg_review_rounds >= 0, "P11: negative avg review rounds");
  }
}

/** One full scenario: run `maxActions` random actions, checking invariants after each. */
function runScenario(rng, seed, maxActions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pbt-agile-${seed}-`));
  const sys = new SprintSystem(dir, rng);
  try {
    for (let step = 0; step < maxActions; step++) {
      sys.continuationPerAction = 0;
      const action = pickAction(rng);
      sys[action]();
      checkInvariants(sys);
    }
  } catch (e) {
    e.log = sys.log;
    throw e;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Pure properties (random inputs against real functions)
// ──────────────────────────────────────────────────────────────────────

function pureContinuationGate(rng, seed) {
  for (let i = 0; i < 500; i++) {
    const pendingCount = genInt(rng, 0, 3);
    const taskCount = genInt(rng, 0, 4);
    const sentForSprint = rng() < 0.5 ? null : genInt(rng, 1, 4);
    const sprintId = genInt(rng, 1, 4);
    const remainingSprints = rng() < 0.3 ? undefined : genInt(rng, 0, 5);
    const loopStopped = rng() < 0.2;
    const ok = shouldSendContinuation({ pendingCount, taskCount, sentForSprint, sprintId, remainingSprints, loopStopped });
    if (ok) {
      assert.ok(pendingCount === 0, "gate fires with pending tasks");
      assert.ok(taskCount > 0, "gate fires on empty sprint");
      assert.ok(sentForSprint !== sprintId, "gate fires for already-covered sprint");
      assert.ok(remainingSprints === undefined || remainingSprints > 0, "gate fires with no sprints left");
      assert.ok(!loopStopped, "gate fires after stop");
    }
  }
}

function pureSessionRoundTrip(rng, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pbt-sess-${seed}-`));
  try {
    for (let i = 0; i < 200; i++) {
      const state = {
        remainingSprints: rng() < 0.3 ? undefined : genInt(rng, 0, 5),
        originalRequest: rng() < 0.2 ? "" : `request ${genInt(rng, 0, 100)}`,
        sprintLoopActive: rng() < 0.5,
        loopStopped: rng() < 0.3,
      };
      saveSessionState(dir, state);
      const loaded = loadSessionState(dir);
      assert.strictEqual(loaded.remainingSprints ?? undefined, state.remainingSprints, "session round-trip: remainingSprints");
      assert.strictEqual(loaded.originalRequest, state.originalRequest, "session round-trip: originalRequest");
      assert.strictEqual(loaded.sprintLoopActive, state.sprintLoopActive, "session round-trip: sprintLoopActive");
      assert.strictEqual(loaded.loopStopped, state.loopStopped, "session round-trip: loopStopped");
    }
    // arbitrary garbage never throws and yields {}
    for (const garbage of ["{bad", "[]", "null", "42", "\"str\"", "\u0000\x01\x02", JSON.stringify({ remainingSprints: "x", loopStopped: 5 }), "{\"remainingSprints\": NaN}"]) {
      fs.writeFileSync(path.join(dir, ".agile", "session.json"), garbage, "utf8");
      const loaded = loadSessionState(dir);
      assert.ok(typeof loaded === "object", "corrupt session must return object");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pureYamlFuzz(rng, seed) {
  for (let i = 0; i < 300; i++) {
    const n = genInt(rng, 0, 4);
    const conds = [];
    for (let j = 0; j < n; j++) {
      conds.push(`      - metric: ${rng() < 0.5 ? "max_sprints" : "coverage"}\n        target: ${genInt(rng, 0, 100)}`);
    }
    const yaml = `project:\n  name: "p"\n  goal: >\n    improve\n  stop_when:\n    mode: ${rng() < 0.5 ? "any_of" : "all_of"}\n    conditions:\n${conds.join("\n")}\n  review_depth: ${rng() < 0.5 ? "deep" : "standard"}\n`;
    let parsed;
    assert.doesNotThrow(() => { parsed = parseSimpleYaml(yaml); }, "yaml fuzz crash");
    if (n > 0) {
      const conditions = parsed.project.stop_when.conditions;
      assert.ok(Array.isArray(conditions), "conditions must be array-of-maps");
      assert.strictEqual(conditions.length, n);
      for (const c of conditions) {
        assert.ok(typeof c === "object" && !Array.isArray(c), "condition item must be a map, not a string");
        assert.ok("metric" in c && "target" in c, "condition item must carry metric+target");
      }
    }
  }
}

function pureBdFuzz(rng, seed) {
  for (let i = 0; i < 300; i++) {
    const lines = genInt(rng, 1, 6);
    const body = Array.from({ length: lines }, (_, k) => {
      const words = genInt(rng, 1, 5);
      const text = Array.from({ length: words }, () => genPick(rng, ["Fix", "bug", "in", "parser", "This", "is", "second", "line", "API", "v2", "endpoints", "NO", "CHANGES", "done"])).join(" ");
      return text;
    }).join("\n");
    const out = `○ pbt-1 · Some task   [● P2 · OPEN]\n\nDESCRIPTION\n${body}\n\nACCEPTANCE CRITERIA\nNo regressions`;
    assert.doesNotThrow(() => parseBdShow(out), "bd fuzz crash");
  }
}

function pureObserverSequences(rng, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pbt-obs-${seed}-`));
  try {
    fs.mkdirSync(path.join(dir, ".agile"), { recursive: true });
    for (let i = 0; i < 100; i++) {
      const obs = createObserverState();
      const sprint = {
        id: 1, goal: "g", status: "planning", tasks: [
          { bd_id: "a", title: "A", status: "done", review_rounds: 0, branch: "feat/a" },
        ], started_at: "", completed_at: "",
      };
      let reworks = 0;
      const n = genInt(rng, 0, 10);
      for (let j = 0; j < n; j++) {
        const st = genPick(rng, ["rework", "done", "blocked"]);
        trackTaskTransition(obs, "a", st);
        if (st === "rework") reworks++;
        else reworks = 0;
      }
      const steers = runSprintObserver(sprint, obs, DEFAULT_OBSERVER_CONFIG, dir);
      const stuck = steers.some((s) => s.type === "stagnation");
      assert.strictEqual(stuck, reworks >= 3, `stagnation steer mismatch: reworks=${reworks}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────────

console.log("# pi-agile PBT (state-machine model + pure properties)\n");

console.log("## state machine: random sprint lifecycle (invariants after every action)");
await forAll({ seeds: 40, maxActions: 90, name: "sprint lifecycle invariants", run: runScenario });

console.log("## pure: continuation gate implication");
await forAll({ seeds: 20, maxActions: 1, name: "gate fires only when all guards clear", run: (rng, seed) => pureContinuationGate(rng, seed) });

console.log("## pure: session state round-trip + corruption");
await forAll({ seeds: 20, maxActions: 1, name: "session save→load + corrupt never throws", run: (rng, seed) => pureSessionRoundTrip(rng, seed) });

console.log("## pure: yaml parser (stop_when array-of-maps)");
await forAll({ seeds: 20, maxActions: 1, name: "yaml fuzz: conditions are array-of-maps", run: (rng, seed) => pureYamlFuzz(rng, seed) });

console.log("## pure: bd show parser fuzz");
await forAll({ seeds: 20, maxActions: 1, name: "bd parse never throws", run: (rng, seed) => pureBdFuzz(rng, seed) });

console.log("## pure: observer stagnation trigger");
await forAll({ seeds: 20, maxActions: 1, name: "stagnation steer iff reworks >= 3", run: (rng, seed) => pureObserverSequences(rng, seed) });

console.log(`\n# Results: ${pbtPass} passed, ${pbtFail} failed`);
if (pbtFail > 0) {
  console.error("\nFailures:");
  for (const f of pbtFailures) {
    console.error(`  - ${f.name} (seed ${f.seed}): ${f.message}`);
    if (f.log) console.error(`    repro: ${f.log.join(" → ")}`);
  }
  process.exit(1);
}
