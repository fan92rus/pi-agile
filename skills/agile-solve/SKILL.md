---
name: agile-solve
description: >-
  Active campaign path on Taskflow: generate a campaign flow over bd code leaves
  with make-campaign-flow.mjs, then run it with taskflow. Use for multi-task
  campaigns in a repository; not for a single ceremony (ledger-solve).
when_to_use: >-
  Campaign of several bd code leaves with a test gate, isolated worktrees,
  independent reviews, merges and bd close.
when_not_to_use: >-
  One gate-driven ceremony (ledger-solve), a single point fix, or a campaign that
  needs sprint curators and per-task engine choice: those belong to the legacy
  agile-run path and are not called here.
---

# agile-solve — активный путь на Taskflow

Активный путь ровно один: **готовый `tf-leaf-mvp` + campaign-слой**. На каждую
bd-задачу генератор переиспользует готовый leaf flow, campaign — это детерминированный
Taskflow DAG из `flow`-фаз плюс финальный `campaign-report`. Новых движков и новых
flow не создаём.

> ⚠️ **Legacy, НЕ активный путь:** `agile_run`, `workflows/agile-loop.js`, а также
> вся машинерия спринтов, curator/discovery/retro, SDD task-engine, arbiter,
> model ladder и бюджетные аргументы остаются в репозитории как наследие.
> **Не вызывайте их в новых кампаниях** и не передавайте их аргументы в генератор.
> Единственный запуск — `taskflow({ action: 'run', ... })` по сгенерированному имени.

## Когда применять

| Ситуация | Инструмент |
|---|---|
| Несколько готовых bd-листьев с общим гейтом, нужны изоляция/ревью/мерж | **agile-solve (этот путь)** |
| Одна церемония «диагноз → фикс под гейт» | ledger-solve |
| Один точечный фикс | обычный воркер |

## Предпосылки

- Есть репозиторий с bd, доступен `taskflow`, имя flow безопасно (`[A-Za-z0-9._-]`).
- Базовая рабочая копия чистая: `preflight` и `merge-gate` leaf flow отказываются
  работать поверх грязи; гейт `--testCommand` проходит на базовой ветке.
- Каждый лист — кодовая задача с **обоими маркерами** в описании: `Files:` (или
  `Файлы:`) и `Acceptance:`. Без них генератор отфильтрует/отвергнёт задачу.
- Выбран источник задач: `--epic <id>` (открытые листья эпика через `bd children`),
  `--tasks <csv>` (явный набор) или ни одного флага (ready-листы из `bd ready --json`).
  `--tasks` и `--epic` вместе запрещены.
- Известны абсолютные пути: `<repo>`, `<bd>` (путь к бинарнику bd), host project root,
  откуда taskflow видит сгенерированный flow.

## Шаги

### 1. Сгенерировать campaign flow

```bash
node <repo>/.pi/taskflows/tf/campaign/make-campaign-flow.mjs \
  --repo <repo> \
  --bdBin <bd> \
  --epic <epic-id> \
  --testCommand '<gate>' \
  --name tf-<epic> \
  --concurrency 3 \
  --maxCycles 3 \
  --reviewerModel opencode-go/hy4-flash-free \
  [--worktreeRoot <root>]
```

Исходники tf (`campaign/`, `mvp/`) раскладываются плагином в
`<repo>/.pi/taskflows/tf/` при старте сессии; этоmanaged-копия, не генерированные flow.
Если каталога нет, перезапусти Pi/`/reload` — установка происходит на `session_start`.
При разработке самого плагина источник — `docs/plans/taskflow-pilot/` в его репозитории.

Генератор пишет `<repo>/.pi/taskflows/<name>.json`, готовые leaf flow
`tf-leaf-mvp-<taskId>.json` (плюс loop/final-cycle) и копирует campaign JSON в
`.pi/taskflows/` host project root. В stdout — JSON со списком задач, путями flow,
`worktreeRoot` и `mergeLock`; проверь, что список задач не пуст и содержит нужные id.

### 2. Запустить

```text
taskflow({ action: 'run', name: '<name>', cwd: '<host project root>' })
```

Запуск долгий: задай таймаут, соразмерный числу листьев и длительности гейта.
Параллелизм задан полем `concurrency` сгенерированного flow; спринтов и волн нет.

### 3. Читать статус

Отдельного `action=status` нет — статус читается из файлов:

| Что | Где |
|---|---|
| Состояние прогона taskflow (по новейшему mtime `.json`) | `<host root>/.pi/taskflows/runs/<name>/*.json` |
| Результат каждого листа | `<repo>/.pi/taskflows/results/<taskId>.json` |
| Итог кампании (финальная фаза `campaign-report`) | `<repo>/.pi/taskflows/results/campaign-<name>.json` |

Кампания успешна, когда в `campaign-<name>.json` `status: "merged"` и у каждого
листа `status: "merged"`, `merged: true`, `bdClosed: true`, `needsAttention: null`,
`blockers: []`. Любая другая комбинация — не «почти готово». Эти поля формируются
`campaign/report.mjs` (`status`, `tasks[]`, `tokens`); это контракт артефакта,
а не предположение о формате.

## Соответствие старых аргументов новым

| Legacy `agile_run` | Активный путь | Примечание |
|---|---|---|
| `taskSource`, `bdEpic`, `bdTasks`, `doneWhen` | `--epic <id>` / `--tasks <csv>` / `bd ready` | Выбор листьев делается до запуска; `*doneWhen*` и курсоры не нужны |
| `testCommand` | `--testCommand '<gate>'` | Тот же гейт воркеров и merge-фазы |
| `maxParallel`, `sprintTasks`, `maxSprints` | `--concurrency` | По умолчанию 3, допустимо 1–4; спринтов и wave-планирования нет |
| `reworkLimit`, review-циклы | `--maxCycles` | По умолчанию 3, допустимо 1–20; потолок final-cycle внутри leaf flow |
| `reviewModel` | `--reviewerModel` | По умолчанию `opencode-go/hy4-flash-free`; модель воркера фиксирована готовым leaf flow |
| `mergeApproval`, `mergePolicy` | внутри leaf flow | Merge автоматический после зелёного гейта и review; отдельного подтверждения нет |
| `worktreeRoot` | `--worktreeRoot` | По умолчанию под `<drive>/tmp/tf-campaign-worktrees` |
| `journalDir`, `metricsScript` | `runs/<name>/` и `results/campaign-<name>.json` | Статистика снимается из артефактов taskflow |
| `description`, `constraints`, `bundleScript` | текст bd-задачи | Переносить некуда; критерии задаются маркерами `Files:`/`Файлы:` и `Acceptance:` |
| `agentWork`, `sdd`, `sddDir`, `modelLadder`, `usageBudget`, `mergeChain` | — | Legacy-механизмы активным путём не поддерживаются |

Переиспользование сессий worker/fix, clean-skip, review-gate (пропуск fix и final
cycles при двух `pass`) и кеш review по diff — **свойства готового `tf-leaf-mvp`**,
а не опции agile-solve. Их не нужно включать или объяснять в брифе.

## Обработка отказов

- **Generator fail:** нет листьев с обоими маркерами, битый `bd` JSON или конфликт
  `--tasks`/`--epic`. Исправь описания задач/аргументы и перегенерируй.
- **`needsAttention` в leaf result:** читать как отказ; кампания не мержит такую
  задачу и не закрывает её в bd. Разбери `blockers`, поправь задачу/код, перегенерируй
  и перезапусти. Автоматического повтора кампании нет.
- **Красный гейт** (`gates`, `recheck`, `merge-gate`): merge не происходит, bd не
  закрывается. Чини причину в задаче/коде, затем повтори прогон; не обходи гейт
  вручную и не закрывай bd-лист рукой.
- **Грязный bd export:** `bd-export` падает, если база грязная до export; коммитится
  только `.beads/issues.jsonl`. Разбери грязь явно (никаких `git add -A`/force),
  добейся чистого `git status` и повтори.
- **Конфликт merge:** leaf записывает артефакт конфликта, merge откатывается и
  попадает в `needsAttention`; свои резолверы не выдумываем — чиним задачу и
  перезапускаем leaf через campaign.

## Дефолты

`--concurrency 3` (1–4), `--maxCycles 3` (1–20), `--reviewerModel opencode-go/hy4-flash-free`,
`--testCommand 'npm test'`, `--name tf-campaign-mvp`, `--worktreeRoot` под
`<drive>/tmp/tf-campaign-worktrees`. Явные значения передавай только когда они
вызваны ограничениями стенда или репо.
