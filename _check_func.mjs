import fs from 'fs';

const content = fs.readFileSync('D:/Documents/Repositories/pi-agile/extensions/pi-agile/index.ts', 'utf8');
const start = content.indexOf('async function delegateBatchParallel');
const end = content.indexOf('async function executeBatchTasks');
const funcText = content.substring(start, end);

// Find function body opening brace
const bodyStart = funcText.indexOf('}> {');
const funcBody = funcText.substring(bodyStart + 4);

// Count braces properly with template literal handling
let depth = 1;
let inString = false;
let stringChar = '';
let inTemplate = false;
let templateStack = 0;

for (let i = 0; i < funcBody.length; i++) {
  const c = funcBody[i];
  const prev = i > 0 ? funcBody[i-1] : '';

  // Skip strings
  if (!inTemplate && (c === "'" || c === '"') && prev !== '\\') {
    if (!inString) { inString = true; stringChar = c; }
    else if (c === stringChar) { inString = false; }
    continue;
  }
  if (inString) continue;

  // Template literal handling
  if (c === '`' && prev !== '\\') {
    if (!inTemplate) {
      inTemplate = true;
      templateStack = 0;
      continue;
    } else if (templateStack === 0) {
      inTemplate = false;
      continue;
    }
    // If templateStack > 0, we're inside a nested `${}`
    continue;
  }
  
  if (inTemplate) {
    if (c === '$' && i + 1 < funcBody.length && funcBody[i + 1] === '{') {
      templateStack++;
      continue;
    }
    if (c === '}') {
      if (templateStack > 0) templateStack--;
      continue;
    }
    continue;
  }

  if (c === '{') depth++;
  if (c === '}') {
    depth--;
    if (depth === 0) {
      const lineNum = content.substring(0, start + bodyStart + 4 + i).split('\n').length;
      console.log('Function body closes at line', lineNum);
      console.log('Context:', funcBody.substring(Math.max(0, i - 30), i + 30));
      break;
    }
  }
}

if (depth !== 0) {
  console.log('Function body NEVER closes! Final depth:', depth);
}
