import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const fail = (m) => { console.error(`INCREMENTAL DIFF FAIL: ${m}`); process.exit(1); };
try {
  const cwd = process.env.TF_MVP_WORKTREE_CWD || process.cwd();
  const cycle = String(process.env.TF_MVP_CYCLE || '');
  const reviewedDirArg = process.env.TF_MVP_REVIEWED_DIR || '';
  const fixSummary = process.env.TF_MVP_FIX_SUMMARY || '';
  if (!/^\d+$/.test(cycle) || !reviewedDirArg) throw new Error('TF_MVP_CYCLE and TF_MVP_REVIEWED_DIR are required');
  const hints = (process.env.TF_MVP_FILES_HINT || '').split(',').map((s) => s.trim().replaceAll('\\', '/')).filter(Boolean);
  if (!hints.length) throw new Error('TF_MVP_FILES_HINT is empty');
  const reviewed = path.isAbsolute(reviewedDirArg) ? reviewedDirArg : path.join(cwd, reviewedDirArg);
  if (!fs.existsSync(reviewed)) throw new Error(`reviewed snapshot missing: ${reviewed}`);
  const current = path.join(cwd, '.taskflow-mvp', 'snapshots', `cycle-${cycle}-current`);
  fs.rmSync(current, { recursive: true, force: true });
  fs.mkdirSync(current, { recursive: true });
  for (const hint of hints) {
    const src = path.join(cwd, hint);
    if (!fs.existsSync(src)) continue;
    const stat = fs.statSync(src);
    const dst = path.join(current, hint);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (stat.isDirectory()) fs.cpSync(src, dst, { recursive: true });
    else fs.copyFileSync(src, dst);
  }
  const result = spawnSync('git', ['diff', '--no-index', '--binary', '--', reviewed, current], {
    cwd, encoding: 'utf8', shell: false, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (![0, 1].includes(result.status)) throw new Error(result.stderr || `git diff exited ${result.status}`);
  const sections = (result.stdout || '').split(/(?=^diff --git )/m)
    .filter((section) => !section.includes('snapshot-state.json'));
  const patch = sections.filter((s) => s.trim()).join('');
  const dir = path.join(cwd, '.taskflow-mvp');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `diff-cycle-${cycle}.patch`), patch, 'utf8');
  fs.writeFileSync(path.join(dir, 'fix-summary.json'), `${JSON.stringify({ cycle, summary: fixSummary }, null, 2)}\n`, 'utf8');
  fs.rmSync(current, { recursive: true, force: true });
  console.log(`INCREMENTAL DIFF OK cycle-${cycle}`);
} catch (e) {
  fail(e.message);
}
