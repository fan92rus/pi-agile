// report-check.mjs — mechanical self-check of a report DRAFT before the final message.
// A worker/rework/merger runs it on its own draft; every printed line names the offending
// field, so the draft is fixed before the host's schema validation can kill the child
// (which would hand the work to the report-repair child). Exit 0 = clean.
//
// The schema file <journalDir>/report-schema.json is written by agile-loop.js at campaign
// start: { work: <WORK_SCHEMA>, merge: <MERGE_SCHEMA> } - the engine's inline schemas.
//
// Usage:
//   node report-check.mjs --schema <journalDir>/report-schema.json --kind work|rework|merge
//                         --draft <file> [--worktree <path>] [--branch <slug>]
//
// Checks: (1) the draft against the schema (required, type, enum, const, pattern,
// minItems/maxItems, items, additionalProperties); (2) work/rework only - the acceptance
// semantics of the engine's validateAccStructured (criterion-1 + criterion-2 present,
// non-blank command/evidence); (3) work/rework with --worktree - head equals the worktree
// HEAD, noStagedFiles agrees with `git status --short`, draft.worktree exists, and with
// --branch the draft.branch matches. kind=merge runs check (1) only.
// Exit codes: 0 clean, 1 problems found, 2 usage/input error.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const USAGE = "usage: node report-check.mjs --schema <report-schema.json> --kind work|rework|merge --draft <file> [--worktree <path>] [--branch <slug>]";
const SCHEMA_KEY = { work: "work", rework: "work", merge: "merge" }; // rework reports use the work schema

function show(v) {
  if (v === undefined) return "отсутствует";
  if (typeof v === "string") return "'" + v + "'";
  const s = JSON.stringify(v);
  return s.length > 80 ? s.slice(0, 80) + "..." : s;
}

function typeOk(type, v) {
  if (type === "integer") return typeof v === "number" && Number.isInteger(v);
  if (type === "number") return typeof v === "number";
  if (type === "object") return v !== null && typeof v === "object" && !Array.isArray(v);
  if (type === "array") return Array.isArray(v);
  return typeof v === type; // string | boolean
}

function childPath(at, key) { return at ? at + "." + key : key; }

// Mini JSON-Schema walk over the keywords the engine's report schemas use.
function walk(schema, v, at, out) {
  const label = at || "<root>";
  if (schema.const !== undefined && v !== schema.const) out.push(label + ": ожидалось " + JSON.stringify(schema.const) + ", получено " + show(v));
  if (Array.isArray(schema.enum) && !schema.enum.includes(v)) out.push(label + ": ожидалось одно из " + JSON.stringify(schema.enum) + ", получено " + show(v));
  if (schema.type && !typeOk(schema.type, v)) { out.push(label + ": ожидался тип " + schema.type + ", получено " + show(v)); return; }
  if (typeof schema.pattern === "string" && typeof v === "string" && !new RegExp(schema.pattern).test(v)) out.push(label + ": ожидалось значение по шаблону " + schema.pattern + ", получено " + show(v));
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) out.push(label + ": элементов не меньше " + schema.minItems + ", получено " + v.length);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) out.push(label + ": элементов не больше " + schema.maxItems + ", получено " + v.length);
    if (schema.items) v.forEach(function (x, i) { walk(schema.items, x, at + "[" + i + "]", out); });
    return;
  }
  if (v !== null && typeof v === "object") {
    const props = schema.properties || {};
    for (const k of schema.required || []) if (v[k] === undefined) out.push(childPath(at, k) + ": обязательное поле отсутствует");
    for (const k of Object.keys(props)) if (v[k] !== undefined) walk(props[k], v[k], childPath(at, k), out);
    if (schema.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in props)) out.push(childPath(at, k) + ": неизвестное поле");
  }
}

// Acceptance semantics mirrored from agile-loop.js validateAccStructured (work/rework).
function acceptanceSemantics(d, out) {
  if (Array.isArray(d.criteriaSatisfied)) {
    const ids = d.criteriaSatisfied.map(function (c) { return c && c.id; });
    if (ids.indexOf("criterion-1") === -1 || ids.indexOf("criterion-2") === -1) out.push("criteriaSatisfied: нужны criterion-1 и criterion-2, получено " + JSON.stringify(ids));
    d.criteriaSatisfied.forEach(function (c, i) {
      if (c && typeof c.evidence === "string" && c.evidence.trim() === "") out.push("criteriaSatisfied[" + i + "].evidence: пустое обоснование");
    });
  }
  if (Array.isArray(d.commandsRun)) {
    d.commandsRun.forEach(function (c, i) {
      if (c && typeof c.command === "string" && c.command.trim() === "") out.push("commandsRun[" + i + "].command: пустая команда");
    });
  }
}

function git(wt, args) {
  const r = spawnSync("git", ["-C", wt].concat(args), { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw new Error(String(r.error.message || r.error));
  if (r.status !== 0) throw new Error("git " + args.join(" ") + " failed: " + String(r.stderr || "").trim().slice(0, 200));
  return r.stdout;
}

// Worktree-bound checks: the claims in the draft against the real repository state.
function worktreeChecks(d, opts, out) {
  let head, dirty;
  try {
    head = git(opts.worktree, ["rev-parse", "HEAD"]).trim();
    dirty = git(opts.worktree, ["status", "--short"]).split("\n").filter(function (l) { return l.trim() !== ""; });
  } catch (e) {
    out.push("worktree: " + e.message);
    return;
  }
  if (typeof d.head === "string" && /^[0-9a-f]{40}$/.test(d.head) && d.head !== head) {
    out.push("head: ожидался HEAD worktree " + head + ", получено '" + d.head + "'");
  }
  if (typeof d.noStagedFiles === "boolean") {
    if (d.noStagedFiles === true && dirty.length) out.push("noStagedFiles: true, но в worktree незакоммиченные изменения (" + dirty.length + "): " + dirty.slice(0, 3).join("; "));
    if (d.noStagedFiles === false && !dirty.length) out.push("noStagedFiles: false, но worktree чист - поставь true");
    if (d.noStagedFiles === false && dirty.length) out.push("noStagedFiles: false - в worktree незакоммиченные изменения (" + dirty.length + "): закоммить или откати и поставь true");
  }
  if (typeof d.worktree === "string" && !fs.existsSync(d.worktree)) out.push("worktree: путь не существует: " + d.worktree);
  if (opts.branch !== undefined && d.branch !== opts.branch) out.push("branch: ожидалась ветка '" + opts.branch + "', получено " + show(d.branch));
}

// Pure core (exported for tests): returns the list of problem lines, [] when clean.
export function checkReport({ schema, kind, draft, worktree, branch }) {
  const out = [];
  walk(schema, draft, "", out);
  if (kind !== "merge" && draft !== null && typeof draft === "object" && !Array.isArray(draft)) {
    acceptanceSemantics(draft, out);
    if (worktree !== undefined) worktreeChecks(draft, { worktree: worktree, branch: branch }, out);
  }
  return out;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1];
    if (!k || !k.startsWith("--") || v === undefined || v.startsWith("--")) throw new Error(USAGE);
    o[k.slice(2)] = v;
  }
  return o;
}

export function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { process.stderr.write(e.message + "\n"); return 2; }
  if (!a.schema || !a.kind || !a.draft || !(a.kind in SCHEMA_KEY)) { process.stderr.write(USAGE + "\n"); return 2; }
  let schemaMap, draft;
  try {
    schemaMap = JSON.parse(fs.readFileSync(a.schema, "utf8"));
  } catch (e) {
    process.stderr.write("report-check: схема не читается (" + a.schema + "): " + e.message + "\n");
    return 2;
  }
  const schema = schemaMap && schemaMap[SCHEMA_KEY[a.kind]];
  if (!schema) { process.stderr.write("report-check: в схеме нет раздела '" + SCHEMA_KEY[a.kind] + "' (" + a.schema + ")\n"); return 2; }
  try {
    draft = JSON.parse(fs.readFileSync(a.draft, "utf8"));
  } catch (e) {
    process.stdout.write("draft: не JSON (" + e.message + ")\n");
    return 1;
  }
  const problems = checkReport({ schema: schema, kind: a.kind, draft: draft, worktree: a.worktree, branch: a.branch });
  if (problems.length === 0) { process.stdout.write("report-check: ok (kind=" + a.kind + ")\n"); return 0; }
  for (const p of problems) process.stdout.write(p + "\n");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
