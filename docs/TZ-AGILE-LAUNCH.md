# Запуск реализации ТЗ pi-autoresearch через agile

> Как запустить: новая pi-сессия с cwd = pi-agile, первое сообщение —
> «Прочитай docs/TZ-AGILE-LAUNCH.md и вызови agile_run с описанием из него
> (cwd: D:/Documents/Repositories/pi-autoresearch)». Сессия загрузит СВЕЖИЙ
> код расширения (B-протокол). headless `pi -p` на этом окружении зависает
> (спайк проверен) — запускать интерактивно.

## Описание для agile_run

Реализуй техническое задание docs/TZ-pbt-state-machine.md из репозитория
pi-autoresearch (D:/Documents/Repositories/pi-autoresearch). Для тебя
pi-autoresearch — ВНЕШНИЙ репозиторий: работай только через явный
cwd=D:/Documents/Repositories/pi-autoresearch во всех тулах (agile_*,
subagent, bd, git). Твой home-репозиторий pi-agile нужен только чтобы
agile-тулы были доступны — НЕ изменяй pi-agile (читать его tests/ как эталон
можно).

Суть: PBT/state-machine тестовое покрытие реального
extensions/pi-autoresearch/index.ts (5480 строк) по образцу pi-agile:
tests/typebox-stub.mjs + redirect-loader на 4 пакета (@sinclair/typebox,
@earendil-works/pi-coding-agent, @earendil-works/pi-ai, @earendil-works/pi-tui),
fake-pi harness (ключ runtimeStore — ctx.sessionManager.getSessionId()),
RealSystem, 11 actions, инварианты P1-P10, smoke real-extension секция,
>=20 seeds x >=20 actions, суммарно >=150 тестов при сохранении зелёными
существующих 59. Прод-изменения — только через TDD
(красный тест → минимальный фикс → зелёный). Результат: REPORT-pbt.md
в корне pi-autoresearch.

## Критерии остановки (работа завершена, когда выполнены ВСЕ)

1. Все 6 стадий ТЗ реализованы; REPORT-pbt.md написан в корень pi-autoresearch
   с описанием найденных непокрытых критичных мест и как они покрыты.
2. Полный прогон тестов в pi-autoresearch зелёный 3 раза подряд:
   существующие 59 + новые, суммарно >=150; PBT-сценарий >=20 seeds x >=20
   actions без флейков.
3. Фаза «поиск непокрытых критичных мест» выполнена: отчёт в REPORT-pbt.md,
   критичные места покрыты тестами.
4. Баланс: существующие 59 тестов не переписаны без необходимости; новые
   тесты устойчивы (не требуют правок при мелких изменениях кода).
5. Всё закоммичено и запушено в pi-autoresearch (origin/master); bd-задачи
   закрыты; спринт закрыт через agile_retrospective.
6. Если пункт ТЗ технически невыполним — задокументируй в REPORT-pbt.md
   (секция Open questions) и остановись; НЕ входи в бесконечный цикл.

## Параметры agile_run

- `description`: текст выше
- `max_sprints`: 0 (continuous — работа до выполнения критериев остановки)
- `cwd`: D:/Documents/Repositories/pi-autoresearch

## Ожидания

- Способности: worker/reviewer-субагенты спавнятся агентом по B-протоколу
  (agile_delegate_task prepare → subagent(worker) → agile_prepare_review →
  subagent(reviewer) → agile_record_verdict → agile_merge_task), с
  cwd=pi-autoresearch.
- bd-задачи создаются в pi-autoresearch/.beads (через bd с cwd=pi-autoresearch).
- Двойная проверка: 3 последовательных зелёных прогона (критерий 2) защищают
  от флейков; стабильность новых тестов (критерий 4) — от хрупкости.
