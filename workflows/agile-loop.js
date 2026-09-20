// agile-loop.js — sprint-campaign workflow (workflow-script port of pi-agile).
// Fixes the lost-events problem: the script awaits EVERY child; one completion
// receipt carries the whole trace. No observer/event channel.
//
// Judgment moved into children (the ledger-loop-mem pattern):
//   discovery -> curator (approval gate via contact_supervisor) -> per task:
//   worker (gate) -> reviewer -> rework loop -> arbiter/merger -> retro.
// State: in-script + on-disk journal <journalDir>/sprint-*.jsonl (children write).
//
// Args:
//   description    (string, required) campaign goal - what "done" means
//   testCommand    (string, required) host gate; also main-checks after merge
//   discoverCommand(op string) custom discovery command; default = tests baseline
//                  + TODO/HACK/FIXME scan composed by the child
//   constraints    (op string) rules injected into every child
//   sprintTasks    (num, default 3, cap 8) tasks per sprint
//   maxSprints     (num, default 3, cap 20)
//   reworkLimit    (num, default 2, cap 3) reviewer->worker cycles per task
//   mergePolicy    ('confirm'|'auto', default 'confirm') caller confirms merges
//   branchPrefix   (string, default 'agile/') feature-branch prefix
//   journalDir     (string, default '.agile-js') on-disk sprint journal
//   model          (op string) override for every child
const description = String(args.description || "");
const testCommand = String(args.testCommand || "");
const discoverCommand = args.discoverCommand ? String(args.discoverCommand) : "";
const constraints = String(args.constraints || "Follow repo conventions. No drive-by refactors outside the task scope.");
const sprintTasks = Math.min(Math.max(Number(args.sprintTasks) || 3, 1), 8);
const maxSprints = Math.min(Math.max(Number(args.maxSprints) || 3, 1), 20);
const reworkLimit = Math.min(Math.max(Number(args.reworkLimit) || 2, 0), 3);
const mergePolicy = String(args.mergePolicy || "confirm").toLowerCase() === "auto" ? "auto" : "confirm";
const branchPrefix = String(args.branchPrefix || "agile/");
const journalDir = String(args.journalDir || ".agile-js");
const model = args.model || undefined;
// Infra-retry budget: whole-campaign wall clock; children killed by transport
// failures retry with exponential backoff until this deadline, then fail honestly.
const budgetMs = Math.min(Math.max(Number(args.budgetMs) || 14400000, 600000), 86400000);
const deadlineMs = Date.now() + budgetMs;
let retriesTotal = 0;

if (!description) throw new Error("agile-loop: args.description is required");
if (!testCommand) throw new Error("agile-loop: args.testCommand is required (no gate -> no delegation)");

const log = [];
const taskResults = [];

// --- helpers ------------------------------------------------------------------
function childOpts(extra) {
  const o = Object.assign({ agent: "worker", context: "fresh" }, extra || {});
  if (model) o.model = model;
  return o;
}
function outOf(runRes) {
  const so = runRes && runRes.structuredOutput;
  if (so && typeof so === "object") return so;
  const txt = String((runRes && runRes.output) || "");
  const m = txt.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return {};
}
function slugify(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}
function withGate(extra) {
  const o = childOpts(extra);
  if (testCommand) o.gate = testCommand; // conditional: never pass undefined
  // Host-side gate verification inherits the per-tool deadline (default 5m); a 2m+ test
  // suite under load (GPU stand restart, CPU contention) blows past it. Give headroom.
  o.toolTimeoutMs = 600000;
  return o;
}

// --- infra-retry layer --------------------------------------------------------------
// The model backend can flap or restart mid-campaign; a child dying on a transport
// error must not kill the sprint. Retryable = connection / 5xx / engine-crash /
// structured-output-missing family (child died mid-generation or finished in prose).
// Unlimited attempts, exponential backoff capped at 5 min, bounded by deadlineMs.
// Non-retryable failures throw immediately - call-site catch chains keep their
// degrade/abort semantics.
const RETRYABLE_RE = /all connection attempts failed|econn(refused|reset|aborted)|etimedout|eai_again|enotfound|fetch failed|socket hang up|bad gateway|service unavailable|\b50[234]\b|enginecore|engine core|internal server error|overloaded|required structured output was not produced|missing structured_output/i;
const RETRY_DELAYS = [15000, 30000, 60000, 120000, 240000]; // then 300s per attempt, unlimited
function sleepMs(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function runChild(key, spec) {
  // Plain promise-chain retry loop (nested async functions are rejected by the sandbox).
  // runs.run is called at the CHAIN HEAD: the tracker requires direct .then/await
  // registration on the launch promise - wrapping it in Promise.resolve().then(...)
  // makes pi flag the run as "unawaited" and fails the whole workflow at completion.
  // If runs.run ever throws synchronously, attempt() throws before any .then exists;
  // the call-site try/catch handles it (no retry) - same as pre-retry behavior.
  function attempt(n) {
    return runs.run(n === 0 ? key : key + "-r" + (n + 1), spec).then(
      function (res) {
        if (res && res.ok !== false) return res;
        return fail(n, String((res && (res.error || res.output)) || "child run failed"));
      },
      function (e) {
        return fail(n, String((e && e.message) || e));
      }
    );
  }
  function fail(n, errText) {
    const attemptNo = n + 1;
    const now = Date.now();
    if (!RETRYABLE_RE.test(errText) || now + 60000 >= deadlineMs) {
      throw new Error(errText.slice(0, 400));
    }
    retriesTotal++;
    const wait = Math.min(attemptNo <= RETRY_DELAYS.length ? RETRY_DELAYS[attemptNo - 1] : 300000, Math.max(1000, deadlineMs - now - 60000));
    emit("[retry] " + key + " attempt " + attemptNo + ": " + errText.replace(/\s+/g, " ").slice(0, 140) + " - next attempt in " + Math.round(wait / 1000) + "s");
    sleepMs(wait);
    return attempt(attemptNo);
  }
  return attempt(0);
}

// --- shared discipline lines -----------------------------------------------------
const FINAL_MSG = "FINAL MESSAGE DISCIPLINE: your final message must be ONLY the JSON value with EXACTLY the schema keys listed in your instructions. Do NOT emit acceptanceReport or any other key; narrative goes inside string fields.\n";
const ACC_REPORT = "ACCEPTANCE REPORT DISCIPLINE: in the fenced acceptance-report block EVERY entry in criteriaSatisfied[] must include ALL THREE fields: id, status (exactly \"satisfied\", \"not-satisfied\" or \"not-applicable\"), evidence. Never omit status on any entry - especially the second and later ones.\n";
const FACTS = "FACTS DISCIPLINE: state only facts you personally verified this session (ran or read); mark recollections as [unverified]. CITATION RULE: cite only sources you actually opened this session.\n";
const CMDS = "Every long command runs with piped stdin and an explicit timeout; running servers, tests or solvers without piped stdin is a violation. Work incrementally.\n";
const GIT_RULES = "Git rules: work on YOUR feature branch only; never push; never mutate main; never rewrite history.\n";

// --- schemas ---------------------------------------------------------------------
const DISC_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    baseline_green: { type: "boolean" },
    issues: { type: "array", items: { type: "object", properties: {
      title: { type: "string" }, severity: { type: "string" }, evidence: { type: "string" }
    }, required: ["title", "severity", "evidence"], additionalProperties: false } }
  },
  required: ["summary", "baseline_green", "issues"],
  additionalProperties: false
};
const CUR_SCHEMA = {
  type: "object",
  properties: {
    sprint_brief: { type: "string" },
    approved_by_caller: { type: "boolean" },
    tasks: { type: "array", items: { type: "object", properties: {
      title: { type: "string" },
      rationale: { type: "string" },
      acceptance: { type: "string" },
      files_hint: { type: "string" }
    }, required: ["title", "rationale", "acceptance", "files_hint"], additionalProperties: false } }
  },
  required: ["sprint_brief", "approved_by_caller", "tasks"],
  additionalProperties: false
};
const WORK_SCHEMA = {
  type: "object",
  properties: {
    what_done: { type: "string" },
    files_changed: { type: "array", items: { type: "string" } },
    verification: { type: "string" },
    branch: { type: "string" },
    completed: { type: "boolean" }
  },
  required: ["what_done", "files_changed", "verification", "branch", "completed"],
  additionalProperties: false
};
const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    rework_reasons: { type: "string" },
    notes: { type: "string" }
  },
  required: ["approved", "rework_reasons", "notes"],
  additionalProperties: false
};
const MERGE_SCHEMA = {
  type: "object",
  properties: {
    merged: { type: "boolean" },
    checks_ok: { type: "boolean" },
    journal_written: { type: "boolean" },
    note: { type: "string" }
  },
  required: ["merged", "checks_ok", "journal_written", "note"],
  additionalProperties: false
};
const RETRO_SCHEMA = {
  type: "object",
  properties: {
    velocity_summary: { type: "string" },
    lessons: { type: "array", items: { type: "string" } },
    continue: { type: "boolean" },
    reason: { type: "string" }
  },
  required: ["velocity_summary", "lessons", "continue", "reason"],
  additionalProperties: false
};

// --- main loop ---------------------------------------------------------------------
let sprint = 0;
let continueCampaign = true;
let stopReason = "";

while (sprint < maxSprints && continueCampaign) {
  sprint++;
  log.push("sprint " + sprint + ": start");

  // 1. discovery ------------------------------------------------------------------
  const discLines = [
    "You are the DISCOVERY engine for a sprint campaign in this repository.",
    "Campaign goal: " + description,
    discoverCommand
      ? "Run this discovery command first: " + discoverCommand
      : "Establish the baseline: (1) run the test suite: " + testCommand + " - report green/red; (2) scan the repo for TODO/HACK/FIXME/XXX markers and obvious dead code; (3) check for lint/format configs and run them if cheap.",
    "Read-only: do NOT modify any files.",
    CMDS, FACTS,
    "Cap issues at the 15 most valuable. severity: high|medium|low.",
    FINAL_MSG,
    "Schema keys: summary, baseline_green, issues[{title, severity, evidence}]."
  ].join("\n");
  let dOut = {};
  try {
    const disc = await runChild("s" + sprint + "-discovery", childOpts({ task: discLines, outputSchema: DISC_SCHEMA }));
    dOut = outOf(disc);
    log.push("sprint " + sprint + ": discovery ok (" + ((dOut.issues || []).length) + " issues, baseline " + (dOut.baseline_green ? "green" : "red") + ")");
  } catch (e) {
    log.push("sprint " + sprint + ": discovery failed (" + String(e).slice(0, 120) + "), continuing with curator on campaign text alone");
  }

  // 2. curator with caller approval -------------------------------------------------
  const curLines = [
    "You are the SPRINT CURATOR. Campaign goal: " + description,
    "",
    "Constraints for all tasks: " + constraints,
    "",
    dOut.summary ? ("Discovery summary: " + dOut.summary) : "Discovery unavailable this sprint.",
    dOut.issues && dOut.issues.length ? ("Top issues: " + JSON.stringify(dOut.issues.slice(0, 12))) : "",
    "",
    "Journal: previous sprint results, if any, are in " + journalDir + "/sprint-*.jsonl - read them for lessons and to avoid repeating tasks.",
    "",
    "FORMULA DISCIPLINE: before writing any numeric claim about the codebase (counts, coverage, timings), verify it with a short script; label unverified claims as hypothesis.",
    "Propose at most " + sprintTasks + " tasks for THIS sprint. Each task must be: independently deliverable in one worker session, verifiable by this gate: " + testCommand + ", and small enough to finish within ~30 minutes of work.",
    "Then MANDATORY: send the proposed task list (titles + 1-line rationale each) to the calling side via contact_supervisor (reason: \"sprint-plan approval\") and WAIT for the reply. Incorporate the reply: adjust, drop or add tasks per the caller's corrections; set approved_by_caller accordingly. If contact_supervisor is unavailable after 2 attempts, proceed with approved_by_caller=false.",
    FINAL_MSG,
    "Schema keys: sprint_brief, approved_by_caller, tasks[{title, rationale, acceptance, files_hint}]."
  ].filter(Boolean).join("\n");
  let cOut = {};
  try {
    const cur = await runChild("s" + sprint + "-curator", childOpts({ task: curLines, outputSchema: CUR_SCHEMA }));
    cOut = outOf(cur);
  } catch (e) {
    log.push("sprint " + sprint + ": curator failed (" + String(e).slice(0, 120) + ")");
  }
  const tasks = (Array.isArray(cOut.tasks) ? cOut.tasks : []).slice(0, sprintTasks);
  if (!tasks.length) {
    log.push("sprint " + sprint + ": no tasks after curation; stopping campaign");
    stopReason = "curator returned no tasks";
    break;
  }
  log.push("sprint " + sprint + ": " + tasks.length + " task(s) approved_by_caller=" + (cOut.approved_by_caller === true));

  // 3. execute tasks sequentially ---------------------------------------------------
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const slug = branchPrefix + slugify(t.title);
    const rec = { sprint: sprint, title: t.title, branch: slug, iterations: 0, verdict: "unknown" };

    // 3a. worker (gate-attached, branch discipline) --------------------------------
    const workLines = [
      "You are the TASK WORKER. Execute EXACTLY ONE task end-to-end.",
      "Task: " + t.title,
      "Rationale: " + (t.rationale || ""),
      "Acceptance criteria: " + (t.acceptance || ""),
      "Expected files (hint, not a straitjacket): " + (t.files_hint || "as the code dictates"),
      "",
      "Branch discipline: first check `git status` - if the working copy is dirty, STOP and report completed=false with the reason. Then `git checkout main && git checkout -b " + slug + "`.",
      "Verification command (must pass before you finish): " + testCommand,
      "",
      "Global constraints: " + constraints,
      GIT_RULES, CMDS,
      "MINIMALITY CONTRACT: the acceptance criteria and the verification command are the source of truth; delete anything no criterion needs before finishing.",
      "TDD preference: for aspects the verification command does not cover, write a failing test first and keep it in the deliverable.",
      "Before finishing: commit all your changes to your branch (git add -A && git commit), leave the working copy clean, report your branch name.",
      FACTS, ACC_REPORT,
      "Report format: what_done (2-4 sentences), files_changed, verification (commands + results), branch, completed (true when done and verified).",
      "If you need a decision beyond your scope (spec ambiguity, widening scope, destructive action), ask the calling side via contact_supervisor instead of guessing."
    ].join("\n");
    let wOut = {};
    let workOk = false;
    try {
      const w = await runChild("s" + sprint + "-t" + (i + 1) + "-work", withGate({ task: workLines, outputSchema: WORK_SCHEMA }));
      wOut = outOf(w);
      workOk = wOut.completed === true;
      rec.iterations++;
    } catch (e) {
      wOut = { what_done: "worker failed: " + String(e).slice(0, 200), completed: false };
    }
    log.push("sprint " + sprint + " task " + (i + 1) + ": work " + (workOk ? "ok" : "incomplete") + " (" + rec.iterations + " iter)");

    // 3b. reviewer + rework loop ----------------------------------------------------
    let approved = false;
    let reworkNotes = "";
    for (let r = 0; r <= reworkLimit; r++) {
      const revLines = [
        "You are the CODE REVIEWER. Fresh eyes, read-only: do NOT modify any files.",
        "Campaign goal: " + description,
        "Task under review: " + t.title,
        "Acceptance criteria: " + (t.acceptance || ""),
        "Worker report: " + JSON.stringify(wOut).slice(0, 1200),
        reworkNotes ? ("Previous rework reasons to re-check: " + reworkNotes) : "",
        "",
        "Review the branch diff: `git log --oneline main.." + slug + "` and `git diff main..." + slug + "`.",
        "Judge: (1) does it satisfy every acceptance criterion; (2) correctness incl. edge cases; (3) constraints compliance; (4) no scope creep; (5) tests meaningful, not tautological.",
        "approved=false requires concrete, actionable rework_reasons.",
        FACTS, FINAL_MSG,
        "Schema keys: approved, rework_reasons, notes."
      ].filter(Boolean).join("\n");
      let vOut = {};
      try {
        const v = await runChild("s" + sprint + "-t" + (i + 1) + "-review" + (r > 0 ? "-r" + r : ""), childOpts({ task: revLines, outputSchema: REVIEW_SCHEMA }));
        vOut = outOf(v);
      } catch (e) {
        vOut = { approved: false, rework_reasons: "reviewer failed: " + String(e).slice(0, 200), notes: "" };
      }
      if (vOut.approved === true) { approved = true; break; }
      reworkNotes = String(vOut.rework_reasons || "").slice(0, 800);
      if (r >= reworkLimit) break;
      // one more work round with the rework reasons
      const rwLines = [
        "You are the TASK WORKER (rework round " + (r + 1) + "). Same task, same rules as before.",
        "Task: " + t.title,
        "Acceptance criteria: " + (t.acceptance || ""),
        "Branch: " + slug + " (continue on it; do NOT create a new branch).",
        "Reviewer rework reasons to address: " + reworkNotes,
        "Verification command: " + testCommand,
        "", "Global constraints: " + constraints, GIT_RULES, CMDS,
        "Commit your fixes to the same branch; leave the working copy clean.",
        FACTS, ACC_REPORT,
        "Report format: what_done, files_changed, verification, branch, completed."
      ].join("\n");
      try {
        const w2 = await runChild("s" + sprint + "-t" + (i + 1) + "-rework" + (r + 1), withGate({ task: rwLines, outputSchema: WORK_SCHEMA }));
        wOut = outOf(w2);
        rec.iterations++;
      } catch (e) {
        log.push("sprint " + sprint + " task " + (i + 1) + ": rework " + (r + 1) + " failed (" + String(e).slice(0, 120) + ")");
      }
    }

    // 3c. merge / arbiter ------------------------------------------------------------
    const branchExists = true; // worker reported it; merger verifies
    if (approved && branchExists) {
      const mergeLines = [
        "You are the MERGER. Deliver the approved branch to main and write the sprint journal.",
        "Branch: " + slug + " | Task: " + t.title,
        "Steps: (1) `git checkout main && git merge --squash " + slug + "`; (2) run main checks: " + testCommand,
        mergePolicy === "confirm"
          ? "(2.5) MANDATORY before committing: ask the calling side via contact_supervisor (reason: \"merge approval\") - show the diff stat and the check result; wait for the reply; if refused, abort with merged=false."
          : "(2.5) mergePolicy is auto: proceed without asking.",
        "(3) green: `git commit` with a conventional message; (4) append ONE json line to " + journalDir + "/sprint-" + sprint + ".jsonl (create the dir): {\"task\": " + JSON.stringify(t.title) + ", \"verdict\": \"merged\", \"branch\": " + JSON.stringify(slug) + ", \"note\": <1-line>}; (5) red checks or refusal: `git reset --hard` back to pre-merge main, append the line with verdict \"merge-failed\" instead.",
        "", GIT_RULES, CMDS, FACTS, FINAL_MSG,
        "Schema keys: merged, checks_ok, journal_written, note."
      ].join("\n");
      try {
        const mg = await runChild("s" + sprint + "-t" + (i + 1) + "-merge", childOpts({ task: mergeLines, outputSchema: MERGE_SCHEMA }));
        const mOut = outOf(mg);
        rec.verdict = mOut.merged === true ? "merged" : "merge-failed";
        log.push("sprint " + sprint + " task " + (i + 1) + ": " + rec.verdict);
      } catch (e) {
        rec.verdict = "merge-failed";
        log.push("sprint " + sprint + " task " + (i + 1) + ": merger failed (" + String(e).slice(0, 120) + ")");
      }
    } else {
      // rework exhausted without approval -> arbiter asks the caller
      const arbLines = [
        "You are the ARBITER. A task exhausted its rework budget without reviewer approval.",
        "Task: " + t.title + " | Branch: " + slug + " | Iterations: " + rec.iterations,
        "Last reviewer verdict: " + reworkNotes.slice(0, 600),
        "Last worker report: " + JSON.stringify(wOut).slice(0, 600),
        "",
        "MANDATORY: ask the calling side via contact_supervisor (reason: \"task-rework-exhausted\") with the situation summary; options you offer: merge-as-is / drop-branch / one-more-round.",
        "Apply the reply: merge-as-is -> run the merge procedure (checkout main, merge --squash, run " + testCommand + ", commit or reset on red) and write the journal line to " + journalDir + "/sprint-" + sprint + ".jsonl; drop-branch -> `git checkout main && git branch -D " + slug + "` + journal line verdict \"dropped\"; one-more-round -> do a focused fix round yourself on the branch against the rework reasons, run " + testCommand + ", commit, then merge as above.",
        "", GIT_RULES, CMDS, FACTS, FINAL_MSG,
        "Schema keys: merged, checks_ok, journal_written, note (note = the caller's decision)."
      ].join("\n");
      try {
        const ab = await runChild("s" + sprint + "-t" + (i + 1) + "-arbiter", childOpts({ task: arbLines, outputSchema: MERGE_SCHEMA }));
        const aOut = outOf(ab);
        rec.verdict = aOut.merged === true ? "merged-after-arbitration" : "dropped-or-failed";
        log.push("sprint " + sprint + " task " + (i + 1) + ": arbitration -> " + String(aOut.note || rec.verdict).slice(0, 100));
      } catch (e) {
        rec.verdict = "arbiter-failed";
        log.push("sprint " + sprint + " task " + (i + 1) + ": arbiter failed (" + String(e).slice(0, 120) + ") - branch " + slug + " left for manual review");
      }
    }
    taskResults.push(rec);
  }

  // 4. retrospective ------------------------------------------------------------------
  const retroLines = [
    "You are the RETROSPECTIVE engine for sprint " + sprint + " of the campaign.",
    "Campaign goal: " + description,
    "Task outcomes this sprint: " + JSON.stringify(taskResults.filter(function (r) { return r.sprint === sprint; })),
    "Journal: read " + journalDir + "/sprint-*.jsonl for history.",
    "You may run read-only checks (git log, the test suite: " + testCommand + ") to ground the velocity summary.",
    "Judge stop criteria: is the campaign goal reached, or is there still valuable, safely deliverable work? continue=false only with a concrete reason (goal reached, or diminishing/risky returns).",
    FACTS, FINAL_MSG,
    "Schema keys: velocity_summary, lessons, continue, reason."
  ].join("\n");
  try {
    const rt = await runChild("s" + sprint + "-retro", childOpts({ task: retroLines, outputSchema: RETRO_SCHEMA }));
    const rOut = outOf(rt);
    continueCampaign = rOut.continue === true;
    log.push("sprint " + sprint + ": retro continue=" + continueCampaign + " (" + String(rOut.reason || "").slice(0, 120) + ")");
  } catch (e) {
    log.push("sprint " + sprint + ": retro failed (" + String(e).slice(0, 120) + "); defaulting continue=false");
    continueCampaign = false;
  }
}

if (!stopReason) {
  if (continueCampaign === false) stopReason = "stop-criteria (retro)";
  else stopReason = "max-sprints reached";
}
const doneTasks = taskResults.filter(function (r) { return r.verdict === "merged" || r.verdict === "merged-after-arbitration"; }).length;
log.push("campaign end: " + doneTasks + "/" + taskResults.length + " tasks merged over " + sprint + " sprint(s); " + stopReason);

return {
  done: doneTasks > 0,
  stopReason: stopReason,
  sprints: sprint,
  retries: retriesTotal,
  tasks: taskResults,
  log: log
};
