#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  if (result.error) throw result.error;
  return result;
}
function git(cwd, args, check = true) {
  const result = run("git", args, { cwd });
  if (check && result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed (${result.status})`);
  return result;
}
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
    const key = argv[i].slice(2);
    if (key === "help") { opts.help = true; continue; }
    if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`missing value for --${key}`);
    opts[key] = argv[++i];
  }
  return opts;
}
function output(status, data) { process.stdout.write(JSON.stringify(data) + "\n"); process.exitCode = status; }

export async function mergeBranch(options) {
  const main = path.resolve(options.mainDir || process.cwd());
  const worktree = path.resolve(options.worktree || "");
  const branch = options.branch;
  const mainBranch = options.mainBranch || git(main, ["branch", "--show-current"]).stdout.trim();
  const approvedSha = options.approvedSha;
  if (!worktree || !branch || !mainBranch || !approvedSha || !options.testCommand) throw new Error("required: --worktree --branch --approved-sha --test-command (integration branch must be checked out)");
  // Only the tracked bd export is an allowed pre-flight dirt exception.
  const dirty = git(main, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim().split("\n").filter(Boolean);
  if (dirty.length) {
    if (dirty.every((line) => line.slice(3) === ".beads/issues.jsonl")) {
      git(main, ["add", ".beads/issues.jsonl"]);
      git(main, ["commit", "-m", "chore(bd): auto-commit claim-dirt export (merge pre-flight)"]);
      if (git(main, ["status", "--porcelain", "--", ".beads/issues.jsonl"]).stdout.trim()) throw new Error("claim-dirt auto-commit failed: .beads/issues.jsonl still dirty");
    } else throw new Error(`main working copy dirty: ${dirty.join(", ")}`);
  }
  const statePath = path.resolve(worktree, git(worktree, ["rev-parse", "--git-path", "merge-branch-resume.json"]).stdout.trim());
  let resuming = false;
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (state.approvedSha !== approvedSha || state.branch !== branch || state.mainBranch !== mainBranch) throw new Error("resume state does not match this merge request");
    const rebaseMerge = path.resolve(worktree, git(worktree, ["rev-parse", "--git-path", "rebase-merge"]).stdout.trim());
    const rebaseApply = path.resolve(worktree, git(worktree, ["rev-parse", "--git-path", "rebase-apply"]).stdout.trim());
    if (git(worktree, ["status", "--porcelain"]).stdout.trim() || fs.existsSync(rebaseMerge) || fs.existsSync(rebaseApply)) throw new Error("rebase is not finished; resolve conflicts and run git rebase --continue");
    const current = git(worktree, ["rev-parse", "HEAD"]).stdout.trim();
    if (current === state.collapsedSha || git(worktree, ["rev-list", "--count", `${mainBranch}..HEAD`]).stdout.trim() !== "1") throw new Error("resume requires the completed rebased branch commit");
    resuming = true;
  } else {
    const sha = git(main, ["rev-parse", branch]).stdout.trim();
    if (sha !== approvedSha) throw new Error(`branch moved after review: ${sha}`);
    const base = git(worktree, ["merge-base", mainBranch, branch]).stdout.trim();
    git(worktree, ["reset", "--soft", base]);
    git(worktree, ["commit", "-m", options.message || `feat: ${branch}`]);
  }
  const rebased = resuming ? { status: 0 } : git(worktree, ["rebase", mainBranch], false);
  if (rebased.status !== 0) {
    const conflicts = git(worktree, ["diff", "--name-only", "--diff-filter=U"], false).stdout.trim().split("\n").filter(Boolean);
    if (conflicts.length) {
      const collapsedSha = git(worktree, ["rev-parse", "HEAD"]).stdout.trim();
      fs.writeFileSync(statePath, JSON.stringify({ approvedSha, branch, mainBranch, collapsedSha }));
      return { status: 2, data: { conflictFiles: conflicts, worktree, branch, approvedSha } };
    }
    throw new Error(rebased.stderr.trim() || "rebase failed without conflicts");
  }
  if (resuming) fs.rmSync(statePath, { force: true });
  const worktreeStatus = git(worktree, ["status", "--porcelain"]).stdout.trim();
  const pending = git(worktree, ["rebase", "--show-current-patch"], false);
  if (worktreeStatus || pending.status === 0) throw new Error("worktree is not clean after rebase");
  const commits = git(worktree, ["rev-list", "--count", `${mainBranch}..${branch}`]).stdout.trim();
  if (commits !== "1") throw new Error(`expected one approved branch commit after rebase, got ${commits}`);
  git(main, ["merge", "--squash", branch]);
  const staged = git(main, ["diff", "--cached", "--check"], false);
  if (staged.status !== 0 || !git(main, ["diff", "--cached", "--stat"]).stdout.trim()) throw new Error("squash is empty or has whitespace errors");
  if (options.sddFile && options.sddItem) {
    const sddPath = path.resolve(main, options.sddFile);
    const source = fs.readFileSync(sddPath, "utf8");
    const unchecked = String(options.sddItem).replace("[x]", "[ ]");
    const checked = unchecked.replace("[ ]", "[x]");
    if (source.includes(unchecked)) {
      fs.writeFileSync(sddPath, source.replace(unchecked, checked));
      git(main, ["add", options.sddFile]);
    }
  }
  const suite = run(options.testCommand, [], { cwd: main, shell: true });
  if (suite.status !== 0) { git(main, ["reset", "--hard", "HEAD"]); throw new Error(`testCommand failed (${suite.status}): ${suite.stderr || suite.stdout}`); }
  git(main, ["commit", "-m", options.message || `feat: ${branch}`]);
  const mergeCommit = git(main, ["rev-parse", "HEAD"]).stdout.trim();
  let journalWritten = false;
  if (options.journalFile) {
    const journal = path.resolve(main, options.journalFile);
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.appendFileSync(journal, JSON.stringify({ task: options.taskTitle || branch, verdict: "merged", branch, head: approvedSha, note: "deterministic CLI merge" }) + "\n");
    journalWritten = true;
  }
  let bdClosed = false;
  if (options.bdLeaf) {
    // bd closure is post-merge bookkeeping: it must never turn a committed merge
    // into a failed merge response when bd is unavailable or its state is broken.
    try {
      const existing = run("bd", ["show", options.bdLeaf, "--json"], { cwd: main });
      let alreadyClosed = false;
      if (existing.status === 0) { try { alreadyClosed = JSON.parse(existing.stdout).status === "closed"; } catch {} }
      if (alreadyClosed) bdClosed = true;
      else {
        const close = run("bd", ["close", options.bdLeaf, "-r", `${options.bdLeaf}: merge ${mergeCommit} - merged`], { cwd: main });
        if (close.status === 0) {
          // Some repos intentionally keep the bd database out of git. Determine that
          // from the actual path state, not a project setting: ignored or untracked
          // exports have nothing safe/useful to commit.
          const ignored = git(main, ["check-ignore", "-q", ".beads/issues.jsonl"], false).status === 0;
          const tracked = git(main, ["ls-files", "--error-unmatch", ".beads/issues.jsonl"], false).status === 0;
          if (ignored || !tracked) bdClosed = true;
          else if (run("bd", ["export"], { cwd: main }).status === 0) {
            try {
              git(main, ["add", ".beads/issues.jsonl"]);
              git(main, ["commit", "-m", `chore(bd): auto-close done leaf (${options.bdLeaf})`]);
              bdClosed = !git(main, ["status", "--porcelain", "--", ".beads/issues.jsonl"]).stdout.trim();
            } catch { bdClosed = false; }
          }
        }
      }
    } catch { bdClosed = false; }
  }
  git(main, ["worktree", "remove", worktree]);
  return { status: 0, data: { merged: true, checksOk: true, journalWritten, mergeCommit, bdClosed, note: "" } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { console.log("merge-branch --main-dir DIR --main-branch NAME --worktree DIR --branch NAME --approved-sha SHA --test-command COMMAND [--bd-leaf ID]"); }
    else {
      const result = await mergeBranch({ mainDir: args["main-dir"], mainBranch: args["main-branch"], worktree: args.worktree, branch: args.branch, approvedSha: args["approved-sha"], testCommand: args["test-command"], bdLeaf: args["bd-leaf"], message: args.message, journalFile: args["journal-file"], taskTitle: args["task-title"], sddFile: args["sdd-file"], sddItem: args["sdd-item"] });
      output(result.status, result.data);
    }
  } catch (error) { output(1, { error: error.message }); }
}
