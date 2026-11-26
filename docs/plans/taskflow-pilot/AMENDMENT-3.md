# Amendment 3 — устранение мусора из измерений (rev.4)

## Причина

Замер по `*.trace.jsonl` показал: из 957 444 свежих токенов на успешный прогон пришлось только 228 800; ~729k ушло на четыре повторных прогона `work`. Две неудачи — воркер написал тесты с expectations, которых нет в исходниках; две — `resume` перезапустил уже сделанную фазу `work`. Ревьюеры вместе стоили 0.73M токенов и $0.016, то есть не являются узким местом.

## Изменения

1. **Тестовый контракт до тестов.** Добавлена `script`-фаза `contract-check`: она читает `workflows/agile-loop.js` и `tests/agile-loop.test.mjs` и печатает `CONTRACT PASS` только если `BD_WRITE_BAN` встречается не менее 5 раз, `bd reopen` присутствует в исходнике и тесты содержат проверки ban/reopen. Детерминированный `gate-contract` с `onBlock: "retry", retry.max: 1` даёт одну bounded-rework-итерацию воркера без LLM-арбитра.
2. **Меньше перезапусков.** В `work` явно сказано: если ветка `tf-pilot/8en` уже есть — переиспользовать её, не пересоздавать; лимит 15 turn-ов; wall timeout снижен с 900 c до 600 c, idle — до 180 c. Ревьюеры получили те же таймауты. Для ревьюеров включён cross-run cache с fingerprint по `git:HEAD` и двум целевым файлам; side-effect-фазы остаются вне кэша.
3. **Переносимость.** Все `testCommand: "true"` в `tests/agile-loop.test.mjs` заменены на `testCommand: "node -e 0"` (проверено в cmd.exe и bash, exit 0; `npm test` 224/224 с ревью ГОДЕН). PATH-префиксы и shim `C:/Users/user/bin/true.cmd` удалены из трёх run-команд. Shim удалён с машины.
4. **Дёшевый guardrails.** Guardrails-ревьюер переведён на `opencode-go/hy4-flash-free` (свежий сеанс, та же модель что у воркера допустима); correctness остаётся на `openai-codex/gpt-6-luna`.
5. **Стоп-лосс.** Добавлен flow-level `budget: { maxUSD: 0.5, maxTokens: 2000000 }` — выше успешного прогона (1.25M с учётом cache), ниже неудачных (до 5.1M).
6. **Автоматические метрики.** Новый `docs/plans/taskflow-pilot/metrics.mjs` парсит самый свежий run и дописывает table fresh/cache/total/turns/cost в `results.md`; script-фаза `metrics` стоит после `post` и является финальной.

## Проверка

- `taskflow verify`: `✅ No issues found.`
- Fixture fix: 0 оставшихся `testCommand: "true"`, `core.editor=true` и `|| true` нетронуты, `npm test` 224/224, cmd `node -e 0` exit 0, ревью ГОДЕН без блокеров — извлечённые строки и числа в `amendment3-evidence.txt`.
- Ожидаемый эффект: при тех же входных данных новый прогон не должен тратить ~390k fresh на выдуманные тесты и ~250k fresh на перезапуск `work`.

## Что не изменилось

Гейты, инструменты агентов, модель correctness-ревьюера, отсутствие bd-вызовов, границы двух файлов и правило «ревью до commit» сохранены.
