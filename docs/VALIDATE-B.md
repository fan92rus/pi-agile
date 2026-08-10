# Живая валидация B-протокола (чек-лист)

> Цель: проверить agent-driven делегацию (вариант B) в реальном цикле pi —
> не на фейковом pi, а с настоящими subagent-тулами, bd и git.
> **Требование:** новая pi-сессия с cwd = pi-agile (текущая сессия держит
> старый код расширения в памяти; валидация должна идти на последнем коммите).

## Подготовка (в новой сессии)

- [ ] `git log --oneline -1` в pi-agile → main содержит `refactor: удалён батч-путь...` (1024f9f+)
- [ ] В манифесте тулов есть `agile_prepare_review` и `agile_record_verdict`
      (признак свежего кода; в старом их нет)
- [ ] `bd ready` — пусто или есть тестовая задача
- [ ] Создать реальную тестовую bd-задачу (например, правка docs/README.md):
      `bd create -t "test: B-protocol validation" -d "..."`

## Прогон B-протокола (1 задача, до 3 раундов)

1. `agile_delegate_task({ bd_id, round: 1 })` — prepare:
   - [ ] возвращает инструкцию `subagent({agent:"worker", ..., task:"Читай .agile/delegate-<id>-r1.md..."})`
   - [ ] файл `.agile/delegate-<id>-r1.md` создан (текст buildWorkerTask)
   - [ ] `bd update <id> --claim` выполнен (bd show → статус claimed)
   - [ ] ветка `feat/<id>` создана
2. Вызвать нативный `subagent(worker)` с инструкцией из prepare
   - [ ] воркер сделал git add -A + commit на `feat/<id>` (не на main, не закрыл bd)
3. `agile_prepare_review({ bd_id, round: 1 })`:
   - [ ] `.agile/review-task-<id>-r1.md` создан, содержит свежий diff `main...feat/<id>`
   - [ ] возвращает инструкцию с `output:"<wd>/.agile/review-<id>-r1.txt"`, `outputMode:"file-only"`
4. Вызвать нативный `subagent(reviewer)` с output-путём из prepare_review
   - [ ] `.agile/review-<id>-r1.txt` создан субагентом, вердикт в формате
        `## Verdict: approved|rework|blocked` (+ json-блок с action_items/lessons)
5. `agile_record_verdict({ bd_id, round: 1 })`:
   - [ ] вердикт распознан (approved/rework/blocked), задача переведена корректно
   - [ ] review_rounds = 1; lessons/do_not_retry попали в knowledge.jsonl
   - [ ] возвращает указание следующего шага (approved → merge; rework → round 2)
6. По вердикту:
   - **approved** → `agile_merge_task({ bd_id })`:
     - [ ] squash-merge прошёл, `feat/<id>` удалён, `bd close <id>` выполнен
     - [ ] сообщение «Task merged to main», без worktree-упоминаний
   - **rework (round 1-2)** → повторить шаги 1-5 с round N+1:
     - [ ] `.agile/delegate-<id>-r<N+1>.md` содержит action_items предыдущего ревью
     - [ ] round 3: после record задача остаётся rework, «решает агент»
   - **blocked** → задача blocked, дальше не делегируем

## Проверки дизайна A (не сломаны)

- [ ] Спринт с терминальными задачами: после последнего merge следующий
      `agent_end` автоматически закрывает спринт (closeSprint) и шлёт
      «Sprint N auto-completed: X done, Y rework, Z blocked...» — ОДНО сообщение,
      без дублей (не all_blocked + nudge)
- [ ] Повторный agent_end в том же спринте молчит (agentEndSentForSprint)
- [ ] `agile_retrospective` на уже закрытом спринте — no-op без двойного
      sprint_summary в knowledge.jsonl
- [ ] `/agile stop` → agent_end-нуджи замолкают (loopStopped в session.json);
      `/agile on` → снова работают

## На что смотреть (известные риски реального цикла)

- Доставка steer-сообщений: tool-сообщения (steers) приходят в том же ходу
  (drain в конце итерации внутреннего цикла) — не должны теряться/дублироваться
- Формат вердикт-файла от РЕАЛЬНОГО ревьюера может отличаться от
  `reviewerVerdictText` из фейка — parseReviewVerdict должен его распарсить
- `bd update --claim` / `bd close` — реальный bd CLI (не фейковый catch-all)
- subagent-инструкции из prepare/prepare_review должны быть кликабельны
  (агент реально их выполняет, а не переписывает по-своему)

## После успешной валидации

- [ ] Отчёт: какие расхождения реального цикла найдены и что пофикшено
- [ ] Если B работает — закрыть вопрос C (миграция на официальный протокол) как неактуальный
- [ ] Если B ломается на реальном цикле — зафиксировать, решить: чинить B или откат
