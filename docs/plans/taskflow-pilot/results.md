# Pilot results (draft; driver appends gate outcome and metrics)

base: 9d5840b6cff6318c3e0496fb1dfbadce4e31df52

baseline tests:

> pi-agile@0.1.0 test
> node --test tests/agile-loop.test.mjs tests/pi-agile-tools.test.mjs

TAP version 13
# Subtest: happy path: 1 task -> worktree isolation even solo, merge preflight + journal head
ok 1 - happy path: 1 task -> worktree isolation even solo, merge preflight + journal head
  ---
  duration_ms: 17.1
  type: 'test'
  ...
# Subtest: workModel/reviewModel: role-split models reach the right children; merge stays on top model
ok 2 - workModel/reviewModel: role-split models reach the right children; merge stays on top model
  ---
  duration_ms: 8.205
  type: 'test'
  ...
# Subtest: single-model degradation: workModel === reviewModel warns and degrades instead of throwing
ok 3 - single-model degradation: workModel === reviewModel warns and degrades instead of throwing
  ---
  duration_ms: 2.6002
  type: 'test'
  ...
# Subtest: manifest: actor-reported ABSOLUTE worktree accepted only with the deterministic basename
ok 4 - manifest: actor-reported ABSOLUTE worktree accepted only with the deterministic basename
  ---
  duration_ms: 4.9729
  type: 'test'
  ...
# Subtest: forced SDD failure stops the campaign instead of degrading to bare work
ok 5 - forced SDD failure stops the campaign instead of degrading to bare work
  ---
  duration_ms: 4.6972
  type: 'test'
  ...
# Subtest: approval-required: approved_by_caller=false -> no workers, no review, no merge
ok 6 - approval-required: approved_by_caller=false -> no workers, no review, no merge
  ---
  duration_ms: 1.0881
  type: 'test'
  ...
# Subtest: transport retry: retried with suffixed key, non-blocking (sibling lane progresses during wait)
ok 7 - transport retry: retried with suffixed key, non-blocking (sibling lane progresses during wait)
  ---
  duration_ms: 51.4085
  type: 'test'
  ...
# Subtest: schema-missing: NO re-brief (single work launch), flow degrades to arbiter, drop via mergeChain
ok 8 - schema-missing: NO re-brief (single work launch), flow degrades to arbiter, drop via mergeChain
  ---
  duration_ms: 3.432
  type: 'test'
  ...
# Subtest: review schema-miss: ONE re-run of the same review with a reminder, ok on the retry -> merged, zero rework
ok 9 - review schema-miss: ONE re-run of the same review with a reminder, ok on the retry -> merged, zero rework
  ---
  duration_ms: 2.8281
  type: 'test'
  ...
# Subtest: review schema-miss twice: exactly two review launches, zero rework/review-r, verdict failed with class review-schema-miss
ok 10 - review schema-miss twice: exactly two review launches, zero rework/review-r, verdict failed with class review-schema-miss
  ---
  duration_ms: 2.2659
  type: 'test'
  ...
# Subtest: review approved:false is a verdict, not a schema-miss: no re-run, rework as before
ok 11 - review approved:false is a verdict, not a schema-miss: no re-run, rework as before
  ---
  duration_ms: 2.278
  type: 'test'
  ...
# Subtest: arbiter merge-as-is: orchestrator merges via mergeChain (serialized), verdict merged-after-arbitration
ok 12 - arbiter merge-as-is: orchestrator merges via mergeChain (serialized), verdict merged-after-arbitration
  ---
  duration_ms: 79.766
  type: 'test'
  ...
# Subtest: supervisor-unavailable fallback: decision=needs-attention holds the branch (no drop, no pool walk)
ok 13 - supervisor-unavailable fallback: decision=needs-attention holds the branch (no drop, no pool walk)
  ---
  duration_ms: 1.0495
  type: 'test'
  ...
# Subtest: one-more-round guard: at most ONE arbiter-granted extra round; a repeated request holds as needs-attention (no drop)
ok 14 - one-more-round guard: at most ONE arbiter-granted extra round; a repeated request holds as needs-attention (no drop)
  ---
  duration_ms: 1.0674
  type: 'test'
  ...
# Subtest: K1: failed leftovers and needs-attention holds are kept for the lead - NO final cleanup child, return.keptBranches names both
ok 15 - K1: failed leftovers and needs-attention holds are kept for the lead - NO final cleanup child, return.keptBranches names both
  ---
  duration_ms: 1.3223
  type: 'test'
  ...
# Subtest: K1: merge-failed and failed leaves are kept - no cleanup child, both branches named in return.keptBranches
ok 16 - K1: merge-failed and failed leaves are kept - no cleanup child, both branches named in return.keptBranches
  ---
  duration_ms: 2.5087
  type: 'test'
  ...
# Subtest: K1: a main-copy incident (main-mutated) keeps the branch - no cleanup child, return.keptBranches names it
ok 17 - K1: a main-copy incident (main-mutated) keeps the branch - no cleanup child, return.keptBranches names it
  ---
  duration_ms: 1.3687
  type: 'test'
  ...
# Subtest: K1: keptBranches excludes merged work and the explicit drop-branch decision (the only engine deletion) - the drop still executes
ok 18 - K1: keptBranches excludes merged work and the explicit drop-branch decision (the only engine deletion) - the drop still executes
  ---
  duration_ms: 1.2048
  type: 'test'
  ...
# Subtest: K2: a merged branch the merger did not delete (branch_deleted=false) stays in return.keptBranches with verdict merged - the merge stands
ok 19 - K2: a merged branch the merger did not delete (branch_deleted=false) stays in return.keptBranches with verdict merged - the merge stands
  ---
  duration_ms: 0.8019
  type: 'test'
  ...
# Subtest: arbiter pool: author glm with an alternative in the pool -> the arbiter is NOT the author's model
ok 20 - arbiter pool: author glm with an alternative in the pool -> the arbiter is NOT the author's model
  ---
  duration_ms: 1.1257
  type: 'test'
  ...
# Subtest: arbiter pool: a single model in the pool is the arbiter - no error, no block
ok 21 - arbiter pool: a single model in the pool is the arbiter - no error, no block
  ---
  duration_ms: 0.973
  type: 'test'
  ...
# Subtest: arbiter pool: 403 on the first arbiter -> the second arbiter call goes to the next pool model
ok 22 - arbiter pool: 403 on the first arbiter -> the second arbiter call goes to the next pool model
  ---
  duration_ms: 1.7923
  type: 'test'
  ...
# Subtest: arbiter pool exhausted: every pool model overloaded -> verdict arbiter-failed (as before)
ok 23 - arbiter pool exhausted: every pool model overloaded -> verdict arbiter-failed (as before)
  ---
  duration_ms: 1.214
  type: 'test'
  ...
# Subtest: escalate-ledger: repair ceremony updates the approved head; merge uses the repair head
ok 24 - escalate-ledger: repair ceremony updates the approved head; merge uses the repair head
  ---
  duration_ms: 3.2148
  type: 'test'
  ...
# Subtest: escalate-ledger: repair completed=false -> verdict failed, NO review child
ok 25 - escalate-ledger: repair completed=false -> verdict failed, NO review child
  ---
  duration_ms: 1.0902
  type: 'test'
  ...
# Subtest: work completed=false -> verdict failed, NO review child, campaign continues
ok 26 - work completed=false -> verdict failed, NO review child, campaign continues
  ---
  duration_ms: 0.839
  type: 'test'
  ...
# Subtest: rework completed=false -> no second review child, verdict failed, campaign continues
ok 27 - rework completed=false -> no second review child, verdict failed, campaign continues
  ---
  duration_ms: 0.973
  type: 'test'
  ...
# Subtest: contract pre-check: header/files_hint names a file the branch never touched -> verdict failed, NO review child
ok 28 - contract pre-check: header/files_hint names a file the branch never touched -> verdict failed, NO review child
  ---
  duration_ms: 1.2256
  type: 'test'
  ...
# Subtest: contract pre-check: a named file the branch DID touch passes; a contract naming no file is not checked
ok 29 - contract pre-check: a named file the branch DID touch passes; a contract naming no file is not checked
  ---
  duration_ms: 1.277
  type: 'test'
  ...
# Subtest: rework schema-missing salvage reports completed=false -> verdict failed, no review child
ok 30 - rework schema-missing salvage reports completed=false -> verdict failed, no review child
  ---
  duration_ms: 1.0784
  type: 'test'
  ...
# Subtest: rework acceptance-rejected after salvage already used -> verdict failed, NO second review child
ok 31 - rework acceptance-rejected after salvage already used -> verdict failed, NO second review child
  ---
  duration_ms: 0.9241
  type: 'test'
  ...
# Subtest: provider overload (429): fail-fast retry-needed, no attempts burned
ok 32 - provider overload (429): fail-fast retry-needed, no attempts burned
  ---
  duration_ms: 0.9328
  type: 'test'
  ...
# Subtest: transport failure: bounded retries then transport-unrecovered
ok 33 - transport failure: bounded retries then transport-unrecovered
  ---
  duration_ms: 19.7502
  type: 'test'
  ...
# Subtest: message matching both schema and transport classes is schema-missing (no re-brief)
ok 34 - message matching both schema and transport classes is schema-missing (no re-brief)
  ---
  duration_ms: 1.1582
  type: 'test'
  ...
# Subtest: rec.head refresh: head-less work report -> schema-missing salvage -> review rejects -> rework head becomes THE approved head (kills 'branch head moved')
ok 35 - rec.head refresh: head-less work report -> schema-missing salvage -> review rejects -> rework head becomes THE approved head (kills 'branch head moved')
  ---
  duration_ms: 3.0159
  type: 'test'
  ...
# Subtest: head-SHA binding: schema requires head; review and merge briefs carry the approved head
ok 36 - head-SHA binding: schema requires head; review and merge briefs carry the approved head
  ---
  duration_ms: 0.7492
  type: 'test'
  ...
# Subtest: rework updates the approved head before the next review/merge
ok 37 - rework updates the approved head before the next review/merge
  ---
  duration_ms: 0.8846
  type: 'test'
  ...
# Subtest: fix-only rework: structured fix_list -> rework brief carries ONLY the listed fixes + scope guard + full gate
ok 38 - fix-only rework: structured fix_list -> rework brief carries ONLY the listed fixes + scope guard + full gate
  ---
  duration_ms: 1.026
  type: 'test'
  ...
# Subtest: fix-only rework: empty or malformed fix_list falls back to the legacy full rework brief
ok 39 - fix-only rework: empty or malformed fix_list falls back to the legacy full rework brief
  ---
  duration_ms: 2.7097
  type: 'test'
  ...
# Subtest: contract: REVIEW_SCHEMA carries optional fix_list ({file,fix} items); reviewer brief announces the channel
ok 40 - contract: REVIEW_SCHEMA carries optional fix_list ({file,fix} items); reviewer brief announces the channel
  ---
  duration_ms: 0.9844
  type: 'test'
  ...
# Subtest: contract: review brief carries the runtime-boundary rule (harness-green is not production evidence)
ok 41 - contract: review brief carries the runtime-boundary rule (harness-green is not production evidence)
  ---
  duration_ms: 1.3683
  type: 'test'
  ...
# Subtest: contract: work/rework/repair briefs carry the no-scratch-debug diagnostic rule
ok 42 - contract: work/rework/repair briefs carry the no-scratch-debug diagnostic rule
  ---
  duration_ms: 3.608
  type: 'test'
  ...
# Subtest: contract: work, rework and review briefs carry the edit-failure rule (first failure reads the whole file, second overwrites via write, third stops)
ok 43 - contract: work, rework and review briefs carry the edit-failure rule (first failure reads the whole file, second overwrites via write, third stops)
  ---
  duration_ms: 2.2319
  type: 'test'
  ...
# Subtest: ISSUE-7 contract: work/rework/report-repair/repair briefs run the gate as env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH <testCommand>
ok 44 - ISSUE-7 contract: work/rework/report-repair/repair briefs run the gate as env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH <testCommand>
  ---
  duration_ms: 3.4873
  type: 'test'
  ...
# Subtest: merged:true with checks_ok:false is NOT a merged verdict
ok 45 - merged:true with checks_ok:false is NOT a merged verdict
  ---
  duration_ms: 1.052
  type: 'test'
  ...
# Subtest: parallel mode: multi-task wave briefs use worktrees
ok 46 - parallel mode: multi-task wave briefs use worktrees
  ---
  duration_ms: 1.0482
  type: 'test'
  ...
# Subtest: report-repair: schema-missing after work -> ONE report-recovery child, merge uses recovered head
ok 47 - report-repair: schema-missing after work -> ONE report-recovery child, merge uses recovered head
  ---
  duration_ms: 2.4568
  type: 'test'
  ...
# Subtest: report-repair: semantic schema-missing after work also salvages - no re-brief, structured contract taught (no fence)
ok 48 - report-repair: semantic schema-missing after work also salvages - no re-brief, structured contract taught (no fence)
  ---
  duration_ms: 1.0978
  type: 'test'
  ...
# Subtest: rework salvage: rework child rejected on report shape -> ONE salvage child, re-review proceeds, no re-implementation
ok 49 - rework salvage: rework child rejected on report shape -> ONE salvage child, re-review proceeds, no re-implementation
  ---
  duration_ms: 1.1092
  type: 'test'
  ...
# Subtest: report-repair failure fails the task fast (exactly one repair attempt, no review burn)
ok 50 - report-repair failure fails the task fast (exactly one repair attempt, no review burn)
  ---
  duration_ms: 0.9138
  type: 'test'
  ...
# Subtest: checkpoint: phases running->completed, generation 1, counters on the happy path
ok 51 - checkpoint: phases running->completed, generation 1, counters on the happy path
  ---
  duration_ms: 0.6925
  type: 'test'
  ...
# Subtest: resume reconcile: interrupted older-generation checkpoint is marked, generation ++, allowances carried
ok 52 - resume reconcile: interrupted older-generation checkpoint is marked, generation ++, allowances carried
  ---
  duration_ms: 1.1712
  type: 'test'
  ...
# Subtest: blocked status: approval-required -> status blocked, counters reported
ok 53 - blocked status: approval-required -> status blocked, counters reported
  ---
  duration_ms: 0.5538
  type: 'test'
  ...
# Subtest: overload retry-needed: checkpoint records the wait reason
ok 54 - overload retry-needed: checkpoint records the wait reason
  ---
  duration_ms: 0.7573
  type: 'test'
  ...
# Subtest: shared queue (work-stealing): a short task never waits behind a striped lane-mate
ok 55 - shared queue (work-stealing): a short task never waits behind a striped lane-mate
  ---
  duration_ms: 122.6607
  type: 'test'
  ...
# Subtest: postPhase backlog cap: reviews bounded by post slots; work queue never blocked
ok 56 - postPhase backlog cap: reviews bounded by post slots; work queue never blocked
  ---
  duration_ms: 77.9336
  type: 'test'
  ...
# Subtest: review reserve: no work child starts inside the last 20 min, landed work still gets its review
ok 57 - review reserve: no work child starts inside the last 20 min, landed work still gets its review
  ---
  duration_ms: 46.6693
  type: 'test'
  ...
# Subtest: one slot per leaf: a leaf never runs two children at once; the next leaf waits for a freed post slot
ok 58 - one slot per leaf: a leaf never runs two children at once; the next leaf waits for a freed post slot
  ---
  duration_ms: 95.1661
  type: 'test'
  ...
# Subtest: budget stop reports needsReview: landed work without a verdict, with its branch
ok 59 - budget stop reports needsReview: landed work without a verdict, with its branch
  ---
  duration_ms: 32.0151
  type: 'test'
  ...
# Subtest: paired wave: sibling merge lands during a work child's life - that child still passes acceptance
ok 60 - paired wave: sibling merge lands during a work child's life - that child still passes acceptance
  ---
  duration_ms: 1.3422
  type: 'test'
  ...
# Subtest: merger pre-flight under parallelism: 3-wide wave merges never overlap and each merger preflights main
ok 61 - merger pre-flight under parallelism: 3-wide wave merges never overlap and each merger preflights main
  ---
  duration_ms: 75.2693
  type: 'test'
  ...
# Subtest: relay workModel: the ceremony launch spec carries workModel, not the top model
ok 62 - relay workModel: the ceremony launch spec carries workModel, not the top model
  ---
  duration_ms: 1.004
  type: 'test'
  ...
# Subtest: npm bootstrap: ci only when node_modules missing or lockfile newer
ok 63 - npm bootstrap: ci only when node_modules missing or lockfile newer
  ---
  duration_ms: 0.7307
  type: 'test'
  ...
# Subtest: per-model cap: 3 same-model work children, cap 2 -> third starts only after a slot frees
ok 64 - per-model cap: 3 same-model work children, cap 2 -> third starts only after a slot frees
  ---
  duration_ms: 91.0974
  type: 'test'
  ...
# Subtest: per-model cap 3 with maxParallel 3: no artificial serialization
ok 65 - per-model cap 3 with maxParallel 3: no artificial serialization
  ---
  duration_ms: 47.3812
  type: 'test'
  ...
# Subtest: per-model cap keys by model: review (other model) overlaps saturated work model
ok 66 - per-model cap keys by model: review (other model) overlaps saturated work model
  ---
  duration_ms: 187.1253
  type: 'test'
  ...
# Subtest: modelLadder: overload on primary -> next attempt on the ladder model
ok 67 - modelLadder: overload on primary -> next attempt on the ladder model
  ---
  duration_ms: 15.568
  type: 'test'
  ...
# Subtest: modelLadder exhausted -> fail-fast wait records lastModel
ok 68 - modelLadder exhausted -> fail-fast wait records lastModel
  ---
  duration_ms: 1.4942
  type: 'test'
  ...
# Subtest: modelLadder for review children never ladders onto the work model
ok 69 - modelLadder for review children never ladders onto the work model
  ---
  duration_ms: 3.2478
  type: 'test'
  ...
# Subtest: runtime usageBudget rejection: terminal, no retry, no ladder, partial with reason
ok 70 - runtime usageBudget rejection: terminal, no retry, no ladder, partial with reason
  ---
  duration_ms: 1.1102
  type: 'test'
  ...
# Subtest: budget classification beats transport look-alikes
ok 71 - budget classification beats transport look-alikes
  ---
  duration_ms: 1.0046
  type: 'test'
  ...
# Subtest: no-code analysis leaf (marker in rationale, artifact in ignored path): work+review pass, empty diff not rejected, merged no-code with bd close and no git commit
ok 72 - no-code analysis leaf (marker in rationale, artifact in ignored path): work+review pass, empty diff not rejected, merged no-code with bd close and no git commit
  ---
  duration_ms: 1.8703
  type: 'test'
  ...
# Subtest: K2: no-code merged deletes its own branch - brief gates on git cherry and git branch -D; a deleted branch is not kept
ok 73 - K2: no-code merged deletes its own branch - brief gates on git cherry and git branch -D; a deleted branch is not kept
  ---
  duration_ms: 1.0916
  type: 'test'
  ...
# Subtest: no-code analysis: a missing artifact is rejected by the reviewer and the no-code merge never runs
ok 74 - no-code analysis: a missing artifact is rejected by the reviewer and the no-code merge never runs
  ---
  duration_ms: 1.0254
  type: 'test'
  ...
# Subtest: plain leaf with an empty diff keeps the empty-diff rejection and the merge-branch CLI (no marker)
ok 75 - plain leaf with an empty diff keeps the empty-diff rejection and the merge-branch CLI (no marker)
  ---
  duration_ms: 0.8054
  type: 'test'
  ...
# Subtest: no-code marker past the first 300 chars of the description does not select the analysis path
ok 76 - no-code marker past the first 300 chars of the description does not select the analysis path
  ---
  duration_ms: 0.8516
  type: 'test'
  ...
# Subtest: toy-falcon bd-epic: snapshot tasks, deps respected, curator/discovery skipped
ok 77 - toy-falcon bd-epic: snapshot tasks, deps respected, curator/discovery skipped
  ---
  duration_ms: 2.615
  type: 'test'
  ...
# Subtest: toy-falcon sprint-1 start: args.bdTasks snapshot -> first child is work (NO initial boundary); empty snapshot -> boundary starts
ok 78 - toy-falcon sprint-1 start: args.bdTasks snapshot -> first child is work (NO initial boundary); empty snapshot -> boundary starts
  ---
  duration_ms: 3.6315
  type: 'test'
  ...
# Subtest: toy-falcon doneWhen: closed epic costs zero children
ok 79 - toy-falcon doneWhen: closed epic costs zero children
  ---
  duration_ms: 2.3348
  type: 'test'
  ...
# Subtest: toy-falcon growth: bd-cursor refresh picks up a new leaf mid-campaign
ok 80 - toy-falcon growth: bd-cursor refresh picks up a new leaf mid-campaign
  ---
  duration_ms: 1.2607
  type: 'test'
  ...
# Subtest: toy-falcon stale cursor: merged leaves never re-run when snapshot lags the driver
ok 81 - toy-falcon stale cursor: merged leaves never re-run when snapshot lags the driver
  ---
  duration_ms: 1.6302
  type: 'test'
  ...
# Subtest: toy-falcon П6: visual-criterion leaf without measure is NOT issued (CRITERION-NOT-MEASURABLE in the report); plain leaf unchanged
ok 82 - toy-falcon П6: visual-criterion leaf without measure is NOT issued (CRITERION-NOT-MEASURABLE in the report); plain leaf unchanged
  ---
  duration_ms: 1.4735
  type: 'test'
  ...
# Subtest: toy-falcon П6: visual-criterion leaf WITH measure is issued; the reviewer brief carries the measurement method
ok 83 - toy-falcon П6: visual-criterion leaf WITH measure is issued; the reviewer brief carries the measurement method
  ---
  duration_ms: 1.3234
  type: 'test'
  ...
# Subtest: toy-falcon end-race: last leaf merged but snapshot lags -> epic-closed, one extra cursor child
ok 84 - toy-falcon end-race: last leaf merged but snapshot lags -> epic-closed, one extra cursor child
  ---
  duration_ms: 1.6191
  type: 'test'
  ...
# Subtest: toy-falcon empty sprint: sprint 1 all failed -> NO sprint-2 boundary (no refresh, nothing janitored), the snapshot is reused, the failed leaf is retried and kept
ok 85 - toy-falcon empty sprint: sprint 1 all failed -> NO sprint-2 boundary (no refresh, nothing janitored), the snapshot is reused, the failed leaf is retried and kept
  ---
  duration_ms: 1.5391
  type: 'test'
  ...
# Subtest: toy-falcon merge: sprint 1 merged a leaf -> sprint 2 launches the bd-cursor refresh
ok 86 - toy-falcon merge: sprint 1 merged a leaf -> sprint 2 launches the bd-cursor refresh
  ---
  duration_ms: 1.2288
  type: 'test'
  ...
# Subtest: claim-dirt: merge preflight auto-commits .beads/issues.jsonl instead of refusing; other dirt still refuses
ok 87 - claim-dirt: merge preflight auto-commits .beads/issues.jsonl instead of refusing; other dirt still refuses
  ---
  duration_ms: 0.7658
  type: 'test'
  ...
# Subtest: claim-dirt: drop preflight carries the same exception (drop is blocked by the same porcelain)
ok 88 - claim-dirt: drop preflight carries the same exception (drop is blocked by the same porcelain)
  ---
  duration_ms: 1.0672
  type: 'test'
  ...
# Subtest: claim-dirt FAIL-SAFE: merger reports the failure contract (auto-commit left the path dirty) -> merged=false lands as merge-failed, never merged, no retry hides it
ok 89 - claim-dirt FAIL-SAFE: merger reports the failure contract (auto-commit left the path dirty) -> merged=false lands as merge-failed, never merged, no retry hides it
  ---
  duration_ms: 0.8653
  type: 'test'
  ...
# Subtest: claim-dirt FAIL-SAFE: drop executor reports the same failure contract -> dropped=false lands as drop-failed, branch left for manual review
ok 90 - claim-dirt FAIL-SAFE: drop executor reports the same failure contract -> dropped=false lands as drop-failed, branch left for manual review
  ---
  duration_ms: 2.1307
  type: 'test'
  ...
# Subtest: merge child hard failure -> merged=false (verdict merge-failed), sibling still merges, campaign completes
ok 91 - merge child hard failure -> merged=false (verdict merge-failed), sibling still merges, campaign completes
  ---
  duration_ms: 1.1616
  type: 'test'
  ...
# Subtest: ISSUE-3 escalation: two identical merge failures in a row -> the third merge never starts; return carries needs-attention with both signatures
ok 92 - ISSUE-3 escalation: two identical merge failures in a row -> the third merge never starts; return carries needs-attention with both signatures
  ---
  duration_ms: 1.4953
  type: 'test'
  ...
# Subtest: E2.1: a held leaf (needs-attention) survives final cleanup - the janitor never touches it
ok 93 - E2.1: a held leaf (needs-attention) survives final cleanup - the janitor never touches it
  ---
  duration_ms: 1.2841
  type: 'test'
  ...
# Subtest: ISSUE-3 escalation: different merge errors in a row do not escalate - every merge runs
ok 94 - ISSUE-3 escalation: different merge errors in a row do not escalate - every merge runs
  ---
  duration_ms: 1.2339
  type: 'test'
  ...
# Subtest: ISSUE-3 escalation: the streak survives a resume - the pair completes in the resumed campaign and the next merge is held
ok 95 - ISSUE-3 escalation: the streak survives a resume - the pair completes in the resumed campaign and the next merge is held
  ---
  duration_ms: 1.7298
  type: 'test'
  ...
# Subtest: ISSUE-3 escalation: a provider wall between two identical merge failures breaks the streak (walls never fingerprint)
ok 96 - ISSUE-3 escalation: a provider wall between two identical merge failures breaks the streak (walls never fingerprint)
  ---
  duration_ms: 1.0307
  type: 'test'
  ...
# Subtest: ISSUE-3 escalation: an attempt ending in another stage between two identical merge failures resets the streak
ok 97 - ISSUE-3 escalation: an attempt ending in another stage between two identical merge failures resets the streak
  ---
  duration_ms: 1.2755
  type: 'test'
  ...
# Subtest: no stale PLANNED markers: agile-loop.js and SKILL.md describe only implemented behavior
ok 98 - no stale PLANNED markers: agile-loop.js and SKILL.md describe only implemented behavior
  ---
  duration_ms: 2.4489
  type: 'test'
  ...
# Subtest: no `|| true` on ANY git command in ANY generated brief; bd-close git failures are explicit
ok 99 - no `|| true` on ANY git command in ANY generated brief; bd-close git failures are explicit
  ---
  duration_ms: 1.9453
  type: 'test'
  ...
# Subtest: stale PLANNED markers are gone from agile-loop.js and SKILL.md (doc matches live code)
ok 100 - stale PLANNED markers are gone from agile-loop.js and SKILL.md (doc matches live code)
  ---
  duration_ms: 1.6461
  type: 'test'
  ...
# Subtest: toy-falcon bd-close: the MERGER closes the merged leaf in bd (close steps in the merge spec, log records it); boundary carries NO bd-close; no post-loop re-close
ok 101 - toy-falcon bd-close: the MERGER closes the merged leaf in bd (close steps in the merge spec, log records it); boundary carries NO bd-close; no post-loop re-close
  ---
  duration_ms: 3.0384
  type: 'test'
  ...
# Subtest: toy-falcon bd-close: exactly-once across a multi-merge campaign - each merger closes its own leaf, no close is ever repeated
ok 102 - toy-falcon bd-close: exactly-once across a multi-merge campaign - each merger closes its own leaf, no close is ever repeated
  ---
  duration_ms: 1.3625
  type: 'test'
  ...
# Subtest: toy-falcon bd-close: failed leaf is never closed - NO boundary child (no refresh), no close section, the leaf is kept
ok 103 - toy-falcon bd-close: failed leaf is never closed - NO boundary child (no refresh), no close section, the leaf is kept
  ---
  duration_ms: 1.0537
  type: 'test'
  ...
# Subtest: toy-falcon bd-close: merger bd-close failure does not sink the merge - verdict merged stands, failure logged, the post-loop child retries
ok 104 - toy-falcon bd-close: merger bd-close failure does not sink the merge - verdict merged stands, failure logged, the post-loop child retries
  ---
  duration_ms: 1.1061
  type: 'test'
  ...
# Subtest: toy-falcon bd-close post-loop: the last sprint's merge is closed before return when the merger's bd-close failed and maxSprints ends the campaign
ok 105 - toy-falcon bd-close post-loop: the last sprint's merge is closed before return when the merger's bd-close failed and maxSprints ends the campaign
  ---
  duration_ms: 0.8647
  type: 'test'
  ...
# Subtest: toy-falcon bd-close post-loop: a failed final close is logged, never thrown, and the merge verdict stands
ok 106 - toy-falcon bd-close post-loop: a failed final close is logged, never thrown, and the merge verdict stands
  ---
  duration_ms: 1.3164
  type: 'test'
  ...
# Subtest: toy-falcon bd-close post-loop: epic-closed reached while the merger's bd-close failed (and the boundary errored) -> the post-loop child closes the merged leaf before return
ok 107 - toy-falcon bd-close post-loop: epic-closed reached while the merger's bd-close failed (and the boundary errored) -> the post-loop child closes the merged leaf before return
  ---
  duration_ms: 1.139
  type: 'test'
  ...
# Subtest: toy-falcon bd-close post-loop: nothing pending after the merger closed everything -> NO post-loop child (epic-closed path unchanged)
ok 108 - toy-falcon bd-close post-loop: nothing pending after the merger closed everything -> NO post-loop child (epic-closed path unchanged)
  ---
  duration_ms: 0.8825
  type: 'test'
  ...
# Subtest: mergeApproval: bd-epic default is auto - merger commits on converged mechanical evidence, NO supervisor round
ok 109 - mergeApproval: bd-epic default is auto - merger commits on converged mechanical evidence, NO supervisor round
  ---
  duration_ms: 0.7684
  type: 'test'
  ...
# Subtest: mergeApproval: curator default is confirm - the supervisor merge-approval question stays
ok 110 - mergeApproval: curator default is confirm - the supervisor merge-approval question stays
  ---
  duration_ms: 0.7832
  type: 'test'
  ...
# Subtest: mergeApproval: explicit args win over the mode defaults both ways; legacy mergePolicy auto still implies auto
ok 111 - mergeApproval: explicit args win over the mode defaults both ways; legacy mergePolicy auto still implies auto
  ---
  duration_ms: 3.4637
  type: 'test'
  ...
# Subtest: contract: work-class brief teaches the structured-output acceptance contract (fence gone, rp-schema)
ok 112 - contract: work-class brief teaches the structured-output acceptance contract (fence gone, rp-schema)
  ---
  duration_ms: 3.1997
  type: 'test'
  ...
# Subtest: contract: schema-valid structured output WITHOUT any fence is accepted end-to-end; reviewer brief carries the fresh head
ok 113 - contract: schema-valid structured output WITHOUT any fence is accepted end-to-end; reviewer brief carries the fresh head
  ---
  duration_ms: 0.8793
  type: 'test'
  ...
# Subtest: contract: WORK_SCHEMA carries the acceptance fields (head/testsAddedOrUpdated/commandsRun/validationOutput/residualRisks/noStagedFiles/criteriaSatisfied)
ok 114 - contract: WORK_SCHEMA carries the acceptance fields (head/testsAddedOrUpdated/commandsRun/validationOutput/residualRisks/noStagedFiles/criteriaSatisfied)
  ---
  duration_ms: 1.0103
  type: 'test'
  ...
# Subtest: work report without head -> schema-missing -> ONE salvage repair, merge uses the recovered head
ok 115 - work report without head -> schema-missing -> ONE salvage repair, merge uses the recovered head
  ---
  duration_ms: 1.0543
  type: 'test'
  ...
# Subtest: head not 40-hex -> schema-missing; salvage that fails too -> verdict failed (no review burn)
ok 116 - head not 40-hex -> schema-missing; salvage that fails too -> verdict failed (no review burn)
  ---
  duration_ms: 0.8331
  type: 'test'
  ...
# Subtest: foreign criteriaSatisfied ids -> schema-missing: criteriaSatisfied; unsalvageable -> verdict failed
ok 117 - foreign criteriaSatisfied ids -> schema-missing: criteriaSatisfied; unsalvageable -> verdict failed
  ---
  duration_ms: 1.3118
  type: 'test'
  ...
# Subtest: mutation probe: head violation -> schema-missing salvage (no re-brief)
ok 118 - mutation probe: head violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 1.2751
  type: 'test'
  ...
# Subtest: mutation probe: testsAddedOrUpdated violation -> schema-missing salvage (no re-brief)
ok 119 - mutation probe: testsAddedOrUpdated violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.7573
  type: 'test'
  ...
# Subtest: mutation probe: commandsRun violation -> schema-missing salvage (no re-brief)
ok 120 - mutation probe: commandsRun violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 1.9666
  type: 'test'
  ...
# Subtest: mutation probe: validationOutput violation -> schema-missing salvage (no re-brief)
ok 121 - mutation probe: validationOutput violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.6853
  type: 'test'
  ...
# Subtest: mutation probe: residualRisks violation -> schema-missing salvage (no re-brief)
ok 122 - mutation probe: residualRisks violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.7011
  type: 'test'
  ...
# Subtest: mutation probe: noStagedFiles violation -> schema-missing salvage (no re-brief)
ok 123 - mutation probe: noStagedFiles violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.661
  type: 'test'
  ...
# Subtest: mutation probe: criteriaSatisfied violation -> schema-missing salvage (no re-brief)
ok 124 - mutation probe: criteriaSatisfied violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.67
  type: 'test'
  ...
# Subtest: mutation probe: criteriaSatisfied violation -> schema-missing salvage (no re-brief)
ok 125 - mutation probe: criteriaSatisfied violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.664
  type: 'test'
  ...
# Subtest: mutation probe: criteriaSatisfied violation -> schema-missing salvage (no re-brief)
ok 126 - mutation probe: criteriaSatisfied violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.8266
  type: 'test'
  ...
# Subtest: mutation probe r2: criteriaSatisfied length !== 2 -> schema-missing salvage (no re-brief)
ok 127 - mutation probe r2: criteriaSatisfied length !== 2 -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.8913
  type: 'test'
  ...
# Subtest: mutation probe r2: criteriaSatisfied evidence blank -> schema-missing salvage (no re-brief)
ok 128 - mutation probe r2: criteriaSatisfied evidence blank -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.6827
  type: 'test'
  ...
# Subtest: mutation probe r2: commandsRun empty array -> schema-missing salvage (no re-brief)
ok 129 - mutation probe r2: commandsRun empty array -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.6945
  type: 'test'
  ...
# Subtest: mutation probe r2: commandsRun command blank -> schema-missing salvage (no re-brief)
ok 130 - mutation probe r2: commandsRun command blank -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.7017
  type: 'test'
  ...
# Subtest: modelLadder duplicates collapse: [m-b, m-b] behaves like [m-b]
ok 131 - modelLadder duplicates collapse: [m-b, m-b] behaves like [m-b]
  ---
  duration_ms: 2.4049
  type: 'test'
  ...
# Subtest: K1: failed leaf -> NO boundary janitor and NO cleanup child: the branch and worktree are kept, return.keptBranches names them
ok 132 - K1: failed leaf -> NO boundary janitor and NO cleanup child: the branch and worktree are kept, return.keptBranches names them
  ---
  duration_ms: 1.013
  type: 'test'
  ...
# Subtest: boundary merge: sprint 1 merged one leaf AND left one failed -> ONE s2-boundary refreshes the snapshot; the failed branch is kept, NOT janitored
ok 133 - boundary merge: sprint 1 merged one leaf AND left one failed -> ONE s2-boundary refreshes the snapshot; the failed branch is kept, NOT janitored
  ---
  duration_ms: 1.6747
  type: 'test'
  ...
# Subtest: boundary child dies at a snapshot refresh: failure is logged, sprint 2 runs on the previous snapshot, nothing is cleaned up
ok 134 - boundary child dies at a snapshot refresh: failure is logged, sprint 2 runs on the previous snapshot, nothing is cleaned up
  ---
  duration_ms: 1.2527
  type: 'test'
  ...
# Subtest: rotation: workModels round-robin glm->haiku->glm across tasks
ok 135 - rotation: workModels round-robin glm->haiku->glm across tasks
  ---
  duration_ms: 1.3135
  type: 'test'
  ...
# Subtest: rotation: reviewer skips the task's worker model (cross-model per task)
ok 136 - rotation: reviewer skips the task's worker model (cross-model per task)
  ---
  duration_ms: 0.7995
  type: 'test'
  ...
# Subtest: rotation preflight degradation: single reviewModels entry colliding with a work model warns and runs
ok 137 - rotation preflight degradation: single reviewModels entry colliding with a work model warns and runs
  ---
  duration_ms: 0.89
  type: 'test'
  ...
# Subtest: rotation: rework pins the task's worker model (same worker continues)
ok 138 - rotation: rework pins the task's worker model (same worker continues)
  ---
  duration_ms: 1.1037
  type: 'test'
  ...
# Subtest: rotation absent -> legacy behavior untouched (workModel string, no lists)
ok 139 - rotation absent -> legacy behavior untouched (workModel string, no lists)
  ---
  duration_ms: 0.7929
  type: 'test'
  ...
# Subtest: breaker: second strike trips the model -> the next task starts directly on the ladder model (exactly 1 launch)
ok 140 - breaker: second strike trips the model -> the next task starts directly on the ladder model (exactly 1 launch)
  ---
  duration_ms: 34.3424
  type: 'test'
  ...
# Subtest: breaker: a strike below the threshold keeps the model primary; child success resets strikes
ok 141 - breaker: a strike below the threshold keeps the model primary; child success resets strikes
  ---
  duration_ms: 20.932
  type: 'test'
  ...
# Subtest: breaker: resume restores overload strikes from the checkpoint
ok 142 - breaker: resume restores overload strikes from the checkpoint
  ---
  duration_ms: 47.0177
  type: 'test'
  ...
# Subtest: breaker: ALL models tripped -> child starts with the primary as-is (breaker must not brick the campaign)
ok 143 - breaker: ALL models tripped -> child starts with the primary as-is (breaker must not brick the campaign)
  ---
  duration_ms: 15.2151
  type: 'test'
  ...
# Subtest: cooling-down: 429 'Server requested Ns retry delay' -> model cooling in the checkpoint; the resumed campaign skips it
ok 144 - cooling-down: 429 'Server requested Ns retry delay' -> model cooling in the checkpoint; the resumed campaign skips it
  ---
  duration_ms: 31.4406
  type: 'test'
  ...
# Subtest: cooling-down: unparsable 429 -> default 600s; parsed delay is capped at 7200s
ok 145 - cooling-down: unparsable 429 -> default 600s; parsed delay is capped at 7200s
  ---
  duration_ms: 31.2946
  type: 'test'
  ...
# Subtest: cooling-down: 403 'Request not allowed' quota wall (live precedent) -> default 600s cooling + ladder escape; the resumed campaign skips it
ok 146 - cooling-down: 403 'Request not allowed' quota wall (live precedent) -> default 600s cooling + ladder escape; the resumed campaign skips it
  ---
  duration_ms: 30.8548
  type: 'test'
  ...
# Subtest: cooling-down: 'forbidden' quota wall without any 429 marker -> same treatment: cooling + breaker strike + ladder escape
ok 147 - cooling-down: 'forbidden' quota wall without any 429 marker -> same treatment: cooling + breaker strike + ladder escape
  ---
  duration_ms: 1.8043
  type: 'test'
  ...
# Subtest: cooling-down: work pool skips a cooling model (until > now) and starts on the next one
ok 148 - cooling-down: work pool skips a cooling model (until > now) and starts on the next one
  ---
  duration_ms: 14.0089
  type: 'test'
  ...
# Subtest: cooling-down: expired until -> the model is eligible again
ok 149 - cooling-down: expired until -> the model is eligible again
  ---
  duration_ms: 16.107
  type: 'test'
  ...
# Subtest: cooling-down: ALL work models cooling -> the one with the minimal until is taken
ok 150 - cooling-down: ALL work models cooling -> the one with the minimal until is taken
  ---
  duration_ms: 15.495
  type: 'test'
  ...
# Subtest: cooling-down: review pool skips a cooling reviewer model
ok 151 - cooling-down: review pool skips a cooling reviewer model
  ---
  duration_ms: 1.1255
  type: 'test'
  ...
# Subtest: cooling-down: ladder start skips the cooling primary and leads with the ladder model
ok 152 - cooling-down: ladder start skips the cooling primary and leads with the ladder model
  ---
  duration_ms: 14.5189
  type: 'test'
  ...
# Subtest: single-model degradation: one model on work+review does NOT throw - review runs on it with a warning
ok 153 - single-model degradation: one model on work+review does NOT throw - review runs on it with a warning
  ---
  duration_ms: 1.1899
  type: 'test'
  ...
# Subtest: single-model degradation: legacy workModel===reviewModel warns and works; reviewModels>=2 keeps the reviewer different
ok 154 - single-model degradation: legacy workModel===reviewModel warns and works; reviewModels>=2 keeps the reviewer different
  ---
  duration_ms: 1.5726
  type: 'test'
  ...
# Subtest: review tier none: 0 review children, the reviewer is never asked, merge gate still merges
ok 155 - review tier none: 0 review children, the reviewer is never asked, merge gate still merges
  ---
  duration_ms: 1.1569
  type: 'test'
  ...
# Subtest: review tier none: salvage-covered head-less report still merges via recovered head; red checks -> merge-failed
ok 156 - review tier none: salvage-covered head-less report still merges via recovered head; red checks -> merge-failed
  ---
  duration_ms: 1.8776
  type: 'test'
  ...
# Subtest: review tier none: completed=false fails fast (no reviewer, no rework ladder)
ok 157 - review tier none: completed=false fails fast (no reviewer, no rework ladder)
  ---
  duration_ms: 0.872
  type: 'test'
  ...
# Subtest: review tier lite: checklist prompt WITHOUT refute protocol, cross-model review still runs, merge gate unchanged
ok 158 - review tier lite: checklist prompt WITHOUT refute protocol, cross-model review still runs, merge gate unchanged
  ---
  duration_ms: 0.9244
  type: 'test'
  ...
# Subtest: review tier full: unchanged judge prompt; missing and unknown tiers fall back to full
ok 159 - review tier full: unchanged judge prompt; missing and unknown tiers fall back to full
  ---
  duration_ms: 1.1505
  type: 'test'
  ...
# Subtest: review tier from a boundary refresh: a leaf that arrives mid-campaign with review none runs without a review
ok 160 - review tier from a boundary refresh: a leaf that arrives mid-campaign with review none runs without a review
  ---
  duration_ms: 1.2748
  type: 'test'
  ...
# Subtest: snapshot leaf with verify:true is an ordinary work leaf: branch/worktree created, review and merge run, verdict merged
ok 161 - snapshot leaf with verify:true is an ordinary work leaf: branch/worktree created, review and merge run, verdict merged
  ---
  duration_ms: 0.7818
  type: 'test'
  ...
# Subtest: carry-over: failed attempt -> next sprint's retry brief carries branch, files and stop point (no worker narrative)
ok 162 - carry-over: failed attempt -> next sprint's retry brief carries branch, files and stop point (no worker narrative)
  ---
  duration_ms: 1.4163
  type: 'test'
  ...
# Subtest: carry-over: merge refused -> carry records the merge stop point and the branch's files
ok 163 - carry-over: merge refused -> carry records the merge stop point and the branch's files
  ---
  duration_ms: 1.1385
  type: 'test'
  ...
# Subtest: carry-over: checkpoint roundtrip - carry is persisted and survives a resume into the first brief of the resumed run
ok 164 - carry-over: checkpoint roundtrip - carry is persisted and survives a resume into the first brief of the resumed run
  ---
  duration_ms: 1.4841
  type: 'test'
  ...
# Subtest: campaign analytics: archiver child launches once at campaign end, after final cleanup, with a copy+analyze brief
ok 165 - campaign analytics: archiver child launches once at campaign end, after final cleanup, with a copy+analyze brief
  ---
  duration_ms: 1.1088
  type: 'test'
  ...
# Subtest: campaign analytics: default-on (auto-run), child failure is best-effort - status and counts untouched
ok 166 - campaign analytics: default-on (auto-run), child failure is best-effort - status and counts untouched
  ---
  duration_ms: 0.8937
  type: 'test'
  ...
# Subtest: campaign analytics: skipped=true (e.g. runtime artifacts not found) is surfaced, not an error
ok 167 - campaign analytics: skipped=true (e.g. runtime artifacts not found) is surfaced, not an error
  ---
  duration_ms: 0.7718
  type: 'test'
  ...
# Subtest: campaign analytics: analytics=false or empty metricsScript opts out - child never launches
ok 168 - campaign analytics: analytics=false or empty metricsScript opts out - child never launches
  ---
  duration_ms: 3.8738
  type: 'test'
  ...
# Subtest: campaign analytics: archiver 429 does not permanently strike the campaign primary
ok 169 - campaign analytics: archiver 429 does not permanently strike the campaign primary
  ---
  duration_ms: 1.2462
  type: 'test'
  ...
# Subtest: campaign analytics: archiver 429 strikes do not leak into the checkpoint (restore, not record)
ok 170 - campaign analytics: archiver 429 strikes do not leak into the checkpoint (restore, not record)
  ---
  duration_ms: 1.2005
  type: 'test'
  ...
# Subtest: analyze-campaign.mjs CLI: wall timeline, failure classes (incl. ok:true failing report), usage, journal -> metrics.json + retro
ok 171 - analyze-campaign.mjs CLI: wall timeline, failure classes (incl. ok:true failing report), usage, journal -> metrics.json + retro
  ---
  duration_ms: 92.6788
  type: 'test'
  ...
# Subtest: analyze-campaign.mjs honesty: no timestamps -> wallMs null (never 0); no token sources -> '?' (exit 0)
ok 172 - analyze-campaign.mjs honesty: no timestamps -> wallMs null (never 0); no token sources -> '?' (exit 0)
  ---
  duration_ms: 73.3183
  type: 'test'
  ...
# Subtest: analyze-campaign.mjs parity: snapshot steps[] startedAt -> per-child wallMs when the child has no child-status 'started' event (collect_metrics.py contract)
ok 173 - analyze-campaign.mjs parity: snapshot steps[] startedAt -> per-child wallMs when the child has no child-status 'started' event (collect_metrics.py contract)
  ---
  duration_ms: 85.2347
  type: 'test'
  ...
# Subtest: analyze-campaign.mjs taxonomy: failure classes + key shapes match the collect_metrics.py contract
ok 174 - analyze-campaign.mjs taxonomy: failure classes + key shapes match the collect_metrics.py contract
  ---
  duration_ms: 1.9136
  type: 'test'
  ...
# Subtest: qa6: merger brief rebases onto main before the squash - conflicts resolve at rebase, auto-evidence covers the rebase
ok 175 - qa6: merger brief rebases onto main before the squash - conflicts resolve at rebase, auto-evidence covers the rebase
  ---
  duration_ms: 0.9155
  type: 'test'
  ...
# Subtest: wide wave unawaited-launch contract: 2 bd-epic leaves, one sprint, no deps - all work->review->merge chains consumed, normal epic-closed stop
ok 176 - wide wave unawaited-launch contract: 2 bd-epic leaves, one sprint, no deps - all work->review->merge chains consumed, normal epic-closed stop
  ---
  duration_ms: 22.9689
  type: 'test'
  ...
# Subtest: wide wave curator mode: 2 sibling tasks in wave 1 - post-phase chains consumed, analytics after merges
ok 177 - wide wave curator mode: 2 sibling tasks in wave 1 - post-phase chains consumed, analytics after merges
  ---
  duration_ms: 30.0909
  type: 'test'
  ...
# Subtest: serial path (single-task wave) under tracker emulation: every launch consumed, serial schedule kept
ok 178 - serial path (single-task wave) under tracker emulation: every launch consumed, serial schedule kept
  ---
  duration_ms: 3.5179
  type: 'test'
  ...
# Subtest: contract: campaign start writes the report schemas to <journalDir>/report-schema.json BEFORE the first work child (R1)
ok 179 - contract: campaign start writes the report schemas to <journalDir>/report-schema.json BEFORE the first work child (R1)
  ---
  duration_ms: 1.1574
  type: 'test'
  ...
# Subtest: contract: work, rework and merge briefs each carry exactly one report self-check call (R1)
ok 180 - contract: work, rework and merge briefs each carry exactly one report self-check call (R1)
  ---
  duration_ms: 1.3228
  type: 'test'
  ...
# Subtest: report-check: a valid work draft against the engine schema exits 0 (R1)
ok 181 - report-check: a valid work draft against the engine schema exits 0 (R1)
  ---
  duration_ms: 815.2448
  type: 'test'
  ...
# Subtest: report-check: a valid merge draft exits 0 (R1)
ok 182 - report-check: a valid merge draft exits 0 (R1)
  ---
  duration_ms: 69.4177
  type: 'test'
  ...
# Subtest: report-check: head 'x', no worktree, no what_done, noStagedFiles=true over a dirty worktree -> exact per-field lines, exit 1 (R1)
ok 183 - report-check: head 'x', no worktree, no what_done, noStagedFiles=true over a dirty worktree -> exact per-field lines, exit 1 (R1)
  ---
  duration_ms: 678.565
  type: 'test'
  ...
# Subtest: report-check: an honest noStagedFiles=false over a dirty worktree is a named line, not a schema error (R1)
ok 184 - report-check: an honest noStagedFiles=false over a dirty worktree is a named line, not a schema error (R1)
  ---
  duration_ms: 781.8571
  type: 'test'
  ...
# Subtest: R1: an honest noStagedFiles=false report passes the repair schema and the in-script acceptance check (forced const removed)
ok 185 - R1: an honest noStagedFiles=false report passes the repair schema and the in-script acceptance check (forced const removed)
  ---
  duration_ms: 1.4689
  type: 'test'
  ...
# Subtest: merge CLI exit-2 brief and already-closed bd leaf contract
ok 186 - merge CLI exit-2 brief and already-closed bd leaf contract
  ---
  duration_ms: 1.9853
  type: 'test'
  ...
# Subtest: mergeBranch conflict fixture: exit 2 reports conflicts and leaves integration HEAD untouched
ok 187 - mergeBranch conflict fixture: exit 2 reports conflicts and leaves integration HEAD untouched
  ---
  duration_ms: 5080.7127
  type: 'test'
  ...
# Subtest: mergeBranch clean fixture: deterministic CLI squashes after full test command
ok 188 - mergeBranch clean fixture: deterministic CLI squashes after full test command
  ---
  duration_ms: 3551.3431
  type: 'test'
  ...
# Subtest: mergeBranch ignored .beads is closed without an export commit
ok 189 - mergeBranch ignored .beads is closed without an export commit
  ---
  duration_ms: 0.3682
  type: 'test'
  ...
# Subtest: mergeBranch bd spawn error is best-effort after committed merge
ok 190 - mergeBranch bd spawn error is best-effort after committed merge
  ---
  duration_ms: 5121.1447
  type: 'test'
  ...
# Subtest: K2: mergeBranch deletes the merged campaign branch after git cherry; a foreign feat/* branch is never touched
ok 191 - K2: mergeBranch deletes the merged campaign branch after git cherry; a foreign feat/* branch is never touched
  ---
  duration_ms: 4873.4454
  type: 'test'
  ...
# Subtest: K2: a campaign branch whose git cherry shows a '+' line is kept (branchDeleted=false) and the merge still stands
ok 192 - K2: a campaign branch whose git cherry shows a '+' line is kept (branchDeleted=false) and the merge still stands
  ---
  duration_ms: 4282.8475
  type: 'test'
  ...
# Subtest: ISSUE-7 unit: mergeBranch gate env drops PI_SUBAGENT_CHILD/DEPTH, keeps PATH/HOME, leaves the merger's own env intact
ok 193 - ISSUE-7 unit: mergeBranch gate env drops PI_SUBAGENT_CHILD/DEPTH, keeps PATH/HOME, leaves the merger's own env intact
  ---
  duration_ms: 3366.2506
  type: 'test'
  ...
# Subtest: ISSUE-7 carrier: a gate script that fails on an inherited PI_SUBAGENT_CHILD passes under the merger gate
ok 194 - ISSUE-7 carrier: a gate script that fails on an inherited PI_SUBAGENT_CHILD passes under the merger gate
  ---
  duration_ms: 2841.2549
  type: 'test'
  ...
# Subtest: main-copy isolation: a change in main between baseline and merge blocks the merge, is reported, and is NOT reverted
ok 195 - main-copy isolation: a change in main between baseline and merge blocks the merge, is reported, and is NOT reverted
  ---
  duration_ms: 1.8666
  type: 'test'
  ...
# Subtest: main-copy isolation: a PRE-EXISTING dirty tracked file overwritten during the campaign (porcelain line unchanged) blocks the merge and is NOT reverted
ok 196 - main-copy isolation: a PRE-EXISTING dirty tracked file overwritten during the campaign (porcelain line unchanged) blocks the merge and is NOT reverted
  ---
  duration_ms: 1.4116
  type: 'test'
  ...
# Subtest: main-copy isolation: a PRE-EXISTING untracked file rewritten during the campaign (porcelain line unchanged) blocks the merge
ok 197 - main-copy isolation: a PRE-EXISTING untracked file rewritten during the campaign (porcelain line unchanged) blocks the merge
  ---
  duration_ms: 1.6249
  type: 'test'
  ...
# Subtest: main-copy isolation: pre-existing baseline dirt and engine-owned safe-list paths are NOT incidents; the baseline is recorded
ok 198 - main-copy isolation: pre-existing baseline dirt and engine-owned safe-list paths are NOT incidents; the baseline is recorded
  ---
  duration_ms: 1.3522
  type: 'test'
  ...
# Subtest: main-copy isolation: resume keeps the campaign baseline (no re-probe) and still catches a NEW mutation only
ok 199 - main-copy isolation: resume keeps the campaign baseline (no re-probe) and still catches a NEW mutation only
  ---
  duration_ms: 1.5654
  type: 'test'
  ...
# Subtest: main-copy isolation: a resumed checkpoint WITHOUT content evidence fails closed on its dirty baseline paths
ok 200 - main-copy isolation: a resumed checkpoint WITHOUT content evidence fails closed on its dirty baseline paths
  ---
  duration_ms: 0.9638
  type: 'test'
  ...
# Subtest: main-copy isolation: a NEW .beads/ path other than issues.jsonl is NOT engine-owned: it is an incident, the merge is refused, nothing is reverted
ok 201 - main-copy isolation: a NEW .beads/ path other than issues.jsonl is NOT engine-owned: it is an incident, the merge is refused, nothing is reverted
  ---
  duration_ms: 1.4934
  type: 'test'
  ...
# Subtest: main-copy isolation: rework and report-repair specs carry the worktree cwd; work-class briefs carry the absolute-path rule
ok 202 - main-copy isolation: rework and report-repair specs carry the worktree cwd; work-class briefs carry the absolute-path rule
  ---
  duration_ms: 2.1011
  type: 'test'
  ...
# Subtest: mergeBranch phantom dirt: porcelain-dirty worktree with quiet unstaged diff merges, phantomDirtCleared names all three files
ok 203 - mergeBranch phantom dirt: porcelain-dirty worktree with quiet unstaged diff merges, phantomDirtCleared names all three files
  ---
  duration_ms: 4219.7659
  type: 'test'
  ...
# Subtest: mergeBranch gate failure keeps the resume: retry with the same approvedSha continues from the gate, not branch moved
ok 204 - mergeBranch gate failure keeps the resume: retry with the same approvedSha continues from the gate, not branch moved
  ---
  duration_ms: 4706.4027
  type: 'test'
  ...
# Subtest: E0.2 known flake: gate red only on a --known-flakes name, targeted retry green -> merged and flakeRetried names it
ok 205 - E0.2 known flake: gate red only on a --known-flakes name, targeted retry green -> merged and flakeRetried names it
  ---
  duration_ms: 3533.0251
  type: 'test'
  ...
# Subtest: E0.2 unlisted failure: one failing name outside --known-flakes refuses the merge with reset --hard, even if it would pass on retry
ok 206 - E0.2 unlisted failure: one failing name outside --known-flakes refuses the merge with reset --hard, even if it would pass on retry
  ---
  duration_ms: 3429.1664
  type: 'test'
  ...
# Subtest: П4 re-issue with a saved attempt: CONTINUATION brief continues the branch per fix_list, no git worktree add
ok 207 - П4 re-issue with a saved attempt: CONTINUATION brief continues the branch per fix_list, no git worktree add
  ---
  duration_ms: 1.6206
  type: 'test'
  ...
# Subtest: П4 collision without attempt: STOP contract stays (no duplicate created), slug unique per attempt on a known collision
ok 208 - П4 collision without attempt: STOP contract stays (no duplicate created), slug unique per attempt on a known collision
  ---
  duration_ms: 1.5778
  type: 'test'
  ...
# Subtest: agile_run: bd-epic launch plan from a mocked bd (open leaves, engine shape, defaults)
ok 209 - agile_run: bd-epic launch plan from a mocked bd (open leaves, engine shape, defaults)
  ---
  duration_ms: 6.0224
  type: 'test'
  ...
# Subtest: agile_run: bundleScript absent -> warning in the output, args carry no bundleScript
ok 210 - agile_run: bundleScript absent -> warning in the output, args carry no bundleScript
  ---
  duration_ms: 0.7775
  type: 'test'
  ...
# Subtest: agile_run: files_hint is the Файлы: line up to the sentence end; a path after that dot stays out, length capped
ok 211 - agile_run: files_hint is the Файлы: line up to the sentence end; a path after that dot stays out, length capped
  ---
  duration_ms: 0.5985
  type: 'test'
  ...
# Subtest: agile_run: leaf without a Файлы: line -> empty files_hint and a warning; prose paths never used
ok 212 - agile_run: leaf without a Файлы: line -> empty files_hint and a warning; prose paths never used
  ---
  duration_ms: 0.5919
  type: 'test'
  ...
# Subtest: agile_run: Метод измерения: line -> measure (whole line, capped); absent -> measure stays '' (leaf unchanged)
ok 213 - agile_run: Метод измерения: line -> measure (whole line, capped); absent -> measure stays '' (leaf unchanged)
  ---
  duration_ms: 0.6338
  type: 'test'
  ...
# Subtest: agile_run: rationale/acceptance over the limit -> warning with leaf id and length (no silent cut)
ok 214 - agile_run: rationale/acceptance over the limit -> warning with leaf id and length (no silent cut)
  ---
  duration_ms: 0.7654
  type: 'test'
  ...
# Subtest: agile_run: workModels overlapping reviewModels -> error string
ok 215 - agile_run: workModels overlapping reviewModels -> error string
  ---
  duration_ms: 0.788
  type: 'test'
  ...
# Subtest: agile_run: distinct workModels/reviewModels pass through to args
ok 216 - agile_run: distinct workModels/reviewModels pass through to args
  ---
  duration_ms: 0.4302
  type: 'test'
  ...
# Subtest: agile_run: invalid mergeApproval -> error string
ok 217 - agile_run: invalid mergeApproval -> error string
  ---
  duration_ms: 0.6537
  type: 'test'
  ...
# Subtest: agile_run: epic with no open leaves -> error (nothing to launch)
ok 218 - agile_run: epic with no open leaves -> error (nothing to launch)
  ---
  duration_ms: 0.695
  type: 'test'
  ...
# Subtest: agile_run: closed leaf whose dep is still open -> error (bd inconsistency)
ok 219 - agile_run: closed leaf whose dep is still open -> error (bd inconsistency)
  ---
  duration_ms: 0.4089
  type: 'test'
  ...
# Subtest: agile_run: missing epic -> error naming the epic
ok 220 - agile_run: missing epic -> error naming the epic
  ---
  duration_ms: 0.2552
  type: 'test'
  ...
# Subtest: agile_run: missing epic/testCommand -> error
ok 221 - agile_run: missing epic/testCommand -> error
  ---
  duration_ms: 0.2773
  type: 'test'
  ...
# Subtest: agile_status: empty temp -> 'no runs found' (no crash)
ok 222 - agile_status: empty temp -> 'no runs found' (no crash)
  ---
  duration_ms: 2.2424
  type: 'test'
  ...
# Subtest: agile_status: unknown runId -> 'not found' (no crash)
ok 223 - agile_status: unknown runId -> 'not found' (no crash)
  ---
  duration_ms: 1.6343
  type: 'test'
  ...
# Subtest: agile_status: freshest run dir -> workflow result, checkpoint and last child_settled (read-only)
ok 224 - agile_status: freshest run dir -> workflow result, checkpoint and last child_settled (read-only)
  ---
  duration_ms: 13.1305
  type: 'test'
  ...
1..224
# tests 224
# suites 0
# pass 224
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 49280.093

post-work tests:

> pi-agile@0.1.0 test
> node --test tests/agile-loop.test.mjs tests/pi-agile-tools.test.mjs

TAP version 13
# Subtest: happy path: 1 task -> worktree isolation even solo, merge preflight + journal head
ok 1 - happy path: 1 task -> worktree isolation even solo, merge preflight + journal head
  ---
  duration_ms: 21.92
  type: 'test'
  ...
# Subtest: workModel/reviewModel: role-split models reach the right children; merge stays on top model
ok 2 - workModel/reviewModel: role-split models reach the right children; merge stays on top model
  ---
  duration_ms: 12.7189
  type: 'test'
  ...
# Subtest: single-model degradation: workModel === reviewModel warns and degrades instead of throwing
ok 3 - single-model degradation: workModel === reviewModel warns and degrades instead of throwing
  ---
  duration_ms: 1.8995
  type: 'test'
  ...
# Subtest: manifest: actor-reported ABSOLUTE worktree accepted only with the deterministic basename
ok 4 - manifest: actor-reported ABSOLUTE worktree accepted only with the deterministic basename
  ---
  duration_ms: 4.8471
  type: 'test'
  ...
# Subtest: forced SDD failure stops the campaign instead of degrading to bare work
ok 5 - forced SDD failure stops the campaign instead of degrading to bare work
  ---
  duration_ms: 5.7934
  type: 'test'
  ...
# Subtest: approval-required: approved_by_caller=false -> no workers, no review, no merge
ok 6 - approval-required: approved_by_caller=false -> no workers, no review, no merge
  ---
  duration_ms: 1.2498
  type: 'test'
  ...
# Subtest: transport retry: retried with suffixed key, non-blocking (sibling lane progresses during wait)
ok 7 - transport retry: retried with suffixed key, non-blocking (sibling lane progresses during wait)
  ---
  duration_ms: 43.3286
  type: 'test'
  ...
# Subtest: schema-missing: NO re-brief (single work launch), flow degrades to arbiter, drop via mergeChain
ok 8 - schema-missing: NO re-brief (single work launch), flow degrades to arbiter, drop via mergeChain
  ---
  duration_ms: 3.1232
  type: 'test'
  ...
# Subtest: review schema-miss: ONE re-run of the same review with a reminder, ok on the retry -> merged, zero rework
ok 9 - review schema-miss: ONE re-run of the same review with a reminder, ok on the retry -> merged, zero rework
  ---
  duration_ms: 2.4722
  type: 'test'
  ...
# Subtest: review schema-miss twice: exactly two review launches, zero rework/review-r, verdict failed with class review-schema-miss
ok 10 - review schema-miss twice: exactly two review launches, zero rework/review-r, verdict failed with class review-schema-miss
  ---
  duration_ms: 2.3503
  type: 'test'
  ...
# Subtest: review approved:false is a verdict, not a schema-miss: no re-run, rework as before
ok 11 - review approved:false is a verdict, not a schema-miss: no re-run, rework as before
  ---
  duration_ms: 1.8907
  type: 'test'
  ...
# Subtest: arbiter merge-as-is: orchestrator merges via mergeChain (serialized), verdict merged-after-arbitration
ok 12 - arbiter merge-as-is: orchestrator merges via mergeChain (serialized), verdict merged-after-arbitration
  ---
  duration_ms: 67.1993
  type: 'test'
  ...
# Subtest: supervisor-unavailable fallback: decision=needs-attention holds the branch (no drop, no pool walk)
ok 13 - supervisor-unavailable fallback: decision=needs-attention holds the branch (no drop, no pool walk)
  ---
  duration_ms: 1.1899
  type: 'test'
  ...
# Subtest: one-more-round guard: at most ONE arbiter-granted extra round; a repeated request holds as needs-attention (no drop)
ok 14 - one-more-round guard: at most ONE arbiter-granted extra round; a repeated request holds as needs-attention (no drop)
  ---
  duration_ms: 1.2023
  type: 'test'
  ...
# Subtest: K1: failed leftovers and needs-attention holds are kept for the lead - NO final cleanup child, return.keptBranches names both
ok 15 - K1: failed leftovers and needs-attention holds are kept for the lead - NO final cleanup child, return.keptBranches names both
  ---
  duration_ms: 1.3766
  type: 'test'
  ...
# Subtest: K1: merge-failed and failed leaves are kept - no cleanup child, both branches named in return.keptBranches
ok 16 - K1: merge-failed and failed leaves are kept - no cleanup child, both branches named in return.keptBranches
  ---
  duration_ms: 2.4254
  type: 'test'
  ...
# Subtest: K1: a main-copy incident (main-mutated) keeps the branch - no cleanup child, return.keptBranches names it
ok 17 - K1: a main-copy incident (main-mutated) keeps the branch - no cleanup child, return.keptBranches names it
  ---
  duration_ms: 1.3515
  type: 'test'
  ...
# Subtest: K1: keptBranches excludes merged work and the explicit drop-branch decision (the only engine deletion) - the drop still executes
ok 18 - K1: keptBranches excludes merged work and the explicit drop-branch decision (the only engine deletion) - the drop still executes
  ---
  duration_ms: 1.2275
  type: 'test'
  ...
# Subtest: K2: a merged branch the merger did not delete (branch_deleted=false) stays in return.keptBranches with verdict merged - the merge stands
ok 19 - K2: a merged branch the merger did not delete (branch_deleted=false) stays in return.keptBranches with verdict merged - the merge stands
  ---
  duration_ms: 0.7999
  type: 'test'
  ...
# Subtest: arbiter pool: author glm with an alternative in the pool -> the arbiter is NOT the author's model
ok 20 - arbiter pool: author glm with an alternative in the pool -> the arbiter is NOT the author's model
  ---
  duration_ms: 1.0481
  type: 'test'
  ...
# Subtest: arbiter pool: a single model in the pool is the arbiter - no error, no block
ok 21 - arbiter pool: a single model in the pool is the arbiter - no error, no block
  ---
  duration_ms: 0.8808
  type: 'test'
  ...
# Subtest: arbiter pool: 403 on the first arbiter -> the second arbiter call goes to the next pool model
ok 22 - arbiter pool: 403 on the first arbiter -> the second arbiter call goes to the next pool model
  ---
  duration_ms: 1.7472
  type: 'test'
  ...
# Subtest: arbiter pool exhausted: every pool model overloaded -> verdict arbiter-failed (as before)
ok 23 - arbiter pool exhausted: every pool model overloaded -> verdict arbiter-failed (as before)
  ---
  duration_ms: 2.997
  type: 'test'
  ...
# Subtest: escalate-ledger: repair ceremony updates the approved head; merge uses the repair head
ok 24 - escalate-ledger: repair ceremony updates the approved head; merge uses the repair head
  ---
  duration_ms: 1.4534
  type: 'test'
  ...
# Subtest: escalate-ledger: repair completed=false -> verdict failed, NO review child
ok 25 - escalate-ledger: repair completed=false -> verdict failed, NO review child
  ---
  duration_ms: 0.8741
  type: 'test'
  ...
# Subtest: work completed=false -> verdict failed, NO review child, campaign continues
ok 26 - work completed=false -> verdict failed, NO review child, campaign continues
  ---
  duration_ms: 0.7703
  type: 'test'
  ...
# Subtest: rework completed=false -> no second review child, verdict failed, campaign continues
ok 27 - rework completed=false -> no second review child, verdict failed, campaign continues
  ---
  duration_ms: 0.8494
  type: 'test'
  ...
# Subtest: contract pre-check: header/files_hint names a file the branch never touched -> verdict failed, NO review child
ok 28 - contract pre-check: header/files_hint names a file the branch never touched -> verdict failed, NO review child
  ---
  duration_ms: 0.9365
  type: 'test'
  ...
# Subtest: contract pre-check: a named file the branch DID touch passes; a contract naming no file is not checked
ok 29 - contract pre-check: a named file the branch DID touch passes; a contract naming no file is not checked
  ---
  duration_ms: 1.2116
  type: 'test'
  ...
# Subtest: rework schema-missing salvage reports completed=false -> verdict failed, no review child
ok 30 - rework schema-missing salvage reports completed=false -> verdict failed, no review child
  ---
  duration_ms: 1.2502
  type: 'test'
  ...
# Subtest: rework acceptance-rejected after salvage already used -> verdict failed, NO second review child
ok 31 - rework acceptance-rejected after salvage already used -> verdict failed, NO second review child
  ---
  duration_ms: 0.8739
  type: 'test'
  ...
# Subtest: provider overload (429): fail-fast retry-needed, no attempts burned
ok 32 - provider overload (429): fail-fast retry-needed, no attempts burned
  ---
  duration_ms: 0.941
  type: 'test'
  ...
# Subtest: transport failure: bounded retries then transport-unrecovered
ok 33 - transport failure: bounded retries then transport-unrecovered
  ---
  duration_ms: 20.7282
  type: 'test'
  ...
# Subtest: message matching both schema and transport classes is schema-missing (no re-brief)
ok 34 - message matching both schema and transport classes is schema-missing (no re-brief)
  ---
  duration_ms: 2.0377
  type: 'test'
  ...
# Subtest: rec.head refresh: head-less work report -> schema-missing salvage -> review rejects -> rework head becomes THE approved head (kills 'branch head moved')
ok 35 - rec.head refresh: head-less work report -> schema-missing salvage -> review rejects -> rework head becomes THE approved head (kills 'branch head moved')
  ---
  duration_ms: 1.8712
  type: 'test'
  ...
# Subtest: head-SHA binding: schema requires head; review and merge briefs carry the approved head
ok 36 - head-SHA binding: schema requires head; review and merge briefs carry the approved head
  ---
  duration_ms: 1.4166
  type: 'test'
  ...
# Subtest: rework updates the approved head before the next review/merge
ok 37 - rework updates the approved head before the next review/merge
  ---
  duration_ms: 1.514
  type: 'test'
  ...
# Subtest: fix-only rework: structured fix_list -> rework brief carries ONLY the listed fixes + scope guard + full gate
ok 38 - fix-only rework: structured fix_list -> rework brief carries ONLY the listed fixes + scope guard + full gate
  ---
  duration_ms: 1.9705
  type: 'test'
  ...
# Subtest: fix-only rework: empty or malformed fix_list falls back to the legacy full rework brief
ok 39 - fix-only rework: empty or malformed fix_list falls back to the legacy full rework brief
  ---
  duration_ms: 4.7626
  type: 'test'
  ...
# Subtest: contract: REVIEW_SCHEMA carries optional fix_list ({file,fix} items); reviewer brief announces the channel
ok 40 - contract: REVIEW_SCHEMA carries optional fix_list ({file,fix} items); reviewer brief announces the channel
  ---
  duration_ms: 3.3511
  type: 'test'
  ...
# Subtest: contract: review brief carries the runtime-boundary rule (harness-green is not production evidence)
ok 41 - contract: review brief carries the runtime-boundary rule (harness-green is not production evidence)
  ---
  duration_ms: 1.4216
  type: 'test'
  ...
# Subtest: contract: work/rework/repair briefs carry the no-scratch-debug diagnostic rule
ok 42 - contract: work/rework/repair briefs carry the no-scratch-debug diagnostic rule
  ---
  duration_ms: 2.2384
  type: 'test'
  ...
# Subtest: contract: work, rework and review briefs carry the edit-failure rule (first failure reads the whole file, second overwrites via write, third stops)
ok 43 - contract: work, rework and review briefs carry the edit-failure rule (first failure reads the whole file, second overwrites via write, third stops)
  ---
  duration_ms: 2.0604
  type: 'test'
  ...
# Subtest: ISSUE-7 contract: work/rework/report-repair/repair briefs run the gate as env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH <testCommand>
ok 44 - ISSUE-7 contract: work/rework/report-repair/repair briefs run the gate as env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH <testCommand>
  ---
  duration_ms: 4.1527
  type: 'test'
  ...
# Subtest: merged:true with checks_ok:false is NOT a merged verdict
ok 45 - merged:true with checks_ok:false is NOT a merged verdict
  ---
  duration_ms: 1.2155
  type: 'test'
  ...
# Subtest: parallel mode: multi-task wave briefs use worktrees
ok 46 - parallel mode: multi-task wave briefs use worktrees
  ---
  duration_ms: 0.9461
  type: 'test'
  ...
# Subtest: report-repair: schema-missing after work -> ONE report-recovery child, merge uses recovered head
ok 47 - report-repair: schema-missing after work -> ONE report-recovery child, merge uses recovered head
  ---
  duration_ms: 1.1123
  type: 'test'
  ...
# Subtest: report-repair: semantic schema-missing after work also salvages - no re-brief, structured contract taught (no fence)
ok 48 - report-repair: semantic schema-missing after work also salvages - no re-brief, structured contract taught (no fence)
  ---
  duration_ms: 0.984
  type: 'test'
  ...
# Subtest: rework salvage: rework child rejected on report shape -> ONE salvage child, re-review proceeds, no re-implementation
ok 49 - rework salvage: rework child rejected on report shape -> ONE salvage child, re-review proceeds, no re-implementation
  ---
  duration_ms: 1.0023
  type: 'test'
  ...
# Subtest: report-repair failure fails the task fast (exactly one repair attempt, no review burn)
ok 50 - report-repair failure fails the task fast (exactly one repair attempt, no review burn)
  ---
  duration_ms: 0.8966
  type: 'test'
  ...
# Subtest: checkpoint: phases running->completed, generation 1, counters on the happy path
ok 51 - checkpoint: phases running->completed, generation 1, counters on the happy path
  ---
  duration_ms: 0.7311
  type: 'test'
  ...
# Subtest: resume reconcile: interrupted older-generation checkpoint is marked, generation ++, allowances carried
ok 52 - resume reconcile: interrupted older-generation checkpoint is marked, generation ++, allowances carried
  ---
  duration_ms: 1.0747
  type: 'test'
  ...
# Subtest: blocked status: approval-required -> status blocked, counters reported
ok 53 - blocked status: approval-required -> status blocked, counters reported
  ---
  duration_ms: 1.9198
  type: 'test'
  ...
# Subtest: overload retry-needed: checkpoint records the wait reason
ok 54 - overload retry-needed: checkpoint records the wait reason
  ---
  duration_ms: 0.8909
  type: 'test'
  ...
# Subtest: shared queue (work-stealing): a short task never waits behind a striped lane-mate
ok 55 - shared queue (work-stealing): a short task never waits behind a striped lane-mate
  ---
  duration_ms: 117.3921
  type: 'test'
  ...
# Subtest: postPhase backlog cap: reviews bounded by post slots; work queue never blocked
ok 56 - postPhase backlog cap: reviews bounded by post slots; work queue never blocked
  ---
  duration_ms: 79.4383
  type: 'test'
  ...
# Subtest: review reserve: no work child starts inside the last 20 min, landed work still gets its review
ok 57 - review reserve: no work child starts inside the last 20 min, landed work still gets its review
  ---
  duration_ms: 46.429
  type: 'test'
  ...
# Subtest: one slot per leaf: a leaf never runs two children at once; the next leaf waits for a freed post slot
ok 58 - one slot per leaf: a leaf never runs two children at once; the next leaf waits for a freed post slot
  ---
  duration_ms: 93.7309
  type: 'test'
  ...
# Subtest: budget stop reports needsReview: landed work without a verdict, with its branch
ok 59 - budget stop reports needsReview: landed work without a verdict, with its branch
  ---
  duration_ms: 31.1552
  type: 'test'
  ...
# Subtest: paired wave: sibling merge lands during a work child's life - that child still passes acceptance
ok 60 - paired wave: sibling merge lands during a work child's life - that child still passes acceptance
  ---
  duration_ms: 2.0345
  type: 'test'
  ...
# Subtest: merger pre-flight under parallelism: 3-wide wave merges never overlap and each merger preflights main
ok 61 - merger pre-flight under parallelism: 3-wide wave merges never overlap and each merger preflights main
  ---
  duration_ms: 75.326
  type: 'test'
  ...
# Subtest: relay workModel: the ceremony launch spec carries workModel, not the top model
ok 62 - relay workModel: the ceremony launch spec carries workModel, not the top model
  ---
  duration_ms: 1.6763
  type: 'test'
  ...
# Subtest: npm bootstrap: ci only when node_modules missing or lockfile newer
ok 63 - npm bootstrap: ci only when node_modules missing or lockfile newer
  ---
  duration_ms: 3.0795
  type: 'test'
  ...
# Subtest: per-model cap: 3 same-model work children, cap 2 -> third starts only after a slot frees
ok 64 - per-model cap: 3 same-model work children, cap 2 -> third starts only after a slot frees
  ---
  duration_ms: 90.0279
  type: 'test'
  ...
# Subtest: per-model cap 3 with maxParallel 3: no artificial serialization
ok 65 - per-model cap 3 with maxParallel 3: no artificial serialization
  ---
  duration_ms: 46.2214
  type: 'test'
  ...
# Subtest: per-model cap keys by model: review (other model) overlaps saturated work model
ok 66 - per-model cap keys by model: review (other model) overlaps saturated work model
  ---
  duration_ms: 170.1793
  type: 'test'
  ...
# Subtest: modelLadder: overload on primary -> next attempt on the ladder model
ok 67 - modelLadder: overload on primary -> next attempt on the ladder model
  ---
  duration_ms: 2.0325
  type: 'test'
  ...
# Subtest: modelLadder exhausted -> fail-fast wait records lastModel
ok 68 - modelLadder exhausted -> fail-fast wait records lastModel
  ---
  duration_ms: 1.5251
  type: 'test'
  ...
# Subtest: modelLadder for review children never ladders onto the work model
ok 69 - modelLadder for review children never ladders onto the work model
  ---
  duration_ms: 1.558
  type: 'test'
  ...
# Subtest: runtime usageBudget rejection: terminal, no retry, no ladder, partial with reason
ok 70 - runtime usageBudget rejection: terminal, no retry, no ladder, partial with reason
  ---
  duration_ms: 1.2025
  type: 'test'
  ...
# Subtest: budget classification beats transport look-alikes
ok 71 - budget classification beats transport look-alikes
  ---
  duration_ms: 1.022
  type: 'test'
  ...
# Subtest: no-code analysis leaf (marker in rationale, artifact in ignored path): work+review pass, empty diff not rejected, merged no-code with bd close and no git commit
ok 72 - no-code analysis leaf (marker in rationale, artifact in ignored path): work+review pass, empty diff not rejected, merged no-code with bd close and no git commit
  ---
  duration_ms: 2.108
  type: 'test'
  ...
# Subtest: K2: no-code merged deletes its own branch - brief gates on git cherry and git branch -D; a deleted branch is not kept
ok 73 - K2: no-code merged deletes its own branch - brief gates on git cherry and git branch -D; a deleted branch is not kept
  ---
  duration_ms: 2.8358
  type: 'test'
  ...
# Subtest: no-code analysis: a missing artifact is rejected by the reviewer and the no-code merge never runs
ok 74 - no-code analysis: a missing artifact is rejected by the reviewer and the no-code merge never runs
  ---
  duration_ms: 1.0868
  type: 'test'
  ...
# Subtest: plain leaf with an empty diff keeps the empty-diff rejection and the merge-branch CLI (no marker)
ok 75 - plain leaf with an empty diff keeps the empty-diff rejection and the merge-branch CLI (no marker)
  ---
  duration_ms: 0.7986
  type: 'test'
  ...
# Subtest: no-code marker past the first 300 chars of the description does not select the analysis path
ok 76 - no-code marker past the first 300 chars of the description does not select the analysis path
  ---
  duration_ms: 1.0999
  type: 'test'
  ...
# Subtest: toy-falcon bd-epic: snapshot tasks, deps respected, curator/discovery skipped
ok 77 - toy-falcon bd-epic: snapshot tasks, deps respected, curator/discovery skipped
  ---
  duration_ms: 1.9833
  type: 'test'
  ...
# Subtest: toy-falcon sprint-1 start: args.bdTasks snapshot -> first child is work (NO initial boundary); empty snapshot -> boundary starts
ok 78 - toy-falcon sprint-1 start: args.bdTasks snapshot -> first child is work (NO initial boundary); empty snapshot -> boundary starts
  ---
  duration_ms: 2.0321
  type: 'test'
  ...
# Subtest: toy-falcon doneWhen: closed epic costs zero children
ok 79 - toy-falcon doneWhen: closed epic costs zero children
  ---
  duration_ms: 0.7504
  type: 'test'
  ...
# Subtest: toy-falcon growth: bd-cursor refresh picks up a new leaf mid-campaign
ok 80 - toy-falcon growth: bd-cursor refresh picks up a new leaf mid-campaign
  ---
  duration_ms: 1.2294
  type: 'test'
  ...
# Subtest: toy-falcon stale cursor: merged leaves never re-run when snapshot lags the driver
ok 81 - toy-falcon stale cursor: merged leaves never re-run when snapshot lags the driver
  ---
  duration_ms: 1.4005
  type: 'test'
  ...
# Subtest: toy-falcon П6: visual-criterion leaf without measure is NOT issued (CRITERION-NOT-MEASURABLE in the report); plain leaf unchanged
ok 82 - toy-falcon П6: visual-criterion leaf without measure is NOT issued (CRITERION-NOT-MEASURABLE in the report); plain leaf unchanged
  ---
  duration_ms: 2.1515
  type: 'test'
  ...
# Subtest: toy-falcon П6: visual-criterion leaf WITH measure is issued; the reviewer brief carries the measurement method
ok 83 - toy-falcon П6: visual-criterion leaf WITH measure is issued; the reviewer brief carries the measurement method
  ---
  duration_ms: 0.9543
  type: 'test'
  ...
# Subtest: toy-falcon end-race: last leaf merged but snapshot lags -> epic-closed, one extra cursor child
ok 84 - toy-falcon end-race: last leaf merged but snapshot lags -> epic-closed, one extra cursor child
  ---
  duration_ms: 1.2329
  type: 'test'
  ...
# Subtest: toy-falcon empty sprint: sprint 1 all failed -> NO sprint-2 boundary (no refresh, nothing janitored), the snapshot is reused, the failed leaf is retried and kept
ok 85 - toy-falcon empty sprint: sprint 1 all failed -> NO sprint-2 boundary (no refresh, nothing janitored), the snapshot is reused, the failed leaf is retried and kept
  ---
  duration_ms: 0.9732
  type: 'test'
  ...
# Subtest: toy-falcon merge: sprint 1 merged a leaf -> sprint 2 launches the bd-cursor refresh
ok 86 - toy-falcon merge: sprint 1 merged a leaf -> sprint 2 launches the bd-cursor refresh
  ---
  duration_ms: 1.1692
  type: 'test'
  ...
# Subtest: claim-dirt: merge preflight auto-commits .beads/issues.jsonl instead of refusing; other dirt still refuses
ok 87 - claim-dirt: merge preflight auto-commits .beads/issues.jsonl instead of refusing; other dirt still refuses
  ---
  duration_ms: 0.7687
  type: 'test'
  ...
# Subtest: claim-dirt: drop preflight carries the same exception (drop is blocked by the same porcelain)
ok 88 - claim-dirt: drop preflight carries the same exception (drop is blocked by the same porcelain)
  ---
  duration_ms: 1.4037
  type: 'test'
  ...
# Subtest: claim-dirt FAIL-SAFE: merger reports the failure contract (auto-commit left the path dirty) -> merged=false lands as merge-failed, never merged, no retry hides it
ok 89 - claim-dirt FAIL-SAFE: merger reports the failure contract (auto-commit left the path dirty) -> merged=false lands as merge-failed, never merged, no retry hides it
  ---
  duration_ms: 1.1508
  type: 'test'
  ...
# Subtest: claim-dirt FAIL-SAFE: drop executor reports the same failure contract -> dropped=false lands as drop-failed, branch left for manual review
ok 90 - claim-dirt FAIL-SAFE: drop executor reports the same failure contract -> dropped=false lands as drop-failed, branch left for manual review
  ---
  duration_ms: 1.434
  type: 'test'
  ...
# Subtest: merge child hard failure -> merged=false (verdict merge-failed), sibling still merges, campaign completes
ok 91 - merge child hard failure -> merged=false (verdict merge-failed), sibling still merges, campaign completes
  ---
  duration_ms: 2.3157
  type: 'test'
  ...
# Subtest: ISSUE-3 escalation: two identical merge failures in a row -> the third merge never starts; return carries needs-attention with both signatures
ok 92 - ISSUE-3 escalation: two identical merge failures in a row -> the third merge never starts; return carries needs-attention with both signatures
  ---
  duration_ms: 3.6093
  type: 'test'
  ...
# Subtest: E2.1: a held leaf (needs-attention) survives final cleanup - the janitor never touches it
ok 93 - E2.1: a held leaf (needs-attention) survives final cleanup - the janitor never touches it
  ---
  duration_ms: 1.1901
  type: 'test'
  ...
# Subtest: ISSUE-3 escalation: different merge errors in a row do not escalate - every merge runs
ok 94 - ISSUE-3 escalation: different merge errors in a row do not escalate - every merge runs
  ---
  duration_ms: 1.2169
  type: 'test'
  ...
# Subtest: ISSUE-3 escalation: the streak survives a resume - the pair completes in the resumed campaign and the next merge is held
ok 95 - ISSUE-3 escalation: the streak survives a resume - the pair completes in the resumed campaign and the next merge is held
  ---
  duration_ms: 2.1246
  type: 'test'
  ...
# Subtest: ISSUE-3 escalation: a provider wall between two identical merge failures breaks the streak (walls never fingerprint)
ok 96 - ISSUE-3 escalation: a provider wall between two identical merge failures breaks the streak (walls never fingerprint)
  ---
  duration_ms: 1.4641
  type: 'test'
  ...
# Subtest: ISSUE-3 escalation: an attempt ending in another stage between two identical merge failures resets the streak
ok 97 - ISSUE-3 escalation: an attempt ending in another stage between two identical merge failures resets the streak
  ---
  duration_ms: 1.4064
  type: 'test'
  ...
# Subtest: no stale PLANNED markers: agile-loop.js and SKILL.md describe only implemented behavior
ok 98 - no stale PLANNED markers: agile-loop.js and SKILL.md describe only implemented behavior
  ---
  duration_ms: 2.9505
  type: 'test'
  ...
# Subtest: no `|| true` on ANY git command in ANY generated brief; bd-close git failures are explicit
ok 99 - no `|| true` on ANY git command in ANY generated brief; bd-close git failures are explicit
  ---
  duration_ms: 2.0191
  type: 'test'
  ...
# Subtest: stale PLANNED markers are gone from agile-loop.js and SKILL.md (doc matches live code)
ok 100 - stale PLANNED markers are gone from agile-loop.js and SKILL.md (doc matches live code)
  ---
  duration_ms: 1.79
  type: 'test'
  ...
# Subtest: toy-falcon bd-close: the MERGER closes the merged leaf in bd (close steps in the merge spec, log records it); boundary carries NO bd-close; no post-loop re-close
ok 101 - toy-falcon bd-close: the MERGER closes the merged leaf in bd (close steps in the merge spec, log records it); boundary carries NO bd-close; no post-loop re-close
  ---
  duration_ms: 1.5212
  type: 'test'
  ...
# Subtest: toy-falcon bd-close: exactly-once across a multi-merge campaign - each merger closes its own leaf, no close is ever repeated
ok 102 - toy-falcon bd-close: exactly-once across a multi-merge campaign - each merger closes its own leaf, no close is ever repeated
  ---
  duration_ms: 2.7947
  type: 'test'
  ...
# Subtest: toy-falcon bd-close: failed leaf is never closed - NO boundary child (no refresh), no close section, the leaf is kept
ok 103 - toy-falcon bd-close: failed leaf is never closed - NO boundary child (no refresh), no close section, the leaf is kept
  ---
  duration_ms: 0.7887
  type: 'test'
  ...
# Subtest: toy-falcon bd-close: merger bd-close failure does not sink the merge - verdict merged stands, failure logged, the post-loop child retries
ok 104 - toy-falcon bd-close: merger bd-close failure does not sink the merge - verdict merged stands, failure logged, the post-loop child retries
  ---
  duration_ms: 1.3756
  type: 'test'
  ...
# Subtest: toy-falcon bd-close post-loop: the last sprint's merge is closed before return when the merger's bd-close failed and maxSprints ends the campaign
ok 105 - toy-falcon bd-close post-loop: the last sprint's merge is closed before return when the merger's bd-close failed and maxSprints ends the campaign
  ---
  duration_ms: 0.9461
  type: 'test'
  ...
# Subtest: toy-falcon bd-close post-loop: a failed final close is logged, never thrown, and the merge verdict stands
ok 106 - toy-falcon bd-close post-loop: a failed final close is logged, never thrown, and the merge verdict stands
  ---
  duration_ms: 0.9689
  type: 'test'
  ...
# Subtest: toy-falcon bd-close post-loop: epic-closed reached while the merger's bd-close failed (and the boundary errored) -> the post-loop child closes the merged leaf before return
ok 107 - toy-falcon bd-close post-loop: epic-closed reached while the merger's bd-close failed (and the boundary errored) -> the post-loop child closes the merged leaf before return
  ---
  duration_ms: 1.0587
  type: 'test'
  ...
# Subtest: toy-falcon bd-close post-loop: nothing pending after the merger closed everything -> NO post-loop child (epic-closed path unchanged)
ok 108 - toy-falcon bd-close post-loop: nothing pending after the merger closed everything -> NO post-loop child (epic-closed path unchanged)
  ---
  duration_ms: 1.0554
  type: 'test'
  ...
# Subtest: bd reconcile: a child-reported closed FAILED leaf is reopened post-loop, incident in return
ok 109 - bd reconcile: a child-reported closed FAILED leaf is reopened post-loop, incident in return
  ---
  duration_ms: 1.1131
  type: 'test'
  ...
# Subtest: bd write ban: work / rework / report-repair / repair briefs forbid worker bd close
ok 110 - bd write ban: work / rework / report-repair / repair briefs forbid worker bd close
  ---
  duration_ms: 3.9117
  type: 'test'
  ...
# Subtest: mergeApproval: bd-epic default is auto - merger commits on converged mechanical evidence, NO supervisor round
ok 111 - mergeApproval: bd-epic default is auto - merger commits on converged mechanical evidence, NO supervisor round
  ---
  duration_ms: 1.313
  type: 'test'
  ...
# Subtest: mergeApproval: curator default is confirm - the supervisor merge-approval question stays
ok 112 - mergeApproval: curator default is confirm - the supervisor merge-approval question stays
  ---
  duration_ms: 0.9761
  type: 'test'
  ...
# Subtest: mergeApproval: explicit args win over the mode defaults both ways; legacy mergePolicy auto still implies auto
ok 113 - mergeApproval: explicit args win over the mode defaults both ways; legacy mergePolicy auto still implies auto
  ---
  duration_ms: 1.8882
  type: 'test'
  ...
# Subtest: contract: work-class brief teaches the structured-output acceptance contract (fence gone, rp-schema)
ok 114 - contract: work-class brief teaches the structured-output acceptance contract (fence gone, rp-schema)
  ---
  duration_ms: 3.2386
  type: 'test'
  ...
# Subtest: contract: schema-valid structured output WITHOUT any fence is accepted end-to-end; reviewer brief carries the fresh head
ok 115 - contract: schema-valid structured output WITHOUT any fence is accepted end-to-end; reviewer brief carries the fresh head
  ---
  duration_ms: 1.1281
  type: 'test'
  ...
# Subtest: contract: WORK_SCHEMA carries the acceptance fields (head/testsAddedOrUpdated/commandsRun/validationOutput/residualRisks/noStagedFiles/criteriaSatisfied)
ok 116 - contract: WORK_SCHEMA carries the acceptance fields (head/testsAddedOrUpdated/commandsRun/validationOutput/residualRisks/noStagedFiles/criteriaSatisfied)
  ---
  duration_ms: 2.2207
  type: 'test'
  ...
# Subtest: work report without head -> schema-missing -> ONE salvage repair, merge uses the recovered head
ok 117 - work report without head -> schema-missing -> ONE salvage repair, merge uses the recovered head
  ---
  duration_ms: 0.8735
  type: 'test'
  ...
# Subtest: head not 40-hex -> schema-missing; salvage that fails too -> verdict failed (no review burn)
ok 118 - head not 40-hex -> schema-missing; salvage that fails too -> verdict failed (no review burn)
  ---
  duration_ms: 0.6767
  type: 'test'
  ...
# Subtest: foreign criteriaSatisfied ids -> schema-missing: criteriaSatisfied; unsalvageable -> verdict failed
ok 119 - foreign criteriaSatisfied ids -> schema-missing: criteriaSatisfied; unsalvageable -> verdict failed
  ---
  duration_ms: 0.7175
  type: 'test'
  ...
# Subtest: mutation probe: head violation -> schema-missing salvage (no re-brief)
ok 120 - mutation probe: head violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.7594
  type: 'test'
  ...
# Subtest: mutation probe: testsAddedOrUpdated violation -> schema-missing salvage (no re-brief)
ok 121 - mutation probe: testsAddedOrUpdated violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.7448
  type: 'test'
  ...
# Subtest: mutation probe: commandsRun violation -> schema-missing salvage (no re-brief)
ok 122 - mutation probe: commandsRun violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.7389
  type: 'test'
  ...
# Subtest: mutation probe: validationOutput violation -> schema-missing salvage (no re-brief)
ok 123 - mutation probe: validationOutput violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.6701
  type: 'test'
  ...
# Subtest: mutation probe: residualRisks violation -> schema-missing salvage (no re-brief)
ok 124 - mutation probe: residualRisks violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.6823
  type: 'test'
  ...
# Subtest: mutation probe: noStagedFiles violation -> schema-missing salvage (no re-brief)
ok 125 - mutation probe: noStagedFiles violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.789
  type: 'test'
  ...
# Subtest: mutation probe: criteriaSatisfied violation -> schema-missing salvage (no re-brief)
ok 126 - mutation probe: criteriaSatisfied violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 2.1286
  type: 'test'
  ...
# Subtest: mutation probe: criteriaSatisfied violation -> schema-missing salvage (no re-brief)
ok 127 - mutation probe: criteriaSatisfied violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.6912
  type: 'test'
  ...
# Subtest: mutation probe: criteriaSatisfied violation -> schema-missing salvage (no re-brief)
ok 128 - mutation probe: criteriaSatisfied violation -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.8344
  type: 'test'
  ...
# Subtest: mutation probe r2: criteriaSatisfied length !== 2 -> schema-missing salvage (no re-brief)
ok 129 - mutation probe r2: criteriaSatisfied length !== 2 -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 1.3403
  type: 'test'
  ...
# Subtest: mutation probe r2: criteriaSatisfied evidence blank -> schema-missing salvage (no re-brief)
ok 130 - mutation probe r2: criteriaSatisfied evidence blank -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.8383
  type: 'test'
  ...
# Subtest: mutation probe r2: commandsRun empty array -> schema-missing salvage (no re-brief)
ok 131 - mutation probe r2: commandsRun empty array -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.7404
  type: 'test'
  ...
# Subtest: mutation probe r2: commandsRun command blank -> schema-missing salvage (no re-brief)
ok 132 - mutation probe r2: commandsRun command blank -> schema-missing salvage (no re-brief)
  ---
  duration_ms: 0.6634
  type: 'test'
  ...
# Subtest: modelLadder duplicates collapse: [m-b, m-b] behaves like [m-b]
ok 133 - modelLadder duplicates collapse: [m-b, m-b] behaves like [m-b]
  ---
  duration_ms: 0.9592
  type: 'test'
  ...
# Subtest: K1: failed leaf -> NO boundary janitor and NO cleanup child: the branch and worktree are kept, return.keptBranches names them
ok 134 - K1: failed leaf -> NO boundary janitor and NO cleanup child: the branch and worktree are kept, return.keptBranches names them
  ---
  duration_ms: 1.0291
  type: 'test'
  ...
# Subtest: boundary merge: sprint 1 merged one leaf AND left one failed -> ONE s2-boundary refreshes the snapshot; the failed branch is kept, NOT janitored
ok 135 - boundary merge: sprint 1 merged one leaf AND left one failed -> ONE s2-boundary refreshes the snapshot; the failed branch is kept, NOT janitored
  ---
  duration_ms: 1.4043
  type: 'test'
  ...
# Subtest: boundary child dies at a snapshot refresh: failure is logged, sprint 2 runs on the previous snapshot, nothing is cleaned up
ok 136 - boundary child dies at a snapshot refresh: failure is logged, sprint 2 runs on the previous snapshot, nothing is cleaned up
  ---
  duration_ms: 1.1635
  type: 'test'
  ...
# Subtest: rotation: workModels round-robin glm->haiku->glm across tasks
ok 137 - rotation: workModels round-robin glm->haiku->glm across tasks
  ---
  duration_ms: 1.2321
  type: 'test'
  ...
# Subtest: rotation: reviewer skips the task's worker model (cross-model per task)
ok 138 - rotation: reviewer skips the task's worker model (cross-model per task)
  ---
  duration_ms: 0.8042
  type: 'test'
  ...
# Subtest: rotation preflight degradation: single reviewModels entry colliding with a work model warns and runs
ok 139 - rotation preflight degradation: single reviewModels entry colliding with a work model warns and runs
  ---
  duration_ms: 0.8507
  type: 'test'
  ...
# Subtest: rotation: rework pins the task's worker model (same worker continues)
ok 140 - rotation: rework pins the task's worker model (same worker continues)
  ---
  duration_ms: 1.0063
  type: 'test'
  ...
# Subtest: rotation absent -> legacy behavior untouched (workModel string, no lists)
ok 141 - rotation absent -> legacy behavior untouched (workModel string, no lists)
  ---
  duration_ms: 0.7952
  type: 'test'
  ...
# Subtest: breaker: second strike trips the model -> the next task starts directly on the ladder model (exactly 1 launch)
ok 142 - breaker: second strike trips the model -> the next task starts directly on the ladder model (exactly 1 launch)
  ---
  duration_ms: 35.3292
  type: 'test'
  ...
# Subtest: breaker: a strike below the threshold keeps the model primary; child success resets strikes
ok 143 - breaker: a strike below the threshold keeps the model primary; child success resets strikes
  ---
  duration_ms: 15.1226
  type: 'test'
  ...
# Subtest: breaker: resume restores overload strikes from the checkpoint
ok 144 - breaker: resume restores overload strikes from the checkpoint
  ---
  duration_ms: 45.6998
  type: 'test'
  ...
# Subtest: breaker: ALL models tripped -> child starts with the primary as-is (breaker must not brick the campaign)
ok 145 - breaker: ALL models tripped -> child starts with the primary as-is (breaker must not brick the campaign)
  ---
  duration_ms: 2.9691
  type: 'test'
  ...
# Subtest: cooling-down: 429 'Server requested Ns retry delay' -> model cooling in the checkpoint; the resumed campaign skips it
ok 146 - cooling-down: 429 'Server requested Ns retry delay' -> model cooling in the checkpoint; the resumed campaign skips it
  ---
  duration_ms: 28.1087
  type: 'test'
  ...
# Subtest: cooling-down: unparsable 429 -> default 600s; parsed delay is capped at 7200s
ok 147 - cooling-down: unparsable 429 -> default 600s; parsed delay is capped at 7200s
  ---
  duration_ms: 31.7341
  type: 'test'
  ...
# Subtest: cooling-down: 403 'Request not allowed' quota wall (live precedent) -> default 600s cooling + ladder escape; the resumed campaign skips it
ok 148 - cooling-down: 403 'Request not allowed' quota wall (live precedent) -> default 600s cooling + ladder escape; the resumed campaign skips it
  ---
  duration_ms: 31.0332
  type: 'test'
  ...
# Subtest: cooling-down: 'forbidden' quota wall without any 429 marker -> same treatment: cooling + breaker strike + ladder escape
ok 149 - cooling-down: 'forbidden' quota wall without any 429 marker -> same treatment: cooling + breaker strike + ladder escape
  ---
  duration_ms: 15.2881
  type: 'test'
  ...
# Subtest: cooling-down: work pool skips a cooling model (until > now) and starts on the next one
ok 150 - cooling-down: work pool skips a cooling model (until > now) and starts on the next one
  ---
  duration_ms: 15.5437
  type: 'test'
  ...
# Subtest: cooling-down: expired until -> the model is eligible again
ok 151 - cooling-down: expired until -> the model is eligible again
  ---
  duration_ms: 16.1073
  type: 'test'
  ...
# Subtest: cooling-down: ALL work models cooling -> the one with the minimal until is taken
ok 152 - cooling-down: ALL work models cooling -> the one with the minimal until is taken
  ---
  duration_ms: 16.1379
  type: 'test'
  ...
# Subtest: cooling-down: review pool skips a cooling reviewer model
ok 153 - cooling-down: review pool skips a cooling reviewer model
  ---
  duration_ms: 1.2188
  type: 'test'
  ...
# Subtest: cooling-down: ladder start skips the cooling primary and leads with the ladder model
ok 154 - cooling-down: ladder start skips the cooling primary and leads with the ladder model
  ---
  duration_ms: 1.4219
  type: 'test'
  ...
# Subtest: single-model degradation: one model on work+review does NOT throw - review runs on it with a warning
ok 155 - single-model degradation: one model on work+review does NOT throw - review runs on it with a warning
  ---
  duration_ms: 1.3346
  type: 'test'
  ...
# Subtest: single-model degradation: legacy workModel===reviewModel warns and works; reviewModels>=2 keeps the reviewer different
ok 156 - single-model degradation: legacy workModel===reviewModel warns and works; reviewModels>=2 keeps the reviewer different
  ---
  duration_ms: 1.7541
  type: 'test'
  ...
# Subtest: review tier none: 0 review children, the reviewer is never asked, merge gate still merges
ok 157 - review tier none: 0 review children, the reviewer is never asked, merge gate still merges
  ---
  duration_ms: 1.0612
  type: 'test'
  ...
# Subtest: review tier none: salvage-covered head-less report still merges via recovered head; red checks -> merge-failed
ok 158 - review tier none: salvage-covered head-less report still merges via recovered head; red checks -> merge-failed
  ---
  duration_ms: 5.5069
  type: 'test'
  ...
# Subtest: review tier none: completed=false fails fast (no reviewer, no rework ladder)
ok 159 - review tier none: completed=false fails fast (no reviewer, no rework ladder)
  ---
  duration_ms: 1.3959
  type: 'test'
  ...
# Subtest: review tier lite: checklist prompt WITHOUT refute protocol, cross-model review still runs, merge gate unchanged
ok 160 - review tier lite: checklist prompt WITHOUT refute protocol, cross-model review still runs, merge gate unchanged
  ---
  duration_ms: 1.8169
  type: 'test'
  ...
# Subtest: review tier full: unchanged judge prompt; missing and unknown tiers fall back to full
ok 161 - review tier full: unchanged judge prompt; missing and unknown tiers fall back to full
  ---
  duration_ms: 2.0345
  type: 'test'
  ...
# Subtest: review tier from a boundary refresh: a leaf that arrives mid-campaign with review none runs without a review
ok 162 - review tier from a boundary refresh: a leaf that arrives mid-campaign with review none runs without a review
  ---
  duration_ms: 1.5834
  type: 'test'
  ...
# Subtest: snapshot leaf with verify:true is an ordinary work leaf: branch/worktree created, review and merge run, verdict merged
ok 163 - snapshot leaf with verify:true is an ordinary work leaf: branch/worktree created, review and merge run, verdict merged
  ---
  duration_ms: 0.8019
  type: 'test'
  ...
# Subtest: carry-over: failed attempt -> next sprint's retry brief carries branch, files and stop point (no worker narrative)
ok 164 - carry-over: failed attempt -> next sprint's retry brief carries branch, files and stop point (no worker narrative)
  ---
  duration_ms: 1.5706
  type: 'test'
  ...
# Subtest: carry-over: merge refused -> carry records the merge stop point and the branch's files
ok 165 - carry-over: merge refused -> carry records the merge stop point and the branch's files
  ---
  duration_ms: 1.1543
  type: 'test'
  ...
# Subtest: carry-over: checkpoint roundtrip - carry is persisted and survives a resume into the first brief of the resumed run
ok 166 - carry-over: checkpoint roundtrip - carry is persisted and survives a resume into the first brief of the resumed run
  ---
  duration_ms: 1.7637
  type: 'test'
  ...
# Subtest: campaign analytics: archiver child launches once at campaign end, after final cleanup, with a copy+analyze brief
ok 167 - campaign analytics: archiver child launches once at campaign end, after final cleanup, with a copy+analyze brief
  ---
  duration_ms: 1.254
  type: 'test'
  ...
# Subtest: campaign analytics: default-on (auto-run), child failure is best-effort - status and counts untouched
ok 168 - campaign analytics: default-on (auto-run), child failure is best-effort - status and counts untouched
  ---
  duration_ms: 1.1233
  type: 'test'
  ...
# Subtest: campaign analytics: skipped=true (e.g. runtime artifacts not found) is surfaced, not an error
ok 169 - campaign analytics: skipped=true (e.g. runtime artifacts not found) is surfaced, not an error
  ---
  duration_ms: 0.7793
  type: 'test'
  ...
# Subtest: campaign analytics: analytics=false or empty metricsScript opts out - child never launches
ok 170 - campaign analytics: analytics=false or empty metricsScript opts out - child never launches
  ---
  duration_ms: 1.4316
  type: 'test'
  ...
# Subtest: campaign analytics: archiver 429 does not permanently strike the campaign primary
ok 171 - campaign analytics: archiver 429 does not permanently strike the campaign primary
  ---
  duration_ms: 2.4753
  type: 'test'
  ...
# Subtest: campaign analytics: archiver 429 strikes do not leak into the checkpoint (restore, not record)
ok 172 - campaign analytics: archiver 429 strikes do not leak into the checkpoint (restore, not record)
  ---
  duration_ms: 2.2702
  type: 'test'
  ...
# Subtest: analyze-campaign.mjs CLI: wall timeline, failure classes (incl. ok:true failing report), usage, journal -> metrics.json + retro
ok 173 - analyze-campaign.mjs CLI: wall timeline, failure classes (incl. ok:true failing report), usage, journal -> metrics.json + retro
  ---
  duration_ms: 95.1085
  type: 'test'
  ...
# Subtest: analyze-campaign.mjs honesty: no timestamps -> wallMs null (never 0); no token sources -> '?' (exit 0)
ok 174 - analyze-campaign.mjs honesty: no timestamps -> wallMs null (never 0); no token sources -> '?' (exit 0)
  ---
  duration_ms: 80.8841
  type: 'test'
  ...
# Subtest: analyze-campaign.mjs parity: snapshot steps[] startedAt -> per-child wallMs when the child has no child-status 'started' event (collect_metrics.py contract)
ok 175 - analyze-campaign.mjs parity: snapshot steps[] startedAt -> per-child wallMs when the child has no child-status 'started' event (collect_metrics.py contract)
  ---
  duration_ms: 79.6029
  type: 'test'
  ...
# Subtest: analyze-campaign.mjs taxonomy: failure classes + key shapes match the collect_metrics.py contract
ok 176 - analyze-campaign.mjs taxonomy: failure classes + key shapes match the collect_metrics.py contract
  ---
  duration_ms: 1.8254
  type: 'test'
  ...
# Subtest: qa6: merger brief rebases onto main before the squash - conflicts resolve at rebase, auto-evidence covers the rebase
ok 177 - qa6: merger brief rebases onto main before the squash - conflicts resolve at rebase, auto-evidence covers the rebase
  ---
  duration_ms: 0.9324
  type: 'test'
  ...
# Subtest: wide wave unawaited-launch contract: 2 bd-epic leaves, one sprint, no deps - all work->review->merge chains consumed, normal epic-closed stop
ok 178 - wide wave unawaited-launch contract: 2 bd-epic leaves, one sprint, no deps - all work->review->merge chains consumed, normal epic-closed stop
  ---
  duration_ms: 25.1439
  type: 'test'
  ...
# Subtest: wide wave curator mode: 2 sibling tasks in wave 1 - post-phase chains consumed, analytics after merges
ok 179 - wide wave curator mode: 2 sibling tasks in wave 1 - post-phase chains consumed, analytics after merges
  ---
  duration_ms: 29.3706
  type: 'test'
  ...
# Subtest: serial path (single-task wave) under tracker emulation: every launch consumed, serial schedule kept
ok 180 - serial path (single-task wave) under tracker emulation: every launch consumed, serial schedule kept
  ---
  duration_ms: 4.2932
  type: 'test'
  ...
# Subtest: contract: campaign start writes the report schemas to <journalDir>/report-schema.json BEFORE the first work child (R1)
ok 181 - contract: campaign start writes the report schemas to <journalDir>/report-schema.json BEFORE the first work child (R1)
  ---
  duration_ms: 4.0149
  type: 'test'
  ...
# Subtest: contract: work, rework and merge briefs each carry exactly one report self-check call (R1)
ok 182 - contract: work, rework and merge briefs each carry exactly one report self-check call (R1)
  ---
  duration_ms: 1.3405
  type: 'test'
  ...
# Subtest: report-check: a valid work draft against the engine schema exits 0 (R1)
ok 183 - report-check: a valid work draft against the engine schema exits 0 (R1)
  ---
  duration_ms: 699.27
  type: 'test'
  ...
# Subtest: report-check: a valid merge draft exits 0 (R1)
ok 184 - report-check: a valid merge draft exits 0 (R1)
  ---
  duration_ms: 75.9997
  type: 'test'
  ...
# Subtest: report-check: head 'x', no worktree, no what_done, noStagedFiles=true over a dirty worktree -> exact per-field lines, exit 1 (R1)
ok 185 - report-check: head 'x', no worktree, no what_done, noStagedFiles=true over a dirty worktree -> exact per-field lines, exit 1 (R1)
  ---
  duration_ms: 637.3354
  type: 'test'
  ...
# Subtest: report-check: an honest noStagedFiles=false over a dirty worktree is a named line, not a schema error (R1)
ok 186 - report-check: an honest noStagedFiles=false over a dirty worktree is a named line, not a schema error (R1)
  ---
  duration_ms: 544.5914
  type: 'test'
  ...
# Subtest: R1: an honest noStagedFiles=false report passes the repair schema and the in-script acceptance check (forced const removed)
ok 187 - R1: an honest noStagedFiles=false report passes the repair schema and the in-script acceptance check (forced const removed)
  ---
  duration_ms: 1.6389
  type: 'test'
  ...
# Subtest: merge CLI exit-2 brief and already-closed bd leaf contract
ok 188 - merge CLI exit-2 brief and already-closed bd leaf contract
  ---
  duration_ms: 2.7519
  type: 'test'
  ...
# Subtest: mergeBranch conflict fixture: exit 2 reports conflicts and leaves integration HEAD untouched
ok 189 - mergeBranch conflict fixture: exit 2 reports conflicts and leaves integration HEAD untouched
  ---
  duration_ms: 5482.0466
  type: 'test'
  ...
# Subtest: mergeBranch clean fixture: deterministic CLI squashes after full test command
ok 190 - mergeBranch clean fixture: deterministic CLI squashes after full test command
  ---
  duration_ms: 2966.5948
  type: 'test'
  ...
# Subtest: mergeBranch ignored .beads is closed without an export commit
ok 191 - mergeBranch ignored .beads is closed without an export commit
  ---
  duration_ms: 0.3524
  type: 'test'
  ...
# Subtest: mergeBranch bd spawn error is best-effort after committed merge
ok 192 - mergeBranch bd spawn error is best-effort after committed merge
  ---
  duration_ms: 3674.898
  type: 'test'
  ...
# Subtest: K2: mergeBranch deletes the merged campaign branch after git cherry; a foreign feat/* branch is never touched
ok 193 - K2: mergeBranch deletes the merged campaign branch after git cherry; a foreign feat/* branch is never touched
  ---
  duration_ms: 5548.1664
  type: 'test'
  ...
# Subtest: K2: a campaign branch whose git cherry shows a '+' line is kept (branchDeleted=false) and the merge still stands
ok 194 - K2: a campaign branch whose git cherry shows a '+' line is kept (branchDeleted=false) and the merge still stands
  ---
  duration_ms: 4517.4713
  type: 'test'
  ...
# Subtest: ISSUE-7 unit: mergeBranch gate env drops PI_SUBAGENT_CHILD/DEPTH, keeps PATH/HOME, leaves the merger's own env intact
ok 195 - ISSUE-7 unit: mergeBranch gate env drops PI_SUBAGENT_CHILD/DEPTH, keeps PATH/HOME, leaves the merger's own env intact
  ---
  duration_ms: 4173.9055
  type: 'test'
  ...
# Subtest: ISSUE-7 carrier: a gate script that fails on an inherited PI_SUBAGENT_CHILD passes under the merger gate
ok 196 - ISSUE-7 carrier: a gate script that fails on an inherited PI_SUBAGENT_CHILD passes under the merger gate
  ---
  duration_ms: 4266.3341
  type: 'test'
  ...
# Subtest: main-copy isolation: a change in main between baseline and merge blocks the merge, is reported, and is NOT reverted
ok 197 - main-copy isolation: a change in main between baseline and merge blocks the merge, is reported, and is NOT reverted
  ---
  duration_ms: 1.6927
  type: 'test'
  ...
# Subtest: main-copy isolation: a PRE-EXISTING dirty tracked file overwritten during the campaign (porcelain line unchanged) blocks the merge and is NOT reverted
ok 198 - main-copy isolation: a PRE-EXISTING dirty tracked file overwritten during the campaign (porcelain line unchanged) blocks the merge and is NOT reverted
  ---
  duration_ms: 0.9241
  type: 'test'
  ...
# Subtest: main-copy isolation: a PRE-EXISTING untracked file rewritten during the campaign (porcelain line unchanged) blocks the merge
ok 199 - main-copy isolation: a PRE-EXISTING untracked file rewritten during the campaign (porcelain line unchanged) blocks the merge
  ---
  duration_ms: 0.7785
  type: 'test'
  ...
# Subtest: main-copy isolation: pre-existing baseline dirt and engine-owned safe-list paths are NOT incidents; the baseline is recorded
ok 200 - main-copy isolation: pre-existing baseline dirt and engine-owned safe-list paths are NOT incidents; the baseline is recorded
  ---
  duration_ms: 2.1724
  type: 'test'
  ...
# Subtest: main-copy isolation: resume keeps the campaign baseline (no re-probe) and still catches a NEW mutation only
ok 201 - main-copy isolation: resume keeps the campaign baseline (no re-probe) and still catches a NEW mutation only
  ---
  duration_ms: 1.1011
  type: 'test'
  ...
# Subtest: main-copy isolation: a resumed checkpoint WITHOUT content evidence fails closed on its dirty baseline paths
ok 202 - main-copy isolation: a resumed checkpoint WITHOUT content evidence fails closed on its dirty baseline paths
  ---
  duration_ms: 1.3592
  type: 'test'
  ...
# Subtest: main-copy isolation: a NEW .beads/ path other than issues.jsonl is NOT engine-owned: it is an incident, the merge is refused, nothing is reverted
ok 203 - main-copy isolation: a NEW .beads/ path other than issues.jsonl is NOT engine-owned: it is an incident, the merge is refused, nothing is reverted
  ---
  duration_ms: 1.0163
  type: 'test'
  ...
# Subtest: main-copy isolation: rework and report-repair specs carry the worktree cwd; work-class briefs carry the absolute-path rule
ok 204 - main-copy isolation: rework and report-repair specs carry the worktree cwd; work-class briefs carry the absolute-path rule
  ---
  duration_ms: 1.6999
  type: 'test'
  ...
# Subtest: mergeBranch phantom dirt: porcelain-dirty worktree with quiet unstaged diff merges, phantomDirtCleared names all three files
ok 205 - mergeBranch phantom dirt: porcelain-dirty worktree with quiet unstaged diff merges, phantomDirtCleared names all three files
  ---
  duration_ms: 4870.1165
  type: 'test'
  ...
# Subtest: mergeBranch gate failure keeps the resume: retry with the same approvedSha continues from the gate, not branch moved
ok 206 - mergeBranch gate failure keeps the resume: retry with the same approvedSha continues from the gate, not branch moved
  ---
  duration_ms: 4204.4784
  type: 'test'
  ...
# Subtest: E0.2 known flake: gate red only on a --known-flakes name, targeted retry green -> merged and flakeRetried names it
ok 207 - E0.2 known flake: gate red only on a --known-flakes name, targeted retry green -> merged and flakeRetried names it
  ---
  duration_ms: 3419.0444
  type: 'test'
  ...
# Subtest: E0.2 unlisted failure: one failing name outside --known-flakes refuses the merge with reset --hard, even if it would pass on retry
ok 208 - E0.2 unlisted failure: one failing name outside --known-flakes refuses the merge with reset --hard, even if it would pass on retry
  ---
  duration_ms: 3074.9462
  type: 'test'
  ...
# Subtest: П4 re-issue with a saved attempt: CONTINUATION brief continues the branch per fix_list, no git worktree add
ok 209 - П4 re-issue with a saved attempt: CONTINUATION brief continues the branch per fix_list, no git worktree add
  ---
  duration_ms: 1.4814
  type: 'test'
  ...
# Subtest: П4 collision without attempt: STOP contract stays (no duplicate created), slug unique per attempt on a known collision
ok 210 - П4 collision without attempt: STOP contract stays (no duplicate created), slug unique per attempt on a known collision
  ---
  duration_ms: 1.4073
  type: 'test'
  ...
# Subtest: agile_run: bd-epic launch plan from a mocked bd (open leaves, engine shape, defaults)
ok 211 - agile_run: bd-epic launch plan from a mocked bd (open leaves, engine shape, defaults)
  ---
  duration_ms: 7.3734
  type: 'test'
  ...
# Subtest: agile_run: bundleScript absent -> warning in the output, args carry no bundleScript
ok 212 - agile_run: bundleScript absent -> warning in the output, args carry no bundleScript
  ---
  duration_ms: 0.8785
  type: 'test'
  ...
# Subtest: agile_run: files_hint is the Файлы: line up to the sentence end; a path after that dot stays out, length capped
ok 213 - agile_run: files_hint is the Файлы: line up to the sentence end; a path after that dot stays out, length capped
  ---
  duration_ms: 0.6655
  type: 'test'
  ...
# Subtest: agile_run: leaf without a Файлы: line -> empty files_hint and a warning; prose paths never used
ok 214 - agile_run: leaf without a Файлы: line -> empty files_hint and a warning; prose paths never used
  ---
  duration_ms: 0.6117
  type: 'test'
  ...
# Subtest: agile_run: Метод измерения: line -> measure (whole line, capped); absent -> measure stays '' (leaf unchanged)
ok 215 - agile_run: Метод измерения: line -> measure (whole line, capped); absent -> measure stays '' (leaf unchanged)
  ---
  duration_ms: 1.6605
  type: 'test'
  ...
# Subtest: agile_run: rationale/acceptance over the limit -> warning with leaf id and length (no silent cut)
ok 216 - agile_run: rationale/acceptance over the limit -> warning with leaf id and length (no silent cut)
  ---
  duration_ms: 0.9812
  type: 'test'
  ...
# Subtest: agile_run: workModels overlapping reviewModels -> error string
ok 217 - agile_run: workModels overlapping reviewModels -> error string
  ---
  duration_ms: 0.985
  type: 'test'
  ...
# Subtest: agile_run: distinct workModels/reviewModels pass through to args
ok 218 - agile_run: distinct workModels/reviewModels pass through to args
  ---
  duration_ms: 0.7648
  type: 'test'
  ...
# Subtest: agile_run: invalid mergeApproval -> error string
ok 219 - agile_run: invalid mergeApproval -> error string
  ---
  duration_ms: 0.8803
  type: 'test'
  ...
# Subtest: agile_run: epic with no open leaves -> error (nothing to launch)
ok 220 - agile_run: epic with no open leaves -> error (nothing to launch)
  ---
  duration_ms: 0.986
  type: 'test'
  ...
# Subtest: agile_run: closed leaf whose dep is still open -> error (bd inconsistency)
ok 221 - agile_run: closed leaf whose dep is still open -> error (bd inconsistency)
  ---
  duration_ms: 0.5044
  type: 'test'
  ...
# Subtest: agile_run: missing epic -> error naming the epic
ok 222 - agile_run: missing epic -> error naming the epic
  ---
  duration_ms: 0.3011
  type: 'test'
  ...
# Subtest: agile_run: missing epic/testCommand -> error
ok 223 - agile_run: missing epic/testCommand -> error
  ---
  duration_ms: 0.3023
  type: 'test'
  ...
# Subtest: agile_status: empty temp -> 'no runs found' (no crash)
ok 224 - agile_status: empty temp -> 'no runs found' (no crash)
  ---
  duration_ms: 1.6863
  type: 'test'
  ...
# Subtest: agile_status: unknown runId -> 'not found' (no crash)
ok 225 - agile_status: unknown runId -> 'not found' (no crash)
  ---
  duration_ms: 2.5868
  type: 'test'
  ...
# Subtest: agile_status: freshest run dir -> workflow result, checkpoint and last child_settled (read-only)
ok 226 - agile_status: freshest run dir -> workflow result, checkpoint and last child_settled (read-only)
  ---
  duration_ms: 15.2919
  type: 'test'
  ...
1..226
# tests 226
# suites 0
# pass 226
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 50080.918

diff stat:


correctness review:
{"verdict":"pass","blockers":[],"evidence":["docs/plans/taskflow-pilot/PLAN.md:58","workflows/agile-loop.js:960-963","workflows/agile-loop.js:815-818","workflows/agile-loop.js:2426-2435","workflows/agile-loop.js:2444-2451","workflows/agile-loop.js:2463-2477","workflows/agile-loop.js:2568-2572","tests/agile-loop.test.mjs:2380-2402","tests/agile-loop.test.mjs:2405-2443"],"tests":"verified-by-script-phase"}

guardrails review:
{"verdict":"pass","blockers":[],"evidence":["workflows/agile-loop.js:963 — shared BD_WRITE_BAN explicitly prohibits close/create/update and is inserted into work (1394), rework (1887), repair (1462), and report-repair (1325) briefs.","workflows/agile-loop.js:2436-2477 — post-loop reconciliation identifies suspect leaves, issues `bd reopen`, records incidents, logs outcome, and persists them.","tests/agile-loop.test.mjs:2379-2403 — test covers reopening a falsely closed failed leaf and incident reporting; lines 2405-2442 cover the four brief bans.","tests/agile-loop.test.mjs:2405-2442 — brief assertions verify the prohibited operations and authorized writers. No bd executable call was added could not be independently verified: shell access was unavailable."],"tests":"verified-by-script-phase"}

Gate outcomes, final git state, token/time figures: appended by driver after the run. No bd command was executed by the pilot.

---

## Итог ведущего (после прогона)

**Результат:** успешный прогон `agile-leaf-pilot-mwxkqdnf-7e47f5`, status `completed`. Оба ревьюера дали `pass`, три score-гейта прошли автоматически без LLM, script-фазы сделали коммит `d036579` и fast-forward мерж в клоне, финальная проверка чистая. bd не вызывался ни одной фазой. Рабочий репозиторий не получил коммитов пилота.

### Что пошло не так до успеха (честно)

| Прогон | Что произошло | Урок |
|---|---|---|
| `-mwish29-16d183`, `-mwj0jsf-884eba`, `-mwj2y1m-76329c` | `npm test`: 224 теста, 7 провалов с `'true' is not recognized` | Script-фаза taskflow на этой машине идёт через `cmd.exe`, а фикстуры merge-branch spawn'ят POSIX `true`; PATH-префикс и shim — amendment 1 |
| `-mwxja318-d014a9` | Воркер сделал изменение, но его новый тест ожидал `rework` и `repair` в одной кампании; `verify` 225 pass / 1 fail | Один вызов модели не гарантирует корректный тест; в agile это был бы rework-цикл |
| `-mwjr9x2-55218f`, `-mwxjxfoh-b45b4b` | resume с big-промптами → `spawn ENAMETOOLONG` | Большие выводы нельзя интерполировать в argv агента; amendment 2 укоротил промпты и перенёс выводы в stdin отчёта |
| `-mwxkcnww-627169` | Воркер снова сделал изменение, но тест ожидал точную фразу «Only the merge child and…»; `verify` 225 pass / 1 fail | Второй ручной repair теста в клоне (registry regex → фактический текст движка) |

### Метрики

| Прогон | Wall | Токены | Завершение |
|---|---:|---:|---|
| Успешный финальный | 234.0 c | 228 800 (work 107 693, review 72 468 + 48 639) | completed, merge в клоне |
| Первый полный с воркером | 469.7 c | 185 510 | failed на verify |
| Все 8 запусков пилота вместе | — | 957 444 | 1 completed, 7 failed |

Ориентир из реальной agile-кампании `4b3502da`: 30 детей, 1 002 394 токена, 5 571 c, 3 смерженных листа, 5 rework, 2 failure → примерно **334k токенов на смерженный лист**. Пилот потратил **957k токенов на один лист** — в ~2.9 раза дороже, если считать все неудачные запуски. Даже только успешный прогон (229k) не дешевле ориентира. Вывод: в текущем виде DAG **не доказал экономию**; основная причина — четыре цикла среды/промптов и два ручных repair-а тестов, а не в самом графе. Граф при этом дал обнуляемые гейты и структурную гарантию «без ревью → без мержа».

### Ограничения

- Два ревьюера работали на одной модели `openai-codex/gpt-6-luna` (другие доступные модели в сессии недоступны); независимость обеспечивалась свежими сеансами, но не разными моделями.
- Guardrails-ревьюер не смог независимо проверить отсутствие bd-вызова через shell (у него нет bash); проверка сделана статически по `tools` и `run`-командам.
- При падении `base` заготовка отчёта не создаётся; при падении `verify` создаётся `report-stub`, детальный отчёт дописан ведущим вручную.
- Локальный shim `C:/Users/user/bin/true.cmd`, созданный для cmd-фикстур, удалён ведущим после прогона.

### Уточнение метрики: замер по `*.trace.jsonl`

Таблица выше считала только `input + output` («fresh»). Taskflow отдельно сообщает `cacheRead/cacheWrite`: это не новые токены, но контекст, который модель реально прогоняла. Полная картина по всем 8 запускам пилота:

| Этап | fresh | cache | всего | turns |
|---|---:|---:|---:|---:|
| `work` (5 вызовов) | 746 871 | 13 975 552 | 14 722 423 | 144 |
| `review-correctness` (2 вызова) | 161 934 | 384 896 | 546 830 | 10 |
| `review-guardrails` (1 вызов) | 48 639 | 135 424 | 184 063 | 5 |
| script-фазы и гейты | 0 | 0 | 0 | 0 |
| **ИТОГО** | **957 444** | **14 495 872** | **15 453 316** | **159** |

Успешный прогон `mwkqdnf-7e47f5` отдельно:

| Этап | fresh | cache | всего | turns |
|---|---:|---:|---:|---:|
| work | 107 693 | 681 216 | 788 909 | 11 |
| review-correctness | 72 468 | 204 288 | 276 756 | 5 |
| review-guardrails | 48 639 | 135 424 | 184 063 | 5 |
| **ИТОГО** | **228 800** | **1 020 928** | **1 249 728** | **21** |

Денежная стоимость в trace есть только у ревьюеров на `openai-codex/gpt-6-luna`: **$0.01599** за успешный прогон ( correctness $0.00960 + guardrails $0.00639 ). У воркера `opencode-go/hy4-flash-free` taskflow вернул `cost: 0`, поэтому сравнивать пилот с agile по долларам напрямую нельзя — сравнивать можно только по токенам и wall time. Вывод прежний: даже по «fresh» пилот дороже ориентира, а с учётом cache разрыв ещё больше; основная масса токенов — это именно повторные прогоны `work`.

---

## Rev.4 (Amendment 3): что изменилось и что получилось

Реализовано: переносимые фикстуры `node -e 0`, детерминированные `contract-check`/`parse-check` и два gate с `onBlock: retry`, 15-turn лимит и таймауты воркера, budget `$0.5 / 2M`, cross-run кэш ревьюеров, дешёвый guardrails, автоматический `metrics.mjs`, удаление PATH-костылей. Все правки прошли свежее ревью с вердиктом ГОДЕН, `taskflow verify` — 0 ошибок/0 предупреждений.

**Итог: 11 прогонов rev.4, ни одного успешного.** Ни один коммит и мерж не состоялся — каждый раз детерминированный gate или ревью блокировали выход. Последний прогон `mwxt7gq8-558545` дошёл до обоих ревью; оба дали `block` по реальным семантическим причинам: в `fix-only rework` брифе нет `BD_WRITE_BAN`, тест проверяет только строки исходника, а не поведение `bd reopen`, подтверждённые post-loop close-ы не попадают в `bdClosedIds`. Gate корректно не дал зайти в commit.

| Метрика rev.4 | Значение |
|---|---:|
| Прогонов | 11 |
| fresh | 1 740 207 |
| cache | 15 982 336 |
| всего токенов | 17 722 543 |
| Успешных мержей | 0 |

Вывод ведущего: гейты и ревью сделали свою работу — протекли только баги, в прод ничего не ушло. Но **rework без передачи причины отказа в промпт** и статический контракт не закрывают семантический разрыв: воркер за 15 turn-ов стабильно производил «строки ради теста». Rev.4 дешевле не стал и не заменил успешный rev.3; оставляю rev.3 как единственный рабочий результат и прекращаю итерации по rev.4 — дальше нужно либо передавать blockers в rework-промпт, либо давать воркеру ограниченный shell для `node --check`, что отдельно требует решения по «no bd»-гарантии.

---

## Rev.5 (Amendment 4): быстро и дёшево через повторное использование

Решение ведущего: раз успешный результат уже получен и принят ревью, **не платить за генерацию дважды**. Вместо повторного вызова воркера добавлен `seed.patch` — зафиксированный диф успешного прогона `d036579`, совмещённый с переносимыми фикстурами `node -e 0`. Скриптовая фаза `seed` применяет его, `seed-check` дешёво проверяет контракт/синтаксис, и только при провале включается воркер (`when: != "SEED OK"`). Убраны `onBlock: retry` на гейтах (идентичный промпт не давал улучшения), дублирующий `npm test` внутри seed-check, бюджет снижен до 1,2M токенов.

| Прогон rev.5 | Результат | fresh | cache | wall | Комментарий |
|---|---|---:|---:|---:|---|
| `agile-leaf-pilot-mwxv52gt-2a06cb` | completed | 187 188 | 1 249 536 | 310.2 c | воркер пропущен, оба ревью pass, commit+merge |
| `agile-leaf-pilot-mwxvcr6h-d281dd` | completed | **0** | **0** | **105.6 c** | оба ревью из cross-run cache, commit+merge |

**Итог по улучшению:** относительно успешного rev.3 (228 800 fresh / 234.0 c) первый rev.5-прогон дешевле на ~18%, а повторный — **почти бесплатный и в 2.2 раза быстрее**: ни одного нового LLM-вызова, оформление и мерж за 1m46s. Относительно rev.4 (1 740 207 fresh, 0 мержа) — экономия в 9,3 раза на первом прогоне и 100% на повторном.

Структурная гарантия сохранена: `contract-check`, `parse-check`, `npm test`, два свежих ревью и три score gate остались обязательными; пропущен только воркер, потому что его результат уже существует и был принят.

### P0/P1: финальные доработки

- **P0 (отчёт):** `report`/`report-stub` пишут в `reports/`, `results.md` больше не перезаписывается. Проверено: прогон `agile-leaf-pilot-mwyfq258-571104` оставил хеш `results.md` прежним (`60391d66…`).
- **P1 (rework):** попытка условного fix-агента внутри одного DAG провалилась по механике taskflow: фазы с невыполненным `when` блокируют зависимые gate, хотя script-фазы при пропуске ведут себя иначе. Решение — отдельный `rework-flow.json` с аргументом `args.blockers`, 8 turn-ами и теми же gates; основной быстрый путь не изменён.
- Контрольный прогон после обеих доработок: `agile-leaf-pilot-mwyfy22k-c08289` — `completed`, commit `cca0772`, оба ревью из cross-run cache, 0 LLM-токенов.

Пилот считается завершённым: безопасность и воспроизводимость подтверждены, стоимость повторного прогона доведена до нуля.

### Попытка «тот же агент»: фаза fix вместо отдельного rework-flow

По просьбе владельца проверен вариант, где воркер возвращается к своей задаче после внешних ревью. Реализовано в основном `flow.json`: фазы `work` и `fix` используют одну роль `executor-code`, одну модель `gpt-6-luna`, одинаковый базовый промпт; блокеры ревью добавляются только в конец. Ревьюеры остались отдельными top-level фазами и прямо обязаны не читать общую доску. `recheck` не гоняет `npm test`, если содержимое двух файлов не изменилось.

Ограничение хост-окружения: включение `shareContext` (`ctx_write`/`ctx_read`) падает с `TFWS_MUTEX_IDENTITY: queue anchor is missing or invalid`. Поэтому вместо blackboard использован стабильный префикс prompt’а + cross-run cache; передача `{steps.work.output}` в `fix` тоже невозможна, потому что пропущенная фаза `work` блокирует зависимую фазу. Это честно зафиксировано как частичный, а не полный вариант «той же сессии».

| Прогон | fresh | cache-read | wall | Комментарий |
|---|---:|---:|---:|---|
| `agile-leaf-pilot-mwygv53p-459ad4` | 60 389 | 461 568 | — | первый запуск `fix`; provider-cache по стабильному префиксу сработал |
| `agile-leaf-pilot-mwygzdmh-b7c7c1` | **0** | **0** | 149.2 c | `fix` и оба ревью из cross-run cache; коммит/мерж выполнены |

Вывод: тот же агент по роли/модели/префиксу и с теми же блокерами в хвосте даёт нулевую стоимость на повторном прогоне и сохраняет независимость ревью. Полноценная непрерывная сессия в taskflow недоступна (`--no-session` в раннере), а blackboard сломан в этом окружении.

### Проверка с настоящим блокером (`context-reuse-probe`)

`context-reuse-probe.json` применяет seed, запускает `work`, ломает маркер `BD_WRITE_BAN`, передаёт блокеры в `fix` и гоняет реальный recheck. Все три прогона завершились `RECHECK OK`; `fix` реально правил `workflows/agile-loop.js`.

| Прогон | work fresh | work cacheRead | fix fresh | fix cacheRead | fix turns |
|---|---:|---:|---:|---:|---:|
| `mwyhccyn-2d84f0` | 41 939 | 434 816 | 69 914 | 180 352 | 6 |
| `mwyhgdad-f09b10` | 57 983 | 358 144 | 40 180 | 363 264 | 8 |
| `mwyhjgy3-58ebfd` | 61 470 | 288 000 | 60 002 | 235 648 | 6 |

Вывод: `fix` — отдельный процесс, а не продолжение сессии воркера. Стабильный префикс даёт только best-effort provider-cache: во втором прогоне `fix` заметно дешевле воркера и читает 363k контекста, но в первом и третьем cacheRead ниже, а fresh такой же порядок. Гарантированного «новых токенов ровно на фикс со всем контекстом воркера» нет. nonzero `cacheWrite` не наблюдался, поэтому часть контекста могло прийти из более ранних прогонов, а не от `work` в этом же run.

Итог: cross-run cache экономит 100% только на неизменённых блокерах (no-op). При реальном блокере экономия нестабильна; для настоящего продолжения контекста нужен рабочий `shareContext`/blackboard или нативный `subagent resume` вне taskflow.

### Автоматический замер: agile-leaf-pilot-mwykp7ll-73cabf

| phase | status | fresh | cache | total | turns | cost |
|---|---|---:|---:|---:|---:|---:|
| review-correctness | done | 122 975 | 792 576 | 915 551 | 11 | $0.00000 |
| review-guardrails | done | 87 297 | 656 640 | 743 937 | 11 | $0.00000 |
| fix | done | 89 729 | 824 320 | 914 049 | 16 | $0.01790 |
| **ИТОГО** | | **300 001** | **2 273 536** | **2 573 537** | | |

### Автоматический замер: agile-leaf-pilot-mwyl2kji-1ddcea

| phase | status | fresh | cache | total | turns | cost |
|---|---|---:|---:|---:|---:|---:|
| review-correctness | done | 106 202 | 1 042 432 | 1 148 634 | 14 | $0.00000 |
| review-guardrails | done | 92 662 | 838 144 | 930 806 | 13 | $0.00000 |
| fix | done | 85 264 | 311 808 | 397 072 | 8 | $0.01202 |
| **ИТОГО** | | **284 128** | **2 192 384** | **2 476 512** | | |

### Нативная continuity сессии (`session-reuse-probe`) — 2026-11-27

После рестарта Pi с обновлённым `taskflow-core`/`pi-taskflow` из форка `fan92rus/taskflow` (`4203e27`) проверен новый механизм `phase.session`.

Минимальная проба: `work` запомнил токен, `fix` в другой taskflow-фазе с тем же `session.key` его воспроизвёл.

| Прогон | work fresh | work cacheRead | fix fresh | fix cacheRead | Результат |
|---|---:|---:|---:|---:|---|
| `session-reuse-probe-mwyn9l45-f439ed` | 18 136 | 0 | **247** | 17 920 | `SECTOR-2026-REUSE` |

Реальная блокер-проба на том же контракте, что и прежний `context-reuse-probe`: `work` → инъекция блокера → `fix` → `RECHECK OK`. `fix` действительно правил `workflows/agile-loop.js`.

| Прогон | work fresh | work cacheRead | fix fresh | fix cacheRead | fix turns | Результат |
|---|---:|---:|---:|---:|---:|---|
| `context-reuse-probe-mwynb1l9-81365d` | 65 444 | 375 936 | **1 693** | 195 584 | 3 | RECHECK OK |
| `context-reuse-probe-mwynfcka-258ed4` | 64 415 | 538 880 | **5 683** | 391 296 | 6 | RECHECK OK |

Сравнение с прежним режимом isolated processes + blackboard: `fix` тратил 40 180–69 914 fresh. С продолжением одной Pi-сессии — 1 693–5 683 fresh, то есть примерно в 8–23 раза меньше, при высоком cacheRead и реальном recheck.

Вывод: требование владельца о «новых токенах только на дельту фикса со всем контекстом воркера» выполнено. Механизм — не живой OS-процесс, а одно сохранённое Pi-session, открытое заново фазой `fix` через `--session-id`.

Ограничения: `session`-фазы не используют cross-run cache (иначе кэш пропустил бы открытие транскрипта); ревьюеры остаются отдельными свежими сессиями; основной happy-path без `session` сохраняет 0-токенный cross-run cache.

### rev.6 — session handoff в rework-flow (2026-11-27)

Amendment 5 убирает `fix` из основного flow и переносит реwork в отдельный запуск с продолжением сессии воркера:

- `work` в основном flow использует `session.id = tf-pilot-8en-worker` и `cleanup: "keep"`;
- `rework-flow.json` принимает `args.sessionId` и открывает ту же сессию в `fix` через `{args.sessionId}`;
- `fix` в rework использует стандартный `cleanup: "run"`, поэтому transient-транскрипт удаляется в конце rework-запуска;
- happy-path (`SEED OK`) не создаёт сессию и сохраняет 0-токенный cross-run cache.

Проверено до живого прогона: `validateTaskflow` для обоих flow — 0 ошибок и 0 предупреждений; модульные тесты форка на интерполяцию `session.id`, unresolved-placeholder и `cleanup: "keep"` зелёные. Живой замер fresh-токенов на 2–3 листах остаётся следующим шагом после рестарта Pi.

### Автоматический замер: agile-leaf-pilot-mwypdy46-a848f3

| phase | status | fresh | cache | total | turns | cost |
|---|---|---:|---:|---:|---:|---:|
| review-correctness | done | 99 875 | 334 080 | 433 955 | 6 | $0.00000 |
| review-guardrails | done | 83 763 | 411 136 | 494 899 | 8 | $0.00000 |
| **ИТОГО** | | **183 638** | **745 216** | **928 854** | | |

### rev.6 живые прогоны (2026-11-27)

**Happy path.** `agile-leaf-pilot-mwypdy46-a848f3` завершился `completed 26/28`: `work` пропущен по `SEED OK`, гейты и MERGE прошли. Ревьюеры не попали в cross-run cache из-за смены HEAD клона, поэтому замер получился 183 638 fresh / 745 216 cache — пайп рабочий, но цифра показывает, что кэш привязан к HEAD.

**Session handoff.** Отдельный producer-прогон `handoff-producer-probe-mwyqip34-b2cac1` создал сессию `tf-pilot-8en-worker` с `cleanup: "keep"`, а consumer `handoff-consumer-probe-mwyqjahr-d5dfcd` продолжил её по `{args.sessionId}`:

| run / phase | fresh | cacheRead | turns | результат |
|---|---:|---:|---:|---|
| producer `work` | 357 | 37 120 | 2 | `BD_WRITE_BANX` |
| consumer `fix` | 110 | 18 816 | 1 | `BD_WRITE_BANX` из предыдущей сессии |

После consumer-запуска transcript удалён по умолчанию (`cleanup: "run"`).

**Полный rework.** Два прогона `agile-leaf-rework` прошли `completed 15/15`, оба ревью `pass`, мерж выполнен:

| run | fresh fix | cacheRead fix | turns fix | коммит |
|---|---:|---:|---:|---|
| `agile-leaf-rework-mwyq2jt6-9d5131` | 42 242 | 429 696 | 9 | `9622dcd` |
| `agile-leaf-rework-mwyqa87z-0b0608` | 30 562 | 347 776 | 9 | `84f776f` |

Второй прогон дешевле, потому что tools в producer совпали с tools в rework `fix`; это подтверждает, что стабильный префикс system prompt улучшает provider cache.

**Наладка.** Первый producer-запуск через уже загруженный хост не сохранил transcript: `cleanup: "keep"` в нём не действует. Прогон через свежий `pi` с явной загрузкой расширения (`--no-extensions -e .../pi-taskflow/dist/index.js`) корректно сохранил и затем удалил сессию. Все приведённые выше живые цифры — из свежих процессов.
