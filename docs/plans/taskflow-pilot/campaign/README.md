# Campaign layer over tf-leaf-mvp

Campaign layer не вводит новый движок. Он только:

1. берёт ready-листы из bd;
2. для каждого листа генерирует `tf-leaf-mvp-<taskId>` через `make-task-flow.mjs`;
3. строит Taskflow DAG, где каждый лист — обычная `flow`-фаза;
4. после всех листов запускает детерминированный `campaign-report`.

## Генерация

```bash
node docs/plans/taskflow-pilot/campaign/make-campaign-flow.mjs \
  --repo D:/Documents/Repositories/pi-agile \
  --bdBin C:/tools/bd.exe \
  --worktreeRoot D:/tmp/tf-campaign-worktrees \
  --testCommand 'npm test' \
  --maxCycles 3 \
  --concurrency 3
```

По умолчанию беруться только ready-листы, у которых в описании есть `Files:` и `Acceptance:`. Это отсекает операционные задачи вроде ff-merge/лендинга.

Явный набор задач:

```bash
--tasks pi-agile-aaa,pi-agile-bbb
```

## Запуск

Сгенерированный flow:

```text
.pi/taskflows/tf-campaign-mvp.json
```

Запуск через taskflow из каталога проекта:

```text
action=run name=tf-campaign-mvp
```

## Почему parallelism безопасен

Leaf-и работают в отдельных worktree и могут править пересекающиеся файлы: совместимые изменения смержатся обычным `git merge`, а текстовые additive-конфликты разрешаются union-резолвером (обе стороны сохраняются, артефакт `.taskflow-mvp/merge-resolution.json`). Фазы, которые трогают общую базовую ветку (`preflight`, `merge-gate`, `merge`, `bd-owner`, `bd-export`, `cleanup`), сериализуются через общий lock (`--mergeLock`). Неразрешённый конфликт не игнорируется: `merge.mjs` записывает `.taskflow-mvp/merge-conflict.json`, откатывает merge и сообщает о `needs attention`.

## Ограничения v1

- нет динамического curator'а и выбора engine на tasks;
- нет автоматического повтора campaign при `needsAttention`;
- нет wave-планирования по `filesHint`;
- campaign-report читает уже созданные leaf `result.json` и падает, если какой-то лист не завершился merge+bd close.
