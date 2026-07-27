---
triggers:
  - "setup agile"
  - "start agile project"
  - "configure pi-agile"
  - "agile setup"
---

# Agile Project Setup

This skill guides the user through setting up a pi-agile project. It creates the `.agile/project.yaml` and `.agile/constraints.yaml` configuration files.

## Steps

### 1. Project Goal
Ask the user:
> What should the agent achieve?

Examples:
- "Improve test coverage of the auth module to 80%"
- "Fix all ESLint warnings and errors"
- "Resolve all security findings from semgrep"
- "Refactor the payment module for better separation of concerns"

Record the answer as the `goal` field.

### 2. Scope
Ask the user:
> What areas should the agent work on? What's off-limits?

Record:
- `include`: list of glob patterns (e.g., `src/auth/**`, `tests/auth/**`)
- `exclude`: list of glob patterns (e.g., `migrations/**`, `config/**`)

### 3. Constraints
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

### 4. Stop Criteria (optional)
Ask the user:
> When should the agent stop?
> Options:
> - **Goal-driven**: stop when a metric target is reached (e.g., coverage ≥ 80%)
> - **Budget-driven**: stop after N sprints
> - **Continuous**: no auto-stop, runs until you stop it manually

If goal-driven, ask:
> What metric? What target? What command checks it?

Record under `stop_when:` in project.yaml. If the user doesn't want auto-stop, omit `stop_when` entirely.

### 5. Review Depth
Ask the user:
> How thorough should code reviews be?
> - **deep**: 6 dimensions (architecture, correctness, security, performance, tests, constraints)
> - **standard**: 3 dimensions (correctness, tests, constraints)

### 6. Generate Config Files

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

  stop_when:        # omit if continuous mode
    mode: any_of    # any_of | all_of
    conditions:
      - metric: <metric name>
        target: <target value>
        area: "<scope area>"
        command: "<command to check>"
        description: "<description>"

  review_depth: deep   # deep | standard
  max_workers: 5
  max_tasks_per_sprint: 10
  created: "<date>"
  version: 1
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

### 7. Ready
Tell the user:
> Setup complete. Run `/agile run` to start the first sprint.
> The agent will discover issues, create tasks, delegate workers, review changes, and iterate.
