import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const fail = (m) => { console.error(`CYCLE AGGREGATE FAIL: ${m}`); process.exit(1); };
function parse(name) {
  const raw = process.env[name];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { fail(`${name} is not valid JSON`); }
}
try {
  const cwd = process.env.TF_MVP_WORKTREE_CWD || process.cwd();
  const cycle = Number(process.env.TF_MVP_CYCLE || 0);
  const max = Number(process.env.TF_MVP_MAX_CYCLES || 3);
  if (!Number.isInteger(cycle) || cycle < 1) throw new Error('TF_MVP_CYCLE must be a positive integer');
  if (!Number.isInteger(max) || max < 1) throw new Error('TF_MVP_MAX_CYCLES must be a positive integer');
  const reviews = [parse('TF_MVP_REVIEW_CORRECTNESS_JSON'), parse('TF_MVP_REVIEW_GUARDRAILS_JSON')];
  if (reviews.some((r) => !r)) throw new Error('missing reviewer JSON');
  const blockers = [];
  for (const [i, review] of reviews.entries()) {
    const label = i === 0 ? 'correctness' : 'guardrails';
    const verdict = String(review.verdict || '').toLowerCase();
    const list = Array.isArray(review.blockers) ? [...review.blockers] : [];
    if (verdict !== 'pass' && !list.length) list.push(review.reason || 'review did not pass');
    for (const item of list) blockers.push(`[-${label}] ${typeof item === 'string' ? item : JSON.stringify(item)}`);
  }
  const exhausted = cycle >= max;
  const done = blockers.length === 0 || exhausted;
  const needsAttention = blockers.length && exhausted
    ? `final review still blocked after ${max} cycles: ${blockers.join('; ')}`
    : null;
  const dir = path.join(cwd, '.taskflow-mvp');
  fs.mkdirSync(dir, { recursive: true });
  const blockersFile = `.taskflow-mvp/blockers-cycle-${cycle}.json`;
  fs.writeFileSync(path.join(cwd, blockersFile), `${JSON.stringify({ cycle, needsFix: blockers.length > 0, blockers, needsAttention }, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    cycle,
    done,
    blockers,
    needsAttention,
    reviewedDir: `.taskflow-mvp/snapshots/cycle-${cycle}`,
    blockersFile: `.taskflow-mvp/blockers-cycle-${cycle + 1}.json`,
  }));
} catch (e) {
  fail(e.message);
}
