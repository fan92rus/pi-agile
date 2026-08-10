# Делегация задач: текущее состояние, варианты, эксперимент B

> Дата: 2026-08-08. Решение: пробуем вариант B (agent-driven delegation) как
> основной режим делегации. 2026-08-10: B реализован и протестирован;
> **батч-путь (worktrees) удалён** — агент-драйв единственный режим.

## 1. Прошлое состояние (вариант A: плагин-драйв через RPC-мост) — удалено

`agile_delegate_task` сам спавнил субагентов «под капотом» через RPC-мост
pi-subagents и ждал их завершения (rpc.ts + pollWithProgress + worktrees +
gitMergeFromWorktree + cleanupStaleWorktrees + batch-progress.json). Весь этот
пласт (~1500-2000 строк) удалён — он был источником большинства реальных багов
сессии (stale-файлы, dead bridge, утечка ворктри на `add -b` exit 255, мерж,
душивший agent_end auto-close). Код остаётся в git-истории (откат: `git revert`).

## 2. Варианты (согласованный анализ, 2026-08-08)

| | A: мост (удалён) | B: agent-driven (текущий) | C: официальный протокол |
|---|---|---|---|
| Кто спавнит | расширение (скрыто) | агент (видно всё) | расширение (скрыто) |
| Прозрачность | нет | да | нет |
| Детерминизм | высокий | средний (модель) | высокий |
| Сложность расширения | высокая | низкая | средняя |
| Вердикт | парсинг текста | парсинг текста (в record) | структура (v2) |
| Ходов на задачу | 1 | 3–5 | 1 |

- **B** — агент сам спавнит worker/reviewer через свой нативный `subagent`-тул;
  расширение готовит задания (файлы) и записывает вердикты (детерминированная
  бухгалтерия). Сбои субагентов видны агенту и самоисправляемы.
- **C** — запасной план: миграция rpc.ts на `prompt-template:subagent:*` v2
  (официальный контракт, structured verdicts без парсинга). Не лечит
  непрозрачность.

## 3. Что осталось на мосту (осознанный гибрид)

Мост (rpc.ts + pollWithProgress) остаётся только для **контекстных** агентов,
которые не выносят вердиктов:
- chain-агенты до воркера в `agile_delegate_task` (`chain: ["scout", ...]`);
- scout в `agile_discover`;
- detective в `agile_investigate`.

Все они best-effort: сбой субагента не ломает prepare/discover/investigate —
агент получает пометку `[FAILED]` в выходном файле задания.

## 4. Спецификация B-протокола

Файлы (в `.agile/`):
- `delegate-<bdId>-r<N>.md` — задание воркера (текст `buildWorkerTask`).
- `review-task-<bdId>-r<N>.md` — задание ревьюера (текст `buildReviewerTask` +
  свежий diff).
- `review-<bdId>-r<N>.txt` — вердикт ревьюера (пишет субагент через параметр
  `output` нативного subagent-тула).

Протокол агента (на раунд, до 3 раундов):
1. `agile_delegate_task({bd_id, round})` — prepare: bd show → **bd update
   --claim (round 1)** → gitCreateBranch → chain-агенты (если заданы) →
   запись `delegate-<bdId>-r<N>.md` (для round>1 фидбек из action_items
   предыдущего ревью) → возвращает инструкцию вызова
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
ошибка с указанием ожидаемого output-пути (нет тихих расхождений). stale
вердикт-файл чистится в prepare и prepare_review (guard от перечитывания
старого вердикта при повторной делегации).

Дизайн A не меняется: record не ставит `agentEndSentForSprint`, терминальные
стиры не шлются, спринт закрывает agent_end.

## 5. bd-интеграция (2026-08-10)

Системный промпт обещает, что claim/close делаются автоматически — теперь это
правда:
- `agile_delegate_task` (prepare, round 1) → `bd update <id> --claim`;
- `agile_merge_task` (после успешного мержа) → `bd close <id>`.

Оба best-effort (bd может отсутствовать или задача уже в нужном статусе).

## 6. План тестов

- **Smoke**: хелпер `delegateViaB` (prepare → prepare_review → запись
  вердикт-файла → record, до 3 раундов). B-тесты: rework-цикл 3 раунда с
  фидбеком, break на approved, blocked → auto-close, stagnation-стир, AC в
  ревью-задании, инструкции prepare с file-референсом, output-путь в
  prepare_review, ошибка record без файла, лимит round>3, claim/close в bd,
  stuck-scout деградирует gracefully (chain), гейтинг 10 тулов.
- **PBT**: `RealSystem.delegate` гоняет реальную B-последовательность
  (prepare → симуляция воркера → prepare_review → запись вердикт-файла →
  record); P21 (rework → 3 раунда, review_rounds=3); P19 (реальный git:
  feat/<bdId> после делегата, удаление после мержа); P22 (agent_end
  auto-close). Батч-инварианты (P18, worktree-cleanup) удалены вместе с
  батч-путём.

## 7. Откат

Весь код моста и батча остаётся в git-истории. Откат: `git revert` коммита
удаления. C (официальный v2-протокол) — запасной план, если живая валидация
B покажет, что модель не справляется с дисциплиной протокола.
