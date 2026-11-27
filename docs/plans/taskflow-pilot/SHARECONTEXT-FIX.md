# shareContext: root cause and applied fix (2026-11-27)

## Symptom

Any flow with `shareContext: true` (or flow-level `contextSharing: true`) fails before execution:

```text
Taskflow '<name>' workspace capability initialization failed:
TFWS_MUTEX_IDENTITY: queue anchor is missing or invalid
```

The failure happens in `createResolveOnlyWorkspaceSession` → `ResolveOnlyWorkspaceSessionImpl.initialize()` → `PersistentLeaseCoordinator` → `PersistentFileMutex.acquire()` → `bindMutexQueue()`.

## Root cause

`taskflow-core@1.0.0` `mutex-bootstrap.js` validates a persisted bootstrap "intent" with:

```js
Number.isSafeInteger(v.dev) && Number.isSafeInteger(v.ino) && v.dev >= 0 && v.ino > 0
```

On this Windows host the control directory (`C:/Users/user/.taskflow/workspace-control/<root-token>`) has an inode such as `33214047252244250`, which is greater than `Number.MAX_SAFE_INTEGER` (`9007199254740991`). JSON parsing rounds it, so `Number.isSafeInteger` is false and every freshly written intent is rejected as `invalid bootstrap intent`. `acquire()` wraps that `ENOENT` as `queue anchor is missing or invalid`.

The control directory is fixed by `os.homedir() + .taskflow/workspace-control/<stableRootToken>`; the flow cannot relocate it. `D:` inodes happen to fit, but `C:` does not.

## Applied fix

Patched the installed `taskflow-core` (not the repository):

- `dist/resources/mutex-bootstrap.js`
  - `same()` and `directoryIdentity()` compare/store `dev`/`ino` as decimal strings;
  - `read()` normalizes file identity to strings;
  - `identity()` accepts numeric **or string** decimal values and validates them with `BigInt`.
- `dist/resources/persistence.js`
  - `sameIdentity()` compares `dev`/`ino` via `String()`.

The exact diff is in `sharecontext-fix.patch`. Backups of the originals are at `D:/tmp/mutex-bootstrap.js.bak` and `D:/tmp/persistence.js.bak`.

Before applying the patch, the orphaned `*.initializing` / `*.staging-*` files in the `29eefa...` control directory were removed (backup at `D:/tmp/tfws-control-backup-29e`).

## Verification

In a fresh Node process, after the patch:

```text
PersistentFileMutex.runExclusive(...): HELD-AND-RELEASED
queue/.identity and queue/.initialized created
createResolveOnlyWorkspaceSession(...): module import blocked only by unrelated missing 'typebox' in standalone Node
```

The mutex bootstrap step — the exact step that produced `TFWS_MUTEX_IDENTITY` — now succeeds.

## Important limitation

The currently running Pi/taskflow host process imported `taskflow-core` before the patch; ESM module cache cannot be refreshed in-place. A **Pi restart is required** before `taskflow` tool calls will use the patched code. The next step after restart is to re-run `ctx-repair-probe` with `shareContext: true` and confirm `ctx_write`/`ctx_read`.

An npm/pnpm reinstall of `taskflow-core` will revert the patch; reapply `sharecontext-fix.patch` then.

## Upstream PR

The same fix was prepared against the upstream TypeScript sources in `heggria/taskflow` and submitted from the fork `fan92rus/taskflow`:

- PR: https://github.com/heggria/taskflow/pull/218
- fork branch: `fix/windows-inode-identity`
- commit: `dbc924a`

`pnpm typecheck` is clean and the added regression test passes. The full `mutex-bootstrap.test.ts` suite was timing-flaky on this Windows host; the PR states this explicitly.
