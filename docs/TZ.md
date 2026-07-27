# ТЗ: pi-agile — Техническое задание

> Форк инфраструктуры pi-autoresearch, превращённый в автономный Agile-движок. Агент сам анализирует кодовую базу, создаёт задачи в `bd`, делегирует worker/reviewer субагентам, рефлексирует и повторяет.

---

## 0. Фундаментальный принцип

```
┌─────────────────────────────────────────────────────────┐
│  AGENT (LLM) — ВСЕ решения                              │
│                                                         │
│  • Читает discovery output → решает, какие задачи       │
│    создавать (с учётом constraints из system prompt)    │
│  • Вызывает bd create через tool calls                  │
│  • Читает knowledge (lessons, dead_ends) в контексте    │
│    → сам не повторяет провалы                           │
│  • После retrospective получает stop-check сообщение    │
│    → сам запускает метрики → сам решает stop/continue   │
├─────────────────────────────────────────────────────────┤
│  EXTENSION (TypeScript) — ТОЛЬКО инструменты            │
│                                                         │
│  • Запускает discovery (eslint, jest, semgrep, grep)    │
│  • Вызывает bd CLI (create, ready, claim, close)       │
│  • Git operations (branch, merge, diff, worktree)       │
│  • Делегирует worker/reviewer субагентов                │
│  • Управляет sprint state machine                       │
│  • Персистит knowledge.jsonl, sprint-N.json             │
│  • Загружает constraints/project текст → в системный    │
│    промпт и в промпты субагентов                        │
│  • Observer: мониторит thresholds → steers              │
│  • Формирует stop-check сообщение → отдаёт агенту       │
├─────────────────────────────────────────────────────────┤
│  BD CLI — task backend                                  │
└─────────────────────────────────────────────────────────┘
```

**Extension НЕ оценивает, НЕ фильтрует, НЕ валидирует.** Extension запускает инструменты, передаёт информацию, персистит данные. Все решения — за агентом.

**Constraints — это текст.** Не формальные критерии, не programmatic checks. Текст правил, который инъектируется в system prompt главного агента и в промпты worker/reviewer субагентов. Агент сам соблюдает и проверяет.

---

## 1. Архитектура

### 1.1 Трёхслойная модель

```
┌──────────────────────────────────────────────────────────┐
│  Слой 1: ОРКЕСТРАТОР (main agent + pi-agile extension)   │
│                                                          │
│  Sprint Loop:                                            │
│    discovery → agent creates tasks in bd → bd ready →    │
│    bd claim → delegate worker → delegate reviewer →      │
│    bd close → retrospective → stop-check → next sprint   │
│                                                          │
│  Команды:                                                │
│    /agile setup  — wizard (через pi skill)               │
│    /agile run    — запуск sprint loop                    │
│    /agile status — текущее состояние                     │
│    /agile stop   — graceful stop                         │
│    /agile config — настройки                             │
├──────────────────────────────────────────────────────────┤
│  Слой 2: TASK BACKEND (bd cli)                           │
│                                                          │
│  Хранение задач, зависимостей, приоритетов, статусов.    │
│  Оркестратор не хранит задачи — bd хранит.               │
├──────────────────────────────────────────────────────────┤
│  Слой 3: ПАМЯТЬ (.agile/)                                │
│                                                          │
│  project.yaml     — цель, scope, stop criteria           │
│  constraints.yaml — правила (текст, агент оценивает)     │
│  knowledge.jsonl  — lessons, dead-ends, patterns         │
│  sprint-N.json    — история спринта                      │
└──────────────────────────────────────────────────────────┘
```

### 1.2 Роли агентов

| Роль | Контекст | Доступ | Назначение |
|---|---|---|---|
| **Main agent** | Session context | Полный | Оркестратор: sprint loop, создание задач, stop-check |
| **Worker** | Fresh context | Feature branch (worktree) | Реализация одной задачи |
| **Reviewer** | Fresh context, read-only | Read git diff, constraints | Глубокое ревью |

### 1.3 Разделение ответственностей

| Задача | Кто делает | Как |
|---|---|---|
| Запуск linters, coverage, semgrep | Extension | ctx_shell команды |
| Парсинг discovery вывода → задачи | Agent | Читает tool output, reasoning |
| Создание задач | Agent | Вызывает bd create |
| Проверка constraints (pre-task) | Agent | Reasoning на основе текста из system prompt |
| Проверка constraints (post-task) | Reviewer agent | Reasoning на основе diff + constraints текста |
| Выбор sprint scope | Agent | Читает bd ready, reasoning |
| Review verdict | Reviewer agent | Reasoning на основе diff + checklist |
| Stop criteria check | Agent | Читает stop-check message, сам запускает метрики |
| Knowledge persistence | Extension | File I/O |

---

## 2. Структура репозитория

```
pi-agile/
├── extensions/
│   └── pi-agile/
│       ├── index.ts              # Главный модуль: команды, sprint loop, tools
│       ├── observer.ts           # Мониторинг здоровья спринта
│       ├── parallel/
│       │   ├── discovery.ts      # Multi-source codebase analysis (raw output)
│       │   ├── sprint.ts         # Sprint lifecycle state machine
│       │   ├── review.ts         # Review delegation to subagent
│       │   └── knowledge.ts      # Persistent memory I/O (.agile/knowledge.jsonl)
│       └── config-ui.ts          # /agile config UI
├── skills/
│   └── agile-setup/
│       └── SKILL.md              # Setup wizard
├── docs/
│   ├── PRD.md
│   └── TZ.md                     # Этот файл
├── package.json
└── README.md
```

### 2.1 Что переиспользуем из pi-autoresearch

| Компонент | Что берём | Адаптация |
|---|---|---|
| Observer pattern | Trigger system, state tracking, steers | Адаптировать triggers под sprint health |
| Config system | readConfig/writeConfig | Добавить project/constraints загрузку |
| Subagent dispatch | Worker/reviewer delegation | Без изменений |
| `config-ui.ts` | TUI config | Адаптировать под sprint config |

### 2.2 Что выкидываем

| Модуль | Причина |
|---|---|
| `simhash.ts` | Не нужен — агент сам распознаёт дубликаты |
| `tree.ts`, `ucb1.ts`, `treeview.ts`, `compose.ts` | bd заменяет task management |
| `run_experiment`, `log_experiment` | Benchmark-specific |
| `measure.sh`, noise floor, confidence | Нет единой метрики |
| `BestOfN`, `SpaceSearch`, `valleyProbe` | Benchmark-specific parallel search |
| `startPhase`, `commitPhase`, `abortPhase` | Transaction system не нужен |
| `propose_hypothesis` | Discovery заменяет |

---

## 3. Схемы данных

### 3.1 `.agile/project.yaml`

```yaml
project:
  name: "Auth module quality improvement"
  goal: >
    Improve code quality and test coverage of the authentication module.
    Fix all lint warnings, add unit tests for uncovered paths,
    and resolve security findings.

  # Scope: где работаем
  scope:
    include:
      - "src/auth/**"
      - "tests/auth/**"
    exclude:
      - "migrations/**"
      - "config/**"
      - ".github/workflows/**"

  # Stop criteria (ОПЦИОНАЛЬНО)
  # Может отсутствовать → continuous mode
  # ТЕКСТ для агента — агент сам запускает команды и решает
  stop_when:
    mode: any_of          # any_of | all_of
    conditions:
      - metric: coverage
        target: 80
        area: "src/auth/**"
        command: "npx jest --coverage --collectCoverageFrom='src/auth/**'"
        description: "Test coverage for auth module"
      - metric: lint_errors
        target: 0
        area: "src/auth/**"
        command: "npx eslint src/auth/ -f compact"
        description: "Zero lint errors in auth module"
      - metric: max_sprints
        target: 10

  review_depth: deep       # deep | standard
  max_workers: 5           # max parallel workers
  max_tasks_per_sprint: 10

  created: "2026-07-27"
  version: 1
```

**Важно:** `command` в stop_when — это подсказка агенту, какую команду запустить для проверки. Extension НЕ запускает эти команды автоматически. Агент читает условие, сам запускает команду (через свои инструменты), сам интерпретирует результат.

### 3.2 `.agile/constraints.yaml`

```yaml
# Текстовые правила — инъектируются в system prompt и worker/reviewer промпты.
# Агент оценивает соответствие, не programmatic checks.

rules:
  - id: no-breaking-api
    rule: "Public APIs must remain backward compatible"
  - id: require-tests
    rule: "All new and changed code must have tests"
  - id: max-loc
    rule: "Maximum 300 lines of code changed per task"
  - id: protected-paths
    rule: "Never touch files under migrations/, config/, or .github/workflows/"

architectural_principles:
  - "Prefer composition over inheritance"
  - "One responsibility per module"
  - "Errors must be typed, not bare strings"
  - "Dependency injection via constructor"

process:
  - "Every task must have clear acceptance criteria before implementation"
  - "Conventional commits only: feat:, fix:, refactor:, test:, docs:"
  - "Feature branches: feat/<task-id>"
  - "All changes must pass linting and type-checking"

do_not_do:
  - "Don't add new dependencies without explicit discussion"
  - "Don't refactor working code without tests in place"
  - "Don't change CI/CD pipeline configuration"
  - "Don't modify lockfiles directly"
```

**Как используется:** загружается как текст, целиком инъектируется в:
1. **System prompt** главного агента — чтобы всегда помнил
2. **Worker task prompt** — чтобы соблюдал при реализации
3. **Reviewer task prompt** — чтобы проверял при ревью

### 3.3 `.agile/knowledge.jsonl`

Формат: одна JSON-запись на строку.

```jsonl
{"type":"lesson","task_id":"bd-42","sprint":1,"ts":"2026-07-27T12:00:00Z","finding":"Auth middleware uses custom error classes, not standard Error"}
{"type":"dead_end","task_id":"bd-38","sprint":1,"ts":"2026-07-27T12:30:00Z","approach":"Tried regex-based input validation","reason":"Too slow for large inputs","do_not_retry":"Regex-based validation in hot paths"}
{"type":"pattern","sprint":2,"ts":"2026-07-27T15:00:00Z","finding":"All controllers use dependency injection via constructor and return Result<T, E>"}
{"type":"task_done","task_id":"bd-42","sprint":1,"ts":"2026-07-27T13:00:00Z","title":"Fix ESLint no-unused-vars in auth.ts","description":"Remove unused imports and variables"}
{"type":"sprint_summary","sprint":1,"ts":"2026-07-27T18:00:00Z","tasks_done":7,"tasks_rework":3,"tasks_blocked":1,"avg_review_rounds":1.4}
```

Типы записей:
- `lesson` — вывод из ревью (инъектируется в sprint planning context)
- `dead_end` — провальный подход (инъектируется в worker prompt как do_not_retry)
- `pattern` — паттерн кодовой базы (инъектируется в reviewer prompt)
- `task_done` — выполненная задача (инъектируется в sprint planning для контекста — агент видит, что уже сделано)
- `sprint_summary` — метрики спринта (для observer и velocity tracking)

### 3.4 `.agile/sprint-N.json`

```typescript
interface SprintState {
  id: number;
  goal: string;
  status: "planning" | "active" | "review" | "retrospective" | "done";

  tasks: {
    bd_id: string;
    title: string;
    status: "backlog" | "in_progress" | "in_review" | "done" | "rework" | "blocked";
    worker_run_id?: string;
    reviewer_run_id?: string;
    review_rounds: number;
    final_verdict?: "approved" | "blocked";
    branch: string;
  }[];

  started_at: string;
  completed_at?: string;
  velocity: {
    attempted: number;
    done: number;
    rework: number;
    blocked: number;
    avg_review_rounds: number;
  };

  retrospective?: {
    stop_criteria_met: boolean;
    stop_reason?: string;
  };
}
```

---

## 4. Sprint Lifecycle

### 4.1 Sprint Planning

```
1. EXTENSION запускает discovery
   ├── ctx_shell: eslint, jest, semgrep, grep TODO, scout subagent
   └── Возвращает RAW output всех источников

2. EXTENSION формирует tool output:
   ├── Raw discovery results
   ├── Constraints text (из constraints.yaml)
   ├── Lessons + dead_ends (из knowledge.jsonl)
   └── Existing tasks (из bd ready)

3. AGENT читает tool output
   ├── Разбирается, что из findings — реальные задачи
   ├── Проверяет (reasoning) соответствие constraints
   ├── Проверяет (reasoning) — не дубликаты ли (видит existing tasks + task_done entries)
   └── Вызывает bd create для каждой выбранной задачи

4. EXTENSION запускает sprint
   ├── bd ready → список задач
   ├── Агент выбирает scope (reasoning: приоритет + зависимости)
   └── Extension сохраняет sprint state (sprint-N.json)
```

**Ключевое:** extension НЕ фильтрует candidates, НЕ проверяет constraints, НЕ дедуплицирует. Всё делает агент через reasoning, видя весь контекст.

### 4.2 Sprint Execution

```typescript
async function executeSprint(workDir: string, sprint: SprintState, ctx: ExtensionAPI) {
  const maxWorkers = 5;

  while (sprint.hasPendingTasks()) {
    // Get up to maxWorkers independent tasks (no unmet dependencies in bd)
    const batch = sprint.getIndependentPendingTasks(maxWorkers);

    // PARALLEL delegation — each task gets its own worktree
    const results: Map<string, ReviewVerdict> = new Map();
    const workerPromises = batch.map(task => executeTask(workDir, task, ctx));
    const workerResults = await Promise.all(workerPromises);

    // Process results sequentially (merge order matters)
    for (let i = 0; i < batch.length; i++) {
      const task = batch[i];
      const result = workerResults[i];

      if (result.verdict === "approved") {
        // Merge to main — handle potential conflicts from prior merges
        try {
          await gitMergeToMain(workDir, task.branch);
          await runMainChecks(workDir); // lint + test on main
          await bdClose(task.bd_id);
          sprint.markDone(task);
        } catch (mergeError) {
          // Conflict or main is red — rebase and retry, or rework
          sprint.markRework(task, `Merge failed: ${mergeError}`);
        }
      } else if (result.verdict === "rework") {
        sprint.markRework(task, result.action_items);
        // Task stays in sprint for next rework round
      } else {
        // blocked
        sprint.markBlocked(task, result.reason);
        await bdUpdate(task.bd_id, { status: "blocked" });
      }
    }
  }
}

async function executeTask(workDir: string, task: SprintTask, ctx: ExtensionAPI): Promise<ReviewVerdict> {
  // 1. Claim in bd
  await bdClaim(task.bd_id);

  // 2. Create feature branch
  const branch = `feat/${task.bd_id}`;
  await gitCreateBranch(workDir, branch);

  // 3. DELEGATE to worker subagent (fresh context, worktree)
  const constraints = loadConstraintsText(workDir);
  const deadEnds = loadDeadEnds(workDir); // for do_not_retry injection
  const workerResult = await ctx.subagent({
    agent: "worker",
    context: "fresh",
    worktree: true,
    cwd: workDir,
    task: buildWorkerTask(task, constraints, deadEnds),
  });

  // 4. Get diff
  const diff = await gitDiff(workDir, `main...${branch}`);

  // 5. DELEGATE to reviewer subagent (fresh context, read-only)
  const patterns = loadPatterns(workDir); // from knowledge.jsonl
  const reviewResult = await ctx.subagent({
    agent: "reviewer",
    context: "fresh",
    task: buildReviewerTask(task, diff, constraints, patterns),
  });

  // 6. Persist lessons to knowledge.jsonl (extension handles I/O)
  if (reviewResult.lessons?.length) {
    appendKnowledge(workDir, reviewResult.lessons.map(l => ({
      type: "lesson", task_id: task.bd_id, finding: l,
    })));
  }

  return reviewResult; // { verdict, action_items, lessons }
}
```

**Concurrency note:** `Promise.all` запускает workers параллельно (каждый в своём worktree). Merge происходит последовательно в цикле обработки результатов. Если task-1 и task-2 меняли один файл, merge task-2 может конфликтовать — тогда rebase или rework.

### 4.3 Sprint Retrospective

```
1. EXTENSION вычисляет velocity из sprint state
   ├── done / rework / blocked counts
   ├── avg review rounds
   └── Сохраняет sprint_summary в knowledge.jsonl

2. EXTENSION формирует retrospective tool output:
   ├── Velocity metrics
   ├── List of completed tasks (for task_done entries)
   ├── Constraints violations summary (if reviewer reported any)
   └── Stop-check message (если stop_when задан)

3. AGENT читает retrospective output
   ├── Формулирует lessons (что узнал, что улучшить)
   ├── Записывает lessons/dead_ends через knowledge tool
   └── Читает stop-check message

4. STOP-CHECK (если stop_when задан)
   ├── Агент читает условия (текст из project.yaml)
   ├── Сам запускает метрик-команды (ctx_shell)
   ├── Сам интерпретирует результаты
   ├── Решает: критерии достигнуты?
   │   ├── ДА → останавливается (calling /agile stop or just not starting next sprint)
   │   └── НЕТ → продолжает (extension запускает next sprint)
```

**Ключевое:** stop criteria — НЕ автоматическая функция. Extension только формирует сообщение: «Sprint N complete. Stop criteria: coverage ≥ 80% (command: ...). Check if met.» Агент сам проверяет.

---

## 5. Модули

### 5.1 discovery.ts

Multi-source codebase analysis. Возвращает **сырой вывод**, не парсит.

```typescript
interface DiscoveryResult {
  lint: string;         // raw eslint/golangci-lint output (JSON or text)
  coverage: string;     // raw coverage summary
  complexity: string;   // raw complexity report
  todos: string;        // raw grep TODO/FIXME output
  security: string;     // raw semgrep output
  scout: string;        // raw scout subagent text findings
}

async function runDiscovery(workDir: string, scope: string[]): Promise<DiscoveryResult> {
  // Run all sources in parallel
  const [lint, coverage, complexity, todos, security, scout] = await Promise.all([
    runLinters(workDir, scope),
    runCoverage(workDir, scope),
    runComplexity(workDir, scope),
    scanTODOs(workDir, scope),
    runSecurityScan(workDir, scope),
    agentCodeReview(workDir, scope),
  ]);

  return { lint, coverage, complexity, todos, security, scout };
}

// Each source runs a shell command and returns RAW output.
// No parsing into structured candidates — agent parses.
async function runLinters(workDir: string, scope: string[]): Promise<string> {
  // Detect project type and run appropriate linter
  // Return raw stdout/stderr
}

async function agentCodeReview(workDir: string, scope: string[]): Promise<string> {
  // Delegate to scout subagent — reads code, returns freeform findings
  // Raw text returned, no parsing
}
```

**Discovery sources:**

| Source | Command (пример) | Возвращает |
|---|---|---|
| Lint | `npx eslint <scope> -f json` | Raw JSON output |
| Coverage | `npx jest --coverage --collectCoverageFrom=<scope>` | Raw coverage summary |
| Complexity | `npx ts-metrics <scope>` или `golangci-lint --enable gocyclo` | Raw report |
| TODO | `grep -rn "TODO\|FIXME\|HACK\|XXX" <scope>` | Raw grep output |
| Security | `semgrep scan --config p/auto <scope> --json` | Raw JSON output |
| Scout | Subagent reads code | Freeform text findings |

**Весь вывод идёт в tool output агенту.** Агент сам разбирает, что важно, и создаёт задачи.

### 5.2 Constraints loading (в index.ts, не отдельный модуль)

Constraints — текст. Загружается и инъектируется, не оценивается.

```typescript
function loadConstraintsText(workDir: string): string {
  const path = join(workDir, ".agile", "constraints.yaml");
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

// Используется при:
// 1. System prompt generation — вставляется целиком
// 2. buildWorkerTask() — вставляется в worker prompt
// 3. buildReviewerTask() — вставляется в reviewer prompt
```

Нет функций `checkPreTaskConstraints` или `checkPostTaskConstraints`. Constraints — текст в промпте.

### 5.3 review.ts

Deep review delegation.

```typescript
interface ReviewVerdict {
  status: "approved" | "rework" | "blocked";

  dimensions: {
    architecture: { score: number; issues: string[] };
    correctness:  { score: number; issues: string[] };
    security:     { score: number; issues: string[] };
    performance:  { score: number; issues: string[] };
    tests:        { score: number; issues: string[] };
    constraints:  { violations: string[] };
  };

  action_items: string[];
  lessons: string[];
  do_not_retry?: string;
}

async function reviewTask(workDir: string, task: SprintTask, ctx: ExtensionAPI): Promise<ReviewVerdict> {
  const diff = await gitDiff(workDir, `main...feat/${task.bd_id}`);
  const constraints = loadConstraintsText(workDir);
  const patterns = loadPatterns(workDir);

  // Delegate to reviewer subagent — fresh context, read-only
  const verdict = await ctx.subagent({
    agent: "reviewer",
    context: "fresh",
    task: buildReviewerTask(task, diff, constraints, patterns),
  });

  // Persist lessons (extension handles file I/O)
  if (verdict.lessons?.length) {
    appendKnowledge(workDir, verdict.lessons.map(l => ({
      type: "lesson", task_id: task.bd_id, finding: l,
    })));
  }

  return verdict;
}
```

### 5.4 sprint.ts

Sprint lifecycle state machine.

```typescript
class SprintLoop {
  private sprintNum = 0;
  private running = false;

  async start(workDir: string, ctx: ExtensionAPI) {
    this.running = true;
    while (this.running) {
      this.sprintNum++;

      // 1. PLAN — extension runs discovery, agent creates tasks
      const sprint = await this.planSprint(workDir, ctx);
      if (sprint.status === "done") break;

      // 2. EXECUTE — extension delegates workers + reviewers
      await this.executeSprint(workDir, sprint, ctx);

      // 3. RETROSPECTIVE — extension computes velocity, agent reflects
      const retroResult = await this.retrospective(workDir, sprint, ctx);

      // 4. STOP-CHECK MESSAGE — agent decides
      // retroResult содержит stop-check message
      // Agent читает его и решает: продолжать или нет
      // Если агент решает остановиться — он не запускает next sprint
      // Extension просто проверяет: если агент сказал "continue", loop повторяется
    }
    this.running = false;
  }

  stop() { this.running = false; }
}
```

### 5.5 knowledge.ts

Persistent memory I/O. Только файловые операции + форматирование для контекста.

```typescript
interface KnowledgeEntry {
  type: "lesson" | "dead_end" | "pattern" | "task_done" | "sprint_summary";
  task_id?: string;
  sprint?: number;
  ts: string;
  [key: string]: unknown;
}

class KnowledgeBase {
  // I/O
  load(workDir: string): void;
  save(workDir: string): void;
  append(entry: KnowledgeEntry): void;

  // Formatting for agent context — возвращает текст для промптов
  formatLessons(): string;      // для injection в sprint planning prompt
  formatDeadEnds(): string;     // для injection в worker prompt (do_not_retry)
  formatPatterns(): string;     // для injection в reviewer prompt
  formatDoneTasks(): string;    // для injection в sprint planning (agent видит что сделано)
}
```

Нет SimHash, нет программной дедупликации. Агент видит выполненные задачи (`task_done` entries) и existing bd tasks в контексте — сам решает, не дублировать.

### 5.6 observer.ts (adapted)

Мониторинг здоровья спринта. Адаптация observer.ts из autoresearch.

**Что остаётся:** trigger system pattern, state tracking, config-driven enable/disable, steer delivery.

**Sprint health triggers:**

| Trigger | Condition | Steer |
|---|---|---|
| `checkSprintStagnation` | Same task rework ≥ 3 | "Task stuck in rework loop. Consider blocking." |
| `checkAllBlocked` | All remaining tasks blocked | "Sprint exhausted — all remaining tasks blocked. End sprint." |
| `checkConstraintSpam` | Same constraint violated ≥ 3 times across tasks | "Constraint 'X' violated 3+ times. Workers may need clearer instructions." |
| `checkVelocityDrop` | Done rate dropped > 50% vs last sprint | "Velocity dropped. Check retrospective for root cause." |
| `checkDiscoveryEmpty` | Discovery found 0 new issues | "Discovery found nothing new. Project may be at goal." |

---

## 6. Команды и Tools

### 6.1 Команды (`/agile ...`)

| Команда | Назначение |
|---|---|
| `/agile setup` | Запускает pi skill `agile-setup` (wizard) |
| `/agile run` | Запускает sprint loop |
| `/agile status` | Показывает текущее состояние спринта |
| `/agile stop` | Graceful stop после завершения текущих задач |
| `/agile config` | Открывает config UI |

### 6.2 System Prompt

System prompt главного агента включает:

```
# pi-agile: Autonomous Sprint Engine

## Project Goal
{goal from project.yaml}

## Scope
Include: {include globs}
Exclude: {exclude globs}

## Constraints (MUST follow)
{constraints.yaml full text}

## Knowledge from Previous Sprints
Lessons: {formatLessons()}
Dead-ends: {formatDeadEnds()}

## Workflow
1. Read discovery output (lint, coverage, security findings)
2. Decide which findings should become tasks (respecting constraints + scope)
3. Create tasks via bd create
4. Sprint executes: worker implements → reviewer reviews
5. After retrospective, check stop criteria yourself
6. If stop criteria met → stop. If not → next sprint.

You make ALL decisions. Extension only runs tools and persists data.
```

### 6.3 bd CLI integration

pi-agile вызывает bd через `ctx_shell`:

```typescript
async function bdCreate(title: string, description: string, priority?: number): Promise<string> {
  const args = ["create", title, "--description", description];
  if (priority !== undefined) args.push("--priority", String(priority));
  const result = await ctxShell("bd", args);
  return parseBdId(result); // extract task ID from output
}

async function bdReady(): Promise<string> {
  // Returns raw bd ready output — agent reads it
  return await ctxShell("bd", ["ready"]);
}

async function bdClaim(taskId: string): Promise<void> {
  await ctxShell("bd", ["update", taskId, "--claim"]);
}

async function bdClose(taskId: string): Promise<void> {
  await ctxShell("bd", ["close", taskId]);
  await ctxShell("bd", ["dolt", "push"]);
}
```

### 6.4 Skill: agile-setup

```markdown
# skills/agile-setup/SKILL.md

---
triggers:
  - "setup agile"
  - "start agile project"
  - "configure pi-agile"
---

# Agile Project Setup

This skill guides the user through setting up a pi-agile project.

## Steps

1. **Project Goal**
   Ask: "What should the agent achieve?"
   (e.g., "Improve test coverage to 80%", "Fix all security findings")

2. **Scope**
   Ask: "What areas should it work on? What's off-limits?"
   Record include/exclude globs.

3. **Constraints**
   Ask: "What rules must be followed?"
   Record as text rules.

4. **Stop Criteria** (optional)
   Ask: "When should the agent stop?"
   Options: goal-driven (metrics), budget (max sprints), continuous.

5. **Review Depth**
   Ask: "How thorough should reviews be?"
   Options: deep (6 dimensions), standard (correctness + tests + constraints)

6. **Generate Config**
   Write .agile/project.yaml and .agile/constraints.yaml.

7. **Ready**
   Tell user: "Setup complete. Run /agile run to start."
```

---

## 7. Git Workflow

### Feature branch per task + trunk-based

```
main (trunk) ──────────●──────●──────●──────●──────●──
                        \     /\     /      /\     /
                         \   /  \   /      /  \   /
              feat/bd-42  ●    ●        ●    ●
                             bd-39      bd-40 bd-45
```

**Правила:**
1. Каждая задача → `feat/<bd-id>` branch
2. Worker работает в worktree (изолированный)
3. Merge в main только после approved review
4. main всегда green (тесты + lint)
5. Branch удаляется после merge
6. Merge strategy: squash merge (one commit per task)

**Main agent ответственность:**
- Создаёт branch перед delegate worker
- Делает merge после approved review
- Делает main green check (lint + test) после merge
- Если merge конфликт → rebase или rework

---

## 8. Subagent Contracts

### 8.1 Worker Task

```typescript
function buildWorkerTask(task: BdTask, constraints: string, deadEnds: string): string {
  return `# Task: ${task.title}

## Description
${task.description}

## Acceptance Criteria
${task.acceptance_criteria || "Change resolves the issue described above."}

## Project Constraints (MUST follow)
${constraints}

## Known Dead-Ends (do NOT repeat these approaches)
${deadEnds || "(none recorded yet)"}

## Instructions
1. Implement the change on this feature branch.
2. Follow existing code patterns.
3. Add or update tests for all changed code.
4. Ensure code passes linting and type-checking.
5. Commit with conventional commit format.
6. Do NOT merge to main — the orchestrator handles merge after review.

## Returns
Summary of changes made (files, approach, LOC).
`;
}
```

### 8.2 Reviewer Task

```typescript
function buildReviewerTask(
  task: SprintTask,
  diff: string,
  constraints: string,
  patterns: string,
): string {
  return `# Code Review: ${task.title}

## Task Description
${task.description}

## Git Diff
\`\`\`diff
${diff}
\`\`\`

## Project Constraints
${constraints}

## Known Codebase Patterns
${patterns || "(none recorded yet)"}

## Review Checklist
Score each dimension 1-5 and list issues:

1. **Architecture** — Does this follow existing patterns? Clean separation?
2. **Correctness** — Edge cases? Error handling? Logic errors?
3. **Security** — Vulnerabilities? Input validation?
4. **Performance** — Algorithmic complexity? Unnecessary allocations?
5. **Tests** — Meaningful coverage? Edge cases tested?
6. **Constraints** — Does the change comply with ALL project constraints?

## Verdict
Return ONE of:
- "approved" — change is ready to merge
- "rework" — change needs fixes (list action items)
- "blocked" — approach is fundamentally flawed (explain why)

Return as JSON:
{
  "status": "approved" | "rework" | "blocked",
  "dimensions": { ... },
  "action_items": [...],
  "lessons": [...],
  "do_not_retry": "..." (only if blocked)
}
`;
}
```

---

## 9. Observer — Sprint Health

### 9.1 State

```typescript
interface SprintObserverState {
  sprintNum: number;
  tasksAttempted: number;
  tasksDone: number;
  tasksRework: number;
  tasksBlocked: number;

  consecutiveReworks: Map<string, number>;  // taskId → count
  constraintViolations: Map<string, number>; // constraint text → count

  recentReviews: ReviewVerdict[];
  recentTaskStatuses: string[];
}
```

### 9.2 Triggers

| Trigger | Condition | Steer |
|---|---|---|
| `checkSprintStagnation` | Same task rework ≥ 3 | "Task stuck in rework loop. Consider blocking." |
| `checkAllBlocked` | All pending tasks blocked | "Sprint exhausted. End sprint." |
| `checkConstraintSpam` | Same constraint violated ≥ 3 | "Constraint violated 3+ times. Review worker instructions." |
| `checkVelocityDrop` | Done rate dropped > 50% vs last sprint | "Velocity dropped. Check retrospective." |
| `checkDiscoveryEmpty` | Discovery found 0 new issues | "Nothing new found. Project may be at goal." |

---

## 10. Stop Criteria

**Не автоматическая функция.** Extension формирует сообщение, агент решает.

### 10.1 Stop-check Message

После retrospective extension формирует:

```typescript
function buildStopCheckMessage(workDir: string, sprintNum: number): string {
  const project = loadProjectConfig(workDir);
  if (!project.stop_when) {
    return `Sprint ${sprintNum} complete. No stop criteria defined. Start next sprint.`;
  }

  const conditions = project.stop_when.conditions.map(c => {
    if (c.metric === "max_sprints") {
      return `- max_sprints: ${sprintNum} / ${c.target}`;
    }
    return `- ${c.metric}: target ${c.target} (${c.description})
  Check command: \`${c.command}\``;
  }).join("\n");

  return `Sprint ${sprintNum} complete.

## Stop Criteria Check
Mode: ${project.stop_when.mode}
Conditions:
${conditions}

Run the check commands yourself and decide if criteria are met.
If met → stop (do not start next sprint).
If not met → start next sprint.`;
}
```

### 10.2 Как это работает

1. Extension завершает retrospective
2. Extension формирует stop-check message
3. Extension отдаёт message как tool output агенту
4. **Агент читает условия**
5. **Агент сам запускает команды** (например `npx jest --coverage`) через свои инструменты
6. **Агент сам интерпретирует результаты**
7. **Агент сам решает:** критерии достигнуты?
   - ДА → агент останавливается (не запускает next sprint, вызывает `/agile stop` или просто завершает)
   - НЕТ → агент продолжает (extension запускает next sprint)

---

## 11. Implementation Phases

### Phase 0: Fork & Cleanup
- Fork pi-autoresearch → pi-agile
- Remove: simhash.ts, tree.ts, ucb1.ts, treeview.ts, compose.ts
- Remove: run_experiment, log_experiment, measure.sh, noise floor
- Remove: BestOfN, SpaceSearch, valleyProbe, phases
- Keep: observer pattern (adapt later), config system, subagent dispatch
- Rename package, update imports
- Verify esbuild compiles

### Phase 1: Core Infrastructure
- `knowledge.ts`: knowledge.jsonl read/write/append + format methods
- Config loaders: loadProjectConfig, loadConstraintsText
- `sprint.ts`: SprintState lifecycle, sprint-N.json persistence
- bd CLI integration layer (bdCreate, bdReady, bdClaim, bdClose)
- System prompt generation (goal + constraints + knowledge injection)

### Phase 2: Discovery
- `discovery.ts`: run all sources, return raw output
- Linter detection (eslint, golangci-lint)
- Coverage command runner
- TODO/FIXME grep
- Semgrep runner
- Scout subagent delegation

### Phase 3: Sprint Loop
- `/agile run`: SprintLoop.start()
- Sprint planning (discovery → tool output → agent creates tasks)
- Sprint execution (parallel worker dispatch + review + sequential merge)
- Sprint retrospective (velocity + stop-check message)
- `/agile status`, `/agile stop`

### Phase 4: Review System
- `review.ts`: reviewer subagent delegation
- Deep review prompt building (constraints + patterns injection)
- Verdict parsing
- Knowledge persistence (lessons from reviewer)

### Phase 5: Observer
- Adapt observer.ts triggers for sprint health
- Sprint stagnation, constraint spam, velocity drop, discovery empty

### Phase 6: Setup Skill
- `skills/agile-setup/SKILL.md`
- Interactive wizard
- Config file generation

### Phase 7: Polish
- Dashboard/widget (sprint status)
- Config UI
- Documentation
- README

---

## 12. Migration from pi-autoresearch

### Что копируем как-есть
- Config system (readConfig, writeConfig pattern)
- Subagent dispatch infrastructure
- esbuild setup

### Что адаптируем
- `observer.ts`: keep trigger pattern, replace metric triggers with sprint triggers
- `config-ui.ts`: replace experiment config with sprint config
- Extension registration: rename tools, commands

### Что НЕ копируем
- `simhash.ts` — не нужен (агент сам распознаёт дубликаты)
- Everything related to experiments, metrics, benchmarks
- tree.ts, ucb1.ts, treeview.ts, compose.ts
- run_experiment, log_experiment
- BestOfN, SpaceSearch, valleyProbe, phases
- measure.sh, noise floor, confidence scores

---

## 13. Open Questions

| # | Question | Default | Defer to implementation? |
|---|---|---|---|
| 1 | Exact bd CLI command syntax for `create`? | `bd create "title" --description "..."` | Yes — verify at runtime |
| 2 | How does agent detect available linters/coverage tools? | Probe package.json / go.mod | Yes |
| 3 | Worker self-assessment format? | Freeform text summary | Yes |
| 4 | How to handle merge conflicts between parallel workers? | Sequential merge, rebase if conflict, rework if still conflict | Yes |
| 5 | How does agent run stop-criteria check commands? | Via ctx_shell (bash) or ctx_call | Yes |

---

## 14. Test Plan

### Unit Tests
- `knowledge.ts`: load/save/append, format methods
- `sprint.ts`: lifecycle state transitions
- Config loaders: project.yaml + constraints.yaml parsing

### Integration Tests
- Discovery pipeline: mock shell outputs → raw DiscoveryResult
- bd integration: mock bd CLI → task lifecycle
- Review: mock reviewer verdict → sprint state transition

### End-to-End Test
- Setup project with known codebase (fixture)
- Run 1 sprint with max 3 tasks
- Verify: discovery ran, tasks created in bd, workers executed, reviews happened, knowledge persisted
- Verify: sprint completed, retrospective ran, stop-check message delivered
