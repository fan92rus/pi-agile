/**
 * Fake pi API harness — lets tests drive the REAL extension
 * (extensions/pi-agile/index.ts) without a running pi instance.
 *
 * Usage:
 *   const { pi, tool, command, hook } = createFakePi({ bdTasks });
 *   piAgileExtension(pi);                 // real extension registers on fake pi
 *   await tool("agile_retrospective").execute("t1", {}, null, null, ctx);
 *   await hook("agent_end")({ messages: [] }, ctx);
 *   await command("agile").handler("run 3", ctx);
 *
 * The fake captures tools/commands/hooks, records sendUserMessage/notify calls,
 * routes exec() through a canned-output table (git/bd), and provides a fake
 * subagent RPC bridge that writes worker/reviewer output files on spawn.
 *
 * Batch support: `git worktree add -b feat/X <wtDir>` auto-registers the
 * worktree dir; git answers in that cwd are branch-aware (branch --list shows
 * feat/X, checkout of an existing branch uses plain `checkout`), so the real
 * gitCreateBranch/gitMergeFromWorktree paths execute their real branches.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export const RPC_REQUEST = "subagents:rpc:v1:request";
export const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";

// ──────────────────────────────────────────────────────────────────────
// Mini EventBus (matches the EventBus surface rpc.ts relies on)
// ──────────────────────────────────────────────────────────────────────

export function createEventBus() {
  const listeners = new Map();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
    emit(event, data) {
      for (const h of [...(listeners.get(event) ?? [])]) h(data);
    },
    count(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Canned bd / git outputs
// ──────────────────────────────────────────────────────────────────────

function bdShowLine(bdId, title, ac) {
  return `○ ${bdId} · ${title}   [● P2 · OPEN]\n\nDESCRIPTION\nTask ${bdId} description.\n\nACCEPTANCE CRITERIA\n${ac ?? "None"}`;
}

// ──────────────────────────────────────────────────────────────────────
// Fake subagent RPC bridge
// ──────────────────────────────────────────────────────────────────────

export function reviewerVerdictText(status, extra = {}) {
  return (
    `## Verdict: ${status.toUpperCase()}\n\n` +
    "```json\n" +
    JSON.stringify({ action_items: [], lessons: [], do_not_retry: undefined, ...extra }) +
    "\n```\n"
  );
}

/**
 * verdictFor: (bdId, round) => "approved" | "blocked" | "rework" — called per
 *   reviewer spawn; bdId/round are parsed from the output file path so batch
 *   runs can give each task its own verdict.
 * workerSummary: text written to the worker's output file.
 * writeOutput: false = dead-bridge mode (spawn ok, NO output file ever) — lets
 *   pollWithProgress exercise its RPC-bridge-dead guard instead of the file.
 * statusImpl: (runId) => { state, lastActivityAt } — override status response;
 *   throw to simulate a dead bridge after spawn.
 * commitWorkerChange: when true, the fake worker also commits a real change in
 *   its cwd (so the REAL-git integration path produces a non-empty diff).
 */
export function createFakeBridge({
  verdictFor = () => "blocked",
  verdictExtra,
  workerSummary = "Worker implemented the change.\n",
  writeOutput = true,
  statusImpl,
  bridgeState = {}, // { dead: false, stuck: false } — mutate to simulate failures
  commitWorkerChange = false,
} = {}) {
  const spawnLog = [];
  const bridge = (events) => (req) => {
    const replyEvent = `${RPC_REPLY_PREFIX}${req.requestId}`;
    const ok = (data) => events.emit(replyEvent, { version: 1, requestId: req.requestId, success: true, data });
    if (req.method === "ping") return ok({});
    if (req.method === "spawn") {
      const runId = `run-${String(req.requestId).slice(0, 8)}`;
      const params = req.params ?? {};
      const outFile = params.output;
      const base = outFile ? path.basename(outFile) : "";
      // worker-<bdId>.txt (single delegate) AND worker-<bdId>-r<N>.txt (batch rounds)
      const isRealWorker = /^worker-[\w.-]+\.txt$/.test(base);
      if (outFile && writeOutput && !bridgeState.dead && !bridgeState.stuck) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        const roleMatch = base.match(/^(worker|review)-([\w.-]+?)(?:-r(\d+))?\.txt$/);
        const bdId = roleMatch ? roleMatch[2] : "scout";
        const round = roleMatch && roleMatch[3] ? parseInt(roleMatch[3], 10) : 1;
        let content;
        if (/scout|detective/.test(base)) {
          content = [
            "SCOUT REPORT",
            "Scanned the codebase for issues relevant to the goal.",
            "- src/parser.ts:32 — potential null dereference",
            "- src/api.ts:88 — unhandled promise rejection",
            "Recommend creating tasks for both findings.",
          ].join("\n");
        } else if (params.agent === "reviewer") {
          content = reviewerVerdictText(verdictFor(bdId, round), verdictExtra ? verdictExtra(bdId, round) : {});
        } else {
          content = workerSummary;
        }
        fs.writeFileSync(outFile, content, "utf8");
      }
      spawnLog.push({ agent: params.agent, task: params.task, output: outFile, runId });
      if (commitWorkerChange && isRealWorker && !bridgeState.dead && !bridgeState.stuck && params.cwd) {
        // Fake worker commits a real change so the real-git diff is non-empty.
        try {
          fs.writeFileSync(path.join(params.cwd, `change-${runId}.txt`), `work by ${runId}\n`);
          execFileSync("git", ["add", "-A"], { cwd: params.cwd });
          execFileSync("git", ["commit", "-m", `feat: ${runId}`], { cwd: params.cwd });
        } catch { /* non-git cwd — ignore */ }
      }
      return ok({ details: { runId, asyncDir: outFile ? path.dirname(outFile) : os.tmpdir() } });
    }
    if (req.method === "status") {
      if (bridgeState.dead) throw new Error("RPC bridge unreachable (fake dead bridge)");
      if (bridgeState.stuck) {
        return ok({ state: "running", lastActivityAt: Date.now() - 3_600_000 });
      }
      if (statusImpl) return ok(statusImpl(req.runId));
      return ok({ state: "completed", lastActivityAt: Date.now() });
    }
    if (req.method === "interrupt" || req.method === "stop") {
      // After an interrupt in stuck mode the run goes terminal.
      if (bridgeState.stuck) bridgeState.stuck = false;
      return ok({});
    }
    return ok({}); // anything else
  };
  bridge.spawnLog = spawnLog;
  return bridge;
}

// ──────────────────────────────────────────────────────────────────────
// Fake pi
// ──────────────────────────────────────────────────────────────────────

export function createFakePi({
  bdTasks = new Map(),      // bdId -> title (for bd list / bd show fakes)
  bdAC = new Map(),         // bdId -> acceptance criteria (bd show fakes)
  execTable = {},           // "cmd args" -> { code, stdout, stderr } override
  bridge,                   // events => handler; if set, registered as RPC bridge
  extraExec,                // (cmd, args, opts) => result | undefined
  gitState = {},            // mutable knobs: showCurrent, headBefore, headAfter
  realGit = false,          // run REAL git (child_process) instead of canned answers
} = {}) {
  const tools = [];
  const commands = [];
  const hooks = new Map(); // event -> handler[]
  const sentMessages = [];
  const notifications = [];
  const execCalls = [];
  const events = createEventBus();
  if (bridge) events.on(RPC_REQUEST, bridge(events));

  // worktreeDir -> feat branch (registered on `git worktree add -b`)
  const worktrees = new Map();

  const pi = {
    tools,
    commands,
    hooks,
    sentMessages,
    notifications,
    execCalls,
    events,
    worktrees,

    on(event, handler) {
      if (!hooks.has(event)) hooks.set(event, []);
      hooks.get(event).push(handler);
    },

    registerTool(def) {
      tools.push(def);
    },

    registerCommand(name, def) {
      commands.push({ name, ...def });
    },

    async exec(cmd, args = [], opts = {}) {
      execCalls.push({ cmd, args, opts });
      if (extraExec) {
        const r = extraExec(cmd, args, opts);
        if (r !== undefined) return r;
      }
      const key = [cmd, ...(args ?? [])].join(" ");
      if (execTable[key]) return execTable[key];

      if (cmd === "bd") {
        if (args[0] === "list") {
          const lines = [...bdTasks.entries()].map(([id, title]) => `○ ${id} ● P2 ${title}`).join("\n");
          return { code: 0, stdout: lines ? lines + "\n" : "", stderr: "" };
        }
        if (args[0] === "show") {
          const title = bdTasks.get(args[1]);
          if (title) return { code: 0, stdout: bdShowLine(args[1], title, bdAC.get(args[1])), stderr: "" };
          return { code: 1, stdout: "", stderr: `no task ${args[1]}` };
        }
        return { code: 0, stdout: "bd v0.0.0\n", stderr: "" };
      }

      if (cmd === "git") {
        if (realGit) {
          try {
            const out = execFileSync("git", args, { cwd: opts.cwd, encoding: "utf8" });
            return { code: 0, stdout: out, stderr: "" };
          } catch (e) {
            return {
              code: e.status ?? 1,
              stdout: e.stdout ?? "",
              stderr: `${e.stderr ?? e.message}`,
            };
          }
        }
        const joined = args.join(" ");
        // worktree add -b <branch> <wtDir> <base> — auto-register for cwd-aware answers
        if (joined.startsWith("worktree add") && args.includes("-b")) {
          const bIdx = args.indexOf("-b");
          if (bIdx >= 0 && args[bIdx + 2]) {
            worktrees.set(args[bIdx + 2], args[bIdx + 1]);
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (joined.startsWith("worktree remove")) return { code: 0, stdout: "", stderr: "" };
        const inWorktree = opts.cwd && worktrees.has(opts.cwd);
        if (joined.startsWith("branch --list")) {
          return inWorktree
            ? { code: 0, stdout: `* ${worktrees.get(opts.cwd)}\n`, stderr: "" }
            : { code: 0, stdout: "* main\n", stderr: "" };
        }
        if (joined.startsWith("checkout")) return { code: 0, stdout: "", stderr: "" };
        if (joined.startsWith("diff")) return { code: 0, stdout: "diff --git a/x b/x\n+work\n", stderr: "" };
        if (joined.startsWith("branch -D")) return { code: 0, stdout: "", stderr: "" };
        if (joined.startsWith("fetch")) return { code: 0, stdout: "", stderr: "" };
        if (joined.startsWith("merge --squash")) return { code: 0, stdout: "", stderr: "" };
        if (joined.startsWith("commit")) return { code: 0, stdout: "[main abc123] feat: merge\n", stderr: "" };
        if (joined.startsWith("rev-parse --abbrev-ref HEAD")) {
          return { code: 0, stdout: `${gitState.originalBranch ?? "main"}\n`, stderr: "" };
        }
        if (joined.startsWith("rev-parse --git-dir")) return { code: 0, stdout: ".git\n", stderr: "" };
        if (joined.startsWith("rev-parse HEAD")) {
          return { code: 0, stdout: `${gitState.headAfter ?? "aaa111"}\n`, stderr: "" };
        }
        if (joined.startsWith("log --oneline -1")) {
          return { code: 0, stdout: `${gitState.headAfter ?? "aaa111"} feat: reproduction\n`, stderr: "" };
        }
        if (joined.startsWith("branch --show-current")) {
          return { code: 0, stdout: `${gitState.showCurrent ?? "main"}\n`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }

      return { code: 0, stdout: "", stderr: "" };
    },

    async sendUserMessage(text, msgOpts) {
      sentMessages.push({ text, opts: msgOpts ?? {} });
    },

    async notify(text, type) {
      notifications.push({ text, type });
    },
  };

  const tool = (name) => tools.find((t) => t.name === name);
  const command = (name) => commands.find((c) => c.name === name);
  const hook = (event) => (hooks.get(event) ?? [])[0];
  return { pi, tool, command, hook, events };
}

/** Fake ui with a queue of answers for the /agile setup wizard. */
export function makeFakeUi(answers = []) {
  const calls = [];
  let i = 0;
  const next = (label) => {
    calls.push(label);
    const v = answers[i];
    if (i < answers.length) i++;
    return Promise.resolve(v ?? "");
  };
  return {
    calls,
    notify() {},
    input: (label, _def) => next(label),
    select: (label, _opts) => next(label),
  };
}

/** Fake extension context: { cwd, sessionId, ui }. */
export function makeCtx(dir, sessionId, ui) {
  return {
    cwd: dir,
    sessionId,
    ui: ui ?? { notify() {}, input: async () => "" },
  };
}

/** Read .agile/session.json of a scenario dir (never throws). */
export function readSession(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, ".agile", "session.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Latest parseable sprint file content, or null. */
export function readLatestSprint(dir) {
  const agileDir = path.join(dir, ".agile");
  if (!fs.existsSync(agileDir)) return null;
  const files = fs.readdirSync(agileDir)
    .filter((f) => /^sprint-(\d+)\.json$/.test(f))
    .sort((a, b) => parseInt(b.replace("sprint-", ""), 10) - parseInt(a.replace("sprint-", ""), 10));
  for (const f of files) {
    try {
      return JSON.parse(fs.readFileSync(path.join(agileDir, f), "utf8"));
    } catch { /* corrupt — try older */ }
  }
  return null;
}
