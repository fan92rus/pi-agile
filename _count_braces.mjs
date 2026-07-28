import fs from 'fs';

const s = fs.readFileSync('extensions/pi-agile/index.ts', 'utf8');
const lines = s.split('\n');

function count(name, start, end) {
  const text = lines.slice(start - 1, end).join('\n');
  const o = (text.match(/{/g) || []).length;
  const c = (text.match(/}/g) || []).length;
  console.log(name + ': {' + o + ' }' + c + ' diff=' + (o - c));
}

count('full file before export', 1, 1117);
count('delegateBatchParallel body', 536, 660);
count('showBatchSummary', 547, 580);
count('wrappedOnProgress', 583, 600);
count('for/if/else block', 626, 650);
