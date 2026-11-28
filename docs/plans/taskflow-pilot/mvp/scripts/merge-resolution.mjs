const START = /^<{7}(?: .*)?$/;
const SEPARATOR = /^={7}$/;
const END = /^>{7}(?: .*)?$/;

export function hasConflictMarkers(content) {
  return START.test(content.split(/\r?\n/, 1)[0]) || /^<{7}(?: .*)?$/m.test(content);
}

/**
 * Resolve a text conflict by keeping the union of both sides. This is meant
 * for additive edits (e.g. two leaves appending different lines to the same
 * file) and deliberately preserves no semantic judgement: if the union is not
 * acceptable, the reviewer or a later workflow must fix the result.
 */
export function resolveUnionConflicts(content) {
  const crlf = content.includes('\r\n');
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const pushUnique = (line) => {
    if (line.trim() && out.includes(line)) return;
    out.push(line);
  };
  let index = 0;
  let resolved = 0;
  while (index < lines.length) {
    if (!START.test(lines[index])) {
      out.push(lines[index]);
      index += 1;
      continue;
    }
    index += 1;
    const ours = [];
    while (index < lines.length && !SEPARATOR.test(lines[index])) {
      ours.push(lines[index]);
      index += 1;
    }
    if (index >= lines.length) throw new Error('unterminated merge conflict (missing =======)');
    index += 1;
    const theirs = [];
    while (index < lines.length && !END.test(lines[index])) {
      theirs.push(lines[index]);
      index += 1;
    }
    if (index >= lines.length) throw new Error('unterminated merge conflict (missing >>>>>>>)');
    index += 1;
    for (const line of ours) pushUnique(line);
    for (const line of theirs) pushUnique(line);
    resolved += 1;
  }
  if (!resolved) return content;
  return out.join(crlf ? '\r\n' : '\n');
}
