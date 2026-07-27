# Changelog

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
