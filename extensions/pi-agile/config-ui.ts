/**
 * config-ui.ts — /agile config UI
 *
 * Provides TUI for viewing and toggling pi-agile configuration.
 * Adapted from pi-autoresearch config-ui pattern.
 */

const AGILE_SUBCOMMANDS: { value: string; label: string; description: string }[] = [
  { value: "run", label: "run", description: "Start sprint loop" },
  { value: "status", label: "status", description: "Show current sprint status" },
  { value: "stop", label: "stop", description: "Graceful stop after current tasks" },
  { value: "config", label: "config", description: "Show current configuration" },
  { value: "observer", label: "observer", description: "Toggle observer on/off" },
];

/** Filter subcommands by prefix for autocomplete. */
export function filterSubcommands(prefix: string): typeof AGILE_SUBCOMMANDS {
  const p = (prefix ?? "").toLowerCase();
  return AGILE_SUBCOMMANDS.filter((s) => s.value.startsWith(p));
}

/** Format config for display. */
export function formatConfig(config: Record<string, unknown>): string {
  const lines: string[] = ["# pi-agile Configuration", ""];

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "boolean") {
      lines.push(`  ${value ? "✅" : "❌"} ${key}: ${value}`);
    } else {
      lines.push(`  ${key}: ${value}`);
    }
  }

  lines.push("");
  lines.push("Toggle boolean settings via: /agile config <key> <on|off>");

  return lines.join("\n");
}
