import fs from 'node:fs';
import path from 'node:path';
const fail = (m) => { console.error(m); process.exit(1); };
const cwd = process.env.TF_MVP_WORKTREE_CWD || process.cwd();
const inputs = [process.env.TF_MVP_REVIEW_CORRECTNESS_JSON, process.env.TF_MVP_REVIEW_GUARDRAILS_JSON];
if (inputs.some(v => !v)) fail('Missing reviewer JSON environment variable');
let reviews;
try { reviews = inputs.map(v => JSON.parse(v)); } catch { fail('Reviewer output is not valid JSON'); }
const blockers = [];
for (const [i, review] of reviews.entries()) {
  const label = i === 0 ? 'correctness' : 'guardrails';
  const verdict = String(review.verdict || '').toLowerCase();
  if (verdict !== 'pass') {
    const list = Array.isArray(review.blockers) ? review.blockers : [review.blockers || review.reason || 'review did not pass'];
    for (const item of list) blockers.push(`[-${label}] ${typeof item === 'string' ? item : JSON.stringify(item)}`);
  }
}
const needsFix = blockers.length > 0;
const dir = path.join(cwd, '.taskflow-mvp');
fs.mkdirSync(dir, { recursive: true });
const outName = process.env.TF_MVP_BLOCKERS_FILE || 'blockers.json';
fs.writeFileSync(path.join(dir, outName), `${JSON.stringify({ needsFix, blockers }, null, 2)}\n`, 'utf8');
console.log(needsFix ? 'NEEDS FIX' : 'NO FIX');
