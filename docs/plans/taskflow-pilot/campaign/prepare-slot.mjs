#!/usr/bin/env node
import fs from 'node:fs';
const [queuePath] = process.argv.slice(2);
if (!queuePath) throw new Error('usage: prepare-slot.mjs <queue.json>');
const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
if (!Array.isArray(queue.pending) || !Array.isArray(queue.active)) throw new Error('invalid queue format');
const taskId = queue.pending.shift();
if (!taskId) { console.log(JSON.stringify({ ready: false })); process.exit(0); }
queue.active.push(taskId);
fs.writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`);
console.log(JSON.stringify({ ready: true, taskId }));
