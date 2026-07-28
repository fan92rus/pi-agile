const fs = require('fs');
const src = fs.readFileSync('extensions/pi-agile/index.ts', 'utf8');

const idx = src.indexOf('async function delegateBatchParallel');
const body = src.substring(idx);
let depth = 0;
let inTemplate = false;
let inSingle = false;
let inDouble = false;

for (let i = 0; i < body.length; i++) {
  const ch = body[i];
  const prev = i > 0 ? body[i-1] : '';

  // Skip strings
  if (ch === "'" && prev !== '\\' && !inDouble && !inTemplate) { inSingle = !inSingle; continue; }
  if (ch === '"' && prev !== '\\' && !inSingle && !inTemplate) { inDouble = !inDouble; continue; }
  if (ch === '`' && prev !== '\\' && !inSingle && !inDouble) {
    inTemplate = !inTemplate;
    continue;
  }
  if (inSingle || inDouble || inTemplate) continue;

  if (ch === '{') depth++;
  if (ch === '}') depth--;

  if (depth === 0 && i > 200) {
    const lineNum = src.substring(0, idx + i).split('\n').length;
    console.log('depth 0 at char', i, 'line ~', lineNum);
    console.log('Context:', JSON.stringify(body.substring(Math.max(0, i - 40), i + 40)));
    break;
  }
}

if (depth !== 0) {
  console.log('Final depth:', depth, 'at end of function');
}
