// agile-loop.js — sprint-campaign workflow (workflow-script port of pi-agile).
// Fixes the lost-events problem: the script awaits EVERY child; one completion
// receipt carries the whole trace. No observer/event channel.
//
// Judgment moved into children (the ledger-loop-mem pattern):
//   discovery -> curator (approval gate via contact_supervisor) -> per task:
//   worker (gate) -> reviewer -> rework loop -> arbiter/merger -> retro.
// State: in-script + on-disk journal <journalDir>/sprint-*.jsonl (children write).
//
// Parallelism (curator-decided): the curator assigns every task a `wave` number.
// Tasks sharing a wave run CONCURRENTLY (each in its own git worktree: branch +
// `npm ci` inside, never touching the shared working copy). Waves execute in
// ascending order; review/rework/merge stay per-task sequential after a wave's
// work phase lands. The curator biases toward parallel: only real dependencies
// or file overlaps justify distinct waves. maxParallel=1 disables worktrees and
// restores the fully sequential single-copy flow.
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
//   maxParallel    (num, default 3, cap 4) max tasks the curator may put in one
//                  wave (concurrent work children); 1 = legacy sequential mode
//   mergePolicy    ('confirm'|'auto', default 'confirm') caller confirms merges
//   branchPrefix   (string, default 'agile/') feature-branch prefix
//   journalDir     (string, default '.agile-js') on-disk sprint journal
//   agentWork      (string, default 'worker') agent for work/rework children;
//                  set to a relay agent (e.g. 'ledger-worker' with subagent tool)
//                  to make the LEDGER ENGINE AVAILABLE - the curator then picks
//                  the engine PER TASK via the task's `engine` field ('bare'
//                  default; 'ledger' for gate-verifiable nontrivial tasks)
//   escalateLedger (bool, default true) when a BARE task exhausts rework and the
//                  arbiter's caller replies 'escalate-ledger', run one repair
//                  ceremony on the existing branch before merge/drop
//   model          (op string) override for every child

const description = String(args.description || "");
const testCommand = String(args.testCommand || "");
const discoverCommand = args.discoverCommand ? String(args.discoverCommand) : "";
const constraints = String(args.constraints || "Follow repo conventions. No drive-by refactors outside the task scope.");
const sprintTasks = Math.min(Math.max(Number(args.sprintTasks) || 3, 1), 8);
const maxSprints = Math.min(Math.max(Number(args.maxSprints) || 3, 1), 20);
const reworkLimit = Math.min(Math.max(Number(args.reworkLimit) || 2, 0), 3);
const maxParallel = Math.min(Math.max(Number(args.maxParallel) || 3, 1), 4);
const mergePolicy = String(args.mergePolicy || "confirm").toLowerCase() === "auto" ? "auto" : "confirm";
const branchPrefix = String(args.branchPrefix || "agile/");
const journalDir = String(args.journalDir || ".agile-js");
const model = args.model || undefined;

const agentWork = String(args.agentWork || "worker");
// adaptive engine: ledger is only AVAILABLE when a relay agent is configured;
// per-task engine selection defaults to bare (cheap), ledger needs justification
const ledgerAvailable = agentWork !== "worker";
const escalateLedger = args.escalateLedger !== false;
function engineOf(t) {
  return ledgerAvailable && t && String(t.engine || "bare").toLowerCase() === "ledger" ? "ledger" : "bare";
}

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
function withGate(extra, relayOverride) {
  const relay = relayOverride === undefined ? ledgerAvailable : relayOverride === true;
  const o = childOpts(extra);
  if (relay) o.agent = agentWork; // relay engine for work/rework children
  if (testCommand) {
    // gate: shorthand expands to acceptance verified with NO timeoutMs on the verify
    // command; acceptance.ts falls back to DEFAULT_VERIFY_TIMEOUT_MS = 120_000 — a hard
    // 2-minute ceiling that kills any full test suite (npm test ~3.5-4 min nominal).
    // Pass verify explicitly with its own generous timeout. toolTimeoutMs is the
    // model's per-tool deadline and does NOT apply to host-side gate verification.
    o.acceptance = {
      level: "verified",
      verify: [{ id: "gate", command: testCommand, timeoutMs: 900000 }],
    };
  }
  // Relay mode blocks on a nested ledger ceremony (up to ~2h) inside ONE subagent
  // tool call — the per-tool deadline must cover the whole ceremony, not 10 min.
  // (600s here silently killed relay ceremonies at minute 10; run budget alone
  // does not help because the tool deadline is separate.)
  o.toolTimeoutMs = relay ? 14400000 : 600000;
  // Relay mode: the worker blocks on a nested ledger ceremony (up to ~2h) + its own
  // verification and commit. The default run budget is too tight for that.
  if (relay) o.timeoutMs = 14400000;
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
      files_hint: { type: "string" },
      wave: { type: "integer" },
      engine: { type: "string", enum: ["bare", "ledger"] }
    }, required: ["title", "rationale", "acceptance", "files_hint", "wave", "engine"], additionalProperties: false } }
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
    worktree: { type: "string" },
    completed: { type: "boolean" }
  },
  required: ["what_done", "files_changed", "verification", "branch", "worktree", "completed"],
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

// --- task execution helpers (wave engine) -----------------------------------------
// The curator assigns each task a wave number; tasks sharing a wave run their WORK
// phase concurrently, each in its own git worktree. postPhase (review/rework/merge)
// stays sequential per task after the wave's work results settle - main is a shared
// resource and reviews are cheap. All helpers are plain functions returning promise
// chains: the sandbox rejects nested async function declarations, and runs.run must
// sit at a .then/await chain head for the unawaited-launch tracker.
let sprint = 0; // hoisted for helpers; assigned in the main loop before use

function taskKey(t, suffix) {
  return "s" + sprint + "-t" + ((t._idx || 0) + 1) + "-" + suffix;
}
function wtPathFor(t, rec) {
  // deterministic worktree path so rework/merge can derive it without parsing reports
  return "../wt-t" + ((t._idx || 0) + 1) + "-" + rec.branch.replace(/^agile\//, "");
}
function workPhase(t, rec, parallel) {
  const slug = rec.branch;
  const ledgerDirName = "ledger-ag-" + slug.replace(/^agile\//, "");
  const useLedger = engineOf(t) === "ledger";
  const relayMode = useLedger;
  const wt = wtPathFor(t, rec);
  const workLines = [
    "You are the TASK WORKER. Execute EXACTLY ONE task end-to-end.",
    relayMode ? "You are operating in RELAY MODE (see IMPLEMENTATION ENGINE below): a ceremony engine implements, you verify/commit/report." : "",
    "TASK-BEGIN",
    "Task: " + t.title,
    "Rationale: " + (t.rationale || ""),
    "Acceptance criteria: " + (t.acceptance || ""),
    "Expected files (hint, not a straitjacket): " + (t.files_hint || "as the code dictates"),
    "Global constraints: " + constraints,
    "TASK-END",
    "",
    parallel
      ? "PARALLEL MODE: this task runs CONCURRENTLY with sibling tasks. You MUST isolate your work in a git worktree:" +
        " (1) in the MAIN working copy, as a one-off setup step only: verify `git status` is clean, then `git worktree add \"" + wt + "\" -b \"" + slug + "\"`" +
        " (if the path or branch already exists: STOP and report completed=false with the reason);" +
        " (2) cd into YOUR worktree - ALL further work, test runs and commits happen ONLY there;" +
        " (3) if package.json exists, run `npm ci` (fallback `npm install`) inside the worktree BEFORE any test run;" +
        " (4) never touch the main working copy and never switch branches there;" +
        " (5) report the worktree path in the worktree field of your result."
      : "Branch discipline: first check `git status` - if the working copy is dirty, STOP and report completed=false with the reason. Then `git checkout main && git checkout -b \"" + slug + "\"`.",
    "Verification command (must pass before you finish): " + testCommand,
    "",
    "Global constraints (repeated for direct workers): " + constraints,
    GIT_RULES, CMDS,
    "MINIMALITY CONTRACT: the acceptance criteria and the verification command are the source of truth; delete anything no criterion needs before finishing.",
    "TDD preference: for aspects the verification command does not cover, write a failing test first and keep it in the deliverable.",
    parallel ? "Before finishing: commit all your changes ON YOUR BRANCH inside your worktree (git add <files> && git commit), leave the worktree clean, report branch + worktree." : "Before finishing: commit all your changes to your branch (git add -A && git commit), leave the working copy clean, report your branch name.",
    relayMode ? "COMMIT NOTE (relay): never `git add -A` - add ONLY the files the ceremony changed (see engine protocol)." : "",
    FACTS, ACC_REPORT,
    "Report format: what_done (2-4 sentences), files_changed, verification (commands + results), branch, worktree, completed (true when done and verified).",
    "If you need a decision beyond your scope (spec ambiguity, widening scope, destructive action), ask the calling side via contact_supervisor instead of guessing.",
    relayMode ? [
      "",
      "IMPLEMENTATION ENGINE (mandatory relay protocol):",
      "1) Branch discipline FIRST, exactly as specified above" + (parallel ? " (worktree variant)." : "."),
      "2) Launch the ledger ceremony EXACTLY like this (fill the placeholders):",
      "   subagent({ workflowScriptPath: \"C:/Users/user/.agents/skills/ledger-solve/workflows/ledger-loop-mem.js\", args: { task: <THE PAYLOAD between TASK-BEGIN/TASK-END above, verbatim>, testCommand: " + JSON.stringify(testCommand) + ", ledgerDir: " + JSON.stringify(parallel ? "<ABSOLUTE path to the MAIN working tree>/" + ledgerDirName + " (main tree = first `worktree` line of `git worktree list --porcelain`)" : JSON.stringify(ledgerDirName)) + ", cwd: " + (parallel ? "<YOUR WORKTREE ABSOLUTE PATH>" : "<the repository root you are in>") + ", maxIters: 10" + (model ? ", model: " + JSON.stringify(model) : "") + " }, async: false, timeoutMs: 14400000 })",
      "   async:false is MANDATORY - block until the ceremony receipt. Do not poll.",
      "3) done:true -> run the gate yourself and inspect git diff; red gate or empty diff -> completed=false with details. done:false -> completed=false with the stopReason and what landed.",
      "4) Commit per COMMIT NOTE above; then verify `git show --stat HEAD` lists only your files; if a hook staged .beads/issues.jsonl: git checkout <pre-commit HEAD> -- .beads/issues.jsonl && git add .beads/issues.jsonl && git commit --amend --no-edit.",
      "5) Report: what_done includes the ceremony receipt summary (rounds, stopReason); verification = YOUR OWN gate run with numbers."
    ].join("\n") : ""
  ].filter(Boolean).join("\n");
  return runChild(taskKey(t, "work"), withGate({ task: workLines, outputSchema: WORK_SCHEMA }, useLedger)).then(
    function (w) {
      const o = outOf(w);
      rec.iterations++;
      return o;
    },
    function (e) {
      return { what_done: "worker failed: " + String(e).slice(0, 200), completed: false };
    }
  );
}

function ledgerRepair(t, rec, parallel, arbiterNote) {
  // escalate-ledger: a BARE task exhausted rework; run ONE repair ceremony on the
  // existing branch (branch-agnostic) and hand the result back to the review cycle.
  const slug = rec.branch;
  const wt = wtPathFor(t, rec);
  const ledgerDirName = "ledger-ag-" + slug.replace(/^agile\//, "") + "-fix";
  const lines = [
    "You are the LEDGER REPAIR worker. A previous direct worker round landed PARTIAL work on branch " + slug + " without reviewer approval; you deliver the task via the ceremony engine, CONTINUING from the current state (never restarting from scratch).",
    "TASK-BEGIN",
    "Task: " + t.title,
    "Rationale: " + (t.rationale || ""),
    "Acceptance criteria: " + (t.acceptance || ""),
    "Expected files (hint): " + (t.files_hint || "as the code dictates"),
    "Global constraints: " + constraints,
    "TASK-END",
    "",
    "ARBITER CONTEXT: " + String(arbiterNote || "rework exhausted").slice(0, 400),
    "",
    parallel
      ? "This task ran in PARALLEL mode: your worktree is \"" + wt + "\" (branch " + slug + " is checked out there). cd into it first; verify `git status` is clean; never touch the main working copy."
      : "Get onto the branch in the main working copy: verify `git status` is clean (STOP with completed=false if dirty), then `git checkout " + slug + "`.",
    "",
    "RELAY PROTOCOL (mandatory):",
    "1) Assess state: `git log --oneline main.." + slug + "` and `git diff main..." + slug + "` - what landed vs the acceptance criteria.",
    "2) Launch the ledger ceremony as REPAIR exactly like this (fill placeholders):",
    "   subagent({ workflowScriptPath: \"C:/Users/user/.agents/skills/ledger-solve/workflows/ledger-loop-mem.js\", args: { task: <THE PAYLOAD between TASK-BEGIN/TASK-END above, verbatim, PLUS this prefix line: 'REPAIR CONTEXT: partial work already exists on the current branch - inspect git status/diff first and complete it rather than restart; keep existing commits.'>, testCommand: " + JSON.stringify(testCommand) + ", ledgerDir: " + JSON.stringify(parallel ? "<ABSOLUTE path to the MAIN working tree>/" + ledgerDirName + " (main tree = first `worktree` line of `git worktree list --porcelain`)" : ledgerDirName) + ", cwd: <repo root you are in>, maxIters: 10" + (model ? ", model: " + JSON.stringify(model) : "") + " }, async: false, timeoutMs: 14400000 })",
    "   async:false is MANDATORY - block until the ceremony receipt. Do not poll.",
    "3) done:true -> run the gate yourself and inspect git diff; red gate or empty diff -> completed=false with details. done:false -> completed=false with the stopReason and what landed.",
    "4) Commit ONLY the files the ceremony changed (never `git add -A`); verify `git show --stat HEAD` lists only your files; if a hook staged .beads/issues.jsonl: git checkout <pre-commit HEAD> -- .beads/issues.jsonl && git add .beads/issues.jsonl && git commit --amend --no-edit.",
    "5) Report: what_done (incl. ceremony receipt summary: rounds, stopReason), files_changed, verification (YOUR OWN gate run with numbers), branch, worktree, completed.",
    "", GIT_RULES, CMDS, FACTS, ACC_REPORT,
    "If you need a decision beyond your scope, ask the calling side via contact_supervisor instead of guessing."
  ].join("\n");
  return runChild(taskKey(t, "repair"), withGate({ task: lines, outputSchema: WORK_SCHEMA }, true)).then(
    function (w) {
      const o = outOf(w);
      rec.iterations++;
      return o;
    },
    function (e) {
      return { what_done: "ledger repair failed: " + String(e).slice(0, 200), completed: false };
    }
  );
}

function postPhase(t, rec, wOut, parallel) {
  const slug = rec.branch;
  const useLedger = engineOf(t) === "ledger";
  const wt = wtPathFor(t, rec);
  const wtNote = parallel ? "Worktree for this task: \"" + wt + "\" (cd there first; all edits, tests and commits happen inside it). " : "";
  function doMerge() {
    const mergeLines = [
      "You are the MERGER. Deliver the approved branch to main and write the sprint journal.",
      "Branch: " + slug + " | Task: " + t.title,
      parallel ? "The branch is checked out in worktree \"" + wt + "\" - do NOT cd there; operate in the main working copy." : "",
      "Steps: (1) `git checkout main && git merge --squash " + slug + "`; if CONFLICTS: resolve them preserving BOTH intents - read the other wave branches' diffs (`git log main --oneline -8`, `git show <other-branch>`) so a sibling task's change survives your resolution; (2) run main checks: " + testCommand,
      mergePolicy === "confirm"
        ? "(2.5) MANDATORY before committing: ask the calling side via contact_supervisor (reason: \"merge approval\") - show the diff stat and the check result; wait for the reply; if refused, abort with merged=false."
        : "(2.5) mergePolicy is auto: proceed without asking.",
      "(3) green: `git commit` with a conventional message; (4) append ONE json line to " + journalDir + "/sprint-" + sprint + ".jsonl (create the dir): {\"task\": " + JSON.stringify(t.title) + ", \"verdict\": \"merged\", \"branch\": " + JSON.stringify(slug) + ", \"note\": <1-line>}; (5) red checks or refusal: `git reset --hard` back to pre-merge main, append the line with verdict \"merge-failed\" instead.",
      parallel ? "(6) cleanup: `git worktree remove \"" + wt + "\"` (branch stays; if the worktree is dirty, leave it and say so in note)." : "",
      "", GIT_RULES, CMDS, FACTS, FINAL_MSG,
      "Schema keys: merged, checks_ok, journal_written, note."
    ].filter(Boolean).join("\n");
    return runChild(taskKey(t, "merge"), childOpts({ task: mergeLines, outputSchema: MERGE_SCHEMA })).then(
      function (mg) {
        const mOut = outOf(mg);
        rec.verdict = mOut.merged === true ? "merged" : "merge-failed";
        log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": " + rec.verdict);
      },
      function (e) {
        rec.verdict = "merge-failed";
        log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": merger failed (" + String(e).slice(0, 120) + ")");
      }
    );
  }
  function doArbitrate(reworkNotes, curWOut) {
    const arbLines = [
      "You are the ARBITER. A task exhausted its rework budget without reviewer approval.",
      "Task: " + t.title + " | Branch: " + slug + " | Iterations: " + rec.iterations,
      parallel ? wtNote : "",
      "Last reviewer verdict: " + String(reworkNotes || "").slice(0, 600),
      "Last worker report: " + JSON.stringify(curWOut).slice(0, 600),
      "",
      "MANDATORY: ask the calling side via contact_supervisor (reason: \"task-rework-exhausted\") with the situation summary; options you offer: merge-as-is / drop-branch / one-more-round" + (escalateLedger && ledgerAvailable && !useLedger ? " / escalate-ledger (recommended when the task looks genuinely nontrivial and the gate is objective: one repair ledger-solve ceremony runs on the existing branch before merge/drop)" : "") + ".",
      "Apply the reply: merge-as-is -> run the merge procedure (checkout main, merge --squash " + slug + ", resolve any conflicts preserving both intents, run " + testCommand + ", commit or reset on red" + (parallel ? ", git worktree remove \"" + wt + "\"" : "") + ") and write the journal line to " + journalDir + "/sprint-" + sprint + ".jsonl; drop-branch -> `git checkout main && git branch -D " + slug + "`" + (parallel ? " + git worktree remove \"" + wt + "\" --force" : "") + " + journal line verdict \"dropped\"; one-more-round -> do a focused fix round yourself on the branch against the rework reasons" + (parallel ? " inside the worktree" : "") + ", run " + testCommand + ", commit, then merge as above; escalate-ledger -> DO NOT try to run the ceremony yourself: reply with schema note=\"escalate-ledger\", merged=false, journal_written=false - the orchestrator launches it.",
      "", GIT_RULES, CMDS, FACTS, FINAL_MSG,
      "Schema keys: merged, checks_ok, journal_written, note (note = the caller's decision)."
    ].filter(Boolean).join("\n");
    return runChild(taskKey(t, "arbiter"), childOpts({ task: arbLines, outputSchema: MERGE_SCHEMA })).then(
      function (ab) {
        const aOut = outOf(ab);
        const note = String(aOut.note || "");
        if (escalateLedger && ledgerAvailable && !useLedger && rec.escalated !== true && /escalate-?ledger/i.test(note)) {
          rec.escalated = true;
          log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": escalating to ledger engine (repair ceremony on branch " + slug + ")");
          return ledgerRepair(t, rec, parallel, note).then(function (repOut) {
            return reviewRound(0, "", repOut);
          });
        }
        rec.verdict = aOut.merged === true ? "merged-after-arbitration" : "dropped-or-failed";
        log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": arbitration -> " + String(aOut.note || rec.verdict).slice(0, 100));
      },
      function (e) {
        rec.verdict = "arbiter-failed";
        log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": arbiter failed (" + String(e).slice(0, 120) + ") - branch " + slug + " left for manual review");
      }
    );
  }
  function reviewRound(r, reworkNotes, curWOut) {
    const revLines = [
      "You are the CODE REVIEWER. Fresh eyes, read-only: do NOT modify any files.",
      "Campaign goal: " + description,
      "Task under review: " + t.title,
      "Acceptance criteria: " + (t.acceptance || ""),
      "Worker report: " + JSON.stringify(curWOut || wOut).slice(0, 1200),
      reworkNotes ? ("Previous rework reasons to re-check: " + reworkNotes) : "",
      "",
      "Review the branch diff: `git log --oneline main.." + slug + "` and `git diff main..." + slug + "`.",
      "Judge: (1) does it satisfy every acceptance criterion; (2) correctness incl. edge cases; (3) constraints compliance; (4) no scope creep; (5) tests meaningful, not tautological.",
      "approved=false requires concrete, actionable rework_reasons.",
      FACTS, FINAL_MSG,
      "Schema keys: approved, rework_reasons, notes."
    ].filter(Boolean).join("\n");
    return runChild(taskKey(t, "review" + (r > 0 ? "-r" + r : "")), childOpts({ task: revLines, outputSchema: REVIEW_SCHEMA })).then(
      function (v) { return decide(outOf(v), curWOut, r, reworkNotes); },
      function (e) {
        // reviewer child failed after retries -> synthesize not-approved, same flow
        return decide({ approved: false, rework_reasons: "reviewer failed: " + String(e).slice(0, 200) }, curWOut, r, reworkNotes);
      }
    );
  }
  function decide(vOut, curWOut, r, prevNotes) {
    if (vOut && vOut.approved === true) return doMerge();
    const notes = String((vOut && vOut.rework_reasons) || "").slice(0, 800) || prevNotes;
    if (r >= reworkLimit) return doArbitrate(notes, curWOut);
    const rwLines = [
      "You are the TASK WORKER (rework round " + (r + 1) + "). Same task, same rules as before.",
      "Task: " + t.title,
      "Acceptance criteria: " + (t.acceptance || ""),
      "Branch: " + slug + " (continue on it; do NOT create a new branch).",
      parallel ? wtNote : "",
      "Reviewer rework reasons to address: " + notes,
      "Verification command: " + testCommand,
      "", "Global constraints: " + constraints, GIT_RULES, CMDS,
      "Commit your fixes to the same branch; leave the working copy clean.",
      (useLedger ? "Rework fixes are SMALL and focused: implement them DIRECTLY yourself - do NOT launch a new ledger ceremony." : ""),
      FACTS, ACC_REPORT,
      "Report format: what_done, files_changed, verification, branch, worktree, completed."
    ].filter(Boolean).join("\n");
    return runChild(taskKey(t, "rework" + (r + 1)), withGate({ task: rwLines, outputSchema: WORK_SCHEMA }, useLedger)).then(
      function (w2) {
        rec.iterations++;
        return reviewRound(r + 1, notes, outOf(w2));
      },
      function (e) {
        log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": rework " + (r + 1) + " failed (" + String(e).slice(0, 120) + ")");
        return reviewRound(r + 1, notes, curWOut);
      }
    );
  }
  return reviewRound(0, "", wOut);
}

function bucketWaves(taskArr) {
  // returns [{wave, tasks}] ascending; ungrouped tasks become singleton waves in listed order;
  // maxParallel === 1 forces the legacy fully-sequential behavior
  const byWave = {};
  const seqQueue = [];
  let nextSeq = 900;
  for (const t of taskArr) {
    let w = Number(t && t.wave);
    if (maxParallel <= 1 || !w || w < 1) { w = nextSeq++; seqQueue.push(t); continue; }
    if (!byWave[w]) byWave[w] = [];
    byWave[w].push(t);
  }
  const keys = Object.keys(byWave).map(Number).sort(function (a, b) { return a - b; });
  const out = keys.map(function (w) { return { wave: w, tasks: byWave[w] }; });
  for (const t of seqQueue) out.push({ wave: 0, tasks: [t] });
  return out;
}

// --- main loop ---------------------------------------------------------------------
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
    "PARALLEL PLANNING (preferred): assign EVERY task a `wave` integer (1.." + maxParallel + "). Tasks sharing a wave run CONCURRENTLY, each isolated in its own git worktree. Bias toward parallel: same wave is the DEFAULT for any tasks that are semantically independent (neither needs the other's change) - PARTIAL FILE OVERLAP is acceptable, the merger resolves textual conflicts at squash time and the gate catches semantic breakage. Use distinct ascending waves ONLY for real dependencies (a task builds on or consumes another task's change). A wave-N task may rely on waves < N being merged. Present the wave structure in your approval request, e.g. 'wave 1: T1+T2 parallel (both touch config.ts, different areas); wave 2: T3 (uses T1's change)'.",
    "EXECUTOR SELECTION: assign EVERY task an `engine` field. " + (ledgerAvailable ? "Two engines are available: 'bare' (direct worker, cheap, reviewer-verified - the DEFAULT) and 'ledger' (a full ledger-solve ceremony: plan -> do -> gate-loop; ~3-4x cost of bare). " : "Only the 'bare' engine is available in this run; set engine=\"bare\" for EVERY task. ") + "Choose 'ledger' ONLY when the task is nontrivial (multi-site change, algorithmic core, spec adaptation, integration) AND the gate objectively verifies the result; choose 'bare' for simple/mechanical tasks and for tasks WITHOUT a crisp gate (docs, research, UI polish - the gate would degenerate to trivially-green and the ceremony overhead buys nothing). Justify every non-default engine in your approval request, e.g. 'T2 engine=ledger (algorithmic core, gate catches regressions)'.",
    "Then MANDATORY: send the proposed task list (titles + 1-line rationale + wave + engine each) to the calling side via contact_supervisor (reason: \"sprint-plan approval\") and WAIT for the reply. Incorporate the reply: adjust, drop or add tasks per the caller's corrections; set approved_by_caller accordingly. If contact_supervisor is unavailable after 2 attempts, proceed with approved_by_caller=false.",
    FINAL_MSG,
    "Schema keys: sprint_brief, approved_by_caller, tasks[{title, rationale, acceptance, files_hint, wave, engine}]."
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

  // 3. execute tasks (curator's waves: same wave = parallel work in own worktrees) --
  for (let gi = 0; gi < tasks.length; gi++) tasks[gi]._idx = gi;
  const waves = bucketWaves(tasks);
  for (const wave of waves) {
    if (wave.tasks.length === 1) {
      const t = wave.tasks[0];
      const rec = { sprint: sprint, title: t.title, branch: branchPrefix + slugify(t.title), iterations: 0, verdict: "unknown" };
      const wOut = await workPhase(t, rec, false);
      log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": work " + (wOut.completed === true ? "ok" : "incomplete") + " (" + rec.iterations + " iter)");
      await postPhase(t, rec, wOut, false);
      taskResults.push(rec);
    } else {
      log.push("sprint " + sprint + ": wave " + wave.wave + " parallel: [" + wave.tasks.map(function (t) { return "t" + ((t._idx || 0) + 1); }).join(", ") + "]");
      const pending = wave.tasks.map(function (t) {
        const rec = { sprint: sprint, title: t.title, branch: branchPrefix + slugify(t.title), iterations: 0, verdict: "unknown" };
        return workPhase(t, rec, true).then(function (wOut) {
          log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": work " + (wOut.completed === true ? "ok" : "incomplete") + " (" + rec.iterations + " iter, parallel wave " + wave.wave + ")");
          return { t: t, rec: rec, wOut: wOut };
        });
      });
      const settled = await Promise.all(pending);
      for (const p of settled) {
        await postPhase(p.t, p.rec, p.wOut, true);
        taskResults.push(p.rec);
      }
    }
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
