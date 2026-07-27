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
import { runDiscovery, formatDiscoveryResult } from "./parallel/discovery.ts";
import { buildChainAgentTask, buildReviewerTask, buildWorkerTask, parseReviewVerdict } from "./parallel/review.ts";
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
}

function loadProjectConfig(workDir: string): Record<string, unknown> | null {
  const filePath = path.join(workDir, PROJECT_FILE);
  if (!fs.existsSync(filePath)) return null;
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
  researcher: "zai-glm/glm-5.2",
  planner: "zai-glm/glm-5.2",
};

/** Read agent_chains from .agile/config.json, default {"default": ["worker","reviewer"]}. */
function getChainConfig(workDir: string): Record<string, string[]> {
  const config = loadAgileConfig(workDir);
  return (config.agent_chains as Record<string, string[]>) ?? { "default": ["worker", "reviewer"] };
}

/** Read spawn_timeout from .agile/config.json, default 600s (600000ms). */
function getSpawnTimeout(workDir: string): number {
  const config = loadAgileConfig(workDir);
  const raw = config.spawn_timeout;
  if (typeof raw === "number" && raw >= 30_000) return raw;
  return 600_000;
}

/** Write progress to .agile/batch-progress.json during parallel execution. */
function writeBatchProgress(workDir: string, data: { tasks: { bdId: string; round: number; stage: string; status: string }[] }): void {
  try {
    ensureAgileDir(workDir);
    fs.writeFileSync(path.join(workDir, ".agile", "batch-progress.json"), JSON.stringify(data, null, 2), "utf8");
  } catch { /* non-fatal */ }
}

/** Resolve model for a given agent role from .agile/config.json or default. */
function getAgentModel(workDir: string, role: string): string {
  const config = loadAgileConfig(workDir);
  const models = (config.agent_models ?? {}) as Record<string, string>;
  return models[role] ?? DEFAULT_AGENT_MODELS[role] ?? DEFAULT_AGENT_MODELS.worker;
}

/** Simple YAML parser (key: value, nested via indent, arrays via "- item", folded scalars). */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");
  const stack: { indent: number; obj: Record<string, unknown> }[] = [{ indent: -1, obj: result }];
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i].replace(/\r$/, "");
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) { i++; continue; }

    const indent = rawLine.length - rawLine.trimStart().length;
    const content = rawLine.trim();

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const current = stack[stack.length - 1].obj;

    if (content.startsWith("- ")) {
      const value = content.slice(2).trim();
      const topObj = stack[stack.length - 1].obj;
      const topKeys = Object.keys(topObj);

      if (stack.length > 1 && topKeys.length === 0) {
        // Empty placeholder {} from last "key:" → convert to array in parent
        const parent = stack[stack.length - 2].obj;
        const parentKeys = Object.keys(parent);
        for (let k = parentKeys.length - 1; k >= 0; k--) {
          if (parent[parentKeys[k]] === topObj) {
            parent[parentKeys[k]] = [parseYamlValue(value)];
            stack.pop();
            break;
          }
        }
      } else {
        // Find existing array on current object (second+ array item)
        for (let k = topKeys.length - 1; k >= 0; k--) {
          if (Array.isArray(topObj[topKeys[k]])) {
            (topObj[topKeys[k]] as unknown[]).push(parseYamlValue(value));
            break;
          }
        }
      }
      i++;
    } else if (content.includes(":")) {
      const colonIdx = content.indexOf(":");
      const key = content.slice(0, colonIdx).trim();
      const valueStr = content.slice(colonIdx + 1).trim();

      if (valueStr === "") {
        // Empty value — could be nested object or array, create empty object for now
        current[key] = {};
        stack.push({ indent, obj: current[key] as Record<string, unknown> });
        i++;
      } else if (valueStr === ">" || valueStr === "|") {
        // Folded (>) or literal (|) block scalar — read subsequent indented lines
        const blockLines: string[] = [];
        const blockIndent = indent + 2;
        i++;
        while (i < lines.length) {
          const nextLine = lines[i].replace(/\r$/, "");
          if (nextLine.trim() === "" && i + 1 < lines.length) { blockLines.push(""); i++; continue; }
          const nextIndent = nextLine.length - nextLine.trimStart().length;
          if (nextIndent > indent) {
            blockLines.push(nextLine.slice(Math.min(blockIndent, nextIndent)).trimEnd());
            i++;
          } else {
            break;
          }
        }
        current[key] = valueStr === ">" ? blockLines.join(" ").replace(/\s+$/g, "\n").trim() : blockLines.join("\n");
      } else {
        current[key] = parseYamlValue(valueStr);
        i++;
      }
    } else {
      i++;
    }
  }
  return result;
}

function parseYamlValue(s: string): unknown {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "~") return null;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  return t;
}

function extractScope(project: Record<string, unknown> | null): string[] {
  if (!project) return ["src/**"];
  const p = project.project as Record<string, unknown> | undefined;
  const scope = p?.scope as Record<string, unknown> | undefined;
  return (scope?.include as string[]) ?? ["src/**"];
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

async function gitCreateBranch(pi: ExtensionAPI, workDir: string, branch: string): Promise<void> {
  await pi.exec("git", ["checkout", "-b", branch], { cwd: workDir, timeout: 10_000 });
}

async function gitDiff(pi: ExtensionAPI, workDir: string, ref: string): Promise<string> {
  return execText(pi, "git", ["diff", ref], workDir, 30_000);
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

// ---------------------------------------------------------------------------
/** Parse `bd show <id>` output to extract title, description, acceptance criteria. */
/** Checkout default branch (main or master) */
async function gitCheckoutMain(pi: ExtensionAPI, workDir: string): Promise<string> {
  const branchResult = await pi.exec("git", ["branch", "--list"], { cwd: workDir, timeout: 5_000 });
  const branchList = (branchResult.stdout ?? "") + (branchResult.stderr ?? "");
  const defaultBranch = branchList.includes("main") ? "main" : "master";
  await pi.exec("git", ["checkout", defaultBranch], { cwd: workDir, timeout: 15_000 });
  return defaultBranch;
}

/**
 * Squash-merge a worktree's feature branch into the main repo's default branch.
 * Worktrees cannot checkout the default branch (it's already checked out in the
 * main repo), so we git-fetch from the worktree into the main repo and merge there.
 */
async function gitMergeFromWorktree(
  pi: ExtensionAPI,
  mainWorkDir: string,
  worktreeDir: string,
  featBranch: string,
  commitMsg?: string,
): Promise<string> {
  const branchResult = await pi.exec("git", ["branch", "--list"], { cwd: mainWorkDir, timeout: 5_000 });
  const branchList = (branchResult.stdout ?? "") + (branchResult.stderr ?? "");
  const defaultBranch = branchList.includes("main") ? "main" : "master";

  // Ensure main repo is on default branch
  const checkout = await pi.exec("git", ["checkout", defaultBranch], { cwd: mainWorkDir, timeout: 15_000 });
  if (checkout.code !== 0) return `checkout ${defaultBranch} in main repo failed: ${checkout.stderr}`;

  // Fetch from worktree
  const fetch = await pi.exec("git", ["fetch", worktreeDir, featBranch], { cwd: mainWorkDir, timeout: 30_000 });
  if (fetch.code !== 0) return `fetch from worktree ${worktreeDir} failed: ${fetch.stderr}`;

  // Squash merge FETCH_HEAD
  const merge = await pi.exec("git", ["merge", "--squash", "FETCH_HEAD"], { cwd: mainWorkDir, timeout: 30_000 });
  if (merge.code !== 0) return `squash merge failed: ${merge.stderr}`;

  const msg = commitMsg ?? `feat: merge ${featBranch}`;
  const commit = await pi.exec("git", ["commit", "-m", msg], { cwd: mainWorkDir, timeout: 15_000 });
  if (commit.code !== 0) return `commit after squash failed: ${commit.stderr}`;

  return "";
}

/** Remove stale git worktrees left from crashed/aborted batch runs. Returns count removed. */
function cleanupStaleWorktrees(workDir: string): number {
  let removed = 0;
  try {
    const listPath = path.join(workDir, ".git", "worktrees");
    if (!fs.existsSync(listPath)) return 0;
    const entries = fs.readdirSync(listPath);
    for (const entry of entries) {
      const wtGitDir = path.join(listPath, entry);
      const gitdirFile = path.join(wtGitDir, "gitdir");
      if (!fs.existsSync(gitdirFile)) continue;
      const wtPath = fs.readFileSync(gitdirFile, "utf8").trim().replace(/\/\s*$/, "");
      if (wtPath && wtPath !== workDir && fs.existsSync(wtPath)) {
        try {
          fs.rmSync(wtGitDir, { recursive: true, force: true });
          fs.rmSync(wtPath, { recursive: true, force: true });
          removed++;
        } catch {}
      }
    }
  } catch {}
  return removed;
}

/**
 * Full task lifecycle in a worktree directory:
 * create branch → spawn worker → poll → spawn reviewer → poll → parse verdict
 * Returns {bdId, status, verdict, diff, branch} or {bdId, status: "error", error}.
 */
async function delegateTaskInWorktree(
  pi: ExtensionAPI,
  rpc_: RpcClient,
  workDir: string,
  bdId: string,
  meta: { title: string; description: string; acceptanceCriteria?: string },
  constraints: string,
  deadEnds: string,
  patterns: string,
  reviewDepth: "deep" | "standard",
  spawnTimeout: number,
  onProgress?: (status: string) => void,
  chain: string[] = ["worker", "reviewer"],
): Promise<{
  bdId: string;
  verdict: ReturnType<typeof parseReviewVerdict>;
  diff: string;
  branch: string;
  workerSummary?: string;
  reviews?: { round: number; action_items: string[]; lessons: string[] }[];
  chainOutputs?: { agent: string; output: string }[];
  error?: string;
}> {
  const branch = `feat/${bdId}`;
  const MAX_REWORK_ROUNDS = 3;
  const reviews: { round: number; action_items: string[]; lessons: string[] }[] = [];
  const chainOutputs: { agent: string; output: string }[] = [];
  let currentDiff = "";
  let currentWorkerSummary = "";
  let overallVerdict: ReturnType<typeof parseReviewVerdict> = { status: "rework", dimensions: {}, action_items: [], lessons: [] };

  // 1. Create feature branch (assumes on main)
  await gitCreateBranch(pi, workDir, branch);

  // 2. Run chain agents before worker (scout, researcher, planner, etc.)
  const preWorker = chain.slice(0, chain.indexOf("worker"));
  for (const agent of preWorker) {
    try { pi.notify(`[${bdId}] Chain: ${agent} starting...`, "info"); } catch {}
    onProgress?.(`${bdId}: chain agent ${agent}...`);
    const agentOutput = path.join(workDir, ".agile", `${agent}-${bdId}.txt`);
    const agentTaskText = buildChainAgentTask(agent, meta.title, meta.description, meta.acceptanceCriteria, constraints, patterns, chainOutputs);
    let spawned: SpawnedWorker;
    try {
      spawned = await rpc_.spawn({
        agent: agent,
        model: getAgentModel(workDir, agent),
        task: agentTaskText,
        cwd: workDir,
        context: "fresh",
        output: agentOutput,
        outputMode: "file-only",
      }, Math.min(spawnTimeout, 120_000));
    } catch (e: unknown) {
      chainOutputs.push({ agent, output: `[FAILED] ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    const done = await pollWithProgress(pi, workDir, rpc_, spawned.runId, agentOutput, `${agent}-${bdId}`, (s: string) => onProgress?.(`${bdId}: ${s}`), 300);
    let output = "";
    try { if (fs.existsSync(agentOutput)) output = fs.readFileSync(agentOutput, "utf8"); } catch {}
    chainOutputs.push({ agent, output: output || `(${agent} completed)` });
    try { pi.notify(`[${bdId}] Chain: ${agent} done`, "info"); } catch {}
  }

  for (let round = 1; round <= MAX_REWORK_ROUNDS; round++) {
    try { pi.notify(`[${bdId}] Round ${round}/${MAX_REWORK_ROUNDS}`, "info"); } catch {}

    const workerOutput = path.join(workDir, ".agile", `worker-${bdId}-r${round}.txt`);
    const reviewerOutput = path.join(workDir, ".agile", `review-${bdId}-r${round}.txt`);

    // Build feedback from previous review (for round > 1)
    let feedbackText: string | undefined;
    if (round > 1 && reviews.length > 0) {
      const prev = reviews[reviews.length - 1];
      feedbackText = `Round ${round - 1} review found:\n`;
      if (prev.action_items.length > 0) {
        feedbackText += "Action items to fix:\n";
        prev.action_items.forEach((ai: string) => { feedbackText += `  - ${ai}\n`; });
      }
      feedbackText += "\nFix these issues, then re-run tests and commit again.";
      onProgress?.(`${bdId}: rework round ${round}...`);
    }

    // 3. Spawn worker (with chain context)
    const workerTaskText = buildWorkerTask(meta.title, meta.description, meta.acceptanceCriteria, constraints, patterns, deadEnds, feedbackText, chainOutputs.length > 0 ? chainOutputs : undefined);
    onProgress?.(`${bdId} (r${round}): spawning worker...`);
    try { pi.notify(`[${bdId}] R${round}: worker starting...`, "info"); } catch {}

    let worker: SpawnedWorker;
    try {
      worker = await rpc_.spawn({
        agent: "worker",
        model: getAgentModel(workDir, "worker"),
        task: workerTaskText,
        cwd: workDir,
        context: "fresh",
        output: workerOutput,
        outputMode: "file-only",
      }, spawnTimeout);
    } catch (e: unknown) {
      return { bdId, verdict: { status: "rework", dimensions: {}, action_items: [], lessons: [] }, diff: currentDiff, branch, workerSummary: currentWorkerSummary, reviews, error: `⏱ Worker r${round} spawn failed after ${(spawnTimeout / 1000)}s: ${e instanceof Error ? e.message : String(e)}. Try increasing spawn_timeout in .agile/config.json or simplifying the task.` };
    }

    onProgress?.(`${bdId} (r${round}): worker started...`);
    try { pi.notify(`[${bdId}] R${round}: worker running...`, "info"); } catch {}
    const workerDone = await pollWithProgress(pi, workDir, rpc_, worker.runId, workerOutput, `worker-${bdId}-r${round}`, (s: string) => onProgress?.(`${bdId}: ${s}`));
    if (!workerDone) {
      return { bdId, verdict: { status: "rework", dimensions: {}, action_items: [], lessons: [] }, diff: currentDiff, branch, workerSummary: currentWorkerSummary, reviews, error: `⏱ Worker r${round} did not complete within ${Math.round(spawnTimeout / 1000)}s. Increase spawn_timeout in .agile/config.json or split into smaller tasks.` };
    }

    try { if (fs.existsSync(workerOutput)) currentWorkerSummary = fs.readFileSync(workerOutput, "utf8"); } catch {}

    // 3. Get diff
    try { pi.notify(`[${bdId}] R${round}: worker done, getting diff...`, "info"); } catch {}
    currentDiff = await gitDiff(pi, workDir, `main...${branch}`);
    if (!currentDiff.trim()) {
      if (round > 1) {
        overallVerdict = { status: "rework", dimensions: {}, action_items: ["Worker reverted all changes after rework feedback."], lessons: [] };
        return { bdId, verdict: overallVerdict, diff: currentDiff, branch, workerSummary: currentWorkerSummary, reviews, error: "no diff after rework" };
      }
      return { bdId, verdict: { status: "rework", dimensions: {}, action_items: [], lessons: [] }, diff: "", branch, workerSummary: currentWorkerSummary, reviews, error: "no diff produced" };
    }

    // 4. Spawn reviewer
    const reviewerTaskText = buildReviewerTask(meta.title, meta.description, currentDiff, constraints, patterns, reviewDepth);
    onProgress?.(`${bdId} (r${round}): spawning reviewer...`);
    try { pi.notify(`[${bdId}] R${round}: reviewer starting...`, "info"); } catch {}

    let reviewer: SpawnedWorker;
    try {
      reviewer = await rpc_.spawn({
        agent: "reviewer",
        model: getAgentModel(workDir, "reviewer"),
        task: reviewerTaskText,
        cwd: workDir,
        context: "fresh",
        output: reviewerOutput,
        outputMode: "file-only",
      }, spawnTimeout);
    } catch (e: unknown) {
      return { bdId, verdict: { status: "rework", dimensions: {}, action_items: [], lessons: [] }, diff: currentDiff, branch, workerSummary: currentWorkerSummary, reviews, error: `⏱ Reviewer r${round} spawn failed after ${(spawnTimeout / 1000)}s: ${e instanceof Error ? e.message : String(e)}. Try increasing spawn_timeout in .agile/config.json.` };
    }

    onProgress?.(`${bdId} (r${round}): reviewer started...`);
    await pollWithProgress(pi, workDir, rpc_, reviewer.runId, reviewerOutput, `reviewer-${bdId}-r${round}`, (s: string) => onProgress?.(`${bdId}: ${s}`));

    let verdictText = "";
    try { if (fs.existsSync(reviewerOutput)) verdictText = fs.readFileSync(reviewerOutput, "utf8"); } catch {}

    overallVerdict = parseReviewVerdict(verdictText);
    reviews.push({ round, action_items: overallVerdict.action_items ?? [], lessons: overallVerdict.lessons ?? [] });
    try { pi.notify(`[${bdId}] R${round}: ${overallVerdict.status}`, "info"); } catch {}

    // 5. Decision: approved→ready; blocked→stop; rework→continue
    if (overallVerdict.status === "approved" || overallVerdict.status === "blocked") {
      break;
    }
  }

  return { bdId, verdict: overallVerdict, diff: currentDiff, branch, workerSummary: currentWorkerSummary, reviews, chainOutputs };
}

/**
 * Parallel batch: create worktrees, delegate each task in its own worktree.
 * Each task runs independent worker→reviewer→rework loop.
 * Approved tasks auto-merged. Worktrees cleaned up.
 */
async function delegateBatchParallel(
  pi: ExtensionAPI,
  rpc_: RpcClient,
  mainWorkDir: string,
  tasks: { bdId: string; meta: { title: string; description: string; acceptanceCriteria?: string } }[],
  constraints: string,
  deadEnds: string,
  patterns: string,
  reviewDepth: "deep" | "standard",
  chain: string[],
  onProgress?: (status: string) => void,
): Promise<{
  results: Awaited<ReturnType<typeof delegateTaskInWorktree>>[];
}> {
  const parentDir = path.dirname(mainWorkDir);
  const repoName = path.basename(mainWorkDir);

  // 1. Ensure on main
  const mainBranch = await gitCheckoutMain(pi, mainWorkDir);

  // 2. Create worktrees for each task
  const worktrees: string[] = [];
  try {
    for (const t of tasks) {
      const wtDir = path.join(parentDir, `${repoName}-${t.bdId}`);
      await pi.exec("git", ["worktree", "add", "-b", `feat/${t.bdId}`, wtDir, mainBranch], { cwd: mainWorkDir, timeout: 30_000 });
      worktrees.push(wtDir);
      onProgress?.(`${t.bdId}: worktree created`);
    }
  } catch (e: unknown) {
    for (const wt of worktrees) {
      try { await pi.exec("git", ["worktree", "remove", "--force", wt], { cwd: mainWorkDir, timeout: 10_000 }); } catch {}
      try { fs.rmSync(wt, { recursive: true, force: true }); } catch {}
    }
    throw e;
  }

  // 3. Run ALL tasks in parallel — each its own worktree, each has its own loop
  onProgress?.("Running all tasks in parallel...");
  const spawnTimeout = getSpawnTimeout(mainWorkDir);
  const taskPromises = tasks.map((t, i) =>
    delegateTaskInWorktree(pi, rpc_, worktrees[i], t.bdId, t.meta, constraints, deadEnds, patterns, reviewDepth, spawnTimeout, onProgress, chain)
  );
  const results = await Promise.all(taskPromises);

  // 4. Write progress snapshot
  writeBatchProgress(mainWorkDir, {
    tasks: results.map(r => ({
      bdId: r.bdId,
      round: (r.reviews ?? []).length,
      stage: r.error ? "error" : r.verdict.status === "approved" ? "merge" : r.verdict.status,
      status: r.error ? `error: ${r.error}` : r.verdict.status,
    })),
  });

  // 5. For approved tasks: merge to main
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.verdict.status === "approved" && !r.error) {
      onProgress?.(`${r.bdId}: approved, merging...`);
      try {
        const mergeResult = await gitMergeFromWorktree(pi, mainWorkDir, worktrees[i], r.branch, `feat: merge ${r.bdId}`);
        if (mergeResult) r.error = `merge failed: ${mergeResult}`;
      } catch (e: unknown) {
        r.error = `merge error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  // 6. Clean up worktrees
  onProgress?.("Cleaning up worktrees...");
  for (const wt of worktrees) {
    try { await pi.exec("git", ["worktree", "remove", "--force", wt], { cwd: mainWorkDir, timeout: 10_000 }); } catch {}
    try { fs.rmSync(wt, { recursive: true, force: true }); } catch {}
  }

  return { results };
}

/**
 * Batch mode handler: reads task details from bd, delegates in parallel,
 * merges approved, returns formatted summary to agent.
 */
async function executeBatchTasks(
  pi: ExtensionAPI,
  rpc_: RpcClient,
  workDir: string,
  bdIds: string[],
  runtime: AgileRuntime,
  onUpdate: (update: { type: string; content?: string }) => void,
  chain?: string[],
): Promise<{ content: { type: "text"; text: string }[] }> {
  const project = loadProjectConfig(workDir);
  const meta = extractProjectMeta(project);
  const constraints = loadConstraintsText(workDir);
  const patterns = runtime.knowledge.formatPatterns();
  const deadEnds = runtime.knowledge.formatDeadEnds();

  //

  // Read all task details from bd
  const tasks: { bdId: string; meta: { title: string; description: string; acceptanceCriteria?: string } }[] = [];
  for (const bdId of bdIds) {
    const bdOutput = await execText(pi, "bd", ["show", bdId], workDir, 10_000);
    const parsed = parseBdShow(bdOutput);
    tasks.push({
      bdId,
      meta: {
        title: parsed.title ?? `(task ${bdId})`,
        description: parsed.description ?? "",
        acceptanceCriteria: parsed.acceptanceCriteria,
      },
    });
  }

  //

  const chains = getChainConfig(workDir);
  const taskChain = (chain as string[] | undefined) ?? chains.default ?? ["worker", "reviewer"];
  let results: Awaited<ReturnType<typeof delegateBatchParallel>>["results"] = [];
  try {
    const batchResult = await delegateBatchParallel(
    pi, rpc_, workDir, tasks, constraints, deadEnds, patterns,
    meta.reviewDepth as "deep" | "standard",
    taskChain,
    () => {},
  );

    results = batchResult.results;
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text" as const, text: `\u274c Batch delegation failed: ${errMsg}` }] };
  }

  // Update sprint state
  const sprint = runtime.store.getCurrent(workDir);
  const lines: string[] = ["# Batch Results\n"];
  const approved: string[] = [];
  const rework: string[] = [];
  const blocked: string[] = [];
  const errored: string[] = [];

  for (const r of results) {
    if (r.error) {
      errored.push(r.bdId);
      lines.push(`## ${r.bdId}: \u274c ERROR`);
      lines.push(r.error);
      lines.push("");
    } else if (r.verdict.status === "approved") {
      approved.push(r.bdId);
      if (sprint) runtime.store.markDone(sprint, r.bdId);
      lines.push(`## ${r.bdId}: \u2705 APPROVED`);
      lines.push(`Merged to main.`);
      if (r.reviews && r.reviews.length > 0) {
        lines.push(`Rounds: ${r.reviews.length}`);
        r.reviews.forEach((rev, i) => {
          if (rev.lessons.length > 0) lines.push(`  Lessons r${i + 1}: ${rev.lessons.join("; ")}`);
        });
      }
      lines.push("");
    } else if (r.verdict.status === "rework") {
      rework.push(r.bdId);
      if (sprint) runtime.store.markRework(sprint, r.bdId, `rework after ${r.reviews?.length ?? 0} rounds`);
      lines.push(`## ${r.bdId}: \u26a0\ufe0f REWORK`);
      lines.push(`Action items:`);
      (r.verdict.action_items ?? []).forEach((ai: string) => lines.push(`  - ${ai}`));
      lines.push("");
    } else if (r.verdict.status === "blocked") {
      blocked.push(r.bdId);
      if (sprint) runtime.store.markBlocked(sprint, r.bdId, r.verdict.action_items?.join("; "));
      lines.push(`## ${r.bdId}: \u26d4 BLOCKED`);
      (r.verdict.action_items ?? []).forEach((ai: string) => lines.push(`  - ${ai}`));
      lines.push("");
    }
  }

  // Summary line
  lines.push("---");
  lines.push(`Approved: ${approved.length} | Rework: ${rework.length} | Blocked: ${blocked.length} | Errors: ${errored.length}`);
  if (rework.length > 0) {
    lines.push("");
    lines.push("\u26a0\ufe0f REWORK tasks need fixes. Read action_items above, then call agile_delegate_task again with bd_id for each.");
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

/** Parse `bd show <id>` output to extract title, description, acceptance criteria.
 *  Example output:
 *    ○ agile-test-9do · Task title   [● P2 · OPEN]
 *    DESCRIPTION
 *    Task description text
 *    ACCEPTANCE CRITERIA
 *    Criteria text
 */
function parseBdShow(output: string): { title?: string; description?: string; acceptanceCriteria?: string } {
  const result: { title?: string; description?: string; acceptanceCriteria?: string } = {};

  const firstLine = output.split("\n")[0] ?? "";
  const titleMatch = firstLine.match(/·\s+(.+?)\s+\[/);
  if (titleMatch) result.title = titleMatch[1].trim();

  const descMatch = output.match(/DESCRIPTION\n([\s\S]*?)(?:\n\n\n|$|\n[A-Z])/);
  if (descMatch) result.description = descMatch[1].trim();

  const accMatch = output.match(/ACCEPTANCE CRITERIA\n([\s\S]*?)(?:\n\n\n|$|\n[A-Z])/);
  if (accMatch) result.acceptanceCriteria = accMatch[1].trim();

  return result;
}

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
  maxWaitSeconds = 600,
): Promise<boolean> {
  const pollInterval = 5000;
  let attempts = 0;
  const maxAttempts = Math.ceil(maxWaitSeconds / (pollInterval / 1000));

  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, pollInterval));
    attempts++;

    // Check 1: output file exists (most reliable signal)
    if (fs.existsSync(outputFile)) {
      onUpdate?.({ content: [{ type: "text", text: `${role} completed (output file found)` }] });
      return true;
    }

    // Check 2: rpc.status()
    try {
      const status = (await rpc.status(runId, 3000)) as { state?: string } | null;
      if (status?.state === "completed" || status?.state === "stopped" || status?.state === "failed") {
        onUpdate?.({ content: [{ type: "text", text: `${role} finished (state: ${status.state})` }] });
        // Give output file a moment to flush
        for (let w = 0; w < 12; w++) {
          await new Promise((r) => setTimeout(r, 1000));
          if (fs.existsSync(outputFile)) break;
        }
        return true;
      }
    } catch {
      // rpc.status failed — ignore, loop continues with file check
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
  currentSprintId: number;
  rpc: RpcClient | null;
  observerState: SprintObserverState;
  observerConfig: ObserverConfig;
  knowledge: KnowledgeBase;
  store: SprintStore;
}

function createRuntime(events: unknown): AgileRuntime {
  return {
    agileMode: false,
    sprintLoopActive: false,
    currentSprintId: 0,
    rpc: null,
    observerState: createObserverState(),
    observerConfig: { ...DEFAULT_OBSERVER_CONFIG },
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

/** Try to restore sprint state from disk if current is null. */
function getOrRestoreSprint(rt: AgileRuntime, workDir: string): SprintState | null {
  const current = rt.store.getCurrent();
  if (current) return current;
  const lastId = rt.store.findLastSprintId(workDir);
  if (lastId > 0) {
    const sprint = rt.store.load(workDir, lastId);
    if (sprint) return sprint;
  }
  return null;
}

// Module-level runtime store (per-session)
const runtimeStore = new Map<string, AgileRuntime>();

/** Set agile mode flag — gates tool execution and system prompt injection. */
function setAgileMode(ctx: ExtensionContext, enabled: boolean, workDir?: string): void {
  getRuntime(ctx, runtimeStore).agileMode = enabled;
  // Persist to .agile/config.json
  if (workDir) {
    const config = loadAgileConfig(workDir);
    config.agile_mode = enabled;
    saveAgileConfig(workDir, config);
  }
  if (!enabled) {
    // Remove gated tools from active set when turning off
    const tools = ctx.getActiveTools?.() ?? [];
    const gated = ["agile_discover", "agile_start_sprint", "agile_delegate_task", "agile_merge_task", "agile_retrospective", "agile_knowledge"];
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
1. **Initialize all analysis tools** for the project:
   - Set up ESLint/Pylint/TSConfig — the project MUST have working linter config
   - Add test runner config (Jest/Vitest/node --test) — tests are REQUIRED for every change
   - Install coverage tools (c8/nyc/istanbul) if available
   - Configure complexity analyzers (plato/complexity-report)
   - Without these tools, \`agile_discover\` returns empty results for those categories
2. Add the configs and tool setup as the FIRST tasks in bd
3. Only proceed to discovery after tools are working

### Phase 1: Discovery
1. Call \`agile_discover\` tool — returns raw lint/coverage/TODO/security output
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

**Rules:**
- Chain agents run ONCE before the worker loop (not on rework rounds)
- Each chain agent sees outputs from previous chain agents
- Rework loop is always worker → reviewer (no scout/re-research)
- Set project-wide defaults in \`.agile/config.json\`:
  \`\`\`json
  {"agent_chains": {"refactor": ["scout", "worker", "reviewer"]}}
  \`\`\`
- Pass \`chain\` per-call: \`agile_delegate_task({bd_id: "...", chain: ["scout", "worker", "reviewer"]})\`

### Phase 4: Sprint Execution
For each task in the sprint:
1. Call \`agile_delegate_task\` with just the bd_id — the tool reads task details from bd
2. Select the chain (from table above based on task type)
3. The worker gets context from prior chain steps (scout report, research, plan)
4. Read the review verdict:
   - **approved** → call \`agile_merge_task\` to merge to main
   - **rework** → read action_items, call \`agile_delegate_task\` again for rework
   - **blocked** → task is fundamentally flawed, move to next task
4. Repeat until all tasks done/blocked

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
- researcher: zai-glm/glm-5.2 (stronger for research tasks)
- planner: zai-glm/glm-5.2 (stronger for decomposition)

Override in .agile/config.json:
  { "agent_models": { "scout": "opencode-go/deepseek-v4-flash", "researcher": "zai-glm/glm-5.2" } }

All agents run with fresh context (no parent session inheritance).

## Key Rules

1. **ONE task per agile_delegate_task call** — don't batch
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
        cleanupStaleWorktrees(ctx.cwd);
      }
    }
    if (!runtime.agileMode) return;

    const workDir = ctx.cwd;
    const project = loadProjectConfig(workDir);
    if (!project) return; // Not an agile project

    const meta = extractProjectMeta(project);
    const scope = extractScope(project);
    const constraints = loadConstraintsText(workDir);

    const knowledge = new KnowledgeBase();
    knowledge.load(workDir);
    const knowledgeText = knowledge.formatAll();

    let extra = "\n\n# pi-agile: Autonomous Sprint Engine\n";

    extra += `\n## Project Goal\n${meta.goal}\n`;
    extra += `\n## Scope\nInclude: ${scope.join(", ")}\n`;
    const exclude = ((project.project as Record<string, unknown>)?.scope as Record<string, unknown>)?.exclude as string[];
    if (exclude) extra += `Exclude: ${exclude.join(", ")}\n`;

    if (constraints) extra += `\n## Constraints (MUST follow)\n${constraints}\n`;
    if (knowledgeText) extra += `\n## Knowledge from Previous Sprints\n${knowledgeText}\n`;

    extra += SYSTEM_PROMPT_WORKFLOW;

    event.systemPrompt = event.systemPrompt + extra;
  });

  // -----------------------------------------------------------------------
  // Tools
  // -----------------------------------------------------------------------

  // Tool: agile_discover — run discovery, return raw output
  pi.registerTool({
    name: "agile_discover",
    label: "agile_discover",
    description: "Run codebase discovery (linters, coverage, TODOs, security). Returns raw output for the agent to analyze and decide which findings become tasks.",
    parameters: Type.Object({
      scope: Type.Optional(Type.Array(Type.String(), { description: "Glob patterns to scan. Defaults to project scope." })),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to session cwd)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx, runtimeStore);
      const gate = assertAgileActive(runtime);
      if (gate) return gate;
      const workDir = (params.cwd as string) || ctx.cwd;
      const project = loadProjectConfig(workDir);
      const scope = (params.scope as string[]) ?? extractScope(project);

      const result = await runDiscovery(workDir, scope);
      const text = formatDiscoveryResult(result);

      return {
        content: [{ type: "text" as const, text: `# Discovery Results\n\n${text}` }],
        details: { sourceCount: 6 },
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

      const sprintId = runtime.store.findLastSprintId(workDir) + 1;
      const sprint = runtime.store.create(workDir, sprintId, meta.goal);

      // Add tasks to sprint state (read titles from bd)
      for (const bdId of params.task_ids as string[]) {
        const bdOutput = await execText(pi, "bd", ["show", bdId], workDir, 10_000);
        const parsed = parseBdShow(bdOutput);
        runtime.store.addTask(sprint, {
          bd_id: bdId,
          title: parsed.title ?? `(task ${bdId})`,
          description: parsed.description,
          status: "backlog",
        });
      }

      runtime.currentSprintId = sprintId;

      return {
        content: [{
          type: "text" as const,
          text: `# Sprint ${sprintId} Started\n\nGoal: ${meta.goal}\nTasks: ${(params.task_ids as string[]).length}\n\nNext: call agile_delegate_task for each task.`,
        }],
        details: { sprintId, taskCount: (params.task_ids as string[]).length },
      };
    },
  });

  // Tool: agile_delegate_task — delegate worker + reviewer for one task
  pi.registerTool({
    name: "agile_delegate_task",
    label: "agile_delegate_task",
    description: "Delegate task(s) to worker+reviewer subagents. Single: pass bd_id. Parallel batch: pass bd_ids[] — each task gets its own worktree, parallel workers, independent rework loops (up to 3 rounds). Title/description auto-read from bd.",
    parameters: Type.Object({
      bd_id: Type.Optional(Type.String({ description: "Single task ID (e.g. agile-test-9do). Mutually exclusive with bd_ids." })),
      bd_ids: Type.Optional(Type.Array(Type.String(), { description: "Multiple task IDs for parallel batch. Mutually exclusive with bd_id." })),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to session cwd)" })),
      title: Type.Optional(Type.String({ description: "Override task title (normally read from bd). Single mode only." })),
      description: Type.Optional(Type.String({ description: "Override task description (normally read from bd). Single mode only." })),
      chain: Type.Optional(Type.Array(Type.String(), { description: "Agent chain: e.g. ['scout','worker','reviewer'] or ['worker','reviewer'] (default). Overrides agent_chains.default from .agile/config.json." })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const workDir = (params.cwd as string) || ctx.cwd;
      const runtime = getRuntime(ctx, runtimeStore);
      {
        const gate = assertAgileActive(runtime);
        if (gate) return gate;
      }
      const bdIds = params.bd_ids as string[] | undefined;
      const singleBdId = params.bd_id as string | undefined;

      // BATCH MODE: bd_ids[] provided → parallel worktree delegation
      if (bdIds && bdIds.length > 0) {
        if (singleBdId) {
          return { content: [{ type: "text" as const, text: "❌ Cannot use both bd_id and bd_ids. Use one or the other." }] };
        }
        return await executeBatchTasks(pi, rpc, workDir, bdIds, runtime, onUpdate, params.chain as string[] | undefined);
      }

      if (!singleBdId) {
        return { content: [{ type: "text" as const, text: "❌ Provide bd_id (single task) or bd_ids[] (parallel batch)." }] };
      }

      const project = loadProjectConfig(workDir);
      const meta = extractProjectMeta(project);

      if (!await rpc.ping()) {
        return {
          content: [{ type: "text" as const, text: "❌ pi-subagents RPC bridge not ready. Ensure pi-subagents extension is installed and active." }],
        };
      }

      const bdId = params.bd_id as string;

      // Read task details from bd if not provided
      let title = params.title as string | undefined;
      let description = (params.description as string) ?? "";
      let acceptanceCriteria: string | undefined;

      if (!title) {
        const bdOutput = await execText(pi, "bd", ["show", bdId], workDir, 10_000);
        const parsed = parseBdShow(bdOutput);
        title = parsed.title ?? `(task ${bdId})`;
        description = parsed.description ?? description;
        acceptanceCriteria = parsed.acceptanceCriteria;
      }
      const branch = `feat/${bdId}`;

      // 1. Create feature branch
      await gitCreateBranch(pi, workDir, branch);

      // 2. Load context for worker
      runtime.knowledge.load(workDir);
      const constraints = loadConstraintsText(workDir);
      const deadEnds = runtime.knowledge.formatDeadEnds();
      const chains = getChainConfig(workDir);
      const taskChain = (params.chain as string[] | undefined) ?? chains.default ?? ["worker", "reviewer"];
      const patterns = runtime.knowledge.formatPatterns();

      // 2b. Run chain agents before worker (scout, researcher, planner, etc.)
      const chainOutputs: { agent: string; output: string }[] = [];
      const preWorker = taskChain.slice(0, taskChain.indexOf("worker"));
      for (const agent of preWorker) {
        try { pi.notify(`[${bdId}] Chain: ${agent} starting...`, "info"); } catch {}
        const agentOutput = path.join(workDir, ".agile", `${agent}-${bdId}.txt`);
        const agentTaskText = buildChainAgentTask(agent, title, description, acceptanceCriteria, constraints, patterns, chainOutputs);
        try {
          const spawned = await rpc.spawn({
            agent, model: getAgentModel(workDir, agent),
            task: agentTaskText, cwd: workDir, context: "fresh",
            output: agentOutput, outputMode: "file-only",
          }, Math.min(getSpawnTimeout(workDir), 120_000));
          await pollWithProgress(pi, workDir, rpc, spawned.runId, agentOutput, `${agent}-${bdId}`, onUpdate, 300);
        } catch (e: unknown) {
          chainOutputs.push({ agent, output: `[FAILED] ${e instanceof Error ? e.message : String(e)}` });
          continue;
        }
        let output = "";
        try { if (fs.existsSync(agentOutput)) output = fs.readFileSync(agentOutput, "utf8"); } catch {}
        chainOutputs.push({ agent, output: output || `(${agent} completed)` });
        try { pi.notify(`[${bdId}] Chain: ${agent} done`, "info"); } catch {}
      }

      // 3. Delegate worker via RPC
      const workerTaskText = buildWorkerTask(title, description, acceptanceCriteria, constraints, patterns, deadEnds, undefined, chainOutputs.length > 0 ? chainOutputs : undefined);
      const workerOutput = path.join(workDir, ".agile", `worker-${bdId}.txt`);

      let worker: SpawnedWorker;
      try {
        worker = await rpc.spawn({
          agent: "worker",
          model: getAgentModel(workDir, "worker"),
          task: workerTaskText,
          cwd: workDir,
          context: "fresh",
          output: workerOutput,
          outputMode: "file-only",
        }, getSpawnTimeout(workDir));
      } catch (e: unknown) {
        return {
          content: [{ type: "text" as const, text: `❌ Failed to spawn worker: ${e instanceof Error ? e.message : String(e)}` }],
        };
      }

      // Poll for worker completion with progress updates
      const workerDone = await pollWithProgress(pi, workDir, rpc, worker.runId, workerOutput, "worker", onUpdate);
      if (!workerDone) {
        return {
          content: [{ type: "text" as const, text: `❌ Worker task ${bdId} did not complete within timeout. Check worker output: ${workerOutput}` }],
        };
      }

      // Read worker output
      let workerSummary = "";
      try {
        if (fs.existsSync(workerOutput)) {
          workerSummary = fs.readFileSync(workerOutput, "utf8");
        }
      } catch { /* best-effort */ }

      // 4. Get diff
      const diff = await gitDiff(pi, workDir, `main...${branch}`);

      if (!diff.trim()) {
        return {
          content: [{
            type: "text" as const,
            text: `⚠️ Worker produced no diff for task ${bdId}. The worker may have failed or made no changes. Worker summary: ${workerSummary.slice(0, 500)}`,
          }],
        };
      }

      // 5. Delegate reviewer via RPC
      const reviewerTaskText = buildReviewerTask(title, description, diff, constraints, patterns, meta.reviewDepth as "deep" | "standard");
      const reviewerOutput = path.join(workDir, ".agile", `review-${bdId}.txt`);

      let reviewer: SpawnedWorker;
      try {
        reviewer = await rpc.spawn({
          agent: "reviewer",
          model: getAgentModel(workDir, "reviewer"),
          task: reviewerTaskText,
          cwd: workDir,
          context: "fresh",
          output: reviewerOutput,
          outputMode: "file-only",
        }, getSpawnTimeout(workDir));
      } catch (e: unknown) {
        return {
          content: [{ type: "text" as const, text: `❌ Failed to spawn reviewer: ${e instanceof Error ? e.message : String(e)}` }],
        };
      }

      // Poll for reviewer completion with progress updates
      const reviewerDone = await pollWithProgress(pi, workDir, rpc, reviewer.runId, reviewerOutput, "reviewer", onUpdate);
      if (!reviewerDone) {
        return {
          content: [{ type: "text" as const, text: `❌ Reviewer for ${bdId} did not complete within timeout. Check output: ${reviewerOutput}. Continuing with whatever was produced.` }],
        };
      }

      // Read reviewer output and parse verdict
      let verdictText = "";
      try {
        if (fs.existsSync(reviewerOutput)) {
          verdictText = fs.readFileSync(reviewerOutput, "utf8");
        }
      } catch { /* best-effort */ }

      const verdict = parseReviewVerdict(verdictText);

      // 6. Update sprint state
      const sprint = runtime.store.getCurrent();
      if (sprint) {
        if (verdict.status === "approved") {
          // markInReview + markDone will be called by merge tool
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
      }

      // 7. Format verdict for agent
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

      const verdictText2 = `# Review Verdict: ${bdId}

**Status:** ${verdict.status.toUpperCase()}

## Dimensions
${dimensionLines.join("\n")}${actionItems}

## Worker Summary
${workerSummary.slice(0, 1000)}`;

      return {
        content: [{ type: "text" as const, text: verdictText2 }],
        details: { verdict: verdict.status, bdId },
      };
    },
  });

  // Tool: agile_merge_task — merge approved task branch to main
  pi.registerTool({
    name: "agile_merge_task",
    label: "agile_merge_task",
    description: "Merge an approved task's feature branch to main (squash merge). Run main checks (lint + test). Call only after agile_delegate_task returns 'approved'.",
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
      const bdId = params.bd_id as string;
      const branch = `feat/${bdId}`;

      // Merge
      const mergeResult = await gitMergeSquash(pi, workDir, branch, `feat: merge ${bdId}`);
      if (mergeResult) {
        return {
          content: [{ type: "text" as const, text: `❌ Merge failed: ${mergeResult}` }],
        };
      }

      // Run main checks (test, optionally lint)
      let checksOutput = "";

      // Only run eslint if config exists
      const hasEslint = [".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.yaml", "eslint.config.js", "eslint.config.mjs"]
        .some((f) => fs.existsSync(path.join(workDir, f)));
      if (hasEslint) {
        const result = await execText(pi, "npx", ["eslint", "."], workDir, 60_000);
        if (result.trim()) checksOutput += `## Lint\n${result.slice(0, 1000)}\n\n`;
      }

      // Run tests
      if (fs.existsSync(path.join(workDir, "package.json"))) {
        const result = await execText(pi, "npm", ["test"], workDir, 120_000);
        if (result.trim()) checksOutput += `## Tests\n${result.slice(0, 2000)}`;
      } else if (fs.existsSync(path.join(workDir, "go.mod"))) {
        const result = await execText(pi, "go", ["test", "./..."], workDir, 120_000);
        if (result.trim()) checksOutput += `## Tests\n${result.slice(0, 2000)}`;
      }

      // Update sprint state
      const sprint = runtime.store.getCurrent();
      if (sprint) {
        runtime.store.markDone(sprint, bdId);
        trackTaskTransition(runtime.observerState, bdId, "done");

        runtime.knowledge.append({
          type: "task_done",
          task_id: bdId,
          sprint: sprint.id,
          ts: new Date().toISOString(),
          title: `(task ${bdId})`,
        });
        runtime.knowledge.save(workDir);
        runtime.store.save(workDir, sprint);
      }

      // Delete feature branch
      try {
        await pi.exec("git", ["branch", "-D", branch], { cwd: workDir, timeout: 5000 });
      } catch { /* best-effort */ }

      return {
        content: [{
          type: "text" as const,
          text: `✅ Task ${bdId} merged to main.\n\n## Main Checks Output\n${checksOutput.trim() || "(no lint config or test runner found — verify manually)"}`,
        }],
      };
    },
  });

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
      const sprint = runtime.store.getCurrent(workDir);

      if (!sprint) {
        return {
          content: [{ type: "text" as const, text: "❌ No active sprint found. Start a sprint with agile_start_sprint or ensure sprint-*.json exists in .agile/." }],
        };
      }

      // Compute velocity
      sprint.velocity = runtime.store.computeVelocity(sprint);

      // Save sprint summary to knowledge
      runtime.knowledge.load(workDir);
      runtime.knowledge.append({
        type: "sprint_summary",
        sprint: sprint.id,
        ts: new Date().toISOString(),
        ...sprint.velocity,
      });
      runtime.knowledge.save(workDir);

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

      // Append observer steers to output if any
      const steerText = observerSteers.length > 0
        ? `
## Observer
${observerSteers.map((s: { type: string; message: string; severity: string }) => `[${s.severity}] ${s.message}`).join("\n")}
`
        : "";

      return {
        content: [{ type: "text" as const, text: retroText + steerText }],
        details: { sprintId: sprint.id, velocity: v, observerSteers },
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
      - metric: sprint_count
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

        ctx.ui.notify(lines.join("\n") + `\n\n✅ Setup complete! Configs created in ${agileDir}/\n\nNext: /agile on`, "info");
        return;
      }

      if (command === "on") {
        setAgileMode(ctx, true, workDir);
        const cleaned = cleanupStaleWorktrees(workDir);
        ctx.ui.notify("✅ Agile mode ON — tools and system prompt active" + (cleaned > 0 ? ` Cleaned ${cleaned} stale worktree(s).` : ""), "info");
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
          `Sprint loop active: ${runtime.sprintLoopActive ? "yes" : "no"}`,
        ].join("\n"), "info");
        return;
      }

      if (command === "stop") {
        const runtime = getRuntime(ctx, runtimeStore);
        runtime.sprintLoopActive = false;
        ctx.ui.notify("Sprint loop stopped", "info");
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
            "researcher — API/best-practices research agent",
            "planner — task decomposition agent",
            "show current models",
          ];
          const roleChoice = await ctx.ui.select("Select agent role:", roleChoices);
          if (!roleChoice) return;
          if (roleChoice === "show current models") { await showModelStatus(totalCount, providerCount); return; }
          const roleMap: Record<string, string> = { worker: "worker", reviewer: "reviewer", scout: "scout", researcher: "researcher", planner: "planner" };
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
\`/agile setup\`    — Run setup wizard (creates .agile/project.yaml + constraints.yaml)
\`/agile status\`   — Show current sprint status
\`/agile stop\`     — Graceful stop
\`/agile config\`   — Show configuration
\`/agile observer\` — Toggle observer on/off

## Workflow
1. \`/agile setup\` — configure project
2. \`/agile on\` — enable agile mode
3. Call \`agile_discover\` tool — get discovery results
4. Create tasks in bd: \`bd create "title" --description "desc"\`
4. Call \`agile_start_sprint\` — initialize sprint
5. For each task: call \`agile_delegate_task\` → get verdict
6. If approved: call \`agile_merge_task\`
7. Call \`agile_retrospective\` — get velocity + stop-check
8. Decide: stop or continue

Architecture: agent decides, extension runs.`;
}
