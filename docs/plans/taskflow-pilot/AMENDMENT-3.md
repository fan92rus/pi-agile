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

### Первый прогон rev.4 (пойманный дефект промпта)

Прогон `agile-leaf-pilot-mwxqzg5y-b4b8af` остановился на `gate-contract`: воркерневерно понял «keep existing edits» как «ничего не делать» на чистом клоне; `contract-check` выдал `CONTRACT FAIL n=0`, gate заблокировал commit до мержа. Никаких токенов на ревью и мерж не потрачено. Промпт уточнён: при совпадении файлов с HEAD implement from scratch; инварианты контракта перечислены прямо в задании.

### Второй прогон rev.4 (пойманный пробел контракта)

Прогон `agile-leaf-pilot-mwxr7nw0-dd2657` дошёл до ревью: correctness `pass`, тесты зелёные, но guardrails `block` — воркер запретил только `bd close`/`bd reopen`, забыв `bd create`/`bd update`. Проверка контракта усилена: теперь требуется явное упоминание всех четырёх операций; промпт воркера уточнён тем же списком. Это ровно тот класс ошибки, ради которого вводился `contract-check`.

### Третий прогон rev.4 (синтаксис)

Прогон `agile-leaf-pilot-mwxrgeom-b68acf`: `contract-check PASS`, но `npm test` дал 226 тестов, 34 pass / 192 fail с `SyntaxError: await is only valid in async functions` — воркер действительно сломал синтаксис тестов. Добавлены script-фаза `parse-check` и gate `gate-parse` с `onBlock: retry, retry.max: 1`; `verify` зависит от обоих gate-ов. **Важная поправка:** первая версия `parse-check` использовала `node --check workflows/agile-loop.js` и давала ложные срабатывания — workflow-скрипт компилируется как тело AsyncFunction (`tests/harness.mjs:compileWorkflow`), поэтому top-level `await`/`return` в нём допустимы. Проверка исправлена на `compileWorkflow()` + `node --check tests/agile-loop.test.mjs`; прогоны `mwxrpnvl` и `mwxs5v7x` (blocked by gate-parse) были ложными блокировками этого дефекта проверки, а не дефектом воркера.

### Четвёртый прогон rev.4 (quality over cheapness)

Прогон `agile-leaf-pilot-mwxrwxtm-227d09` также был заблокирован `gate-parse`, но после исправления проверки выяснилось, что это ложное срабатывание. Решение ведущего всё же оставить на `work` более сильную модель `openai-codex/gpt-6-luna`, а двух свежих ревьюеров перевести на `opencode-go/hy4-flash-free` (другая модель относительно автора): в предыдущих циклах дешёвый воркер дважды создавал реально некорректные тесты, и стоимость повторного цикла превышала стоимость сильной генерации.

### Пятый прогон rev.4 (слишком жёсткий regex)

Прогон `agile-leaf-pilot-mwxseirj-949dfc`: `n=5`, `reopen/create/update=true`, но тесты писали `BD_WRITE_BAN` с подчёркиванием, а проверка искала `bd write ban` с пробелами — ложный BLOCK. Regex исправлен на `/BD_WRITE_BAN/`. Regex проверки не должен быть жёстче самого контракта.

### Шестой прогон rev.4 (неполный scope)

Прогон `agile-leaf-pilot-mwxsmlw0-6c0a2d`: воркер изменил только тесты (`n=4` вместо требуемых 5), решив, что контракт в движке «уже есть». В промпт добавлен факт: на baseline HEAD `BD_WRITE_BAN` встречается 0 раз, редактировать нужно оба файла. Это не новый тип дефекта, а тот же класс, который и ловит `contract-check`.

### Седьмой прогон rev.4 (текст без поведения)

Прогон `agile-leaf-pilot-mwxss3ge-c5ca3a` дошёл до ревью, но оба ревьюера `block`: воркер добавил строки banned-контракта и юнит-тест на исходник, но не создал реальный `bd reopen`, incidents в return и не вставил ban в `ledgerRepair`. `contract-check` усилен: теперь требует реальную команду `bd reopen " + ...`, поле `bdReopenIncidents` и тест, ссылающийся на incidents/reopen. Это граница между статической проверкой и семантическим ревью: первая ловит «строки ради теста», вторая — отсутствие поведения.

### Восьмой прогон rev.4 (эквивалентные имена)

Прогон `agile-leaf-pilot-mwxt20p2-8aa3d8`: `reopenCmd=true`, но incidents назывались `bdCloseIncidents`, а проверка требовала только `bdReopenIncidents`; плюс в движке было 4 ссылки на ban вместо пяти. Проверка приняла оба имени списка инцидентов, а в промпт добавлено требование ровно пяти ссылок (включая `ledgerRepair`).

## Что не изменилось

Гейты, инструменты агентов, отсутствие bd-вызовов, границы двух файлов и правило «ревью до commit» сохранены. Изменились только модели ролей и добавлены детерминированные проверки контракта и синтаксиса.
