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
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

function bdShowLine(bdId, title) {
  return `○ ${bdId} · ${title}   [● P2 · OPEN]\n\nDESCRIPTION\nTask ${bdId} description.\n\nACCEPTANCE CRITERIA\nNone`;
}

// ──────────────────────────────────────────────────────────────────────
// Fake subagent RPC bridge — answers ping/spawn/status and writes the
// worker/reviewer output files the orchestrator polls for.
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
 * verdictFor: () => "blocked" | "rework" — called once per reviewer spawn.
 * workerSummary: text written to the worker's output file.
 */
export function createFakeBridge({ verdictFor = () => "blocked", workerSummary = "Worker implemented the change.\n" } = {}) {
  return (events) => (req) => {
    const replyEvent = `${RPC_REPLY_PREFIX}${req.requestId}`;
    const ok = (data) => events.emit(replyEvent, { version: 1, requestId: req.requestId, success: true, data });
    if (req.method === "ping") return ok({});
    if (req.method === "spawn") {
      const runId = `run-${String(req.requestId).slice(0, 8)}`;
      const params = req.params ?? {};
      const outFile = params.output;
      if (outFile) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(
          outFile,
          params.agent === "reviewer" ? reviewerVerdictText(verdictFor()) : workerSummary,
          "utf8",
        );
      }
      return ok({ details: { runId, asyncDir: outFile ? path.dirname(outFile) : os.tmpdir() } });
    }
    if (req.method === "status") return ok({ state: "completed", lastActivityAt: Date.now() });
    return ok({}); // interrupt / stop / anything else
  };
}

// ──────────────────────────────────────────────────────────────────────
// Fake pi
// ──────────────────────────────────────────────────────────────────────

export function createFakePi({
  bdTasks = new Map(),      // bdId -> title (for bd list / bd show fakes)
  execTable = {},           // "git branch --list" -> { code, stdout, stderr } override
  bridge,                   // events => handler; if set, registered as RPC bridge
  extraExec,                // (cmd, args, opts) => result | undefined
} = {}) {
  const tools = [];
  const commands = [];
  const hooks = new Map(); // event -> handler[]
  const sentMessages = [];
  const notifications = [];
  const execCalls = [];
  const events = createEventBus();
  if (bridge) events.on(RPC_REQUEST, bridge(events));

  const pi = {
    tools,
    commands,
    hooks,
    sentMessages,
    notifications,
    execCalls,
    events,

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
          if (title) return { code: 0, stdout: bdShowLine(args[1], title), stderr: "" };
          return { code: 1, stdout: "", stderr: `no task ${args[1]}` };
        }
      }
      if (cmd === "git") {
        const joined = args.join(" ");
        if (joined.startsWith("branch --list")) return { code: 0, stdout: "* main\n", stderr: "" };
        if (joined.startsWith("checkout -b")) return { code: 0, stdout: "", stderr: "" };
        if (joined.startsWith("checkout main")) return { code: 0, stdout: "", stderr: "" };
        if (joined.startsWith("diff")) return { code: 0, stdout: "diff --git a/x b/x\n+work\n", stderr: "" };
        if (joined.startsWith("branch -D")) return { code: 0, stdout: "", stderr: "" };
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

/** Fake extension context: { cwd, sessionId, ui }. */
export function makeCtx(dir, sessionId) {
  return {
    cwd: dir,
    sessionId,
    ui: {
      notify() {},
      input: async () => "",
    },
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
