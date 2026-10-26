// Contract tests for the two pi-agile tools (agile_run launch station, agile_status).
// Runs the TypeScript modules directly (node >= 22 type stripping):
//   node --experimental-strip-types --test tests/pi-agile-tools.test.mjs
// bd is never touched: the launch planner receives a mock runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { planLaunch, ENGINE_WORKFLOW, LAUNCH_TIMEOUT_MS } from "../extensions/pi-agile/launch.ts";
import { statusReport } from "../extensions/pi-agile/status.ts";

const T = (name, fn) => test(name, { timeout: 15000 }, fn);

// --- mock bd: answers only the read-only commands the planner is allowed to issue ---
function issue(id, status, description, blocks = []) {
  return {
    id,
    title: "title " + id,
    description,
    status,
    dependencies: [
      { id: "E", dependency_type: "parent-child" },
      ...blocks.map((b) => ({ id: b, dependency_type: "blocks" })),
    ],
  };
}

function fixtureData() {
  return {
    epic: { id: "E", title: "Epic title", status: "open", description: "", dependencies: [] },
    children: { E: ["L1", "L2", "L3", "L4", "P"], P: ["C"] },
    issues: {
      L1: issue("L1", "open", "Add parser in extensions/pi-agile/bd.ts. review: lite\nAcceptance: (1) node --test passes (2) exit 0"),
      L2: issue("L2", "open", "Wire launch in extensions/pi-agile/launch.ts", ["L1"]),
      L3: issue("L3", "closed", "Old leaf, already merged"),
      L4: issue("L4", "open", "Docs only", ["L3"]),
      P: issue("P", "open", "Parent with a child: not a leaf"),
    },
  };
}

function mockBd(data, calls = []) {
  return async (args) => {
    calls.push(args);
    if (args[0] === "list" && args[1] === "--parent") {
      const kids = data.children[args[2]] || [];
      return JSON.stringify(kids.map((id) => ({ id, title: "t", status: "open" })));
    }
    if (args[0] === "show") {
      const ids = args.slice(1, args.indexOf("--json"));
      const rows = ids.map((id) => {
        if (id === "E") return data.epic;
        if (data.issues[id]) return data.issues[id];
        throw new Error(`bd show ${id} failed: no issue found matching "${id}"`);
      });
      return JSON.stringify(rows);
    }
    throw new Error("mock bd: unexpected command " + args.join(" "));
  };
}

const BASE = { epic: "E", testCommand: "npm test" };

// --- agile_run -------------------------------------------------------------

T("agile_run: bd-epic launch plan from a mocked bd (open leaves, engine shape, defaults)", async () => {
  const calls = [];
  const plan = await planLaunch({ ...BASE, bundleScript: "C:/bundle.sh" }, { cwd: "/repo", run: mockBd(fixtureData(), calls) });

  assert.ok(plan.workflow.endsWith(path.join("workflows", "agile-loop.js")), plan.workflow);
  assert.equal(plan.workflow, ENGINE_WORKFLOW);
  assert.ok(fs.existsSync(plan.workflow), "engine workflow exists on disk");
  assert.equal(plan.cwd, "/repo");
  assert.equal(plan.timeoutMs, 14400000);
  assert.equal(LAUNCH_TIMEOUT_MS, 14400000);

  const a = plan.args;
  assert.equal(a.taskSource, "bd-epic");
  assert.equal(a.bdEpic, "E");
  assert.equal(a.doneWhen, "bd-epic-closed");
  assert.equal(a.mergeApproval, "auto");
  assert.equal(a.testCommand, "npm test");
  assert.equal(a.sprintTasks, 3);
  assert.equal(a.maxSprints, 3);
  assert.equal(a.maxParallel, 3);
  assert.equal(a.bundleScript, "C:/bundle.sh");
  assert.equal(a.workModels, undefined);

  // open leaves only, closed deps dropped (satisfied), normalizeLeaf fields in engine order
  assert.deepEqual(a.bdTasks, [
    {
      id: "L1", title: "title L1",
      rationale: "Add parser in extensions/pi-agile/bd.ts. review: lite\nAcceptance: (1) node --test passes (2) exit 0",
      acceptance: "(1) node --test passes (2) exit 0",
      files_hint: "extensions/pi-agile/bd.ts",
      deps: [], open: true, review: "lite",
    },
    {
      id: "L2", title: "title L2",
      rationale: "Wire launch in extensions/pi-agile/launch.ts",
      acceptance: "",
      files_hint: "extensions/pi-agile/launch.ts",
      deps: ["L1"], open: true, review: "full",
    },
    {
      id: "L4", title: "title L4",
      rationale: "Docs only",
      acceptance: "", files_hint: "",
      deps: [], open: true, review: "full",
    },
  ]);

  // read-only: only show / list --parent were issued
  for (const c of calls) assert.ok(c[0] === "show" || (c[0] === "list" && c[1] === "--parent"), c.join(" "));

  // no bundleScript warning when one is given; the copyable subagent call is present
  assert.deepEqual(plan.warnings, []);
  assert.ok(plan.call.startsWith("subagent({ workflowScriptPath: "), plan.call);
  assert.ok(plan.call.includes(JSON.stringify(ENGINE_WORKFLOW)));
});

T("agile_run: bundleScript absent -> warning in the output, args carry no bundleScript", async () => {
  const plan = await planLaunch(BASE, { cwd: "/repo", run: mockBd(fixtureData()) });
  assert.equal(plan.args.bundleScript, undefined);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /bundleScript/);
});

T("agile_run: workModels overlapping reviewModels -> error string", async () => {
  await assert.rejects(
    planLaunch({ ...BASE, workModels: ["m-a", "m-b"], reviewModels: ["m-b"] }, { cwd: "/repo", run: mockBd(fixtureData()) }),
    /overlap.*m-b/,
  );
});

T("agile_run: distinct workModels/reviewModels pass through to args", async () => {
  const plan = await planLaunch({ ...BASE, workModels: ["m-a"], reviewModels: ["m-b"], sprintTasks: 2, maxSprints: 1, maxParallel: 2, mergeApproval: "confirm" }, { cwd: "/repo", run: mockBd(fixtureData()) });
  assert.deepEqual(plan.args.workModels, ["m-a"]);
  assert.deepEqual(plan.args.reviewModels, ["m-b"]);
  assert.equal(plan.args.sprintTasks, 2);
  assert.equal(plan.args.maxSprints, 1);
  assert.equal(plan.args.maxParallel, 2);
  assert.equal(plan.args.mergeApproval, "confirm");
});

T("agile_run: invalid mergeApproval -> error string", async () => {
  await assert.rejects(planLaunch({ ...BASE, mergeApproval: "yes" }, { cwd: "/repo", run: mockBd(fixtureData()) }), /mergeApproval/);
});

T("agile_run: epic with no open leaves -> error (nothing to launch)", async () => {
  const data = fixtureData();
  data.children.E = ["L3"];
  await assert.rejects(planLaunch(BASE, { cwd: "/repo", run: mockBd(data) }), /no open leaves/);
});

T("agile_run: closed leaf whose dep is still open -> error (bd inconsistency)", async () => {
  const data = fixtureData();
  data.children.E = ["L1", "L3"];
  data.issues.L3 = issue("L3", "closed", "Closed on top of open work", ["L1"]);
  await assert.rejects(planLaunch(BASE, { cwd: "/repo", run: mockBd(data) }), /closed leaf L3 depends on open leaf L1/);
});

T("agile_run: missing epic -> error naming the epic", async () => {
  await assert.rejects(planLaunch({ ...BASE, epic: "NOPE" }, { cwd: "/repo", run: mockBd(fixtureData()) }), /epic NOPE not found/);
});

T("agile_run: missing epic/testCommand -> error", async () => {
  await assert.rejects(planLaunch({ testCommand: "x" }, { cwd: "/repo", run: mockBd(fixtureData()) }), /epic is required/);
  await assert.rejects(planLaunch({ epic: "E" }, { cwd: "/repo", run: mockBd(fixtureData()) }), /testCommand is required/);
});

// --- agile_status ----------------------------------------------------------

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-agile-status-test-"));
}

T("agile_status: empty temp -> 'no runs found' (no crash)", () => {
  const tmp = tmpRoot();
  try {
    const text = statusReport({}, { tmpDir: tmp });
    assert.match(text, /no runs found/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

T("agile_status: unknown runId -> 'not found' (no crash)", () => {
  const tmp = tmpRoot();
  try {
    fs.mkdirSync(path.join(tmp, "pi-subagents-x", "async-subagent-runs"), { recursive: true });
    const text = statusReport({ runId: "nope" }, { tmpDir: tmp });
    assert.match(text, /run nope not found/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

T("agile_status: freshest run dir -> workflow result, checkpoint and last child_settled (read-only)", () => {
  const tmp = tmpRoot();
  try {
    const runs = path.join(tmp, "pi-subagents-x", "async-subagent-runs");
    const missionDir = path.join(tmp, "mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "state.json"), JSON.stringify({
      "agile-cp": { phase: "completed", sprintDone: 2, used: 7, repairUsed: 0, result: { planned: 3, merged: 3 }, coolingDown: {} },
    }));

    const old = path.join(runs, "old-run");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "status.json"), JSON.stringify({ state: "complete" }));

    const dir = path.join(runs, "new-run");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "mission.json"), JSON.stringify({ missionDir }));
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
      state: "complete",
      cwd: "/repo",
      workflow: { value: { status: "completed", done: true, stopReason: "epic-closed", counts: { planned: 3, merged: 3 }, sprints: 2, used: 7 } },
    }));
    fs.writeFileSync(path.join(dir, "workflow-receipt.json"), JSON.stringify({ state: "complete", workflowChildren: { children: [{}, {}] } }));
    fs.writeFileSync(path.join(dir, "events.jsonl"), [
      { type: "subagent.workflow.child_settled", childKey: "s1-t1-work", outcome: "completed", ts: 1 },
      { type: "subagent.workflow.trace", trace: [] },
      { type: "subagent.workflow.child_settled", childKey: "s2-t2-merge", outcome: "completed", ts: 2 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    // make "new-run" strictly fresher than "old-run"
    const future = new Date(Date.now() + 60000);
    fs.utimesSync(dir, future, future);

    const filesBefore = fs.readdirSync(dir).length;
    const text = statusReport({}, { tmpDir: tmp });
    const rep = JSON.parse(text);
    assert.equal(rep.runId, "new-run");
    assert.equal(rep.workflow.stopReason, "epic-closed");
    assert.equal(rep.workflow.done, true);
    assert.deepEqual(rep.workflow.counts, { planned: 3, merged: 3 });
    assert.equal(rep.receipt.children, 2);
    assert.equal(rep.checkpoint.phase, "completed");
    assert.equal(rep.checkpoint.sprintDone, 2);
    assert.deepEqual(rep.recentChildren.map((c) => c.childKey), ["s1-t1-work", "s2-t2-merge"]);

    // cwd filter: no run matches another repo
    assert.match(statusReport({ cwd: "/elsewhere" }, { tmpDir: tmp }), /no runs found/);
    // read-only: the run dir gained no files
    assert.equal(fs.readdirSync(dir).length, filesBefore);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
