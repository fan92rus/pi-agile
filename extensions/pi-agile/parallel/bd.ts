/**
 * bd.ts — parsers for the `bd` CLI (beads task manager) output.
 *
 * Fix #5: description/AC capture used to stop at the FIRST capitalised line
 * (`\n[A-Z]`) — any multiline description was truncated after its first
 * paragraph, so workers got a gutted task context. A section now ends only at
 * an ALL-CAPS header line (like ACCEPTANCE CRITERIA), a triple blank line, or
 * EOF.
 */

export interface BdShowParsed {
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
}

/**
 * Section body runs until an ALL-CAPS header, triple blank line, or EOF.
 * All-caps is what bd uses for section headers (DESCRIPTION, ACCEPTANCE
 * CRITERIA, ...) — a normal capitalised sentence ("This is the second line")
 * no longer truncates the section.
 */
const SECTION_END = /(?:\n\n\n|\n[A-Z][A-Z \t]{2,}\n|$)/;

export function parseBdShow(output: string): BdShowParsed {
  const result: BdShowParsed = {};

  const firstLine = output.split("\n")[0] ?? "";
  const titleMatch = firstLine.match(/·\s+(.+?)\s+\[/);
  if (titleMatch) result.title = titleMatch[1].trim();

  const descMatch = output.match(new RegExp(`DESCRIPTION\\n([\\s\\S]*?)${SECTION_END.source}`));
  if (descMatch) result.description = descMatch[1].trim();

  const accMatch = output.match(new RegExp(`ACCEPTANCE CRITERIA\\n([\\s\\S]*?)${SECTION_END.source}`));
  if (accMatch) result.acceptanceCriteria = accMatch[1].trim();

  return result;
}
