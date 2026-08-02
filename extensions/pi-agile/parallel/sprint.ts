/**
 * sprint.ts — Sprint lifecycle state machine
 *
 * Manages sprint state persistence (.agile/sprint-N.json) and lifecycle transitions.
 * Does NOT make decisions — extension tracks state, agent evaluates and decides.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type SprintStatus = "planning" | "active" | "retrospective" | "done";
export type TaskStatus = "backlog" | "in_progress" | "in_review" | "done" | "rework" | "blocked";
export type ReviewVerdict = "approved" | "rework" | "blocked";

export interface SprintTask {
  bd_id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  worker_run_id?: string;
  reviewer_run_id?: string;
  review_rounds: number;
  final_verdict?: ReviewVerdict;
  branch: string;
}

export interface SprintVelocity {
  attempted: number;
  done: number;
  rework: number;
  blocked: number;
  avg_review_rounds: number;
}

export interface SprintState {
  id: number;
  goal: string;
  status: SprintStatus;
  tasks: SprintTask[];
  started_at: string;
  completed_at?: string;
  velocity?: SprintVelocity;
  stop_criteria_met?: boolean;
  stop_reason?: string;
}

function sprintFilePath(workDir: string, sprintId: number): string {
  return path.join(workDir, ".agile", `sprint-${sprintId}.json`);
}

export class SprintStore {
  private current: SprintState | null = null;
  /** WorkDir of the in-memory sprint — getCurrent() refuses to reuse it across projects. */
  private currentWorkDir: string | null = null;

  load(workDir: string, sprintId: number): SprintState | null {
    const filePath = sprintFilePath(workDir, sprintId);
    if (!fs.existsSync(filePath)) return null;
    try {
      this.current = JSON.parse(fs.readFileSync(filePath, "utf8")) as SprintState;
      this.currentWorkDir = workDir;
      return this.current;
    } catch {
      return null;
    }
  }

  save(workDir: string, state: SprintState): void {
    const filePath = sprintFilePath(workDir, state.id);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
    this.current = state;
    this.currentWorkDir = workDir;
  }

  create(workDir: string, id: number, goal: string): SprintState {
    const state: SprintState = {
      id,
      goal,
      status: "planning",
      tasks: [],
      started_at: new Date().toISOString(),
    };
    this.save(workDir, state);
    return state;
  }

  addTask(state: SprintState, task: Omit<SprintTask, "branch" | "review_rounds">): void {
    state.tasks.push({
      ...task,
      review_rounds: 0,
      branch: `feat/${task.bd_id}`,
    });
  }

  getPendingTasks(state: SprintState): SprintTask[] {
    return state.tasks.filter((t) => t.status === "backlog" || t.status === "rework");
  }

  getInProgressTasks(state: SprintState): SprintTask[] {
    return state.tasks.filter((t) => t.status === "in_progress" || t.status === "in_review");
  }

  getIndependentPendingTasks(state: SprintState, maxWorkers: number): SprintTask[] {
    // Simple FIFO: return first N pending tasks.
    // Task dependency resolution is handled by bd CLI (worker handles dependencies).
    return this.getPendingTasks(state).slice(0, maxWorkers);
  }

  hasPendingTasks(state: SprintState): boolean {
    return this.getPendingTasks(state).length > 0;
  }

  markInProgress(state: SprintState, bdId: string, workerRunId: string): void {
    const task = state.tasks.find((t) => t.bd_id === bdId);
    if (task) {
      task.status = "in_progress";
      task.worker_run_id = workerRunId;
    }
  }

  markInReview(state: SprintState, bdId: string, reviewerRunId: string): void {
    const task = state.tasks.find((t) => t.bd_id === bdId);
    if (task) {
      task.status = "in_review";
      task.reviewer_run_id = reviewerRunId;
      task.review_rounds++;
    }
  }

  markDone(state: SprintState, bdId: string): void {
    const task = state.tasks.find((t) => t.bd_id === bdId);
    if (task) {
      task.status = "done";
      task.final_verdict = "approved";
    }
  }

  markRework(state: SprintState, bdId: string, reason?: string): void {
    const task = state.tasks.find((t) => t.bd_id === bdId);
    if (task) {
      task.status = "rework";
    }
  }

  markBlocked(state: SprintState, bdId: string, reason?: string): void {
    const task = state.tasks.find((t) => t.bd_id === bdId);
    if (task) {
      task.status = "blocked";
      task.final_verdict = "blocked";
    }
  }

  computeVelocity(state: SprintState): SprintVelocity {
    const done = state.tasks.filter((t) => t.status === "done").length;
    const rework = state.tasks.filter((t) => t.status === "rework").length;
    const blocked = state.tasks.filter((t) => t.status === "blocked").length;
    const reviews = state.tasks
      .filter((t) => t.review_rounds > 0)
      .map((t) => t.review_rounds);

    return {
      attempted: state.tasks.length,
      done,
      rework,
      blocked,
      avg_review_rounds: reviews.length > 0 ? reviews.reduce((a, b) => a + b, 0) / reviews.length : 0,
    };
  }

  completeSprint(
    state: SprintState,
    workDir: string,
    stopMet?: boolean,
    stopReason?: string,
  ): void {
    state.status = "done";
    state.completed_at = new Date().toISOString();
    state.velocity = this.computeVelocity(state);
    state.stop_criteria_met = stopMet;
    state.stop_reason = stopReason;
    this.save(workDir, state);
  }

  getCurrent(workDir?: string): SprintState | null {
    // If the in-memory sprint belongs to a different workDir, don't reuse it —
    // agent_end may fire in a session that switched cwd between projects, and
    // the stale sprint would either suppress the nudge (tasks from another
    // repo) or leak a foreign sprint into the current one.
    if (this.current && (!workDir || this.currentWorkDir === workDir)) {
      return this.current;
    }
    // Auto-restore from disk if workDir is provided
    if (workDir) {
      const lastId = this.findLastSprintId(workDir);
      if (lastId > 0) {
        return this.load(workDir, lastId);
      }
    }
    return null;
  }

  findLastSprintId(workDir: string): number {
    const agileDir = path.join(workDir, ".agile");
    if (!fs.existsSync(agileDir)) return 0;
    const files = fs.readdirSync(agileDir).filter((f) => f.startsWith("sprint-") && f.endsWith(".json"));
    if (files.length === 0) return 0;
    const ids = files.map((f) => parseInt(f.replace("sprint-", "").replace(".json", ""), 10));
    return Math.max(...ids);
  }
}
