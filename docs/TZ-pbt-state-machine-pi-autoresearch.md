# ТЗ: PBT-тесты со State Machine для pi-autoresearch (по образцу pi-agile)

**Статус:** проект (передаётся другому агенту на исполнение)
**Целевой репозиторий (внешний):** `D:\Documents\Repositories\pi-autoresearch` (v1.9.0, master `0ad9a2c`)
**Репозиторий-донор:** `D:\Documents\Repositories\pi-agile` (main `3ac3449`)

> **ГРАНИЦА ОТВЕТСТВЕННОСТИ (важно прочитать первым):**
>
> 1. **Исполнитель этого ТЗ — другой агент.** Он работает В pi-autoresearch,
>    который является для него **ВНЕШНИМ целевым репозиторием**: сессия/агент
>    запускается не «внутри» репозитория как дома, а оперирует им через явный
>    `cwd` (как воркер pi-agile — через worktree/cwd целевого репо). Все команды
>    и тесты выполняются с `cwd = <путь к pi-autoresearch>`; ни один инструмент
>    не должен предполагать, что его рабочая директория — это уже pi-autoresearch.
> 2. **Всё, что находится в `D:\Documents\Repositories\pi-agile` (тестовая
>    инфраструктура: `tests/typebox-stub.mjs`, `tests/typebox-redirect-loader.mjs`,
>    `tests/fake-pi.ts`, `tests/pbt.test.mjs`, `tests/smoke.test.mjs`), — делает
>    ДРУГОЙ агент** (назовём его «владелец pi-agile»). Исполнитель этого ТЗ:
>    - НЕ модифицирует pi-agile;
>    - НЕ собирает из него пакет и НЕ ждёт, пока пакет появится (вынос в пакет —
>      отдельная задача владельца pi-agile, см. раздел 5);
>    - КОПИРУЕТ нужное из pi-agile **read-only** (по путям из раздела 3).
> 3. **Сам этот ТЗ находится в pi-agile** (внешний документ для исполнителя) —
>    его передаёт оркестратор вместе с задачей. В pi-autoresearch ТЗ коммитить
>    НЕ нужно: это внешний репозиторий, и оркестрационные документы ему не
>    принадлежат.

---

## 1. Цель

Сделать в pi-autoresearch то же, что сделано в pi-agile: **реальная оркестрация
расширения (`extensions/pi-autoresearch/index.ts`, 5480 строк) — под PBT-тестами
со State Machine**, имитирующей реальную систему. Сейчас оркестрация покрыта 0%:
существующие 59 тестов (`node --test`, `tests/*.test.mjs`) проверяют только
чистые функции `parallel/*` и `observer.ts`.

Критерий успеха — по аналогии с pi-agile:
- реальный `index.ts` импортируется в тестах (через redirect-loader + стабы);
- PBT State Machine гоняет реальные тулы (init → propose → run → log → фазы →
  explore/restore → finalize) и реальные хуки (session_*, agent_end,
  before_agent_start) против временных `.auto/`-директорий;
- инварианты ассертят реальное состояние диска (`log.jsonl`, `tree.json`,
  `config.json`) и реальные сообщения (`pi.sendUserMessage`);
- smoke-секция real-extension: регистрация 16 тулов + 9 хуков + lifecycle e2e;
- существующие 59 тестов НЕ ломаются.

---

## 2. Карта кода (факты, проверенные на master `0ad9a2c`)

### 2.1 Модули
```
extensions/pi-autoresearch/
  index.ts       5480 стр.  — default export autoresearchExtension(pi)
  hooks.ts        364 стр.  — deps-free (только node builtins + ./jsonl, ./paths, ./observer)
  observer.ts    1008 стр.  — deps-free, уже покрыт 26 тестами (observer.test.mjs)
  compaction.ts  264 стр.   — deps-free
  jsonl.ts       192 стр.   — deps-free
  paths.ts        94 стр.   — deps-free (os.homedir(), НЕ getAgentDir)
  shortcuts.ts    94 стр.   — ⚠️ НЕ deps-free: `import { getAgentDir } from "@earendil-works/pi-coding-agent"`
  parallel/                — aggregate, bestofn, compose, config-ui, config, cpu,
                             orthogonal, phases, remeasure, rpc, simhash, spacesearch,
                             tree, treeview, types (все тестируемые напрямую)
```

### 2.2 Внешние зависимости — БЛОКИРУЮТ импорт index.ts (все 4 нерезолвятся из extension)
Проверено: `require.resolve(...)` из `extensions/pi-autoresearch` бросает для всех.

| Пакет | Символы | Строка | Что нужно в стабе |
|---|---|---|---|
| `@sinclair/typebox` | `Type` | index.ts:31 | callable Proxy (уже есть в pi-agile) |
| `@earendil-works/pi-coding-agent` | `truncateTail`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, `formatSize` | index.ts:28 | `truncateTail` — реальная реализация ~15 строк (или no-op, фейл-драйв); `formatSize` — тривиально; константы — числа |
| — // — | `getAgentDir` | shortcuts.ts:1 | вернуть temp-агент-дир (герметичность) |
| `@earendil-works/pi-ai` | `StringEnum` | index.ts:29 | `() => typeboxCallableProxy` (StringEnum возвращает typebox-схему) |
| `@earendil-works/pi-tui` | `Text` (×54), `truncateToWidth` (×22), `matchesKey` (×6), `visibleWidth` (×12) | index.ts:30 | `truncateToWidth/visibleWidth/matchesKey` — честные 10-строчные реализации; `Text` — минимальный объект; рендер-пути в PBT не вызываются, стаб по фейл-драйву |

`import type {...}` (строка 21-27) стираются при strip-types — стабов НЕ требуют.

### 2.3 API pi, используемый расширением
```
pi.on             ×9  — session_start, session_tree (→ reconstructState),
                        session_before_switch, session_shutdown, agent_start,
                        session_before_compact, session_compact, agent_end,
                        before_agent_start
pi.registerTool   ×8  — но 16 тулов (часть через registerGatedTool)
pi.exec           ×20 — 14× git, 3× bash, остальное rev-parse/cat-file и т.п.
pi.sendUserMessage ×9
pi.getActiveTools / pi.setActiveTools  — ensureGatedToolsActive (index.ts:1674)
pi.registerShortcut ×1, pi.registerCommand ×1 ("autoresearch"), pi.appendEntry ×1
pi.debug?         (используется опционально)
```

### 2.4 ctx (форма!)
```ts
// НЕ ctx.sessionId! Сессионный ключ:
const getSessionKey = (ctx) => ctx.sessionManager.getSessionId();   // index.ts:1656
// ctx.ui — 5 вызовов setWidget("autoresearch", ...), 1 notify (index.ts:1781,1881,...)
```

### 2.5 16 тулов
Гейтед (4, через `registerGatedTool` + `ensureGatedToolsActive`):
`init_experiment`, `propose_hypothesis`, `run_experiment`, `log_experiment`.
Остальные: `BestOfN`, `startPhase`, `commitPhase`, `abortPhase`, `valleyProbe`,
`CheckOrthogonal`, `SpaceSearch`, `explore_from`, `restore_main`, `tree_status`,
`compose`, `finalize_research`.

### 2.6 Диск-стейт (то, что моделирует State Machine)
```
.auto/
  config.json   — {"workingDir": "<abs>"}   (пишется на init)
  log.jsonl     — type:"config" (заголовок: name, metricName, metricUnit, bestDirection)
                  + entries эксперимента (type:"experiment", status, metric, ...)
  tree.json     — overlay: version, rootId, activeNodeId, nextId, baselineMetric,
                  direction, metricName, nodes{id,parentId,children,commit,metric,
                  hypothesis,status,asi,simhash,ideaId,depth,createdAt,exhausted,
                  nodeType}, savedBranches...
  prompt.md, measure.sh, checks.sh, ideas/, hooks/
```

### 2.7 Критические механики
- **run_experiment запускает команду через РЕАЛЬНЫЙ spawn** (`execBashScript`,
  index.ts ~499 — drop-in замена `pi.exec("bash", ...)`, резолвит Git Bash на
  Windows, НЕ через fake pi.exec). Возвращает `{stdout, stderr, code, killed}`.
  Параметры: `command`, `timeout_seconds` (обязательный), `bench_mode` → env
  `BENCH_MODE`, `hypothesis_id`, `checks_timeout_seconds` (пишет `.auto/checks.sh`
  если есть). Guard: если в `.auto/` есть measure.sh — требует гонять его, а не
  кастомную команду (index.ts ~2800).
- **log_experiment keep** → реальный git commit (`git add -A`,
  `git diff --cached --quiet`, `git commit -m`) через pi.exec; **discard/crash** →
  revert; **explore** → detached checkout. Статусы: keep|discard|crash|
  checks_failed|budget_exceeded|explore.
- **explore_from / restore_main** — git checkout по commit из tree.json.
- **Один config-заголовок**: init_experiment НЕ должен писать второй раз, если
  в log.jsonl уже есть config (логика в index.ts — инвариант для PBT!).
- **Побочный эффект на init**: `migrateAutoInstalledHook()` (index.ts:1637 →
  hooks.ts:352) читает/УДАЛЯЕТ `~/.pi/agent/autoresearch/hooks/before.sh`
  (через `os.homedir()`), если в файле есть маркер OBSERVER_VERSION.
  `resolveAutoresearchShortcuts()` (index.ts:1643 → shortcuts.ts) читает
  `~/.pi/agent/extensions/pi-autoresearch.json` (read-only). ⚠️ См. камень №8.
- **before_agent_start** (index.ts:2143) при autoresearchMode дописывает
  `event.systemPrompt + extra` в КОНЕЦ (index.ts:2255): «## Autoresearch Mode
  (ACTIVE)» + «## Experiment Protocol (MANDATORY)» + «## Parallel Toolkit
  (CURRENTLY DISABLED)».

---

## 3. Что переиспользовать из pi-agile

> Все пути — в `D:\Documents\Repositories\pi-agile` (донор). Исполнитель
> КОПИРУЕТ файлы в `tests/` pi-autoresearch. pi-agile не модифицируется
> (это зона владельца pi-agile).

### 3.1 Копируется as-is
| Источник | Что | Комментарий |
|---|---|---|
| `tests/typebox-stub.mjs` (32 стр.) | Proxy-стаб Typebox | пакет-агностик; `then` → undefined, `Symbol.toPrimitive` → "" |
| `tests/pbt.test.mjs:44` | `mulberry32` (seeded PRNG) | |
| `tests/pbt.test.mjs:56` | `genInt` / `genPick` | |
| `tests/pbt.test.mjs:61` | `forAll({seeds, maxActions, name, run})` | счётчики pass/fail |
| `tests/pbt.test.mjs:79` | `shrinkPrefix` | префикс-шринкинг на провале |
| `tests/fake-pi.ts:33` | `createEventBus` | |
| `tests/smoke.test.mjs` | паттерн `test(name, fn)` + `# Results` | харнесс переписать под свои нужды (сам файл целиком не копировать) |

### 3.2 Копируется с адаптацией
| Источник | Что | Адаптация |
|---|---|---|
| `tests/typebox-redirect-loader.mjs` (22 стр.) | resolve-hook | расширить: 4 пакета → стабы (мапа specifier → stub URL) |
| `tests/fake-pi.ts` (378 стр.) | скелет fake-pi | `makeCtx`: `sessionId` → `sessionManager.getSessionId()`; выкинуть bdTasks/worktrees/makeFakeUi; оставить active-tools модель, `_lastSystemPrompt`, `execCalls`; `exec` — под git-вызовы авторасёча (rev-parse, update-ref, add, diff --cached --quiet, commit, checkout, cat-file) ЛИБО реальный git в temp-репо (см. 4.4) |
| `tests/fake-pi.ts:83` | `createFakeBridge` | Протокол rpc СОВПАДАЕТ (`subagents:rpc:v1:request/reply:<id>`, проверено: parallel/rpc.ts:23-25) — нужен только для parallel-тулов (BestOfN и т.п.); в PBT v1 можно не включать |
| `tests/pbt.test.mjs:107` | `class RealSystem` | паттерн зеркала рантайма переносится, модель — своя (раздел 4) |
| `tests/pbt.test.mjs:567` | `checkInvariants` | структура (actionMsgs до проб, negative+positive) переносится, набор инвариантов — свой |

### 3.3 Только паттерн (переписывать по образцу)
- TDD-цикл: RED-тесты → фейл-драйв стабы → green.
- Env-оверрайд таймаутов/polling (в pi-agile: `PI_AGILE_POLL_INTERVAL_MS`).
  В pi-autoresearch polling-интервалов почти нет (run_experiment сам таймаутит),
  но если при PBT всплывёт медленный путь — вводить такой же env-override.
- Извлечение чистых модулей (pi-agile: continuation.ts/yaml.ts/git.ts/bd.ts) —
  здесь почти не нужно: `parallel/` уже чистый.
- PBT как детектор реальных багов (в pi-agile так поймали stale-file,
  double-retrospective, worktree-attach).

---

## 4. PBT State Machine — требования

### 4.1 Действия (реальные тулы/хуки через fake-pi)
Минимум для v1 (по образцу pi-agile PBT v2/v3):
1. `init` — реальный `init_experiment` (name, metric, unit, direction) в temp `.auto/`.
2. `propose` — реальный `propose_hypothesis` (дубликат → duplicate, force → override).
3. `run` — реальный `run_experiment` с тривиальной командой (`node -e ""`,
   `timeout_seconds: 1-5`), иногда с BENCH_MODE=quick.
4. `log(keep|discard|crash|explore)` — реальный `log_experiment` (в temp-репо с
   реальным git: keep → commit, discard/crash → revert, explore → detached).
5. `phaseStart/commit/abort` — реальные `startPhase/commitPhase/abortPhase`.
6. `explore/restore` — реальные `explore_from(nodeId)` / `restore_main()`.
7. `finalize` — реальный `finalize_research` (рекомендация/степень).
8. `agentEnd` / `beforeAgentStart` — реальные хуки `agent_end` / `before_agent_start`
   (observer-стиры, реконструкция состояния, systemPrompt).
9. `restart` — новая сессия (новый sessionId в `sessionManager`) — проверка
   восстановления (аналог `reconstructState` на `session_tree`).
10. `corruptLog` / `corruptTree` — порча файлов (устойчивость к torn-write).
11. `treeStatus` — реальный `tree_status`.

Действия выбираются seeded PRNG с весами (как `WEIGHTS` в pi-agile). Каждый
сценарий — СВОЙ sessionId (`pbt-${seed}-s${n}`), т.к. runtimeStore живёт в
процессе и персистит между сценариями (см. камень №7).

### 4.2 Инварианты (минимум)
- **P1** `log.jsonl` валиден после каждого действия (каждая строка — JSON).
- **P2** config-заголовок ЕДИНСТВЕННЫЙ: повторный `init` не дублирует `type:"config"`.
- **P3** дерево консистентно: дети только у keep-узлов; commit узла существует
  в git (в temp-репо); activeNodeId всегда валиден.
- **P4** keep → коммит на диске (HEAD изменился), discard/crash → revert
  (рабочее дерево вернулось), explore → detached.
- **P5** фазы: commitPhase коммитит цепочку; abortPhase откатывает к базе;
  бюджет фаз не уходит в минус.
- **P6** ≤1 finalize-стир на сессию (anti-spam observer).
- **P7** рестарт восстанавливает activeNodeId/remaining из `tree.json` +
  `log.jsonl` (reconstructState).
- **P8** run_experiment с `timeout_seconds` не вешается (crash → статус).
- **P9** observer-стиры правдивы (не лгут о статусе, аналог steer-truthfulness).
- **P10** коррапт-файлы не роняют следующий тул-вызов (деградация, не краш).

### 4.3 Smoke real-extension (node:test, в стиле существующих)
- регистрация: 16 тулов + 9 хуков + `/autoresearch` + шорткат;
- lifecycle e2e: `init → propose → run → log(keep)` → tree.json обновился,
  `log.jsonl` прирос;
- `log(discard)` после keep → revert;
- `before_agent_start` в autoresearchMode → в мутированном `_lastSystemPrompt`
  есть секция «Autoresearch Mode (ACTIVE)»; в не-agile/не-autoresearch режиме —
  промпт не меняется.

### 4.4 Открытые вопросы (решить исполнителю, зафиксировать в репорте)
- **Git в PBT**: реальный git в temp-репо (рекомендация — git-семантика это
  часть логики; pi-agile так и сделал в realGit-режиме) ЛИБО fake exec.
  При реальном git: каждый сценарий делает `git init` + первый коммит в temp
  дире. Осторожно: `log_experiment` использует `pi.exec` — fake pi.exec должен
  проксировать git-команды на реальный git (cwd → temp) ЛИБО заменить на
  `execBashScript`-подобный вызов — проверить, что делает `pi.exec` в prod.
- **observer-стиры**: hooks.ts дёргает `runObserver` на agent_end — в PBT
  проверять виртуальную передачу (sendUserMessage), а не чистую логику
  observer.ts (она уже покрыта).
- **Порядок systemPrompt**: pi-agile вынес роль В НАЧАЛО (до `<project_context>`);
  здесь секции дописываются в конец — это отдельное улучшение, НЕ входит в это
  ТЗ (только зафиксировать факт в репорте).

---

## 5. Вынос в отдельный пакет (ОПИСАНИЕ — делает владелец pi-agile, НЕ исполнитель)

> **Исполнитель по этому ТЗ пакет НЕ создаёт и НЕ ждёт.** Он копирует
> инфраструктуру из pi-agile read-only. Этот раздел — справка для
> оркестратора/владельца pi-agile, когда тот решит выносить.

### 5.1 Что и почему выносится
Инфраструктура дублируется: сейчас она лежит в `pi-agile/tests/`, по этому ТЗ
копируется в `pi-autoresearch/tests/`. Третье расширение (pi-slash, pi-rtk-
optimizer и т.д.) получит третью копию. Это кандидат на пакет:

| Компонент | Пакет | Обоснование |
|---|---|---|
| `mulberry32`, `genInt`, `genPick`, `forAll`, `shrinkPrefix`, счётчики pass/fail | `@fan92rus/pi-pbt` (чистый, БЕЗ pi-зависимостей) | PBT-ядро переиспользуемо в ЛЮБОМ JS/TS проекте |
| `typebox-stub.mjs` | в `pi-extension-testkit` | один и тот же Proxy для всех pi-расширений |
| redirect-loader (resolve-hook, конфигурируемая мапа пакет → стаб) | `pi-extension-testkit` | pi-agile: 1 пакет, pi-autoresearch: 4 — мапа растёт |
| `createEventBus` | `pi-extension-testkit` | |
| скелет fake-pi: `registerTool/on/exec/sendUserMessage/notify/appendEntry/debug`, active-tools модель, `_lastSystemPrompt`, `makeCtx` (с `sessionManager`), `createFakeBridge` (протокол `subagents:rpc:v1:*` — общий) | `pi-extension-testkit` | скелет общий, специфика (git-worktree, bd, wizard) — НЕ входит |
| тест-раннер (`test()` + `# Results`) | `pi-extension-testkit` | узкий, но общий |

### 5.2 Что НЕ выносится
- `RealSystem`-модели и инварианты (специфичны для каждого расширения);
- bd/git-worktree-бриджи, makeFakeUi (специфика pi-agile);
- сценарии/сиды (специфичны).

### 5.3 Нюансы выноса
- **Стратегия:** выносить ТОЛЬКО после того, как инфраструктура стабилизировалась
  в 2+ репозиториях (сейчас — 2-й раз; выносить можно сразу после этого ТЗ).
- **Риск №1 (главный):** стаб Typebox НЕЛЬЗЯ резолвить из `node_modules`
  приложения — jiti в проде решит его ПЕРВЫМ и сломает валидацию схем тулов.
  Пакет обязан поставлять redirect-loader/стабы как ОТДЕЛЬНЫЕ entry-points,
  подключаемые только через `--experimental-loader`/`module.register` в тестовом
  процессе. Проверить: `npm pack` + импорт из пакета в тесте.
- **Риск №2:** пакет с `type: "module"` + TS-исходники — тесты грузятся через
  `--experimental-strip-types`; стабы должны быть `.mjs` (не TS), чтобы не
  тащить сборку.
- **Риск №3:** версионирование API fake-pi — два потребителя (pi-agile,
  pi-autoresearch) с разными потребностями; версия 1.0 = только общий скелет.

---

## 6. Подводные камни (проверенные фактами)

1. **node 22.20: `--experimental-strip-types` + `--experimental-loader` работают
   вместе** (спайк сделан в pi-agile). Фолбэк: `--import` + `module.register`.
2. **Typebox-стаб**: callable Proxy; `then` → `undefined` (иначе `await` вечно
   висит); `Symbol.toPrimitive` → `""`. НЕ резолвить через node_modules.
3. **`import type` стираются** — стабов требуют только 4 runtime-импорта
   (index.ts:28-31) + `getAgentDir` (shortcuts.ts:1).
4. **`pi.exec` НЕ бросает** на ошибках git — возвращает `{code, stdout, stderr}`.
   Все проверки — по `code`. То же у `execBashScript`.
5. **`run_experiment` реально спавнит Git Bash** (на Windows первый вызов ~1.8с).
   В PBT: команды типа `node -e ""`, `timeout_seconds: 1-5`. НЕ запускать
   measure.sh/checks.sh-шаблоны в цикле (в pi-agile это вешало PBT на 240с).
6. **log_experiment keep делает РЕАЛЬНЫЙ git commit** — если идём по пути
   «реальный git в temp-репо», каждый сценарий: `git init`, настроить
   `user.name/user.email`, первый коммит; проверить, что `git add -A` в temp
   не подхватывает `.auto/` соседних тестов.
7. **runtimeStore персистит в процессе** — сценарии PBT обязаны иметь РАЗНЫЕ
   sessionId (`ctx.sessionManager.getSessionId()`), иначе состояние (activeNode,
   finalize-флаг, фазы) течёт между сценариями (в pi-agile: `pbt-${seed}-s${n}`).
8. **Побочный эффект на init расширения**: `migrateAutoInstalledHook()` может
   УДАЛИТЬ реальный `~/.pi/agent/autoresearch/hooks/before.sh` с маркером
   OBSERVER_VERSION; `resolveAutoresearchShortcuts()` читает реальный
   `~/.pi/agent/extensions/pi-autoresearch.json`. Меры: (а) проверить наличие
   файлов перед прогоном; (б) если нужно — стаб `getAgentDir` → temp и/или
   override `USERPROFILE`/`HOME` в бустрапе тестов ДО импорта index.ts;
   (в) зафиксировать решение в репорте. НЕ менять прод-код ради тестов без
   явной нужды.
9. **`ctx.ui.setWidget("autoresearch", ...)` ×5** — в fake-ctx сделать no-op
   (или recorder). `notify` — recorder. `appendEntry` — recorder.
10. **16 тулов, 8 registerTool** — в fake-pi `registerTool` пушить в массив,
    `getActiveTools/setActiveTools` — active-tools модель (как pi-agile), т.к.
    `ensureGatedToolsActive` реально дёргает setActiveTools на каждый вызов.
11. **Windows-специфика инструментов**: `edit`-тул глотает блоки с `${...}`
    (template literals) — использовать `ctx_edit`; bash heredoc ломает
    backslash-heavy JS — диагностические файлы писать через write tool;
    `grep -P` не работает; grep режет многострочные assert-сообщения (заменять
    `\n` на пробелы).
12. **Пакетный менеджер**: `packageManager: pnpm@10.28.2`, `engines: node>=22`,
    тип модуля — `"type": "module"`. Тестовый скрипт сейчас:
    `node --experimental-strip-types --test tests/*.test.mjs` — новый флаг
    лоадера добавляется сюда (как в pi-agile: `--experimental-loader
    ./tests/typebox-redirect-loader.mjs`).
13. **`BENCH_MODE`**: `run_experiment` принимает `bench_mode` и прокидывает в
    env команды. В PBT использовать `bench_mode: "quick"` — и зеркалить в
    инвариантах, что команда реально получила env (если нужен такой инвариант).
14. **observer.test.mjs уже покрывает чистую логику** — НЕ дублировать; PBT
    покрывает передачу стиров (sendUserMessage) и правдивость.
15. **`tree.json` — overlay над `log.jsonl`**: реконструкция состояния
    (`reconstructState` на `session_tree`) читает ОБА файла; коррапт одного не
    должен ронять восстановление (инвариант P10).
16. **Внешний репозиторий**: все команды — с явным `cwd = <pi-autoresearch>`;
    результат (тесты, правки) коммитится И пушится В pi-autoresearch (это
    внешний целевой репо, но результат должен быть там); не трогать ветки и
    историю, не относящиеся к задаче; не коммитить оркестрационные документы.

---

## 7. Этапы (TDD, каждый этап — зелёные тесты)

| Этап | Содержание | Приёмка |
|---|---|---|
| **0. Спайк** | стабы + redirect-loader (4 пакета); импорт реального `index.ts` под лоадером; fake-pi скелет; `npm test` не падает | импорт работает, 59 старых тестов зелёные |
| **1. fake-pi** | 16 тулов, 9 хуков, `/autoresearch`, шорткат; `sessionManager`; exec (git); ui/appendEntry | smoke: регистрация |
| **2. PBT v1 (ядро)** | действия init/propose/run/log/phase/explore/restore/finalize; инварианты P1-P8 | PBT зелёный, ≥20 сидов × ≥20 действий |
| **3. PBT v2 (хуки и восстановление)** | agent_end/before_agent_start/restart/corrupt; инварианты P9-P10 | PBT зелёный |
| **4. Smoke real-extension** | lifecycle e2e + порядок systemPrompt | smoke зелёный |
| **5. Репорт** | что найдено PBT (реальные баги — с фиксами ТОЛЬКО с тестами); решение по git-стратегии; решение по побочным эффектам на home; статус открытых вопросов 4.4 | репорт в корне pi-autoresearch (напр. `REPORT-pbt.md`) |

Прод-код менять только по необходимости (env-overrides, clearOutputFile-аналоги,
detect реальных багов) и ТОЛЬКО в TDD-цикле (RED → GREEN).

---

## 8. Definition of Done

- [ ] `npm test` зелёный в pi-autoresearch: старые 59 + новые smoke + PBT (цель: >150 всего).
- [ ] Реальный `index.ts` под PBT State Machine (не ре-имплементация логики в тестах).
- [ ] Инварианты ассертят реальный диск (`.auto/*`) и реальные сообщения (sendUserMessage).
- [ ] ≥10 инвариантов, ≥20 сидов × ≥20 действий в PBT.
- [ ] Smoke real-extension: регистрация 16 тулов + 9 хуков + lifecycle e2e.
- [ ] Не сломаны существующие 59 тестов.
- [ ] Побочные эффекты на реальный home-каталог исключены или зафиксированы.
- [ ] Найденные PBT реальные баги: либо исправлены (с тестами), либо заведены
      задачи в bd с воспроизведением.
- [ ] Репорт по открытым вопросам (раздел 4.4) в корне pi-autoresearch.
- [ ] Все результаты закоммичены и запушены В pi-autoresearch (внешний целевой репо);
      рабочее дерево чистое, коммиты по conventional commits.
- [ ] pi-agile НЕ модифицирован (read-only для исполнителя).
