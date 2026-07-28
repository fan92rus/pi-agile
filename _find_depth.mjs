import fs from 'fs';

const src = fs.readFileSync('extensions/pi-agile/index.ts', 'utf8');

// Find the function
const idx = src.indexOf('async function delegateBatchParallel');
const body = src.substring(idx);
const funcBodyStart = body.indexOf('}> {');
const funcBody = body.substring(funcBodyStart + 4);

// Track depth per chunk
let depth = 1;
let inTemplate = false;
let inSingle = false;
let inDouble = false;
let chunkStart = 0;
let lineNum = src.substring(0, idx + funcBodyStart + 4).split('\n').length;

for (let i = 0; i < funcBody.length; i++) {
  const ch = funcBody[i];
  const prev = i > 0 ? funcBody[i-1] : '';

  if (ch === "'" && prev !== '\\' && !inDouble && !inTemplate) { inSingle = !inSingle; continue; }
  if (ch === '"' && prev !== '\\' && !inSingle && !inTemplate) { inDouble = !inDouble; continue; }
  if (ch === '`' && prev !== '\\' && !inSingle && !inDouble) {
    inTemplate = !inTemplate;
    continue;
  }
  if (inSingle || inDouble || inTemplate) continue;

  if (ch === '\n') lineNum++;

  if (ch === '{') {
    depth++;
    if (depth > 3) {
      console.log(`[{ depth=${depth} at line ${lineNum}:`, funcBody.substring(i, i+100).split('\n')[0].trim().substring(0, 80));
    }
  }
  if (ch === '}') {
    depth--;
    if (depth === 2 && ch === '}') {
      // closing back to for-loop level
    }
    if (depth < 1) {
      console.log(`Function closes at line ${lineNum}`);
      process.exit(0);
    }
  }
}

console.log('END OF FILE - depth:', depth);
