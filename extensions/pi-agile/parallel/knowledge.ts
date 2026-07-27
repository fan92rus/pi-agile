/**
 * knowledge.ts — Persistent sprint memory (.agile/knowledge.jsonl)
 *
 * Stores lessons, dead-ends, patterns, completed tasks, and sprint summaries.
 * Extension handles file I/O; agent reads/writes content through tool output.
 *
 * No SimHash, no programmatic dedup — agent recognizes duplicates via context.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const KNOWLEDGE_FILE = ".agile/knowledge.jsonl";

export type KnowledgeType = "lesson" | "dead_end" | "pattern" | "task_done" | "sprint_summary";

export interface KnowledgeEntry {
  type: KnowledgeType;
  task_id?: string;
  sprint?: number;
  ts: string;
  [key: string]: unknown;
}

export class KnowledgeBase {
  private entries: KnowledgeEntry[] = [];

  load(workDir: string): void {
    const filePath = path.join(workDir, KNOWLEDGE_FILE);
    if (!fs.existsSync(filePath)) {
      this.entries = [];
      return;
    }
    this.entries = fs
      .readFileSync(filePath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as KnowledgeEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is KnowledgeEntry => e !== null);
  }

  save(workDir: string): void {
    const filePath = path.join(workDir, KNOWLEDGE_FILE);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const lines = this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(filePath, lines, "utf8");
  }

  append(entry: KnowledgeEntry): void {
    this.entries.push(entry);
  }

  /** Return all entries of a given type, newest first. */
  getByType(type: KnowledgeType): KnowledgeEntry[] {
    return this.entries
      .filter((e) => e.type === type)
      .reverse();
  }

  /** Format lessons for agent context injection. */
  formatLessons(): string {
    const lessons = this.getByType("lesson").slice(0, 20);
    if (lessons.length === 0) return "(none yet)";
    return lessons
      .map((l, i) => `${i + 1}. ${l.finding ?? "(no text)"} (sprint ${l.sprint ?? "?"})`)
      .join("\n");
  }

  /** Format dead-ends for worker prompt injection (do_not_retry). */
  formatDeadEnds(): string {
    const deadEnds = this.getByType("dead_end").slice(0, 15);
    if (deadEnds.length === 0) return "(none recorded)";
    return deadEnds
      .map((d, i) => `${i + 1}. ${d.do_not_retry ?? d.approach ?? "(no text)"}`)
      .join("\n");
  }

  /** Format codebase patterns for reviewer prompt injection. */
  formatPatterns(): string {
    const patterns = this.getByType("pattern").slice(0, 10);
    if (patterns.length === 0) return "(none recorded yet)";
    return patterns
      .map((p, i) => `${i + 1}. ${p.finding ?? "(no text)"}`)
      .join("\n");
  }

  /** Format completed tasks for sprint planning context. */
  formatDoneTasks(): string {
    const tasks = this.getByType("task_done").slice(0, 30);
    if (tasks.length === 0) return "(none yet)";
    return tasks
      .map((t) => `${t.task_id ?? "?"}: ${t.title ?? "(no title)"}`)
      .join("\n");
  }

  /** Format ALL knowledge into a single block for system prompt injection. */
  formatAll(): string {
    const parts: string[] = [];

    const lessons = this.formatLessons();
    if (lessons !== "(none yet)") parts.push("## Lessons from Previous Sprints\n" + lessons);

    const deadEnds = this.formatDeadEnds();
    if (deadEnds !== "(none recorded)") parts.push("## Known Dead-Ends (do NOT repeat)\n" + deadEnds);

    const patterns = this.formatPatterns();
    if (patterns !== "(none recorded yet)") parts.push("## Codebase Patterns\n" + patterns);

    const tasks = this.formatDoneTasks();
    if (tasks !== "(none yet)") parts.push("## Completed Tasks\n" + tasks);

    return parts.length > 0 ? parts.join("\n\n") : "";
  }
}
