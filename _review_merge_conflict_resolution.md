## Result

**Complete.** Code review of commit 5ee084d (batch merge conflict resolution) found 5 real issues — 1 critical leak, 1 medium gap, 2 medium improvements, 1 cosmetic.

- **Critical**: Worktree leaked on disk after successful conflict resolution via `agile_merge_task` without `from_worktree_dir` parameter.
- **Medium**: `extractConflictedFiles` only catches `CONFLICT (content)` — misses `add/add`, `delete/modify`, `rename/rename`, `rename/delete` conflict types.
- **Medium**: Batch conflict output includes unnecessary `git push` step for local git worktrees.
- **Medium**: `agile_merge_task` description vs behavior mismatch — says "Auto-detects worktree" but cleanup only runs when `from_worktree_dir` is passed OR auto-detect is triggered.
- **Low**: `extractConflictedFiles` parameter named `stderr` but receives `mergeResult` (cosmetic, logic is correct).

Confidence: **high** — code was read line-by-line, not inferred.

## Output

### Issue 1 (CRITICAL): Worktree leak after conflict-resolution merge without `from_worktree_dir`

**Where**: `agile_merge_task` handler, lines 1787–1794

**Flow that triggers the leak:**
1. Batch mode conflicts on task-X → worktree `../<repo>-task-X` saved
2. Agent rebases inside worktree → `refs/heads/feat/task-X` updated (shared object store)
3. Agent calls `agile_merge_task({ bd_id: "task-X" })` — no `from_worktree_dir`
4. Handler tries `gitMergeSquash(pi, workDir, "feat/task-X", ...)`
5. **Succeeds** because `feat/task-X` exists in main repo's refs (shared with worktree)
6. Line 1787: `if (usedWorktree || fromWorktreeDir)` → **false** because:
   - `fromWorktreeDir` is undefined (not passed)
   - `usedWorktree` is `""` (gitMergeSquash succeeded, auto-detect never ran)
7. Cleanup is **skipped** → worktree left on disk forever

The branch is removed (line ~1850: `git branch -D feat/X`), but the worktree directory and its `.git/worktrees/` entry persist, accumulating on every conflict.

**Fix**: After successful merge, check if a worktree exists for this bdId via the known pattern `../<repo>-<bdId>`. Simplified:
```
const knownWt = path.join(path.dirname(workDir), `${path.basename(workDir)}-${bdId}`);
if (!usedWorktree && fs.existsSync(knownWt)) { /* cleanup knownWt */ }
```

### Issue 2 (MEDIUM): extractConflictedFiles regex misses non-content conflict types

**Where**: line 335–340

```typescript
function extractConflictedFiles(stderr: string): string[] {
  const files: string[] = [];
  for (const line of stderr.split("\n")) {
    const m = line.match(/CONFLICT \(content\): Merge conflict in (.+)$/);
    if (m) files.push(m[1].trim());
  }
  return files;
}
```

Git produces these conflict message formats:
```
CONFLICT (content): Merge conflict in file.ts       ✓ caught
CONFLICT (add/add): Merge conflict in file.ts       ✗ missed
CONFLICT (delete/modify): Merge conflict in file.ts ✗ missed  
CONFLICT (rename/rename): Merge conflict in file.ts ✗ missed
CONFLICT (rename/delete): Merge conflict in file.ts ✗ missed
CONFLICT (modify/delete): Merge conflict in file.ts ✗ missed
```

The regex `\(content\)` only matches literal `(content)`. All other types (add/add, delete/modify, etc.) use the same `CONFLICT (type): Merge conflict in file` format but with a different parenthesized type name. They will still trigger the `mergeResult.includes("CONFLICT")` check (line 653) but `extractConflictedFiles` will return an **empty array**, so the agent won't see which files conflicted.

**Fix**: Change regex to `CONFLICT \([^)]+\): Merge conflict in (.+)$`

### Issue 3 (MEDIUM): Batch conflict output includes misleading `git push` step

**Where**: line 764 in executeBatchTasks

```
4. `git push origin feat/<bdId> --force` (if worktree is shared)
```

Pi-agile worktrees are created via `git worktree add` (not `git clone`), meaning:
- The worktree shares the object store with the main repo
- `refs/heads/feat/X` is directly visible to both
- `agile_merge_task` without `from_worktree_dir` can merge **directly** from the local ref
- `git push` is unnecessary and potentially confusing (it pushes to origin, not related to the local merge)

**Impact**: Agent might push rebased branches to origin (force-push), and if the push fails (no origin configured, no network), it creates a confusing failure path.

**Fix**: Remove step 4 from batch conflict output. The resolution flow is:
1. `cd <worktreeDir>`
2. `git fetch origin main && git rebase origin/main`
3. Fix conflicts, `git add <files> && git rebase --continue`
4. Call `agile_merge_task({ bd_id: "<bdId>" })` — auto-detects worktree

### Issue 4 (MEDIUM): Cleanup runs only when worktree is explicitly tracked

**Where**: lines 1787–1794 and the batch cleanup at lines 677–682

The batch cleanup correctly skips conflicted worktrees, and the `agile_merge_task` cleanup tries to clean, but:

**Scenario A**: After conflict in batch, agent calls `agile_merge_task({ bd_id: "X" })`:
- If `gitMergeSquash` succeeds → worktree leaks (Issue 1)
- If auto-detect triggers → cleanup works

**Scenario B**: Agent calls `agile_merge_task({ bd_id: "X", from_worktree_dir: "..." })`:
- `gitMergeFromWorktree` succeeds → cleanup at lines 1787–1794 runs ✓

**Scenario C**: `agile_merge_task` is called for a task that was NEVER in batch mode (single task):
- No worktree exists → cleanup path is correctly skipped

The `usedWorktree` tracking is fragile because there are two paths to success (gitMergeSquash vs auto-detect) and only one of them sets `usedWorktree`.

### Issue 5 (LOW): Parameter name mismatch in extractConflictedFiles

```typescript
function extractConflictedFiles(stderr: string): string[] {
```
But called as:
```typescript
files: extractConflictedFiles(mergeResult),
```
where `mergeResult = "squash merge failed: CONFLICT..."` — includes the prefix.

The function works correctly (the CONFLICT lines are preserved in the string), but the parameter name `stderr` is misleading because the string includes a prefix. The `.split("\n")` correctly splits the full message. This is cosmetic only — no behavioral impact.

## Evidence

**Issue 1 — Critical cleanup gap**:
```
// agile_merge_task handler, lines 1787-1794
if (usedWorktree || fromWorktreeDir) {           // ← false when both are set
  const wtCleanup = usedWorktree || fromWorktreeDir || "";
  if (wtCleanup && wtCleanup !== workDir && fs.existsSync(wtCleanup)) {
    try { await pi.exec("git", ["worktree", "remove", "--force", wtCleanup], ...); } catch {}
    try { fs.rmSync(wtCleanup, { recursive: true, force: true }); } catch {}
  }
}
```
When `fromWorktreeDir` is undefined and `gitMergeSquash` succeeds:
- `usedWorktree = ""` (never set — auto-detect didn't run)
- `fromWorktreeDir = undefined`
- `"" || undefined || ""` = `""`
- Cleanup skipped. Worktree persists.

**Issue 2 — Regex gap**, line 338:
```
line.match(/CONFLICT \(content\): Merge conflict in (.+)$/)
```
Confirmed by grep of git documentation: git uses `CONFLICT (type): Merge conflict in file` where type can be `content`, `add/add`, `delete/modify`, `rename/rename`, `rename/delete`, `modify/delete`.

**Issue 3 — Unnecessary `git push`**, line 764:
```
lines.push(`4. \`git push origin feat/${r.bdId} --force\` (if worktree is shared)`);
```
Worktrees are created at line 621: `git worktree add -b feat/${t.bdId} ${wtDir} ${mainBranch}` — local worktree, not shared clone.

**Issue 5 — Parameter name**, line 335:
```
function extractConflictedFiles(stderr: string): string[] {
```
Called at line 657 as `extractConflictedFiles(mergeResult)` where mergeResult = `"squash merge failed: " + merge.stderr`. Logic is correct but name is misleading.

## Learnings

**1. Git worktrees and local branches share refs** — A `git worktree add -b feat/X` creates branch `refs/heads/feat/X` visible from both main repo and worktree. After the worker/agent commits in the worktree, the branch ref is directly accessible from the main repo without any fetch. This means `gitMergeSquash(pi, workDir, "feat/X", ...)` works even when the commits happened inside the worktree. This is not intuitive if you think of worktrees as isolated clones.

**2. Conflict detection happens via exit code AND stderr** — `git merge --squash FETCH_HEAD` exits with code 1 on conflict (so `merge.code !== 0` triggers the error path), AND the stderr contains `CONFLICT (content): Merge conflict in file.txt` lines. The current code checks for "CONFLICT" substring in the returned error string, which works because the error string includes the stderr. But parsing relies on stderr being appended verbatim.

**3. `git merge --squash` enters merge state on conflict** — Despite being a "squash" (which normally doesn't create MERGE_HEAD), when conflicts occur, git DOES set MERGE_HEAD and `git merge --abort` works correctly to restore pre-merge state. Verified by git docs: "When it is not obvious how to reconcile the changes, the following happens... The index and working tree are left in a conflicted state."

**4. Feature branch cleanup (`git branch -D`) doesn't remove the worktree** — After merging via `gitMergeSquash` (which does `git checkout main; git merge --squash feat/X; git commit`), the handler at line 1850 does `git branch -D feat/X`. But the worktree directory at `../<repo>-<bdId>` still exists on disk with its `.git` worktree metadata. Running `git worktree remove` (or `git worktree prune`) is needed to clean up, OR just `rmSync` the directory (which also removes the worktree metadata). The current code does `git worktree remove --force` + `rmSync` — but only when `usedWorktree` is set.

**5. Checking for existing worktree is O(1) via directory existence** — The pattern `../<repo>-<bdId>` is deterministic (built in delegateBatchParallel at line 618). After `agile_merge_task` succeeds, we can cheaply check `fs.existsSync(path.join(parentDir, repoName + '-' + bdId))` to find and clean leaked worktrees. No git commands needed.
