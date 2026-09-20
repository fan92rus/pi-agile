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

      const split = splitKeyContent(content);
      if (split === null) { pos++; continue; }
      const key = split.key;
      const valueStr = split.value;
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

        // Fully-quoted scalar: strip quotes and be done — a colon inside the
        // quotes ("- \"a: b\"") must not start a map item.
        if (itemText.length >= 2 &&
            ((itemText.startsWith('"') && itemText.endsWith('"')) ||
             (itemText.startsWith("'") && itemText.endsWith("'")))) {
          list.push(parseYamlValue(itemText));
          continue;
        }

        const split = splitKeyContent(itemText);
        if (split) {
          // map item: "- key: value" (continuation keys on deeper lines)
          const key = split.key;
          const vStr = split.value;
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

/**
 * Split a "key: value" line into { key, value }, or null when there is no key.
 *
 * Quoted key: when the first character is a quote, find the matching closing
 * quote and take the first ':' AFTER it; the key is then parsed (quotes
 * stripped) — so `"a: b": v` → key `a: b`, value `v`. A quoted key with no
 * colon after the closing quote is not a key line (null).
 * Unquoted: plain first-colon behavior, as before.
 */
function splitKeyContent(content: string): { key: string; value: string } | null {
  if (content.startsWith('"') || content.startsWith("'")) {
    const quote = content[0];
    const close = content.indexOf(quote, 1);
    if (close !== -1) {
      const colonIdx = content.indexOf(":", close + 1);
      if (colonIdx === -1) return null;
      const key = String(parseYamlValue(content.slice(0, close + 1).trim()));
      return { key, value: content.slice(colonIdx + 1).trim() };
    }
  }
  const colonIdx = content.indexOf(":");
  if (colonIdx === -1) return null;
  return { key: content.slice(0, colonIdx).trim(), value: content.slice(colonIdx + 1).trim() };
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
  if (t.length >= 2 && t.startsWith("[") && t.endsWith("]")) {
    // Flow sequence: "[a, b]" → ["a", "b"]. Split on top-level commas while
    // tracking quote state and bracket depth, so a comma inside quotes
    // ("a, b") or inside a nested sequence does not split; each part is
    // trimmed and parsed recursively (quotes/booleans/numbers re-applied).
    const inner = t.slice(1, -1).trim();
    if (inner === "") return [];
    const parts: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let cur = "";
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
      } else if (ch === "[") {
        depth++;
        cur += ch;
      } else if (ch === "]") {
        depth = Math.max(0, depth - 1);
        cur += ch;
      } else if (ch === "," && depth === 0) {
        parts.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    parts.push(cur);
    return parts.map((p) => parseYamlValue(p.trim()));
  }
  return t;
}
