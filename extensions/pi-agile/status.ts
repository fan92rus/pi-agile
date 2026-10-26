/**
 * status.ts — agile_status: read-only progress of a launched campaign. Writes nothing.
 *
 * Run dir: <tmp>/pi-subagents-<session>/async-subagent-runs/<runId>/ holds status.json (state,
 * workflow return value), workflow-receipt.json (children), events.jsonl (child_settled),
 * mission.json (missionDir). The campaign checkpoint is <missionDir>/state.json key "agile-cp".
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface StatusParams {
  runId?: string;
  cwd?: string;
}

export interface StatusOptions {
  /** Temp root holding the pi-subagents-* dirs (default: os.tmpdir()). */
  tmpDir?: string;
}

interface RunDir {
  runId: string;
  dir: string;
  mtimeMs: number;
}

const RECENT_CHILDREN = 5;
const WORKFLOW_FIELDS = ["status", "done", "stopReason", "counts", "sprints", "used"];
const CHECKPOINT_FIELDS = ["phase", "sprintDone", "used", "repairUsed", "result", "wait", "coolingDown"];

type Obj = Record<string, unknown>;

function asObject(v: unknown): Obj | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
}

/** A missing or unreadable artifact is simply absent from the report (run still in progress). */
function readJson(file: string): Obj | undefined {
  try {
    return asObject(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

function pick(obj: Obj | undefined, keys: string[]): Obj | null {
  if (!obj) return null;
  const out: Obj = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

function runRoots(tmpDir: string): string[] {
  try {
    return fs.readdirSync(tmpDir)
      .filter((n) => n.startsWith("pi-subagents-"))
      .map((n) => path.join(tmpDir, n, "async-subagent-runs"));
  } catch {
    return [];
  }
}

/** All run dirs across the pi-subagents roots, newest first by mtime. */
function listRunDirs(tmpDir: string): RunDir[] {
  const out: RunDir[] = [];
  for (const root of runRoots(tmpDir)) {
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = path.join(root, name);
      try {
        const st = fs.statSync(dir);
        if (st.isDirectory()) out.push({ runId: name, dir, mtimeMs: st.mtimeMs });
      } catch {
        // vanished between readdir and stat: not a run any more
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function sameCwd(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function recentChildSettled(file: string): Obj[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows: Obj[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("child_settled")) continue;
    try {
      const e = asObject(JSON.parse(line));
      if (e && e.type === "subagent.workflow.child_settled") {
        rows.push({ childKey: e.childKey, outcome: e.outcome, ts: e.ts });
      }
    } catch {
      // partial last line of a live run: skip it
    }
  }
  return rows.slice(-RECENT_CHILDREN);
}

function buildReport(run: RunDir): Obj {
  const status = readJson(path.join(run.dir, "status.json"));
  const receipt = readJson(path.join(run.dir, "workflow-receipt.json"));
  const mission = readJson(path.join(run.dir, "mission.json"));
  const missionDir = mission && typeof mission.missionDir === "string" ? mission.missionDir : "";
  const checkpoint = missionDir ? asObject(readJson(path.join(missionDir, "state.json"))?.["agile-cp"]) : undefined;
  const wfValue = asObject(asObject(status?.workflow)?.value);
  const children = asObject(receipt?.workflowChildren)?.children;
  return {
    runId: run.runId,
    dir: run.dir,
    state: status?.state ?? null,
    cwd: status?.cwd ?? null,
    startedAt: status?.startedAt ?? null,
    lastUpdate: status?.lastUpdate ?? null,
    workflow: pick(wfValue, WORKFLOW_FIELDS),
    receipt: receipt ? { state: receipt.state ?? null, children: Array.isArray(children) ? children.length : 0 } : null,
    checkpoint: pick(checkpoint, CHECKPOINT_FIELDS),
    recentChildren: recentChildSettled(path.join(run.dir, "events.jsonl")),
  };
}

/**
 * Progress report (JSON text) of a run: the one named by runId, else the freshest run
 * (optionally only runs whose status.json cwd matches `cwd`). Never throws on missing data.
 */
export function statusReport(params: StatusParams, opts: StatusOptions = {}): string {
  const tmpDir = opts.tmpDir ?? os.tmpdir();
  const where = path.join(tmpDir, "pi-subagents-*", "async-subagent-runs");
  const runs = listRunDirs(tmpDir);

  let target: RunDir | undefined;
  if (params.runId) {
    target = runs.find((r) => r.runId === params.runId);
    if (!target) return `run ${params.runId} not found under ${where}`;
  } else {
    for (const r of runs) {
      if (!params.cwd) {
        target = r;
        break;
      }
      const st = readJson(path.join(r.dir, "status.json"));
      if (st && typeof st.cwd === "string" && sameCwd(st.cwd, params.cwd)) {
        target = r;
        break;
      }
    }
    if (!target) return `no runs found under ${where}${params.cwd ? ` for cwd ${params.cwd}` : ""}`;
  }
  return JSON.stringify(buildReport(target), null, 2);
}
