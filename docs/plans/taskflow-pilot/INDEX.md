# INDEX — пилот taskflow/DAG

| Артефакт | Статус |
|---|---|
| Идея / цель | captured (обсуждение в сессии) |
| PLAN.md rev.3 | Approved / Frozen — владелец подтвердил запуск 2026-10-29 |
| flow.json rev.6 | Approved — Amendment 1/2/3/4/5/6, `taskflow verify` PASS; review cache по diff+criteria, повтор того же diff — 0 fresh |
| Ревью документа | R1: НЕ ГОДЕН; R2: НЕ ГОДЕН; финальное: ГОДЕН (3 раунда, 0 блокеров) |
| Согласие владельца | получено («давай, го»), 2026-10-29 |
| Заморозка ТЗ | да, спека не правится; изменения — новый проход ревью |
| Реализация пилота | завершена; результаты rev.3/rev.4/rev.5 — в results.md |
| seed.patch | зафиксированный рабочий диф успешного воркера, применяется до вызова LLM |
| rework-flow.json | отдельный bounded rework от blockers ревью (`args.blockers`) с продолжением сессии `work` через `args.sessionId`; ревьюер получает untrusted worker notes (Amendment 5/6) |
| fix phase | тот же агент по роли/модели/префиксу возвращается после внешних ревью; cross-run cache |
| context-reuse-probe.json | замер реального фикса с блокером; после `4203e27` использует `session.key` и измеряет нативную continuity |
| session-reuse-probe.json | минимальная проба одной Pi-сессии между фазами: `fix` = 247 fresh / 17 920 cacheRead |
| SHARECONTEXT-FIX.md | root cause `TFWS_MUTEX_IDENTITY` (Windows inode > 2^53) и patch для taskflow-core |
| reports/ | черновики прогонов; `results.md` больше не перезаписывается |

Amendment 3 прошёл свежее ревью с вердиктом ГОДЕН. Amendment 4 — решение ведущего по ускорению: reuse-first вместо повторной генерации; измерено два успешных прогона (`mwxv52gt`, `mwxvcr6h`), последний — 0 LLM-токенов и 105.6 c. Доработки P0/P1 проверены прогонами `mwyfq258` (results.md не тронут) и `mwyfy22k` (completed). Вариант «тот же агент» измерен прогонами `mwygv53p` (461k provider-cache) и `mwygzdmh` (0 токенов).
