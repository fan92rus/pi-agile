# pi-agile

> Autonomous Agile workflow engine for [pi](https://github.com/earendil-works/pi-coding-agent). The agent discovers issues, creates tasks, delegates to subagents, reviews, reflects, and repeats — sprints over sprints, within human-defined constraints.

## What it does

```
/agile setup  →  Human sets direction (one time)
/agile run    →  Agent runs autonomously:
                   discover → create tasks → delegate → review → reflect → repeat
```

The agent acts as a full team: product owner (priorities), developer (implements), reviewer (deep review), and scrum master (process).

## Key concepts

- **Sprint loop** — scope-based batches of work (not time-boxed)
- **bd CLI** — task backend (storage, dependencies, priorities)
- **Constraints** — text rules; the agent evaluates compliance, not programmatic checks
- **Deep review** — fresh-context reviewer subagent (architecture, correctness, security, performance, tests, constraints)
- **Knowledge base** — persistent lessons, dead-ends, patterns across sprints
- **Optional stop criteria** — goal-driven, budget-driven, or continuous

## Architecture

```
Orchestrator (main agent)
    ├── Discovery (lint + coverage + complexity + TODO + semgrep + scout)
    ├── bd CLI (task backend)
    ├── Workers (fresh-context subagents, feature branch per task)
    ├── Reviewer (fresh-context, read-only, deep review)
    └── Knowledge base (.agile/knowledge.jsonl)
```

## Documentation

- [PRD](docs/PRD.md) — product requirements
- [TZ](docs/TZ.md) — technical specification (Russian)

## Status

**Planning phase.** ТЗ and PRD are complete. Implementation has not started.

## License

MIT
