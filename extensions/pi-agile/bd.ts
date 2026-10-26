/**
 * bd.ts — read-only helpers for the `bd` CLI (beads task manager).
 *
 * Only `show` and `list --parent` are ever issued from here: the launch station
 * never writes to bd. Closing leaves is the engine's and the driver's job.
 */

import { execFile } from "node:child_process";

/** Runs `bd <args>` in `cwd` and resolves with stdout. Injected in tests. */
export type BdRunner = (args: string[], cwd: string) => Promise<string>;

export interface BdDependency {
  id: string;
  dependency_type: string;
}

export interface BdIssue {
  id: string;
  title: string;
  description: string;
  status: string;
  dependencies: BdDependency[];
}

export const runBd: BdRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "bd",
      args,
      { cwd, timeout: 120000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || stdout || err.message).trim().slice(0, 300);
          reject(new Error(`bd ${args.join(" ")} failed: ${detail}`));
        } else {
          resolve(String(stdout));
        }
      },
    );
    // piped stdin, closed at once: bd must never wait for input
    child.stdin?.end();
  });

function parseJsonRows(output: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(output);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
}

function toIssue(raw: Record<string, unknown>): BdIssue {
  const deps = Array.isArray(raw.dependencies) ? raw.dependencies : [];
  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? ""),
    description: String(raw.description ?? ""),
    status: String(raw.status ?? ""),
    dependencies: deps
      .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
      .map((d) => ({ id: String(d.id ?? ""), dependency_type: String(d.dependency_type ?? "") })),
  };
}

/** Full issues (description, dependencies) for the given ids: ONE `bd show` call. */
export async function showIssues(run: BdRunner, ids: string[], cwd: string): Promise<BdIssue[]> {
  if (ids.length === 0) return [];
  const out = await run(["show", ...ids, "--json"], cwd);
  return parseJsonRows(out).map(toIssue);
}

/** Direct children ids of an issue (`bd list --parent <id> --all -n 0 --json`). */
export async function listChildIds(run: BdRunner, parentId: string, cwd: string): Promise<string[]> {
  const out = await run(["list", "--parent", parentId, "--all", "-n", "0", "--json"], cwd);
  return parseJsonRows(out).map((r) => String(r.id ?? "")).filter((id) => id !== "");
}

export interface EpicTree {
  epic: BdIssue;
  /** Children of the epic that have no children of their own (direct children only). */
  leaves: BdIssue[];
}

/**
 * Reads an epic and its leaves (children with no children of their own), read-only.
 * A missing epic is reported as `epic <id> not found`.
 */
export async function readEpic(run: BdRunner, epicId: string, cwd: string): Promise<EpicTree> {
  let epic: BdIssue | undefined;
  try {
    epic = (await showIssues(run, [epicId], cwd))[0];
  } catch (e) {
    throw new Error(`epic ${epicId} not found in bd (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!epic || epic.id !== epicId) throw new Error(`epic ${epicId} not found in bd`);

  const childIds = await listChildIds(run, epicId, cwd);
  const leafIds: string[] = [];
  for (const id of childIds) {
    if ((await listChildIds(run, id, cwd)).length === 0) leafIds.push(id);
  }
  const leaves = await showIssues(run, leafIds, cwd);
  return { epic, leaves };
}
