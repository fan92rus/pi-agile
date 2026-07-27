/**
 * RPC client for spawning worker subagents over the shared pi.events EventBus.
 *
 * pi-subagents registers an RPC bridge that listens on
 *   SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request"
 * and replies on
 *   SUBAGENT_RPC_REPLY_EVENT_PREFIX + requestId = "subagents:rpc:v1:reply:<id>"
 *
 * The `spawn` method is forced to detached async + clarify:false by the bridge
 * (rpc.ts spawnParams). It returns { runId, asyncDir } via the reply's data.details.
 *
 * This module is the single integration point with pi-subagents: it emits spawn /
 * interrupt / status requests and collects replies. Result COLLECTION is done by
 * the orchestrator (worktree.ts / bestofn.ts) via worker-result.json polling —
 * kept out of here so the RPC layer stays a thin transport.
 */

import { randomUUID } from "node:crypto";

// Protocol constants — mirrored from pi-subagents/src/extension/rpc.ts so this
// extension does not depend on pi-subagents' internal module paths.
export const SUBAGENT_RPC_PROTOCOL_VERSION = 1 as const;
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";

/** Minimal EventBus surface we rely on (matches pi.events). */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): (() => void) | void;
  emit(event: string, data: unknown): void;
}

/** Reply envelope — success or error (mirrors SubagentRpcReplyEnvelope). */
export type RpcReplyEnvelope<T = unknown> =
  | { version: number; requestId: string; success: true; data: T }
  | { version: number; requestId: string; success: false; error: { code: string; message: string } };

/** Shape of the `data` returned by a successful spawn (the Details object). */
export interface SpawnReplyData {
  /** Subagent tool result text (summary). */
  text?: string;
  details?: {
    runId?: string;
    asyncDir?: string;
    [k: string]: unknown;
  };
  isError?: boolean;
}

export interface SpawnParams {
  agent: string;
  task: string;
  cwd: string;
  model?: string;
  context?: "fresh" | "fork";
  /** Hard tool-call budget passed to the worker. */
  toolBudget?: { hard: number; soft?: number };
  /** Where the worker writes its final result (we read it back directly). */
  output?: string;
  outputMode?: "inline" | "file-only";
  acceptance?: unknown;
}

export interface SpawnedWorker {
  runId: string;
  asyncDir: string;
}

/** Build a request envelope. Pure — exported for unit testing. */
export function buildRequest(method: string, params?: unknown, sourceExtension = "pi-agile") {
  return {
    version: SUBAGENT_RPC_PROTOCOL_VERSION,
    requestId: randomUUID(),
    method,
    ...(params !== undefined ? { params } : {}),
    source: { extension: sourceExtension },
  };
}

/** Reply event channel for a given requestId. Pure. */
export function replyEventFor(requestId: string): string {
  return `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;
}

/** Type-guard + extractor for a success reply carrying SpawnReplyData. Pure. */
export function parseSpawnReply(reply: unknown): SpawnedWorker {
  if (!reply || typeof reply !== "object") {
    throw new RpcClientError("invalid_reply", `Spawn reply is not an object: ${String(reply)}`);
  }
  const env = reply as RpcReplyEnvelope<SpawnReplyData>;
  if (env.success === false) {
    throw new RpcClientError(env.error?.code ?? "execution_failed", env.error?.message ?? "spawn failed");
  }
  const data = env.data as SpawnReplyData | undefined;
  const runId = data?.details?.runId;
  const asyncDir = data?.details?.asyncDir;
  if (!runId) {
    throw new RpcClientError("execution_failed", `Spawn reply missing runId in details: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { runId, asyncDir: asyncDir ?? "" };
}

export class RpcClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RpcClientError";
    this.code = code;
  }
}

/** Wait for one event matching `predicate`, with a timeout. Rejects on timeout. */
function onceEvent<T>(
  events: EventBus,
  eventName: string,
  predicate: (data: unknown) => boolean,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      reject(new RpcClientError("timeout", `No reply on ${eventName} within ${timeoutMs}ms`));
    }, timeoutMs);
    const handler = (data: unknown) => {
      if (settled) return;
      if (!predicate(data)) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(data as T);
    };
    unsubscribe = events.on(eventName, handler) ?? undefined;
  });
}

/**
 * High-level RPC client bound to a specific EventBus (= pi.events).
 *
 * Construct once per extension activation; all methods are async.
 */
export class RpcClient {
  private readonly events: EventBus;
  constructor(events: EventBus) {
    this.events = events;
  }

  /** Probe whether the pi-subagents RPC bridge is ready. Resolves true/false. */
  async ping(timeoutMs = 2000): Promise<boolean> {
    // Subscribe before emitting to avoid a missed fast reply (same pattern as spawn).
    const request = buildRequest("ping");
    const replyP = onceEvent(this.events, replyEventFor(request.requestId), () => true, timeoutMs);
    this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, request);
    try {
      await replyP;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Spawn a detached async worker. Resolves once the spawn is accepted and the
   * runId is known — NOT when the worker finishes. Use collectWorkerResult() to
   * await completion.
   */
  async spawn(params: SpawnParams, timeoutMs = 30000): Promise<SpawnedWorker> {
    const request = buildRequest("spawn", {
      agent: params.agent,
      task: params.task,
      cwd: params.cwd,
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.context !== undefined ? { context: params.context } : {}),
      ...(params.toolBudget !== undefined ? { toolBudget: params.toolBudget } : {}),
      ...(params.output !== undefined ? { output: params.output } : {}),
      ...(params.outputMode !== undefined ? { outputMode: params.outputMode } : {}),
      ...(params.acceptance !== undefined ? { acceptance: params.acceptance } : {}),
      async: true,
      clarify: false,
    });
    // Subscribe before emitting to avoid a missed fast reply.
    const replyP = onceEvent(this.events, replyEventFor(request.requestId), (d) => {
      const e = d as { requestId?: string };
      return e?.requestId === request.requestId;
    }, timeoutMs);
    this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, request);
    const reply = await replyP;
    return parseSpawnReply(reply);
  }

  /** Interrupt a running worker by runId (best-effort). */
  async interrupt(runId: string, timeoutMs = 5000): Promise<void> {
    const request = buildRequest("interrupt", { runId });
    const replyP = onceEvent(this.events, replyEventFor(request.requestId), (d) => {
      const e = d as { requestId?: string };
      return e?.requestId === request.requestId;
    }, timeoutMs).catch(() => null);
    this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, request);
    await replyP;
  }

  /** Query a run's status. Returns the raw status data, or null on timeout. */
  async status(runId: string, timeoutMs = 5000): Promise<unknown> {
    const request = buildRequest("status", { runId });
    const replyP = onceEvent(this.events, replyEventFor(request.requestId), (d) => {
      const e = d as { requestId?: string };
      return e?.requestId === request.requestId;
    }, timeoutMs).catch(() => null);
    this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, request);
    const reply = await replyP;
    if (!reply) return null;
    const env = reply as RpcReplyEnvelope;
    return env.success ? env.data : null;
  }

  /** Force-stop a run (harder than interrupt). Returns true if the run was stopped. */
  async stop(runId: string, timeoutMs = 5000): Promise<boolean> {
    const request = buildRequest("stop", { runId });
    const replyP = onceEvent(this.events, replyEventFor(request.requestId), (d) => {
      const e = d as { requestId?: string };
      return e?.requestId === request.requestId;
    }, timeoutMs).catch(() => null);
    this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, request);
    const reply = await replyP;
    if (!reply) return false;
    const env = reply as RpcReplyEnvelope;
    return env.success;
  }
}
