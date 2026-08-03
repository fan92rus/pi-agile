/**
 * git.ts — pure git branch helpers.
 *
 * Fix #3 (hardcoded "main") and #2 (re-delegation of an existing branch must
 * checkout, not fail with "branch already exists"):
 *   - resolveDefaultBranch: detect main|master from `git branch --list`
 *   - branchExistsInList: exact branch-name match in branch list output
 *   - branchCheckoutArgs: plain `checkout` for existing branches, `-b` otherwise
 */

/** Resolve the default branch name from `git branch --list` output. */
export function resolveDefaultBranch(branchList: string): string {
  return /\bmain\b/.test(branchList) ? "main" : "master";
}

/** True when the exact branch name appears in `git branch --list` output. */
export function branchExistsInList(branchList: string, branch: string): boolean {
  if (!branch) return false;
  // Lines look like "* feat/abc" or "  feat/abc" — trim, strip the active marker.
  return branchList.split(/\r?\n/).some((l) => l.trim().replace(/^\*\s*/, "") === branch);
}

/** git args to switch to a branch: plain checkout if it exists, -b to create. */
export function branchCheckoutArgs(exists: boolean, branch: string): string[] {
  return exists ? ["checkout", branch] : ["checkout", "-b", branch];
}
