/**
 * Continuation nudge — shared logic between the `agent_end` hook and the
 * `agile_retrospective` tool, so the auto-continuation behavior lives in one
 * place and is unit-testable without the pi runtime.
 *
 * RC1 fix: a completed sprint (status "done") still deserves the continuation
 * nudge UNLESS a followUp was already sent for it. The anti-spam flag
 * (`agentEndSentForSprint`) is the single source of truth for "already
 * covered": `agile_retrospective` marks the sprint as covered when it sends
 * its own followUp, and `agent_end` skips when the flag matches. The old
 * `status === "done"` gate is gone — it silently killed the nudge in
 * continuous mode (no sprint count), where the retrospective sends nothing.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ContinuationOptions {
  /** Number of tasks that are not done/blocked (still pending). */
  pendingCount: number;
  /** Total tasks in the sprint. */
  taskCount: number;
  /** Sprint id a continuation was already sent for, or null. */
  sentForSprint: number | null;
  /** Current sprint id. */
  sprintId: number;
  /** undefined = continuous mode (unlimited). */
  remainingSprints: number | undefined;
}

/**
 * Pure gate: should the continuation nudge fire for this state?
 * - pending tasks → no (sprint not finished)
 * - empty sprint → no (nothing to nudge about)
 * - already nudged for this sprint id → no (anti-spam)
 * - bounded loop with 0 sprints left → no (loop is over)
 */
export function shouldSendContinuation(opts: ContinuationOptions): boolean {
  const { pendingCount, taskCount, sentForSprint, sprintId, remainingSprints } = opts;
  if (pendingCount > 0) return false;
  if (taskCount === 0) return false;
  if (sentForSprint === sprintId) return false;
  if (remainingSprints !== undefined && remainingSprints <= 0) return false;
  return true;
}

export interface ContinuationContext {
  goal: string;
  originalRequest: string;
  remainingSprints: number | undefined;
  totalTasks: number;
  totalDone: number;
  totalBlocked: number;
  openTasks: string[];
}

/** Build the followUp message shown to the agent. */
export function buildContinuationMessage(ctx: ContinuationContext): string {
  const mode =
    ctx.remainingSprints === undefined
      ? "Continuous mode — no sprint limit."
      : `${ctx.remainingSprints} sprint${ctx.remainingSprints > 1 ? "s" : ""} remaining.`;

  const contextLines = [`Project goal: ${ctx.goal}`];
  if (ctx.originalRequest.trim()) {
    contextLines.push(`Original user request: ${ctx.originalRequest.trim()}`);
  }

  return (
    `All ${ctx.totalTasks} sprint tasks are finished (${ctx.totalDone} done, ${ctx.totalBlocked} blocked).\n` +
    `${mode}\n` +
    `Decide whether to continue finding new work.\n\n` +
    `${contextLines.join("\n")}\n\n` +
    (ctx.openTasks.length > 0
      ? `Open tasks in bd (not in this sprint) — start the next sprint with them:\n` +
        ctx.openTasks.map((id) => `- \`${id}\``).join("\n") +
        `\n\n`
      : ``) +
    `If the original request implies continuing (e.g. improving further, fixing more issues, exploring more areas):\n` +
    `1. If open bd tasks exist above — call \`agile_start_sprint\` with them (plus any new tasks)\n` +
    `2. Run \`agile_discover\` to scan the codebase for remaining issues (check scripts + scout subagent)\n` +
    `3. Review results against project constraints (scope, max tasks from .agile/project.yaml)\n` +
    `4. Create tasks for the next sprint via \`bd create\` with clear acceptance criteria\n` +
    `5. Call \`agile_start_sprint\` to initialize the next sprint\n\n` +
    `If the original request is fully satisfied — end here (no new tasks needed).\n` +
    `Decide and act now — do not end this turn without either starting the next sprint or explicitly concluding the work is complete.`
  );
}

// ---------------------------------------------------------------------------
// Session state persistence (RC3): sprint-loop intent survives pi restarts.
// Persisted per project in .agile/session.json.
// ---------------------------------------------------------------------------

export interface SessionState {
  remainingSprints: number | undefined;
  originalRequest: string;
  sprintLoopActive: boolean;
}

export function sessionStateFilePath(workDir: string): string {
  return path.join(workDir, ".agile", "session.json");
}

export function saveSessionState(workDir: string, state: SessionState): void {
  try {
    const filePath = sessionStateFilePath(workDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* non-fatal — persistence is best effort */
  }
}

/** Read persisted state; returns {} when absent or corrupt. */
export function loadSessionState(workDir: string): Partial<SessionState> {
  try {
    const filePath = sessionStateFilePath(workDir);
    if (!fs.existsSync(filePath)) return {};
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const result: Partial<SessionState> = {};
    if (typeof data.remainingSprints === "number") result.remainingSprints = data.remainingSprints;
    if (typeof data.originalRequest === "string") result.originalRequest = data.originalRequest;
    if (typeof data.sprintLoopActive === "boolean") result.sprintLoopActive = data.sprintLoopActive;
    return result;
  } catch {
    return {};
  }
}
