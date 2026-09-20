/**
 * atomic-write.ts — atomic full-file rewrite for critical state files.
 *
 * A plain fs.writeFileSync truncates the target in place: a crash, kill, or
 * ENOSPC mid-write leaves a torn JSON/YAML file — state lost with no
 * rollback. This helper instead writes to a uniquely named temp file in the
 * SAME directory as the target, then fs.renameSync over it. Rename within
 * one directory is a same-volume atomic replace (verified on this Windows
 * setup: rename over an existing target succeeds; cross-directory rename is
 * also on the same volume here), so the target ever holds either the old
 * bytes or the complete new bytes — never a half-write.
 *
 * Only node:fs / node:path / node:crypto (built-ins) — no new dependencies.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Atomically write `content` to `filePath` (byte-identical to a direct
 * fs.writeFileSync of the same data/encoding):
 *   1) mkdir -p the target's directory (recursive)
 *   2) writeFileSync to <name>.tmp-<pid>-<random-hex> in the target's dir
 *   3) renameSync the temp over the target
 *
 * If the rename fails, the temp file is unlinked and the original error is
 * rethrown — any previous target content stays intact. A temp-name collision
 * is prevented by the pid + random suffix (parallel writers cannot clobber
 * each other's in-flight temp).
 */
export function atomicWriteFileSync(
  filePath: string,
  content: string | Buffer,
  encoding: BufferEncoding = "utf8",
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const name = path.basename(filePath);
  const tempPath = path.join(dir, `${name}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(tempPath, content, encoding);

  try {
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* temp already gone — nothing left to clean up */
    }
    throw e;
  }
}
