# Review criteria (synthetic MVP test)

- Correctness: `README.md` contains `MVP TEST OK`.
- Guardrails: diff changes only `README.md`, no `.beads/` or `.taskflow-mvp/` files, no bd/commit/push commands added to the diff.
- Do NOT try to verify the worker's tool calls from files: absence of bd/commit/push is proven by deterministic script phases and trace.
