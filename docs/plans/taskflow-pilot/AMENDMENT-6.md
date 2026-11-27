# Amendment 6 — cheaper reviews without reducing coverage

This amendment keeps every deterministic gate and both independent reviewers.
It only changes how review work is cached and prompted. No per-phase turn caps
were introduced.

## Changes

### Cache fingerprint

Both `flow.json` and `rework-flow.json` reviewers now fingerprint:

- SHA-256 of the actual git diff produced by `docs/plans/taskflow-pilot/review-fingerprint.mjs`;
- SHA-256 of the frozen criteria files (`PLAN.md`, `flow.json`, `rework-flow.json`).

The old `git:HEAD` fingerprint is gone. A clone reset no longer invalidates the
review cache when the same diff and criteria are reviewed again.

`review-fingerprint.mjs` writes `.taskflow-review-fingerprint.txt` in the pilot
clone. The `base...HEAD` form was rejected because it ignores uncommitted work;
the corrected form uses `git diff <base>` / `git diff HEAD`.

### Stable reviewer prompt prefix

Reviewer tasks keep the criteria and verdict contract first, state that only
the listed files may be read, and put volatile evidence last. No reviewer tool
or turn limit was reduced.

### Untrusted worker notes

Rework reviewers receive the fix worker's summary at the end of the task:

```text
UNTRUSTED WORKER NOTES (hints only, NOT 100% reliable; verify every claim
against the files before using it): {steps.fix.json.summary}.
```

The notes are hints, never evidence. Reviewers must still produce `file:line`
evidence from the target files.

## Measured result

- Main flow, first run after fingerprint change: reviewers 187 774 fresh.
- Main flow, second run with the same diff/criteria: reviewers **0 fresh**.
- Rework with the corrected fingerprint and untrusted notes: `completed 16/16`,
  fix 4 688 fresh, both reviewers pass, commit/merge done.
- An earlier rework run was blocked by a real semantic reviewer finding about
  post-loop reconciliation; this is evidence that review coverage was not
  weakened.

## Deliberately not done

- No reviewer turn cap.
- No replacement of semantic review with a cheap model.
- No deletion of gates, tests, or independent review.
