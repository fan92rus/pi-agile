import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import process from 'node:process';

const fail = (m) => { console.error(`SNAPSHOT FAIL: ${m}`); process.exit(1); };
try {
  const cwd = process.env.TF_MVP_WORKTREE_CWD || process.cwd();
  const cycle = String(process.env.TF_MVP_CYCLE || '');
  if (!/^\d+$/.test(cycle)) throw new Error('TF_MVP_CYCLE must be digits');
  const hints = (process.env.TF_MVP_FILES_HINT || '').split(',').map((s) => s.trim().replaceAll('\\', '/')).filter(Boolean);
  if (!hints.length) throw new Error('TF_MVP_FILES_HINT is empty');
  const dir = path.join(cwd, '.taskflow-mvp', 'snapshots', `cycle-${cycle}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const hint of hints) {
    const src = path.join(cwd, hint);
    if (!fs.existsSync(src)) continue;
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.cpSync(src, path.join(dir, path.basename(hint)), { recursive: true });
      files.push(`${hint}/`);
    } else {
      const dst = path.join(dir, hint);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      files.push(hint);
    }
  }
  const state = {
    cycle,
    files,
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  };
  fs.writeFileSync(path.join(dir, 'snapshot-state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  console.log(`SNAPSHOT OK cycle-${cycle}`);
} catch (e) {
  fail(e.message);
}
