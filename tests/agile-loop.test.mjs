// agile-loop.test.mjs — contract tests for the agile-loop workflow (NO LLM).
// Run: node --test tests/agile-loop.test.mjs
// Pins the Этап-1 target behavior: approval gate, non-blocking classified retry,
// no re-brief on schema/report failures, arbiter decision-only + mergeChain
// serialization, head-SHA binding, checks_ok required for "merged".
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import os from "node:os";
import pathMod from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeRuns, runCampaign, baseArgs, K, makeState, WORKFLOW_SRC,
  ok, fail, boom,
  workOut, reviewOk, mergeOut, dropOut, arbOut, curatorOut, task,
  started, finishedOk, launchedKeys,
} from "./harness.mjs";
import {
  analyzeCampaign, classifyFailure, classifyKey, roleFromKey, fmtDur,
} from "../workflows/analyze-campaign.mjs";
import { mergeBranch } from "../workflows/merge-branch.mjs";

const T = (name, fn) => test(name, { timeout: 15000 }, fn);

// A git MUTATION command silently continued with `|| true` - the ban targets real
// commands, not prose that happens to mention both `git add -A` and `|| true`.
const GIT_MUTATION_SILENT = /\bgit (?:add|commit|push|reset|restore|checkout|switch|merge|rebase|branch|worktree|clean|rm|mv|tag)[^\n`]*\|\| true/;

function happyRoutes(over = {}) {
  const w = over.work || ok(workOut());
  return [
    { match: K.sddSetup, handle: over.sddSetup || ok({ mode: "skip", reason: "t", tasks_file: "", items_total: 0 }) },
    { match: K.discovery, handle: over.discovery || ok({ summary: "s", baseline_green: true, issues: [] }) },
    { match: K.curator, handle: over.curator },
    { match: K.work, handle: w },
    { match: K.rework, handle: over.rework || w },
    { match: K.review, handle: over.review || ok(reviewOk(true)) },
    { match: K.arbiter, handle: over.arbiter },
    { match: K.merge, handle: over.merge || ok(mergeOut()) },
    { match: K.drop, handle: over.drop || ok(dropOut()) },
    { match: K.reportRepair, handle: over.reportRepair || ok(workOut()) },
    { match: K.repair, handle: over.repair || ok(workOut()) },
    { match: K.retro, handle: over.retro || ok({ velocity_summary: "v", lessons: [], continue: false, reason: "done" }) },
    { match: K.cleanup, handle: over.cleanup || ok({ cleaned: [] }) },
    { match: K.analytics, handle: over.analytics || ok({ runid: "snap", skipped: false, summaryLine: "wall=? children=? tokens=? failures=0" }) },
  ];
}

T("happy path: 1 task -> worktree isolation even solo, merge preflight + journal head", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(res.done, true);
  assert.equal(res.tasks[0].verdict, "merged");
  assert.equal(res.stopReason, "stop-criteria (retro)");
  const work = runs.spec(K.work);
  assert.ok(work, "work child launched");
  assert.ok(/git worktree add/.test(work.spec.task), "single task is ALSO worktree-isolated (main copy never switched)");
  assert.ok(!/git checkout main && git checkout -b/.test(work.spec.task), "no main-copy branch switch");
  assert.ok(work.spec.task.includes("npm test"), "gate command in worker brief");
  const merge = runs.spec(K.merge);
  assert.ok(merge.spec.task.includes("workflows/merge-branch.mjs"), "merge brief invokes deterministic CLI");
  assert.ok(merge.spec.task.includes("--approved-sha"), "CLI command carries approved SHA");
  assert.ok(runs.count(K.review) === 1 && runs.count(K.merge) === 1);
});

T("workModel/reviewModel: role-split models reach the right children; merge stays on top model", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ workModel: "m-worker", reviewModel: "m-reviewer" }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.spec(K.work).spec.model, "m-worker", "work child gets workModel");
  assert.equal(runs.spec(K.review).spec.model, "m-reviewer", "review child gets reviewModel");
  assert.equal(runs.spec(K.merge).spec.model, undefined, "merge child stays on the top-level model");
});

T("single-model degradation: workModel === reviewModel warns and degrades instead of throwing", async () => {
  const routes = happyRoutes({ curator: ok(curatorOut(true, [task(1)])) });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ workModel: "same-model", reviewModel: "same-model" }), runs);
  assert.ok(!out.err, "workflow must NOT throw (single-model degradation): " + (out.err && out.err.message));
  assert.equal(runs.spec(K.work).spec.model, "same-model", "work child on the configured model");
  assert.equal(runs.spec(K.review).spec.model, "same-model", "reviewer degrades onto the author's model");
  assert.ok(out.res.log.some((l) => /preflight/.test(l) && /same-model/.test(l)), "preflight warning names the collision: " + JSON.stringify(out.res.log));
});

T("manifest: actor-reported ABSOLUTE worktree accepted only with the deterministic basename", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ worktree: "D:/arena/wt-t1-task-1" })),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const merge = runs.spec(K.merge).spec.task;
  assert.ok(merge.includes("D:/arena/wt-t1-task-1"), "absolute worktree reaches the merger");
  // a superset basename (wt-t1-task-10 for wt-t1-task-1) must ALSO be ignored
  const routes3 = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ worktree: "D:/other/wt-t1-task-10" })),
  });
  const runs3 = makeRuns(routes3);
  const out3 = await runCampaign(baseArgs(), runs3);
  assert.ok(!out3.err, "workflow threw: " + (out3.err && out3.err.message));
  const merge3 = runs3.spec(K.merge).spec.task;
  assert.ok(!merge3.includes("D:/other/wt-t1-task-10"), "superset basename is not accepted");
  assert.ok(merge3.includes("wt-t1-task-1"), "deterministic path is used instead");
  // a forged path without the deterministic basename must be ignored
  const routes2 = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ worktree: "D:/SOMEWHERE/else" })),
  });
  const runs2 = makeRuns(routes2);
  const out2 = await runCampaign(baseArgs(), runs2);
  assert.ok(!out2.err, "workflow threw: " + (out2.err && out2.err.message));
  const merge2 = runs2.spec(K.merge).spec.task;
  assert.ok(!merge2.includes("D:/SOMEWHERE/else"), "forged worktree path is not trusted");
  assert.ok(merge2.includes("wt-t1-task-1"), "deterministic path is used instead");
});

T("forced SDD failure stops the campaign instead of degrading to bare work", async () => {
  const routes = happyRoutes({
    sddSetup: boom("provider down"),
    curator: ok(curatorOut(true, [task(1)])),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ sdd: true }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(res.stopReason, "sdd-setup-failed");
  assert.equal(res.done, false);
  assert.equal(runs.count(K.discovery), 0, "no discovery after a failed forced SDD phase");
  assert.equal(runs.count(K.work), 0, "no workers after a failed forced SDD phase");
});

T("approval-required: approved_by_caller=false -> no workers, no review, no merge", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(false, [task(1), task(2)])),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(res.stopReason, "approval-required");
  assert.equal(res.done, false);
  assert.equal(runs.count(K.work), 0, "no work children");
  assert.equal(runs.count(K.review), 0);
  assert.equal(runs.count(K.merge), 0);
  assert.equal(runs.count(K.arbiter), 0);
});

T("transport retry: retried with suffixed key, non-blocking (sibling lane progresses during wait)", async () => {
  let workCalls = 0;
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1), task(2)])),
    work: async (spec, key) => {
      if (key.includes("t1-work")) {
        workCalls++;
        if (workCalls === 1) await boom("fetch failed")(spec, key);
        return ok(workOut({ branch: "agile/task-1" }))(spec, key);
      }
      return ok(workOut({ branch: "agile/task-2" }), 2)(spec, key); // t2 finishes fast
    },
    review: ok(reviewOk(true), 1),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ retryDelays: [30] }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res, events, emitted } = out;
  assert.equal(res.retries, 1, "retry counted");
  assert.ok(res.log.some((l) => l.includes("[retry]")), "retry logged into the campaign log");
  const retryKeys = launchedKeys(events, /-work~retry\d+$/);
  assert.equal(retryKeys.length, 1, "exactly one retry launch: " + JSON.stringify(retryKeys));
  const t2Review = started(events, /s1-t2-review/);
  const t1Retry = started(events, /t1-work~retry/);
  assert.ok(t2Review >= 0 && t1Retry >= 0);
  assert.ok(t2Review < t1Retry, "sibling lane review started during retry wait (non-blocking delay)");
  assert.equal(res.tasks[0].verdict, "merged");
  assert.equal(res.tasks[1].verdict, "merged");
});

T("schema-missing: NO re-brief (single work launch), flow degrades to arbiter, drop via mergeChain", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: fail("required structured output was not produced"),
    review: ok(reviewOk(false)),
    arbiter: ok(arbOut("drop-branch", "no salvageable work")),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 0 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res, events } = out;
  assert.equal(runs.count(K.work), 1, "work launched exactly once (no auto re-brief)");
  assert.equal(launchedKeys(events, /~retry/).length, 0, "schema-missing is not retried");
  const arb = runs.spec(K.arbiter);
  assert.ok(arb, "arbiter launched");
  assert.ok(!/git merge --squash|git branch -D|git checkout main/.test(arb.spec.task),
    "arbiter child must NOT be instructed to mutate git");
  assert.ok(runs.spec(K.drop), "drop executed by a dedicated child");
  assert.equal(res.tasks[0].verdict, "dropped");
  assert.equal(res.done, false);
});

// ISSUE-4: a review child that ends without structured_output gets ONE re-run of the
// same review (same approved SHA, reminder appended) before any rework is spent.
T("review schema-miss: ONE re-run of the same review with a reminder, ok on the retry -> merged, zero rework", async () => {
  let reviewCalls = 0;
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: (spec, key) => {
      reviewCalls++;
      return reviewCalls === 1 ? fail("required structured output was not produced")() : ok(reviewOk(true))();
    },
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 2 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.review), 2, "exactly two review launches: the original + ONE re-run");
  assert.equal(runs.count(K.rework), 0, "schema-miss spends no rework round");
  assert.equal(runs.count(/-review-r\d+$/), 0, "no review-r round after a schema-miss");
  const orig = runs.spec(/t1-review$/).spec;
  const retry = runs.spec(/t1-review~retry2$/).spec;
  assert.ok(retry, "the re-run is keyed as a review retry");
  assert.equal(retry.model, orig.model, "re-run stays on the same reviewer model (no ladder)");
  assert.ok(retry.task.startsWith(orig.task), "re-run brief = the original brief (same approved SHA) + a reminder");
  assert.ok(/SCHEMA REMINDER/.test(retry.task.slice(orig.task.length)), "re-run carries the structured_output reminder");
  assert.equal(res.tasks[0].verdict, "merged", "ok verdict on the retry merges the task");
});

T("review schema-miss twice: exactly two review launches, zero rework/review-r, verdict failed with class review-schema-miss", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: fail("required structured output was not produced"),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 2 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.review), 2, "exactly two review launches: the original + ONE re-run");
  assert.equal(runs.count(K.rework), 0, "no rework after the review schema-miss");
  assert.equal(runs.count(/-review-r\d+$/), 0, "no review-r round after the review schema-miss");
  assert.equal(runs.count(K.arbiter), 0, "no arbitration after the review schema-miss");
  assert.equal(runs.count(K.merge), 0, "unreviewed work is never merged");
  assert.equal(res.tasks[0].verdict, "failed");
  assert.equal(res.tasks[0].failClass, "review-schema-miss");
  assert.ok(/review-schema-miss/.test(res.tasks[0].stop), "stop names the class: " + res.tasks[0].stop);
});

T("review approved:false is a verdict, not a schema-miss: no re-run, rework as before", async () => {
  let reviewCalls = 0;
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: (spec, key) => {
      reviewCalls++;
      return reviewCalls === 1 ? ok(reviewOk(false))() : ok(reviewOk(true))();
    },
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 2 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(launchedKeys(out.events, /~retry/).filter((k) => /review/.test(k)).length, 0, "approved:false never re-runs the review");
  assert.equal(runs.count(/-review(-r\d+)?$/), 2, "review + one review-r1 after the rework, nothing extra");
  assert.equal(runs.count(K.rework), 1, "approved:false spends exactly one rework round");
  assert.equal(out.res.tasks[0].verdict, "merged");
});

T("arbiter merge-as-is: orchestrator merges via mergeChain (serialized), verdict merged-after-arbitration", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1), task(2)])),
    review: ok(reviewOk(false)),
    arbiter: ok(arbOut("merge-as-is", "caller said merge")),
    merge: ok(mergeOut(), 30),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 0, maxParallel: 2 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res, events } = out;
  const m1end = finishedOk(events, /s1-t1-merge$/);
  const m2start = started(events, /s1-t2-merge$/);
  assert.ok(m1end >= 0 && m2start >= 0, "both merge children launched");
  assert.ok(m2start > m1end, "merges serialized on mergeChain");
  assert.equal(res.tasks[0].verdict, "merged-after-arbitration");
  assert.equal(res.tasks[1].verdict, "merged-after-arbitration");
  assert.equal(res.done, true);
  assert.equal(launchedKeys(events, /-rework\d+$/).length, 0, "reworkLimit=0 -> no rework rounds");
});

T("one-more-round guard: at most ONE arbiter-granted extra round; a repeated request forces drop", async () => {
  let reviewCalls = 0;
  let arbCalls = 0;
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: async () => {
      reviewCalls++;
      return ok(reviewOk(false))();
    },
    arbiter: async () => {
      arbCalls++;
      return ok(arbOut("one-more-round", "fix it"))();
    },
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 0 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(arbCalls, 2, "arbiter asked exactly twice (guard stops the loop)");
  assert.equal(runs.count(K.rework), 1, "exactly one arbiter-granted extra round");
  assert.ok(runs.spec(K.drop), "repeated one-more-round forced a drop");
  assert.equal(res.tasks[0].verdict, "dropped");
});

T("escalate-ledger: repair ceremony updates the approved head; merge uses the repair head", async () => {
  let reviewCalls = 0;
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ head: "1111111111111111111111111111111111111111" })),
    review: async () => {
      reviewCalls++;
      return ok(reviewOk(reviewCalls >= 2))();
    },
    arbiter: ok(arbOut("escalate-ledger", "genuinely nontrivial")),
    repair: ok(workOut({ head: "9999999999999999999999999999999999999999", what_done: "repair ceremony done" })),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 0, agentWork: "ledger-worker" }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.ok(runs.spec(K.repair), "repair ceremony launched");
  const merge = runs.spec(K.merge).spec.task;
  assert.ok(merge.includes("9999999999999999999999999999999999999999"),
    "merge verifies the REPAIR head, not the stale pre-repair one");
  assert.equal(res.tasks[0].verdict, "merged");
  assert.equal(res.done, true);
});

T("escalate-ledger: repair completed=false -> verdict failed, NO review child", async () => {
  // A repair ceremony that honestly reports completed=false is the ceremony's own
  // rejection: re-reviewing it would only re-reject and burn a review round (and
  // the arbiter ladder) on a doomed candidate - same rule as work/rework gates.
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ head: "1111111111111111111111111111111111111111" })),
    review: ok(reviewOk(false)),
    arbiter: ok(arbOut("escalate-ledger", "genuinely nontrivial")),
    repair: ok(workOut({ completed: false, what_done: "repair ceremony failed" })),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 0, agentWork: "ledger-worker" }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.repair), 1, "repair ceremony launched once");
  assert.equal(runs.count(K.review), 1, "exactly the FIRST review runs; the rejected repair report gets no review child");
  assert.equal(runs.count(K.arbiter), 1, "nothing to arbitrate after the gate");
  assert.equal(runs.count(K.merge), 0, "no merge without a reviewed candidate");
  assert.equal(res.tasks[0].verdict, "failed");
  assert.ok(runs.spec(K.retro), "campaign continues: retro still ran");
});

T("work completed=false -> verdict failed, NO review child, campaign continues", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ completed: false })),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.review), 0, "eager review must not burn on a rejected work report");
  assert.equal(runs.count(K.rework), 0, "no rework ladder on the worker's own rejection");
  assert.equal(runs.count(K.arbiter), 0, "nothing to arbitrate without a review");
  assert.equal(runs.count(K.merge), 0, "no merge without a reviewed candidate");
  assert.equal(res.tasks[0].verdict, "failed");
  assert.ok(runs.spec(K.retro), "campaign continues: retro still ran");
  assert.equal(res.status, "failed");
  assert.equal(res.counts.failed, 1, "the failed verdict is counted in counts.failed");
});

T("rework completed=false -> no second review child, verdict failed, campaign continues", async () => {
  // A rework round that reports completed=false is the worker's own rejection:
  // re-reviewing it would only re-reject and burn the arbiter/drop ladder.
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: ok(reviewOk(false)),
    rework: ok(workOut({ completed: false })),
    arbiter: ok(arbOut("drop-branch", "arbiter must never run here")),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 1 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.review), 1, "exactly the FIRST review runs; the rejected rework report gets no second review child");
  assert.equal(runs.count(K.rework), 1);
  assert.equal(runs.count(K.arbiter), 0, "nothing to arbitrate without a second review");
  assert.equal(runs.count(K.drop), 0, "no drop burn on a doomed candidate");
  assert.equal(res.tasks[0].verdict, "failed");
  assert.ok(runs.spec(K.retro), "campaign continues: retro still ran");
});

T("contract pre-check: header/files_hint names a file the branch never touched -> verdict failed, NO review child", async () => {
  // ys9/r1: a stale header rejected good work after a full review+rework round. The
  // mechanical pre-check compares the named deliverable with files_changed and fails fast.
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1, { title: "stale: rename old.js", files_hint: "src/old.js" })])),
    review: ok(reviewOk(true)),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.review), 0, "the LLM reviewer is never launched on a stale contract");
  assert.equal(runs.count(K.merge), 0, "nothing merges on a rejected contract");
  assert.equal(res.tasks[0].verdict, "failed");
  assert.ok(/^contract pre-check: contract names old\.js/.test(res.tasks[0].stop), "stop point names the mismatch: " + res.tasks[0].stop);
  assert.ok(runs.spec(K.retro), "campaign continues: retro still ran");
});

T("contract pre-check: a named file the branch DID touch passes; a contract naming no file is not checked", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [
      task(1, { title: "agile-loop.js: fix", files_hint: "skills/x/src/a.txt" }),
      task(2, { title: "no file named in this header", files_hint: "" }),
    ])),
    review: ok(reviewOk(true)),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ sprintTasks: 2 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.count(K.review), 2, "both contracts reach the reviewer");
  assert.ok(out.res.tasks.every((r) => r.verdict === "merged"), "both merged: " + out.res.tasks.map((r) => r.verdict).join(", "));
});

T("rework schema-missing salvage reports completed=false -> verdict failed, no review child", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: ok(reviewOk(false)),
    rework: ok(workOut({ validationOutput: [] })), // semantic rejection: 'schema-missing: validationOutput'
    reportRepair: ok(workOut({ completed: false })),
    arbiter: ok(arbOut("drop-branch", "arbiter must never run here")),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.reportRepair), 1, "the salvage child ran once");
  assert.equal(runs.count(K.review), 1, "exactly the FIRST review runs; the rejected salvage report gets no review child");
  assert.equal(runs.count(K.arbiter), 0, "nothing to arbitrate without a review");
  assert.equal(res.tasks[0].verdict, "failed");
  assert.ok(runs.spec(K.retro), "campaign continues: retro still ran");
});

T("rework acceptance-rejected after salvage already used -> verdict failed, NO second review child", async () => {
  // The work report was salvaged once (rec.repaired). A later rework report that the
  // acceptance validator rejects has no second salvage left - it must NOT be re-reviewed
  // (eager review of rejected work), the verdict is failed and the campaign continues.
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ validationOutput: [] })), // semantic rejection -> salvage (repaired=true)
    reportRepair: ok(workOut()),
    review: ok(reviewOk(false)),
    rework: ok(workOut({ validationOutput: [] })), // semantic rejection, salvage already used
    arbiter: ok(arbOut("drop-branch", "arbiter must never run here")),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 2 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.reportRepair), 1, "exactly one salvage (the work-phase one)");
  assert.equal(runs.count(K.rework), 1, "one rework round");
  assert.equal(runs.count(K.review), 1, "exactly the FIRST review runs; the rejected rework report gets no second review child");
  assert.equal(runs.count(K.arbiter), 0, "nothing to arbitrate without a second review");
  assert.equal(res.tasks[0].verdict, "failed");
  assert.ok(runs.spec(K.retro), "campaign continues: retro still ran");
});

T("provider overload (429): fail-fast retry-needed, no attempts burned", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: boom("HTTP 429 Too many requests, provider overloaded"),
    review: ok(reviewOk(false)),
    arbiter: ok(arbOut("drop-branch", "no salvageable work")),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 0 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res, events } = out;
  assert.equal(runs.count(K.work), 1, "overload is NOT retried");
  assert.equal(launchedKeys(events, /~retry/).length, 0);
  assert.equal(res.retries, 0);
  assert.equal(res.tasks[0].verdict, "failed", "a burned work phase is failed fast, not reviewed/dropped");
});

T("transport failure: bounded retries then transport-unrecovered", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: boom("fetch failed: ECONNRESET"),
    review: ok(reviewOk(false)),
    arbiter: ok(arbOut("drop-branch", "no salvageable work")),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 0, maxRetryAttempts: 2, retryDelays: [1, 1] }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.work), 3, "initial + maxRetryAttempts launches");
  assert.equal(res.retries, 2);
  assert.equal(res.tasks[0].verdict, "failed", "a burned work phase is failed fast, not reviewed/dropped");
});

T("message matching both schema and transport classes is schema-missing (no re-brief)", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: fail("fetch failed: required structured output was not produced"),
    review: ok(reviewOk(false)),
    arbiter: ok(arbOut("drop-branch", "no salvageable work")),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 0 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { events } = out;
  assert.equal(runs.count(K.work), 1, "schema class wins over transport class");
  assert.equal(launchedKeys(events, /~retry/).length, 0, "no retry for a dual-class message");
});

T("rec.head refresh: head-less work report -> schema-missing salvage -> review rejects -> rework head becomes THE approved head (kills 'branch head moved')", async () => {
  let reviewCalls = 0;
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ head: "" })), // finished, but never ran rev-parse: report rejected
    rework: ok(workOut({ head: "2222222222222222222222222222222222222222" })),
    review: async () => {
      reviewCalls++;
      return ok(reviewOk(reviewCalls >= 2))();
    },
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 1 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.work), 1, "implementation brief never re-run on the head-less report");
  assert.equal(runs.count(K.reportRepair), 1, "head-less report -> schema-missing -> salvage repair");
  assert.ok(res.log.some((l) => l.includes("schema-missing: head")), "rejection names the offending field: " + JSON.stringify(res.log));
  assert.ok(runs.spec(K.rework), "rework round ran");
  const merge = runs.spec(K.merge);
  assert.ok(merge, "merge launched after rework reported a head");
  assert.ok(merge.spec.task.includes("2222222222222222222222222222222222222222"),
    "rec.head = so.head of the LATEST schema-valid report: merge verifies the rework head, not the salvage head");
  assert.ok(!merge.spec.task.includes("1111111111111111111111111111111111111111"), "stale salvage head is gone from the merge brief");
  const rev2 = runs.spec(/t1-review-r1/);
  assert.ok(rev2.spec.task.includes("2222222222222222222222222222222222222222"), "reviewer brief carries the fresh head");
  assert.equal(res.tasks[0].verdict, "merged");
});

T("head-SHA binding: schema requires head; review and merge briefs carry the approved head", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const workSchema = runs.spec(K.work).spec.outputSchema;
  assert.ok(workSchema.properties.head, "WORK_SCHEMA has head");
  assert.ok(workSchema.required.includes("head"), "head is required");
  const review = runs.spec(K.review).spec.task;
  assert.ok(review.includes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "review brief carries the reported head");
  assert.ok(/rev-parse/.test(review), "review verifies branch head via rev-parse");
  const merge = runs.spec(K.merge).spec.task;
  assert.ok(merge.includes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "merge brief carries the approved head");
});

T("rework updates the approved head before the next review/merge", async () => {
  let reviewCalls = 0;
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ head: "1111111111111111111111111111111111111111" })),
    rework: ok(workOut({ head: "2222222222222222222222222222222222222222" })),
    review: async () => {
      reviewCalls++;
      return ok(reviewOk(reviewCalls >= 2))();
    },
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 1 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const review2 = runs.spec(/-review-r1$/);
  assert.ok(review2, "second review round ran");
  assert.ok(review2.spec.task.includes("2222222222222222222222222222222222222222"),
    "second review gets the REWORK head");
  const merge = runs.spec(K.merge).spec.task;
  assert.ok(merge.includes("2222222222222222222222222222222222222222"),
    "merge uses the rework head, not the stale one");
});

// --- FIX-ONLY rework (perf): a structured reviewer fix_list cuts the rework round to
// exactly the listed edits; empty/malformed list -> the legacy full rework brief. ------
T("fix-only rework: structured fix_list -> rework brief carries ONLY the listed fixes + scope guard + full gate", async () => {
  let reviewCalls = 0;
  const FIX_LIST = [
    { file: "src/a.js", fix: "guard the empty-input branch before split" },
    { file: "src/a.test.js", fix: "add the empty-input case to the suite" },
  ];
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ head: "1111111111111111111111111111111111111111" })),
    rework: ok(workOut({ head: "2222222222222222222222222222222222222222" })),
    review: async () => {
      reviewCalls++;
      return ok(reviewCalls === 1
        ? reviewOk(false, { rework_reasons: "helper splits empty input", fix_list: FIX_LIST })
        : reviewOk(true))();
    },
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 1 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.count(K.rework), 1, "one fix-only rework round");
  const rw = runs.spec(K.rework).spec;
  assert.ok(rw.task.includes("FIX-ONLY"), "rework round is marked fix-only");
  for (const f of FIX_LIST) {
    assert.ok(rw.task.includes("[" + f.file + "]: " + f.fix), "fix item verbatim in the brief: " + f.file);
  }
  assert.ok(rw.task.includes("Affected files (scope guard: touch ONLY these): src/a.js, src/a.test.js"),
    "affected-files line lists exactly the fix_list files (deduped)");
  assert.ok(/Apply ONLY these fixes/.test(rw.task) && /do NOT re-research the task/.test(rw.task),
    "scope guard: nothing beyond the list, no re-research");
  assert.ok(!rw.task.includes("Same task, same rules as before"), "legacy re-research brief is replaced");
  assert.ok(!rw.task.includes("Acceptance criteria: acc 1"), "no task re-statement in the fix-only brief");
  assert.ok(rw.task.includes("Verification command: env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH npm test"), "FULL suite stays the rework gate (sealed from PI_SUBAGENT_*)");
  assert.equal(rw.acceptance, false, "report contract unchanged (structured output IS the report)");
  const review2 = runs.spec(/-review-r1$/);
  assert.ok(review2, "fix-only report still goes through review");
  assert.equal(out.res.tasks[0].verdict, "merged", "happy path intact after fix-only rework");
});

T("fix-only rework: empty or malformed fix_list falls back to the legacy full rework brief", async () => {
  for (const bad of [[], [{ file: "src/a.js" }], "rename the helper", [{ file: "", fix: "x" }]]) {
    let reviewCalls = 0;
    const routes = happyRoutes({
      curator: ok(curatorOut(true, [task(1)])),
      work: ok(workOut({ head: "1111111111111111111111111111111111111111" })),
      rework: ok(workOut({ head: "2222222222222222222222222222222222222222" })),
      review: async () => {
        reviewCalls++;
        return ok(reviewCalls === 1
          ? reviewOk(false, { rework_reasons: "not good enough", fix_list: bad })
          : reviewOk(true))();
      },
    });
    const runs = makeRuns(routes);
    const out = await runCampaign(baseArgs({ reworkLimit: 1 }), runs);
    assert.ok(!out.err, "workflow threw for fix_list=" + JSON.stringify(bad) + ": " + (out.err && out.err.message));
    const rw = runs.spec(K.rework).spec;
    assert.ok(rw.task.includes("Same task, same rules as before"), "legacy full brief (" + JSON.stringify(bad) + ")");
    assert.ok(rw.task.includes("Reviewer rework reasons to address: "), "legacy rework line kept (" + JSON.stringify(bad) + ")");
    assert.ok(!rw.task.includes("FIX-ONLY"), "no fix-only marker (" + JSON.stringify(bad) + ")");
    assert.equal(out.res.tasks[0].verdict, "merged", "fallback flow still merges (" + JSON.stringify(bad) + ")");
  }
});

T("contract: REVIEW_SCHEMA carries optional fix_list ({file,fix} items); reviewer brief announces the channel", async () => {
  let reviewCalls = 0;
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ head: "1111111111111111111111111111111111111111" })),
    rework: ok(workOut({ head: "2222222222222222222222222222222222222222" })),
    review: async () => {
      reviewCalls++;
      return ok(reviewCalls === 1
        ? reviewOk(false, { rework_reasons: "x", fix_list: [{ file: "f.js", fix: "g" }] })
        : reviewOk(true))();
    },
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 1 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const sch = runs.spec(K.review).spec.outputSchema;
  assert.ok(sch.properties.fix_list, "fix_list property exists");
  assert.ok(!sch.required.includes("fix_list"), "fix_list stays OPTIONAL - verdicts without it stay schema-valid");
  assert.deepEqual(sch.properties.fix_list.items.required, ["file", "fix"], "each fix item pins file+fix");
  const rev = runs.spec(K.review).spec.task;
  assert.ok(rev.includes("fix_list"), "reviewer brief announces the fix_list channel");
});

T("contract: review brief carries the runtime-boundary rule (harness-green is not production evidence)", async () => {
  // pf3/rework1 lesson: code on runs.host was 141/141 green in the harness and dead in
  // production - only reading the host sources saved the reviewer. The brief makes
  // runtime-boundary verification a MANDATORY review step in BOTH tiers: a change that
  // depends on runtime primitives must be verified against the REAL launch path
  // (host/launcher sources or docs), and a green harness run is not evidence of that.
  for (const tier of [undefined, "lite"]) {
    const routes = happyRoutes({
      curator: ok(curatorOut(true, [task(1, tier ? { review: tier } : {})])),
    });
    const runs = makeRuns(routes);
    const out = await runCampaign(baseArgs(), runs);
    assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
    const rev = runs.spec(K.review).spec.task;
    const label = tier || "full";
    assert.ok(rev.includes("RUNTIME-BOUNDARY"), "reviewer brief names the runtime-boundary rule (" + label + ")");
    assert.ok(rev.includes("runs.host"), "rule names host channels like runs.host (" + label + ")");
    assert.ok(rev.includes("REAL launch path"), "rule demands verification in the REAL launch path, not only the harness (" + label + ")");
    assert.ok(rev.includes("harness-green"), "rule names the harness-green trap (" + label + ")");
    assert.ok(/production evidence/i.test(rev), "harness-green is explicitly not production evidence (" + label + ")");
  }
});

T("contract: work/rework/repair briefs carry the no-scratch-debug diagnostic rule", async () => {
  // ys9/wave-5 precedent: workers twice burned 250k+ tokens on self-written helper
  // scripts (bd-cursor ys9, debug-tracker.mjs). Workers read BRIEFS, not AGENTS.md,
  // so the diagnostic rule must ride in EVERY implementation-round brief: work,
  // rework (both fix-only and legacy share the tail) and the ledger repair ceremony.
  // Diagnosis goes through EXISTING commands; scratch scripts need explicit
  // justification in the final report.
  const assertRule = (task, label) => {
    assert.ok(task.includes("NO SCRATCH DEBUG SCRIPTS"), label + " names the no-scratch-debug rule");
    assert.ok(task.includes("bd list --json") && task.includes("bd show"), label + " names the existing bd commands");
    assert.ok(task.includes("node --test"), label + " names node --test (with a timeout) as the existing command");
    assert.ok(task.includes("debug-*.mjs"), label + " names the forbidden scratch scripts (debug-*.mjs)");
    assert.ok(task.includes("temp-file+node:fs"), label + " names the temp-file+node:fs scripting pattern");
    assert.ok(task.includes("ready-made repo analyzers"), label + " points to ready-made repo analyzers");
    assert.ok(task.includes("without explicit justification"), label + " forbids scratch scripts without explicit justification in the final report");
  };
  // work brief: happy path
  const workRoutes = happyRoutes({ curator: ok(curatorOut(true, [task(1)])) });
  const workRuns = makeRuns(workRoutes);
  const wOut = await runCampaign(baseArgs(), workRuns);
  assert.ok(!wOut.err, "work campaign threw: " + (wOut.err && wOut.err.message));
  assertRule(workRuns.spec(K.work).spec.task, "work brief");
  // rework brief: reviewer rejects once, then approves
  let reviewCalls = 0;
  const reworkRoutes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: async () => { reviewCalls++; return ok(reviewOk(reviewCalls >= 2))(); },
  });
  const reworkRuns = makeRuns(reworkRoutes);
  const rOut = await runCampaign(baseArgs({ reworkLimit: 1 }), reworkRuns);
  assert.ok(!rOut.err, "rework campaign threw: " + (rOut.err && rOut.err.message));
  assert.ok(reworkRuns.spec(K.rework), "rework round launched");
  assertRule(reworkRuns.spec(K.rework).spec.task, "rework brief");
  // repair brief (escalate-ledger ceremony): reviewer rejects, arbiter escalates
  const repairRoutes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: ok(reviewOk(false)),
    arbiter: ok(arbOut("escalate-ledger", "genuinely nontrivial")),
    repair: ok(workOut({ head: "9999999999999999999999999999999999999999", what_done: "repair ceremony done" })),
  });
  const repairRuns = makeRuns(repairRoutes);
  const pOut = await runCampaign(baseArgs({ reworkLimit: 0, agentWork: "ledger-worker" }), repairRuns);
  assert.ok(!pOut.err, "repair campaign threw: " + (pOut.err && pOut.err.message));
  assert.ok(repairRuns.spec(K.repair), "repair ceremony launched");
  assertRule(repairRuns.spec(K.repair).spec.task, "repair brief");
});

T("ISSUE-7 contract: work/rework/report-repair/repair briefs run the gate as env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH <testCommand>", async () => {
  const GATE = "env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH npm test";
  const workRuns = makeRuns(happyRoutes({ curator: ok(curatorOut(true, [task(1)])) }));
  const wOut = await runCampaign(baseArgs(), workRuns);
  assert.ok(!wOut.err, "work campaign threw: " + (wOut.err && wOut.err.message));
  assert.ok(workRuns.spec(K.work).spec.task.includes("Verification command (must pass before you finish): " + GATE), "work brief");
  let reviewCalls = 0;
  const reworkRuns = makeRuns(happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: async () => { reviewCalls++; return ok(reviewOk(reviewCalls >= 2))(); },
  }));
  const rOut = await runCampaign(baseArgs({ reworkLimit: 1 }), reworkRuns);
  assert.ok(!rOut.err, "rework campaign threw: " + (rOut.err && rOut.err.message));
  assert.ok(reworkRuns.spec(K.rework).spec.task.includes("Verification command: " + GATE), "rework brief");
  const reportRuns = makeRuns(happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: fail("required structured output was not produced"),
  }));
  const sOut = await runCampaign(baseArgs(), reportRuns);
  assert.ok(!sOut.err, "report-repair campaign threw: " + (sOut.err && sOut.err.message));
  assert.ok(reportRuns.spec(K.reportRepair).spec.task.includes("Run the verification command YOURSELF: " + GATE), "report-repair brief");
  const repairRuns = makeRuns(happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: ok(reviewOk(false)),
    arbiter: ok(arbOut("escalate-ledger", "genuinely nontrivial")),
    repair: ok(workOut({ head: "9999999999999999999999999999999999999999", what_done: "repair ceremony done" })),
  }));
  const pOut = await runCampaign(baseArgs({ reworkLimit: 0, agentWork: "ledger-worker" }), repairRuns);
  assert.ok(!pOut.err, "repair campaign threw: " + (pOut.err && pOut.err.message));
  assert.ok(repairRuns.spec(K.repair).spec.task.includes("run the gate yourself: " + GATE), "repair brief");
});

T("merged:true with checks_ok:false is NOT a merged verdict", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    merge: ok(mergeOut({ merged: true, checks_ok: false })),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(res.tasks[0].verdict, "merge-failed");
  assert.equal(res.done, false);
});

T("parallel mode: multi-task wave briefs use worktrees", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1), task(2)])),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ maxParallel: 2 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const work = runs.spec(K.work).spec.task;
  assert.ok(/git worktree add/.test(work), "parallel tasks isolate in worktrees");
});

T("report-repair: schema-missing after work -> ONE report-recovery child, merge uses recovered head", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: fail("required structured output was not produced"),
    reportRepair: ok(workOut({ head: "3333333333333333333333333333333333333333", what_done: "recovered report" })),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.work), 1, "implementation brief NEVER re-run");
  assert.equal(runs.count(K.reportRepair), 1, "exactly one report-repair child");
  const repair = runs.spec(K.reportRepair).spec.task;
  assert.ok(/do NOT implement anything new/.test(repair), "repair is explicitly read-only recovery");
  const merge = runs.spec(K.merge).spec.task;
  assert.ok(merge.includes("3333333333333333333333333333333333333333"), "merge uses the recovered head");
  assert.equal(res.tasks[0].verdict, "merged");
  assert.equal(res.repairUsed, 1, "repair-class round counted");
  assert.equal(res.status, "completed");
});

T("report-repair: semantic schema-missing after work also salvages - no re-brief, structured contract taught (no fence)", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ validationOutput: [] })), // 'schema-missing: validationOutput' (empty evidence)
    reportRepair: ok(workOut({ head: "4444444444444444444444444444444444444444", what_done: "recovered report" })),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.work), 1, "implementation brief NEVER re-run on report-shaped rejection");
  assert.equal(runs.count(K.reportRepair), 1, "exactly one report-repair child");
  assert.ok(res.log.some((l) => l.includes("schema-missing: validationOutput")), "rejection names the offending field: " + JSON.stringify(res.log));
  const repair = runs.spec(K.reportRepair).spec.task;
  assert.ok(repair.includes("criteriaSatisfied") && repair.includes("noStagedFiles") && repair.includes("commandsRun"),
    "repair brief teaches the structured acceptance fields (the structured output IS the report)");
  assert.ok(!repair.includes("END your final message with exactly this fence"), "repair brief no longer teaches the removed acceptance_report fence");
  assert.equal(res.tasks[0].verdict, "merged");
  assert.equal(res.status, "completed");
});

T("rework salvage: rework child rejected on report shape -> ONE salvage child, re-review proceeds, no re-implementation", async () => {
  let reviewCalls = 0;
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: async () => {
      reviewCalls++;
      return ok(reviewOk(reviewCalls >= 2))();
    },
    rework: ok(workOut({ residualRisks: "none" })), // semantic rejection: 'schema-missing: residualRisks'
    reportRepair: ok(workOut({ head: "5555555555555555555555555555555555555555", what_done: "recovered after rework" })),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 2 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.work), 1, "no re-implementation after rework report-shape failure");
  assert.equal(runs.count(K.rework), 1, "one rework round");
  assert.equal(runs.count(K.reportRepair), 1, "exactly one salvage child");
  assert.equal(reviewCalls, 2, "re-review ran after salvage");
  assert.equal(res.tasks[0].verdict, "merged");
  assert.equal(res.status, "completed");
});

T("report-repair failure fails the task fast (exactly one repair attempt, no review burn)", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: fail("required structured output was not produced"),
    reportRepair: fail("provider gone"),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 0 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.reportRepair), 1, "exactly one repair attempt");
  assert.equal(runs.count(K.review), 0, "no review child on an unsalvageable work phase");
  assert.equal(res.tasks[0].verdict, "failed");
});

T("checkpoint: phases running->completed, generation 1, counters on the happy path", async () => {
  const routes = happyRoutes({ curator: ok(curatorOut(true, [task(1)])) });
  const runs = makeRuns(routes);
  const st = makeState();
  const out = await runCampaign(baseArgs(), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  const cp = st.store.get("agile-cp");
  assert.ok(cp, "checkpoint written");
  assert.equal(cp.phase, "completed");
  assert.equal(cp.status, "completed");
  assert.equal(cp.generation, 1);
  assert.equal(cp.result.merged, 1);
  assert.equal(cp.used, res.used);
  assert.ok(res.used >= 6, "all child launches counted: " + res.used);
  assert.equal(res.status, "completed");
});

T("resume reconcile: interrupted older-generation checkpoint is marked, generation ++, allowances carried", async () => {
  const routes = happyRoutes({ curator: ok(curatorOut(true, [task(1)])) });
  const runs = makeRuns(routes);
  const st = makeState({ "agile-cp": { phase: "running", generation: 4, used: 10, repairUsed: 2 } });
  const out = await runCampaign(baseArgs(), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(res.generation, 5, "generation incremented from the checkpoint");
  assert.ok(res.used >= 16, "previous used carried forward and incremented: " + res.used);
  assert.ok(res.log.some((l) => l.includes("reconcile: previous checkpoint phase=running")), "interruption surfaced in the log");
  const cp = st.store.get("agile-cp");
  assert.equal(cp.generation, 5);
  assert.equal(cp.interruptedBefore, true);
});

T("blocked status: approval-required -> status blocked, counters reported", async () => {
  const routes = happyRoutes({ curator: ok(curatorOut(false, [task(1), task(2)])) });
  const runs = makeRuns(routes);
  const st = makeState();
  const out = await runCampaign(baseArgs(), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(res.status, "blocked");
  assert.equal(res.done, false);
  assert.deepEqual(res.counts, { planned: 2, merged: 0, dropped: 0, failed: 0 });
  const cp = st.store.get("agile-cp");
  assert.equal(cp.phase, "waiting", "blocked campaign parks in waiting phase");
});

T("overload retry-needed: checkpoint records the wait reason", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: boom("HTTP 429 Too many requests, provider overloaded"),
    review: ok(reviewOk(false)),
    arbiter: ok(arbOut("drop-branch", "n")),
  });
  const runs = makeRuns(routes);
  const st = makeState();
  const out = await runCampaign(baseArgs({ reworkLimit: 0 }), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const waited = st.writes.find((w) => w.key === "agile-cp" && w.value.phase === "waiting" && w.value.wait && w.value.wait.reason === "provider-overload");
  assert.ok(waited, "waiting checkpoint with provider-overload reason recorded");
  assert.equal(out.res.retries, 0, "overload is not retried");
});

T("shared queue (work-stealing): a short task never waits behind a striped lane-mate", async () => {
  // lanes would schedule [t1(100), t3(1)] / [t2(1)]: t3 would start only at ~100ms.
  // A shared queue: t2 frees its slot at ~1ms and takes t3 immediately.
  const delays = [100, 1, 1];
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1), task(2), task(3)])),
    work: async (spec, key) => {
      const m = /s1-t(\d+)-work/.exec(key);
      await new Promise((r) => setTimeout(r, delays[+m[1] - 1]));
      return ok(workOut({ branch: "agile/task-" + m[1] }))();
    },
    review: ok(reviewOk(true), 1),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ maxParallel: 2 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const t3start = started(out.events, /s1-t3-work$/);
  const t1end = finishedOk(out.events, /s1-t1-work$/);
  assert.ok(t3start >= 0 && t1end >= 0);
  assert.ok(t3start < t1end, "t3 stolen by the free slot while t1 still runs (shared queue, not stripes)");
  assert.equal(out.res.tasks.filter((r) => r.verdict === "merged").length, 3, "all tasks accounted");
});

T("postPhase backlog cap: reviews bounded by post slots; work queue never blocked", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1), task(2), task(3)])),
    work: ok(workOut(), 5),
    review: ok(reviewOk(true), 20),
    merge: ok(mergeOut()),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ maxParallel: 2 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { events } = out;
  const t1rEnd = finishedOk(events, /s1-t1-review$/);
  const t2rEnd = finishedOk(events, /s1-t2-review$/);
  const t3rStart = started(events, /s1-t3-review$/);
  const firstFree = Math.min(t1rEnd, t2rEnd);
  assert.ok(t3rStart > firstFree, "t3 review waits for the FIRST free post slot (backlog capped at maxParallel)");
  assert.ok(started(events, /s1-t3-work$/) < firstFree, "t3 WORK is not blocked by the post backlog (separate queues)");
  const t1mEnd = finishedOk(events, /s1-t1-merge$/);
  const t2mStart = started(events, /s1-t2-merge$/);
  assert.ok(t2mStart > t1mEnd, "merges still serialize on mergeChain");
});

// --- paired waves (agents-6xp): disjoint work children run concurrently, merges land on main mid-flight.
// The staged-index race ('Staged index changed after launch') died with withGate acceptance:false:
// the host no longer snapshots main's index at child launch, and noStagedFiles is judged on the
// child's OWN worktree. These tests pin both halves of that contract.
T("paired wave: sibling merge lands during a work child's life - that child still passes acceptance", async () => {
  let releaseT2;
  const t1Merged = new Promise((r) => { releaseT2 = r; });
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1), task(2)])),
    // t2 stays alive until t1's merge has landed on main (the old race window)
    work: async (spec, key) => {
      if (/s1-t2-work$/.test(key)) await t1Merged;
      return ok(workOut({ noStagedFiles: true }))();
    },
    merge: async (spec, key) => {
      const r = await ok(mergeOut())();
      if (/s1-t1-merge$/.test(key)) releaseT2();
      return r;
    },
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ maxParallel: 2 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { events, res } = out;
  assert.ok(finishedOk(events, /s1-t1-merge$/) < finishedOk(events, /s1-t2-work$/), "t1 merged while t2 work was still alive");
  const w2 = runs.spec(/s1-t2-work$/);
  assert.equal(w2.spec.acceptance, false, "work child: host acceptance (main-index snapshot) is OFF - no launch-time staged check");
  assert.equal(runs.count(/s1-t2-work/), 1, "t2 work is never re-briefed");
  assert.equal(runs.count(K.reportRepair), 0, "no report salvage for the paired sibling");
  assert.equal(runs.count(/s1-t2-review$/), 1, "t2 reaches review");
  assert.equal(runs.count(/s1-t2-merge$/), 1, "t2 reaches merge");
  assert.equal(res.tasks.filter((r) => r.verdict === "merged").length, 2, "both paired tasks merged");
  assert.equal(res.tasks.find((r) => r.title === "task 2").verdict, "merged", "the sibling that outlived the merge passes acceptance");
});

T("merger pre-flight under parallelism: 3-wide wave merges never overlap and each merger preflights main", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1), task(2), task(3)])),
    work: ok(workOut(), 5),
    review: ok(reviewOk(true), 1),
    merge: ok(mergeOut(), 5),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ maxParallel: 3 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  // mergeChain: at most ONE merger child alive at a time -> strict start/ok alternation
  const mergeEv = out.events.filter((e) => /-merge$/.test(e.key) && (e.t === "start" || e.t === "ok"));
  assert.equal(mergeEv.length, 6, "three merger children, each started and finished");
  mergeEv.forEach((e, i) => assert.equal(e.t, i % 2 === 0 ? "start" : "ok", "merger event " + i + " overlaps a live merger"));
  for (const k of [1, 2, 3]) {
    const m = runs.spec(new RegExp("^s1-t" + k + "-merge$"));
    assert.ok(m && m.spec.task.includes("workflows/merge-branch.mjs"), "t" + k + " merger invokes deterministic CLI");
  }
  assert.equal(out.res.tasks.filter((r) => r.verdict === "merged").length, 3, "all tasks accounted");
});

T("relay workModel: the ceremony launch spec carries workModel, not the top model", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1, { engine: "ledger", engine_reason: "nontrivial" })])),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ agentWork: "ledger-worker", workModel: "m-worker" }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const work = runs.spec(K.work).spec.task;
  assert.ok(work.includes('model: "m-worker"'), "relay launch spec carries workModel");
});

T("npm bootstrap: ci only when node_modules missing or lockfile newer", async () => {
  const routes = happyRoutes({ curator: ok(curatorOut(true, [task(1)])) });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const work = runs.spec(K.work).spec.task;
  assert.ok(work.includes("ONLY when node_modules is missing or the lockfile is newer"), "bootstrap by lockfile, not per task");
});

T("per-model cap: 3 same-model work children, cap 2 -> third starts only after a slot frees", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1), task(2), task(3)])),
    work: ok(workOut(), 30),
    review: ok(reviewOk(true), 1),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ maxParallel: 3, maxPerModel: 2 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { events } = out;
  const t3start = started(events, /s1-t3-work$/);
  const t1end = finishedOk(events, /s1-t1-work$/);
  const t2end = finishedOk(events, /s1-t2-work$/);
  assert.ok(t3start > 0 && t1end > 0 && t2end > 0);
  assert.ok(t3start >= Math.min(t1end, t2end), "t3 work must wait for a freed model slot (maxPerModel 2)");
  assert.equal(out.res.tasks.filter((r) => r.verdict === "merged").length, 3, "all tasks accounted");
});

T("per-model cap 3 with maxParallel 3: no artificial serialization", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1), task(2), task(3)])),
    work: ok(workOut(), 30),
    review: ok(reviewOk(true), 1),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ maxParallel: 3, maxPerModel: 3 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const t3start = started(out.events, /s1-t3-work$/);
  const t1end = finishedOk(out.events, /s1-t1-work$/);
  assert.ok(t3start > 0 && t1end > 0);
  assert.ok(t3start < t1end, "cap equal to maxParallel must not serialize same-model work");
});

T("per-model cap keys by model: review (other model) overlaps saturated work model", async () => {
  // t1w,t2w hold the work model (cap 2); t3w waits. t1 ends first; the freed work
  // slot goes to t3w AND t1's review starts on the review model while t2w STILL runs:
  // 3 live children across 2 models - a GLOBAL cap of 2 would forbid this.
  const delays = [60, 90, 90];
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1), task(2), task(3)])),
    work: async (spec, key) => {
      const m = /s1-t(\d+)-work/.exec(key);
      await new Promise((r) => setTimeout(r, delays[+m[1] - 1]));
      return ok(workOut({ branch: "agile/task-" + m[1] }))();
    },
    review: ok(reviewOk(true), 5),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ maxParallel: 3, maxPerModel: 2, workModel: "m-work", reviewModel: "m-review" }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { events } = out;
  const t2end = finishedOk(events, /s1-t2-work$/);
  const t3start = started(events, /s1-t3-work$/);
  const t1rStart = started(events, /s1-t1-review$/);
  assert.ok(t3start > 0 && t1rStart > 0 && t2end > 0);
  assert.ok(t3start < t2end, "t3 took the work slot freed by t1 while t2 still runs");
  assert.ok(t1rStart < t2end, "review ran on its own model's slot while t2 work (other model) still runs");
  assert.equal(out.res.tasks.filter((r) => r.verdict === "merged").length, 3, "all tasks accounted");
});

T("modelLadder: overload on primary -> next attempt on the ladder model", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: (spec, key) => (spec.model === "m-b" ? ok(workOut({ branch: "agile/task-1" }))() : boom("HTTP 429 Too many requests, provider overloaded")()),
    review: ok(reviewOk(true), 1),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ modelLadder: ["m-b"] }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.count(K.work), 2, "ladder step burns exactly one extra attempt (shared counter)");
  const retry = runs.spec(/t1-work~retry/);
  assert.ok(retry, "retry launched");
  assert.equal(retry.spec.model, "m-b", "fallback attempt carries the ladder model");
  assert.equal(out.res.tasks.filter((r) => r.verdict === "merged").length, 1, "task completed on the ladder model");
});

T("modelLadder exhausted -> fail-fast wait records lastModel", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: boom("HTTP 429 Too many requests, provider overloaded"),
    review: ok(reviewOk(false)),
    arbiter: ok(arbOut("drop-branch", "n")),
  });
  const runs = makeRuns(routes);
  const st = makeState();
  const out = await runCampaign(baseArgs({ modelLadder: ["m-b"], reworkLimit: 0 }), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.count(K.work), 2, "primary + one ladder model, then fail-fast (no infinite burn)");
  const waited = st.writes.find((w) => w.key === "agile-cp" && w.value.phase === "waiting" && w.value.wait && w.value.wait.reason === "provider-overload");
  assert.ok(waited, "waiting checkpoint recorded");
  assert.equal(waited.value.wait.lastModel, "m-b", "wait reason carries the model that still failed");
});

T("modelLadder for review children never ladders onto the work model", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut()),
    review: (spec, key) => (spec.model === "m-x" ? ok(reviewOk(true))() : boom("HTTP 429 Too many requests, provider overloaded")()),
    merge: ok(mergeOut()),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ workModel: "m-w", reviewModel: "m-r", modelLadder: ["m-w", "m-x"] }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const retry = runs.spec(/t1-review~retry/);
  assert.ok(retry, "review retry launched");
  assert.equal(retry.spec.model, "m-x", "review ladders to m-x, skipping the work model m-w (cross-model review)");
  assert.equal(out.res.tasks.filter((r) => r.verdict === "merged").length, 1);
});

T("runtime usageBudget rejection: terminal, no retry, no ladder, partial with reason", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: boom("usage budget exhausted (hard): child launch rejected"),
    review: ok(reviewOk(false)),
    arbiter: ok(arbOut("drop-branch", "n")),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ modelLadder: ["m-b"], reworkLimit: 0 }), runs, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.count(K.work), 1, "budget rejection is terminal: no transport retry, no ladder step");
  assert.ok(/budget exhausted/.test(out.res.stopReason), "stopReason surfaces the token budget: " + out.res.stopReason);
  assert.equal(out.res.status, "partial", "budget stop with accounted tasks is partial");
});

T("budget classification beats transport look-alikes", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: boom("fetch failed: budget_exhausted for child launch"),
    review: ok(reviewOk(false)),
    arbiter: ok(arbOut("drop-branch", "n")),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ modelLadder: ["m-b"], reworkLimit: 0 }), runs, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.count(K.work), 1, "dual-class message resolves to budget (terminal), not transport retry");
  assert.ok(/budget exhausted/.test(out.res.stopReason));
});

// --- no-code analysis deliverable: 'deliverable: analysis' in the leaf rationale (first 300 chars) ---
const analysisLeaf = (id, over = {}) => falconLeaf(id, Object.assign({
  rationale: "deliverable: analysis\nWrite the analysis report.", files_hint: ".ignored/report.md",
}, over));

T("no-code analysis leaf (marker in rationale, artifact in ignored path): work+review pass, empty diff not rejected, merged no-code with bd close and no git commit", async () => {
  const runs = tierRuns({ merge: ok(mergeOut({ merged: true, checks_ok: true, journal_written: true, merge_commit: "", bd_closed: true })) });
  const out = await runCampaign(tierArgs([analysisLeaf("analysis-a")]), runs, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(out.res.tasks[0].verdict, "merged");
  const work = runs.spec(K.work).spec.task;
  assert.match(work, /NO-CODE ANALYSIS DELIVERABLE/);
  assert.match(work, /NO-CODE EXCEPTION: do NOT commit/);
  assert.ok(!/Before finishing: commit all your changes/.test(work), "no commit instruction on the no-code path");
  const review = runs.spec(K.review).spec.task;
  assert.match(review, /an empty diff is expected, not a rejection/);
  assert.ok(review.includes(".ignored/report.md"), "review inspects the declared artifact");
  assert.ok(!/empty diff - the work never landed/.test(review), "empty-diff rejection disabled for the analysis leaf");
  const merge = runs.spec(K.merge).spec.task;
  assert.match(merge, /NO-CODE ANALYSIS MERGE/);
  assert.match(merge, /NO git commit is created/);
  assert.ok(!/merge-branch\.mjs/.test(merge), "the merge-branch CLI does not run on the no-code path");
  assert.match(merge, /bd close analysis-a /, "merger closes the bd leaf");
  assert.match(merge, /bd_closed/);
  assert.ok(out.res.log.some((l) => /merge bd-close closed analysis-a in bd/.test(l)), "bd close confirmed: " + JSON.stringify(out.res.log));
  assert.equal(runs.count(K.merge), 1, "exactly one no-code merge child");
});

T("no-code analysis: a missing artifact is rejected by the reviewer and the no-code merge never runs", async () => {
  const runs = tierRuns({ review: ok(reviewOk(false, { rework_reasons: "analysis artifact .ignored/report.md is missing in the worktree" })) });
  const out = await runCampaign(tierArgs([analysisLeaf("analysis-missing")]), runs, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.match(runs.spec(K.review).spec.task, /missing or irrelevant artifact -> approved=false/);
  assert.notEqual(out.res.tasks[0].verdict, "merged");
  assert.equal(runs.count(K.merge), 0, "no no-code merge without an approved artifact");
});

T("plain leaf with an empty diff keeps the empty-diff rejection and the merge-branch CLI (no marker)", async () => {
  const runs = tierRuns();
  const out = await runCampaign(tierArgs([falconLeaf("plain-a", { rationale: "Implement the plain change", files_hint: "" })]), runs, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(out.res.tasks[0].verdict, "merged");
  assert.ok(!/NO-CODE/.test(runs.spec(K.work).spec.task), "no no-code work brief without the marker");
  assert.match(runs.spec(K.review).spec.task, /empty diff - the work never landed on the branch/);
  assert.ok(!/NO-CODE/.test(runs.spec(K.review).spec.task));
  assert.match(runs.spec(K.merge).spec.task, /merge-branch\.mjs/);
  assert.ok(!/NO-CODE ANALYSIS MERGE/.test(runs.spec(K.merge).spec.task));
});

T("no-code marker past the first 300 chars of the description does not select the analysis path", async () => {
  const runs = tierRuns({ review: ok(reviewOk(false, { rework_reasons: "empty diff - the work never landed on the branch" })) });
  const late = "x".repeat(300) + "\ndeliverable: analysis";
  const out = await runCampaign(tierArgs([falconLeaf("late-a", { rationale: late, files_hint: "" })]), runs, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.ok(!/NO-CODE/.test(runs.spec(K.work).spec.task), "marker beyond 300 chars is ignored");
  assert.match(runs.spec(K.review).spec.task, /empty diff - the work never landed on the branch/);
  assert.equal(runs.count(K.merge), 0, "rejected empty diff is not merged");
});

// --- toy-falcon: FICTIONAL bd-epic federation fixtures (no real bd touched) ---
const falconLeaf = (id, over = {}) => Object.assign({
  id, title: "falcon: " + id, rationale: "why " + id, acceptance: "gate " + id,
  files_hint: "src/a.txt", deps: [], open: true,
}, over);

T("toy-falcon bd-epic: snapshot tasks, deps respected, curator/discovery skipped", async () => {
  let cursorCalls = 0;
  const routes = makeRuns([
    { match: K.work, handle: ok(workOut()) },
    { match: K.review, handle: ok(reviewOk()) },
    { match: K.merge, handle: ok(mergeOut()) },
    { match: K.boundary, handle: async () => {
        cursorCalls++;
        // call 1 (sprint 2 boundary): driver already closed A and C; B is still open
        // call 2 (sprint 3 boundary): driver closed B too -> doneWhen fires
        return cursorCalls === 1
          ? ok({ leaves: [falconLeaf("fal-a", { open: false }), falconLeaf("fal-b", { deps: ["fal-a"] }), falconLeaf("fal-c", { open: false })] })()
          : ok({ leaves: [falconLeaf("fal-a", { open: false }), falconLeaf("fal-b", { deps: ["fal-a"], open: false }), falconLeaf("fal-c", { open: false })] })();
      } },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 2, maxSprints: 3,
    bdTasks: [falconLeaf("fal-a"), falconLeaf("fal-b", { deps: ["fal-a"] }), falconLeaf("fal-c")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(routes.count(/-discovery$/), 0, "discovery skipped in bd-epic mode");
  assert.equal(routes.count(/-curator$/), 0, "curator skipped in bd-epic mode");
  const ids = out.res.tasks.map((r) => r.id).sort();
  assert.deepEqual(ids, ["fal-a", "fal-b", "fal-c"], "all three leaves executed");
  const b = out.res.tasks.find((r) => r.id === "fal-b");
  assert.equal(b.sprint, 2, "dep-gated leaf waits for sprint 2 (dep merged in sprint 1)");
  assert.equal(out.res.status, "completed");
  assert.equal(out.res.stopReason, "epic-closed");
});

T("toy-falcon sprint-1 start: args.bdTasks snapshot -> first child is work (NO initial boundary); empty snapshot -> boundary starts", async () => {
  // Driver pre-counts the mapping, so a campaign launched WITH a non-empty bdTasks
  // snapshot must go straight to sprint-1 work children (the initial boundary child
  // would only re-derive what args already carries); an EMPTY snapshot still starts
  // with the boundary child (it refreshes the snapshot). Sprints 2+ keep the boundary:
  // here sprint 2 launches exactly one boundary child after sprint 1 merged a leaf.
  const routes = makeRuns([
    { match: K.work, handle: ok(workOut()) },
    { match: K.review, handle: ok(reviewOk()) },
    { match: K.merge, handle: ok(mergeOut()) },
    { match: K.boundary, handle: ok({ leaves: [] }) },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 2, maxSprints: 2,
    bdTasks: [falconLeaf("fal-a")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  // the campaign-start report-schema writer (R1) precedes every sprint; it is not a sprint child
  const starts = out.events.filter((e) => e.t === "start" && !/^report-schema/.test(e.key) && !K.mainStatus.test(e.key)).map((e) => e.key);
  assert.ok(/^s1-t1-work$/.test(starts[0]), "with args.bdTasks the first launched child of sprint 1 is work: " + JSON.stringify(starts));
  assert.equal(starts.filter((k) => /^s1-boundary/.test(k)).length, 0, "no initial boundary/cursor child at sprint 1 on an args snapshot");
  assert.equal(routes.count(/^s2-boundary$/), 1, "sprint 2 boundary logic unchanged (janitor + refresh after a merge)");

  const routes2 = makeRuns([
    { match: K.work, handle: ok(workOut()) },
    { match: K.review, handle: ok(reviewOk()) },
    { match: K.merge, handle: ok(mergeOut()) },
    { match: K.boundary, handle: ok({ leaves: [falconLeaf("fal-a")] }) },
  ]);
  const out2 = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 2, maxSprints: 1, bdTasks: [],
  }), routes2, makeState());
  assert.ok(!out2.err, "workflow threw: " + (out2.err && out2.err.message));
  const starts2 = out2.events.filter((e) => e.t === "start" && !/^report-schema/.test(e.key) && !K.mainStatus.test(e.key)).map((e) => e.key);
  assert.ok(/^s1-boundary/.test(starts2[0]), "without a snapshot the initial boundary child starts sprint 1: " + JSON.stringify(starts2));
});

T("toy-falcon doneWhen: closed epic costs zero children", async () => {
  const routes = makeRuns([
    { match: K.work, handle: ok(workOut()) },
    { match: K.boundary, handle: boom("boundary must never launch") },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed", maxSprints: 2,
    bdTasks: [falconLeaf("fal-x", { open: false })],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(out.events.filter((e) => e.type === "start").length, 0, "zero child launches on a closed epic");
  assert.equal(out.res.status, "completed");
  assert.equal(out.res.stopReason, "epic-closed");
});

T("toy-falcon growth: bd-cursor refresh picks up a new leaf mid-campaign", async () => {
  let calls = 0;
  const routes = makeRuns([
    { match: K.work, handle: ok(workOut()) },
    { match: K.review, handle: ok(reviewOk()) },
    { match: K.merge, handle: ok(mergeOut()) },
    { match: K.boundary, handle: async () => {
        calls++;
        return calls === 1
          ? ok({ leaves: [falconLeaf("fal-a", { open: false }), falconLeaf("fal-g")] })()
          : ok({ leaves: [falconLeaf("fal-a", { open: false }), falconLeaf("fal-g", { open: false })] })();
      } },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 2, maxSprints: 3,
    bdTasks: [falconLeaf("fal-a")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const g = out.res.tasks.find((r) => r.id === "fal-g");
  assert.ok(g, "grown leaf executed");
  assert.equal(g.sprint, 2, "grown leaf picked up at the sprint-2 boundary");
  assert.equal(out.res.status, "completed");
  assert.equal(out.res.stopReason, "epic-closed");
});

T("toy-falcon stale cursor: merged leaves never re-run when snapshot lags the driver", async () => {
  let cursorCalls = 0;
  const routes = makeRuns([
    { match: K.finalClose, handle: ok({ cleaned: [], closed: [], leaves: [] }) },
    { match: K.work, handle: ok(workOut()) },
    { match: K.review, handle: ok(reviewOk()) },
    { match: K.merge, handle: ok(mergeOut()) },
    { match: K.boundary, handle: async () => {
        cursorCalls++;
        // call 1 (sprint 2): STALE - the driver has not closed fal-a/fal-c in bd
        // yet, although sprint 1 merged both. ready must exclude doneIds anyway.
        // call 2 (sprint 3): driver caught up -> all closed -> epic-closed.
        return cursorCalls === 1
          ? ok({ leaves: [falconLeaf("fal-a"), falconLeaf("fal-b", { deps: ["fal-a"] }), falconLeaf("fal-c")] })()
          : ok({ leaves: [falconLeaf("fal-a", { open: false }), falconLeaf("fal-b", { deps: ["fal-a"], open: false }), falconLeaf("fal-c", { open: false })] })();
      } },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 3, maxSprints: 4,
    bdTasks: [falconLeaf("fal-a"), falconLeaf("fal-b", { deps: ["fal-a"] }), falconLeaf("fal-c")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const ids = out.res.tasks.map((r) => r.id);
  assert.equal(ids.filter((x) => x === "fal-a").length, 1, "fal-a executed exactly once despite stale open snapshot");
  assert.equal(ids.filter((x) => x === "fal-c").length, 1, "fal-c executed exactly once despite stale open snapshot");
  assert.deepEqual([...ids].sort(), ["fal-a", "fal-b", "fal-c"]);
  assert.equal(cursorCalls, 2, "exactly two cursor refreshes (sprint 2 and 3 boundaries)");
  assert.equal(out.res.status, "completed");
  assert.equal(out.res.stopReason, "epic-closed");
});

T("toy-falcon end-race: last leaf merged but snapshot lags -> epic-closed, one extra cursor child", async () => {
  let cursorCalls = 0;
  const routes = makeRuns([
    { match: K.finalClose, handle: ok({ cleaned: [], closed: [], leaves: [] }) },
    { match: K.work, handle: ok(workOut()) },
    { match: K.review, handle: ok(reviewOk()) },
    { match: K.merge, handle: ok(mergeOut()) },
    { match: K.boundary, handle: async () => {
        cursorCalls++;
        // call 1 (sprint 2): honest - driver closed a and c, b is open.
        // call 2 (sprint 3): STILL lagging - b is open although sprint 2 merged it.
        // The strict pre-check lets the refresh through (growth discovery must not
        // be short-circuited), and the LOOSENED post-refresh check then closes the
        // epic: our merge verdict on b is evidence enough. Cost: one cursor child.
        return ok({ leaves: [falconLeaf("fal-a", { open: false }), falconLeaf("fal-b", { deps: ["fal-a"] }), falconLeaf("fal-c", { open: false })] })();
      } },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 3, maxSprints: 4,
    bdTasks: [falconLeaf("fal-a"), falconLeaf("fal-b", { deps: ["fal-a"] }), falconLeaf("fal-c")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const ids = out.res.tasks.map((r) => r.id);
  assert.deepEqual([...ids].sort(), ["fal-a", "fal-b", "fal-c"]);
  assert.equal(cursorCalls, 2, "strict pre-check admits the refresh; post-refresh check fires on the lagging snapshot");
  assert.equal(out.res.status, "completed", "end-of-campaign driver lag must not end as blocked/stalled");
  assert.equal(out.res.stopReason, "epic-closed");
});

T("toy-falcon empty sprint: sprint 1 all failed -> sprint 2 boundary is janitor-only, NO snapshot refresh, reuses the snapshot", async () => {
  const routes = makeRuns([
    { match: K.work, handle: ok(workOut({ completed: false })) },
    { match: K.boundary, handle: ok({ cleaned: [{ branch: "agile/falcon-fal-a", worktree: "../wt-t1-falcon-fal-a", removed: true, note: "gone" }], leaves: [] }) },
    { match: K.cleanup, handle: ok({ cleaned: [] }) },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 2,
    bdTasks: [falconLeaf("fal-a")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const bnd = routes.spec(/^s2-boundary$/);
  assert.ok(bnd, "sprint 2 boundary child still runs: it janitors sprint 1's leftover");
  assert.ok(!/bd list --parent/.test(bnd.spec.task), "0-merge sprint: boundary carries NO bd snapshot refresh");
  assert.ok(/NOT requested at this boundary/.test(bnd.spec.task), "refresh explicitly off in the boundary brief");
  assert.equal(routes.count(K.boundary), 1, "exactly one boundary child (sprint 2) - no cursor child of its own");
  assert.equal(routes.count(/^s2-t1-work/), 1, "the failed leaf is retried in sprint 2 from the reused snapshot");
  assert.ok(out.res.log.some((l) => /bd-cursor: skipped/.test(l)), "skip is logged: " + JSON.stringify(out.res.log));
  assert.ok(out.res.log.some((l) => /boundary cleanup removed 1\/1 leftover/.test(l)), "janitor result logged: " + JSON.stringify(out.res.log));
});

T("toy-falcon merge: sprint 1 merged a leaf -> sprint 2 launches the bd-cursor refresh", async () => {
  const routes = makeRuns([
    { match: K.work, handle: ok(workOut()) },
    { match: K.review, handle: ok(reviewOk()) },
    { match: K.merge, handle: ok(mergeOut()) },
    { match: K.boundary, handle: ok({ leaves: [falconLeaf("fal-a", { open: false }), falconLeaf("fal-b")] }) },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 3,
    bdTasks: [falconLeaf("fal-a")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(routes.count(/^s2-boundary$/), 1, "a sprint with >=1 merge refreshes the snapshot at the next boundary");
  const mb = routes.spec(/^s2-boundary$/);
  assert.ok(/bd list --parent/.test(mb.spec.task) && /bd show/.test(mb.spec.task), "refresh brief carries the exact bd commands");
  assert.equal(out.res.tasks.find((r) => r.id === "fal-b").sprint, 2, "leaf that arrives with the refresh runs in sprint 2");
});

// --- claim-dirt: bd-claim export must not block the merge/drop pre-flight ---------
// Headless viability (agents-92w djr): workers bd-claim leaves MID-sprint and the bd
// daemon re-exports .beads/issues.jsonl - a TRACKED file - into the MAIN tree. A
// pre-flight that refuses on it makes every merge fail (no driver exists to commit
// the dirt), so the leaf restarts from zero (qu2 s2 precedent: 14 min, 63k tokens).
// Contract: the merger/drop pre-flight AUTO-COMMITS exactly that one file with a
// mechanical chore(bd) message, then FAIL-SAFES (rework round 1): the allowed path
// must verify CLEAN before continuing - a failed add/commit is an explicit refusal
// (merged/dropped=false), never a blind `|| true` continue; any other dirt refuses.

T("claim-dirt: merge preflight auto-commits .beads/issues.jsonl instead of refusing; other dirt still refuses", async () => {
  const routes = happyRoutes({ curator: ok(curatorOut(true, [task(1)])) });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(out.res.tasks[0].verdict, "merged");
  const merge = runs.spec(K.merge).spec.task;
  assert.ok(/workflows\/merge-branch\.mjs/.test(merge), "merger delegates claim-dirt checks to CLI");
  assert.ok(/--test-command/.test(merge), "CLI receives the suite command alongside preflight inputs");
  assert.ok(/workflows\/merge-branch\.mjs/.test(merge), "CLI preflight owns claim-dirt failure handling");
});

T("claim-dirt: drop preflight carries the same exception (drop is blocked by the same porcelain)", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: ok(reviewOk(false)),
    arbiter: ok(arbOut("drop-branch", "not worth keeping")),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const drop = runs.spec(K.drop);
  assert.ok(drop, "drop child launched (review rejected, arbiter decided drop-branch)");
  assert.ok(/CLAIM-DIRT EXCEPTION/.test(drop.spec.task), "drop brief carries the claim-dirt exception");
  assert.ok(/git add \.beads\/issues\.jsonl/.test(drop.spec.task), "...with the exact auto-commit command");
  assert.ok(/git status --porcelain -- \.beads\/issues\.jsonl/.test(drop.spec.task), "...with the SAME fail-safe verify before proceeding");
  assert.ok(/dropped=false/.test(drop.spec.task), "any OTHER dirty path still refuses the drop");
});

// --- claim-dirt FAIL-SAFE: the failure path is a CONTRACT, not a substring ---------
// Rework round 1: the old rule said `|| true` + CONTINUE, so a failed auto-commit
// silently left .beads/issues.jsonl staged and the merge pre-flight blocked anyway.
// The new rule orders verify-then-continue; these tests drive the failure path
// BEHAVIORALLY: the child obeys the contract (path still dirty -> explicit refusal)
// and the workflow must land that refusal as merge-failed/drop-failed with NO retry
// loop that could hide it and NO merge.

T("claim-dirt FAIL-SAFE: merger reports the failure contract (auto-commit left the path dirty) -> merged=false lands as merge-failed, never merged, no retry hides it", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    merge: ok(mergeOut({ merged: false, checks_ok: false, journal_written: false, merge_commit: "", note: "claim-dirt auto-commit failed: .beads/issues.jsonl still dirty" })),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(out.res.tasks[0].verdict, "merge-failed", "a merged=false refusal is merge-failed, NOT merged");
  assert.equal(out.res.tasks[0].stop, "merge: merged/checks_ok not confirmed", "stop reason points at the unconfirmed merge, not a silent pass");
  assert.equal(runs.count(K.merge), 1, "exactly ONE merger launch: the refusal is terminal, no retry loop hides it");
  assert.equal(runs.count(K.arbiter), 0, "no arbiter detour: a failed claim-dirt auto-commit is not re-litigated");
  assert.equal(out.res.counts.merged, 0, "campaign merged 0 tasks");
  assert.equal(out.res.counts.failed, 1, "campaign counts the refused merge as failed");
  // the merger was TOLD the fail-safe order that produced this refusal
  const merge = runs.spec(K.merge).spec.task;
  assert.ok(/workflows\/merge-branch\.mjs/.test(merge), "CLI includes clean-path verify");
});

T("claim-dirt FAIL-SAFE: drop executor reports the same failure contract -> dropped=false lands as drop-failed, branch left for manual review", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: ok(reviewOk(false)),
    arbiter: ok(arbOut("drop-branch", "not worth keeping")),
    drop: ok(dropOut({ dropped: false, journal_written: false, note: "claim-dirt auto-commit failed: .beads/issues.jsonl still dirty" })),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(out.res.tasks[0].verdict, "drop-failed", "a dropped=false refusal is drop-failed, NOT dropped");
  assert.equal(runs.count(K.drop), 1, "exactly ONE drop launch: the refusal is terminal");
  assert.equal(out.res.counts.failed, 1, "campaign counts the refused drop as failed (drop-failed bucket)");
  assert.equal(out.res.counts.merged, 0, "nothing merged");
  const drop = runs.spec(K.drop).spec.task;
  assert.ok(/git status --porcelain -- \.beads\/issues\.jsonl` must print NOTHING/.test(drop), "drop brief orders the explicit clean-path verify before continuing");
  assert.ok(/note='claim-dirt auto-commit failed: \.beads\/issues\.jsonl still dirty'/.test(drop), "drop brief prescribes the exact refusal note the executor replied with");
});

// --- merge-child hard failure: catch-wrap resolves merged=false, campaign continues -
// A merger child that dies without any report (engine crash, non-retryable child
// failure such as a git identity error) must NOT abort the campaign: the catch-wrap
// in doMerge resolves the merge merged=false (verdict merge-failed), keeps mergeChain
// healthy for the next merge and lets every sibling task finish.

T("merge child hard failure -> merged=false (verdict merge-failed), sibling still merges, campaign completes", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1), task(2)])),
    merge: async (spec, key) => (key.includes("t1-merge") ? fail("fatal: unable to auto-detect email") : ok(mergeOut()))(),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(out.res.done, true, "the campaign COMPLETES - a dead merger never aborts it");
  const verdicts = out.res.tasks.map((t) => t.verdict).sort();
  assert.deepEqual(verdicts, ["merge-failed", "merged"], "the hard failure resolves merged=false; the sibling is unaffected: " + JSON.stringify(out.res.tasks.map((t) => [t.branch, t.verdict, t.stop])));
  assert.equal(out.res.counts.merged, 1, "exactly the sibling merged");
  assert.equal(out.res.counts.failed, 1, "the hard failure lands in the failed bucket");
  const failed = out.res.tasks.find((t) => t.verdict === "merge-failed");
  assert.equal(failed.stop, "merge: merger child failed", "the failure carries an explicit stop reason, not a silent pass");
  assert.ok(out.res.log.some((l) => /merger failed/.test(l) && /unable to auto-detect email/.test(l)), "the failure is logged loudly with its cause: " + JSON.stringify(out.res.log.filter((l) => /merge/.test(l))));
  assert.equal(runs.count(K.merge), 2, "each task ran its own merger (a poisoned chain would silently no-op the second)");
});

// --- stale PLANNED markers: docs must describe implemented behavior ----------------
// Criterion: zero stale PLANNED markers in agile-loop.js and SKILL.md (the r1
// regression: a comment claimed the circuit breaker was "not in code yet" while the
// breaker was live). Mechanical pin: the workflow source carries none of the stale
// phrases at all; SKILL.md may carry them ONLY inside the one section that defines
// the bd-leaf doc-vs-code marker convention (## Маркер PLANNED), where the phrase
// QUOTES the marker format for bd leaves - it does not describe this skill.
const STALE_PLANNED = [
  /not in code yet/i,
  /not yet implemented/i,
  /not implemented yet/i,
  /\bPLANNED:\s/, // case-sensitive: the campaign result field `planned:` is data, not a marker
  /в коде пока нет/i,
  /пока не реализован/i,
];
T("no stale PLANNED markers: agile-loop.js and SKILL.md describe only implemented behavior", async () => {
  for (const re of STALE_PLANNED) {
    assert.ok(!re.test(WORKFLOW_SRC), "stale PLANNED marker in agile-loop.js: " + re);
  }
  assert.ok(/circuit breaker per model \(implemented/.test(WORKFLOW_SRC), "the circuit breaker is pinned as implemented (the r1 regression)");
  const skillPath = pathMod.join(pathMod.dirname(fileURLToPath(import.meta.url)), "..", "skills", "agile-solve", "SKILL.md");
  const skill = fsSync.readFileSync(skillPath, "utf8");
  const convention = skill.match(/## Маркер PLANNED[\s\S]*?(?=\n## |$)/);
  const skillRest = convention ? skill.replace(convention[0], "") : skill;
  for (const re of STALE_PLANNED) {
    assert.ok(!re.test(skillRest), "stale PLANNED marker in SKILL.md (outside the marker-convention section): " + re);
  }
});
// --- `|| true` ban + explicit git-mutation failure across EVERY brief family -------
// Criterion: zero `|| true` on git mutations in GENERATED briefs; a failed git
// mutation surfaces (refusal or explicit report), never a silent continue. One
// bd-epic campaign generates every family: work, review, merge (with the 4.6
// bd-close), arbiter, drop, boundary janitor+refresh, final-bd-close,
// final-cleanup, analytics.

T("no `|| true` on ANY git command in ANY generated brief; bd-close/janitor git failures are explicit", async () => {
  const routes = makeRuns([
    { match: /^s1-t1-review/, handle: ok(reviewOk(true)) },
    { match: /-review$/, handle: ok(reviewOk(false)) },
    { match: /-arbiter$/, handle: ok(arbOut("drop-branch", "not worth keeping")) },
    { match: /^s1-t1-merge$/, handle: ok(mergeOut({ merge_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", bd_closed: false, note: "bd export commit failed: .beads/issues.jsonl still dirty" })) },
    { match: /-drop$/, handle: ok(dropOut()) },
    { match: /^s\d-boundary$/, handle: ok({ cleaned: [], leaves: [falconLeaf("fal-c")] }) },
    { match: /^final-bd-close/, handle: ok({ cleaned: [], closed: [{ id: "fal-a", closed: true, note: "closed" }], leaves: [] }) },
    { match: /^final-cleanup/, handle: ok({ cleaned: [] }) },
    { match: /-work/, handle: ok(workOut()) },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1",
    sprintTasks: 2, maxSprints: 2, reworkLimit: 0,
    bdTasks: [falconLeaf("fal-a"), falconLeaf("fal-b")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  // every brief family is actually generated by this campaign
  assert.ok(routes.spec(/^s1-t1-merge$/), "merge child launched");
  assert.ok(routes.spec(/-drop$/), "drop child launched");
  assert.ok(routes.spec(/^s\d-boundary$/), "boundary child launched (janitor + refresh)");
  assert.ok(routes.spec(/^final-bd-close/), "post-loop bd-close launched (merger's close was unconfirmed)");
  assert.ok(routes.spec(/^final-cleanup/), "final cleanup launched (dropped leftovers)");
  for (const [key, spec] of routes.specs) {
    if (spec && typeof spec.task === "string") {
      assert.ok(!GIT_MUTATION_SILENT.test(spec.task), "brief " + key + " hides a git mutation behind `|| true`");
    }
  }
  // bd-close (merge child 4.6): export flushed -> one-file commit WITHOUT || true ->
  // clean-path verify AFTER the commit -> explicit bd_closed=false on failure
  const mg = routes.spec(/^s1-t1-merge$/).spec.task;
  const at = (s) => mg.indexOf(s);
  const closeCommit = "git add .beads/issues.jsonl && git commit -m \"chore(bd): auto-close done leaf"; // unique to the (4.6) close step
  assert.ok(/workflows\/merge-branch\.mjs/.test(mg), "CLI handles bd close, export, and export commit");
  assert.ok(out.res.log.some((l) => /merge bd-close not confirmed/.test(l) && /bd export commit failed/.test(l)), "the unconfirmed close (export commit failed) is logged: " + JSON.stringify(out.res.log.filter((l) => /bd-close/.test(l))));
  assert.equal(routes.count(K.finalClose), 1, "the unconfirmed close is retried by exactly one post-loop child");
  // post-loop close: same explicit-failure contract
  const fb = routes.spec(/^final-bd-close/).spec.task;
  assert.ok(/every closed\[\] entry of this run gets closed=false with note='export commit failed: \.beads\/issues\.jsonl still dirty'/.test(fb), "post-loop close reports a failed export commit explicitly");
  // janitor briefs (boundary + final cleanup): bare commands, failure must surface
  const bnd = routes.spec(/^s\d-boundary$/).spec.task;
  assert.ok(/git worktree remove --force "<worktree>"/.test(bnd) && /ALREADY GONE/.test(bnd) && /FULL error text in note/.test(bnd), "boundary janitor: bare commands, missing target = fine, real failure surfaces in note");
  const fc = routes.spec(/^final-cleanup/).spec.task;
  assert.ok(/ALREADY GONE/.test(fc) && /FULL error text in note/.test(fc), "final cleanup carries the same explicit-failure contract");
});

// --- stale doc-vs-code markers ----------------------------------------------------
// Criterion: zero stale PLANNED markers in agile-loop.js and SKILL.md - the circuit
// breaker, single-model degradation and review tiers are LIVE implementations; a doc
// that calls them 'not in code yet' manufactures false decisions.

T("stale PLANNED markers are gone from agile-loop.js and SKILL.md (doc matches live code)", () => {
  assert.ok(!WORKFLOW_SRC.includes("PLANNED"), "no PLANNED marker left in the workflow source");
  assert.ok(!WORKFLOW_SRC.includes("not in code yet"), "no 'not in code yet' drift left in the workflow source");
  const skill = fsSync.readFileSync(pathMod.join(pathMod.dirname(fileURLToPath(import.meta.url)), "..", "skills", "agile-solve", "SKILL.md"), "utf8");
  assert.ok(!/not in code yet/.test(skill), "no 'not in code yet' marker in SKILL.md");
  assert.ok(!/ПЛАНИРУЕТСЯ \(agents-7fe\.1\)/.test(skill), "review tiers are IMPLEMENTED (REVIEW_TIERS + tier routing) - the matrix row must not call them planned");
  assert.ok(!/ПЛАНИРУЕТСЯ - реализуется листом agents-u26\.4/.test(skill) && !/в коде пока НЕТ: сейчас/.test(skill), "single-model degradation is IMPLEMENTED (preflight warn + cross-model degraded) - no stale doc-vs-code marker");
  assert.ok(!/сейчас префлайт бросает ошибку/.test(skill), "the preflight does NOT throw on colliding models anymore - the doc must not claim it does");
  // A stale ПЛАНИРУЕТСЯ marker names a CONCRETE leaf; the convention section quotes the
  // format with the literal '<id>' placeholder - only a concrete id is a violation.
  assert.ok(!/ПЛАНИРУЕТСЯ/.test(WORKFLOW_SRC), "no ПЛАНИРУЕТСЯ marker in the workflow source");
  for (const m of skill.matchAll(/ПЛАНИРУЕТСЯ - реализуется листом (\S+)/g)) {
    assert.equal(m[1], "<id>", "SKILL.md carries a stale ПЛАНИРУЕТСЯ marker naming leaf " + m[1]);
  }
});

// --- bd-close: the MERGER closes the leaf it just merged (best-effort, exactly-once) --
// perf (ys9/wave-2): boundary children burned 1.5-4 min per boundary on bd-close - the
// merger is already in the main tree right after the merge. Mechanical close comment:
// leaf id, merge commit, short verdict; .beads/issues.jsonl exported and committed right
// away (the NEXT merge pre-flight requires a clean porcelain); already-closed leaves
// skipped via the grep guard; only a CONFIRMED close marks bdClosedIds (exactly-once);
// the boundary child carries NO bd-close anymore (janitor + cursor only).

T("toy-falcon bd-close: the MERGER closes the merged leaf in bd (close steps in the merge spec, log records it); boundary carries NO bd-close; no post-loop re-close", async () => {
  let boundaries = 0;
  const routes = makeRuns([
    { match: K.work, handle: ok(workOut()) },
    { match: K.review, handle: ok(reviewOk()) },
    { match: K.merge, handle: ok(mergeOut({ merge_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })) },
    { match: K.boundary, handle: async () => {
        boundaries++;
        return ok({ cleaned: [], leaves: [falconLeaf("fal-a", { open: false })] })();
      } },
    { match: /^epic-close$/, handle: ok({ cleaned: [], closed: [{ id: "t-fal.1", closed: true }], leaves: [] }) },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 3,
    bdTasks: [falconLeaf("fal-a")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(out.res.status, "completed");
  assert.equal(out.res.stopReason, "epic-closed", "headless: our own closes complete the epic");
  assert.equal(out.res.tasks.find((r) => r.id === "fal-a").verdict, "merged");
  const mg = routes.spec(K.merge);
  assert.ok(mg, "merger launched");
  assert.ok(/--bd-leaf/.test(mg.spec.task), "open leaf is passed to deterministic bd handling");
  assert.ok(/workflows\/merge-branch\.mjs/.test(mg.spec.task), "CLI handles closed-leaf pre-check");
  assert.ok(/--bd-leaf/.test(mg.spec.task), "CLI handles bd export and close lifecycle");
  assert.ok(/bd_closed/.test(mg.spec.task), "the merger reports bd_closed for exactly-once bookkeeping");
  assert.ok(/--bd-leaf/.test(mg.spec.task), "CLI processes optional bd close best-effort");
  const mergerSource = fsSync.readFileSync(new URL("../workflows/merge-branch.mjs", import.meta.url), "utf8");
  assert.ok(/check-ignore/.test(mergerSource) && /ls-files.*error-unmatch/.test(mergerSource), "CLI detects ignored and untracked stealth-bd state");
  assert.ok(out.res.log.some((l) => /merge bd-close closed fal-a/.test(l)), "the close is recorded in the campaign log: " + JSON.stringify(out.res.log.filter((l) => /bd-close/.test(l))));
  const bnd = routes.spec(/^s2-boundary$/);
  assert.ok(bnd, "sprint-2 boundary still launches (snapshot refresh after a merge)");
  assert.ok(!/bd close /.test(bnd.spec.task), "boundary spec contains NO bd-close");
  assert.ok(!/PART 2 - BD CLOSE/.test(bnd.spec.task), "boundary brief has no BD CLOSE section");
  assert.ok(out.res.log.some((l) => /bd epic-close confirmed t-fal\.1/.test(l)), "engine confirms epic closure after leaf closure");
  const epicClose = routes.spec(/^epic-close$/);
  assert.ok(epicClose && /bd close t-fal\.1/.test(epicClose.spec.task), "epic-closed scenario invokes bd close for the epic");
  assert.ok(/check-ignore/.test(epicClose.spec.task) && /ls-files --error-unmatch/.test(epicClose.spec.task), "epic export follows actual stealth-bd state");
  assert.equal(routes.count(K.finalClose), 0, "exactly-once: the merger's confirmed close means NO post-loop re-close");
  assert.equal(boundaries, 1, "exactly one boundary child: the sprint-2 refresh fires epic-closed, nothing else launches");
});

T("toy-falcon bd-close: exactly-once across a multi-merge campaign - each merger closes its own leaf, no close is ever repeated", async () => {
  const routes = makeRuns([
    { match: K.work, handle: ok(workOut()) },
    { match: K.review, handle: ok(reviewOk()) },
    { match: /^s1-t1-merge/, handle: ok(mergeOut({ merge_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })) },
    { match: /^s2-t1-merge/, handle: ok(mergeOut({ merge_commit: "cccccccccccccccccccccccccccccccccccccccc" })) },
    { match: K.boundary, handle: async (spec, key) => key.startsWith("s2")
        ? ok({ cleaned: [], leaves: [falconLeaf("fal-a", { open: false }), falconLeaf("fal-b")] })()
        : ok({ cleaned: [], leaves: [falconLeaf("fal-a", { open: false }), falconLeaf("fal-b", { open: false })] })() },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 3,
    bdTasks: [falconLeaf("fal-a")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(out.res.stopReason, "epic-closed");
  const s1m = routes.spec(/^s1-t1-merge/);
  assert.ok(s1m && /--bd-leaf/.test(s1m.spec.task), "sprint-1 merger passes open fal-a to CLI");
  const s2m = routes.spec(/^s2-t1-merge/);
  assert.ok(s2m && /--bd-leaf/.test(s2m.spec.task), "sprint-2 merger passes open fal-b to CLI");
  const s2b = routes.spec(/^s2-boundary$/);
  const s3b = routes.spec(/^s3-boundary$/);
  assert.ok(s2b && s3b, "both boundaries launched (snapshot refresh)");
  assert.ok(!/bd close /.test(s2b.spec.task) && !/bd close /.test(s3b.spec.task), "NO boundary ever carries a bd close");
  assert.equal(routes.count(K.finalClose), 0, "exactly-once: both closes confirmed by the mergers - no post-loop re-close");
  assert.ok(out.res.log.some((l) => /merge bd-close closed fal-a/.test(l)) && out.res.log.some((l) => /merge bd-close closed fal-b/.test(l)), "both closes recorded in the log");
});

T("toy-falcon bd-close: failed leaf is never closed - boundary runs as janitor only, NO close section", async () => {
  // the leaf was rejected - bd must NOT be closed by us; the boundary
  // child still runs (janitor for the leftover) but carries NO close section.
  const routesF = makeRuns([
    { match: K.work, handle: ok(workOut({ completed: false })) },
    { match: K.boundary, handle: ok({ cleaned: [{ branch: "agile/falcon-fal-a", worktree: "../wt-t1-falcon-fal-a", removed: true, note: "gone" }], leaves: [] }) },
    { match: K.cleanup, handle: ok({ cleaned: [] }) },
  ]);
  const outF = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 2,
    bdTasks: [falconLeaf("fal-a")],
  }), routesF, makeState());
  assert.ok(!outF.err, "workflow threw: " + (outF.err && outF.message));
  const bndF = routesF.spec(/^s2-boundary$/);
  assert.ok(bndF, "failed leaf: boundary runs as the janitor");
  assert.ok(!/PART 2 - BD CLOSE/.test(bndF.spec.task), "failed verdict: NO bd-close section");
  assert.ok(!/bd close /.test(bndF.spec.task), "failed verdict is never closed in bd");
  assert.equal(outF.res.tasks.find((r) => r.id === "fal-a").verdict, "failed");
});

T("toy-falcon bd-close: merger bd-close failure does not sink the merge - verdict merged stands, failure logged, the post-loop child retries", async () => {
  const routes = makeRuns([
    { match: K.work, handle: ok(workOut()) },
    { match: K.review, handle: ok(reviewOk()) },
    { match: K.merge, handle: ok(mergeOut({ merge_commit: "cccccccccccccccccccccccccccccccccccccccc", bd_closed: false, note: "bd unavailable" })) },
    { match: K.boundary, handle: boom("bd unavailable") },
    { match: K.finalClose, handle: ok({ cleaned: [], closed: [{ id: "fal-a", closed: true, note: "closed" }], leaves: [] }) },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 3,
    bdTasks: [falconLeaf("fal-a")],
  }), routes, makeState());
  assert.ok(!out.err, "a failed merger bd-close must not throw: " + (out.err && out.err.message));
  assert.equal(out.res.status, "completed");
  assert.equal(out.res.tasks.find((r) => r.id === "fal-a").verdict, "merged", "the merge verdict stands; the leaf can be closed post-hoc");
  assert.ok(out.res.log.some((l) => /merge bd-close not confirmed /.test(l) && /bd unavailable/.test(l)), "close failure logged with the merger's note: " + JSON.stringify(out.res.log.filter((l) => /bd-close/.test(l))));
  assert.equal(routes.count(K.finalClose), 1, "the unconfirmed close is retried by exactly one post-loop child (no retry storm)");
  assert.ok(/bd close fal-a -r .*cccccccccccccccccccccccccccccccccccccccc/.test(routes.spec(K.finalClose).spec.task), "post-loop close carries the merge commit");
  assert.ok(out.res.log.some((l) => /post-loop: bd-close closed 1\/1/.test(l)), "post-loop close logged");
});

// POST-LOOP bd-close (agents-qu2.1 residual a): mergers close their own merges eagerly,
// but a close can fail or go unreported (best-effort).
// One mechanical child closes whatever is still pending after the loop, whatever the
// stopReason - otherwise the LAST sprint's done leaves would stay open in bd forever.
T("toy-falcon bd-close post-loop: the last sprint's merge is closed before return when the merger's bd-close failed and maxSprints ends the campaign", async () => {
  const routes = makeRuns([
    { match: K.work, handle: ok(workOut()) },
    { match: K.review, handle: ok(reviewOk()) },
    { match: K.merge, handle: ok(mergeOut({ merge_commit: "dddddddddddddddddddddddddddddddddddddddd", bd_closed: false, note: "bd unavailable" })) },
    { match: K.finalClose, handle: ok({ cleaned: [], closed: [{ id: "fal-a", closed: true, note: "closed" }], leaves: [] }) },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 1,
    bdTasks: [falconLeaf("fal-a")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(out.res.stopReason, "max-sprints reached", "the loop ends with NO next-sprint boundary");
  assert.ok(out.res.log.some((l) => /merge bd-close not confirmed/.test(l)), "the unconfirmed merger close is logged: " + JSON.stringify(out.res.log.filter((l) => /bd-close/.test(l))));
  assert.equal(routes.count(/^s2-boundary$/), 0, "no sprint-2 boundary exists to close the merge");
  const fin = routes.spec(K.finalClose);
  assert.ok(fin, "post-loop bd-close child launched: " + JSON.stringify(routes.keys()));
  assert.ok(/bd close fal-a -r /.test(fin.spec.task) && /merged/.test(fin.spec.task), "the last sprint's merged leaf is in the close list");
  assert.ok(/PART 2 - BD CLOSE/.test(fin.spec.task), "the post-loop child is the mechanical bd-close section");
  assert.ok(/check-ignore/.test(fin.spec.task) && /export=stealth/.test(fin.spec.task), "PART 2 carries the stealth-bd guard: probe check-ignore/ls-files BEFORE export, skip add/commit when ignored or untracked");
  assert.ok(!/bd list --parent/.test(fin.spec.task), "post-loop close carries NO snapshot refresh");
  assert.ok(out.res.log.some((l) => /post-loop: bd-close closed 1\/1/.test(l)), "post-loop close logged: " + JSON.stringify(out.res.log));
  const lastRun = routes.events.filter((e) => e.t === "ok").pop();
  assert.ok(lastRun && (K.finalClose.test(lastRun.key) || K.analytics.test(lastRun.key)), "the close finishes before the workflow returns (only the best-effort analytics archiver may follow it): " + JSON.stringify(lastRun));
});

T("toy-falcon bd-close post-loop: a failed final close is logged, never thrown, and the merge verdict stands", async () => {
  const routes = makeRuns([
    { match: K.work, handle: ok(workOut()) },
    { match: K.review, handle: ok(reviewOk()) },
    { match: K.merge, handle: ok(mergeOut({ merge_commit: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", bd_closed: false, note: "bd unavailable" })) },
    { match: K.finalClose, handle: boom("bd unavailable") },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 1,
    bdTasks: [falconLeaf("fal-a")],
  }), routes, makeState());
  assert.ok(!out.err, "a failed post-loop close must not throw: " + (out.err && out.err.message));
  assert.equal(routes.count(K.finalClose), 1, "exactly one post-loop attempt (no retry storm)");
  assert.ok(out.res.log.some((l) => /post-loop: bd-close child failed .*stay open in bd/.test(l)), "failure logged: " + JSON.stringify(out.res.log.filter((l) => /post-loop/.test(l))));
  assert.equal(out.res.tasks.find((r) => r.id === "fal-a").verdict, "merged", "the merge verdict stands");
});

T("toy-falcon bd-close post-loop: epic-closed reached while the merger's bd-close failed (and the boundary errored) -> the post-loop child closes the merged leaf before return", async () => {
  const routes = makeRuns([
    { match: K.work, handle: ok(workOut()) },
    { match: K.review, handle: ok(reviewOk()) },
    { match: K.merge, handle: ok(mergeOut({ merge_commit: "1234567890123456789012345678901234567890", bd_closed: false, note: "bd unavailable" })) },
    { match: K.boundary, handle: boom("bd unavailable") },
    { match: K.finalClose, handle: ok({ cleaned: [], closed: [{ id: "fal-a", closed: true, note: "closed" }], leaves: [] }) },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 3,
    bdTasks: [falconLeaf("fal-a")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(out.res.stopReason, "epic-closed", "the merged leaf is done for the campaign even though bd still shows it open");
  assert.equal(routes.count(K.finalClose), 1, "one post-loop close for the leaf whose merger close was never confirmed");
  assert.ok(/bd close fal-a -r .*1234567890123456789012345678901234567890/.test(routes.spec(K.finalClose).spec.task), "post-loop close carries the merge commit");
  assert.ok(out.res.log.some((l) => /post-loop: bd-close closed 1\/1/.test(l)), "post-loop close logged");
});

T("toy-falcon bd-close post-loop: nothing pending after the merger closed everything -> NO post-loop child (epic-closed path unchanged)", async () => {
  const routes = makeRuns([
    { match: K.work, handle: ok(workOut()) },
    { match: K.review, handle: ok(reviewOk()) },
    { match: K.merge, handle: ok(mergeOut({ merge_commit: "ffffffffffffffffffffffffffffffffffffffff" })) },
    { match: K.boundary, handle: ok({ cleaned: [], leaves: [falconLeaf("fal-a", { open: false })] }) },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 3,
    bdTasks: [falconLeaf("fal-a")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(out.res.stopReason, "epic-closed");
  assert.equal(routes.count(K.finalClose), 0, "the merger already confirmed the close: no post-loop child (exactly-once)");
  assert.ok(out.res.log.some((l) => /merge bd-close closed fal-a/.test(l)), "merger close logged");
  assert.ok(out.res.log.every((l) => !/sprint 2: bd-close closed/.test(l)), "the boundary no longer logs any bd-close");
});

// --- mergeApproval: who authorizes each merge commit ------------------------------
// bd-epic/headless viability: merge children asking the supervisor hang headless
// federations (pi -p / goal-x non-interactive). 'auto' (default in bd-epic mode)
// commits on converged mechanical evidence; curator mode keeps the question.

const falconRoutes = () => makeRuns([
  { match: K.work, handle: ok(workOut()) },
  { match: K.review, handle: ok(reviewOk()) },
  { match: K.merge, handle: ok(mergeOut()) },
]);

T("mergeApproval: bd-epic default is auto - merger commits on converged mechanical evidence, NO supervisor round", async () => {
  const routes = falconRoutes();
  const out = await runCampaign(baseArgs({
    mergePolicy: undefined, // prove the DEFAULT, not the legacy mergePolicy switch
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 1,
    bdTasks: [falconLeaf("fal-a")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const mg = routes.spec(K.merge);
  assert.ok(mg, "merge child launched");
  assert.ok(/workflows\/merge-branch\.mjs/.test(mg.spec.task), "CLI runs deterministic checks and squash");
  assert.ok(!mg.spec.task.includes("contact_supervisor"), "NO supervisor round anywhere in the merge brief (headless viability)");
  assert.equal(out.res.tasks.find((r) => r.id === "fal-a").verdict, "merged", "evidence-converged merge lands");
  assert.ok(out.res.log.some((l) => /mergeApproval: auto/.test(l)), "campaign log names the mode: " + JSON.stringify(out.res.log.filter((l) => /mergeApproval/.test(l))));
});

T("mergeApproval: curator default is confirm - the supervisor merge-approval question stays", async () => {
  const routes = happyRoutes({ curator: ok(curatorOut(true, [task(1)])) });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ mergePolicy: undefined }), runs); // pure defaults
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const mg = runs.spec(K.merge);
  assert.ok(mg, "merge child launched");
  assert.ok(/workflows\/merge-branch\.mjs/.test(mg.spec.task), "curator mode invokes deterministic CLI");
  assert.match(mg.spec.task, /contact_supervisor \(reason: "merge approval"\)/, "confirm mode keeps the supervisor approval gate");
  assert.match(mg.spec.task, /git diff --stat .*\.\.\./, "approval presents the proposed diff stat");
  assert.match(mg.spec.task, /full checks with/, "approval presents the full check result before CLI commits");
  assert.ok(out.res.log.some((l) => /mergeApproval: confirm/.test(l)), "campaign log names the mode: " + JSON.stringify(out.res.log.filter((l) => /mergeApproval/.test(l))));
});

T("mergeApproval: explicit args win over the mode defaults both ways; legacy mergePolicy auto still implies auto", async () => {
  // explicit confirm in bd-epic restores the question
  const routesC = falconRoutes();
  const outC = await runCampaign(baseArgs({
    mergePolicy: undefined, mergeApproval: "confirm",
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 1,
    bdTasks: [falconLeaf("fal-a")],
  }), routesC, makeState());
  assert.ok(!outC.err, "workflow threw: " + (outC.err && outC.err.message));
  assert.ok(/workflows\/merge-branch\.mjs/.test(routesC.spec(K.merge).spec.task), "explicit confirm mode still invokes CLI");
  // explicit auto in curator mode drops the question
  const runsA = makeRuns(happyRoutes({ curator: ok(curatorOut(true, [task(1)])) }));
  const outA = await runCampaign(baseArgs({ mergeApproval: "auto" }), runsA);
  assert.ok(!outA.err, "workflow threw: " + (outA.err && outA.err.message));
  const mgA = runsA.spec(K.merge);
  assert.ok(/workflows\/merge-branch\.mjs/.test(mgA.spec.task) && !mgA.spec.task.includes("contact_supervisor"), "explicit mergeApproval=auto invokes CLI without a supervisor round");
  // legacy mergePolicy:'auto' (baseArgs default) keeps implying auto in curator mode
  const runsM = makeRuns(happyRoutes({ curator: ok(curatorOut(true, [task(1)])) }));
  const outM = await runCampaign(baseArgs(), runsM);
  assert.ok(!outM.err, "workflow threw: " + (outM.err && outM.err.message));
  assert.ok(/workflows\/merge-branch\.mjs/.test(runsM.spec(K.merge).spec.task), "legacy auto config still invokes the CLI");
});

T("contract: work-class brief teaches the structured-output acceptance contract (fence gone, rp-schema)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../workflows/agile-loop.js", import.meta.url), "utf8");
  // rp-schema: the structured output IS the acceptance report; the manual fence was
  // the duplicate channel that produced every salvage of both live campaigns.
  assert.ok(!src.includes("```acceptance_report"), "no fence template anywhere in the source (the report channel is the structured output)");
  const i = src.indexOf("const ACC_STRUCTURED");
  assert.ok(i > 0, "ACC_STRUCTURED brief present");
  const seg = src.slice(i, i + 2600);
  assert.ok(seg.includes('\\"passed\\"'), "brief demonstrates the enum value passed");
  assert.ok(seg.includes("NEVER"), "brief explicitly forbids free-text result values (live: workers copied result:'exit 0' from the old brief example)");
  assert.ok(seg.includes("criterion-1") && seg.includes("criterion-2"), "brief teaches the exact criterion ids");
  assert.ok(seg.includes("schema-missing"), "brief names the semantic rejection class (salvage-eligible)");
  assert.ok(seg.includes("40-hex") && seg.includes("git rev-parse HEAD"), "brief pins the head contract to the real rev-parse");
  const workRuns = makeRuns(happyRoutes({ curator: ok(curatorOut(true, [task(1)])) }));
  const workOut2 = await runCampaign(baseArgs(), workRuns);
  assert.ok(!workOut2.err, "workflow threw: " + (workOut2.err && workOut2.err.message));
  const workTask = workRuns.spec(K.work).spec.task;
  assert.ok(workTask.includes("FINAL REPORT:"), "FINAL REPORT MARKER stays in the work brief");
  assert.ok(!workTask.includes("END your final message with exactly this fence"), "work brief no longer orders a fence");
  assert.ok(/final message is a free-text summary/.test(workTask), "work brief says the final message is a free summary");
});

T("contract: schema-valid structured output WITHOUT any fence is accepted end-to-end; reviewer brief carries the fresh head", async () => {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const routes = happyRoutes({ curator: ok(curatorOut(true, [task(1)])), work: ok(workOut({ head })) });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const spec = runs.spec(K.work).spec;
  assert.equal(spec.acceptance, false, "acceptance:false (boundary precedent): the host requires NO fenced report");
  assert.equal(runs.count(K.reportRepair), 0, "a valid schema report is accepted with zero salvage children");
  assert.ok(!/END your final message with exactly this fence/.test(spec.task), "no fence instruction in the work brief");
  assert.ok(spec.task.includes("npm test"), "the gate command STAYS in the brief (worker self-verifies)");
  const review = runs.spec(K.review).spec.task;
  assert.ok(review.includes(head), "reviewer brief carries the structured-output head (fresh head, no 'branch head moved')");
  assert.equal(runs.spec(K.merge).spec.task.includes(head), true, "merge verifies the reported head");
  assert.equal(out.res.tasks[0].verdict, "merged");
});

T("contract: WORK_SCHEMA carries the acceptance fields (head/testsAddedOrUpdated/commandsRun/validationOutput/residualRisks/noStagedFiles/criteriaSatisfied)", async () => {
  const routes = happyRoutes({ curator: ok(curatorOut(true, [task(1)])) });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const sch = runs.spec(K.work).spec.outputSchema;
  for (const f of ["head", "testsAddedOrUpdated", "commandsRun", "validationOutput", "residualRisks", "noStagedFiles", "criteriaSatisfied"]) {
    assert.ok(sch.required.includes(f), "required: " + f);
    assert.ok(sch.properties[f], "property: " + f);
  }
  assert.equal(sch.properties.head.pattern, "^[0-9a-f]{40}$", "head pattern pins 40-hex: no empty head exists (verdict-only leaves are gone)");
  assert.deepEqual(sch.properties.commandsRun.items.properties.result.enum, ["passed", "failed", "not-run"], "result enum matches the host report contract");
  assert.equal(sch.properties.commandsRun.minItems, 1, "commandsRun non-empty (a verified report has at least the gate run)");
  assert.equal(sch.properties.validationOutput.minItems, 1, "validationOutput non-empty");
  assert.equal(sch.properties.noStagedFiles.type, "boolean", "noStagedFiles is a boolean (R1: an honest false is a valid report)");
  assert.equal(sch.properties.noStagedFiles.const, undefined, "noStagedFiles carries NO forced const");
  assert.equal(sch.properties.criteriaSatisfied.minItems, 2, "criteriaSatisfied exactly two entries");
  assert.equal(sch.properties.criteriaSatisfied.maxItems, 2);
  assert.deepEqual(sch.properties.criteriaSatisfied.items.properties.id.enum, ["criterion-1", "criterion-2"], "exactly the host criterion ids");
  assert.deepEqual(sch.properties.criteriaSatisfied.items.properties.status.enum, ["satisfied"], "status enum pins EXACTLY 'satisfied' (rework r1)");
});

T("work report without head -> schema-missing -> ONE salvage repair, merge uses the recovered head", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ head: "" })),
    reportRepair: ok(workOut({ head: "3333333333333333333333333333333333333333", what_done: "recovered report" })),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.work), 1, "implementation brief NEVER re-run");
  assert.equal(runs.count(K.reportRepair), 1, "exactly one salvage child on the head-less report");
  assert.ok(res.log.some((l) => l.includes("schema-missing: head")), "rejection names the field: " + JSON.stringify(res.log));
  assert.ok(runs.spec(K.merge).spec.task.includes("3333333333333333333333333333333333333333"), "merge uses the recovered head");
  assert.equal(res.tasks[0].verdict, "merged");
});

T("head not 40-hex -> schema-missing; salvage that fails too -> verdict failed (no review burn)", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ head: "deadbeef" })),
    reportRepair: ok(workOut({ head: "still-not-a-sha" })),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 0 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.work), 1, "no re-brief");
  assert.equal(runs.count(K.reportRepair), 1, "exactly one salvage attempt");
  assert.equal(runs.count(K.review), 0, "no review child on an unsalvageable report");
  assert.equal(res.tasks[0].verdict, "failed");
});

T("foreign criteriaSatisfied ids -> schema-missing: criteriaSatisfied; unsalvageable -> verdict failed", async () => {
  const foreign = [{ id: "criterion-A", status: "satisfied", evidence: "e" }, { id: "criterion-2", status: "satisfied", evidence: "e" }];
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ criteriaSatisfied: foreign })),
    reportRepair: ok(workOut({ criteriaSatisfied: foreign, head: "9999999999999999999999999999999999999999" })),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reworkLimit: 0 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.work), 1, "no re-brief");
  assert.equal(runs.count(K.reportRepair), 1, "exactly one salvage attempt");
  assert.ok(res.log.some((l) => l.includes("schema-missing: criteriaSatisfied")), "rejection names the field: " + JSON.stringify(res.log));
  assert.equal(runs.count(K.review), 0, "no review child on an unsalvageable report");
  assert.equal(res.tasks[0].verdict, "failed");
});

// --- mutation probes (rp-schema): each validateAccStructured check has a designated
// probe - deleting the check makes its invalid payload VALID, the salvage child never
// fires and the probe reddens.
for (const [field, badPayload] of [
  ["head", { head: "" }],
  ["testsAddedOrUpdated", { testsAddedOrUpdated: "XTests.cs: 4 cases" }], // not an array
  ["commandsRun", { commandsRun: [{ command: "npm test", result: "exit 0", summary: "green" }] }], // enum violation (live poison class)
  ["validationOutput", { validationOutput: [] }], // empty evidence
  ["residualRisks", { residualRisks: "none" }], // not an array
  ["noStagedFiles", { noStagedFiles: "true" }], // type violation: noStagedFiles must be a boolean (R1: false itself is honest and valid)
  ["criteriaSatisfied", { criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "e" }, { id: "criterion-3", status: "satisfied", evidence: "e" }] }], // foreign id
  // rework r1: contract requires status EXACTLY "satisfied" - one not-satisfied entry must reject
  ["criteriaSatisfied", { criteriaSatisfied: [{ id: "criterion-1", status: "not-satisfied", evidence: "e" }, { id: "criterion-2", status: "satisfied", evidence: "e" }] }],
  ["criteriaSatisfied", { criteriaSatisfied: [{ id: "criterion-1", status: "not-applicable", evidence: "e" }, { id: "criterion-2", status: "satisfied", evidence: "e" }] }],
]) {
  T("mutation probe: " + field + " violation -> schema-missing salvage (no re-brief)", async () => {
    const routes = happyRoutes({
      curator: ok(curatorOut(true, [task(1)])),
      work: ok(workOut(badPayload)),
      reportRepair: ok(workOut({ head: "7777777777777777777777777777777777777777" })),
    });
    const runs = makeRuns(routes);
    const out = await runCampaign(baseArgs(), runs);
    assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
    const { res } = out;
    assert.equal(runs.count(K.work), 1, "report-class rejection never re-runs the implementation brief");
    assert.equal(runs.count(K.reportRepair), 1, field + ": semantic check fired -> salvage repair ran");
    assert.ok(res.log.some((l) => l.includes("schema-missing: " + field)), "rejection names the offending field " + field + ": " + JSON.stringify(res.log));
    assert.equal(res.tasks[0].verdict, "merged", "branch work survives a broken report via salvage");
  });
}

// --- mutation probes r2 (reviewer gap): the r1 suite left five validateAccStructured
// checks unprobed (every mutant stayed green). Each payload below is rejected TODAY by
// EXACTLY its designated check; deleting that check turns the payload VALID, the salvage
// child never fires and this probe reddens.
for (const [name, field, badPayload] of [
  // three entries, both host ids present, all satisfied+evidence: ONLY the length check
  // rejects (a 1-entry payload would stay rejected by the ids check - it cannot probe length)
  ["criteriaSatisfied length !== 2", "criteriaSatisfied", {
    criteriaSatisfied: [
      { id: "criterion-1", status: "satisfied", evidence: "e1" },
      { id: "criterion-2", status: "satisfied", evidence: "e2" },
      { id: "criterion-1", status: "satisfied", evidence: "e3" },
    ],
  }],
  ["criteriaSatisfied evidence blank", "criteriaSatisfied", {
    criteriaSatisfied: [
      { id: "criterion-1", status: "satisfied", evidence: "   " }, // whitespace-only evidence
      { id: "criterion-2", status: "satisfied", evidence: "gate green" },
    ],
  }],
  ["commandsRun empty array", "commandsRun", { commandsRun: [] }], // [].every is vacuously true - only the length check rejects
  ["commandsRun command blank", "commandsRun", { commandsRun: [{ command: "   ", result: "passed", summary: "green" }] }],
]) {
  T("mutation probe r2: " + name + " -> schema-missing salvage (no re-brief)", async () => {
    const routes = happyRoutes({
      curator: ok(curatorOut(true, [task(1)])),
      work: ok(workOut(badPayload)),
      reportRepair: ok(workOut({ head: "7777777777777777777777777777777777777777" })),
    });
    const runs = makeRuns(routes);
    const out = await runCampaign(baseArgs(), runs);
    assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
    const { res } = out;
    assert.equal(runs.count(K.work), 1, "report-class rejection never re-runs the implementation brief");
    assert.equal(runs.count(K.reportRepair), 1, name + ": semantic check fired -> salvage repair ran");
    assert.ok(res.log.some((l) => l.includes("schema-missing: " + field)), "rejection names the offending field " + field + ": " + JSON.stringify(res.log));
    assert.equal(res.tasks[0].verdict, "merged", "branch work survives a broken report via salvage");
  });
}

T("modelLadder duplicates collapse: [m-b, m-b] behaves like [m-b]", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: boom("HTTP 429 Too many requests, provider overloaded"),
    review: ok(reviewOk(false)),
  });
  const runs = makeRuns(routes);
  const st = makeState();
  const out = await runCampaign(baseArgs({ modelLadder: ["m-b", "m-b"], reworkLimit: 0 }), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.count(K.work), 2, "primary + ONE deduped ladder model, then fail-fast (no duplicate step)");
  assert.equal(st.writes.filter((w) => String(w.value && w.value.wait && w.value.wait.reason) === "provider-overload").length > 0, true, "exhaustion recorded as provider-overload wait");
  const retry = runs.spec(/t1-work~retry/);
  assert.ok(retry && retry.spec.model === "m-b", "the single deduped fallback carries the ladder model");
});

T("toy-falcon cleanup: failed leaf -> boundary janitor removes worktree+branch, retry starts clean", async () => {
  const routes = makeRuns([
    { match: K.work, handle: ok(workOut({ completed: false, what_done: "STOP: could not verify" })) },
    { match: K.review, handle: ok(reviewOk(false)) },
    { match: K.merge, handle: ok(mergeOut()) },
    { match: K.drop, handle: ok(dropOut()) },
    { match: K.boundary, handle: ok({ cleaned: [{ branch: "agile/falcon-fal-a", worktree: "../wt-t1-falcon-fal-a", removed: true, note: "gone" }], leaves: [] }) },
    { match: K.cleanup, handle: ok({ cleaned: [] }) },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.2", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 2,
    bdTasks: [falconLeaf("fal-a")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const jan = routes.spec(/^s2-boundary$/);
  assert.ok(jan, "sprint-2 boundary child launched after a failed sprint leaf");
  assert.equal(routes.count(/-bd-cleanup/), 0, "no separate cleanup child at the sprint end any more");
  assert.ok(jan.spec.task.includes("agile/falcon-fal-a"), "brief names the exact branch");
  assert.ok(jan.spec.task.includes("worktree remove --force") && jan.spec.task.includes("git branch -D"), "brief prescribes both janitor commands");
  assert.equal(routes.count(K.boundary), 1, "one boundary child for the sprint-1 leftover");
  assert.equal(routes.count(K.cleanup), 1, "final cleanup still fires at campaign end");
  assert.ok(out.res.log.some((l) => /cleanup removed 1\/1 leftover/.test(l)), "cleanup result logged");
  const finalJan = routes.spec(/^final-cleanup/);
  assert.ok(finalJan, "final-cleanup runs at campaign end (no garbage left behind)");
});

T("boundary merge: sprint 1 merged one leaf AND left one failed -> ONE s2-boundary does janitor + snapshot refresh", async () => {
  const routes = makeRuns([
    { match: K.finalClose, handle: ok({ cleaned: [], closed: [], leaves: [] }) },
    { match: K.work, handle: async (spec, key) => ({ ok: true, structuredOutput: workOut({ completed: key === "s1-t1-work" }) }) },
    { match: K.review, handle: ok(reviewOk()) },
    { match: K.merge, handle: ok(mergeOut()) },
    { match: K.boundary, handle: ok({
        cleaned: [{ branch: "agile/falcon-fal-c", worktree: "../wt-t2-falcon-fal-c", removed: true, note: "gone" }],
        leaves: [falconLeaf("fal-a", { open: false }), falconLeaf("fal-c"), falconLeaf("fal-d")],
      }) },
    { match: K.cleanup, handle: ok({ cleaned: [] }) },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 2, maxSprints: 2,
    bdTasks: [falconLeaf("fal-a"), falconLeaf("fal-c")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(routes.count(K.boundary), 1, "exactly one boundary child at the sprint-1/2 boundary");
  assert.equal(routes.count(/-bd-cleanup|-bd-cursor/), 0, "no separate cleanup or cursor child exists any more");
  const b = routes.spec(/^s2-boundary$/).spec.task;
  assert.ok(b.includes("agile/falcon-fal-c") && b.includes("git worktree remove --force") && b.includes("git branch -D"), "janitor part names the leftover");
  assert.ok(b.includes("bd list --parent t-fal.1") && b.includes("bd show"), "refresh part carries the exact bd commands");
  assert.ok(out.res.log.some((l) => /boundary cleanup removed 1\/1 leftover/.test(l)), "janitor result logged: " + JSON.stringify(out.res.log));
  assert.ok(out.res.log.some((l) => /snapshot refreshed \(2 open \/ 3 leaves\)/.test(l)), "refresh applied: " + JSON.stringify(out.res.log));
  assert.equal(out.res.tasks.find((r) => r.id === "fal-d").sprint, 2, "leaf that arrives with the refresh runs in sprint 2");
});

T("boundary child dies: sprint-2 janitor+refresh failure is logged, leftovers remain, campaign continues", async () => {
  const routes = makeRuns([
    { match: K.work, handle: ok(workOut({ completed: false })) },
    { match: K.boundary, handle: boom("transport down") },
    { match: K.cleanup, handle: ok({ cleaned: [] }) },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 2,
    bdTasks: [falconLeaf("fal-a")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.ok(out.res.log.some((l) => /sprint 2: boundary child failed .*leftovers remain/.test(l)), "failure logged with leftovers: " + JSON.stringify(out.res.log));
  assert.equal(routes.count(/^s2-t1-work/), 1, "sprint 2 still runs from the previous snapshot");
  assert.equal(routes.count(K.cleanup), 1, "campaign-end cleanup still sweeps the leftovers");
});

T("rotation: workModels round-robin glm->haiku->glm across tasks", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1), task(2), task(3)])),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ workModels: ["m-glm", "m-haiku"] }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const models = [1, 2, 3].map((i) => (runs.spec(new RegExp("t" + i + "-work$")) || {}).spec);
  assert.deepEqual(models.map((s) => s && s.model), ["m-glm", "m-haiku", "m-glm"], "workers rotate round-robin, got: " + JSON.stringify(models.map((s) => s && s.model)));
});

T("rotation: reviewer skips the task's worker model (cross-model per task)", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    workModels: undefined,
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ workModels: ["m-glm"], reviewModels: ["m-glm", "m-luna"] }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const rev = runs.spec(/t1-review/);
  assert.equal(rev.spec.model, "m-luna", "reviewer rotated past the author's model m-glm -> m-luna, got: " + rev.spec.model);
});

T("rotation preflight degradation: single reviewModels entry colliding with a work model warns and runs", async () => {
  const routes = happyRoutes({ curator: ok(curatorOut(true, [task(1)])) });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ workModels: ["m-glm"], reviewModels: ["m-glm"] }), runs);
  assert.ok(!out.err, "workflow must NOT throw (single-model degradation): " + (out.err && out.err.message));
  assert.equal(runs.spec(/t1-review/).spec.model, "m-glm", "reviewer falls back to the only model");
  assert.ok(out.res.log.some((l) => /preflight/.test(l) && /could never differ/.test(l)), "preflight warning kept the collision diagnosis: " + JSON.stringify(out.res.log));
  assert.ok(out.res.log.some((l) => /cross-model degraded/.test(l)), "reviewer pick warns cross-model degraded");
});

T("rotation: rework pins the task's worker model (same worker continues)", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: ok(reviewOk(false)),
    work: (spec) => (spec.model === "m-glm" ? ok(workOut())() : ok({ what_done: "x", files_changed: [], verification: "v", branch: "agile/task-1", worktree: "/tmp/wt", head: "a".repeat(40), completed: true })()),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ workModels: ["m-glm", "m-haiku"], reworkLimit: 1 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const rw = runs.spec(/t1-rework/);
  assert.ok(rw, "rework launched");
  assert.equal(rw.spec.model, "m-glm", "rework stays on the worker's model, not the next rotation pick");
});

T("rotation absent -> legacy behavior untouched (workModel string, no lists)", async () => {
  const routes = happyRoutes({ curator: ok(curatorOut(true, [task(1)])) });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ workModel: "m-w", reviewModel: "m-r" }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.spec(/t1-work$/).spec.model, "m-w", "workModel string still pins work children");
  assert.equal(runs.spec(/t1-review/).spec.model, "m-r", "reviewModel string still pins review children");
});

// --- circuit breaker (overload strikes): every 429 ladder step burns a strike on
// the failed model; a child success clears its strikes; at >= args.overloadTripThreshold
// (default 2) the model is TRIPPED and new children skip it (all tripped -> as-is);
// the strike map lives in the durable checkpoint so a resumed campaign remembers.

T("breaker: second strike trips the model -> the next task starts directly on the ladder model (exactly 1 launch)", async () => {
  // Strike 1 is pre-seeded (its default 600s cooling simulated expired): the first in-
  // campaign 429 is strike 2 -> TRIPPED, and from the same 429 the model also goes into
  // cooling-down - both mechanisms now keep new children off the burned model.
  const st = makeState({ "agile-cp": { phase: "completed", generation: 1, overloadStrikes: { "m-a": 1 }, coolingDown: {} } });
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1), task(2), task(3)])),
    work: (spec) => (spec.model === "m-b" ? ok(workOut())() : boom("HTTP 429 Too many requests, provider overloaded")()),
    review: ok(reviewOk(true), 1),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ workModel: "m-a", modelLadder: ["m-b"], maxParallel: 1 }), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.count(/s1-t1-work/), 2, "task 1 burns primary m-a (strike 2 -> TRIPPED) + ladder m-b");
  const t2 = runs.spec(/s1-t2-work$/);
  assert.ok(t2, "task 2 work launched");
  assert.equal(t2.spec.model, "m-b", "tripped AND cooling m-a skipped at start: task 2 starts on m-b");
  assert.equal(runs.count(/s1-t2-work/), 1, "exactly one launch for task 2 (no burned attempt)");
  assert.ok(out.res.log.some((l) => /TRIPPED/.test(l)), "trip surfaced in the log: " + JSON.stringify(out.res.log.filter((l) => /breaker|cooling/.test(l))));
  assert.equal(out.res.tasks.filter((r) => r.verdict === "merged").length, 3, "all tasks completed");
});

T("breaker: a strike below the threshold keeps the model primary; child success resets strikes", async () => {
  // Strike 1 is pre-seeded (its default 600s cooling simulated expired): below the
  // threshold the model still leads, and one child success on it clears the strike.
  const st = makeState({ "agile-cp": { phase: "completed", generation: 1, overloadStrikes: { "m-a": 1 }, coolingDown: {} } });
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1), task(2)])),
    review: ok(reviewOk(true), 1),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ workModel: "m-a", modelLadder: ["m-b"], maxParallel: 1 }), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const t1 = runs.spec(/s1-t1-work$/);
  assert.ok(t1, "task 1 launched");
  assert.equal(t1.spec.model, "m-a", "strike 1 < threshold and no cooling: task 1 still starts on m-a");
  assert.equal(runs.count(/s1-t1-work/), 1, "task 1 succeeds on m-a without a ladder step");
  assert.equal(runs.spec(/s1-t2-work$/).spec.model, "m-a", "task 2 starts on m-a again");
  assert.deepEqual(st.store.get("agile-cp").overloadStrikes, {}, "success on m-a reset its seeded strike (map ends empty)");
});

T("breaker: resume restores overload strikes from the checkpoint", async () => {
  const st = makeState();
  const mkRoutes = (nTasks) => happyRoutes({
    curator: ok(curatorOut(true, [task(1), task(2)].slice(0, nTasks))),
    work: (spec) => (spec.model === "m-b" ? ok(workOut())() : boom("HTTP 429 Too many requests, provider overloaded")()),
    review: ok(reviewOk(true), 1),
  });
  // campaign 1: one task burns m-a once (strike = 1), finishes on m-b
  const runs1 = makeRuns(mkRoutes(1));
  const out1 = await runCampaign(baseArgs({ workModel: "m-a", modelLadder: ["m-b"], maxParallel: 1 }), runs1, st);
  assert.ok(!out1.err, "campaign 1 threw: " + (out1.err && out1.err.message));
  assert.deepEqual(st.store.get("agile-cp").overloadStrikes, { "m-a": 1 }, "strike persisted in the final checkpoint");
  // Campaign 1's 429 also cooled m-a for the default 600s - SIMULATED EXPIRED here so
  // only the strike persistence is under test (cooling-driven skipping is its own
  // contract below).
  await st.set("agile-cp", Object.assign({}, st.store.get("agile-cp"), { coolingDown: {} }));
  // campaign 2 (resume on the SAME state): the strike survives the campaign boundary
  const runs2 = makeRuns(mkRoutes(2));
  const out2 = await runCampaign(baseArgs({ workModel: "m-a", modelLadder: ["m-b"], maxParallel: 1 }), runs2, st);
  assert.ok(!out2.err, "campaign 2 threw: " + (out2.err && out2.err.message));
  assert.equal(runs2.count(/s1-t1-work/), 2, "restored strike 1 does not trip yet: t1 still tries m-a first");
  const t2 = runs2.spec(/s1-t2-work$/);
  assert.equal(t2.spec.model, "m-b", "resume-accumulated strike 2 TRIPPED m-a: task 2 starts on m-b");
  assert.equal(runs2.count(/s1-t2-work/), 1, "no ladder burn for task 2");
});

T("breaker: ALL models tripped -> child starts with the primary as-is (breaker must not brick the campaign)", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: ok(reviewOk(true), 1),
  });
  const runs = makeRuns(routes);
  const st = makeState({ "agile-cp": { phase: "completed", generation: 1, overloadStrikes: { "m-a": 2, "m-b": 2 } } });
  const out = await runCampaign(baseArgs({ workModel: "m-a", modelLadder: ["m-b"], maxParallel: 1 }), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const w = runs.spec(/s1-t1-work$/);
  assert.ok(w, "work child launched");
  assert.equal(w.spec.model, "m-a", "every candidate tripped -> sequence as-is -> primary m-a");
  assert.equal(runs.count(/s1-t1-work/), 1, "single successful launch");
  assert.equal(out.res.tasks[0].verdict, "merged");
});

// --- quota cooling-down: a 429 carries the provider's own wait ("Server requested
// NNNNs retry delay"); the engine records {model, until} in the durable checkpoint and
// model selection for subsequent children (work/review pools, ladder start) skips
// cooling models (until > now); ALL cooling -> minimal until; expired -> eligible again.

T("cooling-down: 429 'Server requested Ns retry delay' -> model cooling in the checkpoint; the resumed campaign skips it", async () => {
  const mkRoutes = () => happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: (spec) => (spec.model === "m-a" ? boom("HTTP 429 rate_limit_error: Server requested 3910s retry delay")() : ok(workOut())()),
    review: ok(reviewOk(true), 1),
  });
  const st = makeState();
  const args = baseArgs({ workModel: "m-a", modelLadder: ["m-b"], maxParallel: 1 });
  const runs1 = makeRuns(mkRoutes());
  const out1 = await runCampaign(args, runs1, st);
  assert.ok(!out1.err, "campaign 1 threw: " + (out1.err && out1.err.message));
  assert.equal(runs1.count(/s1-t1-work/), 2, "task 1 burns m-a (cooling recorded) and finishes on m-b");
  assert.ok(out1.res.log.some((l) => /\[cooling\].*'m-a'/.test(l)), "cooling surfaced in the log: " + JSON.stringify(out1.res.log.filter((l) => /cooling/.test(l))));
  const cp1 = st.store.get("agile-cp");
  const untilIso = cp1.coolingDown && cp1.coolingDown["m-a"];
  assert.ok(untilIso, "cooling-down {model, until} written to the campaign checkpoint");
  const waitS = (Date.parse(untilIso) - Date.now()) / 1000;
  assert.ok(waitS > 3800 && waitS <= 3910, "until = now + 3910s (retry-after parsed), got " + Math.round(waitS) + "s");
  // resume on the SAME state: the quota wall must not burn a fresh start (wave-6: 3
  // children died dead-on-arrival against one 429 wall)
  const runs2 = makeRuns(mkRoutes());
  const out2 = await runCampaign(args, runs2, st);
  assert.ok(!out2.err, "campaign 2 threw: " + (out2.err && out2.err.message));
  const w2 = runs2.spec(/s1-t1-work$/);
  assert.ok(w2, "resumed campaign launched work");
  assert.equal(w2.spec.model, "m-b", "cooling m-a (until > now) skipped: the fresh child starts on m-b");
  assert.equal(runs2.count(/s1-t1-work/), 1, "no burned attempt on the cooling wall");
  assert.equal(out2.res.tasks[0].verdict, "merged");
});

T("cooling-down: unparsable 429 -> default 600s; parsed delay is capped at 7200s", async () => {
  const mkRoutes = (msg) => happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: (spec) => (spec.model === "m-a" ? boom(msg)() : ok(workOut())()),
    review: ok(reviewOk(true), 1),
  });
  const args = baseArgs({ workModel: "m-a", modelLadder: ["m-b"], maxParallel: 1 });
  // no "requested Ns retry delay" marker in the message -> default wait 600s
  const st1 = makeState();
  const out1 = await runCampaign(args, makeRuns(mkRoutes("HTTP 429 Too many requests, provider overloaded")), st1);
  assert.ok(!out1.err, "campaign 1 threw: " + (out1.err && out1.err.message));
  const d1 = (Date.parse(st1.store.get("agile-cp").coolingDown["m-a"]) - Date.now()) / 1000;
  assert.ok(d1 > 590 && d1 <= 600, "unparsable 429 -> default 600s cooling, got " + Math.round(d1) + "s");
  // a huge provider delay -> capped at 7200s
  const st2 = makeState();
  const out2 = await runCampaign(args, makeRuns(mkRoutes("HTTP 429 rate_limit_error: Server requested 99999s retry delay")), st2);
  assert.ok(!out2.err, "campaign 2 threw: " + (out2.err && out2.err.message));
  const d2 = (Date.parse(st2.store.get("agile-cp").coolingDown["m-a"]) - Date.now()) / 1000;
  assert.ok(d2 > 7100 && d2 <= 7200, "99999s retry delay capped at 7200s cooling, got " + Math.round(d2) + "s");
});

// Live precedent (campaign d77a5dd8/85483e06): rework children s1-t2-rework1 and
// s3-t1-rework1 died dead-on-arrival with "403 Request not allowed" (glm quota
// exhaustion) - the 429-only markers missed it, so no cooling was recorded and the
// same-brief relaunches kept burning against the wall. A 403/forbidden quota wall
// must be treated exactly like a 429: cooling + ladder escape.
T("cooling-down: 403 'Request not allowed' quota wall (live precedent) -> default 600s cooling + ladder escape; the resumed campaign skips it", async () => {
  const mkRoutes = () => happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: (spec) => (spec.model === "m-a" ? boom("403 Request not allowed")() : ok(workOut())()),
    review: ok(reviewOk(true), 1),
  });
  const st = makeState();
  const args = baseArgs({ workModel: "m-a", modelLadder: ["m-b"], maxParallel: 1 });
  const runs1 = makeRuns(mkRoutes());
  const out1 = await runCampaign(args, runs1, st);
  assert.ok(!out1.err, "campaign 1 threw: " + (out1.err && out1.err.message));
  assert.equal(runs1.count(/s1-t1-work/), 2, "task 1 burns m-a (403 cooling recorded) and finishes on m-b");
  assert.ok(out1.res.log.some((l) => /\[cooling\].*'m-a'.*forbidden \(403\)/.test(l)), "quota-forbidden (403) surfaced in the cooling log: " + JSON.stringify(out1.res.log.filter((l) => /cooling/.test(l))));
  const untilIso = st.store.get("agile-cp").coolingDown && st.store.get("agile-cp").coolingDown["m-a"];
  assert.ok(untilIso, "cooling-down {model, until} written for the 403 wall");
  const waitS = (Date.parse(untilIso) - Date.now()) / 1000;
  assert.ok(waitS > 590 && waitS <= 600, "403 carries no retry estimate -> default 600s cooling, got " + Math.round(waitS) + "s");
  // resume on the SAME state: the live failure was a same-brief rework relaunch
  // burning dead-on-arrival against the forbidden model
  const runs2 = makeRuns(mkRoutes());
  const out2 = await runCampaign(args, runs2, st);
  assert.ok(!out2.err, "campaign 2 threw: " + (out2.err && out2.err.message));
  const w2 = runs2.spec(/s1-t1-work$/);
  assert.ok(w2, "resumed campaign launched work");
  assert.equal(w2.spec.model, "m-b", "403-cooled m-a (until > now) skipped: the fresh child starts on m-b");
  assert.equal(runs2.count(/s1-t1-work/), 1, "no burned attempt on the 403 wall");
  assert.equal(out2.res.tasks[0].verdict, "merged");
});

T("cooling-down: 'forbidden' quota wall without any 429 marker -> same treatment: cooling + breaker strike + ladder escape", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: (spec) => (spec.model === "m-a" ? boom("HTTP 403 Forbidden: access to this model is denied for your account")() : ok(workOut())()),
    review: ok(reviewOk(true), 1),
  });
  const runs = makeRuns(routes);
  const st = makeState();
  const out = await runCampaign(baseArgs({ workModel: "m-a", modelLadder: ["m-b"], maxParallel: 1 }), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.count(/s1-t1-work/), 2, "task 1 burns m-a and escapes to m-b");
  const cp = st.store.get("agile-cp");
  assert.ok(cp.coolingDown && cp.coolingDown["m-a"], "cooling written from a 'forbidden' wall (no numeric-429 needed)");
  assert.ok((Number(cp.overloadStrikes && cp.overloadStrikes["m-a"]) || 0) >= 1, "the 403 ladder step burns a breaker strike like a 429");
  assert.ok(out.res.log.some((l) => /\[ladder\].*'m-a'.*next model: 'm-b'|\[ladder\].*m-a.*next model.*m-b/.test(l)), "ladder escape surfaced: " + JSON.stringify(out.res.log.filter((l) => /ladder/.test(l))));
  assert.equal(out.res.tasks[0].verdict, "merged");
});

T("cooling-down: work pool skips a cooling model (until > now) and starts on the next one", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: ok(reviewOk(true), 1),
  });
  const runs = makeRuns(routes);
  const st = makeState({ "agile-cp": { phase: "completed", generation: 1, coolingDown: { "m-a": new Date(Date.now() + 3600000).toISOString() } } });
  const out = await runCampaign(baseArgs({ workModels: ["m-a", "m-b"] }), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const w = runs.spec(/s1-t1-work$/);
  assert.ok(w, "work child launched");
  assert.equal(w.spec.model, "m-b", "cooling m-a skipped: the work child starts on m-b");
  assert.equal(runs.count(/s1-t1-work/), 1, "no burned attempt on the cooling model");
  assert.equal(out.res.tasks[0].verdict, "merged");
});

T("cooling-down: expired until -> the model is eligible again", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: ok(reviewOk(true), 1),
  });
  const runs = makeRuns(routes);
  const st = makeState({ "agile-cp": { phase: "completed", generation: 1, coolingDown: { "m-a": new Date(Date.now() - 60000).toISOString() } } });
  const out = await runCampaign(baseArgs({ workModels: ["m-a", "m-b"] }), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.spec(/s1-t1-work$/).spec.model, "m-a", "until < now: m-a is eligible again (rotation order kept)");
  assert.equal(out.res.tasks[0].verdict, "merged");
});

T("cooling-down: ALL work models cooling -> the one with the minimal until is taken", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: ok(reviewOk(true), 1),
  });
  const runs = makeRuns(routes);
  const st = makeState({ "agile-cp": { phase: "completed", generation: 1, coolingDown: {
    "m-a": new Date(Date.now() + 7200000).toISOString(),
    "m-b": new Date(Date.now() + 60000).toISOString(), // recovers first
    "m-c": new Date(Date.now() + 3600000).toISOString(),
  } } });
  const out = await runCampaign(baseArgs({ workModels: ["m-a", "m-b", "m-c"] }), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.spec(/s1-t1-work$/).spec.model, "m-b", "every model cooling -> minimal until (m-b) is taken");
  assert.ok(out.res.log.some((l) => /every work model is cooling/.test(l)), "all-cooling fallback surfaced in the log");
  assert.equal(out.res.tasks[0].verdict, "merged", "the campaign is not bricked by a full quota wall");
});

T("cooling-down: review pool skips a cooling reviewer model", async () => {
  const routes = happyRoutes({ curator: ok(curatorOut(true, [task(1)])) });
  const runs = makeRuns(routes);
  const st = makeState({ "agile-cp": { phase: "completed", generation: 1, coolingDown: { "m-r1": new Date(Date.now() + 3600000).toISOString() } } });
  const out = await runCampaign(baseArgs({ workModels: ["m-w"], reviewModels: ["m-r1", "m-r2"] }), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.spec(/t1-review/).spec.model, "m-r2", "cooling m-r1 skipped: reviewer on m-r2");
  assert.equal(out.res.tasks[0].verdict, "merged");
});

T("cooling-down: ladder start skips the cooling primary and leads with the ladder model", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: ok(reviewOk(true), 1),
  });
  const runs = makeRuns(routes);
  const st = makeState({ "agile-cp": { phase: "completed", generation: 1, coolingDown: { "m-a": new Date(Date.now() + 3600000).toISOString() } } });
  const out = await runCampaign(baseArgs({ workModel: "m-a", modelLadder: ["m-b"] }), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const w = runs.spec(/s1-t1-work$/);
  assert.ok(w, "work child launched");
  assert.equal(w.spec.model, "m-b", "cooling primary m-a skipped at ladder start: m-b leads");
  assert.equal(runs.count(/s1-t1-work/), 1, "no burned attempt on the cooling primary");
});

T("single-model degradation: one model on work+review does NOT throw - review runs on it with a warning", async () => {
  const routes = happyRoutes({ curator: ok(curatorOut(true, [task(1)])) });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ workModels: ["m-solo"], reviewModels: ["m-solo"] }), runs);
  assert.ok(!out.err, "workflow must NOT throw: " + (out.err && out.err.message));
  assert.equal(runs.spec(K.work).spec.model, "m-solo", "work on the single model");
  assert.equal(runs.spec(/t1-review/).spec.model, "m-solo", "review runs on the same single model");
  assert.ok(out.res.log.some((l) => /cross-model degraded/.test(l)), "degradation warning logged: " + JSON.stringify(out.res.log));
});

T("single-model degradation: legacy workModel===reviewModel warns and works; reviewModels>=2 keeps the reviewer different", async () => {
  // legacy equal strings: warn + work, review degrades onto the same model
  const routes = happyRoutes({ curator: ok(curatorOut(true, [task(1)])) });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ workModel: "m-both", reviewModel: "m-both" }), runs);
  assert.ok(!out.err, "workflow must NOT throw: " + (out.err && out.err.message));
  assert.equal(runs.spec(K.work).spec.model, "m-both", "work on the legacy model");
  assert.equal(runs.spec(/t1-review/).spec.model, "m-both", "reviewer degrades to the author's model");
  assert.ok(out.res.log.some((l) => /cross-model degraded|preflight/.test(l)), "warn present: " + JSON.stringify(out.res.log));
  // reviewModels >= 2: the reviewer stays different even when the work model is in the list
  const routes2 = happyRoutes({ curator: ok(curatorOut(true, [task(1)])) });
  const runs2 = makeRuns(routes2);
  const out2 = await runCampaign(baseArgs({ workModels: ["m-glm"], reviewModels: ["m-glm", "m-luna"] }), runs2);
  assert.ok(!out2.err, "workflow threw: " + (out2.err && out2.err.message));
  assert.equal(runs2.spec(/t1-review/).spec.model, "m-luna", "reviewer stays cross-model when a second review model exists");
});

// --- review tiers: bd leaf field review = full | lite | none (default full) -------
const tierRuns = (over = {}) => makeRuns([
  { match: K.work, handle: over.work || ok(workOut()) },
  { match: K.rework, handle: over.rework || ok(workOut()) },
  { match: K.review, handle: over.review || ok(reviewOk(true)) },
  { match: K.merge, handle: over.merge || ok(mergeOut()) },
  { match: K.arbiter, handle: over.arbiter || ok(arbOut("drop-branch", "t")) },
  { match: K.drop, handle: ok(dropOut()) },
  { match: K.reportRepair, handle: over.reportRepair || ok(workOut()) }, // rp-schema: salvage route (head-less reports repair from branch state)
  { match: K.cleanup, handle: ok({ cleaned: [] }) },
  { match: K.boundary, handle: boom("boundary must not launch in a single sprint") },
]);
const tierArgs = (leaves, over = {}) => baseArgs(Object.assign({
  taskSource: "bd-epic", bdEpic: "t-tier.1", doneWhen: "bd-epic-closed", bdTasks: leaves,
}, over));

T("review tier none: 0 review children, the reviewer is never asked, merge gate still merges", async () => {
  // the reviewer WOULD reject: a none leaf must never reach it
  const runs = tierRuns({ review: ok(reviewOk(false)) });
  const out = await runCampaign(tierArgs([falconLeaf("tier-a", { review: "none" })]), runs, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.count(K.review), 0, "none -> zero review children");
  assert.equal(runs.count(K.arbiter), 0, "none + completed -> no arbiter either");
  assert.equal(out.res.tasks[0].verdict, "merged", "merge passes without a review");
  const merge = runs.spec(K.merge).spec.task;
  assert.ok(merge.includes("workflows/merge-branch.mjs"), "merge preflight runs in CLI");
});

T("review tier none: salvage-covered head-less report still merges via recovered head; red checks -> merge-failed", async () => {
  const noHead = tierRuns({
    work: ok(workOut({ head: "" })),
    reportRepair: ok(workOut({ head: "8888888888888888888888888888888888888888" })),
  });
  const o1 = await runCampaign(tierArgs([falconLeaf("tier-h", { review: "none" })]), noHead, makeState());
  assert.ok(!o1.err, "workflow threw: " + (o1.err && o1.err.message));
  assert.equal(noHead.count(K.reportRepair), 1, "head-less report -> schema-missing -> salvage (head is schema-mandatory now)");
  assert.equal(noHead.count(K.merge), 1, "recovered head -> merge proceeds without a review child (tier none)");
  assert.ok(noHead.spec(K.merge).spec.task.includes("8888888888888888888888888888888888888888"), "merge uses the recovered head");
  assert.equal(o1.res.tasks[0].verdict, "merged");
  const red = tierRuns({ merge: ok(mergeOut({ checks_ok: false })) });
  const o2 = await runCampaign(tierArgs([falconLeaf("tier-r", { review: "none" })]), red, makeState());
  assert.ok(!o2.err, "workflow threw: " + (o2.err && o2.err.message));
  assert.equal(o2.res.tasks[0].verdict, "merge-failed", "red checks never count as merged");
});

T("review tier none: completed=false fails fast (no reviewer, no rework ladder)", async () => {
  const runs = tierRuns({ work: ok(workOut({ completed: false })) });
  const out = await runCampaign(tierArgs([falconLeaf("tier-c", { review: "none" })]), runs, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.count(K.review), 0, "none -> zero review children");
  assert.equal(runs.count(K.rework), 0, "a rejected work report no longer climbs the rework ladder");
  assert.equal(runs.count(K.merge), 0, "no merge without a valid candidate");
  assert.equal(out.res.tasks[0].verdict, "failed");
});

T("review tier lite: checklist prompt WITHOUT refute protocol, cross-model review still runs, merge gate unchanged", async () => {
  const runs = tierRuns();
  const out = await runCampaign(tierArgs([falconLeaf("tier-l", { review: "lite" })]), runs, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.count(K.review), 1, "lite runs exactly one review child");
  const rev = runs.spec(K.review).spec.task;
  assert.ok(/CHECKLIST REVIEW \(lite tier/.test(rev), "lite checklist prompt present");
  assert.ok(!/refute/i.test(rev), "lite prompt carries no refute protocol");
  assert.ok(!/Judge: \(1\) does it satisfy every acceptance criterion/.test(rev), "lite does not use the full judge block");
  assert.ok(/git rev-parse/.test(rev), "lite still verifies the approved head (head-binding)");
  assert.ok(/approved=false requires concrete, actionable rework_reasons/.test(rev), "lite still demands concrete rework reasons");
  assert.equal(out.res.tasks[0].verdict, "merged");
});

T("review tier full: unchanged judge prompt; missing and unknown tiers fall back to full", async () => {
  const runs = tierRuns();
  const out = await runCampaign(tierArgs([
    falconLeaf("tier-f", { review: "full" }),
    falconLeaf("tier-m"),
    falconLeaf("tier-u", { review: "bogus" }),
  ]), runs, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.count(K.review), 3, "every full/missing/unknown leaf gets its review");
  for (const key of ["s1-t1-review", "s1-t2-review", "s1-t3-review"]) {
    const rev = runs.spec(key).spec.task;
    assert.ok(/Judge: \(1\) does it satisfy every acceptance criterion; \(2\) correctness incl\. edge cases; \(3\) constraints compliance; \(4\) no scope creep; \(5\) tests meaningful, not tautological\./.test(rev), key + ": full judge block unchanged");
    assert.ok(!/CHECKLIST REVIEW/.test(rev), key + ": no lite checklist on full");
  }
});

T("review tier from a boundary refresh: a leaf that arrives mid-campaign with review none runs without a review", async () => {
  let calls = 0;
  const routes = makeRuns([
    { match: K.work, handle: ok(workOut()) },
    { match: K.review, handle: ok(reviewOk(true)) },
    { match: K.merge, handle: ok(mergeOut()) },
    { match: K.boundary, handle: async () => {
        calls++;
        return calls === 1
          ? ok({ leaves: [falconLeaf("fal-a", { open: false }), falconLeaf("fal-g", { review: "none" })] })()
          : ok({ leaves: [falconLeaf("fal-a", { open: false }), falconLeaf("fal-g", { review: "none", open: false })] })();
      } },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 2, maxSprints: 3,
    bdTasks: [falconLeaf("fal-a")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(routes.count(/^s1-t1-review/), 1, "sprint 1 full leaf is reviewed");
  assert.equal(routes.count(/^s2-t1-review/), 0, "sprint 2 none leaf (from the cursor) is not reviewed");
  assert.equal(routes.count(/^s2-t1-merge/), 1, "sprint 2 none leaf still merges");
  assert.equal(out.res.tasks.find((r) => r.id === "fal-g").verdict, "merged");
});

// --- retired verdict-only mode: a bd snapshot leaf carrying verify:true is an ORDINARY
// work leaf. The field is dropped by normalizeLeaf; the leaf gets a branch/worktree, a
// review child and a merge child exactly like any other leaf.
T("snapshot leaf with verify:true is an ordinary work leaf: branch/worktree created, review and merge run, verdict merged", async () => {
  const runs = tierRuns();
  const out = await runCampaign(tierArgs([falconLeaf("ver-n", { verify: true })]), runs, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const work = runs.spec(K.work).spec;
  assert.ok(/git worktree add/.test(work.task), "work brief instructs a worktree: the leaf is a normal work leaf");
  assert.equal(work.accVerifyOnly, undefined, "no verdict-only flag rides on the work spec");
  assert.equal(runs.count(K.review), 1, "review child runs for the verify:true leaf");
  assert.equal(runs.count(K.merge), 1, "merge child runs for the verify:true leaf");
  assert.equal(out.res.tasks[0].verdict, "merged", "verify:true leaf merges like a regular leaf");
  assert.equal(out.res.counts.merged, 1);
  assert.equal(out.res.status, "completed");
});

// --- carry-over выжимка (agents-zjt.2): a non-merge attempt leaves ENGINE facts for the retry brief.
const CARRY_SECTION = /PREVIOUS ATTEMPT/;

T("carry-over: failed attempt -> next sprint's retry brief carries branch, files and stop point (no worker narrative)", async () => {
  const routes = makeRuns([
    { match: K.work, handle: async (spec, key) => ok(key.startsWith("s1-")
      ? workOut({ completed: false, what_done: "NARRATIVE-MARKER do not carry", files_changed: ["src/a.txt", "src/b.txt"] })
      : workOut({ files_changed: ["src/a.txt"] }))() },
    { match: K.review, handle: ok(reviewOk(true)) },
    { match: K.merge, handle: ok(mergeOut()) },
    { match: K.boundary, handle: ok({ cleaned: [], leaves: [] }) },
    { match: K.cleanup, handle: ok({ cleaned: [] }) },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.2", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 2,
    bdTasks: [falconLeaf("fal-a")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const first = routes.spec(/^s1-t1-work$/);
  assert.ok(first && !CARRY_SECTION.test(first.spec.task), "first attempt has NO carry section");
  const retry = routes.spec(/^s2-t1-work$/);
  assert.ok(retry, "failed leaf is retried in sprint 2");
  assert.ok(CARRY_SECTION.test(retry.spec.task), "retry brief has the carry section");
  assert.ok(retry.spec.task.includes("agile/falcon-fal-a"), "retry brief names the previous branch");
  assert.ok(retry.spec.task.includes("src/a.txt, src/b.txt (2 total)"), "retry brief names the previous files_changed");
  assert.ok(retry.spec.task.includes("stopped at: work: completed=false"), "retry brief names the stop point");
  assert.ok(!retry.spec.task.includes("NARRATIVE-MARKER"), "worker narrative (what_done) is NOT carried");
  const briefLines = retry.spec.task.split("\n");
  const start = briefLines.findIndex((l) => CARRY_SECTION.test(l));
  let end = start + 1;
  while (end < briefLines.length && briefLines[end].startsWith("- ")) end++;
  assert.ok(end - start <= 5, "carry section is at most 5 lines: " + (end - start));
  const rec = out.res.tasks.find((r) => r.id === "fal-a" && r.verdict === "merged");
  assert.ok(rec, "retry merged");
  assert.equal(rec.carry, undefined, "a merged attempt carries nothing");
});

T("carry-over: merge refused -> carry records the merge stop point and the branch's files", async () => {
  const routes = makeRuns([
    { match: K.work, handle: async (spec, key) => ok(workOut({ files_changed: key.startsWith("s1-") ? ["src/m.txt"] : [] }))() },
    { match: K.review, handle: ok(reviewOk(true)) },
    { match: K.merge, handle: async (spec, key) => ok(key.startsWith("s1-") ? mergeOut({ merged: false, checks_ok: false }) : mergeOut())() },
    { match: K.boundary, handle: ok({ cleaned: [], leaves: [] }) },
    { match: K.cleanup, handle: ok({ cleaned: [] }) },
  ]);
  const out = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.3", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 2,
    bdTasks: [falconLeaf("fal-m", { files_hint: "src/m.txt" })],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const retry = routes.spec(/^s2-t1-work$/);
  assert.ok(retry && CARRY_SECTION.test(retry.spec.task), "merge-refused leaf: retry brief carries the section");
  assert.ok(retry.spec.task.includes("agile/falcon-fal-m") && retry.spec.task.includes("src/m.txt"), "branch and files of the refused attempt");
  assert.ok(retry.spec.task.includes("stopped at: merge: merged/checks_ok not confirmed"), "merge stop point named");
});

T("carry-over: checkpoint roundtrip - carry is persisted and survives a resume into the first brief of the resumed run", async () => {
  const st = makeState();
  const routes1 = makeRuns([
    { match: K.work, handle: ok(workOut({ completed: false, files_changed: ["src/a.txt"] })) },
    { match: K.cleanup, handle: ok({ cleaned: [] }) },
  ]);
  const out1 = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.4", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 1,
    bdTasks: [falconLeaf("fal-a")],
  }), routes1, st);
  assert.ok(!out1.err, "campaign 1 threw: " + (out1.err && out1.err.message));
  const cp = st.store.get("agile-cp");
  assert.ok(cp.carry && cp.carry["agile/falcon-fal-a"], "carry persisted in the checkpoint under the branch");
  assert.deepEqual(cp.carry["agile/falcon-fal-a"].files, ["src/a.txt"], "files persisted");
  assert.equal(cp.carry["agile/falcon-fal-a"].stop, "work: completed=false", "stop point persisted");
  const recCarry = out1.res.tasks.find((r) => r.id === "fal-a").carry;
  assert.deepEqual(recCarry, cp.carry["agile/falcon-fal-a"], "rec carries the same record as the checkpoint");

  const routes2 = makeRuns([
    { match: K.work, handle: ok(workOut()) },
    { match: K.review, handle: ok(reviewOk(true)) },
    { match: K.merge, handle: ok(mergeOut()) },
    { match: K.cleanup, handle: ok({ cleaned: [] }) },
  ]);
  const out2 = await runCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.4", doneWhen: "bd-epic-closed",
    sprintTasks: 1, maxSprints: 1,
    bdTasks: [falconLeaf("fal-a")],
  }), routes2, st);
  assert.ok(!out2.err, "resumed campaign threw: " + (out2.err && out2.err.message));
  const resumed = routes2.spec(/^s1-t1-work$/);
  assert.ok(resumed && CARRY_SECTION.test(resumed.spec.task), "resumed run: first brief carries the checkpoint carry");
  assert.ok(resumed.spec.task.includes("src/a.txt") && resumed.spec.task.includes("stopped at: work: completed=false"), "resumed brief has files and stop point");
  assert.equal(out2.res.generation, 2, "resume ran as generation 2");
});

// --- campaign analytics (agents-1iw): auto-archival of events.jsonl/workflow-children.jsonl + retro ----
// The workflow sandbox has NO fs access: persistence is one mechanical bash child at campaign
// end that copies the runtime artifacts into <journalDir>/<runid>/ and runs analyze-campaign.mjs
// (metrics.json + retro markdown). Best-effort: analytics is evidence, never a gate.

T("campaign analytics: archiver child launches once at campaign end, after final cleanup, with a copy+analyze brief", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    analytics: ok({ runid: "wf-1234", skipped: false, summaryLine: "wall=2h children=12 tokens=90k failures=2 (acceptance, merge-preflight)", children: 12, totalTokens: 90000, failureClasses: { acceptance: 1, "merge-preflight": 1 } }),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.count(K.analytics), 1, "exactly one analytics child per campaign, got " + JSON.stringify(runs.keys()));
  const mg = started(out.events, K.merge);
  const an = started(out.events, K.analytics);
  assert.ok(mg >= 0 && an > mg, "analytics launches at campaign end, after the last task child");
  const lastStart = out.events.filter((e) => e.t === "start").pop();
  assert.ok(lastStart && K.analytics.test(lastStart.key), "analytics is the campaign's final child");
  const an2 = runs.spec(K.analytics);
  assert.ok(an2.spec.acceptance === false, "analytics is not a gate (acceptance off)");
  const b = an2.spec.task;
  assert.ok(b.includes("campaign-analytics"), "brief carries the self-location key (own start record finds the run dir)");
  assert.ok(b.includes("events.jsonl") && b.includes("workflow-children.jsonl") && b.includes("status.json"), "brief copies all three runtime artifacts");
  assert.ok(b.includes("metrics.json") && /retro-/.test(b), "brief writes metrics.json + retro markdown");
  assert.ok(/node \"[^\"]*analyze-campaign\.mjs\"/.test(b), "brief runs the analyze-campaign.mjs deliverable via node");
  assert.ok(b.includes(".agile-js-test/sprint-*.jsonl"), "brief wires the journal glob");
  assert.ok(/epic-close/.test(b), "brief states the epic-close mirror contract for the driver");
  // result mirror (point 5: the summary the driver pastes into the bd epic-close comment)
  assert.equal(out.res.analytics.runid, "wf-1234");
  assert.equal(out.res.analytics.children, 12);
  assert.equal(out.res.analytics.totalTokens, 90000);
  assert.deepEqual(out.res.analytics.failureClasses, { acceptance: 1, "merge-preflight": 1 });
  assert.ok(/wall=2h children=12 tokens=90k failures=2/.test(out.res.analytics.summaryLine), "summaryLine carries wall/children/tokens/failures");
  assert.ok(out.res.log.some((l) => /campaign analytics: wall=2h children=12/.test(l)), "log line mirrors the summary");
});

T("campaign analytics: default-on (auto-run), child failure is best-effort - status and counts untouched", async () => {
  const runs = makeRuns(happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    analytics: boom("analyze-campaign.mjs not found"),
  }));
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.count(K.analytics), 1, "analytics is AUTO by default (no flag needed)");
  assert.equal(out.res.status, "completed", "campaign status unaffected by analytics failure");
  assert.equal(out.res.counts.merged, 1, "counts untouched");
  assert.equal("analytics" in out.res ? out.res.analytics : undefined, undefined, "no analytics mirror on failure");
  assert.ok(out.res.log.some((l) => /campaign analytics failed/.test(l)), "failure logged, not silent");
});

T("campaign analytics: skipped=true (e.g. runtime artifacts not found) is surfaced, not an error", async () => {
  const runs = makeRuns(happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    analytics: ok({ runid: "", skipped: true, reason: "pi-subagents temp root not found", summaryLine: "skipped" }),
  }));
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(out.res.status, "completed");
  assert.ok(out.res.log.some((l) => /campaign analytics: skipped \(pi-subagents temp root not found\)/.test(l)), "skip reason logged");
  assert.equal(out.res.analytics.skipped, true, "mirror keeps the skip fact honest");
});

T("campaign analytics: analytics=false or empty metricsScript opts out - child never launches", async () => {
  for (const over of [{ analytics: false }, { metricsScript: "" }]) {
    const runs = makeRuns(happyRoutes({ curator: ok(curatorOut(true, [task(1)])) }));
    const out = await runCampaign(baseArgs(over), runs);
    assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
    assert.equal(runs.count(K.analytics), 0, "no analytics child with " + JSON.stringify(over));
    assert.equal("analytics" in out.res ? out.res.analytics : undefined, undefined);
  }
});

// rework r1: runChild pins spec.model||model, so the modeless archiver still lands ON the
// campaign primary (args.model) - without the guard its OWN 429 ladder steps permanently
// recordStrike() the primary in the FINAL checkpoint, and its trivial success would
// resetStrikes() it: a copy+script run must leave the breaker evidence exactly as it was.
T("campaign analytics: archiver 429 does not permanently strike the campaign primary", async () => {
  let anCalls = 0;
  const runs = makeRuns(happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    analytics: () => {
      anCalls++;
      return anCalls === 1 ? boom("HTTP 429 Too many requests, provider overloaded")()
        : ok({ runid: "snap", skipped: false, summaryLine: "wall=? children=? tokens=? failures=0" })();
    },
  }));
  const st = makeState();
  const out = await runCampaign(baseArgs({ model: "m-a", modelLadder: ["m-b"], workModel: "m-w", reviewModel: "m-r" }), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const first = runs.spec(/^campaign-analytics$/);
  assert.ok(first, "archiver launched at campaign end");
  assert.equal(first.spec.model, "m-a", "regression mechanics: the modeless launch is pinned to the campaign primary by runChild");
  assert.equal(runs.count(K.analytics), 2, "archiver laddered once on the 429");
  assert.ok(out.res.analytics && out.res.analytics.runid === "snap", "archiver eventually succeeded");
  assert.equal(out.res.status, "completed");
  assert.deepEqual(st.store.get("agile-cp").overloadStrikes, {},
    "the archiver's own 429 must NOT leave a permanent strike on the primary in the final checkpoint");
});

T("campaign analytics: archiver 429 strikes do not leak into the checkpoint (restore, not record)", async () => {
  const runs = makeRuns(happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    analytics: boom("HTTP 429 Too many requests, provider overloaded"),
  }));
  const st = makeState({ "agile-cp": { phase: "completed", generation: 1, overloadStrikes: { "m-x": 1 } } });
  const out = await runCampaign(baseArgs({ model: "m-a", modelLadder: ["m-l"], workModel: "m-w", reviewModel: "m-r" }), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.count(K.analytics), 2, "archiver burned primary + one ladder attempt on 429");
  assert.ok(out.res.log.some((l) => /campaign analytics failed/.test(l)), "failure logged, not silent");
  assert.equal(out.res.status, "completed", "best-effort: analytics failure does not gate the campaign");
  assert.deepEqual(st.store.get("agile-cp").overloadStrikes, { "m-x": 1 },
    "strikes the archiver burned (m-a, m-l) are restored away; pre-existing evidence untouched");
});

// --- analyze-campaign.mjs: THE campaign analyzer deliverable (rework r2) ----
// The archiver child's STEP 3 runs `node analyze-campaign.mjs <run-dir> --agile-journal ...
// --out ... --retro ...`; these tests invoke that exact deliverable - the CLI via spawnSync
// (piped stdin) on synthetic run dirs, plus its module API for the taxonomy contract.
const ANALYZE_SCRIPT = fileURLToPath(new URL("../workflows/analyze-campaign.mjs", import.meta.url));

function writeCampaignFixture(root) {
  const T0 = 1700000000000;
  const runDir = pathMod.join(root, "wf-42");
  fsSync.mkdirSync(runDir, { recursive: true });
  // Live sibling child dirs (<parent>/<childRunId>/status.json) - the primary usage source.
  for (const [id, tokens, model] of [["c1", 1234, "m-w"], ["c2", 777, "m-r"]]) {
    fsSync.mkdirSync(pathMod.join(root, id), { recursive: true });
    fsSync.writeFileSync(pathMod.join(root, id, "status.json"), JSON.stringify({ totalTokens: tokens, state: "ok", model }));
  }
  fsSync.writeFileSync(pathMod.join(runDir, "events.jsonl"), [
    JSON.stringify({ type: "subagent.workflow.started", runId: "wf-42", ts: T0 }),
    JSON.stringify({ type: "subagent.child-status", childRunId: "c1", status: "started", agent: "worker", key: "s1-t1-work", ts: T0 + 1000 }),
    JSON.stringify({ type: "subagent.child-status", childRunId: "c2", status: "started", agent: "reviewer", key: "s1-t1-review", ts: T0 + 10000 }),
    JSON.stringify({ type: "subagent.child-status", childRunId: "c3", status: "started", agent: "worker", key: "s1-t1-work~retry1", ts: T0 + 20000 }),
    JSON.stringify({ type: "subagent.workflow.child_settled", childRunId: "c2", outcome: "failed", ts: T0 + 30000 }),
    JSON.stringify({ type: "subagent.workflow.child_settled", childRunId: "c3", outcome: "ok", ts: T0 + 40000 }),
    JSON.stringify({ type: "subagent.workflow.child_settled", childRunId: "c1", outcome: "ok", ts: T0 + 60000 }),
    JSON.stringify({ type: "subagent.workflow.trace", trace: [
      { operation: "run", runId: "c1", key: "s1-t1-work", state: "ok", durationMs: 58000, agent: "worker" },
      { operation: "run", runId: "c3", key: "s1-t1-work~retry1", state: "ok", durationMs: 18000, agent: "worker" },
    ] }),
  ].join("\n"));
  fsSync.writeFileSync(pathMod.join(runDir, "workflow-children.jsonl"), [
    JSON.stringify({ type: "start", key: "s1-t1-work", runId: "c1" }),
    JSON.stringify({ type: "settle", key: "s1-t1-work", result: { runId: "c1", ok: true, agent: "worker", structuredOutput: { completed: true } } }),
    JSON.stringify({ type: "start", key: "s1-t1-review", runId: "c2" }),
    JSON.stringify({ type: "settle", key: "s1-t1-review", result: { runId: "c2", ok: false, error: "HTTP 429 Too many requests, provider overloaded", agent: "reviewer" } }),
    JSON.stringify({ type: "start", key: "s1-t1-work~retry1", runId: "c3" }),
    // ok:true settle whose REPORT carries the failing verdict (schema-missing) - the
    // report-rejection channel that never surfaces as a settle error.
    JSON.stringify({ type: "settle", key: "s1-t1-work~retry1", result: { runId: "c3", ok: true, agent: "worker", structuredOutput: { completed: false, what_done: "x", verification: "schema-missing: residualRisks list absent" } } }),
  ].join("\n"));
  // Workflow snapshot with steps[] - the fallback usage source for children whose live
  // sibling dir is gone (c3 has no <root>/c3/status.json).
  fsSync.writeFileSync(pathMod.join(runDir, "status.json"), JSON.stringify({ runId: "wf-42", steps: [
    { runId: "c3", tokens: { total: 321 }, durationMs: 18000, agent: "worker", status: "ok", workflowKey: "s1-t1-work~retry1" },
  ] }));
  const journalDir = pathMod.join(root, ".agile-js-test");
  fsSync.mkdirSync(journalDir, { recursive: true });
  fsSync.writeFileSync(pathMod.join(journalDir, "sprint-1.jsonl"), [
    JSON.stringify({ task: "t1", verdict: "merged", branch: "agile/x", head: "a".repeat(40), note: "" }),
    JSON.stringify({ task: "t2", verdict: "failed", branch: "agile/y", head: "b".repeat(40), note: "merge refused: staged files left in main copy" }),
  ].join("\n"));
  return { T0, runDir, journalGlob: pathMod.join(journalDir, "sprint-*.jsonl") };
}

T("analyze-campaign.mjs CLI: wall timeline, failure classes (incl. ok:true failing report), usage, journal -> metrics.json + retro", () => {
  const root = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), "ac-e2e-"));
  try {
    const { T0, runDir, journalGlob } = writeCampaignFixture(root);
    const metricsPath = pathMod.join(root, "metrics.json");
    const retroPath = pathMod.join(root, "retro-wf-42.md");
    const r = spawnSync(process.execPath,
      [ANALYZE_SCRIPT, runDir, "--agile-journal", journalGlob, "--out", metricsPath, "--retro", retroPath],
      { input: "", timeout: 20000, encoding: "utf8" });
    assert.equal(r.status, 0, "CLI exits 0: " + (r.stderr || r.stdout));
    assert.ok(/wallMs: 60000 \(/.test(r.stdout), "campaign wall from first->last event ts (60000): " + r.stdout);
    assert.ok(/sumDurationsMs: 76000 \(busy sum/.test(r.stdout), "busy sum labeled NOT wall time: " + r.stdout);
    assert.ok(/failure classes: \{[^}]*"transport":1[^}]*\}/.test(r.stdout) && /failure classes: \{[^}]*"schema-missing":1/.test(r.stdout), "both failure channels classified: " + r.stdout);
    assert.ok(/agile journal: files=1.*journal failures=1 \{"merge-preflight":1\}/.test(r.stdout), "journal failures classified: " + r.stdout);
    assert.ok(/campaign runId: wf-42/.test(r.stdout));
    const m = JSON.parse(fsSync.readFileSync(metricsPath, "utf8"));
    assert.equal(m.summary.wallMs, 60000);
    assert.equal(m.summary.children, 3);
    assert.equal(m.summary.totalTokens, 2332, "usage = live siblings (1234+777) + snapshot fallback (321)");
    assert.equal(m.summary.tokensKnown, 3);
    assert.deepEqual(m.summary.failureClasses, { "schema-missing": 1, transport: 1 });
    assert.equal(m.summary.retries, 1, "~retry1 key shape classified as a retry launch");
    const c3 = m.children.find((c) => c.runId === "c3");
    assert.equal(c3.failureClass, "schema-missing", "ok:true child with a failing verdict report is classified");
    assert.ok(/\(verdict failed: schema-missing\)/.test(c3.outcome), "outcome marks the verdict-failure channel: " + c3.outcome);
    assert.equal(c3.totalTokens, 321, "snapshot steps[] usage fallback");
    const retro = fsSync.readFileSync(retroPath, "utf8");
    assert.ok(retro.startsWith("# Campaign retro - wf-42"));
    assert.ok(/includes idle gaps - NOT the busy sum/.test(retro), "retro wall line carries the honesty label");
    assert.ok(/\| s1-t1-work\~retry1 \| worker \| .* \| schema-missing/.test(retro) || /verdict failed: schema-missing/.test(retro), "retro children table carries the failing child");
    assert.ok(/## Failure classes - agile journal/.test(retro), "retro has the journal failure-class table");
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

T("analyze-campaign.mjs honesty: no timestamps -> wallMs null (never 0); no token sources -> '?' (exit 0)", () => {
  const root = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), "ac-honest-"));
  try {
    const runDir = pathMod.join(root, "wf-7");
    fsSync.mkdirSync(runDir, { recursive: true });
    fsSync.writeFileSync(pathMod.join(runDir, "events.jsonl"),
      JSON.stringify({ type: "subagent.workflow.trace", trace: [{ operation: "run", runId: "c1", key: "s1-t1-work", state: "ok", durationMs: 5000 }] }));
    fsSync.writeFileSync(pathMod.join(runDir, "workflow-children.jsonl"),
      JSON.stringify({ type: "settle", key: "s1-t1-work", result: { runId: "c1", ok: true, structuredOutput: { completed: true } } }));
    const retroPath = pathMod.join(root, "retro.md");
    const r = spawnSync(process.execPath, [ANALYZE_SCRIPT, runDir, "--retro", retroPath], { input: "", timeout: 20000, encoding: "utf8" });
    assert.equal(r.status, 0, "missing optional data is not an error");
    assert.ok(/wallMs: unknown \(events\.jsonl has no timestamps\)/.test(r.stdout), "wall stays unknown, never fabricated: " + r.stdout);
    assert.ok(/total tokens: \? \(known for 0\)/.test(r.stdout), "unknown tokens stay '?', never zeros: " + r.stdout);
    const retro = fsSync.readFileSync(retroPath, "utf8");
    assert.ok(/- wall: unknown \(no timestamped events in events\.jsonl\)/.test(retro));
    const { summary } = analyzeCampaign(runDir);
    assert.equal(summary.wallMs, null);
    assert.equal(summary.totalTokens, null);
    assert.equal(summary.children, 1);
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

T("analyze-campaign.mjs parity: snapshot steps[] startedAt -> per-child wallMs when the child has no child-status 'started' event (collect_metrics.py contract)", () => {
  const root = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), "ac-snapstart-"));
  try {
    const T0 = 1700000000000;
    const startedAt = T0 + 40000; // real pi-subagents status.json steps[] carry startedAt (epoch ms)
    const settleTs = T0 + 50000;
    const mkRun = (name, withStartedAt) => {
      const dir = pathMod.join(root, name);
      fsSync.mkdirSync(dir, { recursive: true });
      // c1 settles with NO subagent.child-status 'started' event and no sibling dir:
      // the status.json snapshot step is the ONLY start evidence.
      fsSync.writeFileSync(pathMod.join(dir, "events.jsonl"), [
        JSON.stringify({ type: "subagent.workflow.started", runId: name, ts: T0 }),
        JSON.stringify({ type: "subagent.workflow.child_settled", childRunId: "c1", outcome: "ok", ts: settleTs }),
      ].join("\n"));
      fsSync.writeFileSync(pathMod.join(dir, "status.json"), JSON.stringify({ runId: name, steps: [
        Object.assign({ runId: "c1", tokens: { total: 555 }, durationMs: 10000, agent: "worker", status: "ok", workflowKey: "s1-t1-work" },
          withStartedAt ? { startedAt } : {}),
      ] }));
      return dir;
    };
    const dirA = mkRun("wf-a", true);
    const dirB = mkRun("wf-b", false);
    // CLI: the analytics child's exact deliverable on the positive dir.
    const metricsPath = pathMod.join(root, "metrics.json");
    const r = spawnSync(process.execPath, [ANALYZE_SCRIPT, dirA, "--out", metricsPath],
      { input: "", timeout: 20000, encoding: "utf8" });
    assert.equal(r.status, 0, "CLI exits 0: " + (r.stderr || r.stdout));
    assert.ok(/wallMs: 50000 \(/.test(r.stdout), "campaign wall (first->last event ts) untouched: " + r.stdout);
    const m = JSON.parse(fsSync.readFileSync(metricsPath, "utf8"));
    assert.equal(m.children.length, 1, "row exists though the child appears ONLY in the snapshot");
    assert.equal(m.children[0].wallMs, 10000, "child wall = settleTs - snapshot startedAt (what collect_metrics.py computes)");
    assert.equal(m.children[0].totalTokens, 555, "snapshot tokens fallback still flows");
    // Module API: positive vs negative control.
    assert.equal(analyzeCampaign(dirA).rows[0].wallMs, 10000);
    assert.equal(analyzeCampaign(dirB).rows[0].wallMs, null, "no startedAt -> wallMs stays null (never 0, never fabricated)");
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

T("analyze-campaign.mjs taxonomy: failure classes + key shapes match the collect_metrics.py contract", () => {
  assert.equal(classifyFailure("Acceptance rejected: schema-missing: files_changed"), "schema-missing");
  assert.equal(classifyFailure("required structured output was not produced"), "schema-missing");
  assert.equal(classifyFailure("Merge preflight failed: staged index not empty"), "merge-preflight");
  assert.equal(classifyFailure("acceptance verification failed: tests-added evidence missing"), "acceptance");
  assert.equal(classifyFailure("verdict failed: merge refused by reviewer"), "work-class");
  assert.equal(classifyFailure("watchdog: killed after deadline"), "watchdog");
  assert.equal(classifyFailure("HTTP 429 Too many requests"), "transport");
  assert.equal(classifyFailure("ECONNRESET on stream"), "transport");
  assert.equal(classifyFailure("something unprecedented"), "other");
  assert.equal(classifyFailure(""), null);
  assert.deepEqual(classifyKey("s1-t1-work~retry2"), ["retry", "retry"]);
  assert.deepEqual(classifyKey("s1-t1-work-rework1"), ["rework", "rework"]);
  assert.deepEqual(classifyKey("s1-t1-work-report-repair"), ["report-repair", "repair"]);
  assert.deepEqual(classifyKey("s1-t2-merge"), ["merge", "base"]);
  assert.equal(roleFromKey("s1-t1-review"), "reviewer");
  assert.equal(roleFromKey("s1-t1-merge"), "integrator");
  assert.equal(roleFromKey("campaign-analytics"), "curator");
  assert.equal(roleFromKey("s1-t2-work"), "worker");
  assert.equal(fmtDur(null), "?", "unknown duration stays '?'");
  assert.equal(fmtDur(60000), "1m00s");
  assert.equal(fmtDur(3723000), "1h02m03s");
});

test("qa6: merger brief rebases onto main before the squash - conflicts resolve at rebase, auto-evidence covers the rebase", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ worktree: "D:/arena/wt-t1-task-1" })),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const merge = runs.spec(K.merge).spec.task;
  assert.ok(/workflows\/merge-branch\.mjs/.test(merge), "CLI performs collapse, rebase, and squash");
  assert.ok(/exit 2/.test(merge) && /ours being the new base/.test(merge), "conflict prompt gives exit-2 instructions");
});

// --- unawaited-launch tracker emulation (pi-subagents scripted-workflow contract) ---
// The sandbox wraps every runs.run promise in an observation tracker: a launch counts
// as AWAITED only when its promise chain is observed by an ACTIVE consumer - a native
// await/thenable assimilation or a Promise.all/race/allSettled/any aggregate - while a
// script-level .then attachment alone does NOT consume. A bare new Promise fed through
// a resolve() closure is invisible to the tracker: the workflow then fails at
// completion with 'unawaited runs.run launches' AFTER all children completed (live
// wave-4 run 40fa9647: 8/8 children completed, receipt failed with s1-t1-review,
// s1-t1-merge, s1-t2-review, s1-t2-merge unawaited; the return value and the
// campaign-analytics retro write were lost with it). This emulation mirrors those
// semantics with a global Promise subclass swapped in for the campaign duration:
//   - .then whose stack carries workflow (eval) frames = script attachment: recorded
//     as a flows-into edge, NOT consumed;
//   - .then with no script frames = engine/native assimilation (await, thenable-job,
//     builtin internals): consumes the receiver and everything that flowed INTO it;
//   - Promise.all/race/allSettled/any record input->aggregate edges; consuming the
//     aggregate consumes its inputs.
// runTrackedCampaign returns { out, unawaited } - unawaited lists the launch keys that
// finished the campaign without ever being consumed.
async function runTrackedCampaign(args, routes, state) {
  const runs = makeRuns(routes);
  const NativePromise = Promise;
  const launches = new Map(); // tracked root promise -> launch key
  const deps = new Map(); // promise -> Set of promises it depends on (flows INTO it)
  const consumed = new Set();
  const addDep = (consumer, dependency) => {
    if (!dependency || typeof dependency.then !== "function") return;
    if (!deps.has(consumer)) deps.set(consumer, new Set());
    deps.get(consumer).add(dependency);
  };
  // Consumption propagates DOWN from an active consumer (await/combinator) through
  // everything it depends on - matching the tracker's "recursively consumes
  // dependencies". A chain that merely assimilated another (callback return) is NOT
  // itself a consumer: it must first be consumed from above (wave-4 mergeChain lesson).
  const consumeDown = (start) => {
    const stack = [start];
    while (stack.length) {
      const node = stack.pop();
      if (consumed.has(node)) continue;
      consumed.add(node);
      const ds = deps.get(node);
      if (ds) for (const d of ds) if (!consumed.has(d)) stack.push(d);
    }
  };
  const observeAggregate = (agg, items) => {
    for (const it of items) addDep(agg, it);
    return agg;
  };
  class ObservedPromise extends NativePromise {
    constructor(executor) {
      // The raw resolving functions are tagged with the promise AFTER super() returns
      // (the executor itself is invoked with this === undefined in strict mode), so a
      // resolve-thenable job (q.then(resX) after a callback returned q) can be told
      // apart from a root await: the job only links q into X (X depends on q); only
      // an UNTAGGED native .then is a real consumer.
      let rawResolve, rawReject;
      super(function (res, rej) {
        rawResolve = res;
        rawReject = rej;
        executor(function (v) {
          if (v && typeof v.then === "function") addDep(this, v);
          res(v);
        }, rej);
      });
      try { Object.defineProperty(rawResolve, "__obsFor", { value: this }); } catch (e) {}
      try { Object.defineProperty(rawReject, "__obsFor", { value: this }); } catch (e) {}
    }
    then(onOk, onErr) {
      const derived = super.then(onOk, onErr);
      addDep(derived, this);
      const target = (onOk && onOk.__obsFor) || (onErr && onErr.__obsFor) || undefined;
      if (target) {
        addDep(target, this); // resolve-thenable job: target assimilated this chain
      } else if (!/\bat eval\b/.test(String(new Error().stack || ""))) {
        // Engine/native root assimilation (await, builtin internals): no eval frame.
        consumeDown(this);
      }
      return derived;
    }
    catch(onErr) { return this.then(undefined, onErr); }
    finally(fn) {
      const derived = super.finally(fn);
      addDep(derived, this);
      consumeDown(this);
      return derived;
    }
    static all(items) { return observeAggregate(super.all([...items]), items); }
    static allSettled(items) { return observeAggregate(super.allSettled([...items]), items); }
    static race(items) { return observeAggregate(super.race([...items]), items); }
    static any(items) { return observeAggregate(super.any([...items]), items); }
  }
  const nativeRun = runs.run;
  const trackedRuns = Object.assign(Object.create(runs), {
    run: function (key, spec) {
      const root = ObservedPromise.resolve(nativeRun.call(runs, key, spec));
      launches.set(root, key);
      return root;
    },
  });
  globalThis.Promise = ObservedPromise;
  let out;
  try {
    out = await runCampaign(args, trackedRuns, state);
  } finally {
    globalThis.Promise = NativePromise;
  }
  const unawaited = [];
  for (const [root, key] of launches) if (!consumed.has(root)) unawaited.push(key);
  return { out, unawaited };
}

T("wide wave unawaited-launch contract: 2 bd-epic leaves, one sprint, no deps - all work->review->merge chains consumed, normal epic-closed stop", async () => {
  // Wave-4 shape (run 40fa9647): sprintTasks 2, maxParallel 2, two sibling leaves
  // without deps -> parallel branch: 2 work + 2 review + 2 merge + s2-boundary +
  // campaign-analytics. The post-phase chains used to detach from the awaited graph
  // (bare new Promise + resolve() closure) and the receipt failed AFTER all children
  // completed; the stop must instead be the normal epic-closed resonance.
  const routes = [
    { match: K.work, handle: ok(workOut(), 3) },
    { match: K.review, handle: ok(reviewOk(true), 2) },
    { match: K.merge, handle: ok(mergeOut({ bd_closed: true })) },
    { match: K.boundary, handle: ok({ cleaned: [], leaves: [falconLeaf("fal-a", { open: false }), falconLeaf("fal-b", { open: false })] }) },
    { match: /^epic-close$/, handle: ok({ cleaned: [], closed: [{ id: "t-fal.1", closed: true }], leaves: [] }) },
  ];
  const { out, unawaited } = await runTrackedCampaign(baseArgs({
    taskSource: "bd-epic", bdEpic: "t-fal.1", doneWhen: "bd-epic-closed",
    sprintTasks: 2, maxParallel: 2, maxSprints: 3,
    bdTasks: [falconLeaf("fal-a"), falconLeaf("fal-b")],
  }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.deepEqual(unawaited.sort(), [], "unawaited launches: " + JSON.stringify(unawaited) + " - post-phase chains must be threaded into the awaited graph");
  assert.equal(res.stopReason, "epic-closed", "normal stop resonance, not a tracker failure: " + res.stopReason);
  assert.equal(res.status, "completed");
  assert.ok(res.tasks.every((r) => r.verdict === "merged"), "both leaves merged: " + res.tasks.map((r) => r.verdict).join(", "));
  const allStarts = out.events.filter((e) => e.t === "start").map((e) => e.key);
  const starts = allStarts.filter((k) => !K.mainStatus.test(k));
  assert.equal(starts.length, 10, "wave-4 child shape (report-schema writer + 2 work + 2 review + 2 merge + boundary + epic-close + analytics): " + starts.join(", "));
  assert.equal(allStarts.filter((k) => K.mainStatus.test(k)).length, 3, "ISSUE-5 main-copy probes: 1 baseline + 1 pre-merge check per merge: " + allStarts.join(", "));
  assert.ok(starts.includes("epic-close"), "engine explicitly closes completed bd epic");
  // Criterion (2): the analytics archiver is the LAST child - the retro write happens
  // only after every merge child completed, and its result is carried to the return.
  const analyticsAt = finishedOk(out.events, K.analytics);
  const lastMergeAt = Math.max(finishedOk(out.events, /s1-t1-merge/), finishedOk(out.events, /s1-t2-merge/));
  assert.ok(analyticsAt > lastMergeAt, "campaign-analytics runs strictly after both merges finished");
  assert.ok(res.analytics && res.analytics.summaryLine, "analytics result carried in the workflow return: " + JSON.stringify(res.analytics));
});

T("wide wave curator mode: 2 sibling tasks in wave 1 - post-phase chains consumed, analytics after merges", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1), task(2)])),
    work: ok(workOut(), 3),
    review: ok(reviewOk(true), 2),
  });
  const { out, unawaited } = await runTrackedCampaign(baseArgs({ sprintTasks: 2, maxParallel: 2 }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.deepEqual(unawaited.sort(), [], "unawaited launches: " + JSON.stringify(unawaited));
  const { res } = out;
  assert.equal(res.stopReason, "stop-criteria (retro)");
  assert.ok(res.tasks.every((r) => r.verdict === "merged"), "both merged: " + res.tasks.map((r) => r.verdict).join(", "));
  const analyticsAt = finishedOk(out.events, K.analytics);
  const lastMergeAt = Math.max(finishedOk(out.events, /s1-t1-merge/), finishedOk(out.events, /s1-t2-merge/));
  assert.ok(analyticsAt > lastMergeAt, "campaign-analytics runs strictly after both merges finished");
});

T("serial path (single-task wave) under tracker emulation: every launch consumed, serial schedule kept", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
  });
  const { out, unawaited } = await runTrackedCampaign(baseArgs({ sprintTasks: 1 }), routes, makeState());
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.deepEqual(unawaited.sort(), [], "unawaited launches: " + JSON.stringify(unawaited));
  const { res } = out;
  assert.equal(res.tasks[0].verdict, "merged");
  assert.equal(res.stopReason, "stop-criteria (retro)");
  // serial scheduling: the review starts only after the work child finished
  const workOk = finishedOk(out.events, K.work);
  const reviewStart = started(out.events, K.review);
  assert.ok(reviewStart > workOk, "serial wave: review waits for work");
});

// --- R1: report self-check (workflows/report-check.mjs) + honest noStagedFiles -------------
// The engine serializes its inline report schemas to <journalDir>/report-schema.json at campaign
// start; the work/rework/merge briefs carry the checker call; the checker validates a draft.
const REPORT_CHECK = pathMod.join(pathMod.dirname(fileURLToPath(import.meta.url)), "..", "workflows", "report-check.mjs");
const SCHEMA_MARK = "JSON CONTENT:\n";
const schemaMapOf = (brief) => JSON.parse(brief.slice(brief.indexOf(SCHEMA_MARK) + SCHEMA_MARK.length));

T("contract: campaign start writes the report schemas to <journalDir>/report-schema.json BEFORE the first work child (R1)", async () => {
  const runs = makeRuns(happyRoutes({ curator: ok(curatorOut(true, [task(1)])) }));
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const w = runs.spec(K.reportSchema);
  assert.ok(w, "the report-schema writer child launched");
  assert.ok(w.spec.task.includes(".agile-js-test/report-schema.json"), "writes to <journalDir>/report-schema.json");
  assert.ok(started(out.events, K.reportSchema) < started(out.events, K.work), "written before the first work child");
  const map = schemaMapOf(w.spec.task);
  assert.deepEqual(map.work, runs.spec(K.work).spec.outputSchema, "serialized work schema == the schema the work children are validated against");
  assert.deepEqual(map.merge, runs.spec(K.merge).spec.outputSchema, "serialized merge schema == the merge child schema");
});

T("contract: work, rework and merge briefs each carry exactly one report self-check call (R1)", async () => {
  let reviews = 0;
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    review: async () => ok(reviewOk(reviews++ > 0))(), // first verdict rejects -> one rework child
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs({ reportCheckScript: REPORT_CHECK }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const briefs = [["work", runs.spec(K.work).spec.task], ["rework", runs.spec(K.rework).spec.task], ["merge", runs.spec(K.merge).spec.task]];
  for (const [kind, brief] of briefs) {
    const calls = brief.split("\n").filter((l) => l.includes("report-check.mjs"));
    assert.equal(calls.length, 1, kind + ": exactly one checker call line");
    assert.ok(calls[0].includes("node " + REPORT_CHECK), kind + ": runs the reportCheckScript arg");
    assert.ok(calls[0].includes("--kind " + kind), kind + ": --kind " + kind);
    assert.ok(calls[0].includes("--schema ") && calls[0].includes("report-schema.json"), kind + ": --schema <journalDir>/report-schema.json");
    assert.ok(calls[0].includes("--draft "), kind + ": --draft");
  }
  assert.ok(briefs[0][1].includes("--branch agile/") && briefs[1][1].includes("--branch agile/"), "work/rework checker line carries the branch");
});

// The checker reads the schema the ENGINE serializes - captured from a real (fake-runs) campaign.
async function engineSchemaFile() {
  const runs = makeRuns(happyRoutes({ curator: ok(curatorOut(true, [task(1)])) }));
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const dir = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), "r1-schema-"));
  const file = pathMod.join(dir, "report-schema.json");
  fsSync.writeFileSync(file, JSON.stringify(schemaMapOf(runs.spec(K.reportSchema).spec.task)));
  return file;
}
function makeRepo() {
  const dir = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), "r1-repo-"));
  const git = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", timeout: 60000, input: "" });
  git("init");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init");
  return { dir, head: git("rev-parse", "HEAD").stdout.trim() };
}
function runCheck(args) {
  const r = spawnSync(process.execPath, [REPORT_CHECK, ...args], { encoding: "utf8", timeout: 60000, input: "" });
  return { status: r.status, lines: r.stdout.split(/\r?\n/).filter(Boolean) };
}
function draftFile(obj) {
  const f = pathMod.join(fsSync.mkdtempSync(pathMod.join(os.tmpdir(), "r1-draft-")), "draft.json");
  fsSync.writeFileSync(f, JSON.stringify(obj));
  return f;
}

T("report-check: a valid work draft against the engine schema exits 0 (R1)", async () => {
  const schema = await engineSchemaFile();
  const repo = makeRepo();
  const draft = draftFile(workOut({ head: repo.head, branch: "agile/r1-x", worktree: repo.dir }));
  const r = runCheck(["--schema", schema, "--kind", "work", "--draft", draft, "--worktree", repo.dir, "--branch", "agile/r1-x"]);
  assert.equal(r.status, 0, "clean draft exits 0: " + JSON.stringify(r.lines));
  assert.deepEqual(r.lines, ["report-check: ok (kind=work)"]);
});

T("report-check: a valid merge draft exits 0 (R1)", async () => {
  const schema = await engineSchemaFile();
  const draft = draftFile({ merged: true, checks_ok: true, journal_written: true, merge_commit: "abc1234", note: "" });
  const r = runCheck(["--schema", schema, "--kind", "merge", "--draft", draft]);
  assert.equal(r.status, 0, "clean merge draft exits 0: " + JSON.stringify(r.lines));
});

T("report-check: head 'x', no worktree, no what_done, noStagedFiles=true over a dirty worktree -> exact per-field lines, exit 1 (R1)", async () => {
  const schema = await engineSchemaFile();
  const repo = makeRepo();
  fsSync.writeFileSync(pathMod.join(repo.dir, "dirty.txt"), "x"); // untracked = dirty for `git status --short`
  const bad = workOut({ head: "x", branch: "agile/r1-x", noStagedFiles: true });
  delete bad.what_done;
  delete bad.worktree;
  const r = runCheck(["--schema", schema, "--kind", "work", "--draft", draftFile(bad), "--worktree", repo.dir, "--branch", "agile/r1-x"]);
  assert.equal(r.status, 1, "problems exit 1");
  assert.deepEqual(r.lines, [
    "what_done: обязательное поле отсутствует",
    "worktree: обязательное поле отсутствует",
    "head: ожидалось значение по шаблону ^[0-9a-f]{40}$, получено 'x'",
    "noStagedFiles: true, но в worktree незакоммиченные изменения (1): ?? dirty.txt",
  ]);
});

T("report-check: an honest noStagedFiles=false over a dirty worktree is a named line, not a schema error (R1)", async () => {
  const schema = await engineSchemaFile();
  const repo = makeRepo();
  fsSync.writeFileSync(pathMod.join(repo.dir, "dirty.txt"), "x");
  const draft = draftFile(workOut({ head: repo.head, branch: "agile/r1-x", worktree: repo.dir, noStagedFiles: false }));
  const r = runCheck(["--schema", schema, "--kind", "work", "--draft", draft, "--worktree", repo.dir, "--branch", "agile/r1-x"]);
  assert.equal(r.status, 1);
  assert.deepEqual(r.lines, ["noStagedFiles: false - в worktree незакоммиченные изменения (1): закоммить или откати и поставь true"]);
});

T("R1: an honest noStagedFiles=false report passes the repair schema and the in-script acceptance check (forced const removed)", async () => {
  const routes = happyRoutes({
    curator: ok(curatorOut(true, [task(1)])),
    work: ok(workOut({ validationOutput: [] })), // 'schema-missing: validationOutput' -> report-repair
    reportRepair: ok(workOut({ noStagedFiles: false, head: "7777777777777777777777777777777777777777" })),
  });
  const runs = makeRuns(routes);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(K.reportRepair), 1, "the repair child ran");
  assert.ok(res.log.some((l) => l.includes("report repaired from branch state")), "the honest false report was accepted as the repair: " + JSON.stringify(res.log));
  assert.ok(!res.log.some((l) => l.includes("report-repair failed")), "no repair rejection");
  assert.equal(runs.spec(K.reportRepair).spec.outputSchema.properties.noStagedFiles.const, undefined, "no forced const in the repair schema");
  assert.equal(res.tasks[0].verdict, "merged");
});

T("merge CLI exit-2 brief and already-closed bd leaf contract", async () => {
  const closedRoutes = makeRuns([]);
  await runCampaign(baseArgs({ taskSource: "bd-epic", bdEpic: "epic.1", bdTasks: [falconLeaf("fal-closed", { open: false })] }), closedRoutes);
  assert.equal(closedRoutes.count(K.merge), 0, "already-closed bd leaf is not launched for merge, so no --bd-leaf is emitted");
  const routes = happyRoutes({ curator: ok(curatorOut(true, [task(1)])) });
  const runs = makeRuns(routes);
  await runCampaign(baseArgs(), runs);
  const merge = runs.spec(K.merge).spec.task;
  assert.ok(/workflows\/merge-branch\.mjs/.test(merge), "merge command invokes CLI");
  assert.ok(/exit 2/.test(merge), "brief tells child to resolve exit-2 conflicts");
  assert.ok(/sibling-aware editor/.test(merge), "conflict handler preserves sibling intent");
  assert.ok(/ours being the new base/.test(merge), "rebase ours semantics are explicit");
  assert.ok(/--test-command/.test(merge), "CLI command includes the full suite gate");
  assert.ok(/--main-dir "."/.test(merge), "CLI main directory is process-free and relative to repository root");
  assert.ok(!/process\.cwd/.test(merge), "sandbox brief does not depend on process");
});

T("mergeBranch conflict fixture: exit 2 reports conflicts and leaves integration HEAD untouched", async () => {
  const root = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), "merge-branch-conflict-"));
  const main = pathMod.join(root, "repo"), wt = pathMod.join(root, "worker-wt");
  fsSync.mkdirSync(main);
  const git = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    git(main, "init", "-b", "main");
    git(main, "config", "user.email", "test@example.com"); git(main, "config", "user.name", "Contract Test");
    fsSync.writeFileSync(pathMod.join(main, "same.txt"), "base\n");
    git(main, "add", "."); git(main, "commit", "-m", "base");
    git(main, "switch", "-c", "worker");
    fsSync.writeFileSync(pathMod.join(main, "same.txt"), "worker\n");
    git(main, "commit", "-am", "worker change");
    const approvedSha = git(main, "rev-parse", "HEAD");
    git(main, "switch", "main");
    fsSync.writeFileSync(pathMod.join(main, "same.txt"), "main\n"); git(main, "commit", "-am", "main change");
    git(main, "worktree", "add", wt, "worker");
    const mainBefore = git(main, "rev-parse", "HEAD");
    const result = await mergeBranch({ mainDir: main, mainBranch: "main", worktree: wt, branch: "worker", approvedSha, testCommand: "true" });
    assert.equal(result.status, 2);
    assert.deepEqual(result.data.conflictFiles, ["same.txt"]);
    assert.equal(git(main, "rev-parse", "HEAD"), mainBefore, "conflict path made no integration commit");
    assert.equal(git(main, "status", "--porcelain"), "", "integration worktree remains untouched");
    fsSync.writeFileSync(pathMod.join(wt, "same.txt"), "worker + main\n");
    git(wt, "add", "same.txt");
    const continued = spawnSync("git", ["-c", "core.editor=true", "rebase", "--continue"], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(continued.status, 0, `rebase --continue: ${continued.stderr}`);
    const resumed = await mergeBranch({ mainDir: main, mainBranch: "main", worktree: wt, branch: "worker", approvedSha, testCommand: "true" });
    assert.equal(resumed.status, 0, "same CLI request resumes completed rebase");
    assert.equal(resumed.data.merged, true);
  } finally { fsSync.rmSync(root, { recursive: true, force: true }); }
});

T("mergeBranch clean fixture: deterministic CLI squashes after full test command", async () => {
  const root = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), "merge-branch-clean-"));
  const main = pathMod.join(root, "repo"), wt = pathMod.join(root, "worker-wt");
  fsSync.mkdirSync(main);
  const git = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim();
  };
  try {
    git(main, "init", "-b", "main"); git(main, "config", "user.email", "test@example.com"); git(main, "config", "user.name", "Contract Test");
    fsSync.writeFileSync(pathMod.join(main, "base.txt"), "base\n"); git(main, "add", "."); git(main, "commit", "-m", "base");
    git(main, "switch", "-c", "worker"); fsSync.writeFileSync(pathMod.join(main, "new.txt"), "change\n"); git(main, "add", "."); git(main, "commit", "-m", "worker change");
    const approvedSha = git(main, "rev-parse", "HEAD"); git(main, "switch", "main"); git(main, "worktree", "add", wt, "worker");
    const result = await mergeBranch({ mainDir: main, mainBranch: "main", worktree: wt, branch: "worker", approvedSha, testCommand: "true" });
    assert.equal(result.status, 0); assert.equal(result.data.merged, true);
    assert.equal(result.data.bdClosed, false, "without --bd-leaf the CLI skips bd operations");
    assert.equal(git(main, "rev-list", "--count", "main~1..main"), "1");
    assert.equal(git(main, "status", "--porcelain"), "");
  } finally { fsSync.rmSync(root, { recursive: true, force: true }); }
});

T("mergeBranch ignored .beads is closed without an export commit", async () => {
  if (process.platform === "win32") return; // spawnSync cannot execute a fake bd without shell on win32
  const root = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), "merge-branch-ignored-beads-"));
  const main = pathMod.join(root, "repo"), wt = pathMod.join(root, "worker-wt"), bin = pathMod.join(root, "bin");
  fsSync.mkdirSync(main); fsSync.mkdirSync(bin);
  const git = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim();
  };
  const oldPath = process.env.PATH;
  try {
    const bd = pathMod.join(bin, "bd");
    fsSync.writeFileSync(bd, "#!/bin/sh\nexit 0\n");
    fsSync.chmodSync(bd, 0o755);
    process.env.PATH = `${bin}:${oldPath || ""}`;
    git(main, "init", "-b", "main"); git(main, "config", "user.email", "test@example.com"); git(main, "config", "user.name", "Contract Test");
    fsSync.writeFileSync(pathMod.join(main, ".gitignore"), ".beads/\n");
    fsSync.writeFileSync(pathMod.join(main, "base.txt"), "base\n"); git(main, "add", "."); git(main, "commit", "-m", "base");
    git(main, "switch", "-c", "worker"); fsSync.writeFileSync(pathMod.join(main, "new.txt"), "change\n"); git(main, "add", "."); git(main, "commit", "-m", "worker change");
    const approvedSha = git(main, "rev-parse", "HEAD"); git(main, "switch", "main"); git(main, "worktree", "add", wt, "worker");
    const result = await mergeBranch({ mainDir: main, mainBranch: "main", worktree: wt, branch: "worker", approvedSha, testCommand: "true", bdLeaf: "leaf-1" });
    assert.equal(result.status, 0); assert.equal(result.data.merged, true);
    assert.equal(result.data.bdClosed, true, "ignored .beads: close alone sets closed=true");
    assert.equal(git(main, "rev-list", "--count", "main~1..main"), "1", "no chore(bd) export commit when .beads is ignored");
    assert.equal(git(main, "status", "--porcelain"), "");
  } finally { process.env.PATH = oldPath; fsSync.rmSync(root, { recursive: true, force: true }); }
});

T("mergeBranch bd spawn error is best-effort after committed merge", async () => {
  const root = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), "merge-branch-bd-error-"));
  const main = pathMod.join(root, "repo"), wt = pathMod.join(root, "worker-wt"), bin = pathMod.join(root, "bin");
  fsSync.mkdirSync(main); fsSync.mkdirSync(bin);
  const git = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim();
  };
  const oldPath = process.env.PATH;
  try {
    // This executable cannot be spawned because its interpreter is missing (ENOENT).
    const bd = pathMod.join(bin, process.platform === "win32" ? "bd.cmd" : "bd");
    fsSync.writeFileSync(bd, "#!/definitely-missing-bd-interpreter\n");
    if (process.platform !== "win32") fsSync.chmodSync(bd, 0o755);
    process.env.PATH = `${bin}${pathMod.delimiter}${oldPath || ""}`;
    git(main, "init", "-b", "main"); git(main, "config", "user.email", "test@example.com"); git(main, "config", "user.name", "Contract Test");
    fsSync.writeFileSync(pathMod.join(main, "base.txt"), "base\n"); git(main, "add", "."); git(main, "commit", "-m", "base");
    git(main, "switch", "-c", "worker"); fsSync.writeFileSync(pathMod.join(main, "new.txt"), "change\n"); git(main, "add", "."); git(main, "commit", "-m", "worker change");
    const approvedSha = git(main, "rev-parse", "HEAD"); git(main, "switch", "main"); git(main, "worktree", "add", wt, "worker");
    const result = await mergeBranch({ mainDir: main, mainBranch: "main", worktree: wt, branch: "worker", approvedSha, testCommand: "true", bdLeaf: "leaf-1" });
    assert.equal(result.status, 0, "bd spawn error does not change merge success");
    assert.equal(result.data.merged, true);
    assert.equal(result.data.bdClosed, false);
    assert.equal(git(main, "rev-list", "--count", "main~1..main"), "1", "squash commit remains on main");
    assert.equal(git(main, "status", "--porcelain"), "");
  } finally { process.env.PATH = oldPath; fsSync.rmSync(root, { recursive: true, force: true }); }
});

// --- ISSUE-7: gate environment (a worker's PI_SUBAGENT_* must not poison the merge gate) ---
// Fixture: main + one-commit worker branch ready to merge; each test supplies its own testCommand.
function gateFixture(prefix) {
  const root = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), prefix));
  const main = pathMod.join(root, "repo"), wt = pathMod.join(root, "worker-wt");
  fsSync.mkdirSync(main);
  const git = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim();
  };
  git(main, "init", "-b", "main"); git(main, "config", "user.email", "test@example.com"); git(main, "config", "user.name", "Contract Test");
  fsSync.writeFileSync(pathMod.join(main, "base.txt"), "base\n"); git(main, "add", "."); git(main, "commit", "-m", "base");
  git(main, "switch", "-c", "worker"); fsSync.writeFileSync(pathMod.join(main, "new.txt"), "change\n"); git(main, "add", "."); git(main, "commit", "-m", "worker change");
  const approvedSha = git(main, "rev-parse", "HEAD"); git(main, "switch", "main"); git(main, "worktree", "add", wt, "worker");
  return { root, main, wt, approvedSha };
}
const restoreEnv = (saved) => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

T("ISSUE-7 unit: mergeBranch gate env drops PI_SUBAGENT_CHILD/DEPTH, keeps PATH/HOME, leaves the merger's own env intact", async () => {
  const fx = gateFixture("merge-gate-env-");
  const dump = pathMod.join(fx.root, "dump-gate-env.mjs"), out = pathMod.join(fx.root, "gate-env.json");
  fsSync.writeFileSync(dump, `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ PATH: process.env.PATH ?? null, HOME: process.env.HOME ?? null, PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD ?? null, PI_SUBAGENT_DEPTH: process.env.PI_SUBAGENT_DEPTH ?? null }));\n`);
  const saved = { PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD, PI_SUBAGENT_DEPTH: process.env.PI_SUBAGENT_DEPTH, HOME: process.env.HOME };
  process.env.PI_SUBAGENT_CHILD = "1"; process.env.PI_SUBAGENT_DEPTH = "2"; process.env.HOME = fx.root;
  try {
    const result = await mergeBranch({ mainDir: fx.main, mainBranch: "main", worktree: fx.wt, branch: "worker", approvedSha: fx.approvedSha, testCommand: `"${process.execPath}" "${dump}"` });
    assert.equal(result.status, 0); assert.equal(result.data.merged, true);
    const env = JSON.parse(fsSync.readFileSync(out, "utf8"));
    assert.equal(env.PI_SUBAGENT_CHILD, null, "gate spawn env has no PI_SUBAGENT_CHILD");
    assert.equal(env.PI_SUBAGENT_DEPTH, null, "gate spawn env has no PI_SUBAGENT_DEPTH");
    assert.equal(env.PATH, process.env.PATH ?? null, "PATH kept in the gate env");
    assert.equal(env.HOME, fx.root, "HOME kept in the gate env");
    assert.equal(process.env.PI_SUBAGENT_CHILD, "1", "the merger's own process.env is not modified");
  } finally { restoreEnv(saved); fsSync.rmSync(fx.root, { recursive: true, force: true }); }
});

T("ISSUE-7 carrier: a gate script that fails on an inherited PI_SUBAGENT_CHILD passes under the merger gate", async () => {
  const fx = gateFixture("merge-gate-carrier-");
  const carrier = pathMod.join(fx.root, "carrier-gate.mjs");
  fsSync.writeFileSync(carrier, "if (process.env.PI_SUBAGENT_CHILD || process.env.PI_SUBAGENT_DEPTH) { console.error('PI_SUBAGENT_* leaked into the gate'); process.exit(1); }\n");
  const saved = { PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD, PI_SUBAGENT_DEPTH: process.env.PI_SUBAGENT_DEPTH };
  process.env.PI_SUBAGENT_CHILD = "1"; process.env.PI_SUBAGENT_DEPTH = "1";
  try {
    const result = await mergeBranch({ mainDir: fx.main, mainBranch: "main", worktree: fx.wt, branch: "worker", approvedSha: fx.approvedSha, testCommand: `"${process.execPath}" "${carrier}"` });
    assert.equal(result.status, 0, "inherited worker env must not red the gate"); assert.equal(result.data.merged, true);
  } finally { restoreEnv(saved); fsSync.rmSync(fx.root, { recursive: true, force: true }); }
});

// --- ISSUE-5: main-copy isolation (the main working copy is never written by a worker) ------
// The probe answers per key: the campaign baseline sees the starting state, the pre-merge
// probe sees whatever a worker left in main. Nothing here reverts main - it is observed only.
// Content evidence ("<sha> <path>") rides along: a test that alters a dirty file keeps its porcelain line.
function mainProbe(baseline, premerge, baseContent = [], preContent = []) {
  return { match: K.mainStatus, handle: async (spec, key) => {
    const b = /baseline/.test(key);
    return { ok: true, structuredOutput: { lines: b ? baseline : premerge, content: b ? baseContent : preContent } };
  } };
}

T("main-copy isolation: a change in main between baseline and merge blocks the merge, is reported, and is NOT reverted", async () => {
  const runs = makeRuns([
    ...happyRoutes({ curator: ok(curatorOut(true, [task(1)])) }),
    mainProbe([], [" M src/a.txt", "?? stray.txt"]),
  ]);
  const st = makeState();
  const out = await runCampaign(baseArgs(), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(res.tasks[0].verdict, "main-mutated", "the task is refused as a main-copy incident");
  assert.equal(runs.count(K.merge), 0, "the merge child never launches over a mutated main");
  assert.equal(res.counts.merged, 0);
  assert.equal(res.counts.failed, 1, "the incident counts as a failed verdict");
  assert.equal(res.mainIncidents.length, 1, "incident reported in the return");
  assert.deepEqual(res.mainIncidents[0].lines, [" M src/a.txt", "?? stray.txt"], "the offending lines are named");
  assert.ok(res.log.some((l) => /MAIN-COPY INCIDENT/.test(l) && /NOTHING reverted/.test(l)), "incident logged: " + JSON.stringify(res.log));
  assert.equal(runs.keys().filter((k) => /revert|rollback|restore/.test(k)).length, 0, "no rollback child: the evidence stays in main");
  assert.equal(st.store.get("agile-cp").mainIncidents.length, 1, "incident persisted in the checkpoint");
  assert.equal(res.status, "failed");
});

const SHA_A = "a".repeat(40), SHA_B = "b".repeat(40), SHA_C = "c".repeat(40), SHA_D = "d".repeat(40);

T("main-copy isolation: a PRE-EXISTING dirty tracked file overwritten during the campaign (porcelain line unchanged) blocks the merge and is NOT reverted", async () => {
  const runs = makeRuns([
    ...happyRoutes({ curator: ok(curatorOut(true, [task(1)])) }),
    mainProbe([" M src/a.txt"], [" M src/a.txt"], [SHA_A + " src/a.txt"], [SHA_B + " src/a.txt"]),
  ]);
  const st = makeState();
  const out = await runCampaign(baseArgs(), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(res.tasks[0].verdict, "main-mutated", "same porcelain line, different bytes: a main-copy incident");
  assert.equal(runs.count(K.merge), 0, "the merge child never launches over an altered main");
  assert.deepEqual(res.mainIncidents[0].lines, ["src/a.txt (content changed since campaign start)"], "the altered path is named");
  assert.equal(runs.keys().filter((k) => /revert|rollback|restore/.test(k)).length, 0, "no rollback child: the evidence stays in main");
  assert.deepEqual(st.store.get("agile-cp").mainBaselineContent, [SHA_A + " src/a.txt"], "the campaign-start evidence is not overwritten by the pre-merge probe");
  assert.equal(res.status, "failed");
});

T("main-copy isolation: a PRE-EXISTING untracked file rewritten during the campaign (porcelain line unchanged) blocks the merge", async () => {
  const runs = makeRuns([
    ...happyRoutes({ curator: ok(curatorOut(true, [task(1)])) }),
    mainProbe(["?? notes/new.txt"], ["?? notes/new.txt"], [SHA_C + " notes/new.txt"], [SHA_D + " notes/new.txt"]),
  ]);
  const out = await runCampaign(baseArgs(), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(res.tasks[0].verdict, "main-mutated", "a rewritten untracked dirty file is an incident");
  assert.equal(runs.count(K.merge), 0);
  assert.deepEqual(res.mainIncidents[0].lines, ["notes/new.txt (content changed since campaign start)"]);
});

T("main-copy isolation: pre-existing baseline dirt and engine-owned safe-list paths are NOT incidents; the baseline is recorded", async () => {
  const baseline = [" M notes.txt", "?? nul", " M .beads/issues.jsonl"];
  const baseContent = [SHA_A + " notes.txt", SHA_B + " nul", SHA_C + " .beads/issues.jsonl"];
  // safe-listed .beads changed bytes (bd export) and new engine files: still NOT incidents; the unchanged dirt keeps its sha
  const premerge = baseline.concat(["?? .agile-js-test/sprint-1.jsonl", "?? .ai/sdd/specs/x/tasks.md", "?? ledger-ag-task-1/"]);
  const preContent = [SHA_A + " notes.txt", SHA_B + " nul", SHA_D + " .beads/issues.jsonl"];
  const runs = makeRuns([
    ...happyRoutes({ curator: ok(curatorOut(true, [task(1)])) }),
    mainProbe(baseline, premerge, baseContent, preContent),
  ]);
  const st = makeState();
  const out = await runCampaign(baseArgs(), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(res.tasks[0].verdict, "merged", "unchanged dirt and safe-listed writes do not block the merge");
  assert.equal(runs.count(K.merge), 1);
  assert.deepEqual(res.mainIncidents, [], "no incident");
  assert.deepEqual(st.store.get("agile-cp").mainBaseline, baseline, "baseline persisted in the checkpoint");
  assert.deepEqual(st.store.get("agile-cp").mainBaselineContent, baseContent, "content evidence persisted in the checkpoint");
  const probeBrief = runs.spec(/^main-baseline/).spec.task;
  assert.ok(/--untracked-files=all/.test(probeBrief) && /git hash-object -- <path>/.test(probeBrief), "probe brief asks for per-path content evidence (untracked files expanded)");
  assert.ok(res.log.some((l) => /main-copy baseline: 3 pre-existing change/.test(l)), "baseline logged: " + JSON.stringify(res.log));
});

T("main-copy isolation: resume keeps the campaign baseline (no re-probe) and still catches a NEW mutation only", async () => {
  const st = makeState({ "agile-cp": { phase: "running", generation: 2, mainBaseline: [" M legacy.txt"], mainBaselineContent: [SHA_A + " legacy.txt"] } });
  const runs = makeRuns([
    ...happyRoutes({ curator: ok(curatorOut(true, [task(1)])) }),
    mainProbe([], [" M legacy.txt", " M src/a.txt"], [], [SHA_A + " legacy.txt", SHA_B + " src/a.txt"]),
  ]);
  const out = await runCampaign(baseArgs(), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(runs.count(/^main-baseline/), 0, "resume does not re-take the baseline");
  assert.equal(res.tasks[0].verdict, "main-mutated");
  assert.deepEqual(res.mainIncidents[0].lines, [" M src/a.txt"], "only the NEW change is an incident; the pre-campaign legacy dirt is not");
  assert.deepEqual(st.store.get("agile-cp").mainBaseline, [" M legacy.txt"], "the original baseline survives the resume");
  assert.deepEqual(st.store.get("agile-cp").mainBaselineContent, [SHA_A + " legacy.txt"], "the original content evidence survives the resume");
});

T("main-copy isolation: a resumed checkpoint WITHOUT content evidence fails closed on its dirty baseline paths", async () => {
  const st = makeState({ "agile-cp": { phase: "running", generation: 2, mainBaseline: [" M legacy.txt"] } });
  const runs = makeRuns([
    ...happyRoutes({ curator: ok(curatorOut(true, [task(1)])) }),
    mainProbe([], [" M legacy.txt"], [], [SHA_A + " legacy.txt"]),
  ]);
  const out = await runCampaign(baseArgs(), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(out.res.tasks[0].verdict, "main-mutated", "no recorded sha for a dirty baseline path: refused, never a silent pass");
  assert.deepEqual(out.res.mainIncidents[0].lines, ["legacy.txt (no content evidence recorded at campaign start)"]);
});

T("main-copy isolation: a NEW .beads/ path other than issues.jsonl is NOT engine-owned: it is an incident, the merge is refused, nothing is reverted", async () => {
  const runs = makeRuns([
    ...happyRoutes({ curator: ok(curatorOut(true, [task(1)])) }),
    mainProbe([], [" M .beads/config.yaml", "?? .beads/notes.txt"]),
  ]);
  const st = makeState();
  const out = await runCampaign(baseArgs(), runs, st);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  const { res } = out;
  assert.equal(res.tasks[0].verdict, "main-mutated", "a .beads/ path other than .beads/issues.jsonl is a main-copy incident");
  assert.equal(runs.count(K.merge), 0, "the merge child never launches over the mutated main");
  assert.deepEqual(res.mainIncidents[0].lines, [" M .beads/config.yaml", "?? .beads/notes.txt"], "the offending .beads/ paths are named");
  assert.ok(res.log.some((l) => /MAIN-COPY INCIDENT/.test(l) && /\.beads\/config\.yaml/.test(l)), "incident logged naming the path: " + JSON.stringify(res.log));
  assert.equal(runs.keys().filter((k) => /revert|rollback|restore/.test(k)).length, 0, "no rollback child: the evidence stays in main");
  assert.equal(res.status, "failed");
});

T("main-copy isolation: rework and report-repair specs carry the worktree cwd; work-class briefs carry the absolute-path rule", async () => {
  const wt = "D:/arena/wt-t1-task-1";
  let reviewCalls = 0;
  const runs = makeRuns([
    ...happyRoutes({
      curator: ok(curatorOut(true, [task(1)])),
      work: ok(workOut({ worktree: wt })),
      review: async () => { reviewCalls++; return ok(reviewOk(reviewCalls >= 2))(); },
      rework: ok(workOut({ worktree: wt, residualRisks: "none" })), // schema-missing -> report-repair salvage
      reportRepair: ok(workOut({ worktree: wt, head: "5555555555555555555555555555555555555555", what_done: "recovered" })),
    }),
  ]);
  const out = await runCampaign(baseArgs({ reworkLimit: 2 }), runs);
  assert.ok(!out.err, "workflow threw: " + (out.err && out.err.message));
  assert.equal(runs.spec(K.rework).spec.cwd, wt, "rework child is launched inside its worktree");
  assert.equal(runs.spec(K.reportRepair).spec.cwd, wt, "report-repair child is launched inside its worktree");
  assert.equal(runs.spec(K.work).spec.cwd, undefined, "the first work child creates the worktree - no cwd before it exists");
  for (const k of [K.work, K.rework, K.reportRepair]) {
    assert.ok(runs.spec(k).spec.task.includes("ABSOLUTE PATH RULE"), "absolute-path rule in the brief of " + k);
    assert.ok(runs.spec(k).spec.task.includes(wt) || k === K.work, "brief names the worktree for " + k);
  }
});
