import fs from 'node:fs';
import path from 'node:path';

const fail = (message) => { console.error(`REVIEW GATE FAIL: ${message}`); process.exit(1); };
function parseJson(value, label) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { fail(`${label} is not valid JSON`); }
}
try {
  const cwd = process.env.TF_MVP_WORKTREE_CWD || process.cwd();
  const dir = path.join(cwd, '.taskflow-mvp');
  const correctness = parseJson(process.env.TF_MVP_REVIEW_CORRECTNESS_JSON, 'TF_MVP_REVIEW_CORRECTNESS_JSON');
  const guardrails = parseJson(process.env.TF_MVP_REVIEW_GUARDRAILS_JSON, 'TF_MVP_REVIEW_GUARDRAILS_JSON');
  if (!correctness || !guardrails) throw new Error('both initial reviewer JSONs are required');
  const blockers = [];
  const verdictsPass = [correctness, guardrails].every((review) => String(review.verdict || '').toLowerCase() === 'pass');
  for (const [i, review] of [correctness, guardrails].entries()) {
    const label = i === 0 ? 'correctness' : 'guardrails';
    const verdict = String(review.verdict || '').toLowerCase();
    const reported = Array.isArray(review.blockers) ? review.blockers : [];
    if (verdict !== 'pass' && !reported.length) reported.push(review.reason || `${label} review did not pass`);
    for (const item of reported) {
      blockers.push(`[-${label}] ${typeof item === 'string' ? item : JSON.stringify(item)}`);
    }
  }
  const initialPass = verdictsPass && blockers.length === 0;
  const blockersFile = path.join(dir, 'blockers.json');
  const needsFix = blockers.length > 0;
  const gate = {
    initialPass,
    needsFix,
    finalCycleNeeded: needsFix,
    skipFinal: !needsFix,
    done: !needsFix,
    blockers: needsFix ? blockers : [],
    needsAttention: null,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(blockersFile, `${JSON.stringify({ needsFix, blockers }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'review-gate.json'), `${JSON.stringify(gate, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(gate));
} catch (e) {
  fail(e.message);
}
