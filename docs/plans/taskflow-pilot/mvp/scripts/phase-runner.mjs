// Small adapter so Taskflow script phases can set TF_MVP_* env without a shell.
// Usage: node phase-runner.mjs <phase> KEY=value [KEY=value ...]
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [phase, ...pairs] = process.argv.slice(2);
if (!phase) {
  console.error('phase-runner: missing phase name');
  process.exit(2);
}
for (const pair of pairs) {
  const idx = pair.indexOf('=');
  // Positional args (e.g. gates mode=full) stay in process.argv and are
  // intentionally skipped here.
  if (idx <= 0) continue;
  process.env[pair.slice(0, idx)] = pair.slice(idx + 1);
}
const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, `${phase}.mjs`);
// Make the imported script see the same argv layout as a direct `node <script>` call.
process.argv.splice(1, 2, scriptPath);
await import(pathToFileURL(scriptPath).href);
