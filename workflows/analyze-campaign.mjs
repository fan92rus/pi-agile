// analyze-campaign.mjs — campaign analyzer over a workflow run dir: reads events.jsonl
// (wall-clock timeline + per-child durations), workflow-children.jsonl (failure classes
// from settle errors AND from ok:true reports carrying a failing verdict) and status.json
// (the workflow snapshot steps[] as the token/role/duration fallback when sibling child
// dirs are gone), plus the agile sprint journals (--agile-journal) — and emits usage,
// failure classes, metrics.json (--out) and a markdown campaign retro (--retro).
//
// The campaign-analytics child in agile-loop.js runs this file at campaign end
// (default metricsScript); python collect_metrics.py in ledger-solve stays as the
// interchangeable alternative (the runner is chosen by script extension: node|python).
//
// Usage:
//   node analyze-campaign.mjs <workflow-run-dir> [--agile-journal <glob>]
//                             [--out metrics.json] [--retro retro-<runid>.md]
//
// Honesty rules (same as collect_metrics.py):
//   - parallel child durations are NEVER summed into a wall-clock number; the busy sum
//     is reported as sumDurationsMs (labeled), wall comes only from real event
//     timestamps and INCLUDES idle gaps;
//   - missing fields surface as null / "?" - never as zeros;
//   - retry/repair/rework launches are classified from child key shapes
//     ("~retryN", "-reworkN", "-report-repair", "-repair"), not guessed.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Ordered failure taxonomy: FIRST match wins (same classes/order as
// ledger-solve collect_metrics.py - the two analyzers must stay interchangeable).
const FAILURE_PATTERNS = [
  ["schema-missing", /schema-missing|required structured output|structured[_ ]output.{0,40}(missing|not produced)|failed to produce structured output|structured acceptance report (not found|missing)|failed to parse acceptance-report|invalid acceptance-report|required criterion.{0,40}not reported/i],
  ["merge-preflight", /merge-preflight|preflight|staged index|staged files|working copy dirty|claim-dirt|claim dirt/i],
  ["acceptance", /acceptance rejected|acceptance verification|tests-added evidence|acceptance-report/i],
  ["work-class", /work-incomplete|no-head-reported|merge refused|verdict failed|merge-failed|drop-failed|arbiter-failed/i],
  ["watchdog", /watchdog|timed?[ _-]?out|timeout|deadline|killed|budget.?exhausted|token.?budget|paused after interrupt/i],
  ["transport", /transport|econn(refused|reset|aborted)|etimedout|enotfound|socket hang up|bad gateway|service unavailable|gateway timeout|overloaded|rate.?limit|\b429\b|\b403\b|forbidden/i],
];

export function classifyFailure(text) {
  if (!text) return null;
  const t = String(text);
  for (const [name, rx] of FAILURE_PATTERNS) if (rx.test(t)) return name;
  return "other";
}

// Failing-verdict markers inside an OK child's report (completed:false / merged:false);
// approved:false (the rework loop itself) and dropped:true (a clean drop) are NOT failures.
const FAILING_REPORT_MARKERS = /"(?:completed|merged)"\s*:\s*false/;

export function failingReportText(rec) {
  const so = rec && rec.structuredOutput;
  if (so && typeof so === "object") {
    if (so.completed !== false && so.merged !== false) return null;
    const parts = [];
    for (const f of ["what_done", "note", "reason", "verification", "rework_reasons", "residualRisks"]) {
      const v = so[f];
      if (typeof v === "string" && v.trim()) parts.push(v.trim());
      else if (Array.isArray(v) && v.length) parts.push(v.map(String).join(" "));
    }
    return parts.length ? parts.join(" ") : "failing verdict without a reason text";
  }
  const out = rec && rec.output;
  if (typeof out === "string") {
    const m = FAILING_REPORT_MARKERS.exec(out);
    if (m) return out.slice(0, 800) + " ... " + out.slice(Math.max(0, m.index - 400), m.index + m[0].length + 400);
  }
  return null;
}

export function classifyKey(key) {
  const k = key || "";
  if (k.indexOf("~retry") !== -1) return ["retry", "retry"];
  if (k.indexOf("-report-repair") !== -1) return ["report-repair", "repair"];
  if (k.indexOf("-rework") !== -1) return ["rework", "rework"];
  if (k.indexOf("-repair") !== -1) return ["ledger-repair", "repair"];
  for (const stage of ["work", "review", "merge", "drop", "arbiter", "discovery", "curator", "retro", "sdd-setup"]) {
    if (k.endsWith("-" + stage) || k === stage) return [stage, "base"];
  }
  return ["other", "base"];
}

export function roleFromKey(key) {
  const k = key || "";
  if (/-review(-r\d+)?(~retry\d+)?$/.test(k)) return "reviewer";
  if (/-(merge|arbiter|drop|boundary|bd-close)(~retry\d+)?$/.test(k)) return "integrator";
  if (/-(curator|discovery|retro|sdd-setup|analytics)(~retry\d+)?$/.test(k)) return "curator";
  if (/-(work|rework\d*|repair|report-repair|cleanup)(~retry\d+)?$/.test(k)) return "worker";
  return "?";
}

const NUM = (v) => typeof v === "number" && Number.isFinite(v);

export function isoTs(ms) {
  if (!NUM(ms)) return null;
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ") + "Z";
}

export function parseEvents(eventsPath) {
  const children = {};
  const tl = { firstTs: null, lastTs: null, runId: null, childStarts: {}, childSettles: {} };
  let lines;
  try {
    lines = fs.readFileSync(eventsPath, "utf8");
  } catch {
    return [children, tl];
  }
  for (const line of lines.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!d || typeof d !== "object" || Array.isArray(d)) continue;
    const ts = NUM(d.ts) ? d.ts : null;
    if (ts !== null) {
      tl.firstTs = tl.firstTs === null ? ts : Math.min(tl.firstTs, ts);
      tl.lastTs = tl.lastTs === null ? ts : Math.max(tl.lastTs, ts);
    }
    const etype = d.type;
    if (etype === "subagent.workflow.started" && !tl.runId) {
      tl.runId = d.runId;
    } else if (etype === "subagent.child-status") {
      const crid = d.childRunId || d.childId;
      if (crid && d.status === "started") {
        tl.childStarts[crid] = { ts, agent: d.agent, key: d.workflowKey || d.childId };
      }
    } else if (etype === "subagent.workflow.child_settled") {
      const crid = d.childRunId;
      if (crid) tl.childSettles[crid] = { ts: NUM(d.ts) ? d.ts : null, outcome: d.outcome };
    } else if (etype === "subagent.workflow.trace") {
      for (const step of d.trace || []) {
        if (step && step.operation === "run" && step.runId) {
          const c = children[step.runId] || (children[step.runId] = {});
          c.key = step.key;
          c.state = step.state;
          c.durationMs = step.durationMs;
          if (step.agent) c.agent = step.agent;
        }
      }
    }
  }
  return [children, tl];
}

export function parseChildrenLog(wf) {
  const p = path.join(wf, "workflow-children.jsonl");
  const out = {};
  let text;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!d || typeof d !== "object" || d.type !== "settle") continue;
    let r = d.result;
    if (!r || typeof r !== "object" || Array.isArray(r)) r = {};
    const rid = r.runId || d.runId || r.key;
    if (!rid) continue;
    const rec = out[rid] || (out[rid] = {});
    rec.ok = r.ok;
    rec.error = r.error;
    rec.agent = r.agent;
    rec.key = r.key || d.key;
    if (typeof r.output === "string") rec.output = r.output.slice(0, 2400);
    if (r.structuredOutput && typeof r.structuredOutput === "object" && !Array.isArray(r.structuredOutput)) {
      rec.structuredOutput = r.structuredOutput;
    }
  }
  return out;
}

export function parseWorkflowSteps(wf) {
  const p = path.join(wf, "status.json");
  let st;
  try {
    st = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
  const steps = st && st.steps;
  if (!Array.isArray(steps)) return null;
  const per = {};
  for (const s of steps) {
    if (!s || typeof s !== "object" || Array.isArray(s)) continue;
    const rid = s.runId;
    if (!rid) continue;
    const tok = s.tokens;
    per[rid] = {
      tokens: tok && typeof tok === "object" && !Array.isArray(tok) ? tok.total : undefined,
      durationMs: s.durationMs,
      // real pi-subagents steps[] carry startedAt (epoch ms); aggregate() reads it as the
      // per-child wall start when events.jsonl has no child-status 'started' event
      // (collect_metrics.py parity: `step.get("startedAt")`).
      startedAt: s.startedAt,
      agent: s.agent,
      state: s.status,
      key: s.workflowKey || s.label,
    };
  }
  return Object.keys(per).length ? per : null;
}

// Journal verdicts that are NOT failures; everything else is a failing verdict whose
// note gets classified - the sprint journal is the ONLY durable evidence for verdict-only
// leaves and for report rejections thrown inside the runChild success branch.
const JOURNAL_SUCCESS_VERDICTS = new Set(["merged", "merged-after-arbitration", "verified", "dropped"]);

// Minimal glob: literal dirname + basename with * / ? magic (covers the documented
// '<repo>/.agile-js/sprint-*.jsonl' shape; wildcards in the dirname are not supported).
export function globFiles(pattern) {
  if (!pattern) return [];
  if (!/[*?]/.test(pattern)) return fs.existsSync(pattern) ? [pattern] : [];
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  if (/[*?]/.test(dir)) return [];
  const rx = new RegExp("^" + base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((e) => rx.test(e)).map((e) => path.join(dir, e)).sort();
}

export function parseAgileJournal(pattern) {
  const entries = [];
  const verdicts = {};
  const failureClasses = {};
  const examples = {};
  let failures = 0;
  const files = globFiles(pattern);
  for (const p of files) {
    let text;
    try {
      text = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (!d || typeof d !== "object" || Array.isArray(d) || !("verdict" in d)) continue;
      entries.push({ file: path.basename(p), task: d.task, verdict: d.verdict, branch: d.branch, head: d.head, note: d.note });
      const vd = String(d.verdict || "");
      verdicts[d.verdict] = (verdicts[d.verdict] || 0) + 1;
      if (vd && !JOURNAL_SUCCESS_VERDICTS.has(vd)) {
        failures += 1;
        const note = typeof d.note === "string" ? d.note : "";
        const cls = classifyFailure("verdict " + vd + ": " + note) || "other";
        failureClasses[cls] = (failureClasses[cls] || 0) + 1;
        if (!(cls in examples)) {
          examples[cls] = ((d.task || "?") + ": " + note).replace(/\s+/g, " ").slice(0, 160);
        }
      }
    }
  }
  return { entries, verdicts, files: files.length, failures, failureClasses, examples };
}

export function aggregate(parent, children, timeline, childrenLog, wfSteps) {
  const ids = new Set([
    ...Object.keys(children),
    ...Object.keys(timeline.childStarts),
    ...Object.keys(childrenLog),
    ...Object.keys(wfSteps || {}),
  ]);
  const keyOf = (rid) =>
    ((children[rid] || childrenLog[rid] || (wfSteps || {})[rid] || {}).key) || "";
  const runIds = [...ids].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : a < b ? -1 : a > b ? 1 : 0));
  const rows = [];
  let totalTokens = null;
  let tokensKnown = 0;
  const stages = {};
  const kinds = {};
  const failureClasses = {};
  let retries = 0, repairs = 0, reworks = 0, salvage = 0, failures = 0;
  for (const runId of runIds) {
    const c = children[runId] || {};
    const log = childrenLog[runId] || {};
    const step = (wfSteps || {})[runId] || {};
    const start = timeline.childStarts[runId] || {};
    const settle = timeline.childSettles[runId] || {};
    const key = c.key || log.key || step.key || start.key;
    let tokens;
    // live dir: sibling <parent>/<runId>/status.json
    const stPath = path.join(parent, runId, "status.json");
    let st = null;
    try {
      st = JSON.parse(fs.readFileSync(stPath, "utf8"));
    } catch {
      st = null;
    }
    if (st && typeof st === "object") {
      tokens = st.totalTokens;
      if (st.state !== undefined) c.state = st.state;
      if (st.model) c.model = st.model;
    }
    if (tokens && typeof tokens === "object" && !Array.isArray(tokens)) tokens = tokens.total;
    // snapshot fallback: workflow status.json steps[]
    if (tokens === undefined && step.tokens !== undefined) tokens = step.tokens;
    if (NUM(tokens)) {
      totalTokens = (totalTokens || 0) + tokens;
      tokensKnown += 1;
    }
    let durationMs = c.durationMs;
    if (durationMs === undefined && step.durationMs !== undefined) durationMs = step.durationMs;
    let startTs = start.ts;
    if (startTs === undefined) startTs = step.startedAt;
    const endTs = settle.ts;
    const wallMs = NUM(startTs) && NUM(endTs) ? Math.max(0, Math.trunc(endTs - startTs)) : null;
    const state = settle.outcome || step.state || c.state;
    const agent = start.agent || log.agent || step.agent || c.agent;
    const [stage, kind] = classifyKey(key);
    let failMsg = log.error;
    let fclass = log.ok === false ? classifyFailure(failMsg) : null;
    if (log.ok === false && !fclass) fclass = "other";
    let verdictFailed = false;
    if (!fclass && log.ok === true) {
      // ok:true child whose REPORT carries the failing verdict (completed:false /
      // merged:false): the settle error channel never saw it (report rejections throw
      // inside the runChild success branch).
      const reason = failingReportText(log);
      if (reason !== null) {
        verdictFailed = true;
        failMsg = reason;
        fclass = classifyFailure(reason) || "other";
      }
    }
    let outcome = state;
    if (fclass) {
      outcome = verdictFailed
        ? (state || "settled") + " (verdict failed: " + fclass + ")"
        : (state || "failed") + " (" + fclass + ")";
    }
    if (fclass) {
      failures += 1;
      failureClasses[fclass] = (failureClasses[fclass] || 0) + 1;
    }
    stages[stage] = (stages[stage] || 0) + 1;
    kinds[kind] = (kinds[kind] || 0) + 1;
    if (kind === "retry") retries += 1;
    else if (kind === "repair") repairs += 1;
    else if (kind === "rework") reworks += 1;
    if (stage === "report-repair") salvage += 1;
    rows.push({
      key: key, runId, state,
      stage, kind,
      role: agent || roleFromKey(key),
      model: c.model || step.model || null,
      durationMs, wallMs, totalTokens: tokens,
      outcome, failureClass: fclass,
      failMsg: failMsg ? String(failMsg).replace(/\s+/g, " ").slice(0, 160) : null,
    });
  }
  let sumDurationsMs = null;
  const durations = rows.map((r) => r.durationMs).filter(NUM);
  if (durations.length) sumDurationsMs = durations.reduce((a, b) => a + b, 0); // BUSY sum - NOT wall time
  const wallMs = timeline.firstTs !== null && timeline.lastTs !== null
    ? Math.max(0, Math.trunc(timeline.lastTs - timeline.firstTs))
    : null;
  const summary = {
    runId: timeline.runId,
    children: rows.length,
    totalTokens,             // null when no token source had tokens
    tokensKnown,
    sumDurationsMs,          // busy sum, NOT wall time
    wallMs,                  // first -> last event ts; includes idle gaps
    wallStart: isoTs(timeline.firstTs),
    wallEnd: isoTs(timeline.lastTs),
    retries, repairs, reworks, salvage,
    stages, kinds,
    failures, failureClasses,
  };
  return [rows, summary];
}

export function fmtDur(ms) {
  if (!NUM(ms)) return "?";
  const s = ms / 1000;
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const rem = Math.floor(s) - h * 3600;
    const m = Math.floor(rem / 60);
    const sec = rem - m * 60;
    return h + "h" + String(m).padStart(2, "0") + "m" + String(sec).padStart(2, "0") + "s";
  }
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s) - m * 60;
    return m + "m" + String(sec).padStart(2, "0") + "s";
  }
  return s < 10 ? s.toFixed(1) + "s" : Math.floor(s) + "s";
}

const _fmt = (v) => (v === null || v === undefined ? "?" : String(v));

export function renderRetro(runId, rows, summary, agile) {
  const md = [];
  md.push("# Campaign retro - " + (runId || "?"));
  md.push("");
  if (summary.wallMs !== null && summary.wallMs !== undefined) {
    md.push("- wall: " + summary.wallStart + " -> " + summary.wallEnd +
      " (wallMs: " + summary.wallMs + ", " + fmtDur(summary.wallMs) + "; includes idle gaps - NOT the busy sum)");
  } else {
    md.push("- wall: unknown (no timestamped events in events.jsonl)");
  }
  md.push("- children: " + summary.children + " (failed: " + (summary.failures || 0) + ")" +
    " | tokens: " + _fmt(summary.totalTokens) + " (known for " + (summary.tokensKnown || 0) + ")");
  md.push("- launches: retries=" + (summary.retries || 0) + " repairs=" + (summary.repairs || 0) +
    " reworks=" + (summary.reworks || 0) + " salvage=" + (summary.salvage || 0));
  const fc = summary.failureClasses || {};
  md.push("- failure classes: " + (Object.keys(fc).length
    ? Object.keys(fc).sort().map((k) => k + "=" + fc[k]).join(", ")
    : "none observed"));
  if (agile) {
    let jl = "- agile journal: files=" + (agile.files || 0) + ", verdicts=" + JSON.stringify(agile.verdicts || {});
    if (agile.failures) {
      jl += ", journal failures=" + agile.failures + " (" + Object.keys(agile.failureClasses || {})
        .sort().map((k) => k + "=" + agile.failureClasses[k]).join(", ") + ")";
    }
    md.push(jl);
  }
  md.push("");
  md.push("## Children");
  md.push("");
  md.push("| child | role | model | duration | wall | tokens | outcome |");
  md.push("|---|---|---|---|---|---|---|");
  for (const r of rows) {
    md.push("| " + (r.key || "?") + " | " + (r.role || "?") + " | " + (r.model || "?") +
      " | " + fmtDur(r.durationMs) + " | " + fmtDur(r.wallMs) +
      " | " + _fmt(r.totalTokens) + " | " + (r.outcome || "?") + " |");
  }
  md.push("");
  const roles = {};
  for (const r of rows) {
    const role = r.role || "?";
    const a = roles[role] || (roles[role] = { n: 0, tokens: 0, tokensKnown: false, busy: 0, busyKnown: false });
    a.n += 1;
    if (NUM(r.totalTokens)) {
      a.tokens += r.totalTokens;
      a.tokensKnown = true;
    }
    if (NUM(r.durationMs)) {
      a.busy += r.durationMs;
      a.busyKnown = true;
    }
  }
  md.push("## Role summaries");
  md.push("");
  md.push("| role | launches | tokens | busy duration |");
  md.push("|---|---|---|---|");
  for (const role of Object.keys(roles).sort()) {
    const a = roles[role];
    md.push("| " + role + " | " + a.n + " | " + (a.tokensKnown ? String(a.tokens) : "?") +
      " | " + (a.busyKnown ? fmtDur(a.busy) : "?") + " |");
  }
  md.push("");
  md.push("## Top consumers");
  md.push("");
  const byTok = rows.filter((r) => NUM(r.totalTokens)).sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 5);
  const byDur = rows.filter((r) => NUM(r.durationMs)).sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
  if (byTok.length) {
    md.push("By tokens:");
    md.push("");
    for (const r of byTok) md.push("1. " + (r.key || r.runId) + " - " + r.totalTokens + " tok (" + (r.role || "?") + ")");
  }
  if (byDur.length) {
    if (byTok.length) md.push("");
    md.push("By busy duration:");
    md.push("");
    for (const r of byDur) md.push("1. " + (r.key || r.runId) + " - " + fmtDur(r.durationMs) + " (" + (r.role || "?") + ")");
  }
  if (!byTok.length && !byDur.length) md.push("(no token/duration data reported)");
  md.push("");
  md.push("## Failure classes");
  md.push("");
  if (Object.keys(fc).length) {
    md.push("| class | count | example |");
    md.push("|---|---|---|");
    const examples = {};
    for (const r of rows) {
      if (r.failureClass && !(r.failureClass in examples)) examples[r.failureClass] = r.failMsg || "";
    }
    for (const k of Object.keys(fc).sort()) {
      md.push("| " + k + " | " + fc[k] + " | " + (examples[k] || "") + " |");
    }
  } else {
    md.push("none observed");
  }
  md.push("");
  const jfc = agile ? agile.failureClasses : null;
  if (jfc && Object.keys(jfc).length) {
    md.push("## Failure classes - agile journal (verdict/note text)");
    md.push("");
    md.push("| class | count | example |");
    md.push("|---|---|---|");
    const ex = (agile && agile.examples) || {};
    for (const k of Object.keys(jfc).sort()) {
      md.push("| " + k + " | " + jfc[k] + " | " + (ex[k] || "") + " |");
    }
    md.push("");
  }
  return md.join("\n");
}

// Full analysis of one workflow run dir -> { rows, summary, agile }.
export function analyzeCampaign(wf, opts) {
  opts = opts || {};
  const [children, timeline] = parseEvents(path.join(wf, "events.jsonl"));
  const childrenLog = parseChildrenLog(wf);
  const wfSteps = parseWorkflowSteps(wf);
  const [rows, summary] = aggregate(path.dirname(path.resolve(wf)), children, timeline, childrenLog, wfSteps);
  const agile = opts.agileJournal ? parseAgileJournal(opts.agileJournal) : null;
  return { rows, summary, agile };
}

function writeIf(outPath, content) {
  if (!outPath) return;
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, content);
}

// CLI entry: <workflow-dir> [--agile-journal <glob>] [--out metrics.json] [--retro retro.md]
export function main(argv) {
  const args = argv || process.argv.slice(2);
  let wf = null;
  let agileJournal = null, out = null, retro = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--agile-journal") agileJournal = args[++i];
    else if (a === "--out") out = args[++i];
    else if (a === "--retro") retro = args[++i];
    else if (a === "--help" || a === "-h") {
      console.log("usage: node analyze-campaign.mjs <workflow-run-dir> [--agile-journal <glob>] [--out metrics.json] [--retro retro.md]");
      return 0;
    } else if (!wf && !a.startsWith("--")) wf = a;
  }
  if (!wf) {
    console.error("usage: node analyze-campaign.mjs <workflow-run-dir> [--agile-journal <glob>] [--out metrics.json] [--retro retro.md]");
    return 2;
  }
  wf = path.resolve(wf);
  if (!fs.existsSync(path.join(wf, "events.jsonl"))) {
    console.log("no events.jsonl in", wf);
    return 1;
  }
  const { rows, summary, agile } = analyzeCampaign(wf, { agileJournal });

  console.log("| child | stage | kind | state | duration | tokens |");
  console.log("|---|---|---|---|---|---|");
  for (const r of rows) {
    const dur = NUM(r.durationMs) ? Math.floor(r.durationMs / 1000) + "s" : "?";
    const tok = r.totalTokens;
    console.log("| " + r.key + " | " + r.stage + " | " + r.kind + " | " + r.state + " | " + dur + " | " + (tok === null || tok === undefined ? "?" : tok) + " |");
  }
  console.log("");
  console.log("children: " + summary.children + ", total tokens: " + _fmt(summary.totalTokens) + " (known for " + summary.tokensKnown + ")");
  console.log("launches: retries=" + summary.retries + " repairs=" + summary.repairs + " reworks=" + summary.reworks + " salvage=" + summary.salvage);
  console.log("stages: " + JSON.stringify(summary.stages));
  if (summary.sumDurationsMs !== null) {
    console.log("sumDurationsMs: " + summary.sumDurationsMs + " (busy sum across possibly parallel children - NOT wall time)");
  }
  if (summary.wallMs !== null) {
    console.log("wallMs: " + summary.wallMs + " (" + summary.wallStart + " -> " + summary.wallEnd +
      "; first->last event in events.jsonl, includes idle gaps - NOT the busy sum)");
  } else {
    console.log("wallMs: unknown (events.jsonl has no timestamps)");
  }
  if (Object.keys(summary.failureClasses).length) {
    console.log("failure classes: " + JSON.stringify(summary.failureClasses) + " (failed children: " + summary.failures + ")");
  }
  if (summary.runId) console.log("campaign runId: " + summary.runId);
  if (agile) {
    let jl = "agile journal: files=" + agile.files + ", verdicts=" + JSON.stringify(agile.verdicts);
    if (agile.failures) jl += ", journal failures=" + agile.failures + " " + JSON.stringify(agile.failureClasses);
    console.log(jl);
  }

  if (out) {
    const payload = { workflowDir: wf, summary, children: rows };
    if (agile) payload.agileJournal = agile;
    writeIf(out, JSON.stringify(payload, null, 2));
    console.log("written:", out);
  }
  if (retro) {
    const md = renderRetro(summary.runId || path.basename(wf), rows, summary, agile);
    writeIf(retro, md);
    console.log("written:", retro);
  }
  return 0;
}

// Run as CLI when invoked directly (import keeps the module side-effect free).
const invoked = process.argv[1];
if (invoked && (import.meta.url === pathToFileURL(invoked).href ||
                import.meta.url === pathToFileURL(path.resolve(invoked)).href)) {
  process.exitCode = main(process.argv.slice(2));
}
