/**
 * PBT v2 — Property-Based Testing that drives the REAL extension
 * (extensions/pi-agile/index.ts) through a fake pi API, instead of a mirrored
 * model. Run with:
 *   node --experimental-strip-types --experimental-loader ./tests/typebox-redirect-loader.mjs tests/pbt.test.mjs
 *
 * The typebox-redirect-loader stubs "@sinclair/typebox" (the only module that
 * blocks importing index.ts under plain node) — production jiti is untouched.
 *
 * Every action below calls the REAL tool execute / hook / command handler:
 *   agile_on, before_agent_start, agile_start_sprint, agile_delegate_task
 *   (fake subagent RPC bridge + fast poll), agile_retrospective, agent_end,
 *   /agile run|stop, session restart, corruption.
 * Invariants assert on the real store files + the messages the real code sent.
 */

process.env.PI_AGILE_POLL_INTERVAL_MS = "10"; // fast polls for the fake-bridge delegate

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const EXT_DIR = path.join(import.meta.dirname, "..", "extensions", "pi-agile");
const importMod = (rel) => import(pathToFileURL(path.join(EXT_DIR, rel)).href);

const { SprintStore } = await importMod("parallel/sprint.ts");
const { shouldSendContinuation, saveSessionState, loadSessionState } = await importMod("parallel/continuation.ts");
const { createObserverState, runSprintObserver, trackTaskTransition, DEFAULT_OBSERVER_CONFIG } =
  await importMod("observer.ts");
const { parseSimpleYaml } = await importMod("parallel/yaml.ts");
const { parseBdShow } = await importMod("parallel/bd.ts");

const { default: piAgileExtension } = await import(pathToFileURL(path.join(EXT_DIR, "index.ts")).href);
const { createFakePi, createFakeBridge, makeCtx, readSession, readLatestSprint } =
  await import(pathToFileURL(path.join(import.meta.dirname, "fake-pi.ts")).href);

// ──────────────────────────────────────────────────────────────────────
// PBT harness (seeded PRNG + prefix shrinking)
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

async function forAll({ seeds = 40, maxActions = 90, name, run }) {
  for (let seed = 0; seed < seeds; seed++) {
    try {
      await run(mulberry32(seed), seed, maxActions);
      pbtPass++;
    } catch (e) {
      pbtFail++;
      const repro = await shrinkPrefix(run, seed, maxActions);
      const log = repro?.log?.length ? `\n       actions: ${repro.log.join(" → ")}` : "";
      pbtFailures.push({ name, seed, message: e.message, log: repro?.log ?? null });
      console.error(`  ❌ ${name} [seed=${seed}]${log}\n     ${e.message}`);
    }
  }
}

async function shrinkPrefix(run, seed, maxActions) {
  let lo = 1;
  let hi = maxActions;
  let best = null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      await run(mulberry32(seed), seed, mid);
      lo = mid + 1;
    } catch (e) {
      best = { log: e.log ?? null };
      hi = mid;
    }
  }
  return best;
}

// ──────────────────────────────────────────────────────────────────────
// Real-system scenario driver
// ──────────────────────────────────────────────────────────────────────

const TERMINAL = new Set(["done", "blocked"]);
const ALLOWED_STATUSES = new Set(["backlog", "in_progress", "in_review", "done", "rework", "blocked"]);

/** Continuation-type message patterns (nudges + budget + observer steers). */
const NUDGE_RE =
  /Decide and act now|sprints? remaining|All sprints completed|continue to next sprint|next sprint or stop|continue or stop/i;

class RealSystem {
  constructor(dir, seed, rng) {
    this.dir = dir;
    this.seed = seed;
    this.rng = rng;
    this.bdTasks = new Map(); // bdId -> title (bd list / bd show fakes)
    this.nextTask = 1;
    this.pendingVerdict = "blocked"; // what the fake reviewer says on next delegate
    const { pi, tool, command, hook } = createFakePi({
      bdTasks: this.bdTasks,
      bridge: createFakeBridge({ verdictFor: () => this.pendingVerdict }),
    });
    piAgileExtension(pi); // real extension registers on the fake pi
    this.pi = pi;
    this.tool = tool;
    this.command = command;
    this.hook = hook;
    this.session = 0;
    this.ctx = makeCtx(dir, `pbt-${seed}-s${this.session}`);
    this.log = [];
    this.lastAction = null;
    this.boundedInitial = undefined;
    this.actionMarker = 0;
  }

  record(k) {
    this.log.push(k);
    this.lastAction = k;
  }

  newMessages() {
    return this.pi.sentMessages.slice(this.actionMarker);
  }

  nudgeCount(messages) {
    return messages.filter((m) => NUDGE_RE.test(m.text)).length;
  }

  // ---- REAL actions --------------------------------------------------

  async agileOn() {
    await this.command("agile").handler("on", this.ctx);
    this.record("agileOn");
  }

  async beforeStart() {
    const event = { systemPrompt: "" };
    await this.hook("before_agent_start")(event, this.ctx);
  }

  async startSprint() {
    const k = this.rng() < 0.15 ? 0 : genInt(this.rng, 1, 3);
    const ids = [];
    for (let i = 0; i < k; i++) {
      const id = `t${this.nextTask++}`;
      this.bdTasks.set(id, `Task ${id}`);
      ids.push(id);
    }
    await this.tool("agile_start_sprint").execute("t", { task_ids: ids }, null, null, this.ctx);
    this.record(`startSprint(${k})`);
  }

  async delegate() {
    const sprint = readLatestSprint(this.dir);
    if (!sprint) return;
    const eligible = sprint.tasks.filter((t) => t.status === "backlog" || t.status === "rework");
    if (eligible.length === 0) return;
    const t = genPick(this.rng, eligible);
    this.pendingVerdict = this.rng() < 0.6 ? "blocked" : "rework";
    await this.tool("agile_delegate_task").execute(
      "t",
      { bd_id: t.bd_id, title: t.title, description: `desc ${t.bd_id}` },
      null,
      null,
      this.ctx,
    );
    this.record(`delegate(${t.bd_id}→${this.pendingVerdict})`);
  }

  async retrospective() {
    if (!readLatestSprint(this.dir)) return;
    await this.tool("agile_retrospective").execute("t", {}, null, null, this.ctx);
    this.record("retrospective");
  }

  async agentEnd() {
    await this.hook("agent_end")({ messages: [] }, this.ctx);
    this.record("agentEnd");
  }

  async runBounded() {
    const n = genInt(this.rng, 1, 4);
    this.boundedInitial = n;
    await this.command("agile").handler(`run ${n}`, this.ctx);
    this.record(`runBounded(${n})`);
  }

  async runContinuous() {
    await this.command("agile").handler("run Improve the module boundaries", this.ctx);
    this.record("runContinuous");
  }

  async stop() {
    await this.command("agile").handler("stop", this.ctx);
    this.record("stop");
  }

  async restart() {
    // new session = fresh in-memory runtime (real restart semantics) + restore
    this.session++;
    this.ctx = makeCtx(this.dir, `pbt-${this.seed}-s${this.session}`);
    await this.beforeStart();
    this.record("restart");
  }

  async injectTasks() {
    // fresh session + pre-seeded sprint on disk — the REAL getCurrent(workDir)
    // auto-restores it (the 97bf88d / RC3 restart path).
    this.session++;
    this.ctx = makeCtx(this.dir, `pbt-${this.seed}-s${this.session}`);
    const store = new SprintStore();
    const id = store.findLastSprintId(this.dir) + 1;
    const sprint = store.create(this.dir, id, "seeded goal");
    const n = genInt(this.rng, 1, 4);
    for (let i = 0; i < n; i++) {
      const bdId = `t${this.nextTask++}`;
      store.addTask(sprint, {
        bd_id: bdId,
        title: `Task ${bdId}`,
        description: `d ${bdId}`,
        status: genPick(this.rng, ["done", "blocked", "rework", "backlog"]),
      });
    }
    store.save(this.dir, sprint);
    await this.beforeStart();
    this.record(`injectTasks(${n})`);
  }

  async corruptSession() {
    const file = path.join(this.dir, ".agile", "session.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const garbage = genPick(this.rng, [
      "{not json", "[]", "null", "42", "\u0000\xff\xfe",
      JSON.stringify({ remainingSprints: "NaN", loopStopped: "yes" }), "",
    ]);
    fs.writeFileSync(file, garbage, "utf8");
    this.record("corruptSession");
  }

  async corruptSprintFile() {
    const id = new SprintStore().findLastSprintId(this.dir);
    if (id <= 0) return;
    fs.writeFileSync(path.join(this.dir, ".agile", `sprint-${id}.json`), "{torn write", "utf8");
    this.record(`corruptSprint#${id}`);
  }
}

const WEIGHTS = [
  ["startSprint", 6], ["delegate", 9], ["retrospective", 4], ["agentEnd", 8],
  ["runBounded", 2], ["runContinuous", 2], ["stop", 2], ["restart", 2],
  ["injectTasks", 1], ["corruptSession", 1], ["corruptSprintFile", 2],
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
// Invariants (after every action, on the REAL system)
// ──────────────────────────────────────────────────────────────────────

async function checkInvariants(sys) {
  const sprint = readLatestSprint(sys.dir);

  // P1 persist-echo: disk state === what the real code last wrote
  if (sprint) {
    const file = path.join(sys.dir, ".agile", `sprint-${sprint.id}.json`);
    let disk;
    try {
      disk = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      disk = null; // torn write — P2c recovery covers it
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

  // P8 ≤1 continuation-type message per action
  assert.ok(sys.nudgeCount(sys.newMessages()) <= 1, `P8: ${sys.nudgeCount(sys.newMessages())} continuation messages in one action`);

  // P9 anti-spam: an agent_end right after an agent_end never nudges twice
  if (sys.lastAction === "agentEnd") {
    const marker = sys.pi.sentMessages.length;
    await sys.hook("agent_end")({ messages: [] }, sys.ctx);
    assert.strictEqual(sys.nudgeCount(sys.pi.sentMessages.slice(marker)), 0, "P9: agent_end nudged twice in a row");
  }

  // P10 stop silence: after /agile stop, the next agent_end must not nudge
  if (sys.lastAction === "stop") {
    const marker = sys.pi.sentMessages.length;
    await sys.hook("agent_end")({ messages: [] }, sys.ctx);
    assert.strictEqual(sys.nudgeCount(sys.pi.sentMessages.slice(marker)), 0, "P10: nudge after /agile stop");
  }

  // P7 budget: remainingSprints (persisted) never exceeds the initial budget.
  // Only meaningful for numeric values — corrupt session.json may contain junk
  // strings (real loadSessionState filters them by type guard).
  const sess = readSession(sys.dir);
  if (typeof sess.remainingSprints === "number" && sys.boundedInitial !== undefined) {
    assert.ok(
      sess.remainingSprints <= sys.boundedInitial,
      `P7: remainingSprints (${sess.remainingSprints}) above initial budget (${sys.boundedInitial})`,
    );
  }

  // P11 velocity sanity on the current sprint
  if (sprint?.velocity) {
    const v = sprint.velocity;
    assert.ok(v.done >= 0 && v.rework >= 0 && v.blocked >= 0, "P11: negative velocity");
    assert.ok(v.done + v.rework + v.blocked <= v.attempted, "P11: velocity sums exceed attempted");
    assert.ok(v.avg_review_rounds >= 0, "P11: negative avg review rounds");
  }
}

async function runScenario(rng, seed, maxActions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pbt-real-${seed}-`));
  const sys = new RealSystem(dir, seed, rng);
  try {
    await sys.agileOn(); // agile mode ON first (config.json persisted)
    for (let step = 0; step < maxActions; step++) {
      sys.actionMarker = sys.pi.sentMessages.length;
      const action = pickAction(rng);
      await sys[action]();
      await checkInvariants(sys);
    }
  } catch (e) {
    e.log = sys.log;
    throw e;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Pure properties (unchanged — real modules, random inputs)
// ──────────────────────────────────────────────────────────────────────

function pureContinuationGate(rng) {
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
    for (const garbage of ["{bad", "[]", "null", "42", "\"str\"", "\u0000\x01\x02", JSON.stringify({ remainingSprints: "x", loopStopped: 5 }), "{\"remainingSprints\": NaN}"]) {
      fs.writeFileSync(path.join(dir, ".agile", "session.json"), garbage, "utf8");
      assert.ok(typeof loadSessionState(dir) === "object", "corrupt session must return object");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pureYamlFuzz(rng) {
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
        assert.ok(typeof c === "object" && !Array.isArray(c), "condition item must be a map");
        assert.ok("metric" in c && "target" in c, "condition item must carry metric+target");
      }
    }
  }
}

function pureBdFuzz(rng) {
  for (let i = 0; i < 300; i++) {
    const lines = genInt(rng, 1, 6);
    const body = Array.from({ length: lines }, () =>
      Array.from({ length: genInt(rng, 1, 5) }, () =>
        genPick(rng, ["Fix", "bug", "in", "parser", "This", "is", "second", "line", "API", "v2", "endpoints", "NO", "CHANGES", "done"]),
      ).join(" "),
    ).join("\n");
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
        reworks = st === "rework" ? reworks + 1 : 0;
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

console.log("# pi-agile PBT v2 (REAL extension via fake pi) + pure properties\n");

console.log("## state machine: real orchestration (invariants after every action)");
await forAll({ name: "real extension lifecycle", run: runScenario });

console.log("## pure: continuation gate implication");
await forAll({ seeds: 20, maxActions: 1, name: "gate fires only when all guards clear", run: (rng) => pureContinuationGate(rng) });

console.log("## pure: session state round-trip + corruption");
await forAll({ seeds: 20, maxActions: 1, name: "session save→load + corrupt never throws", run: (rng, seed) => pureSessionRoundTrip(rng, seed) });

console.log("## pure: yaml parser (stop_when array-of-maps)");
await forAll({ seeds: 20, maxActions: 1, name: "yaml fuzz: conditions are array-of-maps", run: (rng) => pureYamlFuzz(rng) });

console.log("## pure: bd show parser fuzz");
await forAll({ seeds: 20, maxActions: 1, name: "bd parse never throws", run: (rng) => pureBdFuzz(rng) });

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
