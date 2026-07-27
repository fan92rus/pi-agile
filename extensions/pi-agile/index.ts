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
import * as path from "node:path";

import { KnowledgeBase } from "./parallel/knowledge.ts";
import { SprintStore, type SprintState } from "./parallel/sprint.ts";
import { runDiscovery, formatDiscoveryResult } from "./parallel/discovery.ts";
import { buildReviewerTask, buildWorkerTask, parseReviewVerdict } from "./parallel/review.ts";
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
};

/** Resolve model for a given agent role from .agile/config.json or default. */
function getAgentModel(workDir: string, role: string): string {
  const config = loadAgileConfig(workDir);
  const models = (config.agent_models ?? {}) as Record<string, string>;
  return models[role] ?? DEFAULT_AGENT_MODELS[role] ?? DEFAULT_AGENT_MODELS.worker;
}

/** Simple YAML parser (key: value, nested via indent, arrays via "- item"). */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");
  const stack: { indent: number; obj: Record<string, unknown> }[] = [{ indent: -1, obj: result }];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    const content = line.trim();

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const current = stack[stack.length - 1].obj;

    if (content.startsWith("- ")) {
      const value = content.slice(2).trim();
      const key = Object.keys(current).find((k) => Array.isArray(current[k]));
      if (key) (current[key] as unknown[]).push(parseYamlValue(value));
    } else if (content.includes(":")) {
      const colonIdx = content.indexOf(":");
      const key = content.slice(0, colonIdx).trim();
      const valueStr = content.slice(colonIdx + 1).trim();
      if (valueStr === "" || valueStr === ">") {
        current[key] = {};
        stack.push({ indent, obj: current[key] as Record<string, unknown> });
      } else {
        current[key] = parseYamlValue(valueStr);
      }
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

async function gitMergeSquash(pi: ExtensionAPI, workDir: string, branch: string): Promise<string> {
  // Detect default branch (main or master)
  const branchResult = await pi.exec("git", ["branch", "--list"], { cwd: workDir, timeout: 5_000 });
  const branchList = (branchResult.stdout ?? "") + (branchResult.stderr ?? "");
  const defaultBranch = branchList.includes("main") ? "main" : "master";

  const checkout = await pi.exec("git", ["checkout", defaultBranch], { cwd: workDir, timeout: 15_000 });
  if (checkout.code !== 0) return `git checkout ${defaultBranch} failed: ${checkout.stderr}`;
  const merge = await pi.exec("git", ["merge", "--squash", branch], { cwd: workDir, timeout: 30_000 });
  return merge.code === 0 ? "" : `git merge --squash ${branch} failed: ${merge.stderr}`;
}

// ---------------------------------------------------------------------------
/** Parse `bd show <id>` output to extract title, description, acceptance criteria. */
function parseBdShow(output: string): { title?: string; description?: string; acceptanceCriteria?: string } {
  // Example bd show output:
  //   ○ agile-test-9do · Fix hardcoded credentials in auth.js   [● P2 · OPEN]
  //   Owner: fan92rus · Type: task
  //   Created: 2026-07-27 · Updated: 2026-07-27
  //
  //   DESCRIPTION
  //   Replace hardcoded password check with proper credential validation
  //
  //   ACCEPTANCE CRITERIA
  //   No hardcoded secrets

  const result: { title?: string; description?: string; acceptanceCriteria?: string } = {};

  // Title is on first line after · separator
  const firstLine = output.split("\n")[0] ?? "";
  const titleMatch = firstLine.match(/·\s+(.+?)\s+\[/);
  if (titleMatch) result.title = titleMatch[1].trim();

  // Description is after DESCRIPTION header
  const descMatch = output.match(/DESCRIPTION\n([\s\S]*?)(?:\n\n\n|$|\n[A-Z])/);
  if (descMatch) result.description = descMatch[1].trim();

  // Acceptance criteria is after ACCEPTANCE CRITERIA header
  const accMatch = output.match(/ACCEPTANCE CRITERIA\n([\s\S]*?)(?:\n\n\n|$|\n[A-Z])/);
  if (accMatch) result.acceptanceCriteria = accMatch[1].trim();

  return result;
}

// Extension runtime state
// ---------------------------------------------------------------------------

interface AgileRuntime {
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

// Module-level runtime store (per-session)
const runtimeStore = new Map<string, AgileRuntime>();

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

### Phase 1: Discovery
1. Call \`agile_discover\` tool — returns raw lint/coverage/TODO/security output
2. Read ALL output carefully
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

### Phase 4: Sprint Execution
For each task in the sprint:
1. Call \`agile_delegate_task\` with just the bd_id — the tool reads task details from bd
2. The tool delegates a worker subagent (implements on feature branch) then a reviewer subagent
3. Read the review verdict:
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

Worker and reviewer subagents use configurable models. Defaults:
- worker: opencode-go/deepseek-v4-flash
- reviewer: opencode-go/deepseek-v4-flash

Override in .agile/config.json:
  { "agent_models": { "worker": "zai-glm/glm-5.2", "reviewer": "zai-glm/glm-5.2" } }

Both worker and reviewer run with fresh context (no parent session inheritance).

## Key Rules

1. **ONE task per agile_delegate_task call** — don't batch
2. **Worker needs context** — write detailed descriptions in bd, workers only see title + description
3. **Constraints are TEXT** — read them above, enforce by reasoning, reject violations
4. **Git workflow** — feature branch per task (\`feat/<bd-id>\`), conventional commits only
5. **Merge only after approved review** — never merge rework or blocked
6. **Record dead-ends** — if a task is blocked, record WHY via agile_knowledge so future sprints avoid it

You make ALL decisions. Extension only runs tools and persists data.`;

export default function piAgileExtension(pi: ExtensionAPI): void {

  // Initialize RPC client for subagent delegation
  const rpc = new RpcClient(pi.events as Parameters<typeof RpcClient>[0]);

  // -----------------------------------------------------------------------
  // System prompt injection
  // -----------------------------------------------------------------------

  pi.on("before_agent_start", async (event, ctx) => {
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
    description: "Delegate a single task to a worker subagent (implements on feature branch), then a reviewer subagent (reviews diff). Returns review verdict. Task title and description are read from bd automatically — just pass bd_id.",
    parameters: Type.Object({
      bd_id: Type.String({ description: "bd task ID (e.g. agile-test-9do)" }),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to session cwd)" })),
      title: Type.Optional(Type.String({ description: "Override task title (normally read from bd)" })),
      description: Type.Optional(Type.String({ description: "Override task description (normally read from bd)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workDir = (params.cwd as string) || ctx.cwd;
      const runtime = getRuntime(ctx, runtimeStore);
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

      // 3. Delegate worker via RPC
      const workerTaskText = buildWorkerTask(title, description, acceptanceCriteria, constraints, deadEnds);
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
        }, 30_000);
      } catch (e: unknown) {
        return {
          content: [{ type: "text" as const, text: `❌ Failed to spawn worker: ${e instanceof Error ? e.message : String(e)}` }],
        };
      }

      // Poll for worker completion via RPC status
      let workerDone = false;
      let attempts = 0;
      const maxAttempts = 120; // 10 min at 5s intervals
      while (!workerDone && attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 5000));
        const status = await rpc.status(worker.runId) as { state?: string } | null;
        if (status?.state === "completed" || status?.state === "stopped" || status?.state === "failed") {
          workerDone = true;
        }
        attempts++;
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
      const patterns = runtime.knowledge.formatPatterns();
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
        }, 30_000);
      } catch (e: unknown) {
        return {
          content: [{ type: "text" as const, text: `❌ Failed to spawn reviewer: ${e instanceof Error ? e.message : String(e)}` }],
        };
      }

      // Poll for reviewer completion
      let reviewerDone = false;
      attempts = 0;
      while (!reviewerDone && attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 5000));
        const status = await rpc.status(reviewer.runId) as { state?: string } | null;
        if (status?.state === "completed" || status?.state === "stopped" || status?.state === "failed") {
          reviewerDone = true;
        }
        attempts++;
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
      const bdId = params.bd_id as string;
      const branch = `feat/${bdId}`;

      // Merge
      const mergeResult = await gitMergeSquash(pi, workDir, branch);
      if (mergeResult) {
        return {
          content: [{ type: "text" as const, text: `❌ Merge failed: ${mergeResult}` }],
        };
      }

      // Run main checks (lint + test)
      const project = loadProjectConfig(workDir);
      const scope = extractScope(project);
      let checksOutput = "";
      checksOutput += await execText(pi, "npx", ["eslint", ...scope], workDir, 60_000);
      if (fs.existsSync(path.join(workDir, "package.json"))) {
        checksOutput += await execText(pi, "npm", ["test"], workDir, 120_000);
      } else if (fs.existsSync(path.join(workDir, "go.mod"))) {
        checksOutput += await execText(pi, "go", ["test", "./..."], workDir, 120_000);
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
          text: `✅ Task ${bdId} merged to main.\n\n## Main Checks Output\n${checksOutput.slice(0, 2000) || "(no checks run)"}`,
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
      const sprint = runtime.store.getCurrent();

      if (!sprint) {
        return {
          content: [{ type: "text" as const, text: "❌ No active sprint. Call agile_start_sprint first." }],
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
      runtime.store.completeSprint(workDir, sprint);

      // Build retrospective text
      const v = sprint.velocity;
      const retroText = `# Sprint ${sprint.id} Retrospective

## Velocity
- Attempted: ${v.attempted}
- Done: ${v.done}
- Rework: ${v.rework}
- Blocked: ${v.blocked}
- Avg review rounds: ${v.avg_review_rounds.toFixed(1)}

## Your Tasks
1. Formulate lessons learned from this sprint
2. Record them via bash: append to .agile/knowledge.jsonl
3. Read the stop-check message below
4. Run stop criteria check commands yourself
5. Decide: stop or continue to next sprint

${buildStopCheckMessage(workDir, sprint.id)}`;

      return {
        content: [{ type: "text" as const, text: retroText }],
        details: { sprintId: sprint.id, velocity: v },
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
        if (parts.length < 3) {
          // Show current models
          const config = loadAgileConfig(workDir);
          const models = (config.agent_models ?? {}) as Record<string, string>;
          const lines = ["# Agent Models", ""]
          lines.push(`  worker:   ${models.worker ?? "opencode-go/deepseek-v4-flash (default)"}`);
          lines.push(`  reviewer: ${models.reviewer ?? "opencode-go/deepseek-v4-flash (default)"}`);
          lines.push("");
          lines.push("Set: /agile model <worker|reviewer> <model-id>");
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }
        const role = parts[1];
        const model = parts[2];
        if (role !== "worker" && role !== "reviewer") {
          ctx.ui.notify(`Unknown role: ${role}. Use 'worker' or 'reviewer'.`, "error");
          return;
        }
        const config = loadAgileConfig(workDir);
        if (!config.agent_models) config.agent_models = {};
        (config.agent_models as Record<string, string>)[role] = model;
        saveAgileConfig(workDir, config);
        ctx.ui.notify(`✅ ${role} model set to: ${model}`, "info");
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

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function agileHelp(): string {
  return `# pi-agile Commands

\`/agile setup\`    — Run setup wizard (creates .agile/project.yaml + constraints.yaml)
\`/agile status\`   — Show current sprint status
\`/agile stop\`     — Graceful stop
\`/agile config\`   — Show configuration
\`/agile observer\` — Toggle observer on/off

## Workflow
1. \`/agile setup\` — configure project
2. Call \`agile_discover\` tool — get discovery results
3. Create tasks in bd: \`bd create "title" --description "desc"\`
4. Call \`agile_start_sprint\` — initialize sprint
5. For each task: call \`agile_delegate_task\` → get verdict
6. If approved: call \`agile_merge_task\`
7. Call \`agile_retrospective\` — get velocity + stop-check
8. Decide: stop or continue

Architecture: agent decides, extension runs.`;
}
