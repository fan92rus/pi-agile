// agile-loop.js — sprint-campaign workflow (workflow-script port of pi-agile).
// Fixes the lost-events problem: the script awaits EVERY child; one completion
// receipt carries the whole trace. No observer/event channel.
// Test gate: .githooks/pre-commit runs this file's deterministic contract suite
// (node --test agile-loop.test.mjs) whenever it is staged for commit; installed
// as the pre-commit chain via core.hooksPath=.githooks (bd hooks are forwarded).
//
// Judgment moved into children (the ledger-loop-mem pattern):
//   sdd-setup (phase 0: SDD artifacts become the TASK SOURCE; classifies or skips)
//   discovery -> curator (approval gate via contact_supervisor) -> per task:
//   worker (gate) -> reviewer -> rework loop -> arbiter/merger -> retro.
// State: in-script + on-disk journal <journalDir>/sprint-*.jsonl (children write).
//
// Parallelism (curator-decided): the curator assigns every task a `wave` number.
// Tasks sharing a wave run CONCURRENTLY through a SHARED work-queue (each in its
// own git worktree: branch + lockfile-driven bootstrap inside, never touching the
// shared working copy). Waves execute in ascending order; post-phases (review/
// rework/arbiter/merge) run EAGER through a separate bounded queue (postSlots =
// maxParallel) - reviews never wait for the wave's longest sibling, and the
// backlog is capped. The curator biases toward parallel: only real dependencies
// or file overlaps justify distinct waves. maxParallel=1 = fully sequential
// SCHEDULING; every task is STILL isolated in its own git worktree (the main
// working copy is never switched or written by workers).
//
// Args:
//   description    (string, required) campaign goal - what "done" means
//   testCommand    (string, required) host gate; also main-checks after merge
//   testCommandQuick (op string) FAST MODE: per-round gate (affected test projects
//                  only). Used for work/rework child gates, ceremony do-rounds
//                  (relayed as quickCommand) and INTERMEDIATE merge checks. The
//                  FULL testCommand stays authoritative: it gates the LAST merge
//                  of each wave (once per wave) + discovery baseline. Unset = old
//                  behavior (full gate everywhere).
//   discoverCommand(op string) custom discovery command; default = tests baseline
//                  + TODO/HACK/FIXME scan composed by the child
//   constraints    (op string) rules injected into every child
//   sprintTasks    (num, default 3, cap 12) tasks per sprint (rolling pool may exceed maxParallel)
//   maxSprints     (num, default 3, cap 20)
//   reworkLimit    (num, default 2, cap 3) reviewer->worker cycles per task
//   maxParallel    (num, default 3, cap 4) max concurrently RUNNING tasks (rolling
//                  shared work queue); a wave may hold MORE tasks than this.
//                  1 = legacy sequential mode
//   maxPerModel    (num, default 2, cap 8) max LIVE children per model: the global
//                  "<=2 live per model" rule as runtime enforcement at the two
//                  scheduling points (work pool + post queue), so bursts of 429
//                  rate limits cannot be manufactured by parallelism alone.
//   modelLadder   (array of model ids, default []) overload fallback: when a child
//                  dies with 429/overload, the NEXT attempt moves to the next model
//                  in the ladder (shared attempt counter); review/arbiter children
//                  never ladder onto the work model (cross-model review). Exhausted
//                  ladder = the pre-ladder fail-fast wait (reason carries lastModel).
//   QUOTA COOLING-DOWN (implemented, next to the breaker): a 429 failure parses the
//                  provider's wait (/'requested (\d+)s retry delay'/; unparsable ->
//                  600s; cap 7200s) and cools the burned model until now+wait in the
//                  durable checkpoint. Model selection for subsequent children (work/
//                  review pools, ladder start) skips cooling models (until > now); ALL
//                  cooling -> minimal until; expired until -> eligible again.
//   mergePolicy    ('confirm'|'auto', default 'confirm') caller confirms merges
//   mergeApproval  ('auto'|'confirm', default 'auto' in bd-epic mode, else 'confirm')
//                  who authorizes each merge commit. 'auto' = the merger child commits
//                  when the MECHANICAL evidence converged - branch HEAD == the claimed
//                  SHA, the squash staged a non-empty clean change set, the FULL suite
//                  green on main, the main tree clean - with NO supervisor round
//                  (headless viability: pi -p / goal-x federations have no interactive
//                  caller to answer the merge ask; the campaign would hang). 'confirm'
//                  = the supervisor question before the merge commit stays (curator
//                  campaigns). Legacy args.mergePolicy 'auto' also implies 'auto'; an
//                  explicit args.mergeApproval always wins.
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
//   sdd            (bool|undefined) SDD task-engine override: true forces the
//                  SDD artifacts phase, false disables it, unset = AUTO (the
//                  setup child classifies the campaign: feature/new-behavior
//                  goals get artifacts, known-bugfix/cleanup batches skip)
//   sddDir         (string, default '.ai/sdd') SDD artifacts root:
//                  <sddDir>/specs/<slug>/{requirements,design,tasks}.md + .status
//   model          (op string) override for every child
//   workModel      (op string) model for work/rework/repair children (overrides `model`)
//   reviewModel    (op string) model for review/arbiter children (overrides `model`); equal models DEGRADE (warn, see SINGLE-MODEL DEGRADATION) instead of failing
//   workModels     (op string[]) ROTATION list for work/rework/repair/cleanup children - round-robin per launched child
//                  (glm -> haiku -> glm ...): spreads quota/context burn instead of hammering one model; overrides workModel
//   reviewModels   (op string[]) rotation list for review/arbiter; reviewer pick SKIPS the paired task's worker model
//                  (cross-model per task); overrides reviewModel. args.modelLadder still applies on top for 429-failover
//   SINGLE-MODEL DEGRADATION (implemented): when only one model is available (work and review resolve
//                  to the same model, or a 1-element list) the campaign does NOT throw:
//                  review runs on that model and a warn goes to the log. Cross-model review
//                  is the default whenever >= 2 models are available. When tripped models
//                  leave no other reviewer, the reviewer falls back to the remaining model
//                  (even the author's) with warn 'cross-model degraded'.
//   overloadTripThreshold (num, default 2) circuit breaker per model (implemented, see the breaker section): each 429/overload
//                  ladder step gives the model one strike; a child that succeeds on a model
//                  resets its strikes; at >= threshold the model TRIPS and a new child starts
//                  on the first healthy model of [primary]+modelLadder (all tripped = start on
//                  primary as before). Strikes live in the checkpoint, so resume keeps them.
//   retryDelays    (num[] op) transport-retry backoff schedule, ms (default 15s/30s/60s/120s/240s, then 300s)
//   maxRetryAttempts (num op, default 6, cap 20) max transport-retry attempts per child; schema/report failures are NEVER retried

const description = String(args.description || "");
const testCommand = String(args.testCommand || "");
const testCommandQuick = args.testCommandQuick ? String(args.testCommandQuick) : "";
const discoverCommand = args.discoverCommand ? String(args.discoverCommand) : "";
const constraints = String(args.constraints || "Follow repo conventions. No drive-by refactors outside the task scope.");
const sprintTasks = Math.min(Math.max(Number(args.sprintTasks) || 3, 1), 12);
const maxSprints = Math.min(Math.max(Number(args.maxSprints) || 3, 1), 20);
const reworkLimit = (function () { const v = Number(args.reworkLimit); return Math.min(Math.max(Number.isFinite(v) ? v : 2, 0), 3); })();
const maxParallel = Math.min(Math.max(Number(args.maxParallel) || 3, 1), 4);
const mergePolicy = String(args.mergePolicy || "confirm").toLowerCase() === "auto" ? "auto" : "confirm";
const branchPrefix = String(args.branchPrefix || "agile/");
const journalDir = String(args.journalDir || ".agile-js");
const ledgerWorkflowPath = String(args.ledgerWorkflowPath || "C:/Users/user/.agents/skills/ledger-solve/workflows/ledger-loop-mem.js");
// Campaign analytics (self-reporting campaigns): at campaign end ONE mechanical child copies
// the workflow's runtime artifacts (events.jsonl / workflow-children.jsonl / status.json - the
// temp copies are retention-ephemeral) into <journalDir>/<runid>/ and runs the campaign
// analyzer (analyze-campaign.mjs by default: metrics.json + retro markdown + wall clock +
// failure classes + token usage; the ledger-solve collect_metrics.py stays as the
// interchangeable alternative - the runner is chosen by script extension: node|python).
// Empty string or analytics: false disables; the child itself reports skipped=true when
// artifacts are absent (portable).
const metricsScript = String(args.metricsScript !== undefined && args.metricsScript !== null ? args.metricsScript : "C:/Users/user/.agents/skills/agile-solve/workflows/analyze-campaign.mjs");
const metricsRunner = /\.(mjs|js)$/i.test(metricsScript) ? "node" : "python";
const analyticsEnabled = args.analytics !== false && !!metricsScript;
const model = args.model || undefined;
// Role-split models: workModel -> work/rework/repair children; reviewModel -> review/arbiter.
const workModel = args.workModel ? String(args.workModel) : undefined;
const reviewModel = args.reviewModel ? String(args.reviewModel) : undefined;
// ROTATION LISTS (round-robin per role): workers walk workModels (child 1 -> glm,
// child 2 -> haiku, child 3 -> glm, ...), reviewers walk reviewModels - spreads the
// 5-hour quota/context burn across models instead of hammering one. A single
// workModel/reviewModel stays supported: it degenerates to a 1-element list. The
// OVERLOAD ladder (args.modelLadder) is orthogonal and still applies on top: rotation
// picks the primary, the ladder only fires on 429-style failures. Reviewer pick
// SKIPS the paired task's worker model (cross-model invariant per task, not per role);
// rework/repair pin their task's worker model (same worker continues the work).
const workModels = (Array.isArray(args.workModels) && args.workModels.length ? args.workModels.map(String).filter(Boolean) : (workModel ? [String(workModel)] : []));
const reviewModels = (Array.isArray(args.reviewModels) && args.reviewModels.length ? args.reviewModels.map(String).filter(Boolean) : (reviewModel ? [String(reviewModel)] : []));
let workRR = 0, reviewRR = 0;
function nextWorkModel() {
  if (!workModels.length) return undefined;
  let i, cand;
  for (i = 0; i < workModels.length; i++) {
    cand = workModels[(workRR + i) % workModels.length];
    if (!cooling(cand)) { workRR = workRR + i + 1; return cand; } // cooling models (until > now) are skipped
  }
  // Every work model is cooling-down -> the one that recovers FIRST (minimal until):
  // a quota wall must not leave the campaign without a worker model.
  cand = minCoolingModel(workModels) || workModels[workRR % workModels.length];
  workRR++;
  emit("[cooling] every work model is cooling down - picking '" + cand + "' (minimal until, recovers first)");
  return cand;
}
function nextReviewModel(avoid) {
  if (!reviewModels.length) return undefined;
  let i, cand;
  for (i = 0; i < reviewModels.length; i++) {
    cand = reviewModels[(reviewRR + i) % reviewModels.length];
    if (cand !== avoid && !tripped(cand) && !cooling(cand)) { reviewRR = reviewRR + i + 1; return cand; }
  }
  // Single-model degradation: after skipping the author's model and the tripped/cooling
  // ones nothing healthy remains - review on the only available model (even the
  // author's) instead of launching no reviewer at all, with a loud warning.
  for (i = 0; i < reviewModels.length; i++) {
    cand = reviewModels[(reviewRR + i) % reviewModels.length];
    if (!tripped(cand) && !cooling(cand)) {
      reviewRR = reviewRR + i + 1;
      log.push("cross-model degraded: reviewer on '" + cand + "'" + (cand === avoid ? " (the author's model - no other review model available)" : " (every non-author review model is tripped or cooling)"));
      return cand;
    }
  }
  // Every review model is tripped or cooling -> degrade as-is, EXCEPT cooling decides
  // the pick: the reviewer that recovers FIRST (minimal until) is taken.
  cand = minCoolingModel(reviewModels) || reviewModels[reviewRR % reviewModels.length];
  reviewRR++;
  log.push("cross-model degraded: reviewer on '" + cand + "' (every review model is cooling or tripped)");
  return cand;
}
// SDD task-engine: unset = auto (setup child classifies), true = force, false = legacy
const sddOverride = args.sdd === true ? "on" : args.sdd === false ? "off" : "auto";
const sddDir = String(args.sddDir || ".ai/sdd");
const mainBranch = String(args.mainBranch || "");
const MAIN_BRANCH_NOTE = "MAIN BRANCH: " + (mainBranch ? "the integration branch is '" + mainBranch + "'" : "detect the integration branch name FIRST (it may be 'master', not 'main'): `git branch --show-current` in the MAIN working copy; NEVER create or switch to a 'main' branch that does not exist") + ". Substitute the real name for 'main' in every git command below.";
// claim-dirt (agents-92w djr): workers bd-claim leaves MID-sprint and the bd daemon
// re-exports .beads/issues.jsonl - a TRACKED file - into the main tree. A pre-flight
// that refuses on it makes every merge fail headless (no driver exists to commit the
// dirt), so the leaf restarts from zero (qu2 s2 precedent: 14 min, 63k tokens). The
// merger and drop pre-flights instead auto-commit EXACTLY that one file with a
// mechanical chore(bd) message and proceed - FAIL-SAFE (rework of the first pass):
// `|| true` + continue let a failed add/commit leave the dirt staged and the merge
// blocked anyway, so the rule now VERIFIES the path is clean before continuing and
// turns a failed auto-commit into an explicit merge/drop refusal; any other dirt
// still refuses.
function claimDirtRule(refusal) {
  return "CLAIM-DIRT EXCEPTION (headless viability): workers bd-claim leaves mid-sprint and the bd daemon re-exports .beads/issues.jsonl (a TRACKED file) into the main tree - that alone is NOT dirt: if .beads/issues.jsonl is the only dirty path (staged or modified), commit it FIRST with `git add .beads/issues.jsonl && git commit -m \"chore(bd): auto-commit claim-dirt export (merge pre-flight)\" </dev/null`; then VERIFY before proceeding: `git status --porcelain -- .beads/issues.jsonl` must print NOTHING - only a CLEAN path proves the commit landed, and then you CONTINUE (never refuse and never reset because of bd claim-dirt). If the path is STILL dirty (the add/commit failed: locked index, missing user identity, hook rejection), do NOT proceed and do NOT retry blindly: " + refusal + " and make NO further git changes. ";
}

const agentWork = String(args.agentWork || "worker");
// adaptive engine: ledger is only AVAILABLE when a relay agent is configured;
// per-task engine selection defaults to bare (cheap), ledger needs justification
const ledgerAvailable = agentWork !== "worker";
const escalateLedger = args.escalateLedger !== false;
function engineOf(t) {
  const e = t ? String(t.engine || "bare").toLowerCase() : "bare";
  if (e === "ledger" && ledgerAvailable) return "ledger";
  if (e === "sdd") return "sdd";
  return "bare";
}

const budgetMs = Math.min(Math.max(Number(args.budgetMs) || 14400000, 600000), 86400000);
const deadlineMs = Date.now() + budgetMs;

let retriesTotal = 0;

// --- durable checkpoint (mission state; phase model per plan §4a, goal-x design) ----
// state.get/set is the atomic mission-state API (durable JSON, ≤256 KiB). A missing
// mission (mission:false run) disables recovery guarantees - that is surfaced, not hidden.
const stateOk = (typeof state !== "undefined") && !!state && typeof state.get === "function" && typeof state.set === "function";
let GENERATION = 1;      // ++ on every start; late answers of older generations are stale
let usedCount = 0;       // every child launch (attempt-level)
let repairUsedCount = 0; // repair-class rounds: report-repair, arbiter one-more-round
let plannedTotal = 0;    // curated tasks across sprints (planned before execution)
// Writers are SERIALIZED: each read-merge-write must see the previous write, or a
// fire-and-forget patch (carry, strikes) is silently dropped by the next write's stale base.
let cpChain = Promise.resolve();
function cpWrite(patch) {
  if (!stateOk) return Promise.resolve(undefined);
  const write = cpChain.then(function () {
    return Promise.resolve(state.get("agile-cp")).catch(function () { return undefined; }).then(function (prev) {
      const base = (prev && typeof prev === "object") ? prev : {};
      const cp = Object.assign({}, base, patch, { generation: GENERATION, updatedAt: new Date().toISOString() });
      return Promise.resolve(state.set("agile-cp", cp)).catch(function () { return undefined; });
    });
  });
  cpChain = write.catch(function () { return undefined; });
  return write;
}
// In-script event line: retry/phase diagnostics land in the returned log. The
// sandbox also exposes a host emit, but the local definition is self-contained.
function emit(line) { log.push(String(line)); }

if (!description) throw new Error("agile-loop: args.description is required");
if (!testCommand) throw new Error("agile-loop: args.testCommand is required (no gate -> no delegation)");
const log = [];
const taskResults = [];
let mergeChain = Promise.resolve(); // ALL main-tree merge children serialize here (reviews run eager and read-only)

// SINGLE-MODEL DEGRADATION: colliding model configs WARN instead of throwing -
// a reviewer on the author's model beats not running the campaign at all.
// nextReviewModel degrades per task and logs 'cross-model degraded' whenever the
// cross-model invariant cannot be satisfied for that pick.
if (workModel && reviewModel && workModel === reviewModel) {
  log.push("agile-loop preflight (degraded): workModel and reviewModel are the same model ('" + workModel + "') - the mandatory reviewer cannot differ from the author; continuing with the reviewer on the author's model");
}
if (reviewModels.length === 1 && workModels.length && workModels.indexOf(reviewModels[0]) !== -1) {
  log.push("agile-loop preflight (degraded): reviewModels has a single entry that collides with a work model ('" + reviewModels[0] + "') - reviewers could never differ from their authors; continuing with degraded per-task picks");
}

// Reconcile-on-load: a checkpoint left by an older generation means a previous run
// was interrupted. Its phase and spent allowances carry forward - never silently reset.
let cpPrev = undefined;
if (stateOk) cpPrev = await Promise.resolve(state.get("agile-cp")).catch(function () { return undefined; });
if (cpPrev && typeof cpPrev === "object" && cpPrev.generation) GENERATION = Math.max(1, Number(cpPrev.generation) || 0) + 1;
usedCount = (cpPrev && Number(cpPrev.used)) || 0;
repairUsedCount = (cpPrev && Number(cpPrev.repairUsed)) || 0;
let budgetHit = false; // Q4: any child launch rejected by the runtime usageBudget
if (!stateOk) log.push("checkpoint: mission state unavailable - recovery after a crash is NOT guaranteed for this run");
else if (cpPrev && typeof cpPrev === "object" && cpPrev.phase === "running") log.push("reconcile: previous checkpoint phase=running (generation " + (cpPrev.generation || "?") + ") - marked interrupted; tasks are never silently re-planned");
await cpWrite({ phase: "running", interruptedBefore: !!(cpPrev && typeof cpPrev === "object" && cpPrev.phase === "running") });

// --- overload circuit breaker (per-model 429 strikes) ------------------------------
// Every 429 ladder step burns a STRIKE on the model that failed; a child success on
// a model clears its strikes; strikes >= args.overloadTripThreshold (default 2) TRIP
// the model: runChild skips it when STARTING a new child (first healthy model leads
// the [primary]+ladder sequence; ALL tripped -> run as-is, the breaker must not
// brick the campaign). The map lives in the durable checkpoint, so a resumed
// campaign keeps skipping a model that burned out minutes ago.
const overloadTripThreshold = Math.min(Math.max(Number(args.overloadTripThreshold) || 2, 1), 10);
const overloadStrikes = Object.assign({}, (cpPrev && typeof cpPrev === "object" && cpPrev.overloadStrikes && typeof cpPrev.overloadStrikes === "object") ? cpPrev.overloadStrikes : {});
function tripped(m) { return !!m && (Number(overloadStrikes[String(m)]) || 0) >= overloadTripThreshold; }
function recordStrike(m) {
  if (!m) return;
  const k = String(m);
  overloadStrikes[k] = (Number(overloadStrikes[k]) || 0) + 1;
  if (tripped(k)) log.push("[breaker] model '" + k + "' TRIPPED after " + overloadStrikes[k] + " overload strike(s) (>= threshold " + overloadTripThreshold + ") - new children skip it");
  cpWrite({ overloadStrikes: Object.assign({}, overloadStrikes) }); // best-effort persist: strikes survive a mid-sprint crash/resume
}
function resetStrikes(m) {
  if (!m || !overloadStrikes[String(m)]) return;
  delete overloadStrikes[String(m)]; // child success on the model: it is healthy again
  cpWrite({ overloadStrikes: Object.assign({}, overloadStrikes) });
}

// --- quota cooling-down (per-model 429 retry-after) ---------------------------------
// A child that dies on a rate limit carries the provider's own wait estimate
// ("Server requested NNNNs retry delay"). The engine parses it (unparseable ->
// default 600s; capped at 7200s) and puts the burned model into COOLING-DOWN until
// <now + wait>. Model selection for subsequent children (work pool, review pool,
// ladder start) skips cooling models (until > now); when EVERY candidate is cooling,
// the one with the minimal until is taken - a quota wall must not leave the campaign
// without a model class. The map lives in the durable checkpoint, so a resumed
// campaign keeps avoiding a model whose quota returns only in an hour (wave-6
// precedent: 3 fresh starts burned dead-on-arrival against one 429 wall).
const COOLING_DEFAULT_S = 600;
const COOLING_CAP_S = 7200;
const RETRY_DELAY_RE = /requested (\d+)s retry delay/i;
const coolingDown = Object.assign({}, (cpPrev && typeof cpPrev === "object" && cpPrev.coolingDown && typeof cpPrev.coolingDown === "object") ? cpPrev.coolingDown : {});
function coolingUntil(m) {
  const iso = m ? coolingDown[String(m)] : undefined;
  if (!iso) return 0;
  const t = Date.parse(String(iso));
  return Number.isFinite(t) ? t : 0;
}
function cooling(m) { return coolingUntil(m) > Date.now(); } // after until the model is eligible again
function retryAfterSeconds(errText) {
  const m = RETRY_DELAY_RE.exec(String(errText || ""));
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(n)) return COOLING_DEFAULT_S; // no parseable retry delay -> default wait
  return Math.min(n, COOLING_CAP_S); // a huge provider delay is capped
}
function recordCooling(m, seconds, key) {
  if (!m) return; // modeless launches have no model to cool
  const k = String(m);
  const until = Date.now() + Math.max(0, Number(seconds) || 0) * 1000;
  if (until <= coolingUntil(k)) return; // an already-longer wait wins
  coolingDown[k] = new Date(until).toISOString();
  emit("[cooling] " + (key ? key + ": " : "") + "model '" + k + "' rate-limited (429) -> cooling down until " + coolingDown[k] + " (" + Math.round((until - Date.now()) / 1000) + "s retry-after)");
  cpWrite({ coolingDown: Object.assign({}, coolingDown) }); // best-effort persist: cooling survives a mid-sprint crash/resume
}
function minCoolingModel(models) {
  let best = "";
  for (let i = 0; i < (models || []).length; i++) {
    const m = String(models[i]);
    if (cooling(m) && (!best || coolingUntil(m) < coolingUntil(best))) best = m;
  }
  return best;
}

// --- carry-over выжимка (retry brief) ----------------------------------------------
// A leaf attempt that ends WITHOUT a merge leaves ENGINE facts only: its branch, the
// files_changed of the last validated structured output and the engine stop point.
// The record rides on the rec and in the checkpoint (carry, keyed by branch); the next
// fresh attempt on that branch gets it as a short brief section. Never the worker's
// narrative or verdict text. Loaded on resume, so it survives a campaign restart.
const carryByBranch = Object.assign({}, (cpPrev && typeof cpPrev === "object" && cpPrev.carry && typeof cpPrev.carry === "object") ? cpPrev.carry : {});
function noteFiles(rec, o) {
  if (o && Array.isArray(o.files_changed)) rec.filesChanged = o.files_changed.map(String);
}
function recordCarry(rec) {
  if (!rec || !rec.branch) return;
  if (rec.verdict === "merged" || rec.verdict === "merged-after-arbitration") return;
  const files = Array.isArray(rec.filesChanged) ? rec.filesChanged : [];
  rec.carry = { branch: String(rec.branch), files: files.slice(0, 10), filesTotal: files.length, stop: String(rec.stop || ("verdict " + rec.verdict)) };
  carryByBranch[rec.branch] = rec.carry;
  cpWrite({ carry: Object.assign({}, carryByBranch) }); // best-effort persist, like the overload strikes
}
function carryLines(c) {
  if (!c) return [];
  const shown = c.files.join(", ") + (c.filesTotal > c.files.length ? ", ..." : "");
  return [
    "PREVIOUS ATTEMPT (engine facts from the checkpoint, not a judgment - the previous worker's narrative is not included):",
    "- branch: " + c.branch,
    "- files_changed: " + (c.filesTotal ? shown + " (" + c.filesTotal + " total)" : "none reported"),
    "- stopped at: " + c.stop
  ];
}

// --- helpers ------------------------------------------------------------------
function childOpts(extra, role) {
  const o = Object.assign({ agent: "worker", context: "fresh" }, extra || {});
  // Role-based model split (fallback): explicit extra.model (rotation picks) wins;
  // then workModel/reviewModel; then the top-level model. Cross-model review
  // REQUIRES reviewer != author - enforced by nextReviewModel(avoid) at the call
  // sites and by preflight; equality is never a silent fallback.
  const m = role === "work" ? (workModel || model) : role === "review" ? (reviewModel || model) : model;
  if (!o.model && m) o.model = m;
  return o;
}
// --- per-model concurrency gate (Q2) ------------------------------------------
// Bounds LIVE children per model at the two SCHEDULING points (work-pool workers
// and post-queue jobs), NOT inside runChild: the sandbox flags deferred runs.run
// launches as unawaited (runs.run must stay at its chain head), while waiting at
// queue level is already the norm (post Этап 4 queues). Known approximation:
// rework/repair/merge children run INSIDE a held post slot, so their load is
// charged to that slot's model, not their own — the work-phase long poles (relay
// ceremonies up to ~2h) and the eager review burst, the actual overload sources,
// are capped exactly. Event-driven handoff: waiters resolved by release, no timers.
const maxPerModel = Math.min(Math.max(Number(args.maxPerModel) || 2, 1), 8);
const modelSlots = new Map();
function modelGateFor(m) {
  const k = String(m || "default");
  let s = modelSlots.get(k);
  if (!s) { s = { live: 0, waiters: [] }; modelSlots.set(k, s); }
  return s;
}
function acquireModel(m) {
  const s = modelGateFor(m);
  if (s.live < maxPerModel) { s.live++; return Promise.resolve(); }
  return new Promise(function (resolve) { s.waiters.push(function () { s.live++; resolve(); }); });
}
function releaseModel(m) {
  const s = modelGateFor(m);
  s.live = Math.max(0, s.live - 1);
  const w = s.waiters.shift();
  if (w) w(); // hand the freed slot directly to the next waiter
}
function outOf(runRes) {
  const so = runRes && runRes.structuredOutput;
  if (so && typeof so === "object") return so;
  const txt = String((runRes && runRes.output) || "");
  const m = txt.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return {};
}
// FIX-ONLY REWORK (perf): parse the reviewer verdict's structured fix-list. Returns a
// normalized [{file, fix}] array, or null when absent/empty/malformed - null means the
// rework round falls back to the legacy full brief. One malformed item poisons the
// whole list (a half-parsed fix order is worse than a full re-brief).
function fixListOf(vOut) {
  const fl = vOut && vOut.fix_list;
  if (!Array.isArray(fl) || fl.length === 0) return null;
  const list = [];
  for (let i = 0; i < fl.length; i++) {
    const f = fl[i];
    const file = f && typeof f === "object" ? String(f.file || "").trim() : "";
    const fix = f && typeof f === "object" ? String(f.fix || "").trim() : "";
    if (!file || !fix) return null;
    list.push({ file: file, fix: fix });
  }
  return list;
}
// CONTRACT PRE-CHECK (perf, mechanical, NO LLM): the leaf's header (title) and files_hint
// name the deliverable files; the worker's files_changed is the branch's actual change set.
// A stale header (ys9/r1: a good change rejected after a 29-min rework round for metadata
// that no longer matched the branch) is caught here for the price of a string comparison.
// Returns a reason string on mismatch, null otherwise. Rule: only when the contract NAMES
// files; a match on ANY named file passes (files_hint is a hint, not a straitjacket).
const CONTRACT_FILE_RE = /[A-Za-z0-9_.\-\/]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|sh|py|yml|yaml|ps1|cmd|bat|toml|txt|html|css|sql|go|rs|java|cs|c|h)\b/gi;
function normPath(p) { return String(p || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase(); }
function contractMismatch(t, changed) {
  const named = ((String(t.title || "") + " " + String(t.files_hint || "")).match(CONTRACT_FILE_RE) || []).map(normPath);
  const uniq = named.filter(function (n, i) { return named.indexOf(n) === i; });
  if (!uniq.length) return null; // the contract names no file: nothing to cross-check
  const ch = (changed || []).map(normPath);
  const hit = uniq.some(function (n) {
    return ch.some(function (c) { return c === n || c.endsWith("/" + n) || n.endsWith("/" + c); });
  });
  if (hit) return null;
  return "contract names " + uniq.join(", ") + " but the branch changed " + (ch.length ? ch.slice(0, 5).join(", ") + (ch.length > 5 ? ", ..." : "") : "no files");
}
function slugify(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}
function withGate(extra, relayOverride) {
  const relay = relayOverride === undefined ? ledgerAvailable : relayOverride === true;
  const o = childOpts(extra, "work");
  if (relay) o.agent = agentWork; // relay engine for work/rework children
  // ACCEPTANCE SOURCE = the structured output itself (WORK_SCHEMA + in-script
  // validateAccStructured). acceptance:false is the boundary/discovery precedent
  // (level "none"): the host requires NO fenced acceptance_report - the manual
  // fence was the duplicate of the schema channel and produced EVERY salvage of
  // both live campaigns while the schema channel had 0 rejections in ~100 children.
  // (Combining acceptance:false with the top-level `gate` field would re-enable the
  // fence: normalizeGateAcceptance reifies the gate into verified acceptance and
  // resolveEffectiveAcceptance unions requiredEvidenceForLevel back in.)
  // The gate command STAYS in every work/rework/repair brief ("Verification command
  // must pass before you finish") and is re-run MECHANICALLY by the merger on main
  // (full suite) before any commit; per-child the worker attests its own gate run
  // via commandsRun/validationOutput and the semantic validator + reviewer check it.
  o.acceptance = false;
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
// Retryable = LAUNCH-LEVEL transport failures only (the child never started, or the
// provider died before any work landed): re-launching the same brief cannot redo
// finished work. A child that RAN but failed to emit its schema/report is class
// "schema-missing" - re-running the same brief risks re-implementing landed work, so
// it fails FAST with a classified error; call-sites degrade (workPhase catch ->
// completed=false -> review/rework/arbiter) instead of re-briefing. Provider
// overload/rate-limit is NOT retried at all: the sandbox has NO timer primitives
// (verified in-runtime: no setTimeout/queueMicrotask/process), so a pause is
// impossible - burning immediate attempts into a rate limit is pointless; the error
// is returned classified as retry-needed with the recommended pause. Transient
// connection errors get bounded retries; the inter-attempt delay is 0 in the
// sandbox (no timers) and timer-based when a delay primitive exists (tests).
// Atomics.wait is forbidden here - it freezes the entire single-threaded workflow.
// emit: host global exists in the pi-subagents sandbox, but the local definition
// keeps retry diagnostics in the returned log without relying on the host.
const TRANSPORT_RE = /all connection attempts failed|econn(refused|reset|aborted)|etimedout|eai_again|enotfound|fetch failed|socket hang up|bad gateway|service unavailable|gateway timeout|enginecore|engine core|internal server error/i;
const OVERLOAD_RE = /overloaded|rate.?limit|429|too many requests|quota/i;
const SCHEMA_RE = /required structured output was not produced|missing structured_output|failed to produce structured output/i;
// Q4: launch rejections from the runtime-level usageBudget (see pi-subagents docs:
// accounts usage across completed children, rejects later launches once exhausted,
// and returns terminalOutcome partial/budget_exhausted). Terminal by design.
const BUDGET_RE = /budget_exhausted|usage budget|token budget|usagebudget/i;
const RETRY_DELAYS = [15000, 30000, 60000, 120000, 240000]; // honored only where a timer primitive exists
const retryDelays = (Array.isArray(args.retryDelays) ? args.retryDelays.map(Number) : RETRY_DELAYS).filter(function (n) { return Number.isFinite(n) && n >= 0; });
const maxRetryAttempts = Math.min(Math.max(Number(args.maxRetryAttempts) || 6, 1), 20);
// Optional context-bundle script ("codemode path"): when set, the worker brief gains
// a STEP 0 line - one read-only call (bd + git + task map) replacing discovery.
// Absent/empty = brief unchanged (portable across machines/containers).
const bundleScript = typeof args.bundleScript === "string" && args.bundleScript.trim() ? args.bundleScript.trim() : "";
// --- Federation mode (bd-epic): bd is the task source, this workflow is the stage
// executor, the driver (goal-x / operator) owns bd writes and relaunches stages.
// taskSource "curator" (default) = 1:1 legacy behavior. "bd-epic": discovery and
// curator children are SKIPPED; tasks come from the leaf snapshot (args.bdTasks on
// sprint 1, then ONE mechanical boundary child per sprint boundary (janitor + snapshot
// refresh: picks up mid-flight growth; bd-close is NOT a boundary duty anymore - each
// MERGE child closes the leaf it just merged, best-effort; after the loop ONE post-loop
// child closes whatever is still pending - unconfirmed closes - whatever the
// stopReason). doneWhen "bd-epic-closed": the campaign stops with stopReason
// epic-closed as soon as the snapshot shows no open leaves. A leaf is READY when
// every dep id is in the done set (closed in snapshot OR merged by this campaign earlier).
const taskSource = args.taskSource === "bd-epic" ? "bd-epic" : "curator";
const bdEpic = String(args.bdEpic || "");
const doneWhen = args.doneWhen === "bd-epic-closed" ? "bd-epic-closed" : "";
// Merge approval mode (see Args): 'auto' commits a merge on converged mechanical
// evidence with no supervisor round (headless viability); 'confirm' keeps the ask.
const mergeApproval = (function () {
  const v = args.mergeApproval !== undefined
    ? String(args.mergeApproval).toLowerCase()
    : (taskSource === "bd-epic" || mergePolicy === "auto") ? "auto" : "confirm";
  return v === "auto" ? "auto" : "confirm";
})();
log.push("mergeApproval: " + mergeApproval + (mergeApproval === "auto"
  ? " (merges commit on converged mechanical evidence - no supervisor round)"
  : " (supervisor confirm before each merge commit)"));
// Review tier per task (bd leaf field `review`): none = no review child (merge gate,
// head-binding and acceptance evidence stay), lite = checklist review without the
// judge block, full = the default review. Missing or unknown values are full.
const REVIEW_TIERS = ["full", "lite", "none"];
function reviewTierOf(v) {
  const s = String(v || "").trim().toLowerCase();
  return REVIEW_TIERS.indexOf(s) !== -1 ? s : "full";
}
function normalizeLeaf(l) {
  l = l && typeof l === "object" ? l : {};
  return {
    id: String(l.id || ""), title: String(l.title || ""), rationale: String(l.rationale || ""),
    acceptance: String(l.acceptance || ""), files_hint: String(l.files_hint || ""),
    deps: Array.isArray(l.deps) ? l.deps.map(String) : [],
    open: l.open !== false,
    review: reviewTierOf(l.review)
  };
}
let bdSnapshot = (Array.isArray(args.bdTasks) ? args.bdTasks : []).map(normalizeLeaf).filter(function (l) { return l.id; });
// ids whose bd close is CONFIRMED done (the merger reported bd_closed=true, or the
// post-loop child closed them) - never closed twice (exactly-once: a failed close stays
// unmarked and is retried by the post-loop child or the driver).
const bdClosedIds = new Set();
function doneSet() {
  const s = new Set();
  bdSnapshot.forEach(function (l) { if (!l.open) s.add(l.id); });
  taskResults.forEach(function (r) { if (r && r.id && r.verdict === "merged") s.add(r.id); });
  return s;
}
function delayMs(ms) {
  // No timer primitive in the sandbox -> zero-delay bounded retry (not a busy loop:
  // attempts are bounded and each is a real child launch).
  if (ms <= 0 || typeof setTimeout !== "function") return Promise.resolve();
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}
function runChild(key, spec) {
  // Q3 model ladder: on provider overload the NEXT attempt moves to the next model
  // in args.modelLadder (shared attempt counter - a ladder step burns an attempt;
  // transport retries keep the CURRENT fallback model). Review/arbiter children
  // never ladder onto the work model: cross-model review is a hard invariant.
  const primary = String(spec.model || model || "");
  const isReviewish = /-review(-r\d+)?$/.test(key) || /-arbiter$/.test(key);
  const ladderSeen = {};
  const ladderFull = [primary].concat(
    (Array.isArray(args.modelLadder) ? args.modelLadder.map(String) : []).filter(function (m) {
      if (!m || m === primary || ladderSeen[m]) return false; // duplicates would ladder into nowhere
      if (isReviewish && m === String(workModel || "")) return false;
      ladderSeen[m] = true;
      return true;
    })
  );
  // Breaker + cooling: a tripped model (>= overloadTripThreshold recent 429 strikes)
  // or a cooling model (429 retry-after not yet elapsed, until > now) is skipped at
  // START - the first healthy model leads the ladder. Every candidate unhealthy ->
  // sequence as-is (never refuse to launch because of it), except cooling decides the
  // lead: the model that recovers FIRST (minimal until) starts the sequence, so a
  // fresh child does not burn its start on the longest quota wall.
  const ladderHealthy = ladderFull.filter(function (m) { return !tripped(m) && !cooling(m); });
  const coolingLead = ladderHealthy.length ? "" : minCoolingModel(ladderFull);
  const ladderSeq = ladderHealthy.length ? ladderHealthy
    : (coolingLead ? [coolingLead].concat(ladderFull.filter(function (m) { return m !== coolingLead; })) : ladderFull);
  if (coolingLead) emit("[cooling] " + key + ": every ladder candidate is unhealthy - leading with '" + coolingLead + "' (minimal until, recovers first)");
  let modelIdx = 0;
  // Plain promise-chain retry loop (nested async functions are rejected by the sandbox).
  // runs.run is called at the CHAIN HEAD: the tracker requires direct .then/await
  // registration on the launch promise - wrapping it in Promise.resolve().then(...)
  // makes pi flag the run as "unawaited" and fails the whole workflow at completion.
  // If runs.run ever throws synchronously, attempt() throws before any .then exists;
  // the call-site try/catch handles it (no retry) - same as pre-retry behavior.
  function attempt(n) {
    usedCount++; // every launch attempt counts toward the campaign's LLM budget
    const m = ladderSeq[modelIdx];
    const spec2 = m && m !== spec.model ? Object.assign({}, spec, { model: m }) : spec;
    return runs.run(n === 0 ? key : key + "~retry" + (n + 1), spec2).then(
      function (res) {
        if (res && res.ok !== false) {
          resetStrikes(m);
          // rp-schema: a WORK_SCHEMA child's structured output IS the acceptance report -
          // validate it semantically here, once, for every work-class child (work, rework,
          // report-repair, repair). A violation throws the salvage-class error: it bypasses
          // fail() (report failures are NEVER retried/re-briefed) and rejects this promise,
          // so the call-site rejection handler routes it into salvageReport.
          if (spec.outputSchema === WORK_SCHEMA) {
            const bad = validateAccStructured(outOf(res));
            if (bad) throw new Error("schema-missing: " + bad);
          }
          return res;
        }
        return fail(n, String((res && (res.error || res.output)) || "child run failed"));
      },
      function (e) {
        return fail(n, String((e && e.message) || e));
      }
    );
  }
  function fail(n, errText) {
    if (BUDGET_RE.test(errText)) {
      // BEFORE everything else: a budget rejection happens at LAUNCH - no child ran,
      // nothing landed. Terminal: no transport retry, no model ladder, no re-brief.
      // The runtime itself stops the campaign (terminalOutcome partial/budget_exhausted);
      // the in-script classification just makes call-site catches degrade fast.
      budgetHit = true;
      throw new Error("token-budget-exhausted: " + errText.slice(0, 300));
    }
    if (SCHEMA_RE.test(errText)) {
      // The child RAN (it may have landed work on the branch) - never auto re-brief.
      throw new Error("schema-missing: " + errText.slice(0, 300));
    }
    if (OVERLOAD_RE.test(errText)) {
      // Quota cooling-down FIRST: the provider told us how long this model is done for
      // ("Server requested NNNNs retry delay"); record it so SUBSEQUENT children (work/
      // review pools, fresh ladder sequences) never start on the burned model.
      recordCooling(ladderSeq[modelIdx], retryAfterSeconds(errText), key);
      if (modelIdx < ladderSeq.length - 1) {
        // Ladder step: same brief, next model, shared attempt counter. The launch
        // pattern is unchanged (attempt() already runs inside a .then chain).
        recordStrike(ladderSeq[modelIdx]); // breaker: the burned model takes a strike
        modelIdx++;
        emit("[ladder] " + key + " attempt " + (n + 1) + ": model " + ladderSeq[modelIdx - 1] + " overloaded (429) -> next model: " + ladderSeq[modelIdx]);
        return attempt(n + 1);
      }
      // No pause primitive in the sandbox - with the ladder exhausted, retrying a
      // rate limit immediately just burns the budget; surface a diagnosable
      // retry-needed instead. The checkpoint records the wait (and the model that
      // still failed) so a resumed run knows why the campaign stopped.
      // BEST-EFFORT (not awaited): the throw below must not depend on state I/O.
      cpWrite({ phase: "waiting", wait: { reason: "provider-overload", lastModel: String(ladderSeq[modelIdx] || ""), until: new Date(Date.now() + 300000).toISOString() } });
      throw new Error("retry-needed (provider overloaded/rate-limited; pause a few minutes and resume the campaign): " + errText.slice(0, 250));
    }
    const attemptNo = n + 1;
    const now = Date.now();
    if (!TRANSPORT_RE.test(errText) || attemptNo > maxRetryAttempts || now + 60000 >= deadlineMs) {
      throw new Error((TRANSPORT_RE.test(errText) ? "transport-unrecovered: " : "child-failed: ") + errText.slice(0, 300));
    }
    retriesTotal++;
    const wait = Math.min(attemptNo <= retryDelays.length ? retryDelays[attemptNo - 1] : 300000, Math.max(1000, deadlineMs - now - 60000));
    emit("[retry] " + key + " attempt " + attemptNo + ": " + errText.replace(/\s+/g, " ").slice(0, 140) + (typeof setTimeout === "function" ? " - next attempt in " + Math.round(wait / 1000) + "s" : " - retrying immediately (no timer primitive in sandbox)"));
    return delayMs(wait).then(function () { return attempt(attemptNo); });
  }
  return attempt(0);
}

// --- shared discipline lines -----------------------------------------------------
const FINAL_MSG = "FINAL MESSAGE DISCIPLINE: your final message must be ONLY the JSON value with EXACTLY the schema keys listed in your instructions. Do NOT emit acceptanceReport or any other key; narrative goes inside string fields.\n";
const ACC_STRUCTURED = "ACCEPTANCE SOURCE (structured output IS the report): your structured_output JSON IS the acceptance report - the workflow validates it semantically and any violation fails as 'schema-missing: <field>'. There is NO fenced acceptance_report block anymore: do NOT emit one; your final message is a free-text summary for the caller. Acceptance fields (ALL required, inside the structured output):\n- head: the full 40-hex SHA of YOUR branch HEAD after the final commit (run `git rev-parse HEAD` and report exactly that).\n- testsAddedOrUpdated: array of '<file>: <N> cases' strings; [] exactly when the task truly adds no tests.\n- commandsRun: array of {command, result, summary}; result is EXACTLY one of \"passed\", \"failed\", \"not-run\" (NEVER \"exit 0\" or any other free text - a live campaign lost two workers to a brief that demonstrated exit 0).\n- validationOutput: NON-EMPTY array of the decisive gate output lines.\n- residualRisks: array of strings ([] when none).\n- noStagedFiles: must be true - after your final commit `git status --short` in YOUR tree must be empty.\n- criteriaSatisfied: EXACTLY two entries with ids EXACTLY \"criterion-1\" (scope discipline: implement without widening) and \"criterion-2\" (evidence sufficiency), each {id, status: \"satisfied\", evidence: <verified fact: numbers, exit codes, file paths>}.\n";
const REPORT_SHAPE_RE = /^schema-missing:/i; // salvage-class rejections: the machine-readable REPORT is broken; the WORK on the branch may be fine (live classes: host "required structured output was not produced" via runChild fail(), and validateAccStructured 'schema-missing: <field>'; the fence classes "Structured acceptance report not found" / "Required criterion ... not reported" are GONE with acceptance:false)
const FACTS = "FACTS DISCIPLINE: state only facts you personally verified this session (ran or read); mark recollections as [unverified]. CITATION RULE: cite only sources you actually opened this session.\n";
const CMDS = "Every long command runs with piped stdin and an explicit timeout; running servers, tests or solvers without piped stdin is a violation. Work incrementally.\n";
const GIT_RULES = "Git rules: work on YOUR feature branch only; never push; never mutate main; never rewrite history.\n";
// ys9/wave-5 precedent: workers twice burned 250k+ tokens on self-written helper
// scripts (bd-cursor ys9, debug-tracker.mjs) because they read BRIEFS, not AGENTS.md.
// Shared by the work/rework/repair briefs below.
const NO_SCRATCH_DEBUG = "NO SCRATCH DEBUG SCRIPTS: find answers with EXISTING commands (`bd list --json`, `bd show`, `node --test <file>` with a timeout, ready-made repo analyzers); self-written helper scripts (debug-*.mjs, temp-file+node:fs scripting) are FORBIDDEN without explicit justification in your final report.\n";

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
const CURSOR_SCHEMA = {
  type: "object",
  properties: {
    leaves: { type: "array", items: { type: "object", properties: {
      id: { type: "string" }, title: { type: "string" }, rationale: { type: "string" },
      acceptance: { type: "string" }, files_hint: { type: "string" },
      deps: { type: "array", items: { type: "string" } }, open: { type: "boolean" },
      review: { type: "string", enum: REVIEW_TIERS }
    }, required: ["id", "title", "open", "review"], additionalProperties: false } }
  },
  required: ["leaves"],
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
      engine: { type: "string", enum: ["bare", "ledger", "sdd"] },
      engine_reason: { type: "string" },
      sdd_item: { type: "string" }
    }, required: ["title", "rationale", "acceptance", "files_hint", "wave", "engine", "engine_reason"], additionalProperties: false } }
  },
  required: ["sprint_brief", "approved_by_caller", "tasks"],
  additionalProperties: false
};
const SDD_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["sdd", "skip"] },
    reason: { type: "string" },
    tasks_file: { type: "string" },
    items_total: { type: "integer" }
  },
  required: ["mode", "reason", "tasks_file", "items_total"],
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
    completed: { type: "boolean" },
    head: { type: "string", pattern: "^[0-9a-f]{40}$", description: "Full 40-hex SHA of your branch HEAD after the final commit (git rev-parse HEAD)" },
    plan_progress: { type: "string", description: "Ceremony plan completion, e.g. '4/5 done, 1 n/a'" },
    // ACCEPTANCE FIELDS (rp-schema): the structured output IS the acceptance report.
    // Shape lives here (host schema channel - 0 rejections in ~100 live children);
    // semantics are re-checked in-script by validateAccStructured below.
    testsAddedOrUpdated: { type: "array", items: { type: "string" }, description: "Test files with case counts ('<file>: <N> cases'); [] exactly when the task adds no tests" },
    commandsRun: { type: "array", minItems: 1, items: { type: "object", properties: {
      command: { type: "string" },
      result: { type: "string", enum: ["passed", "failed", "not-run"] },
      summary: { type: "string" }
    }, required: ["command", "result", "summary"], additionalProperties: false } },
    validationOutput: { type: "array", minItems: 1, items: { type: "string" } },
    residualRisks: { type: "array", items: { type: "string" } },
    noStagedFiles: { type: "boolean", const: true, description: "true only when `git status --short` is empty in your tree after the final commit" },
    criteriaSatisfied: { type: "array", minItems: 2, maxItems: 2, items: { type: "object", properties: {
      id: { type: "string", enum: ["criterion-1", "criterion-2"] },
      // rework r1: the host contract requires status EXACTLY "satisfied" - a report
      // admitting not-satisfied/not-applicable is not a verified acceptance report.
      status: { type: "string", enum: ["satisfied"] },
      evidence: { type: "string" }
    }, required: ["id", "status", "evidence"], additionalProperties: false } }
  },
  required: ["what_done", "files_changed", "verification", "branch", "worktree", "completed", "head", "testsAddedOrUpdated", "commandsRun", "validationOutput", "residualRisks", "noStagedFiles", "criteriaSatisfied"],
  additionalProperties: false
};
// Semantic acceptance validation of a WORK_SCHEMA structured output (rp-schema):
// returns "" when valid, otherwise the offending FIELD name - callers raise
// Error("schema-missing: " + field), the salvage-class rejection (REPORT_SHAPE_RE).
function validateAccStructured(so) {
  so = so && typeof so === "object" ? so : {};
  const isStrArr = function (a) { return Array.isArray(a) && a.every(function (s) { return typeof s === "string"; }); };
  const head = typeof so.head === "string" ? so.head : "";
  if (!/^[0-9a-f]{40}$/.test(head)) return "head";
  if (!isStrArr(so.testsAddedOrUpdated)) return "testsAddedOrUpdated";
  if (!Array.isArray(so.commandsRun) || so.commandsRun.length < 1 || !so.commandsRun.every(function (c) {
    return c && typeof c === "object"
      && typeof c.command === "string" && c.command.trim().length > 0
      && (c.result === "passed" || c.result === "failed" || c.result === "not-run")
      && typeof c.summary === "string";
  })) return "commandsRun";
  if (!isStrArr(so.validationOutput) || so.validationOutput.length < 1) return "validationOutput";
  if (!isStrArr(so.residualRisks)) return "residualRisks";
  if (so.noStagedFiles !== true) return "noStagedFiles";
  const crit = so.criteriaSatisfied;
  if (!Array.isArray(crit) || crit.length !== 2) return "criteriaSatisfied";
  const ids = crit.map(function (c) { return c && typeof c === "object" ? c.id : undefined; });
  if (ids.indexOf("criterion-1") === -1 || ids.indexOf("criterion-2") === -1) return "criteriaSatisfied"; // exactly these two ids, no foreign ids
  if (!crit.every(function (c) {
    return c && typeof c === "object"
      && c.status === "satisfied" // rework r1: exactly "satisfied" - mirrors the schema enum above
      && typeof c.evidence === "string" && c.evidence.trim().length > 0;
  })) return "criteriaSatisfied";
  return "";
}
const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    rework_reasons: { type: "string" },
    notes: { type: "string" },
    // FIX-ONLY REWORK (perf): optional structured fix-list on a rejected verdict.
    // When well-formed, the rework child applies EXACTLY these fixes (no re-research);
    // absent/empty/malformed -> the legacy full rework brief. Optional: old verdicts
    // without it stay schema-valid.
    fix_list: {
      type: "array", minItems: 1,
      description: "approved=false ONLY: concrete per-file fixes, each {file, fix}; the rework child applies exactly these edits and nothing else",
      items: {
        type: "object",
        properties: {
          file: { type: "string", description: "affected file path" },
          fix: { type: "string", description: "the exact edit to apply" }
        },
        required: ["file", "fix"],
        additionalProperties: false
      }
    }
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
    merge_commit: { type: "string" },
    // bd-epic only: the merger's best-effort close of the leaf it just merged (omitted
    // when no bd-close step ran). false/absent NEVER fails the merge; the unconfirmed
    // id stays out of bdClosedIds and is retried by the post-loop child or the driver.
    bd_closed: { type: "boolean" },
    note: { type: "string" }
  },
  required: ["merged", "checks_ok", "journal_written", "merge_commit", "note"],
  additionalProperties: false
};
// Arbiter only DECIDES (merge/drop run through the shared mergeChain); a repeated
// one-more-round is forced to drop by the orchestrator (max one arbiter fix round).
const ARB_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["merge-as-is", "drop-branch", "one-more-round", "escalate-ledger"] },
    note: { type: "string" }
  },
  required: ["decision", "note"],
  additionalProperties: false
};
const DROP_SCHEMA = {
  type: "object",
  properties: {
    dropped: { type: "boolean" },
    journal_written: { type: "boolean" },
    note: { type: "string" }
  },
  required: ["dropped", "journal_written", "note"],
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
// phase concurrently through the shared work-queue, each in its own git worktree.
// postPhase (review/rework/merge) runs through the separate bounded post queue
// (capped, eager) - main is a shared resource and merges serialize on mergeChain.
// All helpers are plain functions returning promise
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
function wtBaseName(t, rec) {
  return wtPathFor(t, rec).replace(/^\.\.[\\/]/, "");
}
const CLEANUP_SCHEMA = { type: "object", properties: { cleaned: { type: "array", items: { type: "object", properties: { branch: { type: "string" }, worktree: { type: "string" }, removed: { type: "boolean" }, note: { type: "string" } }, required: ["branch", "removed"] } } }, required: ["cleaned"] };
const BOUNDARY_SCHEMA = { type: "object", properties: { cleaned: CLEANUP_SCHEMA.properties.cleaned, closed: { type: "array", items: { type: "object", properties: { id: { type: "string" }, closed: { type: "boolean" }, note: { type: "string" } }, required: ["id", "closed"], additionalProperties: false } }, leaves: CURSOR_SCHEMA.properties.leaves }, required: ["cleaned", "leaves"], additionalProperties: false };
const ANALYTICS_SCHEMA = { type: "object", properties: { runid: { type: "string" }, skipped: { type: "boolean" }, reason: { type: "string" }, wallMs: {}, children: {}, totalTokens: {}, failureClasses: {}, summaryLine: { type: "string" }, files: { type: "array", items: { type: "string" } } }, required: ["runid", "summaryLine"] };
function leftoverEntries(recs) {
  // Executed-but-never-merged recs: their worktrees/branches are garbage by campaign
  // semantics (the gates rejected the work; retries must start collision-free - a
  // stale path makes the worker's STOP-on-collision contract fail the retry forever).
  const seen = {};
  const out = [];
  (recs || []).forEach(function (r) {
    if (!r || !r.branch || !r.wt) return;
    if (r.verdict === "merged" || r.verdict === "merged-after-arbitration" || r.verdict === "unknown") return;
    const b = String(r.branch);
    if (seen[b]) return;
    seen[b] = true;
    out.push({ branch: b, worktree: r.wt });
  });
  return out;
}
// bd-epic auto-close: leaves carrying a FINAL done verdict of THIS campaign -
// merged/merged-after-arbitration (merge commit recorded by the merger). Everything else
// (failed/dropped/merge-failed/unknown/no-head/arbiter-failed) is NEVER closed: bd
// stays the source of truth for not-delivered work. Feeds the POST-LOOP close (the
// merger closes the merged ones eagerly during the loop).
function bdCloseEntries(recs) {
  const out = [];
  (recs || []).forEach(function (r) {
    if (!r || !r.id) return;
    if (r.verdict !== "merged" && r.verdict !== "merged-after-arbitration") return;
    out.push({ id: String(r.id), commit: String(r.mergeCommit || ""), verdict: String(r.verdict) });
  });
  return out;
}
function cleanupBrief(entries) {
  return [
    "You are the CLEANUP CREW - a mechanical janitor, NOT a reviewer. Remove LEFTOVER worktrees and branches of tasks that were executed but NEVER merged: the campaign gates rejected that work, and stale paths make any retry fail its STOP-on-collision contract.",
    "For EACH entry below run BOTH commands from the MAIN working copy, piped stdin, WITHOUT `|| true` - a failed git command must SURFACE in the report, never be swallowed:",
    "   git worktree remove --force \"<worktree>\"",
    "   git branch -D \"<branch>\"",
    "Interpret each failure honestly: 'not a working tree' / 'not found' style error = the target is ALREADY GONE - fine, report removed=false with that reason in note; ANY OTHER failure (locked, permission, hook) = report removed=false with the FULL error text in note - do NOT retry and never swallow the error.",
    "NEVER touch the main working copy contents, the integration branch, or anything NOT listed here. Do NOT run tests, do NOT inspect diffs, do NOT create or commit anything.",
    "ENTRIES:",
    entries.map(function (e) { return "- branch " + JSON.stringify(e.branch) + ", worktree " + JSON.stringify(e.worktree); }).join("\n"),
    FACTS, FINAL_MSG,
    "Schema keys: cleaned[{branch, worktree, removed (boolean), note}]."
  ].join("\n");
}
function analyticsBrief() {
  return [
    "You are the CAMPAIGN ANALYTICS archiver - a mechanical script-runner, NOT a reviewer. The campaign is over; preserve its evidence next to the sprint journal (the runtime copies in the pi-subagents temp root are retention-ephemeral - without this copy past campaigns are unreanalyzable).",
    "STEP 1 - locate THIS campaign's workflow run dir: the async-subagent-runs/<runid> whose workflow-children.jsonl contains your own launch key \"campaign-analytics\" (the start record is written at launch, so your own dir matches). Search the temp roots, first that exists: \"${TMPDIR:-${TEMP:-/tmp}}\" and C:/Users/*/AppData/Local/Temp - glob pi-subagents-*/async-subagent-runs/*/workflow-children.jsonl. Several matches (parallel campaign on the same machine): take the newest by mtime and say so in reason.",
    "STEP 2 - persist the sources: mkdir -p " + journalDir + "/<runid> && cp -f the run dir's events.jsonl, workflow-children.jsonl and status.json into " + journalDir + "/<runid>/ (keep the names).",
    "STEP 3 - analyze: " + metricsRunner + " \"" + metricsScript + "\" <workflow-run-dir> --agile-journal \"" + journalDir + "/sprint-*.jsonl\" --out " + journalDir + "/<runid>/metrics.json --retro " + journalDir + "/<runid>/retro-<runid>.md (runner or script missing -> still do STEP 2, report skipped=true with the reason).",
    "Report the collected facts honestly: wallMs/children/totalTokens/failureClasses from metrics.json; summaryLine = ONE line 'wall=<human> children=<n> tokens=<n|?> failures=<n> (<classes|none>)' - the DRIVER mirrors it into the bd epic-close comment. Missing data stays '?' - never zeros.",
    "Do NOT modify the campaign repo, do NOT run tests, do NOT commit anything.",
    FACTS, FINAL_MSG,
    "Schema keys: runid, skipped, reason, wallMs, children, totalTokens, failureClasses, summaryLine, files[]."
  ].join("\n");
}
// ONE boundary child per sprint boundary (bd-epic): PART 1 janitors the previous sprint's
// never-merged leftovers, PART 3 refreshes the bd snapshot only when it can have changed.
// PART 2 (bd-close) now fires ONLY through the post-loop child: at a sprint boundary
// `closables` is never passed - the close moved into the MERGE child (perf: boundary
// children burned 1.5-4 min per boundary on it).
function boundaryBrief(entries, refresh, closables) {
  const janitor = entries.length ? [
    "PART 1 - JANITOR. Remove LEFTOVER worktrees and branches of tasks that were executed but NEVER merged: the campaign gates rejected that work, and stale paths make the retry fail its STOP-on-collision contract.",
    "For EACH entry below run BOTH commands from the MAIN working copy, piped stdin, WITHOUT `|| true` - a failed git command must SURFACE in the report, never be swallowed:",
    "   git worktree remove --force \"<worktree>\"",
    "   git branch -D \"<branch>\"",
    "Interpret each failure honestly: 'not a working tree' / 'not found' style error = the target is ALREADY GONE - fine, report removed=false with that reason in note; ANY OTHER failure (locked, permission, hook) = report removed=false with the FULL error text in note - do NOT retry and never swallow the error.",
    "NEVER touch the main working copy contents, the integration branch, or anything NOT listed here. Do NOT inspect diffs, do NOT run tests, do NOT create or commit anything.",
    "ENTRIES:",
    entries.map(function (e) { return "- branch " + JSON.stringify(e.branch) + ", worktree " + JSON.stringify(e.worktree); }).join("\n")
  ] : ["PART 1 - JANITOR: no leftovers at this boundary - cleaned=[]."];
  const bdClose = (closables || []).length ? [
    "PART 2 - BD CLOSE (mechanical bookkeeping, NOT a judgment call): the leaves below carry a FINAL done verdict from this campaign (merged / merged-after-arbitration) but bd may still show them open - close EACH of them so bd catches up with the merges (a headless campaign must reach bd-epic-closed on its own).",
    "Run each command line below from the MAIN working copy, piped stdin, VERBATIM (the grep pre-check skips an already-closed leaf without error - a driver's close is never overwritten):",
    ...closables.map(function (e) {
      return "  bd show " + e.id + " --json </dev/null | grep -q '\"status\": *\"closed\"' || bd close " + e.id + " -r \"" + e.id + ": merge " + (e.commit || "no-commit") + " - " + e.verdict + "\" </dev/null";
    }),
    "The -r string is the MECHANICAL close comment: leaf id, merge commit, short verdict - exactly this form, no prose.",
    "Then flush the JSONL export and commit it to the integration tree (the merge pre-flight requires a clean porcelain; this is the ONLY commit this child ever makes; NEVER `git add -A`, only this one file). NO `|| true` - a failed git command must SURFACE, never be swallowed:",
    "  bd export </dev/null",
    "  git add .beads/issues.jsonl && git commit -m \"chore(bd): auto-close done leaves (" + closables.map(function (e) { return e.id; }).join(",") + ")\"",
    "Then VERIFY: `git status --porcelain -- .beads/issues.jsonl` must print NOTHING - only a CLEAN path proves the commit landed. If the path is STILL dirty (the add/commit/export failed: locked index, missing user identity, hook rejection), do NOT retry blindly and do NOT reset: report the failure EXPLICITLY - every closed[] entry of this run gets closed=false with note='export commit failed: .beads/issues.jsonl still dirty' (the close itself is idempotent in bd and is retried later; the failure must be visible, never silent).",
    "NEVER close an id NOT listed here; do NOT create or modify any other bd issue.",
    "Report each listed leaf: closed=true ONLY when the leaf is closed in bd (you closed it, or the pre-check found it closed already) AND the export commit landed clean; false otherwise, with the reason in note."
  ] : [];
  const snapshot = refresh ? [
    "PART 3 - BD SNAPSHOT (read-only). Report EVERY leaf of bd epic " + JSON.stringify(bdEpic) + " (children with no children of their own).",
    "Run these commands with piped stdin (read-only; do NOT create, close or modify anything in bd):",
    "  (a) bd list --parent " + bdEpic + " --all -n 0 --json </dev/null   - the epic's children (JSON array: id, title, status)",
    "  (b) bd show <ALL child ids from (a), space-separated> --json </dev/null   - ONE call, JSON array with description and dependencies[]",
    "  (c) ONE bash for-loop: for i in <child ids>; do bd list --parent \"$i\" --all -n 0 --json </dev/null; done   - a child with a non-empty result has children of its own: it is NOT a leaf, omit it",
    "Map each leaf exactly:",
    "  id = id; title = title; open = (status != \"closed\");",
    "  rationale = description, first 300 chars;",
    "  acceptance = the test/contract clause of the description (the sentence that states the tests or contract), first 300 chars, '' if none;",
    "  files_hint = the first file path named in the description, first 200 chars, '' if none;",
    "  deps = ids of dependencies[] entries whose dependency_type is \"blocks\" (parent-child entries are NOT deps), [] if none;",
    "  review = the tier word full|lite|none that the description states for the task; missing or unknown -> \"full\".",
    "Return only leaves shown by (a)-(c); NEVER invent ids."
  ] : ["PART 3 - BD SNAPSHOT: NOT requested at this boundary (the snapshot did not change) - run NO bd command; leaves=[]."];
  return [
    "You are the SPRINT BOUNDARY crew - ONE mechanical child, NOT a planner and NOT an implementer. Do exactly the parts below and nothing else.",
    ...janitor,
    ...bdClose,
    ...snapshot,
    FINAL_MSG,
    "Schema keys: cleaned[{branch, worktree, removed (boolean), note}], closed[{id, closed (boolean), note}] (omit when there is no BD CLOSE section), leaves[{id, title, rationale, acceptance, files_hint, deps, open, review}]."
  ].join("\n");
}
function salvageReport(ctx, fromLabel) {
  // REPORT-REPAIR: the WORK landed on the branch but the machine-readable report was
  // rejected (schema-missing class: host structured-output absence, or a
  // validateAccStructured 'schema-missing: <field>' semantic rejection).
  // Recover the report from ACTUAL state - never re-run the implementation brief.
  // Module-level because BOTH rejection sites need it: the work-phase catch and the
  // rework-round failure handler (postPhase scope) - they are sibling functions.
  const t = ctx.t, rec = ctx.rec, slug = ctx.slug, wt = ctx.wt, parallel = ctx.parallel;
  const testCommand = ctx.testCommand, testCommandQuick = ctx.testCommandQuick;
  const useLedger = ctx.useLedger, sprint = ctx.sprint;
  repairUsedCount++;
  log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": report-shaped rejection (" + String(ctx.reason || "unclassified").slice(0, 160) + ") after " + fromLabel + " - REPORT-REPAIR on the existing branch (no re-implementation)");
  const repairLines = [
    "You are the REPORT-REPAIR worker. A previous worker EXECUTED the task on branch " + slug + " but its structured report failed validation ('schema-missing'). Your ONLY job: reconstruct the COMPLETE structured report (the acceptance report) from the ACTUAL repository state.",
    "HARD RULES: do NOT implement anything new; do NOT create branches, worktrees or commits; do NOT reset or delete anything. Read-only investigation plus ONE report.",
    parallel ? "The task worktree is \"" + wt + "\" (branch " + slug + " checked out there) - inspect THERE." : "",
    "1) `git log --oneline main.." + slug + "` and `git diff main..." + slug + "` - what landed vs the task.",
    "2) Task intent: " + t.title + " | Acceptance criteria: " + (t.acceptance || ""),
    "3) Run the verification command YOURSELF: " + (testCommandQuick ? testCommandQuick + " (quick gate; the FULL suite runs at merge)" : testCommand),
    MAIN_BRANCH_NOTE,
    "Report EXACTLY the schema: what_done (2-4 sentences on what the PREVIOUS worker actually landed), files_changed (from the diff), verification (YOUR OWN gate run with numbers), branch (" + slug + "), worktree, head (`git rev-parse " + slug + "` - full 40-hex SHA), completed (true ONLY if the EXISTING work satisfies every acceptance criterion).",
    "", GIT_RULES, CMDS, FACTS, ACC_STRUCTURED,
    "Reconstruct the acceptance fields from REAL state: testsAddedOrUpdated from test files in the diff ('<file>: <N> cases', [] when none); commandsRun from YOUR OWN gate run (result is exactly passed|failed|not-run); validationOutput = decisive gate output lines; residualRisks = [] when none; noStagedFiles from `git status --short` in your tree; criteriaSatisfied = exactly criterion-1 (scope) and criterion-2 (evidence), judged against the diff and the task's acceptance criteria.",
    "Schema keys: what_done, files_changed, verification, branch, worktree, head, completed, testsAddedOrUpdated, commandsRun, validationOutput, residualRisks, noStagedFiles, criteriaSatisfied."
  ].filter(Boolean).join("\n");
  return runChild(taskKey(t, "report-repair"), withGate(Object.assign({ task: repairLines, outputSchema: WORK_SCHEMA }, rec.wm ? { model: rec.wm } : {}), useLedger)).then(
    function (r) {
      const o = outOf(r);
      rec.iterations++;
      rec.repaired = true;
      noteFiles(rec, o);
      log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": report repaired from branch state (completed=" + (o.completed === true) + ")");
      return o;
    },
    function (e2) {
      log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": report-repair failed (" + String(e2).slice(0, 120) + ")");
      return null;
    }
  );
}

function workPhase(t, rec, parallel) {
  const slug = rec.branch;
  const ledgerDirName = "ledger-ag-" + slug.replace(/^agile\//, "");
  const useLedger = engineOf(t) === "ledger";
  const sddEngine = engineOf(t) === "sdd";
  const engineAgent = sddEngine ? "sdd-worker" : undefined;
  const relayMode = useLedger;
  const wt = wtPathFor(t, rec);
  const workLines = [
    "You are the TASK WORKER. Execute EXACTLY ONE task end-to-end.",
    relayMode ? "You are operating in RELAY MODE (see IMPLEMENTATION ENGINE below): a ceremony engine implements, you verify/commit/report." : "",
    "TASK-BEGIN",
    "Task: " + t.title,
    "Rationale: " + (t.rationale || ""),
    "Acceptance criteria: " + (t.acceptance || ""),
    sddActive && t.sdd_item ? "SDD item (verbatim): " + String(t.sdd_item) : "",
    sddActive ? "Authoritative spec: " + sddTasksFile + " (SDD artifacts under " + sddDir + "/specs) - read YOUR item there for full context (requirements/design)." : "",
    sddEngine ? "SDD ENGINE: this task adds NEW behavior - walk a COMPACT sdd chain FIRST using the sdd-* skills (read each SKILL.md: sdd-idea -> sdd-prd -> sdd-spec -> sdd-tasks; self-answer clarifying questions, record decisions in the artifacts' Gate Log, advance .status gates). Artifacts under " + sddDir + "/specs/<task-slug>/ committed ON YOUR BRANCH; tasks.md = checkbox items. Then implement per your own tasks.md. Code never precedes artifacts; keep the chain lean (this is a per-task spec, not a project bible)." : "",
    "Expected files (hint, not a straitjacket): " + (t.files_hint || "as the code dictates"),
    "Global constraints: " + constraints,
    "TASK-END",
    bundleScript ? "STEP 0 (context bundle, ONE call, before anything else): sh " + bundleScript + " '' " + JSON.stringify(String(t.title || "").slice(0, 160)) + " - returns bd task + git state + task-relevant map; replaces DISCOVERY only, never your own gate runs or reading the field files." : "",
    ...carryLines(carryByBranch[rec.branch]),
    MAIN_BRANCH_NOTE,
    "",
    (parallel ? "PARALLEL MODE: this task runs CONCURRENTLY with sibling tasks. " : "") +
      "WORKTREE DISCIPLINE (mandatory for EVERY task - the main working copy is never switched or written):" +
      " (1) in the MAIN working copy, as a one-off setup step only: verify `git status --porcelain --untracked-files=no` is EMPTY (untracked files such as the campaign journal are not dirt), then `git worktree add \"" + wt + "\" -b \"" + slug + "\"`" +
      " (if the path or branch already exists: STOP and report completed=false with the reason); if git reports an index.lock contention, wait 3 seconds and retry the command once;" +
      " (2) cd into YOUR worktree - ALL further work, test runs and commits happen ONLY there;" +
      " (3) if package.json exists: run `npm ci --prefer-offline` ONLY when node_modules is missing or the lockfile is newer than node_modules - reuse the existing install otherwise (bootstrap by lockfile, not per task); `npm install` only as a last-resort fallback;" +
      " (4) never touch the main working copy and never switch branches there;" +
      " (5) report the ABSOLUTE worktree path in the worktree field of your result.",,
    "Verification command (must pass before you finish): " + (relayMode && testCommandQuick ? testCommandQuick + " (quick gate; the FULL suite runs again at merge)" : testCommand),
    "",
    "Global constraints (repeated for direct workers): " + constraints,
    GIT_RULES, CMDS, NO_SCRATCH_DEBUG,
    "MINIMALITY CONTRACT: the acceptance criteria and the verification command are the source of truth; delete anything no criterion needs before finishing.",
    "TDD preference: for aspects the verification command does not cover, write a failing test first and keep it in the deliverable.",
    parallel ? "Before finishing: commit all your changes ON YOUR BRANCH inside your worktree (git add <files> && git commit), leave the worktree clean, report branch + worktree." : "Before finishing: commit all your changes to your branch (git add <your changed files> && git commit - NEVER 'git add -A': journal/.env/beads files must not leak into the branch), leave the working copy clean, report your branch name.",
    "HEAD REPORT (mandatory): after your FINAL commit run `git rev-parse HEAD` on YOUR branch and report the full SHA in the `head` field - review and merge verify exactly this commit; a missing or mismatched head fails the task.",
    relayMode ? "COMMIT NOTE (relay): never `git add -A` - add ONLY the files the ceremony changed (see engine protocol)." : "",
    FACTS, ACC_STRUCTURED,
    "Report format: what_done (2-4 sentences), files_changed, verification (commands + results), branch, worktree, head (40-hex SHA), completed (true when done and verified), testsAddedOrUpdated, commandsRun, validationOutput, residualRisks, noStagedFiles, criteriaSatisfied.",
    "FINAL REPORT MARKER: begin your FINAL report message with the exact token 'FINAL REPORT:'. Earlier structured outputs in your session (intermediate ceremony rounds, mid-run statuses) are NOT the report and are ignored by the caller.",
    "SCOPE DISCIPLINE (ceremony): the ceremony must execute its seed plan IN FULL; plan items close as done or n/a (with a one-line reason) - never dropped silently; adjacent discoveries go to findings, NOT into new work. Check the ceremony's finalState.tasks: if any item is neither done nor n/a you MUST report completed=false and put the details in what_done; include 'plan_progress' (e.g. '4/5 done, 1 n/a') in your report when the ceremony provides it.",
    "If you need a decision beyond your scope (spec ambiguity, widening scope, destructive action), ask the calling side via contact_supervisor instead of guessing.",
    relayMode ? [
      "",
      "IMPLEMENTATION ENGINE (mandatory relay protocol):",
      "1) Branch discipline FIRST, exactly as specified above" + (parallel ? " (worktree variant)." : "."),
      "2) Launch the ledger ceremony EXACTLY like this (fill the placeholders):",
      "   subagent({ workflowScriptPath: " + JSON.stringify(ledgerWorkflowPath) + ", args: { task: <THE PAYLOAD between TASK-BEGIN/TASK-END above, verbatim>, testCommand: " + JSON.stringify(testCommand) + (testCommandQuick ? ", quickCommand: " + JSON.stringify(testCommandQuick) : "") + ", ledgerDir: " + JSON.stringify(parallel ? "<ABSOLUTE path to the MAIN working tree>/" + ledgerDirName + " (main tree = first `worktree` line of `git worktree list --porcelain`)" : JSON.stringify(ledgerDirName)) + ", cwd: " + (parallel ? "<YOUR WORKTREE ABSOLUTE PATH>" : "<the repository root you are in>") + ", maxIters: 10" + ((workModel || model) ? ", model: " + JSON.stringify(workModel || model) : "") + " }, async: false, timeoutMs: 14400000 })\n   NOTE: if the workflowScriptPath above does not exist on this machine (different OS/container), locate ledger-loop-mem.js under the ledger-solve skill dir (e.g. ~/.agents/skills/ledger-solve/workflows/) and use that absolute path instead.",
      "   async:false is MANDATORY - block until the ceremony receipt. Do not poll. While that call is blocked you cannot act and need not act: the receipt arrives as the call result. NEVER watch the ceremony with sleep loops (no `sleep 330`, no polling cats of state files) - they burn wall time; any sleep above 60 seconds is FORBIDDEN (sole exception: the KILLED-CALL RECOVERY procedure of your relay agent profile, only after a blocking call was actually killed).",
      "3) done:true -> run the gate yourself" + (testCommandQuick ? " (QUICK gate: " + testCommandQuick + " - the full authoritative gate runs at merge)" : "") + " and inspect git diff; red gate or empty diff -> completed=false with details. done:false -> completed=false with the stopReason and what landed.",
      "4) Commit per COMMIT NOTE above; then verify `git show --stat HEAD` lists only your files; if a hook staged .beads/issues.jsonl: git checkout <pre-commit HEAD> -- .beads/issues.jsonl && git add .beads/issues.jsonl && git commit --amend --no-edit.",
      "5) Report: what_done includes the ceremony receipt summary (rounds, stopReason); verification = YOUR OWN gate run with numbers; testsAddedOrUpdated = the test files/cases the ceremony added ([] when none)."
    ].join("\n") : ""
  ].filter(Boolean).join("\n");
  const workSpec = { task: workLines, outputSchema: WORK_SCHEMA };
  const wm = nextWorkModel(); // rotation pick (round-robin over workModels)
  if (wm) { workSpec.model = wm; rec.wm = wm; }
  if (sddEngine) workSpec.agent = engineAgent; // sdd per-task engine overrides the profile; otherwise childOpts default / relay override applies — passing agent:undefined here poisons Object.assign and crashes runs.run validation
  return runChild(taskKey(t, "work"), withGate(workSpec, useLedger)).then(
    function (w) {
      const o = outOf(w); // already schema-valid + semantically validated in runChild
      rec.iterations++;
      noteFiles(rec, o);
      return o;
    },
    function (e) {
      const msg = String((e && e.message) || e);
      if (REPORT_SHAPE_RE.test(msg)) {
        // The worker RAN and may have landed commits on the branch. Recover the
        // REPORT from the actual state - never re-run the implementation brief.
        return salvageReport({ t: t, rec: rec, slug: slug, wt: wt, parallel: parallel, testCommand: testCommand, testCommandQuick: testCommandQuick, useLedger: useLedger, sprint: sprint, reason: msg }, "work").then(function (o) {
          return o || { what_done: "worker failed (" + msg.slice(0, 120) + "; report-repair also failed)", completed: false };
        });
      }
      return { what_done: "worker failed: " + msg.slice(0, 200), completed: false };
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
    "Your worktree is \"" + wt + "\" (branch " + slug + " is checked out there). cd into it first; verify `git status` is clean; never touch the main working copy.",,
    "",
    "RELAY PROTOCOL (mandatory):",
    MAIN_BRANCH_NOTE,
    "1) Assess state: `git log --oneline main.." + slug + "` and `git diff main..." + slug + "` - what landed vs the acceptance criteria.",
    "2) Launch the ledger ceremony as REPAIR exactly like this (fill placeholders):",
    "   subagent({ workflowScriptPath: " + JSON.stringify(ledgerWorkflowPath) + ", args: { task: <THE PAYLOAD between TASK-BEGIN/TASK-END above, verbatim, PLUS this prefix line: 'REPAIR CONTEXT: partial work already exists on the current branch - inspect git status/diff first and complete it rather than restart; keep existing commits.'>, testCommand: " + JSON.stringify(testCommand) + (testCommandQuick ? ", quickCommand: " + JSON.stringify(testCommandQuick) : "") + ", ledgerDir: " + JSON.stringify(parallel ? "<ABSOLUTE path to the MAIN working tree>/" + ledgerDirName + " (main tree = first `worktree` line of `git worktree list --porcelain`)" : ledgerDirName) + ", cwd: <repo root you are in>, maxIters: 10" + ((workModel || model) ? ", model: " + JSON.stringify(workModel || model) : "") + " }, async: false, timeoutMs: 14400000 })\n   NOTE: if the workflowScriptPath above does not exist on this machine (different OS/container), locate ledger-loop-mem.js under the ledger-solve skill dir (e.g. ~/.agents/skills/ledger-solve/workflows/) and use that absolute path instead.",
    "   async:false is MANDATORY - block until the ceremony receipt. Do not poll. While that call is blocked you cannot act and need not act: the receipt arrives as the call result. NEVER watch the ceremony with sleep loops (no `sleep 330`, no polling cats of state files) - they burn wall time; any sleep above 60 seconds is FORBIDDEN (sole exception: the KILLED-CALL RECOVERY procedure of your relay agent profile, only after a blocking call was actually killed).",
    "3) done:true -> run the gate yourself" + (testCommandQuick ? " (QUICK gate: " + testCommandQuick + " - the full authoritative gate runs at merge)" : "") + " and inspect git diff; red gate or empty diff -> completed=false with details. done:false -> completed=false with the stopReason and what landed.",
    "4) Commit ONLY the files the ceremony changed (never `git add -A`); verify `git show --stat HEAD` lists only your files; if a hook staged .beads/issues.jsonl: git checkout <pre-commit HEAD> -- .beads/issues.jsonl && git add .beads/issues.jsonl && git commit --amend --no-edit.",
    "HEAD REPORT (mandatory): after your FINAL commit run `git rev-parse HEAD` on YOUR branch and report the full SHA in the `head` field - review and merge verify exactly this commit after the repair.",
    "5) Report: what_done (incl. ceremony receipt summary: rounds, stopReason), files_changed, verification (YOUR OWN gate run with numbers), branch, worktree, head (40-hex SHA), completed, testsAddedOrUpdated, commandsRun, validationOutput, residualRisks, noStagedFiles, criteriaSatisfied.",
    "", GIT_RULES, CMDS, NO_SCRATCH_DEBUG, FACTS, ACC_STRUCTURED,
    "If you need a decision beyond your scope, ask the calling side via contact_supervisor instead of guessing."
  ].join("\n");
  return runChild(taskKey(t, "repair"), withGate(Object.assign({ task: lines, outputSchema: WORK_SCHEMA }, rec.wm ? { model: rec.wm } : {}), true)).then(
    function (w) {
      const o = outOf(w);
      rec.iterations++;
      noteFiles(rec, o);
      return o;
    },
    function (e) {
      return { what_done: "ledger repair failed: " + String(e).slice(0, 200), completed: false };
    }
  );
}

function postPhase(t, rec, wOut, parallel) {
  if (wOut && wOut.head) rec.head = String(wOut.head);
  const slug = rec.branch;
  const useLedger = engineOf(t) === "ledger";
  // Manifest discipline: the deterministic path is authoritative; an actor-reported
  // ABSOLUTE worktree is accepted only when its LAST path component EQUALS the
  // deterministic basename (a substring match would pass wt-t1-task-10 for
  // wt-t1-task-1) and the path is absolute - a child-provided arbitrary directory
  // is never trusted blind.
  if (wOut && wOut.worktree) {
    const rep = String(wOut.worktree).replace(/[\\/]+$/, "");
    const repLast = (rep.split(/[\\/]/).pop() || "").toLowerCase();
    const repAbsolute = /^[A-Za-z]:[\\/]/.test(rep) || rep.slice(0, 1) === "/";
    if (repAbsolute && repLast === wtBaseName(t, rec).toLowerCase()) {
      rec.worktree = rep;
    }
  }
  const wt = rec.worktree || wtPathFor(t, rec);
  const wtNote = "Worktree for this task: \"" + wt + "\" (cd there first; all edits, tests and commits happen inside it). ";
  function doMerge() {
    // CODE GATE (not prompt-only): integration is refused without HEAD evidence.
    // Review still runs (it may route the task into rework); only the MERGE requires
    // a verified head. workPhase catches and ledgerRepair both fill rec.head.
    if (!rec.head) {
      rec.verdict = "no-head-reported";
      rec.stop = "merge: no HEAD SHA reported";
      log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": no HEAD SHA reported by any work/rework/repair round - integration refused (branch " + slug + " left for manual review)");
      return Promise.resolve();
    }
    const mergeLines = [
      "You are the MERGER. Deliver the approved branch to main and write the sprint journal.",
      "Branch: " + slug + " | Task: " + t.title,
      "The branch is checked out in worktree \"" + wt + "\" - do NOT cd there; operate in the main working copy (the ONLY exceptions are the step (1) rebase commands that run via `git -C` inside the worktree).",
      "(0a) in the MAIN working copy verify `git status --porcelain --untracked-files=no` is EMPTY (untracked files such as the campaign journal are not dirt). " + claimDirtRule("reply merged=false, checks_ok=false, journal_written=false, merge_commit='', note='claim-dirt auto-commit failed: .beads/issues.jsonl still dirty'") + "Any OTHER dirty path -> reply merged=false, checks_ok=false, journal_written=false, note='main working copy dirty: <path>' and make NO git changes.",
      "Approved HEAD SHA: " + (rec.head || "NONE RECORDED") + ".",
      "(0) verify the branch still points at the approved SHA: `git rev-parse " + slug + "`; if it differs" + (rec.head ? "" : " (or no SHA was recorded)") + " -> reply merged=false, checks_ok=false, journal_written=false, note='branch moved after review' and make NO git changes.",
      "Steps: (1) FIRST collapse the branch into ONE commit so the whole leaf needs at most ONE conflict-resolution pass (the leaf lands as a single squash anyway - per-commit replay is wasted passes): `git -C \"" + wt + "\" merge-base main " + slug + "` -> note the BASE sha it prints; `git -C \"" + wt + "\" reset --soft <BASE>` (changes stay staged - safe); `git -C \"" + wt + "\" commit -m <conventional message for this task>`; then `git -C \"" + wt + "\" rebase main` - 'Already up to date' means skip; if CONFLICTS: resolve them IN THE WORKTREE preserving BOTH intents - read the sibling branches' diffs (`git log main --oneline -8`, `git show <other-branch>`) so a sibling task's change survives your resolution, then `git -C \"" + wt + "\" add <resolved-files>` and `git -C \"" + wt + "\" rebase --continue` (a rebase left in progress = failed merge, go to step (5)); (1b) back in the MAIN copy: `git checkout main && git merge --squash " + slug + "` - after the collapse+rebase this stages a non-conflicting change set; (2) run main checks: " + testCommand,
      mergeApproval === "confirm"
        ? "(2.5) MANDATORY before committing: ask the calling side via contact_supervisor (reason: \"merge approval\") - show the diff stat and the check result; wait for the reply; if refused, abort with merged=false. If contact_supervisor is unavailable after 2 attempts: `git reset --hard` back to pre-merge main and reply merged=false, checks_ok=false, journal_written=false, note=\"supervisor unavailable\"."
        : "(2.5) mergeApproval is auto (headless viability: NO supervisor round for the merge decision): commit ONLY when the mechanical evidence has CONVERGED - (a) step (1) collapse+rebase completed clean: `git -C \"" + wt + "\" status` shows a clean worktree with no rebase in progress AND `git -C \"" + wt + "\" log --oneline main.." + slug + "` lists exactly ONE commit (the approved pre-collapse SHA from step (0) is superseded by the collapse - content is gated by (b)+(c)), (b) the squash staged a NON-EMPTY, CLEAN change set: `git diff --cached --stat` prints a real change set AND `git diff --cached --check` reports nothing (no conflict markers), (c) the FULL suite (step 2) is green on main, (d) the main tree was clean (step 0a). Any piece missing or red = failed merge: apply step (5) - `git reset --hard` back to pre-merge main, reply merged=false, checks_ok=false, journal_written=false.",
      MAIN_BRANCH_NOTE,
      "(3) green: `git commit` with a conventional message, then `git rev-parse HEAD` - report the merge commit SHA as merge_commit (empty string when the merge did not land); (4) append ONE json line to " + journalDir + "/sprint-" + sprint + ".jsonl (create the dir): {\"task\": " + JSON.stringify(t.title) + ", \"verdict\": \"merged\", \"branch\": " + JSON.stringify(slug) + ", \"head\": " + JSON.stringify(rec.head || "") + ", \"note\": <1-line>}; (5) red checks or refusal: `git reset --hard` back to pre-merge main, append the line with verdict \"merge-failed\" instead.",
      sddActive && t.sdd_item ? "(4.5) SDD WRITE-BACK (BEFORE the merge commit): in " + sddTasksFile + " flip THIS task's item from '[ ]' to '[x]' - the exact line is " + JSON.stringify(String(t.sdd_item)) + " - then `git add " + sddTasksFile + "` so it lands INSIDE the merge commit. Do NOT create a separate 'sdd:' commit. Skip silently if the line is already [x]." : "",
      ...(bdEpic && t.id ? [
        "(4.6) BD CLOSE (mechanical bookkeeping, NOT a judgment call; ONLY after step (3) landed the merge commit - skip entirely when the merge did not land): leaf " + t.id + " carries a FINAL done verdict now - close it in bd so bd catches up with the merge (a headless campaign must reach bd-epic-closed on its own). BEST-EFFORT BY CLOSING: a bd failure or refusal NEVER fails the merge - report it and go on; but a FAILED GIT COMMAND here is NEVER swallowed silently.",
        "Run each command line below from the MAIN working copy, piped stdin, VERBATIM (the grep pre-check skips an already-closed leaf without error - a driver's close is never overwritten); <merge_commit> is the SHA from step (3):",
        "  bd show " + t.id + " --json </dev/null | grep -q '\"status\": *\"closed\"' || bd close " + t.id + " -r \"" + t.id + ": merge <merge_commit> - merged\" </dev/null",
        "The -r string is the MECHANICAL close comment: leaf id, merge commit, short verdict - exactly this form, no prose.",
        "Then flush the JSONL export and commit it to the integration tree (keeps the main copy clean for the NEXT merge pre-flight; NEVER `git add -A`, only this one file). NO `|| true` - a failed git command must SURFACE:",
        "  bd export </dev/null",
        "  git add .beads/issues.jsonl && git commit -m \"chore(bd): auto-close done leaf (" + t.id + ")\"",
        "Then VERIFY: `git status --porcelain -- .beads/issues.jsonl` must print NOTHING - only a CLEAN path proves the commit landed. If the path is STILL dirty (the add/commit/export failed: locked index, missing user identity, hook rejection), do NOT retry blindly and do NOT reset: report bd_closed=false with note='bd export commit failed: .beads/issues.jsonl still dirty' (the merge verdict stands; the post-loop close retries the export).",
        "NEVER close an id NOT listed here; do NOT create or modify any other bd issue.",
        "Report bd_closed=true ONLY when the leaf is closed in bd (you closed it, or the pre-check found it closed already) AND the export commit landed clean (`git status --porcelain -- .beads/issues.jsonl` prints nothing); bd_closed=false otherwise, with the reason in note - the merge verdict stands either way."
      ] : []),
      "(6) cleanup: `git worktree remove \"" + wt + "\"` (branch stays; if the worktree is dirty, leave it and say so in note).",
      "", GIT_RULES, CMDS, FACTS, FINAL_MSG,
      "Schema keys: merged, checks_ok, journal_written, merge_commit, note" + (bdEpic && t.id ? ", bd_closed (boolean - set it whenever the (4.6) bd close step ran)" : "") + "."
    ].filter(Boolean).join("\n");
    return runChild(taskKey(t, "merge"), childOpts({ task: mergeLines, outputSchema: MERGE_SCHEMA })).then(
      function (mg) {
        const mOut = outOf(mg);
        // A merge that reports success but a red/missing check gate is NOT merged:
        // the integration evidence must be complete, not just the git operation.
        rec.verdict = (mOut.merged === true && mOut.checks_ok === true) ? "merged" : "merge-failed";
        if (rec.verdict === "merge-failed") rec.stop = "merge: merged/checks_ok not confirmed";
        // Merge commit lands on main - the bd-close comment carries it as evidence.
        if (rec.verdict === "merged" && mOut.merge_commit) rec.mergeCommit = String(mOut.merge_commit);
        // MERGER bd-close (perf: boundary children burned 1.5-4 min per boundary on it):
        // the merger closes the leaf it just merged - best-effort. Only a CONFIRMED close
        // marks bdClosedIds (exactly-once); an unconfirmed one stays unmarked and is
        // retried by the post-loop child or the driver. A close failure never fails the merge.
        if (rec.verdict === "merged" && bdEpic && t.id) {
          if (mOut.bd_closed === true) {
            bdClosedIds.add(String(t.id));
            log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": merge bd-close closed " + t.id + " in bd");
          } else {
            log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": merge bd-close not confirmed (" + String(mOut.note || "no bd_closed report").slice(0, 140) + "); leaf " + t.id + " stays open in bd (post-hoc close possible)");
          }
        }
        log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": " + rec.verdict);
      },
      function (e) {
        rec.verdict = "merge-failed";
        rec.stop = "merge: merger child failed";
        log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": merger failed (" + String(e).slice(0, 120) + ")");
      }
    ).catch(function (e) {
      // CATCH-WRAP: a failure AFTER the child answered (a throw inside the handlers
      // above - bookkeeping, logging, an engine edge) must neither abort the campaign
      // nor poison mergeChain (a REJECTED chain silently no-ops every later merge/drop
      // on it). An unlanded merge resolves merged=false (verdict merge-failed); a merge
      // that already landed keeps its verdict. Never silent: the reason is logged.
      const msg = String((e && e.message) || e).slice(0, 140);
      if (rec.verdict === "merged") {
        log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": merge landed but post-merge bookkeeping failed (" + msg + ")");
        return;
      }
      rec.verdict = "merge-failed";
      rec.stop = "merge: merger child failed";
      log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": merger failed (" + msg + ")");
    });
  }
  function doArbitrate(reworkNotes, curWOut) {
    // Decision-only: the arbiter child NEVER mutates git. merge-as-is/drop-branch are
    // applied by the ORCHESTRATOR through the shared mergeChain (single main-writer,
    // same queue as ordinary merges); one-more-round becomes an orchestrator-driven
    // rework round (at most one per task - a repeated request is forced to drop).
    const arbLines = [
      "You are the ARBITER. A task exhausted its rework budget without reviewer approval.",
      "Task: " + t.title + " | Branch: " + slug + " | Iterations: " + rec.iterations,
      "Last reviewer verdict: " + String(reworkNotes || "").slice(0, 600),
      "Last worker report: " + JSON.stringify(curWOut).slice(0, 600),
      "",
      "READ-ONLY ROLE (hard): you do NOT run any git write commands and do NOT modify anything - you DECIDE; the orchestrator applies your decision.",
      "MANDATORY: ask the calling side via contact_supervisor (reason: \"task-rework-exhausted\") with the situation summary; options you offer: merge-as-is / drop-branch / one-more-round" + (escalateLedger && ledgerAvailable && !useLedger ? " / escalate-ledger (recommended when the task looks genuinely nontrivial and the gate is objective: one repair ledger-solve ceremony runs on the existing branch before merge/drop)" : "") + ".",
      "(fallback) If contact_supervisor is unavailable after 2 attempts: decision=drop-branch, note='supervisor unavailable - defaulted to drop'.",
      MAIN_BRANCH_NOTE,
      "", GIT_RULES, CMDS, FACTS, FINAL_MSG,
      "Schema keys: decision (merge-as-is | drop-branch | one-more-round | escalate-ledger), note (= the caller's decision + 1 line why)."
    ].filter(Boolean).join("\n");
    const arbSpec = { task: arbLines, outputSchema: ARB_SCHEMA };
    const avm = nextReviewModel(rec.wm);
    if (avm) arbSpec.model = avm;
    return runChild(taskKey(t, "arbiter"), childOpts(arbSpec, "review")).then(
      function (ab) {
        const aOut = outOf(ab);
        const decision = String(aOut.decision || "").trim().toLowerCase();
        const note = String(aOut.note || "");
        rec.arbRounds = (rec.arbRounds || 0) + 1;
        if (decision === "escalate-ledger" && escalateLedger && ledgerAvailable && !useLedger && rec.escalated !== true) {
          rec.escalated = true;
          log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": escalating to ledger engine (repair ceremony on branch " + slug + ")");
          return ledgerRepair(t, rec, parallel, note).then(function (repOut) {
            if (repOut && repOut.head) rec.head = String(repOut.head);
            // Same rule as postPhase/doRework: a completed=false repair report is the
            // ceremony's own rejection - a fresh review child would only re-reject it
            // and burn a review round (and the arbiter ladder) on a doomed candidate.
            // Verdict failed WITHOUT a review child; the campaign moves on and the
            // branch goes to the boundary janitor.
            if (!repOut || repOut.completed !== true) {
              rec.verdict = "failed";
              rec.stop = "ledger repair: completed=false";
              log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": ledger repair completed=" + String((repOut || {}).completed) + " - rejected work is not reviewed, verdict failed (branch " + slug + " left for cleanup)");
              return Promise.resolve();
            }
            return reviewRound(0, "", repOut);
          });
        }
        if (decision === "merge-as-is") {
          mergeChain = mergeChain.then(function () { return doMerge(); }).then(function () {
            if (rec.verdict === "merged") rec.verdict = "merged-after-arbitration";
          });
          return mergeChain;
        }
        if (decision === "drop-branch" || (decision === "one-more-round" && rec.arbRounds > 1)) {
          if (decision === "one-more-round") log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": arbiter repeated one-more-round; forcing drop (max one arbiter round)");
          mergeChain = mergeChain.then(function () { return doDrop(); });
          return mergeChain;
        }
        if (decision === "one-more-round") {
          repairUsedCount++;
          log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": arbiter granted one more round");
          return doRework((reworkNotes ? reworkNotes + " | " : "") + note, reworkLimit, curWOut);
        }
        rec.verdict = "arbiter-failed";
        rec.stop = "arbitration: no usable decision";
        log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": arbiter returned no usable decision (" + (decision || "empty") + ") - branch " + slug + " left for manual review");
      },
      function (e) {
        rec.verdict = "arbiter-failed";
        rec.stop = "arbitration: arbiter child failed";
        log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": arbiter failed (" + String(e).slice(0, 120) + ") - branch " + slug + " left for manual review");
      }
    );
  }
  function doDrop() {
    const dropLines = [
      "You are the DROP EXECUTOR. The arbiter decided drop-branch: remove the task branch and write the journal line.",
      "Task: " + t.title + " | Branch: " + slug,
      "Steps IN THE MAIN WORKING COPY:",
      "(0) in the MAIN working copy verify `git status --porcelain --untracked-files=no` is EMPTY (untracked files such as the campaign journal are not dirt). " + claimDirtRule("reply dropped=false, journal_written=false, note='claim-dirt auto-commit failed: .beads/issues.jsonl still dirty'") + "Any OTHER dirty path -> reply dropped=false, journal_written=false, note='main working copy dirty: <path>' and make NO git changes.",
      "(1) `git worktree remove \"" + wt + "\" --force` (ignore errors if it is already gone); `git checkout main`;",
      "(2) `git branch -D " + slug + "`;",
      "(3) append ONE json line to " + journalDir + "/sprint-" + sprint + ".jsonl (create the dir if needed): {\"task\": " + JSON.stringify(t.title) + ", \"verdict\": \"dropped\", \"branch\": " + JSON.stringify(slug) + ", \"note\": <1-line>};",
      "Never touch other branches; no other git writes.",
      "", MAIN_BRANCH_NOTE, GIT_RULES, CMDS, FACTS, FINAL_MSG,
      "Schema keys: dropped, journal_written, note."
    ].filter(Boolean).join("\n");
    return runChild(taskKey(t, "drop"), childOpts({ task: dropLines, outputSchema: DROP_SCHEMA })).then(
      function (d) {
        const o = outOf(d);
        rec.verdict = o.dropped === true ? "dropped" : "drop-failed";
        rec.stop = "arbitration: drop-branch decided";
        log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": dropped (" + String(o.note || "").slice(0, 100) + ")");
      },
      function (e) {
        rec.verdict = "drop-failed";
        rec.stop = "arbitration: drop child failed";
        log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": drop failed (" + String(e).slice(0, 120) + ") - branch " + slug + " left for manual review");
      }
    );
  }
  function reviewRound(r, reworkNotes, curWOut) {
    const tier = reviewTierOf(t.review);
    if (tier === "none") {
      // review tier none: NO review child. Approval is the worker's own completed flag;
      // the merge gate (HEAD required, checks_ok) and acceptance evidence still apply.
      return decide(
        (curWOut && curWOut.completed === true)
          ? { approved: true }
          : { approved: false, rework_reasons: "worker reported completed=false (review tier none: no reviewer ran)" },
        curWOut, r, reworkNotes
      );
    }
    // Contract pre-check BEFORE the LLM reviewer: a header/files_hint that names files the
    // branch never touched is a fast, mechanical rejection - the review child is not launched.
    const preMismatch = contractMismatch(t, (curWOut && Array.isArray(curWOut.files_changed)) ? curWOut.files_changed : []);
    if (preMismatch) {
      rec.verdict = "failed";
      rec.stop = "contract pre-check: " + preMismatch;
      log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": contract pre-check mismatch (" + preMismatch + ") - review child skipped, verdict failed (branch " + slug + " left for cleanup)");
      return Promise.resolve();
    }
    const revLines = [
      "You are the CODE REVIEWER. Fresh eyes, read-only: do NOT modify any files.",
      "Campaign goal: " + description,
      "Task under review: " + t.title,
      "Acceptance criteria: " + (t.acceptance || ""),
      "Worker report: " + JSON.stringify(curWOut || wOut).slice(0, 1200),
      "Approved HEAD SHA: " + String((curWOut || wOut || {}).head || "unknown") + " - FIRST verify it: run `git rev-parse " + slug + "`; if the branch head differs from the approved SHA -> approved=false, rework_reasons='branch head moved after the work report'.",
      reworkNotes ? ("Previous rework reasons to re-check: " + reworkNotes) : "",
      "",
      "Review the branch diff: `git log --oneline main.." + slug + "` and `git diff main..." + slug + "` (MAIN BRANCH: if 'main' does not exist, substitute the actual integration branch - typically 'master'; never create 'main').",
      "If the diff vs the integration branch is EMPTY: approved=false with reason 'empty diff - the work never landed on the branch'.",
      ...(tier === "lite" ? [
        "CHECKLIST REVIEW (lite tier, mechanical change): tick each item against the diff; do not build counter-arguments beyond this list.",
        "(a) every acceptance criterion is evidenced by the diff or the worker's verification; (b) the diff holds only the task's mechanical change (renames, moves, uniform edits) - no scope creep; (c) constraints compliance; (d) tests and gate evidence present and not tautological."
      ] : [
        "Judge: (1) does it satisfy every acceptance criterion; (2) correctness incl. edge cases; (3) constraints compliance; (4) no scope creep; (5) tests meaningful, not tautological."
      ]),
      // pf3/rework1 lesson: code on runs.host was 141/141 green in the harness and dead
      // in production. Harness-green is NOT production evidence for runtime-boundary
      // assumptions - the reviewer must verify them against the REAL launch path.
      "RUNTIME-BOUNDARY RULE: if the change depends on runtime primitives (host channels like runs.host, launch mode, env, host limits), you MUST verify their availability in the REAL launch path (host/launcher sources or docs), NOT only in the test harness; 'harness-green' is NOT production evidence for such changes - an unverifiable runtime assumption -> approved=false with the unverified boundary named in rework_reasons.",
      "approved=false requires concrete, actionable rework_reasons.",
      "approved=false with CONCRETE per-file fixes -> also emit fix_list: [{\"file\": \"<path>\", \"fix\": \"<the exact edit>\"}] - the rework child then applies ONLY these fixes without re-researching the task; omit fix_list for design-level or exploratory rework.",
      FACTS, FINAL_MSG,
      "Schema keys: approved, rework_reasons, notes; optional fix_list (see above)."
    ].filter(Boolean).join("\n");
    const revSpec = { task: revLines, outputSchema: REVIEW_SCHEMA };
    const rvm = nextReviewModel(rec.wm); // rotation + skip the author's model (cross-model per task)
    if (rvm) revSpec.model = rvm; // never pass model:undefined - poisons the launch spec
    return runChild(taskKey(t, "review" + (r > 0 ? "-r" + r : "")), childOpts(revSpec, "review")).then(
      function (v) { return decide(outOf(v), curWOut, r, reworkNotes); },
      function (e) {
        // reviewer child failed after retries -> synthesize not-approved, same flow
        return decide({ approved: false, rework_reasons: "reviewer failed: " + String(e).slice(0, 200) }, curWOut, r, reworkNotes);
      }
    );
  }
  function decide(vOut, curWOut, r, prevNotes) {
    if (vOut && vOut.approved === true) {
      mergeChain = mergeChain.then(function () { return doMerge(); });
      return mergeChain;
    }
    const notes = String((vOut && vOut.rework_reasons) || "").slice(0, 800) || prevNotes;
    if (r >= reworkLimit) return doArbitrate(notes, curWOut);
    return doRework(notes, r, curWOut, fixListOf(vOut));
  }
  function doRework(notes, r, curWOut, fixList) {
    // FIX-ONLY rework (perf): a well-formed reviewer fix_list replaces the re-research -
    // the child applies EXACTLY the listed edits under a scope guard; the FULL gate
    // ("Verification command") and the downstream review/merge flow stay unchanged.
    // Null/empty list -> the legacy full rework brief, byte-for-byte as before.
    const fixOnly = Array.isArray(fixList) && fixList.length > 0;
    const rwLines = (fixOnly ? [
      "You are the TASK WORKER (rework round " + (r + 1) + ", FIX-ONLY): the reviewer supplied a structured fix-list.",
      "Apply ONLY these fixes - exactly the items below, nothing else; do NOT re-research the task, do NOT re-plan, do NOT refactor or touch anything beyond the list.",
      fixList.map(function (f, i) { return "FIX " + (i + 1) + " [" + f.file + "]: " + f.fix; }).join("\n"),
      "Affected files (scope guard: touch ONLY these): " + fixList.map(function (f) { return f.file; }).filter(function (f, i, a) { return a.indexOf(f) === i; }).join(", ")
    ] : [
      "You are the TASK WORKER (rework round " + (r + 1) + "). Same task, same rules as before.",
      "Task: " + t.title,
      "Acceptance criteria: " + (t.acceptance || "")
    ]).concat([
      "Branch: " + slug + " (continue on it; do NOT create a new branch).",
      parallel ? wtNote : "",
      (fixOnly ? "Reviewer verdict reasons (context only): " : "Reviewer rework reasons to address: ") + notes,
      "Verification command: " + testCommand,
      "", "Global constraints: " + constraints, GIT_RULES, CMDS, NO_SCRATCH_DEBUG,
      "HEAD REPORT (mandatory): after your FINAL commit run `git rev-parse HEAD` and report the full SHA in the `head` field.",
      "Commit your fixes to the same branch; leave the working copy clean.",
      (useLedger ? "Rework fixes are SMALL and focused: implement them DIRECTLY yourself - do NOT launch a new ledger ceremony." : ""),
      FACTS, ACC_STRUCTURED,
      "Report format: what_done, files_changed, verification, branch, worktree, head (40-hex SHA), completed, testsAddedOrUpdated, commandsRun, validationOutput, residualRisks, noStagedFiles, criteriaSatisfied."
    ]).filter(Boolean).join("\n");
    const rwSpec = { task: rwLines, outputSchema: WORK_SCHEMA };
    if (engineOf(t) === "sdd") rwSpec.agent = "sdd-worker"; // engineOf here: sddEngine lives in workPhase scope, not reviewRound — old code would ReferenceError at first rework
    if (rec.wm) rwSpec.model = rec.wm; // SAME worker continues the work - rework pins the task's model, rotation picks the next task
    return runChild(taskKey(t, "rework" + (r + 1)), withGate(rwSpec, useLedger)).then(
      function (w2) {
        const o2 = outOf(w2);
        rec.iterations++;
        noteFiles(rec, o2);
        if (o2 && o2.head) rec.head = String(o2.head); // re-review/merge verify the NEW head, not the stale one
        // Same rule as postPhase: a completed=false rework report is the worker's own
        // rejection - a fresh review child would only re-reject it and burn the
        // arbiter/drop ladder. Verdict failed WITHOUT a review child; the campaign
        // moves on and the branch goes to the boundary janitor.
        if (!o2 || o2.completed !== true) {
          rec.verdict = "failed";
          rec.stop = "rework " + (r + 1) + ": completed=false";
          log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": rework " + (r + 1) + " completed=" + String((o2 || {}).completed) + " - rejected work is not reviewed, verdict failed (branch " + slug + " left for cleanup)");
          return Promise.resolve();
        }
        return reviewRound(r + 1, notes, o2);
      },
      function (e) {
        const msg = String((e && e.message) || e);
        log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": rework " + (r + 1) + " failed (" + msg.slice(0, 120) + ")");
        if (!REPORT_SHAPE_RE.test(msg)) return reviewRound(r + 1, notes, curWOut); // work-class failure (not an acceptance rejection) - nothing to recover
        if (rec.repaired) {
          // Acceptance-rejected rework with the salvage already spent: the rework report
          // was never accepted, so it is not a reviewable candidate. Verdict failed WITHOUT
          // a review child (same rule as the completed=false gates above).
          rec.verdict = "failed";
          rec.stop = "rework " + (r + 1) + ": acceptance-rejected (report-repair already used)";
          log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": rework " + (r + 1) + " rejected by acceptance after report-repair was already used - rejected work is not reviewed, verdict failed (branch " + slug + " left for cleanup)");
          return Promise.resolve();
        }
        return salvageReport({ t: t, rec: rec, slug: slug, wt: wt, parallel: parallel, testCommand: testCommand, testCommandQuick: testCommandQuick, useLedger: useLedger, sprint: sprint }, "rework" + (r + 1)).then(function (o3) {
          // Same rule as postPhase: salvage failed or honestly reports the work
          // incomplete (completed!==true) - no report says "reviewable". Verdict
          // failed WITHOUT a review child; never re-review a rejected candidate.
          if (!o3 || o3.completed !== true) {
            rec.verdict = "failed";
            rec.stop = "rework " + (r + 1) + ": report-repair completed=false";
            log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": rework " + (r + 1) + " report-repair completed=" + String((o3 || {}).completed) + " - rejected work is not reviewed, verdict failed (branch " + slug + " left for cleanup)");
            return Promise.resolve();
          }
          if (o3.head) rec.head = String(o3.head); // re-review verifies the (unchanged) branch head
          return reviewRound(r + 1, notes, o3);
        });
      }
    );
  }
  // Rejected work is never reviewed: a completed=false report (an honest worker, or
  // a failed work/rework/repair round) marks a doomed candidate - eager review would
  // only burn a review child (and the rework ladder) on the worker's own rejection.
  // Verdict failed WITHOUT a review child; the campaign moves on and the branch goes
  // to the boundary janitor. (rp-schema: every validated report carries a 40-hex head,
  // so the rec.head below is always fresh; the no-head-reported merge gate stays as
  // defense-in-depth only.)
  if (!wOut || wOut.completed !== true) {
    rec.verdict = "failed";
    rec.stop = "work: completed=false";
    log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": work completed=" + String((wOut || {}).completed) + " - rejected work is not reviewed, verdict failed (branch " + slug + " left for cleanup)");
    return Promise.resolve();
  }
  return reviewRound(0, "", wOut);
}

function bucketWaves(taskArr) {
  // returns [{wave, tasks}] ascending; ungrouped tasks become singleton waves in listed order;
  // maxParallel === 1 forces the legacy fully-sequential behavior.
  // NO maxParallel slicing: the wave loop is a ROLLING POOL now - within-wave
  // concurrency is workSlots = min(maxParallel, tasks); slicing here would stall
  // tasks beyond the cap until the whole wave (postPhases + wave gate) drains.
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
  const out = [];
  for (const w of keys) out.push({ wave: w, tasks: byWave[w] });
  for (const t of seqQueue) out.push({ wave: 0, tasks: [t] });
  return out;
}

// --- campaign-level state (declared BEFORE phase 0: the SDD catch writes stopReason)
let continueCampaign = true;
let stopReason = "";

// --- phase 0: SDD task-engine (campaign-level; runs once) --------------------------
// Artifacts first, code never: an sdd-worker child classifies the campaign and,
// for feature-shaped goals, walks the sdd chain to produce the authoritative
// tasks.md the curator then derives sprint tasks from (write-back on merge).
let sddActive = false;
let sddTasksFile = "";
let sddItemsTotal = 0;
if (sddOverride !== "off" && taskSource !== "bd-epic") {
  const sddLines = [
    "You are the SDD TASK-ENGINE for a sprint campaign in this repository.",
    "Campaign goal: " + description,
    "",
    "Your job: make SDD artifacts the TASK SOURCE of the campaign. Artifacts first, code never - do NOT touch any code files.",
    sddOverride === "on"
      ? "The caller FORCED SDD mode: skip classification and produce the artifacts."
      : "CLASSIFY the campaign goal: feature work / new behavior / unsettled design -> mode=sdd. A batch of known bugfixes / cleanup / routine mechanics -> mode=skip (ceremony waste).",
    "",
    "If mode=sdd:",
    "1. Resume case: if " + sddDir + " already contains a spec with tasks.md, validate its .status files, change nothing, report mode=sdd, tasks_file=<repo-relative path to tasks.md>, items_total=<count of UNCHECKED items>.",
    "2. Fresh case: walk the SDD chain using the sdd-* skills available to you (read each SKILL.md first): sdd-idea -> sdd-prd -> sdd-spec -> sdd-tasks. Self-answer clarifying questions (approval is delegated) and record decisions in the artifacts' Gate Log; gate .status files advance accordingly.",
    "3. Artifacts live under " + sddDir + "/specs/<slug>/ (requirements.md, design.md, tasks.md + .status). tasks.md = checkbox items, each independently deliverable in ~one worker session and verifiable by the campaign gate. Commit the artifacts to the current branch: 'sdd: campaign spec <slug>'.",
    "4. Report: mode=sdd, tasks_file=<repo-relative path to tasks.md>, items_total=<unchecked count>, reason=<1 line>.",
    "If mode=skip: tasks_file='', items_total=0, reason=<1 line>.",
    "", CMDS, FACTS, FINAL_MSG,
    "Schema keys: mode, reason, tasks_file, items_total."
  ].join("\n");
  try {
    const sddRes = await runChild("sdd-setup", childOpts({ agent: "sdd-worker", task: sddLines, outputSchema: SDD_SCHEMA, timeoutMs: 5400000, toolTimeoutMs: 900000 }));
    const sOut = outOf(sddRes);
    sddTasksFile = String(sOut.tasks_file || "");
    sddActive = sOut.mode === "sdd" && !!sddTasksFile;
    sddItemsTotal = Number(sOut.items_total) || 0;
    log.push("sdd-setup: mode=" + String(sOut.mode || "?") + " (" + String(sOut.reason || "").slice(0, 140) + ")");
    if (sOut.mode === "sdd" && !sddTasksFile) log.push("sdd-setup: mode=sdd but tasks_file missing; SDD task engine disabled");
  } catch (e) {
    log.push("sdd-setup failed (" + String(e).slice(0, 120) + ")");
    if (sddOverride === "on") {
      // FORCED SDD: a failed spec phase must not silently degrade into bare work.
      stopReason = "sdd-setup-failed";
    } else {
      log.push("continuing without the SDD task engine (auto classification)");
    }
  }
}

// --- main loop ---------------------------------------------------------------------

while (sprint < maxSprints && continueCampaign && !stopReason) {
  if (Date.now() + 600000 >= deadlineMs) { stopReason = "budget exhausted"; break; }
  sprint++;
  log.push("sprint " + sprint + ": start");

  let tasks = [];
  if (taskSource === "bd-epic") {
    // doneWhen pre-check BEFORE any refresh: an already-closed epic costs zero children.
    // STRICT predicate on purpose: this snapshot has not seen a cursor refresh yet, so
    // "every open leaf is already merged by us" must NOT stop the campaign here - the
    // refresh may reveal growth. Driver-lag tolerance lives in the POST-refresh check.
    if (bdSnapshot.length && doneWhen === "bd-epic-closed" && !bdSnapshot.some(function (l) { return l.open; })) {
      stopReason = "epic-closed";
      break;
    }
    // The snapshot changes only through this campaign's merges (driver closes follow merges),
    // so after a completed sprint with 0 merged leaves the previous snapshot is reused and no
    // refresh runs. An empty snapshot (launch or failed refresh) always refreshes.
    // ONE boundary child serves both jobs: the janitor for the previous sprint's never-merged
    // leftovers (they must be gone before this sprint's retries start) and, when the snapshot
    // can have changed, the mechanical refresh that picks up mid-flight growth.
    const prevMerged = taskResults.filter(function (r) {
      return r.sprint === sprint - 1 && (r.verdict === "merged" || r.verdict === "merged-after-arbitration");
    }).length;
    const refresh = bdSnapshot.length === 0 || (sprint > 1 && prevMerged > 0);
    const prevLeft = leftoverEntries(taskResults.filter(function (r) { return r.sprint === sprint - 1; }));
    // bd-close is NOT a boundary duty anymore (perf: it burned 1.5-4 min per boundary):
    // each MERGE child closes the leaf it just merged (best-effort); the boundary child
    // is janitor + cursor only. Sprints without merges and without leftovers still skip it.
    if (refresh || prevLeft.length) {
      try {
        const bd = await runChild("s" + sprint + "-boundary", childOpts({ task: boundaryBrief(prevLeft, refresh), outputSchema: BOUNDARY_SCHEMA, acceptance: false }));
        const bo = outOf(bd);
        if (prevLeft.length) {
          const cleanedN = (bo.cleaned || []).filter(function (c) { return c.removed === true; }).length;
          log.push("sprint " + sprint + ": boundary cleanup removed " + cleanedN + "/" + prevLeft.length + " leftover(s)");
        }
        if (refresh && Array.isArray(bo.leaves) && bo.leaves.length) {
          bdSnapshot = bo.leaves.map(normalizeLeaf);
          log.push("bd-cursor: snapshot refreshed (" + bdSnapshot.filter(function (l) { return l.open; }).length + " open / " + bdSnapshot.length + " leaves)");
        }
      } catch (e) {
        log.push("sprint " + sprint + ": boundary child failed (" + String(e).slice(0, 120) + ")" + (refresh ? "; continuing on the previous snapshot" : "") + (prevLeft.length ? "; leftovers remain" : ""));
      }
    }
    if (refresh) {
      // Same predicate as the pre-check: snapshot-open leaves that this campaign
      // already merged do not block epic-closed (end-of-campaign driver-lag race).
      if (bdSnapshot.length && doneWhen === "bd-epic-closed" && !bdSnapshot.some(function (l) { return l.open && !doneSet().has(String(l.id)); })) {
        stopReason = "epic-closed";
        break;
      }
    } else if (sprint > 1) {
      log.push("bd-cursor: skipped (sprint " + (sprint - 1) + " merged 0 leaves; previous snapshot reused)");
    }
    const doneIds = doneSet();
    // A leaf already merged by THIS campaign must never re-run, even when the
    // cursor snapshot is stale (driver lag between our merge and its bd close).
    const ready = bdSnapshot.filter(function (l) {
      return l.open && !doneIds.has(String(l.id)) && l.deps.every(function (d) { return doneIds.has(String(d)); });
    });
    tasks = ready.slice(0, sprintTasks);
    tasks.forEach(function (t) { t.wave = 1; }); // deps live OUTSIDE this sprint -> picked tasks are mutually independent
    plannedTotal += tasks.length;
    log.push("bd-epic: " + ready.length + " ready / " + bdSnapshot.filter(function (l) { return l.open; }).length + " open; taking " + tasks.length + " (driver pre-approved)");
    if (!tasks.length) {
      const openLeft = bdSnapshot.filter(function (l) { return l.open && !doneIds.has(String(l.id)); });
      if (openLeft.length) {
        stopReason = "bd-epic-stalled: open leaves with unsatisfied deps: " + openLeft.map(function (l) { return String(l.id); }).join(",");
        log.push("bd-epic: stalled - " + stopReason);
      } else {
        stopReason = doneWhen === "bd-epic-closed" ? "epic-closed" : "bd tasks exhausted this snapshot";
      }
      break;
    }
  } else {
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
    const disc = await runChild("s" + sprint + "-discovery", childOpts({ task: discLines, outputSchema: DISC_SCHEMA, acceptance: false }));
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
    "ROLE BOUNDARY (HARD - violating this invalidates the plan): you are a PLANNER, not an executor. FORBIDDEN for you: implementing any task; running experiments, training, evaluation or benchmarks; running the project gate/test suite; creating or modifying ANY file; git commit/checkout/branch; long-running commands (>60s). Your job ends at a PLAN. Allowed: reading files and READ-ONLY inspection (ls, rg/grep, cat, git log/status/diff, wc) and at most a couple of trivial read-only one-liners to size tasks - total under ~5 minutes of tooling. If you discover work that needs doing (validation, experiments, measurements) - that becomes a PLAN TASK with engine/engine_reason, never your own execution. If you notice you have run 30+ tool calls without producing the plan, STOP exploring and emit the plan with what you know.",
    "",
    dOut.summary ? ("Discovery summary: " + dOut.summary) : "Discovery unavailable this sprint.",
    dOut.issues && dOut.issues.length ? ("Top issues: " + JSON.stringify(dOut.issues.slice(0, 12))) : "",
    "",
    "Journal: previous sprint results, if any, are in " + journalDir + "/sprint-*.jsonl - read them for lessons and to avoid repeating tasks.",
    sddActive ? "TASK SOURCE (authoritative): this campaign runs off the SDD spec in " + sddDir + ". The ONLY work list is " + sddTasksFile + " (checkbox items). Derive THIS sprint's tasks EXCLUSIVELY from UNCHECKED items in file order, at most " + sprintTasks + ". For each task set `sdd_item` to its checkbox line VERBATIM; `acceptance` MUST carry the item's acceptance criteria from the spec verbatim; `files_hint` from design.md. Discovery/journal are context, not a source. If EVERY item is checked, return an empty tasks array - the campaign is done." : "",
    sddActive ? "Engine selection still applies per task (bare/ledger/sdd as usual): SDD defines WHAT, the engine defines HOW." : "",
    sddActive ? "If " + sddTasksFile + " is unreadable or missing, say so explicitly in sprint_brief and return an empty tasks array." : "",
    "",
    "FORMULA DISCIPLINE: before writing any numeric claim about the codebase (counts, coverage, timings), verify it with a short READ-ONLY script; label unverified claims as hypothesis. Numeric claims about FUTURE work (estimated runtimes, expected scores) are always hypotheses.",
    "Propose at most " + sprintTasks + " tasks for THIS sprint. Each task must be: independently deliverable in one worker session, verifiable by this gate: " + testCommand + ", and small enough to finish within ~30 minutes of work.",
    "PARALLEL PLANNING (preferred): assign EVERY task a `wave` integer (1, 2, 3, ... - the wave number is a DEPENDENCY DEPTH level, not a concurrency slot; a wave MAY hold more tasks than maxParallel). Tasks sharing a wave run through a ROLLING POOL: up to " + maxParallel + " run at once (each isolated in its own git worktree) and the moment one finishes, the next task of the same wave starts immediately - a task never waits for the wave's longest sibling to be reviewed and merged. Bias toward parallel: same wave is the DEFAULT for any tasks that are semantically independent (neither needs the other's change) - PARTIAL FILE OVERLAP is acceptable, the merger resolves textual conflicts at squash time and the gate catches semantic breakage. Use distinct ascending waves ONLY for real dependencies (a task builds on or consumes another task's change). A wave-N task may rely on waves < N being merged. Present the wave structure in your approval request, e.g. 'wave 1: T1+T2+T3 pool of 2 (all independent); wave 2: T4 (uses T1's change)'.",
    "EXECUTOR SELECTION (mandatory per-task CLASSIFICATION, never a default): for EVERY task set `engine` AND `engine_reason` - the reason must name the criterion that decided, not 'default'. Classify by criteria: engine='ledger' requires BOTH (a) the gate objectively verifies the deliverable AND (b) at least one of: multi-site change, algorithmic/invariant-sensitive core, spec adaptation, integration with an existing subsystem, subtle edge cases where plan-before-code discipline pays. engine='sdd' when the task introduces NEW behavior / a feature with unsettled design AND the gate objectively verifies the result (~2x bare: the worker first produces compact spec artifacts on its branch, then implements; needs no relay). engine='bare' when: a simple mechanical change (1-2 files, obvious diff) OR no crisp gate exists (docs, research, UI polish - a trivially-green gate makes ceremony overhead pointless; the reviewer is the verifier there). " + (ledgerAvailable ? "Both 'ledger' and 'sdd' engines are available ('ledger' = plan->do->gate-loop ceremony, ~3-4x bare cost). A sprint mixing engines is NORMAL and expected - an all-bare sprint containing gate-verifiable nontrivial or feature-shaped tasks is a classification defect. " : "'ledger' is NOT available in this run (no relay agent); 'sdd' and 'bare' are. ") + "In the approval request list each task as 'title [engine] criterion'.",
    "Then MANDATORY: send the proposed task list (titles + 1-line rationale + wave + engine + criterion each) to the calling side via contact_supervisor (reason: \"sprint-plan approval\") and WAIT for the reply. Incorporate the reply: adjust, drop or add tasks per the caller's corrections; set approved_by_caller accordingly. If contact_supervisor is unavailable after 2 attempts, proceed with approved_by_caller=false.",
    FINAL_MSG,
    "Schema keys: sprint_brief, approved_by_caller, tasks[{title, rationale, acceptance, files_hint, wave, engine, engine_reason" + (sddActive ? ", sdd_item" : "") + "}]."
  ].filter(Boolean).join("\n");
  let cOut = {};
  let curatorOk = false;
  try {
    const cur = await runChild("s" + sprint + "-curator", childOpts({ task: curLines, outputSchema: CUR_SCHEMA, acceptance: false }));
    cOut = outOf(cur);
    curatorOk = true;
  } catch (e) {
    log.push("sprint " + sprint + ": curator failed (" + String(e).slice(0, 120) + ")");
  }
  tasks = (Array.isArray(cOut.tasks) ? cOut.tasks : []).slice(0, sprintTasks);
  plannedTotal += tasks.length;
  if (!tasks.length) {
    log.push("sprint " + sprint + ": no tasks after curation; stopping campaign");
    stopReason = sddActive ? (curatorOk ? "sdd tasks exhausted (no unchecked items left)" : "curator failed; sdd items likely remain") : "curator returned no tasks";
    break;
  }
  if (cOut.approved_by_caller !== true) {
    log.push("sprint " + sprint + ": caller did NOT approve the curator plan - no workers launched");
    stopReason = "approval-required";
    break;
  }
  log.push("sprint " + sprint + ": " + tasks.length + " task(s) approved by caller");
  } // end curator branch

  // 3. execute tasks (curator's waves: same wave = parallel work in own worktrees) --
  for (let gi = 0; gi < tasks.length; gi++) tasks[gi]._idx = gi;
  const waves = bucketWaves(tasks);
  for (const wave of waves) {
    if (wave.tasks.length === 1) {
      const t = wave.tasks[0];
      const rec = { id: t.id || "", sprint: sprint, title: t.title, branch: branchPrefix + slugify(t.title), iterations: 0, verdict: "unknown" };
      rec.wt = wtPathFor(t, rec);
      const wOut = await workPhase(t, rec, false);
      log.push("sprint " + sprint + " task " + ((t._idx || 0) + 1) + ": work " + (wOut.completed === true ? "ok" : "incomplete") + " (" + rec.iterations + " iter)");
      await postPhase(t, rec, wOut, false);
      taskResults.push(rec);
      recordCarry(rec);
    } else {
      log.push("sprint " + sprint + ": wave " + wave.wave + " rolling pool: [" + wave.tasks.map(function (t) { return "t" + ((t._idx || 0) + 1); }).join(", ") + "], " + Math.max(1, Math.min(maxParallel, wave.tasks.length)) + " work slot(s), shared queue + capped post queue)");
      const recs = wave.tasks.map(function (t) {
        const r = { id: t.id || "", sprint: sprint, title: t.title, branch: branchPrefix + slugify(t.title), iterations: 0, verdict: "unknown" };
        r.wt = wtPathFor(t, r);
        return r;
      });
      // ROLLING POOL with a SHARED QUEUE (work-stealing): workers pull the NEXT
      // unfinished task of the wave the moment a slot frees - a short task never
      // waits behind its lane-mate's long sibling (striped lanes did exactly that:
      // lane i only ever ran tasks i, i+N, ...). postPhase runs OUTSIDE the work
      // slots through a SEPARATE bounded queue (postSlots = maxParallel): reviews
      // stay eager but the review/rework backlog is CAPPED so slow reviews cannot
      // spawn an unbounded tail, and merges still serialize on mergeChain with the
      // FULL suite. The next WAVE still drains everything first.
      const workSlots = Math.max(1, Math.min(maxParallel, wave.tasks.length));
      const postSlots = workSlots;
      let nextTask = 0;
      let postTaken = 0;
      const postQueue = [];
      const allPosts = [];
      function postDrain() {
        while (postTaken < postSlots && postQueue.length) postQueue.shift()();
      }
      function enqueuePost(job, modelHint) {
        // UNAWAITED-LAUNCH TRACKER (wave-4 run 40fa9647 post-mortem): the sandbox
        // counts a runs.run launch as awaited only when its promise chain is threaded
        // - RETURNED at every .then link - into a consumer the script awaits. The old
        // wrapper (bare new Promise resolved from the job's completion callbacks)
        // detached the review/merge chains from the awaited graph: all children
        // completed, yet the workflow failed at completion with 'unawaited runs.run
        // launches' and the return value (with the analytics retro write) was lost.
        // The chain below is returned end-to-end (slot grant -> model gate -> job
        // chain) and lands in allPosts, awaited via Promise.all before the wave ends.
        let grantSlot;
        const slotGrant = new Promise(function (resolve) {
          grantSlot = function () { postTaken++; resolve(); };
        });
        const entry = {};
        entry.promise = slotGrant.then(function () {
          // postTaken (not live postRunning) bounds the queue: the post slot is taken
          // at grant time, the model gate right after, then the job runs.
          return acquireModel(modelHint).then(function () {
            let p;
            try {
              // job() is NOT async: a sync throw in its prelude must neither leak
              // the slot nor reject this chain (Promise.all(allPosts) keeps the old
              // wrapper's never-reject guarantee).
              p = job();
            } catch (eSync) {
              postTaken--;
              releaseModel(modelHint);
              postDrain();
              return undefined;
            }
            return p.then(
              function (r) { postTaken--; releaseModel(modelHint); postDrain(); return r; },
              function (e) { postTaken--; releaseModel(modelHint); postDrain(); }
            );
          });
        });
        allPosts.push(entry.promise); // promises, not wrappers: Promise.all must wait for COMPLETION
        if (postTaken < postSlots) grantSlot();
        else postQueue.push(grantSlot);
      }
      function workWorker() {
        if (nextTask >= wave.tasks.length) return Promise.resolve();
        const idx = nextTask++;
        const t = wave.tasks[idx];
        // Q2: per-model cap on the work-phase long pole (workModel load).
        return acquireModel(workModel || model).then(function () {
          return workPhase(t, recs[idx], true).then(function (wOut) {
            releaseModel(workModel || model);
            log.push("sprint " + sprint + " task " + (idx + 1) + ": work " + (wOut.completed === true ? "ok" : "incomplete") + " (" + recs[idx].iterations + " iter, wave " + wave.wave + ")");
            enqueuePost(function () {
              return postPhase(t, recs[idx], wOut, true).then(function () {
                taskResults.push(recs[idx]);
                recordCarry(recs[idx]);
              }, function (e) {
                log.push("sprint " + sprint + " task " + (idx + 1) + ": postPhase failed (" + String(e).slice(0, 120) + ")");
              });
            }, reviewModel || model);
            return workWorker();
          }, function (e) {
            // Nearly unreachable (workPhase catches its child failures), but the
            // accounting contract holds: EVERY task lands in taskResults.
            releaseModel(workModel || model);
            recs[idx].verdict = "work-failed";
            recs[idx].stop = "work: work-phase error";
            taskResults.push(recs[idx]);
            recordCarry(recs[idx]);
            log.push("sprint " + sprint + " task " + (idx + 1) + ": work failed (" + String(e).slice(0, 120) + ")");
            return workWorker();
          });
        });
      }
      const workers = [];
      for (let wi = 0; wi < workSlots; wi++) workers.push(workWorker());
      await Promise.all(workers);
      await Promise.all(allPosts);
    }
  }

  // sprint boundary checkpoint: phase/progress snapshot for resume reconciliation
  await cpWrite({ phase: "running", sprintDone: sprint, used: usedCount, repairUsed: repairUsedCount, overloadStrikes: Object.assign({}, overloadStrikes) });

  // 4. retrospective (curator campaigns only): in bd-epic federation mode the STOP
  // decision belongs to doneWhen/maxSprints/budget - an LLM retro must not veto a
  // stage that bd still shows open.
  if (taskSource === "bd-epic") {
    // Leftover janitor runs in the next sprint's boundary child (top of the loop).
    log.push("sprint " + sprint + ": retro skipped (bd-epic: stopping owned by doneWhen/maxSprints/budget)");
  } else {
  const retroLines = [
    "You are the RETROSPECTIVE engine for sprint " + sprint + " of the campaign.",
    "Campaign goal: " + description,
    "Task outcomes this sprint: " + JSON.stringify(taskResults.filter(function (r) { return r.sprint === sprint; })),
    "Journal: read " + journalDir + "/sprint-*.jsonl for history.",
    "You may run read-only checks (git log, the test suite: " + testCommand + ") to ground the velocity summary.",
    "Judge stop criteria: is the campaign goal reached, or is there still valuable, safely deliverable work? continue=false only with a concrete reason (goal reached, or diminishing/risky returns).",
    sddActive ? "SDD progress: " + sddTasksFile + " - the campaign is done when ALL its items are checked [x]; unchecked items mean continue=true unless they are unsafe to deliver." : "",
    FACTS, FINAL_MSG,
    "Schema keys: velocity_summary, lessons, continue, reason."
  ].join("\n");
  try {
    const rt = await runChild("s" + sprint + "-retro", childOpts({ task: retroLines, outputSchema: RETRO_SCHEMA, acceptance: false }));
    const rOut = outOf(rt);
    continueCampaign = rOut.continue === true;
    log.push("sprint " + sprint + ": retro continue=" + continueCampaign + " (" + String(rOut.reason || "").slice(0, 120) + ")");
  } catch (e) {
    log.push("sprint " + sprint + ": retro failed (" + String(e).slice(0, 120) + "); defaulting continue=false");
    continueCampaign = false;
  }
  } // end retro else
}

if (!stopReason) {
  if (continueCampaign === false) stopReason = "stop-criteria (retro)";
  else stopReason = "max-sprints reached";
}
// Q4: surface a runtime budget stop over merely-natural reasons (keep meaningful
// reasons like approval-required/curator failures intact).
if (budgetHit && /^(max-sprints reached|stop-criteria \(retro\)|sdd tasks exhausted|curator returned no tasks)/.test(stopReason)) {
  stopReason = "token budget exhausted (runtime usageBudget)";
}
// POST-LOOP bd-close (bd-epic): mergers close their own merges eagerly, but a close can
// fail or go unreported (best-effort) - those would stay open in bd when the loop ends
// (maxSprints/budget/stall/epic-closed).
// One mechanical child closes whatever is still pending, whatever the stopReason.
// Best-effort: a failed close is logged and the merge verdict stands.
if (taskSource === "bd-epic") {
  const finalClosables = bdCloseEntries(taskResults).filter(function (e) { return !bdClosedIds.has(e.id); });
  if (finalClosables.length) {
    try {
      const fb = await runChild("final-bd-close", childOpts({ task: boundaryBrief([], false, finalClosables), outputSchema: BOUNDARY_SCHEMA, acceptance: false }));
      const fbClosed = (outOf(fb).closed || []).filter(function (c) { return c && c.closed === true; }).length;
      log.push("post-loop: bd-close closed " + fbClosed + "/" + finalClosables.length + " done leaf(s) in bd" + (fbClosed < finalClosables.length ? " (rest stays open in bd)" : ""));
    } catch (e) {
      log.push("post-loop: bd-close child failed (" + String(e).slice(0, 120) + "); " + finalClosables.length + " done leaf(s) stay open in bd");
    }
  }
}
// Final cleanup (ALL modes): no leftover worktrees/branches of never-merged work.
// Best-effort by design - a cleanup failure must not corrupt the campaign result.
const finalLeft = leftoverEntries(taskResults);
if (finalLeft.length) {
  try {
    const cm = nextWorkModel();
    const fcl = await runChild("final-cleanup", childOpts(Object.assign({ task: cleanupBrief(finalLeft), outputSchema: CLEANUP_SCHEMA, acceptance: false }, cm ? { model: cm } : {}), "work"));
    const fn2 = (outOf(fcl).cleaned || []).filter(function (c) { return c.removed === true; }).length;
    log.push("final cleanup: removed " + fn2 + "/" + finalLeft.length + " leftover worktree(s)/branch(es)");
  } catch (e) {
    log.push("final cleanup failed (" + String(e).slice(0, 120) + "); leftovers remain");
  }
}
// Campaign analytics (auto, best-effort, ALL modes): one mechanical child archives the runtime
// artifacts next to the journal and computes metrics.json + retro markdown (wall clock, failure
// classes, tokens). Evidence, never a gate: a failure is logged and the campaign result stands.
// BREAKER-TRANSPARENT (rework r1): runChild pins spec.model||model, so this "modeless" launch
// still lands ON the campaign primary (args.model) - its trivial success would resetStrikes()
// that model in the FINAL checkpoint and its 429 ladder steps would recordStrike() into it,
// erasing exactly the evidence a resume needs ("strikes must survive resume exactly as the
// campaign left them"). The strike map is snapshotted before the child and restored verbatim
// after, whatever the outcome: a copy+script run vouches for no model's health. The cooling-down
// map is restored symmetrically: an archiver 429 must not cool the campaign primary either.
let analytics;
if (analyticsEnabled) {
  const strikesBeforeAnalytics = Object.assign({}, overloadStrikes);
  const coolingBeforeAnalytics = Object.assign({}, coolingDown);
  try {
    // Literal opts (NOT childOpts): the role-model fallback would pin the archiver to
    // workModel - a rotation pick here would spend a slot on a trivial copy+script child.
    const an = await runChild("campaign-analytics", Object.assign({ agent: "worker", context: "fresh", task: analyticsBrief(), outputSchema: ANALYTICS_SCHEMA, acceptance: false }));
    analytics = outOf(an);
    if (analytics && analytics.skipped === true) log.push("campaign analytics: skipped (" + String(analytics.reason || "no reason").slice(0, 120) + ")");
    else log.push("campaign analytics: " + String((analytics && analytics.summaryLine) || "").slice(0, 200) + " (mirrored to " + journalDir + "/" + String((analytics && analytics.runid) || "<runid>") + "/)");
  } catch (e) {
    log.push("campaign analytics failed (" + String(e).slice(0, 120) + "); metrics stay unarchived");
  }
  // Restore the pre-analytics strike + cooling maps (success resets and the archiver's
  // own 429 strikes/coolings both reverted).
  const strikesSnapshot = JSON.stringify(strikesBeforeAnalytics);
  if (JSON.stringify(overloadStrikes) !== strikesSnapshot || JSON.stringify(coolingDown) !== JSON.stringify(coolingBeforeAnalytics)) {
    Object.keys(overloadStrikes).forEach(function (k) { delete overloadStrikes[k]; });
    Object.assign(overloadStrikes, strikesBeforeAnalytics);
    Object.keys(coolingDown).forEach(function (k) { delete coolingDown[k]; });
    Object.assign(coolingDown, coolingBeforeAnalytics);
    await cpWrite({ overloadStrikes: Object.assign({}, overloadStrikes), coolingDown: Object.assign({}, coolingDown) }); // persist the restored evidence (the final checkpoint below would carry it too)
  }
}
const mergedCount = taskResults.filter(function (r) { return r.verdict === "merged" || r.verdict === "merged-after-arbitration"; }).length;
// Verdict-class counters, NOT a strict partition: "drop-failed" lands in both
// dropped and failed; "unknown"/"no-head-reported" land in neither.
const droppedCount = taskResults.filter(function (r) { return r.verdict === "dropped" || r.verdict === "drop-failed"; }).length;
const failedCount = taskResults.filter(function (r) { return ["failed", "arbiter-failed", "merge-failed", "drop-failed"].indexOf(r.verdict) !== -1; }).length;
let STATUS;
if (stopReason === "approval-required" || stopReason === "sdd-setup-failed") STATUS = "blocked";
else if (/^bd-epic-stalled/.test(stopReason)) STATUS = "blocked";
else if (/budget exhausted/.test(stopReason)) STATUS = taskResults.length ? "partial" : "failed";
else if (mergedCount > 0 && taskResults.length > mergedCount) STATUS = "partial";
else if (mergedCount > 0) STATUS = "completed";
else if (taskResults.length === 0) STATUS = /curator failed|sdd items likely remain/.test(stopReason) ? "failed" : "completed"; // nothing to do is a legitimate completion; a curator breakdown is not
else STATUS = "failed";
log.push("campaign end: " + mergedCount + "/" + taskResults.length + " tasks merged over " + sprint + " sprint(s); " + stopReason);
await cpWrite({
  phase: STATUS === "completed" ? "completed" : (STATUS === "blocked" ? "waiting" : "interrupted"),
  status: STATUS,
  result: { planned: plannedTotal, merged: mergedCount, dropped: droppedCount, failed: failedCount },
  used: usedCount,
  repairUsed: repairUsedCount,
  overloadStrikes: Object.assign({}, overloadStrikes),
  coolingDown: Object.assign({}, coolingDown)
});
if (stateOk) {
  Promise.resolve(state.set("nextReadyAction", { title: "agile campaign " + STATUS + ": " + stopReason, kind: STATUS === "completed" ? "done" : "attention" })).catch(function () {});
}

return {
  status: STATUS,
  done: mergedCount > 0, // legacy flag - use `status`/`counts` as evidence
  stopReason: stopReason,
  counts: { planned: plannedTotal, merged: mergedCount, dropped: droppedCount, failed: failedCount },
  generation: GENERATION,
  used: usedCount,
  repairUsed: repairUsedCount,
  sprints: sprint,
  sdd: { active: sddActive, tasksFile: sddTasksFile, itemsTotal: sddItemsTotal || undefined },
  retries: retriesTotal,
  tasks: taskResults,
  analytics: analytics,
  log: log
};

// WRITE-PROBE-1
