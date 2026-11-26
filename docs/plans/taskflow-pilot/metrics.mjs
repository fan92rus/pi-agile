// Per-phase token accounting for the taskflow/DAG pilot.
// Run: node docs/plans/taskflow-pilot/metrics.mjs
// Appends a compact table for the newest agile-leaf-pilot run to results.md.
import fs from 'node:fs';
import path from 'node:path';

const runDir = 'D:/Documents/Repositories/pi-agile/.pi/taskflows/runs/agile-leaf-pilot';
const report = 'D:/Documents/Repositories/pi-agile/docs/plans/taskflow-pilot/results.md';
const traces = fs.readdirSync(runDir)
  .filter((f) => f.endsWith('.trace.jsonl'))
  .map((f) => ({ f, m: fs.statSync(path.join(runDir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);
if (!traces.length) { console.log('METRICS no trace found'); process.exit(0); }
const runId = traces[0].f.replace(/\.trace\.jsonl$/, '');
const state = JSON.parse(fs.readFileSync(path.join(runDir, runId + '.json'), 'utf8'));

const rows = [];
let freshAll = 0, cacheAll = 0;
for (const [id, p] of Object.entries(state.phases || {})) {
  const u = p.usage || {};
  const fresh = (u.input || 0) + (u.output || 0);
  const cache = (u.cacheRead || 0) + (u.cacheWrite || 0);
  if (!fresh && !cache) continue;
  freshAll += fresh;
  cacheAll += cache;
  rows.push({ id, status: p.status, fresh, cache, total: fresh + cache, turns: u.turns || 0, cost: u.cost || 0 });
}
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const lines = [
  '',
  '### Автоматический замер: ' + runId,
  '',
  '| phase | status | fresh | cache | total | turns | cost |',
  '|---|---|---:|---:|---:|---:|---:|',
  ...rows.map((r) => '| ' + r.id + ' | ' + r.status + ' | ' + fmt(r.fresh) + ' | ' + fmt(r.cache) + ' | ' + fmt(r.total) + ' | ' + r.turns + ' | $' + r.cost.toFixed(5) + ' |'),
  '| **ИТОГО** | | **' + fmt(freshAll) + '** | **' + fmt(cacheAll) + '** | **' + fmt(freshAll + cacheAll) + '** | | |',
  '',
];
fs.appendFileSync(report, lines.join('\n'));
console.log('METRICS run=' + runId + ' phases=' + rows.length + ' fresh=' + freshAll + ' cache=' + cacheAll);
