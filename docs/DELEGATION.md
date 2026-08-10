# Делегация задач: текущее состояние, варианты, эксперимент B

> Дата: 2026-08-08. Решение: пробуем вариант B (agent-driven delegation) как
> основной режим одиночной делегации. Батч-путь (worktrees) остаётся legacy до
> валидации B; вариант C — запасной план.

## 1. Текущее состояние (вариант A: плагин-драйв через RPC-мост)

`agile_delegate_task` сам спавнит субагентов «под капотом» через RPC-мост
pi-subagents и ждёт их завершения:

```
агент ── agile_delegate_task ──► rpc.ts ── subagents:rpc:v1:request ──► pi-subagents (async run)
       ◄── текст вердикта ────────  pollWithProgress (статус + выходной файл) ◄──
```

Плюсы: детерминизм (состояние меняет код, не LLM), чистый контекст агента,
1 tool-call на задачу, проверенный канал (pi-subagents сам слушает
`subagents:rpc:v1:request`, src/extension/rpc.ts:403).

Минусы (подтверждены реальными багами этой сессии): непрозрачность для агента;
огромный пласт хрупкого кода (rpc-клиент, pollWithProgress, clearOutputFile от
stale-файлов, dead-bridge guard, stuck-worker loop, worktrees, gitMergeFromWorktree,
cleanupStaleWorktrees); парсинг текстовых вердиктов; тихие сбои (диск расходится
с состоянием молча); философское противоречие с системным промптом
(«Extension only runs tools and persists data»).

## 2. Варианты (согласованный анализ, 2026-08-08)

| | A: мост (текущий) | B: agent-driven | C: официальный протокол |
|---|---|---|---|
| Кто спавнит | расширение (скрыто) | агент (видно всё) | расширение (скрыто) |
| Прозрачность | нет | да | нет |
| Детерминизм | высокий | средний (модель) | высокий |
| Сложность расширения | высокая | низкая | средняя |
| Вердикт | парсинг текста | парсинг текста (в record) | структура (v2) |
| Ходов на задачу | 1 | 3–5 | 1 |

- **A** — статус-кво, зафиксировано выше.
- **B** — агент сам спавнит worker/reviewer через свой нативный `subagent`-тул;
  расширение готовит задания (файлы) и записывает вердикты (детерминированная
  бухгалтерия). Сбои субагентов видны агенту и самоисправляемы.
- **C** — миграция rpc.ts на `prompt-template:subagent:*` v2 (официальный
  контракт, structured verdicts без парсинга). Не лечит непрозрачность.

## 3. Решение: пробуем B

B реализуется для одиночного пути (`bd_id`). Батч (`bd_ids[]` → worktrees)
остаётся на мосту как legacy — удаляется после валидации B. Мост также
остаётся для: chain-агентов до воркера (scout/researcher/planner), scout в
`agile_discover`, detective в `agile_investigate`.

## 4. Спецификация B-протокола

Файлы (в `.agile/`):
- `delegate-<bdId>-r<N>.md` — задание воркера (текст `buildWorkerTask`).
- `review-task-<bdId>-r<N>.md` — задание ревьюера (текст `buildReviewerTask` +
  свежий diff).
- `review-<bdId>-r<N>.txt` — вердикт ревьюера (пишет субагент через параметр
  `output` нативного subagent-тула).

Протокол агента (на раунд, до 3 раундов):
1. `agile_delegate_task({bd_id, round})` — prepare: bd show → gitCreateBranch →
   chain-агенты (если заданы) → запись `delegate-<bdId>-r<N>.md` (для round>1
   фидбек из action_items предыдущего ревью) → возвращает инструкцию вызова
   `subagent({agent:"worker", model, task:"Читай .agile/delegate-<bdId>-r<N>.md
   и следуй ему", context:"fresh", cwd})`.
2. Агент вызывает subagent (worker) — блокирует до завершения.
3. `agile_prepare_review({bd_id, round})` — свежий diff (`main...feat/<bdId>`) →
   запись `review-task-<bdId>-r<N>.md` → возвращает инструкцию вызова
   `subagent({agent:"reviewer", model, task:"Читай .agile/review-task-<bdId>-r<N>.md",
   context:"fresh", cwd, output:"<workDir>/.agile/review-<bdId>-r<N>.txt",
   outputMode:"file-only"})`.
4. Агент вызывает subagent (reviewer).
5. `agile_record_verdict({bd_id, round})` — читает вердикт-файл,
   `parseReviewVerdict`, бухгалтерия (setReviewRounds max, markRework/markBlocked +
   trackTaskTransition, constraint violations, lessons/dead_end → knowledge,
   store.save, runSprintObserver, не-терминальные стиры через steer) → возвращает
   вердикт + указание следующего шага:
   - approved → `agile_merge_task({bd_id})`;
   - blocked → задача заблокирована, дальше не делегируем;
   - rework и round<3 → `agile_delegate_task({bd_id, round: N+1})`;
   - rework и round=3 → задача остаётся rework, решает агент.

Ошибки: prepare при round>3 — «max 3 rounds»; prepare_review при пустом diff —
«воркер ничего не изменил»; record при отсутствии вердикт-файла — громкая
ошибка с указанием ожидаемого output-пути (нет тихих расхождений).

Дизайн A не меняется: record не ставит `agentEndSentForSprint`, терминальные
стиры не шлются, спринт закрывает agent_end.

## 5. План тестов

- **Smoke**: хелпер `delegateViaB` (prepare → prepare_review → запись
  вердикт-файла → record, до 3 раундов). Переписываются существующие
  delegate-тесты (rework-цикл 3 раунда с фидбеком, break на approved, blocked →
  auto-close, stagnation-стир, AC в ревью-задании) + новые (инструкции prepare
  с file-референсом, output-путь в prepare_review, ошибка record без файла,
  лимит round>3, гейтинг 10 тулов).
- **PBT**: `RealSystem.delegate` гоняет реальную B-последовательность
  (prepare → симуляция воркера → prepare_review → запись вердикт-файла →
  record); P21 (rework → 3 раунда, review_rounds=3) сохраняется; P20 (stuck)
  переезжает на батч-путь.

## 6. Откат

Вся логика моста и старого inline-делегата остаётся в git-истории
(последний коммит до перехода). Откат: `git revert` + возврат старого
`agile_delegate_task`. Батч на мосту не трогается, поэтому мост и его тесты
живы до валидации.
