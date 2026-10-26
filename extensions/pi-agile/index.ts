/**
 * pi-agile — Pi Extension (thin harness).
 *
 * Two tools, no sprint loop of its own. The campaign engine is the workflow script
 * workflows/agile-loop.js, run by subagent; the extension only prepares its launch
 * and reports on it.
 * - agile_run    launch station: read-only bd check + launch plan (no LLM, starts nothing)
 * - agile_status read-only progress of a launched campaign
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { planLaunch, type LaunchInput } from "./launch.ts";
import { statusReport } from "./status.ts";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorText(tool: string, e: unknown) {
  return textResult(`❌ ${tool}: ${e instanceof Error ? e.message : String(e)}`);
}

export default function piAgileExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "agile_run",
    label: "agile_run",
    description: "Launch station for a bd epic campaign. Checks the epic read-only in bd (exists, has open leaves, closed leaves have no open deps), snapshots the open leaves and returns the engine workflow path (workflows/agile-loop.js), its args and a copyable subagent call line. Starts nothing. Defaults: sprintTasks 3, maxSprints 3, maxParallel 3, mergeApproval auto.",
    parameters: Type.Object({
      epic: Type.String({ description: "bd epic id whose open leaves form the campaign" }),
      testCommand: Type.String({ description: "Host gate command (the full suite) the campaign must keep green" }),
      cwd: Type.Optional(Type.String({ description: "Repository root (defaults to session cwd)" })),
      sprintTasks: Type.Optional(Type.Integer({ description: "Tasks per sprint (default 3)" })),
      maxSprints: Type.Optional(Type.Integer({ description: "Sprint budget (default 3)" })),
      maxParallel: Type.Optional(Type.Integer({ description: "Max concurrently running tasks (default 3)" })),
      mergeApproval: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("confirm")], { description: "Who authorizes merges (default auto)" })),
      workModels: Type.Optional(Type.Array(Type.String(), { description: "Rotation of work models" })),
      reviewModels: Type.Optional(Type.Array(Type.String(), { description: "Rotation of review models; must not overlap workModels" })),
      bundleScript: Type.Optional(Type.String({ description: "Read-only context bundle script run as the campaign's STEP 0 (warned when absent)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const plan = await planLaunch(params as LaunchInput, { cwd: ctx.cwd });
        return textResult(JSON.stringify(plan, null, 2));
      } catch (e) {
        return errorText("agile_run", e);
      }
    },
  });

  pi.registerTool({
    name: "agile_status",
    label: "agile_status",
    description: "Read-only progress of a launched campaign: workflow state and result (stopReason, counts), checkpoint (phase, sprint, cooldowns) and the last settled children. Without runId, reports the freshest run (filtered to cwd when given). Writes nothing.",
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ description: "Run id (subagent async run dir name). Omit for the freshest run." })),
      cwd: Type.Optional(Type.String({ description: "Only consider runs launched in this repository root" })),
    }),
    async execute(_toolCallId, params) {
      try {
        return textResult(statusReport(params as { runId?: string; cwd?: string }));
      } catch (e) {
        return errorText("agile_status", e);
      }
    },
  });
}
