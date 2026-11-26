# Amendment 1 — PATH для тестовых команд (rev.3.1)

## Причина

Три запуска замороженного flow (`agile-leaf-pilot-mwxish29-16d183`, `-mwj0jsf-884eba`, `-mw xj2y1m-76329c` — точные id ниже) падали в фазе `baseline-test`: 224 теста, 7 провалов, все с одним текстом

`testCommand failed (1): 'true' is not recognized as an internal or external command, operable program or batch file.`

Почему `true`, если в `run` написано `npm test`: сами тесты (`tests/agile-loop.test.mjs`, фикстуры mergeBranch) передают в `mergeBranch` `testCommand: 'true'` и spawn'ят его в temp-каталогах через `workflows/merge-branch.mjs:209`. В Script-фазе taskflow на этой машине используется `cmd.exe`, PATH которого не содержит MSYS `true`. Доказательство — выдержка из вывода фазы `baseline-test` прогона `agile-leaf-pilot-mwxish29-16d183`, сохранённая в `docs/plans/taskflow-pilot/amendment-evidence.txt`: семь строк `not ok` и `testCommand failed (1): 'true' is not recognized...` со стеком `mergeBranch (file:///D:/tmp/tf-pilot-repo/workflows/merge-branch.mjs:209:75)`. Источник — `.pi/taskflows/runs/agile-leaf-pilot/agile-leaf-pilot-mwxish29-16d183.json`, поле `phases['baseline-test'].output`. Ручной прогон из bash и из `cmd //c` с унаследованным bash PATH давал 224/224 — расхождение среды, а не дефект кода листа.

Точные id прогонов:
- `agile-leaf-pilot-mwxish29-16d183`
- `agile-leaf-pilot-mwxj0jsf-884eba`
- `agile-leaf-pilot-mwxj2y1m-76329c`

## Изменение

Три `run`-команды (`baseline-test`, `verify`, `merge`) получают префикс:

```
set PATH=C:\Users\user\bin;%PATH% &&
```

В `C:/Users/user/bin/true.cmd` создан ASCII/CRLF-файл с `@exit /b 0` — локальный shim для POSIX `true`, который ожидают фикстуры. Он удаляется ведущим после завершения пилота. Ни один гейт, вердикт, инструмент-agent или зависимость графа не меняется; семантика тестов остаётся прежней.

## Проверка

`taskflow verify` на изменённом `flow.json` — 0 ошибок, 0 предупреждений. Ожидаемый эффект: фазы тестов дают `# fail 0`, остальной граф идёт по замороженному плану.

## Статус

Изменение проходит короткий amendment-ревью свежим агентом; после вердикта ГОДЕН пилот перезапускается с нуля, а три неудачных прогона сохраняются как измерение.
