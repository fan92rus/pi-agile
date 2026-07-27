---
triggers:
  - "setup agile"
  - "start agile project"
  - "configure pi-agile"
  - "agile setup"
---

# Agile Project Setup

This skill guides the user through setting up a pi-agile project. It creates the `.agile/project.yaml` and `.agile/constraints.yaml` configuration files.

## Prerequisites

Before setup, verify:

1. **bd CLI** — run `bd --version`. If missing, install from https://github.com/fan92rus/bd
2. **bd init** — run `bd init` inside the project directory. This creates `.beads/` (the task database). Without it, task creation fails.
3. **git init** — the project must be a git repo (`git init` if not)
4. **pi-subagents** — installed via pi (required for worker/reviewer delegation)

## Steps

### 1. Project Goal
Ask the user:
> What should the agent achieve over multiple sprints?

Examples:
- "Improve test coverage of the auth module to 80%"
- "Fix all ESLint warnings and errors"
- "Resolve all security findings from semgrep"
- "Refactor the payment module for better separation of concerns"

Record the answer as the `goal` field in `project.yaml`.

### 2. Scope
Ask the user:
> What areas should the agent work on? What's off-limits?

Record:
- `include`: list of glob patterns (e.g., `src/auth/**`, `tests/auth/**`)
- `exclude`: list of glob patterns (e.g., `migrations/**`, `config/**`)

### 3. Tool Setup (Phase 0 Initialization)
Ask the user:
> What analysis tools are already installed?
> - ESLint / Pylint / TSConfig?
> - Test runner (Jest / Vitest / node --test)?
> - Coverage tool (c8 / nyc / istanbul)?
> - Complexity analyzer?

Explain:
> `agile_discover` scans for TODOs, runs lint, coverage, complexity, and security
> checks. Tools that aren't installed return empty results. The **first tasks** in the
> project should set up these tools.

If tools are missing, the agent will create tasks to install them after `agile_discover`.

### 4. Constraints
Ask the user:
> What rules must the agent follow?

Examples:
- "Public APIs must remain backward compatible"
- "All new code must have tests"
- "Maximum 300 lines changed per task"
- "Never touch files under migrations/"
- "Use conventional commits"
- "Don't add new dependencies"

Record as text rules under `rules:` in constraints.yaml.

Also ask about architectural principles and process rules.

### 5. Stop Criteria (optional)
Ask the user:
> When should the agent stop?

Options:
- **Goal-driven**: stop when a metric target is reached (e.g., coverage >= 80%)
  → ask: "What metric? What target? What command checks it?"
  → e.g. `npm run test -- --coverage | grep Lines | grep -oP '\d+\.?\d*(?=%)'`
- **Budget-driven**: stop after N sprints
- **Continuous (default)**: no auto-stop, runs until you stop it manually with `/agile stop`

Record under `stop_when:` in project.yaml. Omit `stop_when` entirely for continuous mode.

**How stop works in practice:**
- After each sprint, `agile_retrospective` produces a stop-check message
- The **agent** reads it, runs the check commands, and decides: next sprint or stop
- Goal-driven: agent checks if target is met
- Budget-driven: agent counts completed sprints vs N
- Continuous: agent always proceeds to next sprint
- User can always `/agile stop` manually at any time

### 6. Review Depth
Ask the user:
> How thorough should code reviews be?
> - **deep**: 6 dimensions (architecture, correctness, security, performance, tests, constraints)
> - **standard**: 3 dimensions (correctness, tests, constraints)

### 7. Generate Config Files

Create `.agile/project.yaml`:

```yaml
project:
  name: "<project name>"
  goal: >
    <user's goal>

  scope:
    include:
      - "<include glob 1>"
      - "<include glob 2>"
    exclude:
      - "<exclude glob 1>"

  stop_when:        # omit for continuous mode
    mode: any_of    # any_of | all_of
    conditions:
      - metric: <metric name>
        target: <target value>
        area: "<scope area>"
        command: "<command to check>"
        description: "<description>"

  review_depth: deep   # deep | standard
  max_workers: 5
```

Create `.agile/constraints.yaml`:

```yaml
rules:
  - id: <rule-id>
    rule: "<rule text>"

architectural_principles:
  - "<principle text>"

process:
  - "<process rule>"

do_not_do:
  - "<thing to avoid>"
```

### 8. Ready
Tell the user:
> Setup complete! The sprint cycle is **driven by the agent**, not a single command.
> The agent will go through these steps:

```
1. agile_discover(cwd)       → scan for TODOs, lint, coverage, security issues
2. bd create "..."           → create tasks from findings
3. bd link ...               → set dependencies if needed
4. agile_start_sprint([...]) → start a sprint with selected tasks
5. agile_delegate_task([...]) → parallel workers + reviewers with rework loop
6. agile_merge_task(id)      → squash-merge approved task to main
7. agile_retrospective()     → velocity + stop-check
8. Decide: next sprint or stop
```

> The agent will walk through this automatically. You can also run each tool
> manually or interrupt with `/agile stop`.
