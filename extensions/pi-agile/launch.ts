/**
 * launch.ts — agile_run: the launch station. Mechanical, no LLM, starts nothing.
 *
 * 1. read-only bd check: the epic exists, has open leaves, closed leaves have no open deps;
 * 2. snapshot of the open leaves in the shape the engine reads (workflows/agile-loop.js normalizeLeaf);
 * 3. defaults + validation of the launch arguments;
 * 4. output: the engine workflow path, its args and a copyable subagent call line.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { readEpic, runBd, type BdIssue, type BdRunner } from "./bd.ts";

/** Absolute path of the campaign engine, resolved from this file (extensions/pi-agile -> repo root). */
export const ENGINE_WORKFLOW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../workflows/agile-loop.js");
export const LAUNCH_TIMEOUT_MS = 14400000;

const DEFAULT_SPRINT_TASKS = 3;
const DEFAULT_MAX_SPRINTS = 3;
const DEFAULT_MAX_PARALLEL = 3;

export interface LaunchInput {
  epic: string;
  testCommand: string;
  cwd?: string;
  sprintTasks?: number;
  maxSprints?: number;
  maxParallel?: number;
  mergeApproval?: string;
  workModels?: string[];
  reviewModels?: string[];
  bundleScript?: string;
}

/** Leaf in the engine's bdTasks shape (normalizeLeaf fields). */
export interface EngineLeaf {
  id: string;
  title: string;
  rationale: string;
  acceptance: string;
  files_hint: string;
  deps: string[];
  open: boolean;
  review: string;
}

export interface LaunchPlan {
  workflow: string;
  args: Record<string, unknown>;
  cwd: string;
  timeoutMs: number;
  warnings: string[];
  call: string;
}

export interface LaunchOptions {
  cwd: string;
  run?: BdRunner;
}

const RATIONALE_MAX = 300;
const ACCEPTANCE_MAX = 300;
const FILES_HINT_MAX = 200;
const FILES_LINE_RE = /^[ \t]*Файлы[ \t]*:(.*)$/m;
const ACCEPTANCE_RE = /acceptance\s*:/i;
const REVIEW_RE = /\breview\s*:\s*(full|lite|none)\b/i;

function positiveInt(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer (got ${String(value)})`);
  return n;
}

function modelList(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of model ids`);
  return value.map((v) => String(v).trim()).filter((v) => v !== "");
}

/**
 * files_hint = the value of the "Файлы:" line, up to the sentence end ("a.js, b.js. prose" -> "a.js, b.js").
 * No such line -> '' (the planner warns); paths in the prose are never used.
 */
function filesHint(desc: string): string {
  const line = FILES_LINE_RE.exec(desc);
  if (!line) return "";
  const value = line[1].split(/\.(?:\s|$)/)[0].trim();
  return value.slice(0, FILES_HINT_MAX).trim();
}

/** Maps a bd leaf to the engine snapshot. Deps on closed leaves are dropped: already satisfied. */
function toEngineLeaf(issue: BdIssue, closedIds: Set<string>): EngineLeaf {
  const desc = issue.description;
  const acc = ACCEPTANCE_RE.exec(desc);
  const tier = REVIEW_RE.exec(desc);
  return {
    id: issue.id,
    title: issue.title,
    rationale: desc.slice(0, RATIONALE_MAX),
    acceptance: acc ? desc.slice(acc.index + acc[0].length).trim().slice(0, ACCEPTANCE_MAX) : "",
    files_hint: filesHint(desc),
    deps: issue.dependencies
      .filter((d) => d.dependency_type === "blocks" && !closedIds.has(d.id))
      .map((d) => d.id),
    open: issue.status !== "closed",
    review: tier ? tier[1].toLowerCase() : "full",
  };
}

/**
 * Plans an agile_run launch. Throws an Error with a readable message on any invalid input
 * or bd inconsistency. Only read-only bd commands are issued (via opts.run, default `bd`).
 */
export async function planLaunch(input: LaunchInput, opts: LaunchOptions): Promise<LaunchPlan> {
  const epicId = String(input.epic ?? "").trim();
  const testCommand = String(input.testCommand ?? "").trim();
  if (!epicId) throw new Error("epic is required (bd epic id)");
  if (!testCommand) throw new Error("testCommand is required (the host gate: no gate -> no launch)");

  const mergeApproval = input.mergeApproval === undefined ? "auto" : String(input.mergeApproval).trim().toLowerCase();
  if (mergeApproval !== "auto" && mergeApproval !== "confirm") {
    throw new Error(`mergeApproval must be 'auto' or 'confirm' (got ${String(input.mergeApproval)})`);
  }
  const sprintTasks = positiveInt(input.sprintTasks, DEFAULT_SPRINT_TASKS, "sprintTasks");
  const maxSprints = positiveInt(input.maxSprints, DEFAULT_MAX_SPRINTS, "maxSprints");
  const maxParallel = positiveInt(input.maxParallel, DEFAULT_MAX_PARALLEL, "maxParallel");
  const workModels = modelList(input.workModels, "workModels");
  const reviewModels = modelList(input.reviewModels, "reviewModels");
  const shared = workModels.filter((m) => reviewModels.includes(m));
  if (shared.length) {
    throw new Error(`workModels and reviewModels overlap on ${shared.join(", ")}: the reviewer must differ from its author model`);
  }
  const bundleScript = typeof input.bundleScript === "string" ? input.bundleScript.trim() : "";
  const cwd = input.cwd && String(input.cwd).trim() ? String(input.cwd).trim() : opts.cwd;

  const { epic, leaves } = await readEpic(opts.run ?? runBd, epicId, cwd);
  if (leaves.length === 0) throw new Error(`epic ${epicId} has no leaves (no children without children)`);

  const closedIds = new Set(leaves.filter((l) => l.status === "closed").map((l) => l.id));
  const openIds = new Set(leaves.filter((l) => l.status !== "closed").map((l) => l.id));
  for (const leaf of leaves) {
    if (leaf.status !== "closed") continue;
    const openDep = leaf.dependencies.find((d) => d.dependency_type === "blocks" && openIds.has(d.id));
    if (openDep) throw new Error(`bd inconsistency: closed leaf ${leaf.id} depends on open leaf ${openDep.id}`);
  }
  const open = leaves.filter((l) => l.status !== "closed");
  if (open.length === 0) throw new Error(`epic ${epicId} has no open leaves (nothing to launch)`);

  const bdTasks = open.map((l) => toEngineLeaf(l, closedIds));
  const args: Record<string, unknown> = {
    description: `Close bd epic ${epicId} (${epic.title}): every open leaf merged and closed in bd`,
    testCommand,
    taskSource: "bd-epic",
    bdEpic: epicId,
    bdTasks,
    doneWhen: "bd-epic-closed",
    mergeApproval,
    sprintTasks,
    maxSprints,
    maxParallel,
  };
  if (workModels.length) args.workModels = workModels;
  if (reviewModels.length) args.reviewModels = reviewModels;
  if (bundleScript) args.bundleScript = bundleScript;

  const warnings: string[] = [];
  if (!bundleScript) {
    warnings.push("bundleScript not set: the campaign runs without the STEP 0 context bundle (children discover context themselves)");
  }
  for (const t of bdTasks) {
    if (!t.files_hint) warnings.push(`leaf ${t.id}: no "Файлы:" line - files_hint left empty (paths in the prose are not used)`);
  }

  const call = `subagent({ workflowScriptPath: ${JSON.stringify(ENGINE_WORKFLOW)}, args: ${JSON.stringify(args)}, async: true, timeoutMs: ${LAUNCH_TIMEOUT_MS} })`;
  return { workflow: ENGINE_WORKFLOW, args, cwd, timeoutMs: LAUNCH_TIMEOUT_MS, warnings, call };
}
