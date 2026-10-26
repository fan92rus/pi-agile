// harness.mjs — deterministic fake-runs simulator for agile-loop.js (NO LLM).
// Compiles the workflow source into an AsyncFunction(args, runs, emit) and drives
// it with scripted child responses: ordered event log, per-key launch counts,
// captured child specs (for contract assertions), fault injection by error class.
// Virtual-concurrency semantics: real setTimeout with millisecond delays; tests
// assert on the EVENT ORDER, never on wall-clock totals.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export const WORKFLOW_PATH = join(HERE, "..", "workflows", "agile-loop.js");
export const WORKFLOW_SRC = readFileSync(WORKFLOW_PATH, "utf8");

export function compileWorkflow() {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction("args", "runs", "emit", "state", WORKFLOW_SRC);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- scripted responses -------------------------------------------------------
export const ok = (structuredOutput, delayMs = 0) => async () => {
  if (delayMs) await sleep(delayMs);
  return { ok: true, structuredOutput };
};
// engine-level failure (child ran, reported ok:false)
export const fail = (error, delayMs = 0) => async () => {
  if (delayMs) await sleep(delayMs);
  return { ok: false, error };
};
// transport-level failure (child never produced a result)
export const boom = (message, delayMs = 0) => async () => {
  if (delayMs) await sleep(delayMs);
  throw new Error(message);
};

// --- standard child payloads ---------------------------------------------------
export function workOut(over = {}) {
  return Object.assign(
    {
      what_done: "did the task",
      files_changed: ["src/a.txt"],
      verification: "npm test; exit 0",
      branch: "",
      worktree: "",
      head: "1111111111111111111111111111111111111111",
      completed: true,
      // rp-schema acceptance fields: the structured output IS the acceptance report.
      // Defaults form a fully schema-valid report; tests override individual fields
      // to probe validateAccStructured rejections ('schema-missing: <field>').
      testsAddedOrUpdated: [],
      commandsRun: [{ command: "npm test", result: "passed", summary: "green" }],
      validationOutput: ["ok 12 tests"],
      residualRisks: [],
      noStagedFiles: true,
      criteriaSatisfied: [
        { id: "criterion-1", status: "satisfied", evidence: "diff is scoped to the task" },
        { id: "criterion-2", status: "satisfied", evidence: "gate green" },
      ],
    },
    over
  );
}
export const reviewOk = (approved = true, extra = {}) =>
  Object.assign({ approved, rework_reasons: approved ? "" : "not good enough", notes: "r" }, extra);
export const mergeOut = (over = {}) =>
  // bd_closed: true = a competent merger closed the leaf it just merged (bd-epic mode);
  // tests override it to false to simulate a failed best-effort close.
  Object.assign({ merged: true, checks_ok: true, journal_written: true, bd_closed: true, note: "" }, over);
export const dropOut = (over = {}) =>
  Object.assign({ dropped: true, journal_written: true, note: "dropped" }, over);
export const arbOut = (decision, note = "") => ({ decision, note });

export function curatorOut(approved_by_caller, tasks, brief = "plan") {
  return { sprint_brief: brief, approved_by_caller, tasks };
}
export function task(i, over = {}) {
  return Object.assign(
    {
      title: "task " + i,
      rationale: "why " + i,
      acceptance: "acc " + i,
      files_hint: "src/a.txt", // names the file workOut() changes: a contract the default worker honours
      wave: 1,
      engine: "bare",
      engine_reason: "mechanical",
    },
    over
  );
}

// --- fake runs -----------------------------------------------------------------
// routes: [{ match: RegExp, handle: async (spec, key) => result }]
// First matching route wins. Unknown key -> hard error (typos surface loudly).
export function makeRuns(routes) {
  const events = [];
  const counts = new Map();
  const specs = new Map();
  const runs = {
    events,
    specs,
    keys: () => [...counts.keys()],
    count(pred) {
      let n = 0;
      for (const [k, c] of counts) if (typeof pred === "string" ? k.includes(pred) : pred.test(k)) n += c;
      return n;
    },
    spec(pred) {
      for (const [k, s] of specs) if (typeof pred === "string" ? k.includes(pred) : pred.test(k)) return { key: k, spec: s };
      return null;
    },
    async run(key, spec) {
      counts.set(key, (counts.get(key) || 0) + 1);
      specs.set(key, spec);
      events.push({ t: "start", key });
      let route = routes.find((r) => (typeof r.match === "string" ? key.includes(r.match) : r.match.test(key)));
      if (!route && K.analytics.test(key)) {
        // The best-effort analytics child launches in EVERY campaign; most tests do not
        // care about it. Default no-op route keeps "unknown key -> hard error" loud for
        // everything else; tests that assert analytics override it via happyRoutes.
        route = { handle: async () => ({ ok: true, structuredOutput: { runid: "snap", skipped: false, summaryLine: "wall=? children=? tokens=? failures=0" } }) };
      }
      if (!route) throw new Error("harness: no route for key " + key);
      try {
        const res = await route.handle(spec, key);
        events.push({ t: "ok", key });
        return res;
      } catch (e) {
        events.push({ t: "err", key, message: String((e && e.message) || e) });
        throw e;
      }
    },
  };
  return runs;
}

// Route matcher fragments for agile-loop key shapes: s1-t1-work, s1-t1-work~retry2,
// s1-t1-rework2, s1-t1-review(-rN), s1-t1-merge, s1-t1-arbiter, s1-t1-drop,
// s1-t1-repair, s1-discovery, s1-curator, s1-retro, s2-boundary, sdd-setup.
export const K = {
  sddSetup: /^sdd-setup/,
  discovery: /-discovery$/,
  curator: /-curator$/,
  work: /-work(~retry\d+)?$/,
  rework: /-rework\d+$/,
  review: /-review(-r\d+)?(~retry\d+)?$/,
  merge: /-merge(~retry\d+)?$/,
  arbiter: /-arbiter(~retry\d+)?$/,
  drop: /-drop$/,
  reportRepair: /-report-repair$/,
  boundary: /-boundary(~retry\d+)?$/, // federation bd-epic mode: one sprint-boundary child (janitor + snapshot refresh)
  cleanup: /^final-cleanup(~retry\d+)?$/, // campaign-end leftover worktree/branch janitor
  finalClose: /^final-bd-close(~retry\d+)?$/, // bd-epic post-loop bd-close of the last sprint's merges (any stopReason)
  analytics: /^campaign-analytics(~retry\d+)?$/, // campaign-end metrics archiver (analyze-campaign.mjs; best-effort)
  repair: /-repair/,
  retro: /-retro$/,
};

export function runCampaign(args, runs, state) {
  const emitted = [];
  const emit = (line) => emitted.push(String(line));
  const st = state || makeState();
  const fn = compileWorkflow();
  return fn(args, runs, emit, st).then(
    (res) => ({ res, events: runs.events, emitted, state: st }),
    (e) => ({ err: e, events: runs.events, emitted, state: st })
  );
}

// --- fake mission state (durable checkpoint store) --------------------------------
export function makeState(seed) {
  const store = new Map(Object.entries(seed || {}));
  const writes = [];
  return {
    store,
    writes,
    async get(key) {
      return store.get(key);
    },
    async set(key, value) {
      store.set(key, value);
      writes.push({ key, value });
      return value;
    },
  };
}

// Default campaign args: SDD off, auto merge, single sprint.
export function baseArgs(over = {}) {
  return Object.assign(
    {
      description: "test campaign",
      testCommand: "npm test",
      sdd: false,
      mergePolicy: "auto",
      sprintTasks: 3,
      maxSprints: 1,
      maxParallel: 3,
      reworkLimit: 2,
      journalDir: ".agile-js-test",
    },
    over
  );
}

// --- event helpers ---------------------------------------------------------------
export const evIndex = (events, pred) => events.findIndex((e) => pred(e));
export const started = (events, keyRe) => events.findIndex((e) => e.t === "start" && keyRe.test(e.key));
export const finishedOk = (events, keyRe) => events.findIndex((e) => e.t === "ok" && keyRe.test(e.key));
export const launchedKeys = (events, keyRe) =>
  events.filter((e) => e.t === "start" && keyRe.test(e.key)).map((e) => e.key);
