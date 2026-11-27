import process from 'node:process';

const fail = (m) => { console.error(`CYCLE RESULT FAIL: ${m}`); process.exit(1); };
function parse(name, required = true) {
  const raw = process.env[name];
  if (!raw) {
    if (required) fail(`${name} is missing`);
    return null;
  }
  try { return JSON.parse(raw); } catch { fail(`${name} is not valid JSON`); }
}
try {
  const aggregate = parse('TF_MVP_CYCLE_AGGREGATE_JSON');
  const fix = parse('TF_MVP_FIX_JSON', false);
  console.log(JSON.stringify({
    cycle: String(Number(aggregate.cycle) + 1),
    done: aggregate.done === true,
    blockers: Array.isArray(aggregate.blockers) ? aggregate.blockers : [],
    needsAttention: aggregate.needsAttention || null,
    reviewedDir: aggregate.reviewedDir,
    blockersFile: aggregate.blockersFile,
    fixSummary: fix?.summary || '',
  }));
} catch (e) {
  fail(e.message);
}
