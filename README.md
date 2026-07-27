# pi-agile

Autonomous Agile/Kanban engine for [pi](https://github.com/earendil-works/pi-coding-agent) coding agent.

The agent independently discovers tasks, delegates to worker subagents, conducts deep code review, reflects on results, and iterates in sprints — all within configurable constraints.

## Architecture

```
Agent decides · Extension runs
```

- **Extension** (TypeScript): runs discovery tools (linters, coverage, semgrep), calls `bd` CLI for task management, delegates worker/reviewer subagents, manages git branches, persists knowledge.
- **Agent** (LLM): reads discovery output, decides what tasks to create, evaluates constraint compliance, decides merge/rework/block, checks stop criteria.
- **Constraints** are text injected into prompts — not programmatic checks.
- **Stop criteria** are checked by the agent — not by an automated function.

## Quick Start

```bash
# 1. Setup project (interactive wizard)
/agile setup

# 2. Run sprint loop
/agile run

# 3. Check status
/agile status
```

## Commands

| Command | Description |
|---|---|
| `/agile setup` | Run setup wizard (creates `.agile/project.yaml` + `.agile/constraints.yaml`) |
| `/agile run` | Start sprint loop |
| `/agile status` | Show current sprint status |
| `/agile stop` | Graceful stop after current tasks |
| `/agile config` | Show configuration |
| `/agile observer` | Toggle observer on/off |

## Sprint Loop

```
discovery → agent creates tasks in bd → bd ready → bd claim →
delegate worker → delegate reviewer → bd close → retrospective → stop-check → next sprint
```

1. **Discovery**: Extension runs linters, coverage, security scans; agent reads raw output and decides what tasks to create
2. **Execution**: Extension delegates workers (fresh-context subagents on feature branches) and reviewers (fresh-context read-only subagents)
3. **Review**: Reviewer evaluates architecture, correctness, security, performance, tests, constraints
4. **Retrospective**: Extension computes velocity; agent formulates lessons and checks stop criteria
5. **Repeat**: If stop criteria not met, next sprint begins

## Configuration

### `.agile/project.yaml`

```yaml
project:
  goal: "Improve auth module test coverage to 80%"
  scope:
    include: ["src/auth/**", "tests/auth/**"]
    exclude: ["migrations/**"]
  stop_when:
    mode: any_of
    conditions:
      - metric: coverage
        target: 80
        command: "npx jest --coverage"
  review_depth: deep
  max_workers: 5
```

### `.agile/constraints.yaml`

```yaml
rules:
  - id: require-tests
    rule: "All new code must have tests"
do_not_do:
  - "Don't modify lockfiles directly"
```

## Requirements

- [pi](https://github.com/earendil-works/pi-coding-agent) coding agent
- [bd](https://github.com/zimash/bd) CLI for task management

## License

MIT
