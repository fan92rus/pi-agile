/**
 * observer.ts — Sprint health monitoring
 *
 * Monitors sprint progress and fires steers when unhealthy patterns are detected.
 * Adapted from pi-autoresearch observer pattern (trigger system + steers).
 *
 * Extension code only — runs checks, fires steers, does NOT make decisions.
 * The agent reads steers and decides what to do.
 */

import * as fs from "fs";
import * as path from "path";
import type { SprintState, SprintTask } from "./parallel/sprint.ts";

export interface ObserverConfig {
  /** Rework rounds before flagging a task as stuck. Default: 3 */
  reworkStuckThreshold: number;
  /** Consecutive constraint violations before alerting. Default: 3 */
  constraintSpamThreshold: number;
  /** Velocity drop percentage vs last sprint. Default: 50 */
  velocityDropThreshold: number;
  /** Enable all observer steers. Default: true */
  observerEnabled: boolean;
}

export const DEFAULT_OBSERVER_CONFIG: ObserverConfig = {
  reworkStuckThreshold: 3,
  constraintSpamThreshold: 3,
  velocityDropThreshold: 50,
  observerEnabled: true,
};

export interface SprintObserverState {
  sprintNum: number;
  tasksAttempted: number;
  tasksDone: number;
  tasksRework: number;
  tasksBlocked: number;
  consecutiveReworks: Map<string, number>;
  constraintViolations: Map<string, number>;
  recentTaskStatuses: string[];
}

export function createObserverState(): SprintObserverState {
  return {
    sprintNum: 0,
    tasksAttempted: 0,
    tasksDone: 0,
    tasksRework: 0,
    tasksBlocked: 0,
    consecutiveReworks: new Map(),
    constraintViolations: new Map(),
    recentTaskStatuses: [],
  };
}

export interface ObserverSteer {
  type: string;
  message: string;
  severity: "info" | "warning" | "critical";
}

/**
 * Run all sprint health triggers and return any steers.
 * Called after each task transition (review complete, task done/rework/blocked).
 */
export function runSprintObserver(
  state: SprintState,
  obsState: SprintObserverState,
  config: ObserverConfig,
  workDir?: string,
): ObserverSteer[] {
  if (!config.observerEnabled) return [];

  const steers: ObserverSteer[] = [];

  // 1. Task stuck in rework loop
  const stuckSteer = checkSprintStagnation(state, obsState, config);
  if (stuckSteer) steers.push(stuckSteer);

  // 2. All tasks blocked
  const blockedSteer = checkAllBlocked(state, obsState);
  if (blockedSteer) steers.push(blockedSteer);

  // 3. Same constraint violated multiple times
  const spamSteer = checkConstraintSpam(obsState, config);
  if (spamSteer) steers.push(spamSteer);

  // 4. Discovery empty
  const emptySteer = checkDiscoveryEmpty(state);
  if (emptySteer) steers.push(emptySteer);

  // 5. All tasks in terminal state (done/blocked) — need new tasks
  const exhaustedSteer = checkAllTasksExhausted(state);
  if (exhaustedSteer) steers.push(exhaustedSteer);

  // 6. Sprint completed — recommend continue or check criteria
  if (state.status === "done") {
    const completedSteer = checkSprintCompleted(workDir);
    if (completedSteer) steers.push(completedSteer);
  }

  return steers;
}

/**
 * After sprint completion, check stop criteria and recommend next action.
 * - No stop criteria (continuous mode): recommend analysis + continue.
 * - Stop criteria set: confirm everything is normal, check criteria.
 */
function checkSprintCompleted(workDir?: string): ObserverSteer | null {
  if (!workDir) return null;

  // Read project config to check for stop criteria
  const projectPath = path.join(workDir, ".agile", "project.yaml");
  if (!fs.existsSync(projectPath)) {
    return {
      type: "sprint_completed",
      severity: "info",
      message: "Sprint completed. No stop criteria configured — analyze results and continue to next sprint.",
    };
  }

  try {
    const yaml = fs.readFileSync(projectPath, "utf8");
    const hasStopWhen = yaml.includes("stop_when");

    if (!hasStopWhen) {
      return {
        type: "sprint_completed",
        severity: "info",
        message: "Sprint completed. No stop criteria (continuous mode). Analyze sprint results, record lessons, then start next sprint.",
      };
    }

    return {
      type: "sprint_completed",
      severity: "info",
      message: "Sprint completed. Stop criteria are configured — check them before deciding: continue or stop.",
    };
  } catch {
    return {
      type: "sprint_completed",
      severity: "info",
      message: "Sprint completed. Analyze results and decide: continue or stop.",
    };
  }
}

/**
 * All tasks in the sprint are in terminal states (done/blocked),
 * no pending work — recommend running discovery or ending sprint.
 */
function checkAllTasksExhausted(state: SprintState): ObserverSteer | null {
  if (state.tasks.length === 0) return null;
  if (state.status === "done") return null; // already handled by checkSprintCompleted

  const pending = state.tasks.filter((t) => t.status !== "done" && t.status !== "blocked");
  if (pending.length > 0) return null;

  const totalBlocked = state.tasks.filter((t) => t.status === "blocked").length;
  const totalDone = state.tasks.filter((t) => t.status === "done").length;

  return {
    type: "all_tasks_exhausted",
    severity: "info",
    message: `All ${state.tasks.length} tasks are exhausted (${totalDone} done, ${totalBlocked} blocked).\n` +
      `1. Run \`agile_discover\` to scan the codebase for remaining issues\n` +
      `2. Review results against project constraints (scope, max tasks from .agile/project.yaml)\n` +
      `3. Create tasks for the next sprint via \`bd create\` with clear acceptance criteria\n` +
      `4. Call \`agile_start_sprint\` to initialize the next sprint, or end here`,
  };
}

function checkSprintStagnation(
  state: SprintState,
  obsState: SprintObserverState,
  config: ObserverConfig,
): ObserverSteer | null {
  for (const [bdId, count] of obsState.consecutiveReworks) {
    if (count >= config.reworkStuckThreshold) {
      const task = state.tasks.find((t) => t.bd_id === bdId);
      return {
        type: "stagnation",
        severity: "warning",
        message: `⚠️ Task ${bdId} (${task?.title ?? "?"}) is stuck in a rework loop (${count} rounds). Consider blocking it and moving on.`,
      };
    }
  }
  return null;
}

function checkAllBlocked(state: SprintState, _obsState: SprintObserverState): ObserverSteer | null {
  const pending = state.tasks.filter((t) => t.status !== "done" && t.status !== "blocked");
  const blocked = state.tasks.filter((t) => t.status === "blocked");
  if (pending.length === 0 && blocked.length > 0) {
    return {
      type: "all_blocked",
      severity: "critical",
      message: `🚫 All remaining tasks are blocked (${blocked.length} tasks). Sprint cannot continue. End sprint and run retrospective.`,
    };
  }
  return null;
}

function checkConstraintSpam(
  obsState: SprintObserverState,
  config: ObserverConfig,
): ObserverSteer | null {
  for (const [constraint, count] of obsState.constraintViolations) {
    if (count >= config.constraintSpamThreshold) {
      return {
        type: "constraint_spam",
        severity: "warning",
        message: `⚠️ Constraint "${constraint}" violated ${count} times. Workers may need clearer instructions or the constraint may be too strict.`,
      };
    }
  }
  return null;
}

function checkDiscoveryEmpty(state: SprintState): ObserverSteer | null {
  if (state.tasks.length === 0) {
    return {
      type: "discovery_empty",
      severity: "info",
      message: "No tasks in sprint. Discovery may have found no new issues, or all tasks are done. Consider ending sprint.",
    };
  }
  return null;
}

/**
 * Track a constraint violation when reviewer reports one.
 */
export function trackConstraintViolation(
  obsState: SprintObserverState,
  constraint: string,
): void {
  const current = obsState.constraintViolations.get(constraint) ?? 0;
  obsState.constraintViolations.set(constraint, current + 1);
}

/**
 * Track a task status transition.
 */
export function trackTaskTransition(
  obsState: SprintObserverState,
  bdId: string,
  newStatus: string,
): void {
  obsState.recentTaskStatuses.push(`${bdId}:${newStatus}`);
  if (obsState.recentTaskStatuses.length > 20) obsState.recentTaskStatuses.shift();

  if (newStatus === "rework") {
    const current = obsState.consecutiveReworks.get(bdId) ?? 0;
    obsState.consecutiveReworks.set(bdId, current + 1);
  } else if (newStatus === "done" || newStatus === "blocked") {
    obsState.consecutiveReworks.delete(bdId);
  }
}
