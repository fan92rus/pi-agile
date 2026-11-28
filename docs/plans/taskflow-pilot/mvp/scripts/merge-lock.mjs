import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const WAIT_MS = 5 * 60 * 1000;
const STALE_MS = 10 * 60 * 1000;
const GRACE_MS = 5000;
const OWNER_FILE = 'owner.json';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function removeLock(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function evictStale(dir) {
  // Rename first: only one waiter can win, so no waiter can delete a lock
  // that another process acquired after the stale owner was observed.
  const stalePath = `${dir}.stale-${Date.now()}-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(dir, stalePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  removeLock(stalePath);
  return true;
}

function ownerAlive(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8');
  } catch (error) {
    return error?.code === 'ENOENT' ? 'missing' : null;
  }
  try {
    const owner = JSON.parse(raw);
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  } catch {
    return null;
  }
}

export function releaseLock(lockPath, token) {
  const dir = path.resolve(String(lockPath));
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'));
    if (owner.token !== token) return false;
  } catch {
    // Without a readable owner file we cannot prove ownership; leave the
    // directory for stale eviction instead of deleting another owner's lock.
    return false;
  }
  removeLock(dir);
  return true;
}

/**
 * Serialize phases that touch the shared base repository. The lock is a
 * directory so acquisition is atomic on Windows and POSIX.
 */
export async function withLock(lockPath, fn, options = {}) {
  if (!lockPath) return fn();
  const dir = path.resolve(String(lockPath));
  const waitMs = options.waitMs ?? WAIT_MS;
  const staleMs = options.staleMs ?? STALE_MS;
  const graceMs = options.graceMs ?? GRACE_MS;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const deadline = Date.now() + waitMs;
  let token = '';
  while (true) {
    try {
      fs.mkdirSync(dir);
      token = randomUUID();
      fs.writeFileSync(path.join(dir, OWNER_FILE), `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token })}\n`, 'utf8');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const alive = ownerAlive(dir);
      let age = 0;
      try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch { age = STALE_MS; }
      // A live owner must never be evicted, no matter how long the phase runs.
      // A dead owner can be evicted right away: no live phase holds the lock.
      if (alive === false && age > graceMs) {
        evictStale(dir);
        continue;
      }
      // A missing owner file is only a problem if it never appeared; wait for
      // the stale timeout so a just-created lock is not stolen.
      if (alive === 'missing' && age > staleMs) {
        evictStale(dir);
        continue;
      }
      // An unreadable owner file is never evicted: another live owner may
      // have it open. `missing` is handled above only after the stale timeout.
      if (alive === null) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for merge lock: ${dir}`);
        await sleep(100);
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for merge lock: ${dir}`);
      await sleep(100);
    }
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseLock(dir, token);
  };
  // Scripts in this pilot call process.exit directly; an exit handler is the
  // only way to release the lock on both success and failure paths.
  process.on('exit', release);
  try {
    return await fn();
  } finally {
    release();
    process.off('exit', release);
  }
}
