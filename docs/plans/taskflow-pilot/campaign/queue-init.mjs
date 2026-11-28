#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const [queuePath, ...taskIds] = process.argv.slice(2);
if (!queuePath) throw new Error('usage: queue-init.mjs <queue.json> [task-id ...]');
const queue = { version: 1, pending: [...new Set(taskIds)], active: [], completed: [] };
fs.mkdirSync(path.dirname(path.resolve(queuePath)), { recursive: true });
fs.writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`);
console.log(JSON.stringify(queue));
