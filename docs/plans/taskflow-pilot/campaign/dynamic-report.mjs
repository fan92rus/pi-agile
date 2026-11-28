#!/usr/bin/env node
import fs from 'node:fs';
const [queuePath] = process.argv.slice(2);
if (!queuePath) throw new Error('usage: dynamic-report.mjs <queue.json>');
const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
const report = { pending: queue.pending || [], active: queue.active || [], completed: queue.completed || [] };
console.log(JSON.stringify(report));
