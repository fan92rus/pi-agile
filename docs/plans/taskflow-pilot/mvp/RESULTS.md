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
| `tf-leaf-mvp-review-fresh-mwza0q3y-c01697` | fresh | 42,968 | 280,448 | 17 | 141.1 | — |
| `tf-leaf-mvp-review-reuse-mwza403d-f9caa5` | reused | 42,738 | 282,496 | 17 | 150.0 | — |

The first four runs looked like a reviewer-reuse penalty, but the reverse-order pair (`fresh` then `reuse`) came out essentially equal. To isolate reviewers from `final-fix`, the same flows were rerun with `final-fix` skipped (`when: 1 == 0`); `final-cycles` then contains only the two incremental reviewers plus deterministic scripts.

| run | mode | final-cycle fresh | final-cycle cacheRead | initial correctness fresh |
|---|---|---:|---:|---:|
| `tf-leaf-mvp-review-reuse-mwza964g-4f6816` | reused | 1,731 | 113,792 | 19,638 |
| `tf-leaf-mvp-review-fresh-mwzabj3r-b01a95` | fresh | 1,564 | 94,720 | 836 |
| `tf-leaf-mvp-review-fresh-mwzaf22k-8d4ed3` | fresh | 20,327 | 94,976 | 854 |
| `tf-leaf-mvp-review-reuse-mwzahbma-05e1c6` | reused | 1,491 | 94,848 | 19,640 |

Root cause: the numbers are governed by **provider prompt-cache state**, not by taskflow session reuse as such. Continuing a reviewer session sends the already-warmed prefix from the initial review, so the incremental review is cheap; a fresh session must rebuild that prefix and can be cold or warm depending on whether the provider has cached an identical prompt. Taskflow's own cross-run cache was disabled for both variants, but provider-level prefix caching was not observable or controllable from the flow. The `final-cycles` aggregate also includes `final-fix`, adding worker-session variance to the first table.

Practical conclusion: reviewer session reuse gives a *stable hot prefix* for the second review, but it is not a reliable token-cost win in these measurements. `make-task-flow.mjs` therefore defaults to `--reuseReviewerSession false`; worker/fix session reuse stays enabled. Any future claim must control run order and cache warmth, and should instrument nested phases separately instead of relying on the aggregate `final-cycles` usage.

## Campaign layer proof

`campaign/make-campaign-flow.mjs` builds a Taskflow DAG from ready bd leaves; each leaf is the existing saved `tf-leaf-mvp-<taskId>` flow, and a final deterministic `campaign-report` checks leaf result artifacts. No new engine was introduced.

Synthetic two-leaf campaign `tf-campaign-mvp-mwzccj7w-e809b0`: completed 3/3; both leaves `merged`, `bdClosed true`, blockers empty, final report `status: merged`. Leaves ran with `concurrency: 1` because each merges into the same base branch.

Current real repo has no eligible ready code leaves after `pi-agile-8en`; `pi-agile-2nh` and `pi-agile-337` have no `Files:`/`Acceptance:` code-leaf shape and are intentionally filtered out.

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

## Campaign vs agile-loop на одной пачке задач

Одни и те же два реальных bd-листа с пересекающимися файлами:

```text
pi-agile-wa6.1 — waveA() в lib/wave-overlap.mjs + тест
pi-agile-wa6.2 — waveB() в lib/wave-overlap.mjs + тест
```

Оба прогона шли с `concurrency/maxParallel = 2`, `testCommand = npm test`, одним спринтом и авто-мержем. Первая попытка agile-loop была отброшена: ревьюер `zcode/glm-5.4` вне `modelScope`; в-table ниже только успешный прогон с `opencode-go/hy4-flash-free`.

| Прогон | Результат | Wall | Children / фазы | Tokens | Cost | Turn'ы | bd |
|---|---|---:|---:|---:|---:|---:|---|
| taskflow campaign `tf-campaign-real-overlap-mx05rjzt-51ed66` | 2 merged, 3/3 done | 775.8 s | 2 flow-фазы (внутри 19 phased-шагов на лист) | 320,117 fresh + 659,712 cacheRead | $0.0405 | 46 | оба листа + эпик закрыты |
| agile-loop `4dfb8128-321e-4423-b582-4d06b542ccd3` | 2 merged, 0 failed | 1091.8 s (по status; analytics: 985.2 s) | 11 детей | 191,938 (172,455 in / 19,483 out) | $0.0092 | 70 | оба листа закрыты, эпик остался открытым |

Оба финальных состояния прошли `npm test`: 246/246. Модуль содержит обе функции, а тестовый файл — оба теста.

Вывод: на этой пачке taskflow campaign был быстрее примерно на 21–29% по wall-clock, но дороже примерно в 4.4 раза по учтённой стоимости. Сравнение не полностью сопоставимо: у campaign ревьюеры были `gpt-6-luna` с fresh sessions, у agile-loop — `hy4-flash-free`; accounting токенов тоже разный (taskflow считает usage всех agent-фаз, agile-loop считает totalTokens детей). Для выбор движка по стоимости нужно повторять замер на той же модели ревьюера.

## Token work: что включено

1. **Clean-skip.** Новый `review-gate` после первых двух ревью пропускает `fix` и весь `final-cycles`, если оба вердикта `pass`. Вместо `fix` идёт дешёвый `fix-noop`, а `merge-gate` получает fallback от `review-gate` через `join: any`. Это убирает лишний fix и вторую пару ревьюеров для простых листов.
2. **Cache финальных ревью.** `review-correctness` и `review-guardrails` внутри `mvp-final-cycle` кешируются cross-run по стабильному файлу `.taskflow-mvp/review-fingerprint.txt`, который `incremental-diff` вычисляет из patch + criteria + acceptance + testCommand + fixSummary. Fingerprint в taskflow не интерполирует `{args.*}`, поэтому путь обязан быть относительным к cwd фазы. При `--reuseReviewerSession true` кеш снимается: taskflow запрещает cross-run cache для session-фаз.
3. **Дешёвый ревьюер по умолчанию.** `--reviewerModel` в генераторах теперь по умолчанию `opencode-go/hy4-flash-free`; worker остаётся на `gpt-6-luna`. Это главный рычаг стоимости.
4. **Учёт токенов.** `report.mjs` и `campaign/report.mjs` теперь берут usage из run state и пишут `freshTokens` / `cacheReadTokens` в leaf `result.json` и в campaign summary. В campaign usage имеет приоритет над возможным stale-значением из старого standalone leaf run. Раньше поля были всегда `0`.

### Почему не режем контекст ревьюеру

Отдельный пункт «дать ревьюеру только diff» я сознательно **не включил как общее правило**. Ранее уже были ложные blockers именно из-за размытых критериев; ревьюер начинает выдумывать проверки и провоцирует дополнительный rework-цикл, который свежевает ревьюера и съедает больше токенов, чем экономит короткий prompt. Оставляем: acceptance + criteria + filesHint + diff. Из лишнего убраны только инструкции, основанные на недоверенных заметках worker, там где они не нужны.

Живое доказательство: synthetic campaign `tf-token-opt-mx0bewp7-08dc61` — 2/2 done, merge и bd close зелёные; clean-skip path снова проходит после обработки `{steps.final-cycles.output}` как пропущенного выхода. В result и campaign summary записаны реальные `66,801` fresh и `200,704` cacheRead, совпадающие с usage campaign run state. Полный `npm test`: 258/258.
