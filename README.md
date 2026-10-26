# pi-agile

Agile/Kanban campaign engine for the [pi](https://github.com/earendil-works/pi-coding-agent) coding agent.

A bd epic is a campaign. The engine takes its open leaves, curates them into waves, runs each
task in its own git worktree with a gated worker, a fresh reviewer, and a merger, and repeats
in sprints until the stop criteria are met.

## Layout

```
extensions/pi-agile/   pi extension: two tools (agile_run, agile_status)
workflows/agile-loop.js  the engine: a workflow script run by pi-subagents
skills/agile-solve/    skill describing the engine contract for the caller
```

- **Engine** (`workflows/agile-loop.js`) lives in this repository. It is a single workflow script:
  the parent script awaits every child (discovery, curator, worker, reviewer, arbiter/merger,
  retrospective), and its completion receipt carries the whole trace.
- **Extension** (`extensions/pi-agile/`) is a thin harness. It never runs the loop itself.
  - `agile_run` — launch station. Read-only check of the epic in bd, snapshot of the open
    leaves, defaults and validation of the launch arguments. Returns the engine path, the args
    and a copyable `subagent({ ... })` call. Starts nothing, writes nothing.
  - `agile_status` — read-only progress of a launched campaign: workflow state and result,
    checkpoint (phase, sprint, cooldowns) and the last settled children.

## Quick Start

1. Create a bd epic with the work as open leaves (`bd create ...`, attach them to the epic).
2. In pi, plan the launch:

   ```
   agile_run({ epic: "<epic-id>", testCommand: "<full test suite command>" })
   ```

   Optional arguments: `cwd`, `sprintTasks` (default 3), `maxSprints` (default 3),
   `maxParallel` (default 3), `mergeApproval` (`auto` | `confirm`, default `auto`),
   `workModels`, `reviewModels`, `bundleScript`.
3. Start the campaign with the `subagent` call line that `agile_run` returns.
4. Check progress at any time:

   ```
   agile_status({ runId: "<run-id>" })   // or agile_status({}) for the freshest run
   ```

`testCommand` is the host gate: no gate, no launch.

## Requirements

- [pi](https://github.com/earendil-works/pi-coding-agent) coding agent with pi-subagents (workflow scripts)
- [bd](https://github.com/zimash/bd) CLI for task management (the epic and its leaves live in bd)
- Node.js >= 22 (the extension runs TypeScript directly via type stripping)
- A git repository with a working test command

## Development

```bash
npm test                                   # node --test tests/agile-loop.test.mjs
node --experimental-strip-types --check extensions/pi-agile/index.ts
```

## License

MIT
