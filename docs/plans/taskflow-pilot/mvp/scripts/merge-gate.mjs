import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

function run(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `git exited ${r.status}`).trim());
  return r.stdout.trim();
}
function fail(message) { console.error(`MERGE GATE FAIL: ${message}`); process.exit(1); }
function parseOrNull(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
try {
  const repo = process.env.TF_MVP_REPO;
  const branch = process.env.TF_MVP_BRANCH;
  if (!repo || !branch) throw new Error('TF_MVP_REPO and TF_MVP_BRANCH are required');
  if (run(['status', '--porcelain'], repo)) throw new Error('base repo is not clean');
  const sha = run(['rev-parse', branch], repo);
  const reviewedFile = join(process.env.TF_MVP_WORKTREE_CWD || '', '.taskflow-mvp', 'reviewed-sha.txt');
  const reviewed = existsSync(reviewedFile) ? readFileSync(reviewedFile, 'utf8').trim() : (process.env.TF_MVP_REVIEWED_SHA || '').trim();
  if (!reviewed || sha !== reviewed) throw new Error('branch SHA differs from reviewed SHA');
  if (!/^GATES OK\s*$/m.test(process.env.TF_MVP_GATES_OUTPUT || '')) throw new Error('gates are not OK');
  const finalRaw = process.env.TF_MVP_FINAL_CYCLE_JSON || '';
  const skippedPlaceholder = finalRaw.trim() === '{steps.final-cycles.output}';
  const finalCycle = skippedPlaceholder ? null : parseOrNull(finalRaw);
  const finalMalformed = Boolean(finalRaw.trim()) && !finalCycle && !skippedPlaceholder;
  if (finalCycle && typeof finalCycle === 'object') {
    if (finalCycle.done !== true) throw new Error('final review cycle did not complete');
    if (!Array.isArray(finalCycle.blockers)) throw new Error('final cycle blockers must be an array');
    if (finalCycle.needsAttention) throw new Error(finalCycle.needsAttention);
    if (finalCycle.blockers.length) throw new Error(`final blockers remain: ${finalCycle.blockers.join('; ')}`);
  } else {
    if (finalMalformed) throw new Error('final cycle output is present but not valid JSON');
    const worktree = process.env.TF_MVP_WORKTREE_CWD || '';
    const finalArtifacts = [
      join(worktree, '.taskflow-mvp', 'diff-cycle-1.patch'),
      join(worktree, '.taskflow-mvp', 'blockers-cycle-1.json'),
      join(worktree, '.taskflow-mvp', 'snapshots', 'cycle-1'),
    ];
    if (finalArtifacts.some((file) => existsSync(file))) throw new Error('final cycle artifacts exist but its result is missing');
    const reviewGateFile = join(worktree, '.taskflow-mvp', 'review-gate.json');
    const reviewGate = parseOrNull(process.env.TF_MVP_REVIEW_GATE_JSON)
      || (existsSync(reviewGateFile) ? parseOrNull(readFileSync(reviewGateFile, 'utf8')) : null);
    if (reviewGate?.finalCycleNeeded === true) throw new Error('final cycle output is missing but the cycle was required');
    if (reviewGate?.skipFinal !== true || reviewGate?.initialPass !== true) {
      throw new Error('final cycle was skipped without an initial-pass review gate');
    }
    if (!Array.isArray(reviewGate.blockers) || reviewGate.blockers.length) {
      throw new Error('review gate has unresolved blockers');
    }
  }
  if (!/^RECHECK OK(?: \(no diff\))?\s*$/m.test(process.env.TF_MVP_RECHECK_OUTPUT || '')) throw new Error('recheck is not OK');
  console.log('MERGE GATE OK');
} catch (e) { fail(e.message); }
