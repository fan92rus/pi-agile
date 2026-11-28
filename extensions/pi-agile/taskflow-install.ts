/**
 * taskflow-install.ts — install packaged tf assets into the project workspace.
 *
 * On session start the extension copies the bundled campaign/mvp asset trees from
 * the installed pi-agile package into <project>/.pi/taskflows/tf. This keeps the
 * active agile-solve skill independent of a source checkout: it can always point
 * at a stable installed path, and a package update refreshes managed files.
 *
 * Installation is non-destructive: files that differ from the last installed
 * manifest are treated as user edits and preserved across later updates too.
 * Unrelated files in the managed directory are never removed.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const SOURCE_PARTS = ["docs", "plans", "taskflow-pilot"];
const TARGET_PARTS = [".pi", "taskflows", "tf"];
const ASSET_DIRS = ["campaign", "mvp"];
const STAMP = "INSTALL.json";

export interface InstallResult {
  installed: boolean;
  reason: "up-to-date" | "installed" | "source-missing";
  target: string;
  version: string;
  missing?: string[];
  conflicts?: string[];
}

interface ManagedStamp {
  version: string;
  installedAt: string;
  source: string;
  assets: string[];
  /** Last packaged source hash for every managed path. */
  files: Record<string, string>;
  /** Paths whose local version is preserved. */
  conflicts?: string[];
  /** Hash of each preserved local version; older stamps may lack this. */
  conflictHashes?: Record<string, string>;
}

function digest(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function relative(filePath: string, root: string): string {
  return path.relative(root, filePath).replaceAll("\\", "/");
}

function collectFiles(dir: string, root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full, root));
    else if (entry.isFile()) out.push(relative(full, root));
  }
  return out.sort();
}

function readStamp(file: string): ManagedStamp | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object") return undefined;
    return value as ManagedStamp;
  } catch {
    return undefined;
  }
}

/** Absolute root of the installed pi-agile package (extensions/pi-agile -> package root). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

/** Version recorded in the installed marker. Empty when package.json is absent. */
export function readVersion(sourceRoot: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
    return String(pkg?.version ?? "");
  } catch {
    return "";
  }
}

/**
 * Copy the packaged tf assets into the project workspace.
 * The managed directory is <project>/.pi/taskflows/tf; generated flows stay in
 * <project>/.pi/taskflows and are never touched by this installer.
 */
export function installTaskflowAssets(opts: {
  sourceRoot: string;
  projectRoot: string;
  version?: string;
}): InstallResult {
  const sourceBase = path.resolve(opts.sourceRoot, ...SOURCE_PARTS);
  const target = path.resolve(opts.projectRoot, ...TARGET_PARTS);
  const version = String(opts.version ?? "");
  const stampFile = path.join(target, STAMP);
  const missing = ASSET_DIRS.filter((dir) => !fs.existsSync(path.join(sourceBase, dir)));
  if (missing.length) {
    return { installed: false, reason: "source-missing", target, version, missing };
  }

  const previous = readStamp(stampFile);
  const previousFiles = previous?.files;
  const previousConflicts = Array.isArray(previous?.conflicts) ? previous.conflicts : [];
  const previousConflictHashes = previous?.conflictHashes && !Array.isArray(previous.conflictHashes)
    ? previous.conflictHashes
    : {};

  const sourceFiles: Array<{ rel: string; full: string; hash: string }> = [];
  for (const dir of ASSET_DIRS) {
    const root = path.join(sourceBase, dir);
    for (const rel of collectFiles(root, root)) {
      const full = path.join(root, rel);
      sourceFiles.push({ rel: `${dir}/${rel}`, full, hash: digest(fs.readFileSync(full)) });
    }
  }

  const matchesStamp = sourceFiles.every((entry) => {
    const destination = path.join(target, entry.rel);
    if (!fs.existsSync(destination)) return false;
    const current = digest(fs.readFileSync(destination));
    if (previousConflicts.includes(entry.rel)) {
      return previousConflictHashes[entry.rel] !== undefined
        ? current === previousConflictHashes[entry.rel]
        : false;
    }
    return previousFiles?.[entry.rel] === current;
  });
  if (previous?.version === version && matchesStamp) {
    return { installed: false, reason: "up-to-date", target, version };
  }

  fs.mkdirSync(target, { recursive: true });
  const files: Record<string, string> = {};
  const conflictHashes: Record<string, string> = {};
  for (const entry of sourceFiles) {
    const destination = path.join(target, entry.rel);
    const existing = fs.existsSync(destination) ? fs.readFileSync(destination) : undefined;
    const blocked = previousConflicts.includes(entry.rel) && existing !== undefined;
    const localEdit = !blocked && existing !== undefined && previousFiles?.[entry.rel] !== undefined
      && digest(existing) !== previousFiles[entry.rel];

    files[entry.rel] = entry.hash;
    if (blocked || localEdit) {
      conflictHashes[entry.rel] = digest(existing!);
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, fs.readFileSync(entry.full));
  }

  const conflicts = Object.keys(conflictHashes).sort();
  const stamp: ManagedStamp = {
    version,
    installedAt: new Date().toISOString(),
    source: "pi-agile",
    assets: ASSET_DIRS,
    files,
    ...(conflicts.length ? { conflicts, conflictHashes } : {}),
  };
  fs.writeFileSync(stampFile, `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
  return { installed: true, reason: "installed", target, version, ...(conflicts.length ? { conflicts } : {}) };
}
