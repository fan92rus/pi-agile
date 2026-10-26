# Changelog

## [Unreleased]

### Breaking
- The sprint loop moved out of the extension into the workflow script `workflows/agile-loop.js` (run by pi-subagents). The extension is now a thin harness with two tools.
- Removed the 8 old tools: `agile_run` (old sprint-loop implementation), `agile_discover`, `agile_investigate`, `agile_start_sprint`, `agile_delegate_task`, `agile_merge_task`, `agile_retrospective`, `agile_knowledge`. `agile_run` is re-registered with a new meaning (launch station); the other seven names are gone.
- Removed the `/agile` slash command (setup, run, status, stop, config, observer).
- Removed the `parallel/` helper modules, `observer.ts`, `config-ui.ts` and the `agile-setup` skill.
- Removed `docs/PRD.md` and `docs/TZ.md` (still available in git history).

### Added
- `agile_run`: read-only launch station for a bd epic campaign (checks the epic in bd, snapshots open leaves, returns the engine path, args and a copyable `subagent` call; starts nothing).
- `agile_status`: read-only progress of a launched campaign (state, result, checkpoint, last settled children).
- `workflows/agile-loop.js`: the campaign engine, now in this repository.

### Changed
- README rewritten for the new form (two tools, engine in `workflows/`, quick start).

## [0.1.0] - 2026-07-27

### Added
- Initial pi-agile extension scaffold
- Sprint lifecycle state machine (planning → active → retrospective → done)
- Knowledge base persistence (.agile/knowledge.jsonl)
- Multi-source discovery (lint, coverage, complexity, TODOs, security, scout)
- Deep review delegation (6 dimensions: architecture, correctness, security, performance, tests, constraints)
- Observer for sprint health monitoring (stagnation, blocked, constraint spam)
- Setup skill wizard (/agile setup)
- Commands: /agile run, status, stop, config, observer
- System prompt injection (goal + constraints + knowledge)
- bd CLI integration layer
- Stop-check message builder (agent decides, not automated)
- Technical specification (docs/TZ.md) and PRD (docs/PRD.md)

### Architecture
- Agent decides, extension runs
- Constraints as text in prompts, not programmatic checks
- Stop criteria checked by agent, not automated function
- No SimHash — agent recognizes duplicates via context
- Discovery returns raw output — agent parses, not code
