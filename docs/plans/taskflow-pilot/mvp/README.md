# tf-leaf-mvp — one-task Taskflow MVP

Цель: довести **одну bd-задачу** от `bd show` до `bd close` через детерминированный Taskflow DAG, не трогая `agile-loop.js`.

Это не campaign engine. Это vertikal'ный срез, который потом можно расширять до спринтов и `repeat`.

## Решения владельца (2026-11-27)

1. **Merge target** — в `base` (текущая branch тестового репо), а не в фиксированный `main`.
2. **bd export** — отдельный финальный script phase после успешного merge.
3. **Worker tools** — давать `bash`, но worker не должен вызывать `bd`, коммитить или пушить. Нарушение ловится gates.
4. **Models** — по умолчанию worker и reviewer'ы на `openai-codex/gpt-6-luna`. Taskflow 0.2.1 не интерполирует `{args.X}` в поле `model`, поэтому модель задаётся генератором (`--workerModel`, `--reviewerModel`) или правкой сгенерированного flow, а не аргументом ранна.

## Генерация flow под bd-лист

```bash
node docs/plans/taskflow-pilot/mvp/scripts/make-task-flow.mjs \
  --taskId pi-agile-xzy \
  --repo D:/Documents/Repositories/pi-agile \
  --worktree D:/tmp/tf-leaf-mvp-worktrees/pi-agile-xzy \
  --filesHint extensions/pi-agile/bd.ts,workflows/agile-loop.js,tests/agile-loop.test.mjs
```

Скрипт читает `bd show <taskId> --json`, достаёт `Files:`/`Acceptance:` из описания, пишет `acceptance.md` и `criteria.md` во временную директорию вне репо и создаёт:

- `.pi/taskflows/tf-leaf-mvp-<taskId>.json` — главный flow;
- `.pi/taskflows/mvp-loop-<taskId>.json` — repeat-wrapper;
- `.pi/taskflows/mvp-final-cycle-<taskId>.json` — saved subflow одного цикла.

Флаги:

- `--filesHint` — когда тестовый файл не перечислен в bd-описании;
- `--workerModel` / `--reviewerModel` — модели прямо в сгенерированный flow;
- `--maxCycles` — потолок финальных циклов (по умолчанию 3);
- `--reuseReviewerSession true|false` — переиспользовать ли сессии reviewer'ов между циклами.

Worker/fix всегда переиспользуют `{args.sessionId}` с `cleanup: keep`. Reviewer'ы по умолчанию тоже переиспользуют свои сессии, но получают только инкрементальный diff и untrusted fix summary.

## Входные аргументы

| Arg | Required | Default | Meaning |
|---|---|---|---|
| `taskId` | yes | — | bd id, например `pi-agile-8en` |
| `repo` | yes | — | абсолютный путь к рабочему репозиторию |
| `worktreeCwd` | yes | — | абсолютный путь к isolated worktree |
| `branch` | yes | — | branch имени `tf-leaf-mvp/<id>` |
| `filesHint` | yes | — | CSV разрешённых путей, relativ к `repo` |
| `acceptanceFile` | yes | — | файл с критериями приёмки |
| `criteriaFile` | yes | — | файл с criteria для reviewer'ов |
| `testCommand` | no | `npm test` | команда гейта |
| `sessionId` | no | `tf-leaf-mvp-<taskId>-worker` | Pi session id worker'а |
| `forceEscalation` | no | `false` | `true` заставляет worker спросить супервизора до работы |
| `bdBin` | no | `bd` | путь к `bd`; нужен для тестовых shim |

## Paths caveat

`flow.json` сейчас hardware-pin'ит `cwd` на:

```text
D:/tmp/tf-leaf-mvp-repo
D:/tmp/tf-leaf-mvp-worktrees/8en
```

Taskflow 0.2.1 разрешает `{args.X}` в `cwd` только для `type: "relative-path"`, а абсолютные пути туда нельзя передать. Для другого task/repo нужно сгенерировать копию flow с подставленными literal cwd. Это осознанное ограничение MVP.

## Запреты

Worker и reviewer не вызывают `bd`, не коммитят, не пушат, не меняют `.beads/`.

`bd` вызывают только script-фазы:

- `task-packet` — читает `bd show`;
- `bd-owner` — закрывает задачу после merge;
- `bd-export` — делает export и отдельный commit.

## Артефакты внутри `worktreeCwd`

| Path | Writer | Meaning |
|---|---|---|
| `.taskflow-mvp/task.json` | `task-packet` |结构化 task packet |
| `.taskflow-mvp/acceptance.txt` | `task-packet` | criteria приёмки |
| `.taskflow-mvp/worker.json` | work/fix | output воркера |
| `.taskflow-mvp/diff.patch` | `diff` | diff against base SHA |
| `.taskflow-mvp/diff-sha256.txt` | `diff` | hash рабочего diff |
| `.taskflow-mvp/criteria-sha256.txt` | `diff` | hash review criteria |
| `.taskflow-mvp/review-fingerprint.txt` | `diff` | `diffHash + criteriaHash` |
| `.taskflow-mvp/blockers.json` | `rework-input` | blockers после первого review |
| `.taskflow-mvp/diff-final.patch` | `diff-final` | diff после fix |
| `.taskflow-mvp/review-fingerprint-final.txt` | `diff-final` | cache key финального review |
| `.taskflow-mvp/blockers-final.json` | `rework-input-final` | blockers после финального review |
| `.taskflow-mvp/merge-commit.txt` | `merge` | SHA merge commit |
| `.taskflow-mvp/gates.log` | `gates` / `recheck` | вывод тестов |
| `.taskflow-mvp/snapshots/cycle-N/` | `snapshot` | проверенное состояние файлов |
| `.taskflow-mvp/diff-cycle-N.patch` | `incremental-diff` | дельта с прошлого цикла |
| `.taskflow-mvp/fix-summary.json` | `incremental-diff` | untrusted резюме фикса |
| `.taskflow-mvp/blockers-cycle-N.json` | `cycle-aggregate` | blockers текущего цикла |
| `.taskflow-mvp/result.json` | `report` | финальный structured report |

`cleanup` копирует `result.json` в `<repo>/.pi/taskflows/results/<taskId>.json`, затем удаляет worktree и branch.

Все эти файлы исключены из gate на changed files и из commit.

## Фазы

```text
preflight → task-packet → work → gates → diff
  → review-correctness ┬┐
  → review-guardrails ─┴→ rework-input → fix → recheck → diff-final
    → snapshot(cycle-0)
    → final-cycles (repeat ≤ N):
        incremental-diff → review-correctness/review-guardrails
        → cycle-aggregate → final-fix → recheck → snapshot → cycle-result
      → merge-gate → merge → bd-owner → bd-export → report → cleanup
```

`fix` запускается всегда: при отсутствии blockers он дешёвый за счёт session reuse и cross-run cache. Это исключает каскадные skip через `dependsOn`.

## Контракты script-фаз

### `preflight.mjs`

- проверяет洁净 base repo;
- проверяет существование `taskId`, `acceptanceFile`, `criteriaFile`;
- создаёт worktree и branch, если их нет;
- пишет `.taskflow-mvp/base-sha.txt`;
- output: `PREFLIGHT OK`.

### `task-packet.mjs`

- `bd show <taskId> --json`;
- пишет `.taskflow-mvp/task.json`;
- копирует acceptance в `.taskflow-mvp/acceptance.txt`;
- output: `TASK PACKET OK`.

### `gates.mjs mode=full|quick`

- проверяет, что изменённые файлы ⊆ `filesHint`;
- запрещает `.beads/` и `.taskflow-mvp/` в diff;
- проверяет отсутствие коммитов выше base SHA;
- запускает `testCommand`;
- output: `GATES OK` / `GATES FAIL: <reason>`.

`mode=quick` не запускает tests — используется `recheck`, если diff не изменился.

### `diff.mjs`

- `git diff <baseSha> -- .` → `.taskflow-mvp/diff.patch`;
- пишет hash diff, hash criteria и combined fingerprint;
- output: `DIFF OK`.

### `rework-input.mjs`

- читает JSON обоих reviewer'ов;
- пишет `.taskflow-mvp/blockers.json`:

```json
{ "needsFix": true, "blockers": ["[-correctness] ...", "[-guardrails] ..."] }
```

- output: `NEEDS FIX` или `NO FIX`.

### `recheck.mjs`

- если diff hash совпадает → `RECHECK OK (no diff)`;
- если изменился → `gates.mjs mode=full`;
- output: `RECHECK OK` / `RECHECK FAIL: ...`.

### `merge-gate.mjs`

Пропускает только если:

- `gates` OK;
- оба reviewer'а `verdict == pass`;
- `recheck` OK;
- base repo остался чистым;
- SHA branch не изменился после review.

Output: `MERGE GATE OK` / `MERGE GATE FAIL: ...`.

### `merge.mjs`

- checkout base branch;
- rebase feature branch onto base SHA;
- `testCommand`;
- merge в base;
- output: `MERGE OK <sha>`.

`reset --hard` и авто-revert чужих файлов запрещены.

### `bd-owner.mjs`

- только при `MERGE OK`;
- `bd close <taskId> --comment "taskflow MVP: <commit>"`;
- output: `BD CLOSE OK`.

### `bd-export.mjs`

- `bd export`;
- коммитит только `.beads/issues.jsonl`;
- если base dirty до export → failing with explicit reason;
- output: `BD EXPORT OK <sha>`.

### `report.mjs`

Читает все артефакты и печатает JSON:

```json
{
  "taskId": "pi-agile-8en",
  "status": "merged|blocked|failed",
  "commit": "abc1234",
  "merged": true,
  "bdClosed": true,
  "blockers": [],
  "needsAttention": null,
  "freshTokens": 0,
  "cacheReadTokens": 0
}
```

Финальная фаза `report` — script, `final: true`.

## Definition of done

- [ ] `taskflow action=compile defineFile=...` — 0 errors
- [ ] preflight создаёт worktree
- [ ] worker не вызывает bd и не коммитит
- [ ] gates ловит выход за `filesHint`
- [ ] reviewer'ы независимые, свежие, кешируются по `diff+criteria`
- [ ] escalation через `contact_supervisor` проверен хотя бы один раз
- [ ] merge только после ok review + зелёного test gate
- [ ] `bd close` только после merge
- [ ] `bd export` отдельным commit
- [ ] `report` печатает валидный JSON
