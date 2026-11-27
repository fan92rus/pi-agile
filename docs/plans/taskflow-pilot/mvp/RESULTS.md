# RESULTS — tf-leaf-mvp

> Исторические прогоны ниже были на 19-фазовой версии до добавления `cleanup` и repeat-циклов. Текущий flow: 19 топ-level фаз, внутри `final-cycles` — повторяемый saved subflow.

## Fix session reuse A/B

Same synthetic `TEST-1` task, identical repo state and prompts; only the `fix` phase session differed. Reviewer reuse was disabled in both runs, `--maxCycles 1`. Two pairs were run.

| run | fix session | fresh tokens | cacheRead | turns | seconds | cost |
|---|---|---:|---:|---:|---:|---:|
| `mwz8ecty-0817b6` | reused | 19,736 | 37,248 | 3 | 18.4 | 0.002490 |
| `mwz8i6fg-6fb5c7` | fresh | 1,358 | 74,624 | 4 | 17.8 | 0.001012 |
| `mwz8l2h4-72bc02` | reused | 971 | 55,808 | 3 | 15.0 | 0.000742 |
| `mwz8nyqs-63130b` | fresh | 38,193 | 37,248 | 4 | 12.2 | 0.004259 |
| average | reused | 10,354 | 46,528 | 3.0 | 16.7 | 0.001616 |
| average | fresh | 19,776 | 55,936 | 4.0 | 15.0 | 0.002636 |

The token/cost difference is noisy because prompt caching and model nondeterminism dominate a no-op fix. A targeted probe removes that ambiguity: work chose a marker `CYCLE-NNNN` and stored it outside the worktree without mentioning it in its JSON; fix had to append that exact marker.

| probe | result | fix tokens | fix turns | fix seconds |
|---|---|---:|---:|---:|
| `token-probe-reuse-mwz8t7sl-8a4486` | `pass=true` | 1,284 | 3 | 18.9 |
| `token-probe-fresh-mwz8u5r4-9bbe77` | `pass=false`, invented `MVP TEST OK` | 19,692 | 7 | 40.3 |

Conclusion: session reuse makes fix cheaper and reduces turns in this pilot, and gives access to context that is not available in artifacts. Wall time is not reliably lower because a fresh session can be shorter when it does less verification.

## Full-flow reviewer session reuse A/B

Full 19-phase flow, same synthetic `TEST-1`, identical repo state and worker/fix sessions, `--maxCycles 1`. Both reviewer cache scopes were forced to `run-only` because taskflow rejects `cross-run` together with session reuse.

- **reuse** — initial reviewers and final-cycle reviewers shared one session id per reviewer role.
- **fresh** — initial and final-cycle reviewers used different session ids.

`review total` = `review-correctness` + `review-guardrails` + aggregated `final-cycles`. The last aggregate also includes `final-fix`, so this is reviewer-path cost rather than a pure reviewer-only measurement.

| run | mode | review fresh | review cacheRead | review turns | total run sec | review cost |
|---|---|---:|---:|---:|---:|---:|
| `tf-leaf-mvp-review-reuse-mwz99x0a-382d80` | reused | 60,292 | 150,528 | 11 | 125.5 | 0.008060 |
| `tf-leaf-mvp-review-fresh-mwz9cukn-40adbf` | fresh | 43,487 | 281,600 | 17 | 128.1 | 0.007733 |
| `tf-leaf-mvp-review-reuse-mwz9ftso-38472f` | reused | 61,620 | 263,936 | 17 | 150.3 | 0.009391 |
| `tf-leaf-mvp-review-fresh-mwz9jd9g-3f4192` | fresh | 23,587 | 262,912 | 15 | 218.8 | 0.005597 |
| average | reused | 60,956 | 207,232 | 14.0 | 137.9 | 0.009000 |
| average | fresh | 33,537 | 272,256 | 16.0 | 173.4 | 0.007000 |

Unlike fix reuse, reviewer reuse did **not** reduce fresh tokens here: fresh sessions got more provider prompt-cache hits and used fewer fresh tokens, while reused sessions had fewer turns and shorter total runs in this sample. Treat this as evidence that reviewer reuse changes cache behavior rather than as a universal cost win.

## Repeat-cycle proof

Синтетический прогон `tf-leaf-mvp-TEST-1-mwz7k01r-d8c206`: completed 19/19, `final-cycles` завершился на `cycle=2` с `done=true`, blockers пуст, merge `1461622`, cleanup удалил worktree/branch. Reviewer'ы получали `.taskflow-mvp/diff-cycle-N.patch` и untrusted `fixSummary`; worker/fix и reviewer-сессии configured as `cleanup: keep`.

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
