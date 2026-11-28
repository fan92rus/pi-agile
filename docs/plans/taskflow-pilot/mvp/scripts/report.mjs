import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

function jsonEnv(name) {
  const value = process.env[name];
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}
function artifact(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return readFileSync(path, 'utf8').trim(); }
}
function newestRunState(repo, flowName) {
  const dir = join(repo, '.pi', 'taskflows', 'runs', flowName);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null;
  try { return JSON.parse(readFileSync(join(dir, files[0].name), 'utf8')); } catch { return null; }
}
function usageFromRunState(state) {
  const total = { input: 0, output: 0, cacheRead: 0, turns: 0 };
  for (const phase of Object.values(state?.phases || {})) {
    const usage = phase?.usage || {};
    total.input += Number(usage.input) || 0;
    total.output += Number(usage.output) || 0;
    total.cacheRead += Number(usage.cacheRead) || 0;
    total.turns += Number(usage.turns) || 0;
  }
  return total;
}
try {
  const root = process.env.TF_MVP_WORKTREE_CWD || process.cwd();
  const dir = join(root, '.taskflow-mvp');
  const taskId = process.env.TF_MVP_TASK_ID || artifact(join(dir, 'task.json'))?.id || '';
  const repo = process.env.TF_MVP_REPO || root;
  const flowRoot = process.env.TF_MVP_FLOW_PROJECT_ROOT || repo;
  const repoUsage = usageFromRunState(newestRunState(repo, `tf-leaf-mvp-${taskId}`));
  const hostUsage = usageFromRunState(newestRunState(flowRoot, `tf-leaf-mvp-${taskId}`));
  const usage = repoUsage.input || repoUsage.output || repoUsage.cacheRead ? repoUsage : hostUsage;
  const worker = artifact(join(dir, 'worker.json'));
  const finalCycle = jsonEnv('TF_MVP_FINAL_CYCLE_JSON');
  const reviewGate = jsonEnv('TF_MVP_REVIEW_GATE_JSON');
  const blockersData = finalCycle || reviewGate || artifact(join(dir, 'blockers-final.json')) || artifact(join(dir, 'blockers.json'));
  const gates = process.env.TF_MVP_GATES_OUTPUT || artifact(join(dir, 'gates.log')) || '';
  const recheck = process.env.TF_MVP_RECHECK_OUTPUT || '';
  const commit = process.env.TF_MVP_COMMIT || (existsSync(join(dir, 'merge-commit.txt')) ? readFileSync(join(dir, 'merge-commit.txt'), 'utf8').trim() : '');
  const blockers = Array.isArray(blockersData?.blockers) ? blockersData.blockers : [];
  const needsAttentionFromCycle = finalCycle?.needsAttention || null;
  let mergeVerified = false;
  if (commit) {
    const branch = process.env.TF_MVP_BRANCH || '';
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: repo, encoding: 'utf8', shell: false, windowsHide: true });
    const subject = spawnSync('git', ['log', '-1', '--format=%s', commit], { cwd: repo, encoding: 'utf8', shell: false, windowsHide: true });
    const identity = spawnSync('git', ['rev-parse', `${commit}^{commit}`], { cwd: repo, encoding: 'utf8', shell: false, windowsHide: true });
    const owner = artifact(join(dir, 'bd-owner.json'));
    mergeVerified = !ancestor.error && ancestor.status === 0
      && !subject.error && subject.status === 0
      && !identity.error && identity.status === 0 && identity.stdout.trim() === commit
      && subject.stdout.includes(`Merge branch '${branch}'`)
      && owner?.closed === true
      && owner?.commit === commit;
  }
  const status = mergeVerified ? 'merged' : blockersData?.needsFix ? 'blocked' : 'failed';
  const report = {
    taskId,
    status,
    commit,
    merged: status === 'merged',
    bdClosed: Boolean(artifact(join(dir, 'bd-owner.json'))?.closed) && mergeVerified,
    blockers,
    needsAttention: status === 'merged' ? null : (needsAttentionFromCycle || blockers.join('; ') || worker?.error || String(gates || recheck || 'Taskflow did not complete successfully')),
    freshTokens: Number(process.env.TF_MVP_FRESH_TOKENS || usage.input + usage.output),
    cacheReadTokens: Number(process.env.TF_MVP_CACHE_READ_TOKENS || usage.cacheRead)
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report));
} catch (e) { console.error(`REPORT FAIL: ${e.message}`); process.exit(1); }
