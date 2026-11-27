# RESULTS — tf-leaf-mvp

> Исторические прогоны ниже были на 19-фазовой версии до добавления финальной `cleanup`-фазы. Текущий flow: 20 фаз.

Два живых прогона на synthetic bd task `TEST-1` в throwaway repo `D:/tmp/tf-leaf-mvp-repo` с `bd` shim.

| Run | Режим | Фаз | Статус | fresh | cacheRead | turns | commit | escalation |
|---|---|---:|---|---:|---:|---:|---|---|
| `tf-leaf-mvp-mwz2irfq-e59f76` | happy path | 19 | completed | 99,166 | 226,560 | 17 | `d4153e4` | no |
| `tf-leaf-mvp-mwz2opi4-20686c` | forced escalation | 19 | completed | 100,009 | 323,072 | 22 | `309ac47` | `supervisorToken:ALPHA` |

Оба прогона:

- preflight → task-packet → work → gates → diff;
- два первых reviewer → rework-input → fix → recheck;
- diff-final → два финальных reviewer → rework-input-final;
- merge-gate → merge → bd-owner → bd-export → report;
- status `merged`, `bdClosed: true`, `needsAttention: null`.

## Escalation proof

В прогоне `mwz2opi4` worker вызвал `contact_supervisor` mid-turn:

```text
Which token should I return: ALPHA or BETA?
```

Supervisor ответил `ALPHA`. Worker продолжил в том же turn и вернул:

```json
{"summary":"Added the acceptance-required README line. supervisorToken:ALPHA","filesChanged":["README.md"],"decisions":[]}
```

Это доказывает, что MVP использует supervisor bridge не только в отдельном probe, а внутри боевого one-task flow.

## Уроки

1. `model` не интерполируется через `{args.X}` — модель зашита в `flow.json`; смена модели пока делается правкой flow.
2. `cwd` из args требует `type: relative-path`, поэтому абсолютные пути зашиты literal в flow.
3. Reviewer нельзя просить проверять «worker не вызывал bd/commit/push» по файлам — это проверяют детерминированные script phases. Иначе reviewer блокирует по недоказуемому критерию.
4. Нужна вторая пара reviewer после fix: первая пара evaluates пре-fix diff, а fix может изменить код.
5. merge phase должен коммитить worker changes в feature branch до rebase, иначе rebase падает на unstaged changes.
6. `bd close` делает грязным `.beads/issues.jsonl`; `bd-export` должен разрешить только это загрязнение и закоммитить отдельным commit.
