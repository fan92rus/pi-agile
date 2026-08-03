/**
 * yaml.ts — minimal YAML parser for .agile/project.yaml (and friends).
 *
 * Handles the shapes pi-agile generates and reads:
 *   - nested blocks (indent-based)
 *   - scalar arrays ("- item")
 *   - array-of-maps ("- key: value" + continuation keys, e.g. stop_when.conditions)
 *   - quoted / typed scalars (numbers, booleans, null)
 *   - folded (>) and literal (|) block scalars
 *
 * Fix #10: the old index.ts parser turned "- metric: sprint_count\n  target: 3"
 * into a string item and leaked "target" into the parent object, so
 * stop_when.conditions.find(...) always returned undefined and the sprint
 * budget was silently ignored. This rewrite is a recursive-descent parser and
 * keeps multi-key map items intact.
 */

export function parseSimpleYaml(text: string): Record<string, unknown> {
  const lines: { indent: number; raw: string; content: string }[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    lines.push({ indent: line.length - line.trimStart().length, raw: line, content: trimmed });
  }

  let pos = 0;

  function isListLine(idx: number): boolean {
    return idx < lines.length && (lines[idx].content === "-" || lines[idx].content.startsWith("- "));
  }

  function parseBlock(minIndent: number): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    while (pos < lines.length) {
      const { indent, content } = lines[pos];
      if (content === "") { pos++; continue; } // blank
      if (indent < minIndent) break;
      if (content.startsWith("- ")) break; // list inside a block without a key — malformed; stop

      const colonIdx = content.indexOf(":");
      if (colonIdx === -1) { pos++; continue; }
      const key = content.slice(0, colonIdx).trim();
      const valueStr = content.slice(colonIdx + 1).trim();
      pos++;

      if (valueStr === "") {
        if (pos < lines.length && lines[pos].indent > indent) {
          obj[key] = isListLine(pos) ? parseList(indent) : parseBlock(indent);
        } else {
          obj[key] = {};
        }
      } else if (valueStr === ">" || valueStr === "|") {
        obj[key] = parseBlockScalar(indent, valueStr);
      } else {
        obj[key] = parseYamlValue(valueStr);
      }
    }
    return obj;
  }

  function parseList(minIndent: number): unknown[] {
    const list: unknown[] = [];
    while (pos < lines.length) {
      const { indent, content } = lines[pos];
      if (content === "") { pos++; continue; } // blank
      if (indent < minIndent) break;
      if (content === "-" || content.startsWith("- ")) {
        const itemText = content === "-" ? "" : content.slice(2).trim();
        pos++;

        if (itemText === "") {
          // item is a nested block or list
          if (pos < lines.length && lines[pos].indent > indent) {
            list.push(isListLine(pos) ? parseList(indent) : parseBlock(indent));
          } else {
            list.push({});
          }
          continue;
        }

        const colonIdx = itemText.indexOf(":");
        if (colonIdx !== -1) {
          // map item: "- key: value" (continuation keys on deeper lines)
          const key = itemText.slice(0, colonIdx).trim();
          const vStr = itemText.slice(colonIdx + 1).trim();
          const item: Record<string, unknown> = {};
          if (vStr === "") {
            if (pos < lines.length && lines[pos].indent > indent) {
              item[key] = isListLine(pos) ? parseList(indent) : parseBlock(indent);
            } else {
              item[key] = {};
            }
          } else {
            item[key] = parseYamlValue(vStr);
            // continuation keys deeper than the dash: "target: 3", "area: ..."
            if (pos < lines.length && lines[pos].indent > indent && !lines[pos].content.startsWith("- ")) {
              const sub = parseBlock(indent);
              for (const k of Object.keys(sub)) item[k] = sub[k];
            }
          }
          list.push(item);
          continue;
        }

        // scalar item
        list.push(parseYamlValue(itemText));
      } else {
        break; // key line — belongs to the caller's block
      }
    }
    return list;
  }

  function parseBlockScalar(minIndent: number, kind: string): string {
    const out: string[] = [];
    while (pos < lines.length) {
      const { indent, raw, content } = lines[pos];
      if (content !== "" && indent <= minIndent) break;
      if (content === "") { out.push(""); pos++; continue; }
      out.push(raw.slice(Math.min(minIndent + 2, indent)).trimEnd());
      pos++;
    }
    return kind === ">" ? out.join(" ").replace(/\s{2,}/g, " ").trim() : out.join("\n").trim();
  }

  return parseBlock(-1);
}

export function parseYamlValue(s: string): unknown {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "~") return null;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  return t;
}
