import fs from 'fs';

// Read the diff
const diffText = fs.readFileSync('C:/Users/user/AppData/Local/Temp/_added_full.tmp', 'utf8');
const lines = diffText.split('\n');

let depth = 0;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  // Count braces (template literals still count, but balanced)
  for (let j = 0; j < l.length; j++) {
    const c = l[j];
    if (c === '{') depth++;
    if (c === '}') depth--;
  }
  if (depth !== 0) {
    console.log(`Line ${i+1}: depth=${depth}: ${l.substring(0,100)}`);
  }
}
console.log(`Final depth: ${depth}`);
