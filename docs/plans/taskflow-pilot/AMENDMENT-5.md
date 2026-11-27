# Amendment 5 — native session handoff between the pilot and rework flows

This amendment records rev.6 of the taskflow pilot. It does not change the
frozen PLAN.md contract; it changes only how the pilot reaches rework.

## What changed

### Main flow (`flow.json`)

- `work` now opts into a stable Pi session:

  ```json
  "session": { "id": "tf-pilot-8en-worker", "cleanup": "keep" }
  ```

  When the seed already satisfies the contract, `work` is skipped and no
  session is created; the cheap 0-fresh pass path is unchanged.

- The old `fix` agent phase was removed from the main flow. It was either a
  cached no-op on the happy path or an isolated, context-poor retry on the
  blocker path. Both cases are now handled better: happy path needs no fix;
  blocker path goes to `rework-flow.json`.

- `recheck` now depends only on `hash-before`, so a skipped `fix` cannot cascade
  a skip into gates and merge. `report` no longer depends on `fix`.

### Rework flow (`rework-flow.json`)

- New typed arg `sessionId`, default `tf-pilot-8en-worker`.
- `fix` continues that transcript:

  ```json
  "session": { "id": "{args.sessionId}" }
  ```

  The default `cleanup: "run"` means the rework run removes the artifact when
  it terminates. The producer run keeps it (`cleanup: "keep"`), so exactly one
  handoff exists and there is no permanent transcript leakage.

- The existing `args.blockers` remains the feedback channel. Reviewers stay
  independent fresh sessions.

## Required fork support

`fan92rus/taskflow` gained:

- interpolation of `session.id` and `session.dir` from `{args.X}` /
  `{steps.X}` at phase execution;
- phase-level `session.cleanup: "run" | "keep"`;
- unresolved placeholders disable reuse with a warning instead of opening an
  arbitrary session id.

## Verification so far

- `validateTaskflow` on both flows: 0 errors, 0 warnings.
- `taskflow-core` session/schema tests for interpolation, unresolved
  placeholders and `cleanup: "keep"` pass (two unrelated Windows-path schema
  tests remain baseline failures in this environment).
- Live pilot re-measurement is pending a genuine Pi restart so the current host
  loads the rebuilt ESM modules.

## Why this is the right split

- Happy path: no session phases, no transcript, cross-run cache still works.
- Blocker path: one kept transcript from `work`, continued by `fix` in the
  rework run, then deleted.
- Reviewers: always fresh, never in the worker session.
