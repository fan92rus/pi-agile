/**
 * pi-agile — Pi Extension
 *
 * Autonomous Agile/Kanban engine for pi coding agent.
 *
 * Architecture: agent decides, extension runs.
 * - Extension provides tools: discovery, delegation, merge, retrospective
 * - Agent reads tool output, makes ALL decisions (task creation, verdicts, stop criteria)
 * - Constraints are text injected into system prompt, not programmatic checks
 * - Stop criteria checked by agent, not automated function
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExecResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { KnowledgeBase } from "./parallel/knowledge.ts";
import { SprintStore, type SprintState, type SprintTask, type SprintVelocity } from "./parallel/sprint.ts";
import {
  shouldSendContinuation,
  buildContinuationMessage,
  loadSessionState as loadSessionStateFromDisk,
  saveSessionState as saveSessionStateToDisk,
} from "./parallel/continuation.ts";
import { runDiscovery, formatDiscoveryResult, initChecks, detectEcosystem, type EcosystemInfo } from "./parallel/discovery.ts";
import { parseSimpleYaml, parseYamlValue } from "./parallel/yaml.ts";
import { resolveDefaultBranch, branchExistsInList, branchCheckoutArgs } from "./parallel/git.ts";
import { parseBdShow } from "./parallel/bd.ts";
import { buildChainAgentTask, buildReviewerTask, buildWorkerTask, parseReviewVerdict, buildDiscoveryScoutTask, buildDetectiveTask } from "./parallel/review.ts";
import { RpcClient, type SpawnedWorker } from "./parallel/rpc.ts";
import {
  createObserverState,
  runSprintObserver,
  trackConstraintViolation,
  trackTaskTransition,
  DEFAULT_OBSERVER_CONFIG,
  type ObserverConfig,
  type SprintObserverState,
} from "./observer.ts";
import { filterSubcommands, formatConfig } from "./config-ui.ts";

// ---------------------------------------------------------------------------
// Constants & paths
// ---------------------------------------------------------------------------

const AGILE_DIR = ".agile";
const PROJECT_FILE = ".agile/project.yaml";
const CONSTRAINTS_FILE = ".agile/constraints.yaml";
const CONFIG_FILE = ".agile/config.json";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function ensureAgileDir(workDir: string): void {
  const dir = path.join(workDir, AGILE_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Fix #17: agile state files (sprint-*.json, session.json, knowledge.jsonl,
  // worker-*.txt) must never be committed by workers —
  // they run `git add -A` and would otherwise pollute feature branches/main
  // on projects that don't already ignore .agile/.
  try {
    const giPath = path.join(workDir, ".gitignore");
    const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf8") : "";
    const hasAgile = gi.split(/\r?\n/).some((l) => l.trim() === ".agile/" || l.trim() === ".agile");
    if (!hasAgile) {
      fs.writeFileSync(giPath, (gi ? (gi.endsWith("\n") ? gi : gi + "\n") : "") + ".agile/\n", "utf8");
    }
  } catch { /* non-fatal */ }
}

function loadProjectConfig(workDir: string): Record<string, unknown> | null {
  const filePath = path.join(workDir, PROJECT_FILE);
  if (!fs.existsSync(filePath)) {
    // Auto-create default project.yaml on first access
    const name = path.basename(workDir);
    const defaultYaml = `project:
  name: "${name}"
  goal: "Improve code quality and fix issues"

  scope:
    include:
      - "src/**"
    exclude:
      - "node_modules/**"
      - "dist/**"

  review_depth: deep
  max_workers: 5
`;
    if (!fs.existsSync(path.join(workDir, AGILE_DIR))) {
      fs.mkdirSync(path.join(workDir, AGILE_DIR), { recursive: true });
    }
    fs.writeFileSync(filePath, defaultYaml, "utf8");
  }
  const text = fs.readFileSync(filePath, "utf8");
  return parseSimpleYaml(text);
}

function loadConstraintsText(workDir: string): string {
  const filePath = path.join(workDir, CONSTRAINTS_FILE);
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

function loadAgileConfig(workDir: string): Record<string, unknown> {
  const filePath = path.join(workDir, CONFIG_FILE);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function saveAgileConfig(workDir: string, config: Record<string, unknown>): void {
  ensureAgileDir(workDir);
  fs.writeFileSync(path.join(workDir, CONFIG_FILE), JSON.stringify(config, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Agent model configuration
// ---------------------------------------------------------------------------

const DEFAULT_AGENT_MODELS: Record<string, string> = {
  worker: "opencode-go/deepseek-v4-flash",
  reviewer: "opencode-go/deepseek-v4-flash",
  scout: "opencode-go/deepseek-v4-flash",
  detective: "opencode-go/deepseek-v4-flash",
  researcher: "zai-glm/glm-5.2",
  planner: "zai-glm/glm-5.2",
};

/** Read agent_chains from .agile/config.json, default {"default": ["worker","reviewer"]}. */
function getChainConfig(workDir: string): Record<string, string[]> {
  const config = loadAgileConfig(workDir);
  return (config.agent_chains as Record<string, string[]>) ?? { "default": ["worker", "reviewer"] };
}

/** Read spawn_timeout from .agile/config.json, default 1800s (1800000ms).
 * This is the timeout for the RPC spawn REPLY (acceptance), not the subagent runtime.
 * Subagent runtime waits indefinitely — see pollWithProgress (maxWaitSeconds=0). */
function getSpawnTimeout(workDir: string): number {
  const config = loadAgileConfig(workDir);
  const raw = config.spawn_timeout;
  if (typeof raw === "number" && raw >= 30_000) return raw;
  return 1_800_000;
}

/** Read worker_stuck_timeout from .agile/config.json, default 30min (1800000ms).
 * If a subagent shows NO activity (no tool calls, no output writes) for this long,
 * pollWithProgress interrupts and force-stops it instead of waiting forever. */
function getStuckTimeout(workDir: string): number {
  // Env override (PI_AGILE_STUCK_TIMEOUT_MS) — lets tests drive the Level B
  // stuck-worker path without a 30-minute wait; users can tune it too.
  const envRaw = parseInt(process.env.PI_AGILE_STUCK_TIMEOUT_MS ?? "", 10);
  if (!Number.isNaN(envRaw) && envRaw > 0) return envRaw;
  const config = loadAgileConfig(workDir);
  const raw = config.worker_stuck_timeout;
  if (typeof raw === "number" && raw >= 60_000) return raw;
  return 1_800_000;
}

/** Resolve model for a given agent role from .agile/config.json or default. */
function getAgentModel(workDir: string, role: string): string {
  const config = loadAgileConfig(workDir);
  const models = (config.agent_models ?? {}) as Record<string, string>;
  return models[role] ?? DEFAULT_AGENT_MODELS[role] ?? DEFAULT_AGENT_MODELS.worker;
}

/** Simple YAML parser (key: value, nested via indent, arrays via "- item", folded scalars).
 *  Lives in parallel/yaml.ts — moved there so it is unit-testable (Fix #10). */

function extractScope(project: Record<string, unknown> | null): string[] {
  if (!project) return ["src/**"];
  const p = project.project as Record<string, unknown> | undefined;
  const scope = p?.scope as Record<string, unknown> | undefined;
  return toStringArray(scope?.include, ["src/**"]);
}

/** Coerce a YAML value that may be a string or an array into a string[]. */
function toStringArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string" && value.trim() !== "") return [value];
  return fallback;
}

function extractProjectMeta(project: Record<string, unknown> | null): {
  goal: string;
  maxWorkers: number;
  reviewDepth: string;
} {
  const p = project?.project as Record<string, unknown> | undefined;
  return {
    goal: (p?.goal as string) ?? "Improve code quality",
    maxWorkers: (p?.max_workers as number) ?? 5,
    reviewDepth: (p?.review_depth as string) ?? "deep",
  };
}

// ---------------------------------------------------------------------------
// Shell + Git helpers (via pi.exec)
// ---------------------------------------------------------------------------

async function execText(
  pi: ExtensionAPI,
  cmd: string,
  args: string[],
  workDir: string,
  timeoutMs = 60_000,
): Promise<string> {
  try {
    const result: ExecResult = await pi.exec(cmd, args, { cwd: workDir, timeout: timeoutMs });
    return (result.stdout ?? "") + (result.stderr ?? "");
  } catch (e: unknown) {
    return `[exec error] ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Remove a subagent output file before (re-)spawning, so pollWithProgress
 * cannot short-circuit on a stale file from a PREVIOUS delegation of the same
 * task (re-delegation after rework read the old verdict — silent staleness).
 */
function clearOutputFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch { /* best effort */ }
}

async function gitCreateBranch(pi: ExtensionAPI, workDir: string, branch: string): Promise<void> {
  // Fix #2: re-delegating a task whose feat/<bdId> branch already exists (a
  // rework round) must plain-checkout it — `checkout -b` fails with exit 128 and
  // pi.exec does not throw, so the old code silently kept working on the wrong
  // branch (main) and the worker committed past review.
  const branchResult = await pi.exec("git", ["branch", "--list"], { cwd: workDir, timeout: 5_000 });
  const branchList = (branchResult.stdout ?? "") + (branchResult.stderr ?? "");
  const exists = branchExistsInList(branchList, branch);
  const args = branchCheckoutArgs(exists, branch);
  const checkout = await pi.exec("git", args, { cwd: workDir, timeout: 10_000 });
  if (checkout.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${checkout.stderr}`);
  }
}

async function gitDiff(pi: ExtensionAPI, workDir: string, ref: string): Promise<string> {
  return execText(pi, "git", ["diff", ref], workDir, 30_000);
}

/** Diff against the DETECTED default branch (main|master) — Fix #3. */
async function gitDiffAgainstDefault(pi: ExtensionAPI, workDir: string, branch: string): Promise<string> {
  const branchResult = await pi.exec("git", ["branch", "--list"], { cwd: workDir, timeout: 5_000 });
  const defaultBranch = resolveDefaultBranch((branchResult.stdout ?? "") + (branchResult.stderr ?? ""));
  return gitDiff(pi, workDir, `${defaultBranch}...${branch}`);
}

async function gitMergeSquash(pi: ExtensionAPI, workDir: string, branch: string, commitMsg?: string): Promise<string> {
  // Detect default branch (main or master)
  const branchResult = await pi.exec("git", ["branch", "--list"], { cwd: workDir, timeout: 5_000 });
  const branchList = (branchResult.stdout ?? "") + (branchResult.stderr ?? "");
  const defaultBranch = branchList.includes("main") ? "main" : "master";

  const checkout = await pi.exec("git", ["checkout", defaultBranch], { cwd: workDir, timeout: 15_000 });
  if (checkout.code !== 0) return `git checkout ${defaultBranch} failed: ${checkout.stderr}`;
  const merge = await pi.exec("git", ["merge", "--squash", branch], { cwd: workDir, timeout: 30_000 });
  if (merge.code !== 0) return `git merge --squash ${branch} failed: ${merge.stderr}`;

  // Commit the squashed changes
  const msg = commitMsg ?? `feat: merge ${branch}`;
  const commit = await pi.exec("git", ["commit", "-m", msg], { cwd: workDir, timeout: 15_000 });
  if (commit.code !== 0) return `git commit after squash failed: ${commit.stderr}`;

  return "";
}

/**
 * Parse `bd show <id>` output — lives in parallel/bd.ts (unit-testable).
 */

/**
 * Poll for worker/reviewer completion with progress updates.
 * Checks output file existence + rpc.status() in parallel.
 * Sends progress via onUpdate every ~15s.
 */
async function pollWithProgress(
  pi: ExtensionAPI,
  workDir: string,
  rpc: RpcClient,
  runId: string,
  outputFile: string,
  role: string,
  onUpdate: (msg: { content: { type: string; text: string }[] }) => void,
  maxWaitSeconds = 0, // 0 = wait indefinitely (subagents run as long as needed)
): Promise<boolean> {
  // Poll interval — env-overridable (PI_AGILE_POLL_INTERVAL_MS). Tests set it
  // to a few ms so the fake-subagent PBT harness can exercise the real
  // delegate/merge paths without real workers; users can tune it too.
  const pollInterval = parseInt(process.env.PI_AGILE_POLL_INTERVAL_MS ?? "", 10) || 5000;
  let attempts = 0;
  // maxWaitSeconds <= 0 means unlimited — poll until terminal state
  const maxAttempts = maxWaitSeconds > 0 ? Math.ceil(maxWaitSeconds / (pollInterval / 1000)) : Number.MAX_SAFE_INTEGER;

  // Level B guard: if the subagent shows no activity (no tool calls / output
  // writes) for worker_stuck_timeout (default 30min), interrupt then force-stop
  // it instead of waiting forever. A healthy worker updates lastActivityAt on
  // every tool call; an idle one hangs the whole poll.
  const stuckTimeoutMs = getStuckTimeout(workDir);
  let lastActivityWarningShown = false;
  // Fix #14: if the RPC bridge is dead (rpc.status keeps failing) and the run
  // was never confirmed to exist, waiting forever is wrong. Abort after
  // ~150s of consecutive failures with no "running" sighting.
  let consecutiveStatusFailures = 0;
  let everSawRunning = false;
  const MAX_CONSECUTIVE_STATUS_FAILURES = 30;

  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, pollInterval));
    attempts++;

    // Check 1: output file exists (most reliable signal)
    if (fs.existsSync(outputFile)) {
      onUpdate?.({ content: [{ type: "text", text: `${role} completed (output file found)` }] });
      return true;
    }

    // Check 2: rpc.status()
    let status: { state?: string; lastActivityAt?: number } | null = null;
    try {
      status = (await rpc.status(runId, 3000)) as { state?: string; lastActivityAt?: number } | null;
      if (status?.state === "completed" || status?.state === "stopped" || status?.state === "failed") {
        onUpdate?.({ content: [{ type: "text", text: `${role} finished (state: ${status.state})` }] });
        // Give output file a moment to flush — check FIRST, sleep only while
        // the file is still missing (an existing file returns instantly; a
        // completed run without a file still gives up after ~12s).
        for (let w = 0; w < 12; w++) {
          if (fs.existsSync(outputFile)) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        return true;
      }
      if (status?.state === "running") everSawRunning = true;
      consecutiveStatusFailures = 0;
    } catch {
      // rpc.status failed — bridge may be dead. Count consecutive failures and
      // abort when the run was never confirmed to exist (Fix #14).
      consecutiveStatusFailures++;
      if (!everSawRunning && consecutiveStatusFailures >= MAX_CONSECUTIVE_STATUS_FAILURES) {
        onUpdate?.({ content: [{ type: "text", text: `⏱ ${role}: RPC bridge unreachable (${consecutiveStatusFailures} status failures, run never confirmed). Aborting wait.` }] });
        return false;
      }
    }

    // Check 3: Level B — stuck detection via lastActivityAt (only while running)
    if (status?.state === "running" && typeof status.lastActivityAt === "number") {
      const idleMs = Date.now() - status.lastActivityAt;
      if (idleMs > stuckTimeoutMs) {
        onUpdate?.({ content: [{ type: "text", text: `⏱ ${role} idle for ${Math.round(idleMs / 60000)}m (> ${Math.round(stuckTimeoutMs / 60000)}m) — interrupting stuck worker` }] });
        try { await rpc.interrupt(runId, 5000); } catch {}
        // Give it a moment to finish the current turn after interrupt — check
        // status FIRST, sleep only while the run is still not terminal (an
        // immediate stop returns instantly instead of wasting 5s).
        for (let w = 0; w < 6; w++) {
          const s2 = (await rpc.status(runId, 3000)) as { state?: string } | null;
          if (s2?.state === "stopped" || s2?.state === "failed" || s2?.state === "completed") break;
          if (fs.existsSync(outputFile)) break;
          await new Promise((r) => setTimeout(r, 5000));
        }
        try { await rpc.stop(runId, 5000); } catch {}
        onUpdate?.({ content: [{ type: "text", text: `⏱ ${role} force-stopped after ${Math.round(idleMs / 60000)}m of inactivity. Check task description / bd database.` }] });
        return false;
      }
      if (idleMs > stuckTimeoutMs / 2 && !lastActivityWarningShown) {
        lastActivityWarningShown = true;
        onUpdate?.({ content: [{ type: "text", text: `⏳ ${role} has been idle ${Math.round(idleMs / 60000)}m — will force-stop after ${Math.round(stuckTimeoutMs / 60000)}m of inactivity` }] });
      }
    }

    // Progress update every ~15s
    if (attempts % 3 === 0) {
      onUpdate?.({ content: [{ type: "text", text: `⏳ Waiting for ${role}... (${Math.round(attempts * pollInterval / 60000)}m elapsed)` }] });
    }
  }

  return false;
}

// Extension runtime state
// ---------------------------------------------------------------------------

interface AgileRuntime {
  agileMode: boolean;
  sprintLoopActive: boolean;
  remainingSprints: number | undefined; // undefined = continuous
  currentSprintId: number;
  rpc: RpcClient | null;
  observerState: SprintObserverState;
  observerConfig: ObserverConfig;
  knowledge: KnowledgeBase;
  store: SprintStore;
  /** Original user request from /agile run [count] [description...] — the agent judges continuation intent from it. */
  originalRequest: string;
  /** Sprint id for which the agent_end discovery followUp was already sent (prevents spam per sprint). */
  agentEndSentForSprint: number | null;
  /** Last workDir the agile tools operated on — agent_end falls back to it when ctx.cwd has no sprint (RC2). */
  lastWorkDir: string | null;
  /** true after /agile stop — the loop was explicitly halted; agent_end must stay silent. */
  loopStopped: boolean;
}

function createRuntime(events: unknown): AgileRuntime {
  return {
    agileMode: false,
    sprintLoopActive: false,
    remainingSprints: undefined,
    currentSprintId: 0,
    rpc: null,
    observerState: createObserverState(),
    observerConfig: { ...DEFAULT_OBSERVER_CONFIG },
    originalRequest: "",
    agentEndSentForSprint: null,
    lastWorkDir: null,
    loopStopped: false,
    knowledge: new KnowledgeBase(),
    store: new SprintStore(),
  };
}

function getRuntime(ctx: ExtensionContext, store: Map<string, AgileRuntime>): AgileRuntime {
  const key = (ctx.sessionId ?? "default") as string;
  let rt = store.get(key);
  if (!rt) {
    rt = createRuntime(undefined);
    store.set(key, rt);
  }
  return rt;
}

/** (dead code removed — SprintStore.getCurrent(workDir) already auto-restores) */

// Module-level runtime store (per-session)
const runtimeStore = new Map<string, AgileRuntime>();

// ---------------------------------------------------------------------------
// Session state (RC3): persist sprint-loop intent per project so it survives
// pi restarts. All mutations of remainingSprints/originalRequest/
// sprintLoopActive must go through persistSessionState.
// ---------------------------------------------------------------------------

function persistSessionState(workDir: string, runtime: AgileRuntime): void {
  saveSessionStateToDisk(workDir, {
    remainingSprints: runtime.remainingSprints,
    originalRequest: runtime.originalRequest,
    sprintLoopActive: runtime.sprintLoopActive,
    loopStopped: runtime.loopStopped,
  });
}

/** Restore persisted loop state for this project into the runtime (no-op when absent). */
function loadSessionIntoRuntime(workDir: string, runtime: AgileRuntime): void {
  const state = loadSessionStateFromDisk(workDir);
  if (state.remainingSprints !== undefined) runtime.remainingSprints = state.remainingSprints;
  if (state.originalRequest !== undefined) runtime.originalRequest = state.originalRequest;
  if (state.sprintLoopActive !== undefined) runtime.sprintLoopActive = state.sprintLoopActive;
  if (state.loopStopped !== undefined) runtime.loopStopped = state.loopStopped;
}

/**
 * Send the continuation nudge (RC1/RC4): build the message, mark the sprint
 * as covered BEFORE sending (optimistic — a delivery failure must not cause a
 * retry storm on every agent_end), then fire the followUp.
 */
async function maybeSendContinuation(
  pi: ExtensionAPI,
  runtime: AgileRuntime,
  workDir: string,
  sprint: SprintState,
  prefix?: string,
  deliverAs: "followUp" | "steer" = "followUp",
): Promise<boolean> {
  // Fix #11: after /agile stop the loop is halted — no nudges at all.
  if (runtime.loopStopped) return false;

  // Open bd tasks not already in this sprint — they should go into the next sprint.
  let openTasks: string[] = [];
  try {
    const bdOut = await execText(pi, "bd", ["list"], workDir, 10_000);
    if (!bdOut.includes("[exec error]")) {
      const inSprint = new Set(sprint.tasks.map((t) => t.bd_id));
      // Lines like: ○ pi-autoresearch-22i ● P2 Test agent_end E2E
      for (const line of bdOut.split(/\r?\n/)) {
        const m = line.match(/^[○◐]\s+([\w.-]+)\s/);
        if (m && !inSprint.has(m[1])) openTasks.push(m[1]);
      }
    }
  } catch { /* bd may not be initialized — fall back to discovery-only hint */ }

  const project = loadProjectConfig(workDir);
  const meta = extractProjectMeta(project);
  const totalDone = sprint.tasks.filter((t) => t.status === "done").length;
  const totalBlocked = sprint.tasks.filter((t) => t.status === "blocked").length;

  const message = buildContinuationMessage({
    goal: meta.goal,
    originalRequest: runtime.originalRequest,
    remainingSprints: runtime.remainingSprints,
    totalTasks: sprint.tasks.length,
    totalDone,
    totalBlocked,
    openTasks,
  });

  // Design A: agent_end auto-close prefixes the nudge with the retrospective
  // summary so the agent sees the sprint was closed automatically.
  const full = prefix ? `${prefix}\n\n${message}` : message;

  runtime.agentEndSentForSprint = sprint.id; // optimistic dedupe (RC4)
  try {
    await pi.sendUserMessage(full, { deliverAs });
    return true;
  } catch {
    return false;
  }
}

/** Set agile mode flag — gates tool execution and system prompt injection. */
function setAgileMode(ctx: ExtensionContext, enabled: boolean, workDir?: string): void {
  getRuntime(ctx, runtimeStore).agileMode = enabled;
  // Persist to .agile/config.json
  if (workDir) {
    const config = loadAgileConfig(workDir);
    config.agile_mode = enabled;
    saveAgileConfig(workDir, config);
  }
  if (enabled) {
    // Fix: /agile off removes the gated agile tools from the active set, but
    // re-enabling never restored them — after an off→on cycle the tools stayed
    // missing for the rest of the session, silently breaking the autonomous
    // loop. Restore any registered tool that is no longer active.
    const all = (ctx.getAllTools?.() ?? []).map((t) => (typeof t === "string" ? t : t.name));
    const current = new Set(ctx.getActiveTools?.() ?? []);
    const missing = all.filter((n) => !current.has(n));
    if (missing.length > 0) ctx.setActiveTools?.([...current, ...missing]);
  } else {
    // Remove gated tools from active set when turning off
    const tools = ctx.getActiveTools?.() ?? [];
    const gated = ["agile_discover", "agile_start_sprint", "agile_delegate_task", "agile_prepare_review", "agile_record_verdict", "agile_merge_task", "agile_retrospective", "agile_knowledge", "agile_investigate"];
    ctx.setActiveTools?.(tools.filter((t) => !gated.includes(t)));
  }
}

/** Return an error response if agile mode is off (used by gated tools). */
function assertAgileActive(rt: AgileRuntime): { content: { type: "text"; text: string }[] } | undefined {
  if (rt.agileMode) return undefined;
  return { content: [{ type: "text" as const, text: "❌ Agile mode is OFF. Run /agile on first." }] };
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// System prompt — detailed workflow + bd CLI cheatsheet
// ---------------------------------------------------------------------------

/** Insert the agile role block before <project_context> so the role
 * statement outranks the generic "expert coding assistant" base prompt but
 * never overrides the user's own AGENTS.md instructions. Falls back to
 * prepending when the marker is absent (custom system prompts without
 * project context). */
function insertRoleBeforeContext(systemPrompt: string, roleBlock: string): string {
  const marker = "<project_context>";
  const idx = systemPrompt.indexOf(marker);
  if (idx === -1) return roleBlock + systemPrompt;
  return systemPrompt.slice(0, idx) + roleBlock + "\n\n" + systemPrompt.slice(idx);
}

// Behavioral contract (role + what the agent must NOT do) — injected at the
// TOP of the system prompt, before the user's own AGENTS.md instructions.
const SYSTEM_PROMPT_ROLE = `
## Your Role: Tech Lead

You are a TECH LEAD, not a coder. Your job is to PLAN, DELEGATE, and REVIEW — not to write code yourself.

**You DO:**
- Analyze the codebase (read, grep, understand)
- Create tasks in bd with clear descriptions and acceptance criteria
- Delegate ALL implementation to workers via agile_delegate_task
- Review diffs and review verdicts
- Decide: merge, rework, or block
- Record lessons and dead-ends in knowledge base
- Investigate specific bugs via agile_investigate (detective)

**You do NOT:**
- Write or edit code directly (use agile_delegate_task instead)
- Run tests directly (the worker does that)
- Fix bugs yourself (create a task and delegate)
- Implement features yourself (create a task and delegate)

If you find yourself wanting to write code — STOP. Create a bd task and delegate it.
Every line of code should be written by a worker subagent, reviewed by a reviewer subagent, and merged by you.
`;

// Reference material (bd CLI, workflow phases, chains, detective, models) —
// appended at the END of the system prompt, after the project context.
const SYSTEM_PROMPT_WORKFLOW = `
## bd CLI Task Tracker

bd is the task tracker. Tasks ("beads") have IDs like \`abc-9do\`.

### Creating tasks
\`\`\`bash
bd create "Title" -d "Description"                    # basic
bd create "Title" -d "Description" --acceptance "Criteria"  # with acceptance criteria
\`\`\`

### Viewing tasks
\`\`\`bash
bd ready              # tasks ready to work on (no blockers)
bd show <id>          # full task details
bd list --status open # all open tasks
\`\`\`

### Claiming and completing
\`\`\`bash
bd update <id> --claim   # mark in_progress (done automatically by agile_delegate_task)
bd close <id>            # close when done (done automatically by agile_merge_task)
\`\`\`

### Dependencies
\`\`\`bash
bd link <child-id> <parent-id>   # child blocks on parent (parent must finish first)
bd children <id>                 # show child tasks
\`\`\`

### Priority
\`\`\`bash
bd priority <id> high    # set priority: high, medium, low
\`\`\`

## Workflow

### Phase 0: Project Setup (MUST DO first)
1. **Run \`/agile init-checks\`** — generates .agile/checks/{todos,lint,coverage}.sh
   for your project's ecosystem (Go, Rust, .NET, Python, JS/TS, etc.)
2. **Edit the generated scripts** — they have placeholders; fix paths, commands,
   and file extensions to match your project
3. **Install missing tools** (eslint, ruff, dotnet, etc.) via package manager
4. **Run \`agile_discover\`** to validate scripts produce real output
5. **Iterate** — if \`agile_discover\` returns empty sections, fix the scripts
6. Only proceed to Phase 1 after \`agile_discover\` returns meaningful results

### Phase 1: Discovery
1. Call \`agile_discover\` tool — runs check scripts (lint/coverage/todos) + scout subagent codebase analysis
2. Read ALL output carefully — empty sections likely mean tools need setup (see Phase 0)
3. Identify findings that are actionable tasks:
   - Each TODO/FIXME is a potential task
   - Each lint error is a potential task
   - Group related issues into one task (don't create 10 tasks for 10 TODOs in one file)
   - A task should be completable in <100 LOC change

### Phase 2: Task Creation
1. For each finding, create a task:
   \`\`\`bash
   bd create "Fix hardcoded credentials in auth.js" -d "Replace hardcoded password check with proper validation" --acceptance "No hardcoded secrets, credentials validated via config/env"
   \`\`\`
2. Write CLEAR descriptions — workers only see title + description + acceptance criteria
3. Use dependencies when task B needs task A done first:
   \`\`\`bash
   bd link <task-b-id> <task-a-id>
   \`\`\`
4. Set priority on important tasks:
   \`\`\`bash
   bd priority <id> high
   \`\`\`

### Phase 3: Sprint Planning
1. Run \`bd ready\` to see available tasks
2. Select tasks for this sprint (respect max_tasks_per_sprint)
3. Call \`agile_start_sprint\` with the task IDs
4. The sprint is now active

## Agent Chains
Choose the right chain based on task complexity and context:

| Task type | Chain | Reason |
|-----------|-------|--------|
| **Simple bugfix** in familiar code | \`["worker", "reviewer"]\` (default) | Cheapest, fastest |
| **Refactor** in unfamiliar code | \`["scout", "worker", "reviewer"]\` | Scout maps existing patterns first |
| **New feature** with external API | \`["researcher", "scout", "worker", "reviewer"]\` | Research docs, scout existing code |
| **Complex multi-file change** | \`["scout", "worker", "reviewer"]\` (+ planner if large) | Decompose before implementing |
| **Security fix** | \`["scout", "worker", "reviewer"]\` | Scout finds all vulnerable paths |
| **Suspected bug needing validation** | \`["detective", "worker", "reviewer"]\` | Detective reproduces before worker fixes |

**Rules:**
- Chain agents run ONCE before the worker loop (not on rework rounds)
- Each chain agent sees outputs from previous chain agents
- Rework loop is always worker → reviewer (no scout/re-research)
- Set project-wide defaults in \`.agile/config.json\`:
  \`\`\`json
  {"agent_chains": {"refactor": ["scout", "worker", "reviewer"]}}
  \`\`\`
- Pass \`chain\` per-call: \`agile_delegate_task({bd_id: "...", chain: ["scout", "worker", "reviewer"]})\`

## Detective Agent

Use \`agile_investigate\` or chain \`["detective", "worker", "reviewer"]\` when:
1. Scout found a suspicious pattern — detective confirms it's real
2. Reviewer flagged a potential issue — detective reproduces it
3. You have a HYPOTHESIS about a possible bug — detective investigates

Do NOT use detective for broad exploration (use \`agile_discover\` / scout).
Do NOT use detective when the fix is obvious (skip to worker directly).

**Model selection:**
- Simple bugs (null check, typo): flash (default)
- Complex logic (race conditions, security, algorithms): pass \`model: "zai-glm/glm-5.2"\`

### Phase 4: Sprint Execution
For each task in the sprint — B-protocol (agent-driven delegation, docs/DELEGATION.md):
1. Call \`agile_delegate_task({ bd_id }) \` — the tool writes the worker task file and returns the EXACT \`subagent()\` call to spawn the worker. The tool does NOT spawn anything.
2. Call your \`subagent\` tool exactly as instructed (worker): it blocks until the worker finishes. Select the chain via the \`chain\` param if the task type needs scout/researcher first.
3. Call \`agile_prepare_review({ bd_id }) \` — writes the reviewer task file with the fresh diff and returns the EXACT \`subagent()\` call for the reviewer (with output/outputMode).
4. Call your \`subagent\` tool exactly as instructed (reviewer): its verdict lands in \`.agile/review-<bdId>-r<N>.txt\`.
5. Call \`agile_record_verdict({ bd_id, round }) \` — parses the verdict and applies bookkeeping. Read the returned verdict + next step:
   - **approved** → call \`agile_merge_task\` to merge to main
   - **rework** → call \`agile_delegate_task({ bd_id, round: N+1 })\` for the next round (action items are picked up automatically); max 3 rounds
   - **blocked** → task is fundamentally flawed, move to next task
   - **merge conflict** (from \`agile_merge_task\`) → rebase the feature branch on main (\`git checkout feat/<bdId> && git rebase main\`, fix conflicts, \`git add <files> && git rebase --continue\`) and call \`agile_merge_task\` again
6. Repeat until all tasks done/blocked

### Phase 5: Retrospective
1. Call \`agile_retrospective\` — returns velocity metrics + stop-check message
2. Formulate lessons learned (what worked, what didn't)
3. Record lessons:
   \`\`\`bash
   agile_knowledge(action="append", type="lesson", finding="Auth module uses custom error classes")
   \`\`\`
4. Read stop-check message
5. Run stop criteria check commands yourself (via bash)
6. Decide: stop (criteria met) or continue (start next sprint)

## Agent Models (configurable)

Each agent role uses a configurable model. Defaults:
- worker: opencode-go/deepseek-v4-flash
- reviewer: opencode-go/deepseek-v4-flash
- scout: opencode-go/deepseek-v4-flash
- detective: opencode-go/deepseek-v4-flash
- researcher: zai-glm/glm-5.2 (stronger for research tasks)
- planner: zai-glm/glm-5.2 (stronger for decomposition)

Override in .agile/config.json:
  { "agent_models": { "scout": "opencode-go/deepseek-v4-flash", "researcher": "zai-glm/glm-5.2" } }

All agents run with fresh context (no parent session inheritance).

## Key Rules

1. **ONE task per agile_delegate_task call** — process tasks one at a time
   (B-protocol: prepare → subagent(worker) → prepare_review → subagent(reviewer) → record_verdict → merge/rework; see Phase 4)
2. **Worker needs context** — write detailed descriptions in bd, workers only see title + description
3. **Use chain agents for complex tasks**: scout (explore codebase), researcher (look up APIs), planner (break down)
4. **Constraints are TEXT** — read them above, enforce by reasoning, reject violations
5. **Git workflow** — feature branch per task (\`feat/<bd-id>\`), conventional commits only
6. **Merge only after approved review** — never merge rework or blocked
7. **Record dead-ends** — if a task is blocked, record WHY via agile_knowledge so future sprints avoid it

You make ALL decisions. Extension only runs tools and persists data.`;

export default function piAgileExtension(pi: ExtensionAPI): void {

  // Initialize RPC client for subagent delegation
  const rpc = new RpcClient(pi.events as Parameters<typeof RpcClient>[0]);

  // -----------------------------------------------------------------------
  // System prompt injection
  // -----------------------------------------------------------------------

  pi.on("before_agent_start", async (event, ctx) => {
    const runtime = getRuntime(ctx, runtimeStore);
    // Auto-enable agile mode if persisted in .agile/config.json
    if (!runtime.agileMode) {
      const config = loadAgileConfig(ctx.cwd);
      if (config.agile_mode === true) {
        runtime.agileMode = true;
      }
    }
    if (!runtime.agileMode) return;

    // RC3: restore persisted sprint-loop state (remainingSprints, originalRequest)
    loadSessionIntoRuntime(ctx.cwd, runtime);

    const workDir = ctx.cwd;
    const project = loadProjectConfig(workDir);
    if (!project) return; // Not an agile project

    const meta = extractProjectMeta(project);
    const scope = extractScope(project);
    const constraints = loadConstraintsText(workDir);

    const knowledge = new KnowledgeBase();
    knowledge.load(workDir);
    const knowledgeText = knowledge.formatAll();

    // ROLE block goes BEFORE the user's AGENTS.md (so it beats the generic
    // "expert coding assistant" persona) while dynamic CONTEXT (goal, scope,
    // constraints, knowledge, workflow reference) stays appended at the end.
    const roleBlock = "\n\n# pi-agile: Autonomous Sprint Engine\n" + SYSTEM_PROMPT_ROLE;
    let extra = "";

    extra += `\n## Project Goal\n${meta.goal}\n`;
    extra += `\n## Scope\nInclude: ${scope.join(", ")}\n`;
    const rawScope = (project.project as Record<string, unknown>)?.scope as Record<string, unknown> | undefined;
    const exclude = toStringArray(rawScope?.exclude, []);
    if (exclude.length > 0) extra += `Exclude: ${exclude.join(", ")}\n`;

    if (constraints) extra += `\n## Constraints (MUST follow)\n${constraints}\n`;
    if (knowledgeText) extra += `\n## Knowledge from Previous Sprints\n${knowledgeText}\n`;

    extra += SYSTEM_PROMPT_WORKFLOW;

    event.systemPrompt = insertRoleBeforeContext(event.systemPrompt, roleBlock);
    event.systemPrompt = event.systemPrompt + extra;
  });

  // Fired when an agent loop ends — remind the agent to run discovery when sprint work is exhausted.
  pi.on("agent_end", async (event, ctx) => {
    const runtime = getRuntime(ctx, runtimeStore);
    if (!runtime.agileMode) return;

    // RC2: the agile tools accept an explicit cwd param, so the session cwd
    // may differ from the workDir the sprint actually lives in. Fall back to
    // the last known agile workDir before giving up.
    let workDir = ctx.cwd;
    let sprint = runtime.store.getCurrent(workDir);
    if (!sprint && runtime.lastWorkDir && runtime.lastWorkDir !== workDir) {
      sprint = runtime.store.getCurrent(runtime.lastWorkDir);
      if (sprint) workDir = runtime.lastWorkDir;
    }
    if (!sprint) return; // No active sprint
    runtime.lastWorkDir = workDir;

    // RC1: NO status==="done" gate. A completed sprint still deserves the
    // continuation nudge unless a followUp was already sent for it — the
    // anti-spam flag is the single source of truth (agile_retrospective marks
    // the sprint as covered when it sends its own followUp, and the flag
    // dedupes repeated agent_end firings). This keeps the loop alive in
    // continuous mode where the retrospective sends no bounded followUp.
    const pending = sprint.tasks.filter((t) => t.status !== "done" && t.status !== "blocked");
    if (!shouldSendContinuation({
      pendingCount: pending.length,
      taskCount: sprint.tasks.length,
      sentForSprint: runtime.agentEndSentForSprint,
      sprintId: sprint.id,
      remainingSprints: runtime.remainingSprints,
      loopStopped: runtime.loopStopped, // Fix #11: /agile stop silences agent_end
    })) return;

    // Design A: agent_end is the single place that closes a terminal sprint
    // and sends THE continuation message ('start the next sprint'). If the
    // agent never called agile_retrospective, close the sprint here — the
    // close flow itself sends the nudge (prefixed with the auto-completed
    // summary). A sprint already done (e.g. restart recovery with a lost
    // in-memory flag) falls back to the plain continuation nudge.
    if (sprint.status !== "done") {
      await closeSprint(pi, runtime, workDir, sprint, { autoCompleted: true });
    } else {
      await maybeSendContinuation(pi, runtime, workDir, sprint);
    }
  });

  // -----------------------------------------------------------------------
  // Tools
  // -----------------------------------------------------------------------

  // Tool: agile_discover — run discovery, return raw output
  pi.registerTool({
    name: "agile_run",
    label: "agile_run",
    description: "Bootstrap the autonomous sprint loop — behaves like `/agile run`, but callable even when agile mode is OFF (it enables agile mode itself, no human needed). Use for headless launches (`pi -p`) without any human interaction. REQUIRED: description of the work to complete — the agent keeps running sprints until these conditions are met. OPTIONAL: max_sprints — omit (or 0) for continuous mode.",
    parameters: Type.Object({
      description: Type.String({ description: "The work to complete autonomously. The agent works until these conditions are met (continuous mode) or the sprint budget runs out." }),
      max_sprints: Type.Optional(Type.Integer({ description: "Max sprint count. Omit or 0 for continuous mode — run until the description's conditions are met." })),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to session cwd)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx, runtimeStore);
      const workDir = (params.cwd as string) || ctx.cwd;
      const description = String(params.description ?? "").trim();
      const maxSprintsRaw = params.max_sprints as number | undefined;

      if (!description) {
        return { content: [{ type: "text" as const, text: "❌ agile_run: description is required — the agent needs to know what to accomplish. Call agile_run with a description of the work (optionally max_sprints for a bounded run)." }] };
      }

      // 1. Enable agile mode ourselves — the whole point: no human to type /agile on.
      setAgileMode(ctx, true, workDir);

      // 2. Session state: bounded (max_sprints) or continuous until conditions met.
      const maxSprints = maxSprintsRaw !== undefined && maxSprintsRaw > 0 ? maxSprintsRaw : undefined;
      runtime.originalRequest = description;
      runtime.remainingSprints = maxSprints;
      runtime.sprintLoopActive = true;
      runtime.loopStopped = false; // re-launch un-stops a persisted /agile stop
      persistSessionState(workDir, runtime);

      // 3. Goal-setup followUp (same as /agile run <desc>) — the agent must
      // formalize goal + constraints from the description before any sprint.
      const budgetLine = maxSprints
        ? `This session is budgeted for ${maxSprints} sprint${maxSprints > 1 ? "s" : ""} — stop when the budget is consumed.`
        : "Continuous mode — no sprint limit. Work until the description's conditions are met.";

      const setupMsg = `## Sprint Goal Setup Required (autonomous run)\n\nThe user requested:\n> ${description}\n\n${budgetLine}\n\n**Work autonomously — no human is available to answer questions.** You MUST fill the project configuration before starting any sprint:\n\n1. **Read** current \`.agile/project.yaml\` and \`.agile/constraints.yaml\`\n2. **Extract** the goal from the description above — formalize it into \`goal:\` in \`.agile/project.yaml\`\n3. **Extract** constraints (e.g. \"не вводи новых функций\", \"не используй X\") — add them to \`constraints:\` array\n4. **Leave empty** anything not specified — don't invent extra goals or constraints\n5. **Goal is MANDATORY** — you MUST write a goal before proceeding\n6. After filling, call \`agile_start_sprint\` with tasks from \`bd ready\` (or run \`agile_discover\` first if no tasks exist)\n\nDo NOT start sprint work until goal + constraints are written.`;
      await pi.sendUserMessage(setupMsg, { deliverAs: "steer" });

      return { content: [{ type: "text" as const, text: `✅ Agile mode ON. Autonomous sprint loop ${maxSprints ? `budgeted for ${maxSprints} sprint${maxSprints > 1 ? "s" : ""}` : "in continuous mode — run until the description's conditions are met"}. Fill goal + constraints in .agile/project.yaml, then start the sprint cycle.` }] };
    },
  });

  pi.registerTool({
    name: "agile_discover",
    label: "agile_discover",
    description: "Run codebase discovery: check scripts (lint/coverage/todos) + scout subagent analysis. Returns raw output for the agent to analyze and decide which findings become tasks.",
    parameters: Type.Object({
      goal: Type.Optional(Type.String({ description: "Discovery goal — what to look for. Overrides the project goal for this call only (project.yaml is not modified). Falls back to the project goal." })),
      scope: Type.Optional(Type.Array(Type.String(), { description: "Glob patterns to scan. Defaults to project scope." })),
      skip_scout: Type.Optional(Type.Boolean({ description: "Skip the scout subagent (only run check scripts). Default: false." })),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to session cwd)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx, runtimeStore);
      const gate = assertAgileActive(runtime);
      if (gate) return gate;
      const workDir = (params.cwd as string) || ctx.cwd;
      const project = loadProjectConfig(workDir);
      const scope = (params.scope as string[]) ?? extractScope(project);
      const skipScout = (params.skip_scout as boolean) ?? false;
      // Effective goal: per-call override wins, otherwise the project goal.
      const goal = (params.goal as string | undefined)?.trim() || extractProjectMeta(project).goal || "";

      // 1. Run check scripts (lint, coverage, todos)
      const result = await runDiscovery(workDir, scope);
      const eco = detectEcosystem(workDir);
      const text = formatDiscoveryResult(result);

      // Detect missing tools (Fix #6: async — execSync blocked the event loop)
      let missingBlock = "";
      if (eco) {
        const missing: { name: string; install: string }[] = [];
        for (const t of eco.tools) {
          const probe = await execText(pi, t.name.split(" ")[0], ["--version"], workDir, 3_000);
          if (probe.startsWith("[exec error]")) missing.push({ name: t.name, install: t.install });
        }
        if (missing.length > 0) {
          missingBlock = "## ⚙️ Tools Not Found\n" +
            "Run /agile init-checks to generate scripts, or install manually:\n" +
            missing.map(t => "- " + t.name + ": `" + t.install + "`").join("\n") + "\n\n";
        }
      }

      // 2. Run scout subagent for codebase analysis
      let scoutBlock = "";
      if (!skipScout) {
        try {
          const kb = new KnowledgeBase();
          kb.load(workDir);
          const constraintsText = loadConstraintsText(workDir);
          const patternsText = kb.formatPatterns();
          const scoutTask = buildDiscoveryScoutTask(workDir, goal, constraintsText, patternsText, scope);
          const scoutOutput = path.join(workDir, ".agile", "scout-output.txt");
          const spawnTimeout = getSpawnTimeout(workDir);

          let spawned: SpawnedWorker;
          try {
            clearOutputFile(scoutOutput);
            spawned = await rpc.spawn({
              agent: "worker",
              model: getAgentModel(workDir, "scout"),
              task: scoutTask,
              cwd: workDir,
              context: "fresh",
              output: scoutOutput,
              outputMode: "file-only",
            }, spawnTimeout);
          } catch (e: unknown) {
            scoutBlock = "\n\n## Scout Analysis\n⚠ Scout spawn failed: " + (e instanceof Error ? e.message : String(e)) + "\n";
          }

          if (!scoutBlock) {
            // Poll for completion
            const scoutDone = await pollWithProgress(
              pi, workDir, rpc, spawned.runId, scoutOutput, "scout",
              () => {}
            );
            if (scoutDone && fs.existsSync(scoutOutput)) {
              const scoutResult = fs.readFileSync(scoutOutput, "utf8").trim();
              if (scoutResult.length > 100) {
                scoutBlock = "\n\n## Scout Analysis (subagent findings)\n" + scoutResult.slice(0, 8000) + "\n";
              }
            } else {
              scoutBlock = "\n\n## Scout Analysis\n⚠ Scout did not complete in time. Re-run agile_discover or set skip_scout=true.\n";
            }
          }
        } catch (e: unknown) {
          scoutBlock = "\n\n## Scout Analysis\n⚠ Scout error: " + (e instanceof Error ? e.message : String(e)) + "\n";
        }
      }

      return {
        content: [{ type: "text" as const, text: `# Discovery Results\n\n## Discovery Goal\n${goal || "(not specified)"}\n\n${missingBlock}${text}${scoutBlock}` }],
        details: { scriptsFound: result.scriptsFound, metricCount: Object.keys(result.metrics).length, scoutRan: !skipScout && !scoutBlock.startsWith("\n\n## Scout Analysis\n⚠") },
      };
    },
  });

  // Tool: agile_investigate — standalone detective agent for targeted bug investigation
  pi.registerTool({
    name: "agile_investigate",
    label: "agile_investigate",
    description: "Spawn a detective subagent to investigate a specific concern and reproduce it if real. Returns CONFIRMED/NOT_REPRODUCED with reproduction steps. Use when you have a hypothesis about a potential bug.",
    parameters: Type.Object({
      concern: Type.String({ description: "The specific concern or hypothesis to investigate. Be specific: what bug, where, under what conditions." }),
      model: Type.Optional(Type.String({ description: "Override detective model. Use glm-5.2 for complex logic (race conditions, security). Defaults to config." })),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to session cwd)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx, runtimeStore);
      const gate = assertAgileActive(runtime);
      if (gate) return gate;
      const workDir = (params.cwd as string) || ctx.cwd;
      const concern = params.concern as string;
      const modelOverride = params.model as string | undefined;

      // Capture original branch BEFORE creating investigate branch
      let originalBranch = "";
      try {
        originalBranch = (await execText(pi, "git", ["rev-parse", "--abbrev-ref", "HEAD"], workDir, 5000)).trim();
      } catch { /* detached HEAD — will use '-' fallback */ }

      // Create investigate branch
      const branchName = "investigate/" + Date.now().toString(36);
      try {
        await execText(pi, "git", ["checkout", "-b", branchName], workDir, 10000);
      } catch {
        return {
          content: [{ type: "text" as const, text: "Failed to create investigate branch. Check for uncommitted changes (git stash)." }],
        };
      }

      // Capture HEAD before detective runs (to detect new commits)
      let headBefore = "";
      try {
        headBefore = (await execText(pi, "git", ["rev-parse", "HEAD"], workDir, 5000)).trim();
      } catch { /* ignore */ }

      // Build detective task
      const constraints = loadConstraintsText(workDir);
      const kb = new KnowledgeBase();
      kb.load(workDir);
      const patterns = kb.formatPatterns();
      const detectiveTask = buildDetectiveTask(workDir, concern, constraints, patterns);
      const detectiveOutput = path.join(workDir, ".agile", "detective-output.txt");
      const spawnTimeout = getSpawnTimeout(workDir);

      // Spawn detective subagent
      let spawned: SpawnedWorker;
      try {
        clearOutputFile(detectiveOutput);
        spawned = await rpc.spawn({
          agent: "worker",
          model: modelOverride ?? getAgentModel(workDir, "detective"),
          task: detectiveTask,
          cwd: workDir,
          context: "fresh",
          output: detectiveOutput,
          outputMode: "file-only",
        }, spawnTimeout);
      } catch (e: unknown) {
        // Switch back to original branch on failure
        await execText(pi, "git", ["checkout", originalBranch || "-"], workDir, 5000);
        return {
          content: [{ type: "text" as const, text: "Detective spawn failed: " + (e instanceof Error ? e.message : String(e)) }],
        };
      }

      // Poll for completion
      const done = await pollWithProgress(
        pi, workDir, rpc, spawned.runId, detectiveOutput, "detective",
        () => {}
      );

      let report = "";
      if (done && fs.existsSync(detectiveOutput)) {
        report = fs.readFileSync(detectiveOutput, "utf8").trim();
      }
      if (report.length < 50) {
        report = "Detective did not produce a report. The investigation may have timed out.";
      }

      // Check if detective actually committed anything (compare HEAD before/after)
      let commitHash = "";
      try {
        const headAfter = (await execText(pi, "git", ["rev-parse", "HEAD"], workDir, 5000)).trim();
        if (headAfter !== headBefore) {
          commitHash = (await execText(pi, "git", ["log", "--oneline", "-1"], workDir, 5000)).trim();
        }
      } catch { /* no commits */ }

      // Switch back to original branch
      try {
        await execText(pi, "git", ["checkout", originalBranch || "-"], workDir, 5000);
        // Fix (M7): verify the checkout actually happened — execText never
        // throws, so a dirty tree would silently leave the agent on the
        // investigate branch.
        const nowOn = (await execText(pi, "git", ["branch", "--show-current"], workDir, 5000)).trim();
        if (nowOn && nowOn !== (originalBranch || "")) {
          report = `⚠️ **Checkout back to ${originalBranch || "previous branch"} failed** (uncommitted changes in investigate branch?). You are still on \`${nowOn}\`. Run \`git checkout ${originalBranch || "-"}\` manually.\n\n` + report;
        }
      } catch { /* best effort */ }

      return {
        content: [{ type: "text" as const, text: "# Detective Investigation Report\n\n**Branch**: " + branchName + "\n" + (commitHash ? "**Commit**: " + commitHash + "\n" : "") + "\n" + report }],
        details: { branch: branchName, commit: commitHash },
      };
    },
  });

  // Tool: agile_start_sprint — initialize a new sprint
  pi.registerTool({
    name: "agile_start_sprint",
    label: "agile_start_sprint",
    description: "Initialize a new sprint. Call after creating tasks in bd. Returns sprint state.",
    parameters: Type.Object({
      task_ids: Type.Array(Type.String(), { description: "bd task IDs included in this sprint" }),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to session cwd)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workDir = (params.cwd as string) || ctx.cwd;
      const runtime = getRuntime(ctx, runtimeStore);
      {
        const gate = assertAgileActive(runtime);
        if (gate) return gate;
      }
      const project = loadProjectConfig(workDir);
      const meta = extractProjectMeta(project);
      runtime.lastWorkDir = workDir;

      // Read task details FIRST (Fix M11): creating the sprint with placeholder
      // titles "(task <bdId>)" (bd database missing) burned the sprint id and
      // left sprint-N.json with tasks:[] — the same failure mode as 97bf88d.
      const parsedTasks: { bdId: string; title: string; description?: string }[] = [];
      const unreadable: string[] = [];
      for (const bdId of params.task_ids as string[]) {
        const bdOutput = await execText(pi, "bd", ["show", bdId], workDir, 10_000);
        const parsed = parseBdShow(bdOutput);
        const title = parsed.title && parsed.title !== `(task ${bdId})` ? parsed.title : undefined;
        if (!title) {
          unreadable.push(bdId);
          continue;
        }
        parsedTasks.push({ bdId, title, description: parsed.description });
      }
      if (unreadable.length > 0) {
        return {
          content: [{ type: "text" as const, text: `❌ Sprint aborted: could not read task details for ${unreadable.join(", ")} — ` +
            `bd show returned no title (missing .beads database in ${workDir}?). ` +
            `No sprint was created. Fix the bd database location or task ids, then retry.` }],
        };
      }
      // Fix (agent_end stability): an empty sprint (task_ids: [] or all bd shows
      // failing) becomes a zombie — sprint-N.json with tasks: [] makes agent_end
      // silent forever (taskCount === 0 gate) and pollutes findLastSprintId.
      // Abort instead of creating it.
      if (parsedTasks.length === 0) {
        return {
          content: [{ type: "text" as const, text: `❌ Sprint aborted: no readable tasks (task_ids empty or bd show failed for all ids). ` +
            `No sprint was created. Create tasks in bd first, then retry with their ids.` }],
        };
      }

      const sprintId = runtime.store.findLastSprintId(workDir) + 1;      const sprint = runtime.store.create(workDir, sprintId, meta.goal);

      // Add tasks to sprint state (titles already verified above)
      for (const t of parsedTasks) {
        runtime.store.addTask(sprint, {
          bd_id: t.bdId,
          title: t.title,
          description: t.description,
          status: "backlog",
        });
      }
      // Persist tasks to disk — create() already saved an empty sprint,
      // so without this save sprint-N.json keeps tasks: [] and agent_end
      // (which loads the last sprint from disk) never fires.
      runtime.store.save(workDir, sprint);

      runtime.currentSprintId = sprintId;
      // New sprint — allow the agent_end discovery nudge to fire again
      runtime.agentEndSentForSprint = null;

      return {
        content: [{
          type: "text" as const,
          text: `# Sprint ${sprintId} Started\n\nGoal: ${meta.goal}\nTasks: ${(params.task_ids as string[]).length}\n\nNext: call agile_delegate_task for each task.`,
        }],
        details: { sprintId, taskCount: (params.task_ids as string[]).length },
      };
    },
  });

  // Tool: agile_delegate_task — B-protocol PREPARE (agent-driven delegation).
  // The tool does NOT spawn worker/reviewer subagents anymore: it prepares the
  // worker task file and instructs the AGENT to call its native subagent tool.
  // Verdict bookkeeping lives in agile_record_verdict (docs/DELEGATION.md).
  pi.registerTool({
    name: "agile_delegate_task",
    label: "agile_delegate_task",
    description: "B-protocol prepare for ONE task (bd_id): writes the worker task file (.agile/delegate-<bdId>-r<N>.md) and returns the exact subagent() call the agent must make to spawn the worker. The agent then calls agile_prepare_review (after the worker commits) and agile_record_verdict (after the reviewer finishes).",
    parameters: Type.Object({
      bd_id: Type.String({ description: "Task ID (e.g. agile-test-9do)" }),
      round: Type.Optional(Type.Number({ description: "Rework round (1-3, default 1). Round N>1 picks up action items from the previous review file automatically." })),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to session cwd)" })),
      title: Type.Optional(Type.String({ description: "Override task title (normally read from bd)." })),
      description: Type.Optional(Type.String({ description: "Override task description (normally read from bd)." })),
      chain: Type.Optional(Type.Array(Type.String(), { description: "Agent chain: e.g. ['scout','worker','reviewer'] or ['worker','reviewer'] (default). Chain agents before worker run via the extension bridge." })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const workDir = (params.cwd as string) || ctx.cwd;
      const runtime = getRuntime(ctx, runtimeStore);
      {
        const gate = assertAgileActive(runtime);
        if (gate) return gate;
      }
      runtime.lastWorkDir = workDir;
      const singleBdId = params.bd_id as string | undefined;

      if (!singleBdId) {
        return { content: [{ type: "text" as const, text: "❌ Provide bd_id (single task)." }] };
      }

      const bdId = params.bd_id as string;
      const MAX_REWORK_ROUNDS = 3;
      const round = typeof params.round === "number" && Number.isFinite(params.round) ? Math.max(1, Math.floor(params.round)) : 1;
      if (round > MAX_REWORK_ROUNDS) {
        return { content: [{ type: "text" as const, text: `❌ Rework rounds are capped at ${MAX_REWORK_ROUNDS} rounds (requested round ${round}). Task ${bdId} has already been reworked — decide manually: block it or leave it for later.` }] };
      }

      // Read task details from bd if not provided
      let title = params.title as string | undefined;
      let description = (params.description as string) ?? "";
      let acceptanceCriteria: string | undefined;

      if (!title) {
        const bdOutput = await execText(pi, "bd", ["show", bdId], workDir, 10_000);
        const parsed = parseBdShow(bdOutput);
        title = parsed.title && parsed.title !== `(task ${bdId})` ? parsed.title : undefined;
        description = parsed.description ?? description;
        acceptanceCriteria = parsed.acceptanceCriteria;
      }
      // Level A guard: refuse to prepare a worker with empty task details.
      if (!title) {
        return {
          content: [{ type: "text" as const, text: `❌ Delegate aborted: could not read task details for ${bdId} — ` +
            `bd show returned no title (missing .beads database in ${workDir}?). ` +
            `No worker was spawned. Fix the bd database location or task id, then retry.` }],
        };
      }
      const branch = `feat/${bdId}`;

      // 1. Create feature branch (worker commits land here)
      await gitCreateBranch(pi, workDir, branch);

      // 1b. Claim the bd task on round 1 (the prompt promises this is done
      //     automatically by agile_delegate_task). Best-effort: bd may be
      //     missing or the task already claimed.
      if (round === 1) {
        try { await execText(pi, "bd", ["update", bdId, "--claim"], workDir, 10_000); } catch { /* best effort */ }
      }

      // 2. Load context for worker
      runtime.knowledge.load(workDir);
      const constraints = loadConstraintsText(workDir);
      const deadEnds = runtime.knowledge.formatDeadEnds();
      const chains = getChainConfig(workDir);
      const taskChain = (params.chain as string[] | undefined) ?? chains.default ?? ["worker", "reviewer"];
      const patterns = runtime.knowledge.formatPatterns();

      // 2b. Run chain agents before worker (scout, researcher, planner, etc.)
      //     — still extension-driven via the bridge (analysis agents, no verdicts).
      const chainOutputs: { agent: string; output: string }[] = [];
      const preWorker = taskChain.slice(0, taskChain.indexOf("worker"));
        for (const agent of preWorker) {
        try { pi.notify(`[${bdId}] Chain: ${agent} starting...`, "info"); } catch {}
        const agentOutput = path.join(workDir, ".agile", `${agent}-${bdId}.txt`);
        const agentTaskText = buildChainAgentTask(agent, title, description, acceptanceCriteria, constraints, patterns, chainOutputs);
        try {
          clearOutputFile(agentOutput);
          const spawned = await rpc.spawn({
            agent, model: getAgentModel(workDir, agent),
            task: agentTaskText, cwd: workDir, context: "fresh",
            output: agentOutput, outputMode: "file-only",
          }, getSpawnTimeout(workDir));
          const done = await pollWithProgress(pi, workDir, rpc, spawned.runId, agentOutput, `${agent}-${bdId}`, onUpdate);
          if (!done) {
            chainOutputs.push({ agent, output: `[FAILED] ${agent} did not complete (stuck or unreachable)` });
            continue;
          }
        } catch (e: unknown) {
          chainOutputs.push({ agent, output: `[FAILED] ${e instanceof Error ? e.message : String(e)}` });
          continue;
        }
        let output = "";
        try { if (fs.existsSync(agentOutput)) output = fs.readFileSync(agentOutput, "utf8"); } catch {}
        chainOutputs.push({ agent, output: output || `(${agent} completed)` });
        try { pi.notify(`[${bdId}] Chain: ${agent} done`, "info"); } catch {}
      }

      // 3. Rework feedback (round > 1): action items from the previous review file.
      let feedbackText: string | undefined;
      if (round > 1) {
        const prevReviewPath = path.join(workDir, ".agile", `review-${bdId}-r${round - 1}.txt`);
        let prevText = "";
        try { if (fs.existsSync(prevReviewPath)) prevText = fs.readFileSync(prevReviewPath, "utf8"); } catch {}
        const prev = parseReviewVerdict(prevText);
        feedbackText = `Round ${round - 1} review found:\n`;
        if (prev.action_items.length > 0) {
          feedbackText += "Action items to fix:\n";
          prev.action_items.forEach((ai: string) => { feedbackText += `  - ${ai}\n`; });
        }
        feedbackText += "\nFix these issues, then re-run tests and commit again.";
      }

      const workerTaskText = buildWorkerTask(title, description, acceptanceCriteria, constraints, patterns, deadEnds, feedbackText, chainOutputs.length > 0 ? chainOutputs : undefined);

      // 4. Write the worker task file + clear the round's stale verdict file.
      const workerTaskFile = path.join(workDir, ".agile", `delegate-${bdId}-r${round}.md`);
      const verdictFile = path.join(workDir, ".agile", `review-${bdId}-r${round}.txt`);
      fs.mkdirSync(path.join(workDir, ".agile"), { recursive: true });
      fs.writeFileSync(workerTaskFile, workerTaskText, "utf8");
      clearOutputFile(verdictFile); // B stale-file guard: record must not read an old verdict

      const workerModel = getAgentModel(workDir, "worker");
      const workerTaskRef = `.agile/delegate-${bdId}-r${round}.md`;
      const text = `# Delegate prepared: ${bdId} (round ${round}${feedbackText ? ", rework" : ""})

Worker task file: ${workerTaskRef}

1. Call your subagent tool (it blocks until the worker finishes):
   subagent({
     agent: "worker",
     model: "${workerModel}",
     task: "Follow the instructions in the file ${workerTaskRef} exactly. Implement the change and commit it to the current branch (feat/${bdId}). Return a summary of the changes you made.",
     context: "fresh",
     cwd: "${workDir}"
   })
2. When the worker finishes, call agile_prepare_review({ bd_id: "${bdId}", round: ${round} }) to prepare the reviewer.`;

      return { content: [{ type: "text" as const, text }], details: { bdId, round, phase: "prepare" } };
    },
  });

  // Tool: agile_prepare_review — B-protocol: write the reviewer task file with
  // the FRESH diff main...feat/<bdId> and return the subagent() call the agent
  // makes to spawn the reviewer (its verdict goes to .agile/review-<bdId>-r<N>.txt).
  pi.registerTool({
    name: "agile_prepare_review",
    label: "agile_prepare_review",
    description: "B-protocol step 2: after the worker commits, prepare the reviewer — writes .agile/review-task-<bdId>-r<N>.md with the fresh diff and returns the exact subagent() call (reviewer spawns with output: .agile/review-<bdId>-r<N>.txt, outputMode: file-only). Then call agile_record_verdict.",
    parameters: Type.Object({
      bd_id: Type.String({ description: "bd task ID" }),
      round: Type.Optional(Type.Number({ description: "Rework round (default 1)" })),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to session cwd)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workDir = (params.cwd as string) || ctx.cwd;
      const runtime = getRuntime(ctx, runtimeStore);
      {
        const gate = assertAgileActive(runtime);
        if (gate) return gate;
      }
      runtime.lastWorkDir = workDir;
      const bdId = params.bd_id as string;
      const round = typeof params.round === "number" && Number.isFinite(params.round) ? Math.max(1, Math.floor(params.round)) : 1;
      const branch = `feat/${bdId}`;

      // Read task details from bd
      const bdOutput = await execText(pi, "bd", ["show", bdId], workDir, 10_000);
      const parsed = parseBdShow(bdOutput);
      const title = parsed.title && parsed.title !== `(task ${bdId})` ? parsed.title : bdId;
      const description = parsed.description ?? "";
      const acceptanceCriteria = parsed.acceptanceCriteria;

      // Fresh diff after this round's worker work
      const diff = await gitDiffAgainstDefault(pi, workDir, branch);
      if (!diff.trim()) {
        return {
          content: [{
            type: "text" as const,
            text: `⚠️ No diff on feat/${bdId} (round ${round}). The worker produced no changes — re-run the worker subagent or check that it committed to the branch.`,
          }],
        };
      }

      const project = loadProjectConfig(workDir);
      const meta = extractProjectMeta(project);
      const constraints = loadConstraintsText(workDir);
      runtime.knowledge.load(workDir);
      const patterns = runtime.knowledge.formatPatterns();
      const reviewerTaskText = buildReviewerTask(title, description, diff, constraints, patterns, meta.reviewDepth as "deep" | "standard", acceptanceCriteria);

      const reviewerTaskFile = path.join(workDir, ".agile", `review-task-${bdId}-r${round}.md`);
      const verdictFile = path.join(workDir, ".agile", `review-${bdId}-r${round}.txt`);
      fs.mkdirSync(path.join(workDir, ".agile"), { recursive: true });
      fs.writeFileSync(reviewerTaskFile, reviewerTaskText, "utf8");
      clearOutputFile(verdictFile); // stale-verdict guard (agent may re-prepare a round)

      const reviewerModel = getAgentModel(workDir, "reviewer");
      const reviewerTaskRef = `.agile/review-task-${bdId}-r${round}.md`;
      const verdictRef = `.agile/review-${bdId}-r${round}.txt`;
      const text = `# Review prepared: ${bdId} (round ${round})

Reviewer task file: ${reviewerTaskRef}
Verdict output file: ${verdictRef}

1. Call your subagent tool (it blocks until the reviewer finishes):
   subagent({
     agent: "reviewer",
     model: "${reviewerModel}",
     task: "Follow the instructions in the file ${reviewerTaskRef} exactly. Your final response MUST contain the verdict JSON block exactly as specified — it is saved to the output file.",
     context: "fresh",
     cwd: "${workDir}",
     output: "${workDir}/${verdictRef}",
     outputMode: "file-only"
   })
2. Then call agile_record_verdict({ bd_id: "${bdId}", round: ${round} }).`;

      return { content: [{ type: "text" as const, text }], details: { bdId, round, phase: "prepare_review" } };
    },
  });

  // Tool: agile_record_verdict — B-protocol step 3: read the reviewer verdict
  // file, parse it, and apply ALL bookkeeping deterministically. No subagent is
  // spawned here — the AGENT ran the reviewer via its own subagent tool.
  pi.registerTool({
    name: "agile_record_verdict",
    label: "agile_record_verdict",
    description: "B-protocol step 3: after the reviewer subagent finishes, read .agile/review-<bdId>-r<N>.txt, parse the verdict and apply the bookkeeping (status, review_rounds, lessons, dead-ends, observer). Returns the verdict + the next step (merge / rework round / blocked).",
    parameters: Type.Object({
      bd_id: Type.String({ description: "bd task ID" }),
      round: Type.Optional(Type.Number({ description: "Rework round (default 1)" })),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to session cwd)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workDir = (params.cwd as string) || ctx.cwd;
      const runtime = getRuntime(ctx, runtimeStore);
      {
        const gate = assertAgileActive(runtime);
        if (gate) return gate;
      }
      runtime.lastWorkDir = workDir;
      const bdId = params.bd_id as string;
      const round = typeof params.round === "number" && Number.isFinite(params.round) ? Math.max(1, Math.floor(params.round)) : 1;

      const verdictFile = path.join(workDir, ".agile", `review-${bdId}-r${round}.txt`);
      let verdictText = "";
      try {
        if (fs.existsSync(verdictFile)) verdictText = fs.readFileSync(verdictFile, "utf8");
      } catch { /* handled below */ }
      if (!verdictText.trim()) {
        const rel = verdictFile.replace(workDir + path.sep, "");
        return {
          content: [{
            type: "text" as const,
            text: `❌ No review verdict file (${rel}) for ${bdId} (round ${round}). ` +
              `The reviewer subagent did not produce output. Re-run the reviewer subagent with output: "${rel}", outputMode: "file-only", then call agile_record_verdict again. No state was changed.`,
          }],
        };
      }

      const verdict = parseReviewVerdict(verdictText);

      // Read task title for knowledge bookkeeping (approach field of dead_ends)
      let title = bdId;
      try {
        const bdOutput = await execText(pi, "bd", ["show", bdId], workDir, 10_000);
        const parsed = parseBdShow(bdOutput);
        title = parsed.title && parsed.title !== `(task ${bdId})` ? parsed.title : bdId;
      } catch { /* best-effort */ }

      // Bookkeeping (identical to the former inline delegate path, docs/DELEGATION.md)
      const sprint = runtime.store.getCurrent(workDir);
      if (sprint) {
        runtime.store.setReviewRounds(sprint, bdId, round);
        if (verdict.status === "approved") {
          // markInReview + markDone will be called by the merge tool
        } else if (verdict.status === "rework") {
          runtime.store.markRework(sprint, bdId);
          trackTaskTransition(runtime.observerState, bdId, "rework");
        } else {
          runtime.store.markBlocked(sprint, bdId);
          trackTaskTransition(runtime.observerState, bdId, "blocked");
        }

        // Track constraint violations
        if (verdict.dimensions?.constraints?.violations) {
          for (const v of verdict.dimensions.constraints.violations) {
            trackConstraintViolation(runtime.observerState, v);
          }
        }

        // Persist lessons and dead-ends
        if (verdict.lessons?.length) {
          for (const lesson of verdict.lessons) {
            runtime.knowledge.append({
              type: "lesson",
              task_id: bdId,
              sprint: sprint.id,
              ts: new Date().toISOString(),
              finding: lesson,
            });
          }
        }
        if (verdict.do_not_retry) {
          runtime.knowledge.append({
            type: "dead_end",
            task_id: bdId,
            sprint: sprint.id,
            ts: new Date().toISOString(),
            approach: title,
            do_not_retry: verdict.do_not_retry,
          });
        }
        runtime.knowledge.save(workDir);
        runtime.store.save(workDir, sprint);

        // Observer after the task transition — non-terminal steers only
        // (design A: agent_end is the single closer + terminal messenger).
        const transitionSteers = runSprintObserver(sprint, runtime.observerState, DEFAULT_OBSERVER_CONFIG, workDir);
        const terminalNow = sprint.tasks.every((t) => t.status === "done" || t.status === "blocked");
        if (!terminalNow) {
          for (const steer of transitionSteers) {
            try {
              await pi.sendUserMessage(steer.message, { deliverAs: "steer" });
            } catch { /* best effort */ }
          }
        }
      }

      // Format the verdict for the agent
      const dimensionLines: string[] = [];
      for (const [dim, data] of Object.entries(verdict.dimensions)) {
        if ("score" in (data as object)) {
          dimensionLines.push(`- ${dim}: ${(data as { score: number }).score}/5 — ${(data as { issues: string[] }).issues?.length ?? 0} issues`);
        } else if ("violations" in (data as object)) {
          const violations = (data as { violations: string[] }).violations ?? [];
          if (violations.length) dimensionLines.push(`- constraints: ${violations.length} violations`);
        }
      }

      const actionItems = verdict.action_items.length > 0
        ? `\n## Action Items\n${verdict.action_items.map((a, i) => `${i + 1}. ${a}`).join("\n")}`
        : "";

      let nextStep = "";
      if (verdict.status === "approved") {
        nextStep = `\n## Next\n✅ **APPROVED** — call agile_merge_task({ bd_id: "${bdId}" }) to merge to main.`;
      } else if (verdict.status === "blocked") {
        nextStep = `\n## Next\n⛔ **BLOCKED** — task ${bdId} marked blocked. Do not re-delegate it.`;
      } else if (round < 3) {
        nextStep = `\n## Next\n🔄 **REWORK** — call agile_delegate_task({ bd_id: "${bdId}", round: ${round + 1} }) to start the next round (action items above are picked up automatically).`;
      } else {
        nextStep = `\n## Next\n⛔ **REWORK after 3 rounds** — task ${bdId} left in rework status. Decide manually: block it (no re-delegation) or leave it for later.`;
      }

      const verdictText2 = `# Review Verdict: ${bdId}

**Status:** ${verdict.status.toUpperCase()}
**Rounds:** ${round}

## Dimensions
${dimensionLines.join("\n")}${actionItems}${nextStep}`;

      return {
        content: [{ type: "text" as const, text: verdictText2 }],
        details: { verdict: verdict.status, bdId, round },
      };
    },
  });
  // Tool: agile_merge_task — merge approved task branch to main
  pi.registerTool({
    name: "agile_merge_task",
    label: "agile_merge_task",
    description: "Merge an approved task's feature branch to main (squash merge) and close the bd task. Run main checks (lint + test).",
    parameters: Type.Object({
      bd_id: Type.String({ description: "bd task ID to merge" }),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to session cwd)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workDir = (params.cwd as string) || ctx.cwd;
      const runtime = getRuntime(ctx, runtimeStore);
      {
        const gate = assertAgileActive(runtime);
        if (gate) return gate;
      }
      runtime.lastWorkDir = workDir;
      const bdId = params.bd_id as string;
      const branch = `feat/${bdId}`;

      // Squash-merge the feature branch into the default branch (main|master).
      const mergeResult = await gitMergeSquash(pi, workDir, branch, `feat: merge ${bdId}`);
      if (mergeResult) {
        const isConflict = mergeResult.includes("CONFLICT");
        if (isConflict) {
          try { await pi.exec("git", ["merge", "--abort"], { cwd: workDir, timeout: 10_000 }); } catch {}
          const bl = await pi.exec("git", ["branch", "--list"], { cwd: workDir, timeout: 5_000 });
          const defaultBranch = resolveDefaultBranch((bl.stdout ?? "") + (bl.stderr ?? ""));
          return {
            content: [{ type: "text" as const, text: `🔀 Merge conflict in ${bdId}. The squash merge was aborted. To resolve:
1. \`git checkout feat/${bdId}\`
2. \`git rebase ${defaultBranch}\` — fix conflicts, \`git add <files> && git rebase --continue\`
3. Call \`agile_merge_task({ bd_id: "${bdId}" })\` again — the merge will now apply cleanly.` }],
          };
        }
        return {
          content: [{ type: "text" as const, text: `❌ Merge failed: ${mergeResult}` }],
        };
      }

      // Close the bd task (the prompt promises agile_merge_task does it).
      // Best-effort: bd may be missing or the task already closed.
      try { await execText(pi, "bd", ["close", bdId], workDir, 10_000); } catch { /* best effort */ }

      // Run main checks (test, optionally lint)
      let checksOutput = "";
      let checksFailed = false;

      // Failure markers: jest/mocha "FAIL", go "FAIL", eslint "error".
      const hasFailures = (text: string): boolean => /\bFAIL(?:ED)?\b|\berror(?:s)?\b/i.test(text);

      // Only run eslint if config exists
      const hasEslint = [".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.yaml", "eslint.config.js", "eslint.config.mjs"]
        .some((f) => fs.existsSync(path.join(workDir, f)));
      if (hasEslint) {
        const result = await execText(pi, "npx", ["eslint", "."], workDir, 60_000);
        if (result.trim()) checksOutput += `## Lint\n${result.slice(0, 1000)}\n\n`;
        if (hasFailures(result)) checksFailed = true;
      }

      // Run tests
      if (fs.existsSync(path.join(workDir, "package.json"))) {
        const result = await execText(pi, "npm", ["test"], workDir, 120_000);
        if (result.trim()) checksOutput += `## Tests\n${result.slice(0, 2000)}`;
        if (hasFailures(result)) checksFailed = true;
      } else if (fs.existsSync(path.join(workDir, "go.mod"))) {
        const result = await execText(pi, "go", ["test", "./..."], workDir, 120_000);
        if (result.trim()) checksOutput += `## Tests\n${result.slice(0, 2000)}`;
        if (hasFailures(result)) checksFailed = true;
      }

      // Update sprint state
      // Fix #1: pass workDir (same rationale as agile_delegate_task above).
      const sprint = runtime.store.getCurrent(workDir);
      let observerBlock = "";
      if (sprint) {
        runtime.store.markDone(sprint, bdId);
        trackTaskTransition(runtime.observerState, bdId, "done");

        const doneTask = sprint.tasks.find((t) => t.bd_id === bdId);
        runtime.knowledge.append({
          type: "task_done",
          task_id: bdId,
          sprint: sprint.id,
          ts: new Date().toISOString(),
          title: doneTask?.title ?? `(task ${bdId})`, // Fix: real title, not placeholder
        });
        runtime.knowledge.save(workDir);
        runtime.store.save(workDir, sprint);

        // Run observer after task completion
        const steers = runSprintObserver(sprint, runtime.observerState, DEFAULT_OBSERVER_CONFIG, workDir);
        if (steers.length > 0) {
          observerBlock = "\n\n## Observer\n" + steers.map(s => `[${s.severity}] ${s.message}`).join("\n");
          // Design A: agent_end is the single closer + messenger for terminal
          // sprints — deliver ONLY non-terminal steers (stagnation/constraint_spam/
          // velocity_drop) mid-turn as steer (the merge runs inside a tool call,
          // the agent continues thinking right after). Terminal steers
          // (all_blocked/all_tasks_exhausted) are replaced by the agent_end
          // auto-close message, and NO dedupe flag is set here anymore — the old
          // agentEndSentForSprint=sprint.id silenced the agent_end auto-close
          // after a terminal merge, killing the loop (design-A incompleteness).
          const terminalNow = sprint.tasks.every((t) => t.status === "done" || t.status === "blocked");
          if (!terminalNow) {
            for (const steer of steers) {
              try {
                await pi.sendUserMessage(steer.message, { deliverAs: "steer" });
              } catch { /* best effort */ }
            }
          }
        }
      }

      // Delete feature branch
      try {
        await pi.exec("git", ["branch", "-D", branch], { cwd: workDir, timeout: 5000 });
      } catch { /* best-effort */ }

      return {
        content: [{
          type: "text" as const,
          text: `✅ Task ${bdId} merged to main.${observerBlock}

## Main Checks Output
${checksOutput.trim() || "(no lint config or test runner found — verify manually)"}
${checksFailed ? "\n⚠️ **Checks reported failures above — verify before continuing. The merge happened; broken code is now on main.**" : ""}`,
        }],
      };
    },
  });

  /**
   * Design A: complete a sprint — shared by agile_retrospective (agent-called)
   * and agent_end (auto-close when the agent never called the retrospective).
   *
   * State: velocity, ONE sprint_summary in knowledge (alreadyCompleted → no-op
   * for budget/messages/knowledge — a second close must not append a duplicate
   * summary), completeSprint (status done), observer, bounded budget decrement.
   * Message: the single continuation message ('start the next sprint') — full
   * buildContinuationMessage in BOTH modes (bounded gets the mode line
   * 'N sprint(s) remaining.' + next steps), prefixed with the auto-completed
   * summary when opts.autoCompleted.
   */
  async function closeSprint(
    pi: ExtensionAPI,
    runtime: AgileRuntime,
    workDir: string,
    sprint: SprintState,
    opts?: { autoCompleted?: boolean; deliverAs?: "followUp" | "steer" },
  ): Promise<{ retroText: string; steers: { type: string; message: string; severity: string }[] }> {
    // Mid-turn tool calls (agile_retrospective) deliver steer so the agent
    // sees the message immediately; agent_end auto-close keeps followUp.
    const deliverAs = opts?.deliverAs ?? "followUp";
    // Compute velocity
    sprint.velocity = runtime.store.computeVelocity(sprint);

    // PBT find: closing twice on the same sprint (agent error / agent_end
    // auto-close followed by an explicit retrospective) must be a no-op for
    // budget, messages AND knowledge — the old code appended a second
    // sprint_summary and double-decremented remainingSprints.
    const alreadyCompleted = sprint.status === "done";
    if (!alreadyCompleted) {
      // Save sprint summary to knowledge
      runtime.knowledge.load(workDir);
      runtime.knowledge.append({
        type: "sprint_summary",
        sprint: sprint.id,
        ts: new Date().toISOString(),
        ...sprint.velocity,
      });
      runtime.knowledge.save(workDir);
    }

    // Complete sprint
    runtime.store.completeSprint(sprint, workDir);

    // Run observer on sprint completion
    const observerSteers = runSprintObserver(sprint, runtime.observerState, {
      reworkStuckThreshold: 3,
      constraintSpamThreshold: 3,
      velocityDropThreshold: 50,
      observerEnabled: true,
    }, workDir);

    // Build retrospective text
    const v = sprint.velocity;
    const retroText = buildRetrospectiveText(sprint, workDir, v, runtime.knowledge);

    // Design A: agent_end auto-close prefixes the nudge with the retrospective
    // summary so the agent knows the sprint was closed without an explicit
    // retrospective call.
    const autoPrefix = opts?.autoCompleted
      ? `Sprint ${sprint.id} auto-completed: ${v.done} done, ${v.rework} rework, ${v.blocked} blocked, avg review rounds ${Math.round((v.avg_review_rounds ?? 0) * 10) / 10}.`
      : undefined;

    // Decrement remaining sprints (if bounded) and send follow-up.
    // RC1: the retrospective is the natural end of a sprint cycle — in
    // continuous mode (no sprint count) the bounded followUp below does not
    // exist, so the discovery nudge must fire here too, otherwise the loop
    // silently stops after the first sprint.
    if (!alreadyCompleted) {
      if (runtime.remainingSprints !== undefined) {
        runtime.remainingSprints--;
        // Mark the sprint as covered — agent_end must not send a second nudge.
        runtime.agentEndSentForSprint = sprint.id;
        persistSessionState(workDir, runtime);
        if (runtime.remainingSprints <= 0) {
          runtime.sprintLoopActive = false;
          persistSessionState(workDir, runtime);
          try {
            await pi.sendUserMessage("All sprints completed. Stop criteria met — end the sprint loop with /agile stop.", { deliverAs });
          } catch { /* best effort */ }
        } else {
          // Bounded with sprints left: the FULL continuation message (mode line
          // 'N sprint(s) remaining.' + next steps), not the terse one-liner.
          await maybeSendContinuation(pi, runtime, workDir, sprint, autoPrefix, deliverAs);
        }
      } else {
        // Continuous mode: the same continuation nudge the agent_end hook would send.
        await maybeSendContinuation(pi, runtime, workDir, sprint, autoPrefix, deliverAs);
      }
    }

    // Append observer steers to output if any
    const steerText = observerSteers.length > 0
      ? `
## Observer
${observerSteers.map((s: { type: string; message: string; severity: string }) => `[${s.severity}] ${s.message}`).join("\n")}
`
      : "";

    // Send observer steers as follow-up messages so the agent acts on them
    // (dedupe: when we already sent the continuation/budget followUp above,
    // the observer's sprint_completed steer says the same thing — PBT found
    // two near-identical messages on one completion).
    const sentOwnFollowUp = !alreadyCompleted && (runtime.remainingSprints !== undefined || !runtime.loopStopped);
    for (const steer of observerSteers) {
      if (sentOwnFollowUp && (steer.type === "sprint_completed" || steer.type === "all_tasks_exhausted")) continue;
      try {
        await pi.sendUserMessage(steer.message, { deliverAs });
      } catch { /* best effort */ }
    }

    return { retroText: retroText + steerText, steers: observerSteers };
  }

  // Tool: agile_retrospective — compute velocity, build stop-check message
  pi.registerTool({
    name: "agile_retrospective",
    label: "agile_retrospective",
    description: "Complete current sprint: compute velocity, save sprint summary to knowledge, build stop-check message. Agent reads velocity and decides whether to stop or continue.",
    parameters: Type.Object({
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to session cwd)" })),
    }),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const workDir = (_params?.cwd as string) || ctx.cwd;
      const runtime = getRuntime(ctx, runtimeStore);
      {
        const gate = assertAgileActive(runtime);
        if (gate) return gate;
      }
      runtime.lastWorkDir = workDir;
      const sprint = runtime.store.getCurrent(workDir);

      if (!sprint) {
        return {
          content: [{ type: "text" as const, text: "❌ No active sprint found. Start a sprint with agile_start_sprint or ensure sprint-*.json exists in .agile/." }],
        };
      }

      const { retroText, steers } = await closeSprint(pi, runtime, workDir, sprint, { deliverAs: "steer" });

      return {
        content: [{ type: "text" as const, text: retroText }],
        details: { sprintId: sprint.id, velocity: sprint.velocity, observerSteers: steers },
      };
    },
  });

  // Tool: agile_knowledge — append/read knowledge entries
  pi.registerTool({
    name: "agile_knowledge",
    label: "agile_knowledge",
    description: "Append a knowledge entry (lesson, dead_end, pattern) or read all entries. Used for cross-sprint memory.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("append"), Type.Literal("read")], { description: "append or read" }),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to session cwd)" })),
      type: Type.Optional(Type.Union([
        Type.Literal("lesson"), Type.Literal("dead_end"),
        Type.Literal("pattern"), Type.Literal("task_done"),
      ])),
      finding: Type.Optional(Type.String({ description: "Text content for append" })),
      do_not_retry: Type.Optional(Type.String({ description: "For dead_end: what not to retry" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workDir = (params.cwd as string) || ctx.cwd;
      const runtime = getRuntime(ctx, runtimeStore);
      {
        const gate = assertAgileActive(runtime);
        if (gate) return gate;
      }
      const action = params.action as string;

      if (action === "read") {
        runtime.knowledge.load(workDir);
        return {
          content: [{ type: "text" as const, text: runtime.knowledge.formatAll() || "(no knowledge recorded yet)" }],
        };
      }

      // append
      const type = (params.type as string) ?? "lesson";
      const finding = (params.finding as string) ?? "";
      const entry = {
        type,
        ts: new Date().toISOString(),
        ...(finding ? { finding } : {}),
        ...(params.do_not_retry ? { do_not_retry: params.do_not_retry } : {}),
      };

      runtime.knowledge.load(workDir);
      runtime.knowledge.append(entry);
      runtime.knowledge.save(workDir);

      return {
        content: [{ type: "text" as const, text: `✅ ${type} recorded.` }],
      };
    },
  });

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  pi.registerCommand("agile", {
    description: "Start, stop, configure, or check pi-agile sprint",
    getArgumentCompletions: (argumentPrefix: string) => {
      return filterSubcommands(argumentPrefix).map((s) => ({
        value: s.value,
        label: s.label,
        description: s.description,
      }));
    },
    handler: async (args, ctx) => {
      const command = (args ?? "").trim().toLowerCase();
      const workDir = ctx.cwd;

      if (!command || command === "help") {
        ctx.ui.notify(agileHelp(), "info");
        return;
      }

      if (command === "setup") {
        const runtime = getRuntime(ctx, runtimeStore);
        await ctx.ui.input("Press Enter to start the setup wizard...", "");
        const lines: string[] = ["# pi-agile Setup Wizard"];

        // 1. Project name & goal
        lines.push("");
        const name = await ctx.ui.input("Project name (e.g., 'My App'):", "");
        if (!name) { ctx.ui.notify("Setup cancelled", "error"); return; }
        const goal = await ctx.ui.input("What should the agent achieve over multiple sprints?\n  (e.g., 'Fix all ESLint warnings', 'Refactor auth module'):", "");
        if (!goal) { ctx.ui.notify("Setup cancelled", "error"); return; }
        lines.push(`Project: ${name}`);
        lines.push(`Goal: ${goal}`);

        // 2. Scope
        const includeStr = await ctx.ui.input("Include globs (comma-separated, e.g. src/**, tests/**):", "src/**");
        const excludeStr = await ctx.ui.input("Exclude globs (comma-separated, e.g. node_modules/**, dist/**):", "node_modules/**, dist/**");
        const includes = (includeStr || "src/**").split(",").map(s => `      - "${s.trim()}"`).join("\n");
        const excludes = (excludeStr || "node_modules/**, dist/**").split(",").map(s => `      - "${s.trim()}"`).join("\n");
        lines.push(`Scope: include ${includeStr || "src/**"}, exclude ${excludeStr || "node_modules/**"}`);

        // 3. Constraints
        const constraints: string[] = [];
        ctx.ui.notify("Now add project constraints. Enter one per line. Empty line to finish.", "info");
        while (true) {
          const rule = await ctx.ui.input(`Constraint ${constraints.length + 1} (Enter to finish):`, "");
          if (!rule) break;
          constraints.push(rule);
        }
        if (constraints.length === 0) constraints.push("All new code must have tests");
        lines.push(`Constraints: ${constraints.length} rules`);

        // 4. Stop criteria
        const stopMode = await ctx.ui.select("Stop criteria:", [
          "continuous — no auto-stop, run until /agile stop",
          "budget — stop after N sprints",
          "goal-driven — stop when a metric target is reached",
        ]);
        const isContinuous = stopMode?.startsWith("continuous");
        const isBudget = stopMode?.startsWith("budget");
        const isGoal = stopMode?.startsWith("goal");
        let sprints: string | undefined;
        let metricName = "";
        let metricTarget = "";
        if (isBudget) {
          sprints = await ctx.ui.input("How many sprints?:", "3");
          if (!sprints) sprints = "3";
          lines.push(`Stop: after ${sprints} sprints`);
        } else if (isGoal) {
          metricName = await ctx.ui.input("Metric name (e.g., 'test_coverage'):", "");
          metricTarget = await ctx.ui.input("Target value:", "");
          lines.push(`Stop: ${metricName} >= ${metricTarget}`);
        } else {
          lines.push("Stop: continuous (manual /agile stop)");
        }

        // 5. Review depth
        const depth = await ctx.ui.select("Review depth:", [
          "deep — 6 dimensions (architecture, correctness, security, performance, tests, constraints)",
          "standard — 3 dimensions (correctness, tests, constraints)",
        ]);
        const reviewDepth = depth?.startsWith("deep") ? "deep" : "standard";
        lines.push(`Review depth: ${reviewDepth}`);

        // 6. Generate configs
        const agileDir = path.join(workDir, ".agile");
        fs.mkdirSync(agileDir, { recursive: true });

        const projectYaml = `project:
  name: "${name}"
  goal: >
    ${goal}

  scope:
    include:
${includes}
    exclude:
${excludes}
${isBudget ? `  stop_when:
    mode: any_of
    conditions:
      - metric: max_sprints
        target: ${sprints}
        area: "project"
        description: "After ${sprints} sprints"` : ""}
${isGoal ? `  stop_when:
    mode: any_of
    conditions:
      - metric: ${metricName}
        target: ${metricTarget}
        area: "project"
        description: "${metricName} >= ${metricTarget}"` : ""}
  review_depth: ${reviewDepth}
  max_workers: 5
`;
        fs.writeFileSync(path.join(agileDir, "project.yaml"), projectYaml, "utf8");

        const constraintsYaml = `rules:
${constraints.map((r, i) => `  - id: rule-${i + 1}
    rule: "${r}"`).join("\n")}

architectural_principles:
  - Follow existing code patterns and conventions

process:
  - Use conventional commits
  - Keep changes minimal per task

do_not_do:
  - Do not modify files outside project scope
  - Do not add new dependencies without constraint override
`;
        fs.writeFileSync(path.join(agileDir, "constraints.yaml"), constraintsYaml, "utf8");

        // 7. Init bd if needed
        ctx.ui.notify("Checking prerequisites...", "info");
        try {
          await pi.exec("bd", ["--version"], { cwd: workDir, timeout: 5000 });
        } catch {
          ctx.ui.notify("⚠ bd CLI not found. Install from https://github.com/fan92rus/bd", "error");
        }
        try {
          await pi.exec("git", ["rev-parse", "--git-dir"], { cwd: workDir, timeout: 5000 });
        } catch {
          ctx.ui.notify("⚠ Not a git repo. Run git init first.", "error");
        }

        ctx.ui.notify("Generating discovery scripts...", "info");
        const checksResult = initChecks(workDir);
        const eco = detectEcosystem(workDir);
        let checksMsg = `\nCreated ${checksResult.created.length} check script(s): ${checksResult.created.join(", ")}`;
        if (eco) checksMsg += ` (detected: ${eco.language})`;
        if (checksResult.warnings.length > 0) {
          checksMsg += `\n\n⚠ ${checksResult.warnings.join("\n")}`;
        }

        checksMsg += `\n\n## Agent: edit these scripts before using\n`;
        checksMsg += `Review each script in .agile/checks/ and fix paths/commands for your project:\n`;
        for (const script of checksResult.created) {
          const hints: Record<string, string> = {
            "lint.sh": "Set the correct linter command and flags",
            "coverage.sh": "Set the correct test runner and test path",
            "todos.sh": "Adjust file extensions to match project languages",
          };
          checksMsg += `  - .agile/checks/${script} — ${hints[script] || ""}\n`;
        }
        checksMsg += `\nThen run \`agile_discover\` to validate.`;

        ctx.ui.notify(lines.join("\n") + checksMsg + "\n\n\u2705 Setup complete! Configs created in " + agileDir + "/", "info");

        // Fix #16: the wizard created configs but left agile mode OFF — the
        // followUp then ordered the agent to call agile_start_sprint, which
        // answered "Agile mode is OFF. Run /agile on first."
        setAgileMode(ctx, true, workDir);
        // Fix (agent_end stability): setup re-arms the loop — clear a persisted
        // /agile stop so agent_end nudges again after re-setup.
        runtime.loopStopped = false;
        persistSessionState(workDir, runtime);

        // Trigger agent to edit scripts and start discovery
        const ecoLang = eco ? eco.language : "unknown";
        const setupAgentMsg = `/agile setup complete. Project configured in .agile/ (ecosystem: ${ecoLang}).

You MUST now:
1. READ the generated scripts in .agile/checks/ and FIX them for this project:
   - lint.sh: verify linter command, flags, config file, and target paths
   - coverage.sh: verify test runner points to the right project/solution file
   - todos.sh: verify file extensions match your languages
2. INSTALL missing tools (npm install, pip install, etc.)
3. RUN agile_discover — every section must produce real output
4. If a section is empty or errors, fix the script and re-run
5. Create tasks in bd from discovery results (bd create "title" -d "desc")
6. Call agile_start_sprint to begin the sprint

Common fixes:
- dotnet: dotnet test needs .sln path (dotnet test src/Project.sln)
- js/ts: eslint needs eslint.config.js, vitest needs vitest.config.ts
- python: ruff needs pyproject.toml, pytest needs to find tests

Do NOT create tasks until agile_discover works.`;
        await pi.sendUserMessage(setupAgentMsg, { deliverAs: "followUp" });
        return;
      }

      if (command === "init-checks") {
        const checksResult = initChecks(workDir);
        const eco = detectEcosystem(workDir);

        let msg = `Created ${checksResult.created.length} check script(s): ${checksResult.created.join(", ")}`;
        if (eco) msg += ` (detected: ${eco.language})`;

        if (checksResult.warnings.length > 0) {
          msg += `\n\n⚠ ${checksResult.warnings.join("\n")}`;
        }

        msg += `\n\n## Agent: edit these scripts before using\n`;
        msg += `Review each script in .agile/checks/ and fix paths/commands for your project:\n`;
        for (const script of checksResult.created) {
          const hints: Record<string, string> = {
            "lint.sh": "Set the correct linter command and flags for your project",
            "coverage.sh": "Set the correct test runner and test path for your project",
            "todos.sh": "Adjust file extensions to match your project languages",
          };
          const hint = hints[script] || "";
          msg += `  - \`.agile/checks/${script}\` — ${hint}\n`;
        }
        msg += `\nRun \`agile_discover\` after editing to validate.`;

        ctx.ui.notify(msg, "info");

        // Trigger agent to edit and validate the scripts
        const ecoLang = eco ? eco.language : "unknown";
        const ecoTools = eco ? eco.tools.map((t: any) => t.name).join(", ") : "none";
        const agentMsg = `/agile init-checks created ${checksResult.created.length} scripts in .agile/checks/ (ecosystem: ${ecoLang}, tools: ${ecoTools}).

You MUST now:
1. READ each script: ${checksResult.created.map((s: string) => "`.agile/checks/" + s + "`").join(", ")}
2. FIX commands and paths for THIS project — the scripts are templates, not final:
   - todos.sh: check the file extensions match your languages
   - lint.sh: verify the linter command works (correct flags, config file, target paths)
   - coverage.sh: verify the test command points to the right project/solution file
3. INSTALL missing tools if needed (npm install, pip install, dotnet, etc.)
4. RUN agile_discover to validate — every section should produce real output, not "(not configured)"
5. If a section returns empty or errors, fix the script and re-run agile_discover

Common fixes by ecosystem:
- dotnet: "dotnet test" needs the .sln or .csproj path, e.g. dotnet test src/Project.sln
- js/ts: npx eslint needs a config (eslint.config.js), npx vitest needs vitest.config.ts
- go: golangci-lint needs .golangci.yml, go test runs from module root
- python: ruff needs pyproject.toml config, pytest needs to find tests

Do NOT proceed to task creation until agile_discover returns meaningful results.`;
        await pi.sendUserMessage(agentMsg, { deliverAs: "followUp" });
        return;
      }

      if (command === "on") {
        const runtime = getRuntime(ctx, runtimeStore);
        setAgileMode(ctx, true, workDir);
        // Fix (agent_end stability): re-arming must clear a persisted /agile stop —
        // otherwise loopStopped stays true and agent_end never nudges again.
        runtime.loopStopped = false;
        persistSessionState(workDir, runtime);
        ctx.ui.notify("✅ Agile mode ON — tools and system prompt active", "info");
        return;
      }

      if (command === "off") {
        setAgileMode(ctx, false, workDir);
        ctx.ui.notify("Agile mode OFF — tools and system prompt inactive", "info");
        return;
      }

      if (command === "status") {
        const project = loadProjectConfig(workDir);
        if (!project) {
          ctx.ui.notify("No .agile/project.yaml found. Run /agile setup first.", "error");
          return;
        }
        const meta = extractProjectMeta(project);
        const runtime = getRuntime(ctx, runtimeStore);
        const lastSprintId = runtime.store.findLastSprintId(workDir);

        ctx.ui.notify([
          "# pi-agile Status",
          "",
          `Mode: ${runtime.agileMode ? "🟢 ON" : "🔴 OFF"}`,
          `Goal: ${meta.goal}`,
          `Review depth: ${meta.reviewDepth}`,
          `Max workers: ${meta.maxWorkers}`,
          `Last sprint: ${lastSprintId}`,
          `Sprint loop active: ${runtime.sprintLoopActive ? "yes" : "no"}${runtime.remainingSprints !== undefined && runtime.sprintLoopActive ? ` (${runtime.remainingSprints} sprint${runtime.remainingSprints > 1 ? "s" : ""} remaining)` : ""}`,
          `Loop state: ${runtime.loopStopped ? "🔇 stopped (/agile stop) — agent_end nudges disabled" : "🔊 running — agent_end may nudge"}`,
        ].join("\n"), "info");
        return;
      }

      if (command === "stop") {
        const runtime = getRuntime(ctx, runtimeStore);
        runtime.sprintLoopActive = false;
        runtime.remainingSprints = undefined;
        runtime.loopStopped = true; // Fix #11: explicit stop — agent_end must stay silent
        persistSessionState(workDir, runtime);
        ctx.ui.notify("Sprint loop stopped", "info");
        return;
      }

      if (command === "run" || command.startsWith("run ")) {
        const runtime = getRuntime(ctx, runtimeStore);
        if (!runtime.agileMode) {
          ctx.ui.notify("⚠ Agile mode is OFF. Run /agile on first.", "error");
          return;
        }
        const project = loadProjectConfig(workDir);
        if (!project) {
          ctx.ui.notify("⚠ No .agile/project.yaml found. Run /agile setup first.", "error");
          return;
        }

        // Parse: optional sprint count + optional description
        // /agile run 5 -> count=5, desc=""
        // /agile run 5 Improve module boundaries without new features -> count=5, desc="..."
        // /agile run Improve module boundaries -> count=undefined, desc="..."
        const parts2 = command.split(/\s+/);
        let maxSprints: number | undefined;
        let description = "";
        if (parts2.length >= 2) {
          const n = parseInt(parts2[1], 10);
          if (!isNaN(n) && n > 0) {
            maxSprints = n;
            if (parts2.length >= 3) {
              description = parts2.slice(2).join(" ");
            }
          } else {
            description = parts2.slice(1).join(" ");
          }
        }

        // If description provided → goal/constraints setup phase (always refill)
        if (description.trim()) {
          runtime.originalRequest = description.trim();
          // Fix #9: /agile run 5 <desc> must keep the sprint budget, otherwise
          // the loop silently continues with the stale value from a previous
          // /agile run (or continuous mode).
          if (maxSprints !== undefined) {
            runtime.remainingSprints = maxSprints;
          }
          runtime.loopStopped = false;
          // Don't start sprint loop yet — agent must fill goal/constraints first
          runtime.sprintLoopActive = false;
          persistSessionState(workDir, runtime);
          ctx.ui.notify(`📋 Setting sprint goal: "${description.slice(0, 80)}${description.length > 80 ? "…" : ""}"`, "info");

          const setupMsg = `## Sprint Goal Setup Required\n\nThe user specified:\n> ${description}\n\n**You MUST fill the project configuration before starting any sprint.**\n\n1. **Read** current \`.agile/project.yaml\` and \`.agile/constraints.yaml\`\n2. **Extract** the goal from the description above — formalize it into \`goal:\` in \`.agile/project.yaml\`\n3. **Extract** constraints (e.g. \"не вводи новых функций\", \"не используй X\") — add them to \`constraints:\` array\n4. **Leave empty** anything not specified — don't invent extra goals or constraints\n5. **Goal is MANDATORY** — you MUST write a goal before proceeding\n6. After filling, call \`agile_start_sprint\` with tasks from \`bd ready\` (or run \`agile_discover\` first if no tasks exist)\n\nDo NOT start sprint work until goal + constraints are written.`;
          await pi.sendUserMessage(setupMsg, { deliverAs: "followUp" });
          return;
        }

        // No description → normal sprint cycle
        // If no count from command, try config.json, then project.yaml budget
        if (maxSprints === undefined) {
          const config = loadAgileConfig(workDir);
          if (config.max_sprints && typeof config.max_sprints === "number") {
            maxSprints = config.max_sprints;
          }
        }
        if (maxSprints === undefined) {
          const stopWhen = (project as Record<string, unknown>).stop_when as Record<string, unknown> | undefined;
          if (stopWhen && (stopWhen.mode === "any_of" || stopWhen.mode === "all_of")) {
            const conditions = (stopWhen.conditions as Array<Record<string, unknown>>) ?? [];
            // Fix #10: unified metric name — TZ.md and buildStopCheckMessage use
            // "max_sprints"; the setup wizard used to emit "sprint_count" which
            // made the budget silently ignored.
            const sprintCond = conditions.find(c => (c as Record<string, unknown>).metric === "max_sprints");
            if (sprintCond) maxSprints = sprintCond.target as number;
          }
        }

        runtime.sprintLoopActive = true;
        runtime.remainingSprints = maxSprints;
        runtime.loopStopped = false; // starting a fresh loop un-stops it
        persistSessionState(workDir, runtime);

        const sprintsInfo = maxSprints
          ? `This session is budgeted for ${maxSprints} sprint${maxSprints > 1 ? "s" : ""}.`
          : "Continuous mode (no sprint limit).";

        ctx.ui.notify(`▶ Sprint loop started (${maxSprints ? maxSprints + " sprints" : "continuous"})`, "info");
        await pi.sendUserMessage(`/agile run — start the sprint loop.\n\n${sprintsInfo}\nAfter each retrospective, check the sprint count — if 0 left, stop.\n\nExecute ONE sprint cycle now:\n1. If no sprint exists, call agile_discover to find work\n2. Create tasks in bd from discovery results (bd create "title" -d "desc")\n3. Call agile_start_sprint with the task IDs\n4. Call agile_delegate_task for each task\n5. OPTIONAL: call agile_retrospective — agent_end auto-closes terminal sprints; call it only to close early or see the full retrospective text\n6. Read the sprint count in the retrospective output — if none left, stop; otherwise continue the cycle`, { deliverAs: "followUp" });
        return;
      }

      if (command === "config") {
        const config = loadAgileConfig(workDir);
        ctx.ui.notify(formatConfig(config), "info");
        return;
      }

      if (command === "model" || command.startsWith("model ")) {
        const parts = command.split(/\s+/);
        const config = loadAgileConfig(workDir);

        async function getAvailableModels(): Promise<Record<string, string[]>> {
          const mp = path.join(os.homedir(), ".pi", "agent", "models-store.json");
          if (!fs.existsSync(mp)) return {};
          try {
            const raw = JSON.parse(fs.readFileSync(mp, "utf8")) as Record<string, unknown>;
            const byProvider: Record<string, string[]> = {};
            for (const [provider, info] of Object.entries(raw)) {
              if (info && typeof info === "object" && Array.isArray((info as Record<string, unknown>).models)) {
                const arr = (info as Record<string, unknown>).models as Array<Record<string, unknown>>;
                byProvider[provider] = arr.map((m) => `${provider}/${m.id}`).sort();
              }
            }
            return byProvider;
          } catch { return {}; }
        }

        async function showModelStatus(availableCount: number, providerCount: number) {
          const models = (config.agent_models ?? {}) as Record<string, string>;
          const lines = ["# Agent Models", ""];
          lines.push(`  worker:   ${models.worker ?? "opencode-go/deepseek-v4-flash (default)"}`);
          lines.push(`  reviewer: ${models.reviewer ?? "opencode-go/deepseek-v4-flash (default)"}`);
          lines.push("");
          lines.push(`Available: ${availableCount} models across ${providerCount} providers`);
          ctx.ui.notify(lines.join("\n"), "info");
        }

        // ── Interactive: /agile model (no args) ──
        if (parts.length < 2) {
          const allModels = await getAvailableModels();
          const providerCount = Object.keys(allModels).length;
          const totalCount = Object.values(allModels).reduce((s, m) => s + m.length, 0);

          // Step 1: pick role
          const roleChoices = [
            "worker — implementation subagent",
            "reviewer — code review subagent",
            "scout — codebase exploration agent",
            "detective — bug investigation & reproduction agent",
            "researcher — API/best-practices research agent",
            "planner — task decomposition agent",
            "show current models",
          ];
          const roleChoice = await ctx.ui.select("Select agent role:", roleChoices);
          if (!roleChoice) return;
          if (roleChoice === "show current models") { await showModelStatus(totalCount, providerCount); return; }
          const roleMap: Record<string, string> = { worker: "worker", reviewer: "reviewer", scout: "scout", detective: "detective", researcher: "researcher", planner: "planner" };
          const role = Object.keys(roleMap).find(k => roleChoice.startsWith(k)) ?? "worker";
          const current = ((config.agent_models ?? {}) as Record<string, string>)[role];

          // Step 2: pick method
          const method = await ctx.ui.select(
            `Set model for ${role}${current ? ` (current: ${current})` : ""}:`,
            ["browse by provider", "type model ID"],
          );
          if (!method) return;

          let model: string | undefined;

          if (method.startsWith("type")) {
            model = await ctx.ui.input("Enter model ID (format: provider/model:thinking?)", current ?? "");
            if (model) model = model.trim();
          }

          if (!model) {
            // Browse by provider
            const provs = Object.keys(allModels).sort();
            const provPick = await ctx.ui.select("Select provider:", provs.slice(0, 50));
            if (!provPick) return;
            const providerModels = allModels[provPick];
            if (!providerModels?.length) { ctx.ui.notify("No models found", "error"); return; }
            const modelPick = await ctx.ui.select(`Model from ${provPick}:`, providerModels.slice(0, 80).map((m) => m === current ? `${m} ✓` : m).concat(["back"]));
            if (!modelPick || modelPick === "back") return;
            model = modelPick.replace(" ✓", "");
          }

          if (!model || !model.trim()) return;
          if (!config.agent_models) config.agent_models = {};
          (config.agent_models as Record<string, string>)[role] = model.trim();
          saveAgileConfig(workDir, config);
          ctx.ui.notify(`✅ ${role} model set to: ${model.trim()}`, "info");
          return;
        }

        // ── Quick non-interactive: /agile model show /agile model <role> <model> ──
        if (parts.length === 2 && parts[1] === "show") {
          const allModels = await getAvailableModels();
          const totalCount = Object.values(allModels).reduce((s, m) => s + m.length, 0);
          await showModelStatus(totalCount, Object.keys(allModels).length);
          return;
        }
        if (parts.length < 3) {
          const allModels = await getAvailableModels();
          await showModelStatus(Object.values(allModels).reduce((s, m) => s + m.length, 0), Object.keys(allModels).length);
          return;
        }
        if (!["worker", "reviewer", "scout", "researcher", "planner"].includes(parts[1])) {
          ctx.ui.notify(`Unknown role: ${parts[1]}. Use 'worker', 'reviewer', 'scout', 'researcher', or 'planner'.`, "error");
          return;
        }
        if (!config.agent_models) config.agent_models = {};
        (config.agent_models as Record<string, string>)[parts[1]] = parts[2];
        saveAgileConfig(workDir, config);
        ctx.ui.notify(`✅ ${parts[1]} model set to: ${parts[2]}`, "info");
        return;
      }

      if (command === "observer") {
        const config = loadAgileConfig(workDir);
        const current = config.observer_enabled !== false;
        config.observer_enabled = !current;
        saveAgileConfig(workDir, config);
        ctx.ui.notify(`Observer ${!current ? "enabled" : "disabled"}`, "info");
        return;
      }

      ctx.ui.notify(`Unknown command: ${command}. Run /agile help.`, "error");
    },
  });
}

// ---------------------------------------------------------------------------
// Stop-check message
// ---------------------------------------------------------------------------

function buildStopCheckMessage(workDir: string, sprintNum: number): string {
  const project = loadProjectConfig(workDir);
  const p = project?.project as Record<string, unknown> | undefined;
  const stopWhen = p?.stop_when as Record<string, unknown> | undefined;

  if (!stopWhen) {
    return `## Stop Criteria\nNo stop criteria defined (continuous mode). Start next sprint or run \`/agile stop\` to end.`;
  }

  const mode = (stopWhen.mode as string) ?? "any_of";
  const conditions = (stopWhen.conditions as Array<Record<string, unknown>>) ?? [];

  const conditionLines = conditions.map((c) => {
    const metric = c.metric as string;
    const target = c.target;
    const description = c.description as string | undefined;
    const command = c.command as string | undefined;

    if (metric === "max_sprints") {
      return `- max_sprints: ${sprintNum} / ${target} ${sprintNum >= (target as number) ? "✅" : "❌"}`;
    }
    return `- ${metric}: target ${target}${description ? ` (${description})` : ""}\n  Check command: \`${command ?? "(not specified)"}\``;
  }).join("\n");

  return `## Stop Criteria Check
Mode: ${mode} (any_of = any condition suffices, all_of = all required)
Current sprint: ${sprintNum}

Conditions:
${conditionLines}

Run the check commands yourself and decide if criteria are met.
If met → stop (do not start next sprint).
If not met → start next sprint.`;
}

/**
 * Build a structured retrospective with per-task breakdown, trends,
 * dead-end analysis, lessons, recommendations, and self-reflection.
 */
function buildRetrospectiveText(
  sprint: SprintState,
  workDir: string,
  v: SprintVelocity,
  knowledge: KnowledgeBase,
): string {

  // ── Per-task breakdown ──
  const taskLines = sprint.tasks.map((t: SprintTask) => {
    const icon = t.status === "done" ? "✅" : t.status === "blocked" ? "🚫" : t.status === "rework" ? "🔄" : "⏳";
    const verdict = t.final_verdict ? ` verdict: ${t.final_verdict}` : "";
    return `  ${icon} ${t.bd_id}: ${t.title} — ${t.status}${verdict} (${t.review_rounds} review rounds)`;
  }).join("\n");

  // ── Previous sprint comparison ──
  let trendLine = "";
  for (let i = sprint.id - 1; i >= 0; i--) {
    const agileDir = path.join(workDir, ".agile");
    const f = path.join(agileDir, `sprint-${i}.json`);
    if (fs.existsSync(f)) {
      try {
        const prev = JSON.parse(fs.readFileSync(f, "utf8")) as { velocity?: SprintVelocity };
        const pv = prev.velocity;
        if (pv) {
          const doneDelta = v.done - pv.done;
          const reworkDelta = v.rework - pv.rework;
          trendLine = `
## Trend vs Sprint ${i}
- Done: ${v.done} (${doneDelta >= 0 ? "+" : ""}${doneDelta} vs ${pv.done})
- Rework: ${v.rework} (${reworkDelta >= 0 ? "+" : ""}${reworkDelta} vs ${pv.rework})
- Avg review rounds: ${v.avg_review_rounds.toFixed(1)} vs ${pv.avg_review_rounds?.toFixed(1) ?? "?"}
`;
        }
      } catch {}
      break; // only first previous sprint
    }
  }

  // ── Rework & Blocked Analysis ──
  const problemTasks = sprint.tasks.filter((t: SprintTask) => t.status === "rework" || t.status === "blocked");
  let reworkAnalysis = "";
  if (problemTasks.length > 0) {
    reworkAnalysis = `
## Rework & Blocked Analysis
${problemTasks.slice(0, 3).map((t: SprintTask) => {
  const agileDir = path.join(workDir, ".agile");
  let items: string[] = [];
  try {
    const files = fs.readdirSync(agileDir).filter(f => f.startsWith(`review-${t.bd_id}`));
    items = files.flatMap(f => {
      try {
        const content = fs.readFileSync(path.join(agileDir, f), "utf8");
        const verdict = parseReviewVerdict(content);
        return verdict.action_items;
      } catch { return []; }
    });
  } catch {}
  const itemsText = items.length > 0 ? items.map(a => `    - ${a}`).join("\n") : "    (no action items extracted)";
  return `  ${t.bd_id}: ${t.title} [${t.status}]\n${itemsText}`;
}).join("\n")}
`;
  }

  // ── Lessons from knowledge ──
  const allLessons = knowledge.getByType("lesson").slice(-10);
  const knowledgeSummary = allLessons.length > 0
    ? `
## Lessons Learned This Sprint
${allLessons.map((l: { finding?: string }) => `  - ${l.finding ?? "(no text)"}`).join("\n")}
`
    : "";

  // ── Recommendations ──
  const recs: string[] = [];
  if (v.blocked > 0) {
    recs.push(`🔴 ${v.blocked} task(s) blocked — review do_not_retry in knowledge, consider splitting`);
  }
  if (v.rework > v.done && v.done > 0) {
    recs.push(`🔄 Rework (${v.rework}) exceeds done (${v.done}) — tasks may be too complex or need scout in chain`);
  }
  if (v.avg_review_rounds > 2) {
    recs.push(`👁️ High avg review rounds (${v.avg_review_rounds.toFixed(1)}) — improve task descriptions or check worker model quality`);
  }
  if (v.done === 0 && sprint.tasks.length > 0) {
    recs.push(`⚠️ Nothing completed — check task sizing, tool setup, and worker spawn timeout`);
  }
  const recsText = recs.length > 0 ? `
## Recommendations
${recs.join("\n")}
` : "";

  // ── Self-Reflection (context-dependent) ──
  const ref: string[] = ["## Self-Reflection (answer before proceeding)\n"];
  ref.push(`This sprint had ${v.attempted} tasks: ${v.done} done, ${v.rework} rework, ${v.blocked} blocked, ` +
    `${v.avg_review_rounds.toFixed(1)} avg review rounds. Go through each section and write your analysis.`);

  // 1. Process (always)
  ref.push(`\n### 1. Process\n` +
    `- Which tasks were straightforward and which dragged? For each dragged task: was the problem in planning, implementation, or review?\n` +
    `- Did the agent chain help or hurt? Would a different chain have changed any outcome?\n` +
    `- Were task descriptions detailed enough? Did workers go off-target or miss acceptance criteria?\n` +
    `- What specific tool call or parameter would you change if replaying this sprint?`);

  // 2. Blocked (conditional)
  if (v.blocked > 0) {
    const blockedList = sprint.tasks.filter((t: SprintTask) => t.status === "blocked").map((t: SprintTask) => `${t.bd_id} (${t.title})`).join(", ");
    ref.push(`\n### 2. Blocked Tasks — ${blockedList}\n` +
      `- Is each blockade a fundamental dead-end or a solvable problem that needs re-scoping?\n` +
      `- Could the block have been detected earlier (task creation, scout, planning) rather than after implementation?\n` +
      `- For each blocked task: split, change approach, or defer? Be specific about the next action.`);
  }

  // 3. Rework overhead (conditional)
  if (v.rework > v.done && v.done > 0) {
    ref.push(`\n### 3. Rework Overhead\n` +
      `Rework (${v.rework}) outpaces completed work (${v.done}). Which cause fits best?\n` +
      `- **Task too large**: keep LOC limit lower or split more aggressively\n` +
      `- **AC unclear**: acceptance criteria didn't capture edge cases — need more detail\n` +
      `- **Chain mismatch**: worker lacked context (no scout, no patterns) → reviewer caught what scout should have\n` +
      `- **Knowledge gap**: constraints/patterns not in .agile/knowledge.jsonl → worker didn't know the rules\n` +
      `Pick ONE and commit to a concrete change for next sprint.`);
  }

  // 4. Review bottleneck (conditional)
  if (v.avg_review_rounds > 2) {
    ref.push(`\n### 4. Review Bottleneck\n` +
      `Reviews averaged ${v.avg_review_rounds.toFixed(1)} rounds. Consider:\n` +
      `- **Worker model**: is the model capable enough? Check if rework items are about correctness vs style\n` +
      `- **Spec clarity**: did workers deviate because AC was ambiguous?\n` +
      `- **Premature review**: was the worker asked to review half-baked changes? (worker must commit only green tests)\n` +
      `- **Reviewer too strict**: optional style preferences vs genuine constraint violations?\n` +
      `Pick the dominant cause and decide one change.`);
  }

  // 5. Zero completion (conditional)
  if (v.done === 0 && sprint.tasks.length > 0) {
    ref.push(`\n### 5. Zero Completion\n` +
      `No tasks completed — red flag. Root causes to check:\n` +
      `- **Over-estimation**: tasks too large for one sprint? Next time 1-2 trivial tasks max\n` +
      `- **Setup issues**: missing tools, failing tests, worker couldn't run the project?\n` +
      `- **Wrong scope**: tasks touched out-of-scope files and got blocked\n` +
      `- **Infrastructure**: worker timeouts, spawn failures — increase spawn_timeout in config\n` +
      `Diagnose root cause and decide: re-scope, increase timeout, or fix setup before next sprint.`);
  }

  // 6. Trajectory (conditional on having previous sprint)
  if (trendLine) {
    ref.push(`\n### 6. Trajectory\n` +
      `Compare this sprint (${v.done} done, ${v.rework} rework) to the previous sprint.\n` +
      `- If improving: what changed? Is this sustainable or a lucky sprint?\n` +
      `- If declining: is the codebase harder to change (tech debt) or are tasks genuinely harder?\n` +
      `- Is velocity stable enough to plan, or is variance too high?`);
  }

  // 7. What worked (conditional on having done > 0)
  if (v.done > 0) {
    ref.push(`\n### 7. What Worked\n` +
      `- Identify 1-2 practices that contributed to successful tasks.\n` +
      `- Should these be recorded as patterns in .agile/knowledge.jsonl?\n` +
      `- Anything to start doing (new chain, better descriptions, pre-discovery)?`);
  }

  // 8. Decision
  ref.push(`\n### 8. Decision\n` +
    `After answering the questions above:\n` +
    `- **Continue**: start next sprint with the improvements you identified\n` +
    `- **Stop**: criteria met or direction needs re-evaluation\n` +
    `\n**Before deciding, record at least one lesson via:**\n` +
    `\`agile_knowledge({ action: "append", type: "lesson", finding: "..." })\``);

  const reflectionText = ref.join("\n");

  return `# Sprint ${sprint.id} Retrospective

## Velocity
- Attempted: ${v.attempted}
- Done: ${v.done}
- Rework: ${v.rework}
- Blocked: ${v.blocked}
- Avg review rounds: ${v.avg_review_rounds.toFixed(1)}

## Task Breakdown
${taskLines}
${trendLine}${reworkAnalysis}${knowledgeSummary}${recsText}
${reflectionText}

${buildStopCheckMessage(workDir, sprint.id)}`;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function agileHelp(): string {
  return `# pi-agile Commands

\`/agile on\`       — Enable agile mode (tools + system prompt active)
\`/agile off\`      — Disable agile mode
\`/agile setup\`    — Run setup wizard (creates .agile/project.yaml + constraints.yaml + check scripts)
\`/agile init-checks\` — Generate/update .agile/checks/ scripts for your project ecosystem
\`/agile run [count] [description]\` — Start sprint cycle with goal description (agent fills + starts)
\`/agile status\`   — Show current sprint status
\`/agile stop\`     — Graceful stop
\`/agile config\`   — Show configuration
\`/agile observer\` — Toggle observer on/off
\`/agile model\`    — Set agent models (worker, reviewer, scout, researcher, planner)

## Workflow
1. \`/agile setup\` — configure project
2. \`/agile on\` — enable agile mode
3. With goal: \`/agile run [count] "refactor module X without new features"\` — agent fills goal+constraints from description, then starts sprint
4. No goal: \`/agile run [count]\` — normal sprint cycle
5. Call \`agile_discover\` tool — runs check scripts + scout subagent analysis
6. Create tasks in bd: \`bd create "title" --description "desc"\`
7. Call \`agile_start_sprint\` — initialize sprint
8. For each task: call \`agile_delegate_task\` → get verdict
9. If approved: call \`agile_merge_task\`
10. Call \`agile_retrospective\` — get velocity + stop-check
11. Decide: stop or continue

Architecture: agent decides, extension runs.`;
}
