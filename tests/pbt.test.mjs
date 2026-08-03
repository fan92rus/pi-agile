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
import { execFileSync } from "node:child_process";

const EXT_DIR = path.join(import.meta.dirname, "..", "extensions", "pi-agile");
const importMod = (rel) => import(pathToFileURL(path.join(EXT_DIR, rel)).href);

const { SprintStore } = await importMod("parallel/sprint.ts");
const { shouldSendContinuation, saveSessionState, loadSessionState } = await importMod("parallel/continuation.ts");
const { createObserverState, runSprintObserver, trackTaskTransition, DEFAULT_OBSERVER_CONFIG } =
  await importMod("observer.ts");
const { parseSimpleYaml } = await importMod("parallel/yaml.ts");
const { parseBdShow } = await importMod("parallel/bd.ts");

const { default: piAgileExtension } = await import(pathToFileURL(path.join(EXT_DIR, "index.ts")).href);
const { createFakePi, createFakeBridge, makeCtx, makeFakeUi, readSession, readLatestSprint } =
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

async function forAll({ seeds = 25, maxActions = 50, name, run }) {
  for (let seed = 0; seed < seeds; seed++) {
    const t0 = process.env.PBT_DEBUG ? Date.now() : 0;
    try {
      await run(mulberry32(seed), seed, maxActions);
      pbtPass++;
    } catch (e) {
      pbtFail++;
      const repro = await shrinkPrefix(run, seed, maxActions);
      const fullLog = e.log ?? [];
      const log = repro?.log?.length ? repro.log : fullLog;
      pbtFailures.push({ name, seed, message: e.message, log: log });
      console.error(`  ❌ ${name} [seed=${seed}]${log.length ? `\n       actions: ${log.join(" → ")}` : ""}\n     ${e.message}`);
    }
    if (process.env.PBT_DEBUG) console.error(`  [${name}] seed=${seed} done in ${Date.now() - t0}ms`);
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
  constructor(dir, seed, rng, opts = {}) {
    this.dir = dir;
    this.seed = seed;
    this.rng = rng;
    this.realGit = opts.realGit ?? false; // run REAL git via child_process
    this.bdTasks = new Map(); // bdId -> title (bd list / bd show fakes)
    this.nextTask = 1;
    this.pendingVerdict = "blocked"; // what the fake reviewer says on next single delegate
    this.batchVerdicts = new Map(); // bdId -> verdict for batch runs
    this.bridgeState = { dead: false, stuck: false }; // flip to simulate failures
    this.gitState = { originalBranch: "main", showCurrent: "main", headBefore: "aaa111", headAfter: "aaa111" };
    this.execTable = {}; // mutable exec overrides (e.g. failing `npm test`)
    this.batchVerdictsRef = this.batchVerdicts;
    const { pi, tool, command, hook } = createFakePi({
      bdTasks: this.bdTasks,
      gitState: this.gitState,
      execTable: this.execTable,
      realGit: this.realGit,
      bridge: createFakeBridge({
        bridgeState: this.bridgeState,
        verdictFor: (bdId) => this.batchVerdicts.get(bdId) ?? this.pendingVerdict,
        commitWorkerChange: opts.commitWorkerChange ?? false,
      }),
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
    const wasStuck = this.bridgeState.stuck;
    const wasDead = this.bridgeState.dead;
    const res = await this.tool("agile_delegate_task").execute(
      "t",
      { bd_id: t.bd_id, title: t.title, description: `desc ${t.bd_id}` },
      null,
      null,
      this.ctx,
    );
    if (wasStuck) {
      // P20: a stuck worker must fail the delegate with an explicit error
      const text = res.content?.[0]?.text ?? "";
      assert.ok(
        /did not complete|idle for|force-stopped/i.test(text),
        `P20: stuck worker must abort delegate (got: ${text.slice(0, 120)})`,
      );
      // The interrupt path clears stuck — unless the bridge is ALSO dead, in
      // which case the dead-bridge abort wins (nothing to interrupt).
      if (!wasDead) {
        assert.ok(!this.bridgeState.stuck, "P20: interrupt must clear stuck state");
      }
    }
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

  // ---- batch / merge / investigate / discover / knowledge / status / setup ----

  async delegateBatch() {
    const sprint = readLatestSprint(this.dir);
    if (!sprint) return;
    const eligible = sprint.tasks.filter((t) => t.status === "backlog" || t.status === "rework");
    if (eligible.length === 0) return;
    const n = Math.min(genInt(this.rng, 1, Math.min(3, eligible.length)), eligible.length);
    const chosen = eligible.slice(0, n);
    const ids = chosen.map((t) => t.bd_id);
    for (const t of chosen) {
      const v = this.rng() < 0.45 ? "blocked" : this.rng() < 0.5 ? "approved" : "rework";
      this.batchVerdicts.set(t.bd_id, v);
    }
    await this.tool("agile_delegate_task").execute("t", { bd_ids: ids }, null, null, this.ctx);
    this.record(`delegateBatch(${ids.join(",")})`);
  }

  async merge() {
    const sprint = readLatestSprint(this.dir);
    if (!sprint || sprint.tasks.length === 0) return;
    let candidates;
    if (this.realGit) {
      // Real git: merging a branch that does not exist fails — only merge
      // tasks whose feat/<bdId> branch actually exists.
      const branches = this.branchList();
      candidates = sprint.tasks.filter((t) => t.status !== "done" && branches.includes(`feat/${t.bd_id}`));
    } else {
      candidates = sprint.tasks.filter((t) => t.status !== "done");
    }
    if (candidates.length === 0) return;
    const t = genPick(this.rng, candidates);
    // Occasionally the project gains a failing test runner (package.json +
    // `npm test` that reports FAIL) — exercises the merge-checks highlight.
    if (this.rng() < 0.2 && !fs.existsSync(path.join(this.dir, "package.json"))) {
      fs.writeFileSync(
        path.join(this.dir, "package.json"),
        JSON.stringify({ name: "p", scripts: { test: "node tests/x.js" } }, null, 2),
        "utf8",
      );
      this.execTable["npm test"] = { code: 1, stdout: "FAIL tests\n1 failed", stderr: "" };
      this.checksFailArmed = true;
    }
    const res = await this.tool("agile_merge_task").execute("t", { bd_id: t.bd_id }, null, null, this.ctx);
    const text = res.content?.[0]?.text ?? "";
    if (this.checksFailArmed) {
      assert.ok(text.includes("Checks reported failures"), "P16: merge must flag failing checks");
    }
    this.record(`merge(${t.bd_id}${this.checksFailArmed ? ",failChecks" : ""})`);
  }

  async investigate() {
    const concern = `Potential bug in zone ${genInt(this.rng, 1, 9)}`;
    // In realGit mode the branch state comes from REAL git — the dirty/commit
    // variants are fake-git knobs only.
    const dirty = !this.realGit && this.rng() < 0.25; // occasionally the checkout-back silently fails
    const committed = !this.realGit && this.rng() < 0.2; // occasionally the detective commits a repro
    this.gitState.originalBranch = "main";
    this.gitState.showCurrent = dirty ? "investigate/xyz" : "main";
    this.gitState.headBefore = "aaa111";
    this.gitState.headAfter = committed ? "bbb222" : "aaa111";
    const res = await this.tool("agile_investigate").execute("t", { concern }, null, null, this.ctx);
    const text = res.content?.[0]?.text ?? "";
    assert.ok(text.includes("# Detective Investigation Report"), "P15: investigate must return a report");
    if (dirty) {
      assert.ok(
        text.includes("Checkout back to main failed"),
        `P15: dirty tree must warn about checkout-back failure (got: ${text.slice(0, 120)})`,
      );
    }
    this.record(`investigate(${dirty ? "dirty" : "clean"}${committed ? ",commit" : ""})`);
  }

  async discover() {
    const withScout = this.rng() < 0.5;
    const firstAfterSetup = this.checksReady;
    const res = await this.tool("agile_discover").execute(
      "t",
      { skip_scout: !withScout },
      null,
      null,
      this.ctx,
    );
    const text = res.content?.[0]?.text ?? "";
    assert.ok(text.length > 0, "P13: discover must return output");
    if (firstAfterSetup) {
      // Exercise the PRIMARY runChecks path once (real bash on the generated
      // template scripts — ~2s on Windows Git Bash startup), then remove the
      // templates so the rest of the scenario uses the fast fallback detectors.
      assert.ok(
        text.includes("## Metrics"),
        `P13: runChecks path must produce METRIC lines (got: ${text.slice(0, 100)})`,
      );
      const checksDir = path.join(this.dir, ".agile", "checks");
      for (const f of fs.readdirSync(checksDir)) {
        if (f.endsWith(".sh")) fs.rmSync(path.join(checksDir, f), { force: true });
      }
      this.checksReady = false;
    }
    this.record(`discover(${withScout ? "scout" : "noscout"})`);
  }

  async knowledge() {
    const act = this.rng() < 0.5 ? "append" : "read";
    if (act === "append") {
      const finding = `lesson-${genInt(this.rng, 1, 100)}`;
      await this.tool("agile_knowledge").execute(
        "t",
        { action: "append", type: "lesson", finding },
        null,
        null,
        this.ctx,
      );
      this.record(`knowledge(append:${finding})`);
    } else {
      await this.tool("agile_knowledge").execute("t", { action: "read" }, null, null, this.ctx);
      this.record("knowledge(read)");
    }
  }

  async status() {
    await this.command("agile").handler("status", this.ctx);
    this.record("status");
  }

  async setup() {
    // Queue answers for the REAL /agile setup wizard (ui.input/ui.select order).
    const ui = makeFakeUi([
      "",                                    // Press Enter to start
      `Proj-${this.seed}`,                   // project name
      "Fix all bugs in the module",          // goal
      "src/**",                              // include globs
      "node_modules/**, dist/**",            // exclude globs
      "All new code must have tests",        // constraint 1
      "",                                    // end constraints
      "continuous — no auto-stop, run until /agile stop", // stop criteria
      "standard — 3 dimensions (correctness, tests, constraints)", // review depth
    ]);
    this.ctx = { ...this.ctx, ui };
    await this.command("agile").handler("setup", this.ctx);
    const yaml = fs.readFileSync(path.join(this.dir, ".agile", "project.yaml"), "utf8");
    assert.ok(yaml.includes("Fix all bugs in the module"), "P17: setup must write the goal to project.yaml");
    const config = JSON.parse(fs.readFileSync(path.join(this.dir, ".agile", "config.json"), "utf8"));
    assert.strictEqual(config.agile_mode, true, "P17: setup must enable agile mode");
    assert.ok(
      this.pi.sentMessages.some((m) => m.text.startsWith("/agile setup complete")),
      "P17: setup must send the setup-complete followUp",
    );
    this.record("setup");
    this.checksReady = true; // template scripts exist — next discover runs real runChecks
  }

  async deadBridge() {
    this.bridgeState.dead = true;
    this.record("deadBridge");
  }

  async stuckBridge() {
    this.bridgeState.stuck = true;
    this.record("stuckBridge");
  }

  /** Real git helpers (only meaningful when realGit: true). */
  gitExec(args, cwd) {
    return execFileSync("git", args, { cwd: cwd ?? this.dir, encoding: "utf8" });
  }

  branchList() {
    return this.gitExec(["branch", "--list"]);
  }
}

const WEIGHTS = [
  ["startSprint", 5], ["delegate", 8], ["delegateBatch", 5], ["merge", 4],
  ["retrospective", 3], ["agentEnd", 7], ["investigate", 3], ["discover", 3],
  ["knowledge", 2], ["status", 2], ["setup", 1], ["deadBridge", 1], ["stuckBridge", 1],
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

  // P14: merging a task marks it done on disk
  if (sys.lastAction && sys.lastAction.startsWith("merge(")) {
    const id = sys.lastAction.match(/^merge\(([^,)]+)/)?.[1];
    const sprintNow = readLatestSprint(sys.dir);
    const t = sprintNow?.tasks.find((x) => x.bd_id === id);
    if (t) {
      assert.strictEqual(t.status, "done", `P14: merged task ${id} must be done (got ${t.status})`);
    }
  }

  // P19: REAL git branch lifecycle (realGit scenarios only)
  if (sys.realGit && sys.lastAction) {
    if (sys.lastAction.startsWith("delegate(")) {
      const id = sys.lastAction.match(/^delegate\(([^→]+)/)?.[1];
      if (id) {
        assert.ok(
          sys.branchList().includes(`feat/${id}`),
          `P19: feat/${id} must exist after delegate (branches: ${sys.branchList().trim().replace(/\n/g, ", ")})`,
        );
      }
    }
    if (sys.lastAction.startsWith("merge(")) {
      const id = sys.lastAction.match(/^merge\(([^,)]+)/)?.[1];
      if (id) {
        assert.ok(
          !sys.branchList().includes(`feat/${id}`),
          `P19: feat/${id} must be deleted after merge`,
        );
      }
    }
    if (sys.lastAction.startsWith("delegateBatch(")) {
      const wt = (sys.gitExec(["worktree", "list", "--porcelain"]).match(/^worktree /gm) ?? []).length;
      assert.ok(wt === 1, `P19: batch must clean up worktrees (found ${wt})`);
    }
  }

  // P18: batch that sent its own terminal/continuation steer must NOT get a
  // second continuation from the immediately-following agent_end (M2 disease
  // for the batch path — the merge tool was fixed, executeBatchTasks was not).
  if (sys.lastAction && sys.lastAction.startsWith("delegateBatch(")) {
    const sprintNow = readLatestSprint(sys.dir);
    const terminal =
      sprintNow && sprintNow.tasks.length > 0 && sprintNow.tasks.every((t) => t.status === "done" || t.status === "blocked");
    const batchMsgs = sys.newMessages();
    if (terminal && batchMsgs.length > 0 && sys.nudgeCount(batchMsgs) === 0) {
      const marker = sys.pi.sentMessages.length;
      await sys.hook("agent_end")({ messages: [] }, sys.ctx);
      assert.strictEqual(
        sys.nudgeCount(sys.pi.sentMessages.slice(marker)),
        0,
        "P18: agent_end double-nudges after batch exhausted-steer",
      );
    }
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
      const tA = process.env.PBT_DEBUG ? Date.now() : 0;
      await sys[action]();
      if (process.env.PBT_DEBUG && Date.now() - tA > 400) {
        console.error(`    [slow] ${action} took ${Date.now() - tA}ms (log: ${sys.log.join(" → ")})`);
      }
      await checkInvariants(sys);
    }
  } catch (e) {
    e.log = sys.log;
    throw e;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── REAL git repository scenario ───────────────────────────────────────

function setupRealGit(dir) {
  const run = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
  run(["init", "-q"]);
  run(["config", "user.email", "pbt@test.local"]);
  run(["config", "user.name", "PBT"]);
  fs.writeFileSync(path.join(dir, "readme.md"), "# pbt\n");
  run(["add", "-A"]);
  run(["commit", "-qm", "init"]);
  run(["branch", "-M", "main"]);
}

const REALGIT_WEIGHTS = [
  ["startSprint", 6], ["delegate", 8], ["delegateBatch", 4], ["merge", 4],
  ["retrospective", 3], ["agentEnd", 6], ["investigate", 2], ["knowledge", 2],
  ["status", 2], ["runBounded", 2], ["runContinuous", 2], ["stop", 2],
  ["restart", 2], ["injectTasks", 1],
];

async function runScenarioRealGit(rng, seed, maxActions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pbt-rg-${seed}-`));
  setupRealGit(dir);
  const sys = new RealSystem(dir, seed, rng, { realGit: true, commitWorkerChange: true });
  try {
    await sys.agileOn();
    for (let step = 0; step < maxActions; step++) {
      sys.actionMarker = sys.pi.sentMessages.length;
      const total = REALGIT_WEIGHTS.reduce((s, [, w]) => s + w, 0);
      let roll = rng() * total;
      let action = "agentEnd";
      for (const [name, w] of REALGIT_WEIGHTS) {
        roll -= w;
        if (roll <= 0) {
          action = name;
          break;
        }
      }
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

console.log("## state machine: REAL git repository (checkout/diff/merge/worktree/branch -D)");
await forAll({ seeds: 10, maxActions: 20, name: "real git integration lifecycle", run: runScenarioRealGit });

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
