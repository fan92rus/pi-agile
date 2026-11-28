# Campaign layer over tf-leaf-mvp

**Это активный путь кампаний:** он вызывается через skill
[`agile-solve`](../../../../skills/agile-solve/SKILL.md), который генерирует flow,
запускает его через `taskflow` и читает статус из артефактов. Старый `agile_run`
(`workflows/agile-loop.js`) в этом пути **не используется**.

Campaign layer не вводит новый движок. Он только:

1. берёт ready-листы из bd;
2. для каждого листа генерирует `tf-leaf-mvp-<taskId>` через `make-task-flow.mjs`;
3. строит Taskflow DAG, где каждый лист — обычная `flow`-фаза;
4. после всех листов запускает детерминированный `campaign-report`.

## Генерация

При установке/обновлении плагина pi-agile эти исходники (`campaign/`, `mvp/`)
копируются в `<repo>/.pi/taskflows/tf/`. Активный `agile-solve` запускает генератор
именно оттуда; путь `docs/plans/taskflow-pilot/...` остаётся источником для разработки
самого плагина.

```bash
node docs/plans/taskflow-pilot/campaign/make-campaign-flow.mjs \
  --repo D:/Documents/Repositories/pi-agile \
  --bdBin C:/tools/bd.exe \
  --worktreeRoot D:/tmp/tf-campaign-worktrees \
  --testCommand 'npm test' \
  --maxCycles 3 \
  --concurrency 3 \
  --reviewerModel opencode-go/hy4-flash-free
```

`--reviewerModel` по умолчанию `opencode-go/hy4-flash-free`: ревьюеры — самая дорогая часть leaf flow, а дешёвая модель на этой пачке задач дала сопоставимый вердикт. Worker остаётся на `openai-codex/gpt-6-luna`.

Поддерживаются оба маркера кодового листа в описании bd-задачи: `Files:` **или** `Файлы:`, плюс обязательный `Acceptance:`. Без них задача не попадает в кампанию — это отсекает операционные задачи вроде ff-merge/лендинга.

Источник задач (взаимоисключающие варианты):

```bash
--epic pi-agile-xxx        # открытые листья эпика через bd children
--tasks pi-agile-aaa,pi-agile-bbb  # явный набор
# без флагов — готовые листы из bd ready --json
```

Сгенерированный campaign JSON копируется также в `.pi/taskflows/` host project root; leaf flow (`tf-leaf-mvp-<taskId>.json`) остаётся в репозитории.

## Запуск

Сгенерированный flow:

```text
.pi/taskflows/tf-campaign-mvp.json
```

Запуск через taskflow из host project root (долгий прогон — с явным таймаутом):

```text
taskflow({ action: 'run', name: '<name>', cwd: '<host project root>' })
```

Отдельного `action=status` нет: состояние прогона лежит в
`<host root>/.pi/taskflows/runs/<name>/*.json`, результаты листов — в
`<repo>/.pi/taskflows/results/<taskId>.json`, итог — в
`<repo>/.pi/taskflows/results/campaign-<name>.json`.

## Почему parallelism безопасен

Leaf-и работают в отдельных worktree и могут правитьпересекающиеся файлы: совместимые изменения смержатся обычным `git merge`, а только текстовые additive-конфликты разрешаются union-резолвером (обе стороны сохраняются, артефакт `.taskflow-mvp/merge-resolution.json`). Не-additive конфликт НЕ резолвится автоматически. Фазы, которые трогают общую базовую ветку (`preflight`, `merge-gate`, `merge`, `bd-owner`, `bd-export`, `cleanup`), сериализуются через общий lock (`--mergeLock`). Неразрешённый конфликт не игнорируется: `merge.mjs` записывает `.taskflow-mvp/merge-conflict.json`, откатывает merge и сообщает о `needs attention`.

## Ограничения v1

- нет динамического curator'а и выбора engine на tasks;
- нет автоматического повтора campaign при `needsAttention`;
- нет wave-планирования по `filesHint`;
- campaign-report читает уже созданные leaf `result.json` и падает, если какой-то лист не завершился merge+bd close.
