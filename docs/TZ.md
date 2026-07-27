# ТЗ: pi-agile — Техническое задание

> Форк инфраструктуры pi-autoresearch, превращённый в автономный Agile-движок. Агент сам анализирует кодовую базу, создаёт задачи в `bd`, делегирует worker/reviewer субагентам, рефлексирует и повторяет.

---

## 1. Архитектура

### 1.1 Трёхслойная модель

```
┌──────────────────────────────────────────────────────────┐
│  Слой 1: ОРКЕСТРАТОР (main agent + pi-agile extension)   │
│                                                          │
│  Sprint Loop:                                            │
│    discovery → bd create → bd ready → bd claim →         │
│    delegate worker → delegate reviewer → bd close        │
│    → retrospective → next sprint (or stop)               │
│                                                          │
│  Команды:                                                │
│    /agile setup  — wizard (через pi skill)               │
│    /agile run    — запуск sprint loop                    │
│    /agile status  — текущее состояние                    │
│    /agile stop    — graceful stop                        │
│    /agile config  — настройки                            │
├──────────────────────────────────────────────────────────┤
│  Слой 2: TASK BACKEND (bd cli)                           │
│                                                          │
│  Хранение задач, зависимостей, приоритетов, статусов.    │
│  Оркестратор не хранит задачи — bd хранит.               │
│                                                          │
│  Команды (используемые pi-agile):                        │
│    bd create "title" --description "..." [--priority N]  │
│    bd ready [--area <glob>]                              │
│    bd show <id>                                          │
│    bd update <id> --claim                                │
│    bd update <id> --status <status>                      │
│    bd close <id>                                         │
│    bd dolt push                                          │
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
| **Main agent** | Session context | Полный | Оркестратор: sprint loop, discovery, planning, retrospective |
| **Worker** | Fresh context | Feature branch (worktree) | Реализация одной задачи |
| **Reviewer** | Fresh context, read-only | Read git diff, constraints | Глубокое ревью |

```
Main Agent (оркестратор)
│
├── ctx_shell: discovery tools (eslint, jest, semgrep...)
├── ctx_shell: bd cli commands
│
├── subagent({ agent: "worker", context: "fresh", worktree: true })
│   └── Получает: task description + constraints text + sprint context
│       Возвращает: self-assessment + summary of changes
│
└── subagent({ agent: "reviewer", context: "fresh" })
    └── Получает: git diff + constraints text + task description
        Возвращает: verdict (approved/rework/blocked) + action items + lessons
```

---

## 2. Структура репозитория

```
pi-agile/
├── extensions/
│   └── pi-agile/
│       ├── index.ts              # Главный модуль: команды, sprint loop
│       ├── observer.ts           # Мониторинг здоровья спринта
│       ├── parallel/
│       │   ├── simhash.ts        # Дедупликация задач (из autoresearch)
│       │   ├── discovery.ts      # Multi-source codebase analysis
│       │   ├── sprint.ts         # Sprint lifecycle
│       │   ├── review.ts         # Deep review delegation
│       │   └── knowledge.ts      # Persistent memory (.agile/knowledge.jsonl)
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

| Файл | Что берём | Адаптация |
|---|---|---|
| `simhash.ts` | 32-bit FNV1a SimHash, hammingDistance, computeSimhash | Без изменений — task dedup |
| Observer pattern | Trigger system, state tracking | Адаптировать triggers под sprint health |
| Config system | readConfig/writeConfig | Добавить constraints section |
| Subagent dispatch | Worker/reviewer delegation | Без изменений |
| `config-ui.ts` | TUI config | Адаптировать под sprint config |

### 2.2 Что выкидываем

| Модуль | Причина |
|---|---|
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
  stop_when:
    mode: any_of          # any_of | all_of
    conditions:
      - metric: coverage
        target: 80
        area: "src/auth/**"
        command: "npx jest --coverage --collectCoverageFrom='src/auth/**'"
        extract: "regex:All files.*?(\\d+\\.?\\d*)%"  # how to extract metric value
      - metric: lint_errors
        target: 0
        area: "src/auth/**"
        command: "npx eslint src/auth/ --format json"
        extract: "json:$.length"  # or errorCount
      - metric: max_sprints
        target: 10
  
  review_depth: deep       # deep | standard
  max_workers: 5           # max parallel workers
  max_tasks_per_sprint: 10
  
  created: "2026-07-27"
  version: 1
```

### 3.2 `.agile/constraints.yaml`

```yaml
# Текстовые правила — агент оценивает соответствие, не programmatic checks
rules:
  - id: no-breaking-api
    rule: "Public APIs must remain backward compatible"
    severity: block    # block | warn
  - id: require-tests
    rule: "All new and changed code must have tests"
    severity: block
  - id: max-loc
    rule: "Maximum 300 lines of code changed per task"
    severity: warn
  - id: protected-paths
    rule: "Never touch files under migrations/, config/, or .github/workflows/"
    severity: block

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

### 3.3 `.agile/knowledge.jsonl`

Формат: одна JSON-запись на строку.

```jsonl
{"type":"lesson","task_id":"bd-42","sprint":1,"ts":"2026-07-27T12:00:00Z","finding":"Auth middleware uses custom error classes, not standard Error","review_score":4}
{"type":"dead_end","task_id":"bd-38","sprint":1,"ts":"2026-07-27T12:30:00Z","approach":"Tried regex-based input validation","reason":"Too slow for large inputs (O(n*m))","do_not_retry":"Regex-based validation in hot paths"}
{"type":"pattern","sprint":2,"ts":"2026-07-27T15:00:00Z","finding":"All controllers in src/api/ use dependency injection via constructor and return Result<T, E>"}
{"type":"constraint_violation","task_id":"bd-45","sprint":2,"ts":"2026-07-27T16:00:00Z","constraint":"max-loc","detail":"Change was 450 LOC, limit is 300"}
{"type":"sprint_summary","sprint":1,"ts":"2026-07-27T18:00:00Z","tasks_done":7,"tasks_rework":3,"tasks_blocked":1,"avg_review_score":3.8,"top_constraint_violation":"max-loc"}
```

Поля:
- `type`: `lesson` | `dead_end` | `pattern` | `constraint_violation` | `sprint_summary`
- `task_id`: идентификатор задачи в bd (опционально)
- `sprint`: номер спринта
- `ts`: ISO timestamp
- Остальные поля зависят от type

### 3.4 `.agile/sprint-N.json`

```typescript
interface SprintState {
  id: number;                        // sprint number
  goal: string;                      // sprint-specific goal
  status: "planning" | "active" | "review" | "retrospective" | "done";
  
  // Tasks selected for this sprint
  tasks: {
    bd_id: string;
    title: string;
    status: "backlog" | "in_progress" | "in_review" | "done" | "rework" | "blocked";
    worker_run_id?: string;          // subagent run id
    reviewer_run_id?: string;
    review_rounds: number;           // how many rework cycles
    final_verdict?: "approved" | "blocked";
    branch: string;                  // feat/<task-id>
  }[];
  
  // Metrics
  started_at: string;
  completed_at?: string;
  velocity: {
    attempted: number;
    done: number;
    rework: number;
    blocked: number;
    avg_review_rounds: number;
  };
  
  // Retrospective
  retrospective?: {
    lessons: string[];
    dead_ends: string[];
    process_improvements: string[];
    stop_criteria_met: boolean;
    stop_reason?: string;
  };
}
```

---

## 4. Sprint Lifecycle — детально

### 4.1 Sprint Planning

```typescript
async function planSprint(workDir: string, sprintNum: number): Promise<SprintState> {
  // 1. DISCOVERY
  const candidates = await runDiscovery(workDir);
  //    ↓ discovery.ts: linters + coverage + complexity + TODO + semgrep + scout
  
  // 2. PRE-TASK CONSTRAINT CHECK
  const validTasks = [];
  for (const candidate of candidates) {
    const constraintResult = await checkPreTaskConstraints(workDir, candidate);
    //    ↓ agent reads candidate + constraints.yaml, decides
    if (constraintResult.approved) {
      validTasks.push(candidate);
    }
  }
  
  // 3. SIMHASH DEDUP
  const knowledge = loadKnowledge(workDir);
  const newTasks = validTasks.filter(t => !isDuplicate(t, knowledge));
  //    ↓ simhash.ts: compare against knowledge.jsonl lessons/dead_ends
  
  // 4. CREATE IN bd
  for (const task of newTasks) {
    await bd.create(task.title, task.description, task.priority);
  }
  
  // 5. SELECT SPRINT SCOPE
  const ready = await bd.ready(project.scope.include);
  const selected = selectSprintScope(ready, project.max_tasks_per_sprint);
  //    ↓ prioritize by bd priority + dependencies
  
  // 6. CHECK STOP CRITERIA
  if (project.stop_when) {
    const stopResult = await checkStopCriteria(workDir, project.stop_when);
    if (stopResult.met) {
      return { status: "done", stopReason: stopResult.reason };
    }
  }
  
  return { id: sprintNum, tasks: selected, status: "active" };
}
```

### 4.2 Sprint Execution

```typescript
async function executeSprint(workDir: string, sprint: SprintState) {
  const maxWorkers = project.max_workers;  // 5
  
  while (sprint.hasPendingTasks()) {
    // Get up to maxWorkers independent tasks (no unmet dependencies)
    const batch = sprint.getIndependentPendingTasks(maxWorkers);
    
    // PARALLEL delegation
    const results = await Promise.all(
      batch.map(task => executeTask(workDir, task))
    );
    
    // Process results
    for (const result of results) {
      if (result.verdict === "approved") {
        await mergeToMain(workDir, task.branch);
        await bd.close(task.bd_id);
        sprint.markDone(task);
      } else if (result.verdict === "rework") {
        sprint.markRework(task, result.actionItems);
        // Task stays in sprint for next rework round
      } else {
        sprint.markBlocked(task, result.reason);
        await bd.update(task.bd_id, { status: "blocked" });
      }
    }
  }
}

async function executeTask(workDir: string, task: Task): Promise<ReviewResult> {
  // 1. Claim in bd
  await bd.update(task.bd_id, { status: "claimed" });
  
  // 2. Create feature branch
  const branch = `feat/${task.bd_id}`;
  await git.createBranch(branch);
  
  // 3. DELEGATE to worker subagent (fresh context, worktree)
  const workerResult = await subagent({
    agent: "worker",
    context: "fresh",
    worktree: true,
    cwd: workDir,
    task: buildWorkerTask(task, constraints, sprintContext),
  });
  
  // 4. DELEGATE to reviewer subagent (fresh context, read-only)
  const diff = await git.diff(`main...${branch}`);
  const reviewResult = await subagent({
    agent: "reviewer",
    context: "fresh",
    task: buildReviewerTask(task, diff, constraints),
  });
  
  // 5. Return verdict
  return reviewResult;  // { verdict, actionItems, lessons }
}
```

### 4.3 Sprint Retrospective

```typescript
async function retrospective(workDir: string, sprint: SprintState) {
  // 1. Compute velocity
  sprint.velocity = {
    attempted: sprint.tasks.length,
    done: countByStatus(sprint.tasks, "done"),
    rework: countByStatus(sprint.tasks, "rework"),
    blocked: countByStatus(sprint.tasks, "blocked"),
    avg_review_rounds: avgReviewRounds(sprint.tasks),
  };
  
  // 2. Extract lessons from reviews
  const lessons = sprint.tasks
    .filter(t => t.review_lessons)
    .flatMap(t => t.review_lessons);
  
  // 3. Extract dead-ends from blocked tasks
  const deadEnds = sprint.tasks
    .filter(t => t.status === "blocked")
    .map(t => ({
      approach: t.title,
      reason: t.block_reason,
      do_not_retry: t.do_not_retry,
    }));
  
  // 4. Save to knowledge.jsonl
  const knowledge = loadKnowledge(workDir);
  knowledge.append(lessons.map(l => ({ type: "lesson", ...l, sprint: sprint.id })));
  knowledge.append(deadEnds.map(d => ({ type: "dead_end", ...d, sprint: sprint.id })));
  knowledge.append({ type: "sprint_summary", sprint: sprint.id, ...sprint.velocity });
  knowledge.save();
  
  // 5. Check stop criteria
  if (project.stop_when) {
    const stopResult = await checkStopCriteria(workDir, project.stop_when);
    if (stopResult.met) {
      sprint.retrospective = {
        stop_criteria_met: true,
        stop_reason: stopResult.reason,
        ...
      };
      return { shouldStop: true, reason: stopResult.reason };
    }
  }
  
  return { shouldStop: false };
}
```

---

## 5. Модули — детальный дизайн

### 5.1 discovery.ts

Multi-source codebase analysis → candidate tasks.

```typescript
interface DiscoveryCandidate {
  source: "lint" | "coverage" | "complexity" | "todo" | "security" | "agent";
  title: string;            // candidate task title
  description: string;      // details (file, line, issue)
  area: string;             // file glob
  priority: "high" | "medium" | "low";
  metadata?: Record<string, unknown>;
}

async function runDiscovery(workDir: string, scope: string[]): Promise<DiscoveryCandidate[]> {
  const candidates: DiscoveryCandidate[] = [];
  
  // Run all discovery sources in parallel
  const [lint, coverage, complexity, todos, security, agentFindings] = await Promise.all([
    runLinters(workDir, scope),         // eslint, golangci-lint
    runCoverage(workDir, scope),        // jest --coverage, go test -cover
    runComplexity(workDir, scope),      // complexity reporters
    scanTODOs(workDir, scope),          // grep TODO/FIXME
    runSecurityScan(workDir, scope),    // semgrep
    agentCodeReview(workDir, scope),    // scout subagent
  ]);
  
  candidates.push(...lint, ...coverage, ...complexity, ...todos, ...security, ...agentFindings);
  
  return candidates;
}
```

**Discovery sources:**

| Source | Command (example) | Output parsing |
|---|---|---|
| Lint | `npx eslint <scope> -f json` | `[{file, messages: [{rule, message, line, severity}]}]` |
| Coverage | `npx jest --coverage --collectCoverageFrom=<scope>` | coverage summary → uncovered lines |
| Complexity | `npx ts-metrics <scope>` или `golangci-lint run --enable gocyclo` | functions with complexity > threshold |
| TODO | `grep -rn "TODO\|FIXME\|HACK\|XXX" <scope>` | line + text |
| Security | `semgrep scan --config p/auto <scope>` | `[{check_id, path, start, end, extra.message}]` |
| Agent | Scout subagent reads code | Freeform findings |

**Agent code reading (scout subagent):**
```typescript
async function agentCodeReview(workDir: string, scope: string[]): Promise<DiscoveryCandidate[]> {
  // Delegate to scout subagent: read code in scope, find improvement opportunities
  const result = await subagent({
    agent: "scout",
    context: "fresh",
    task: `Read the code under ${scope.join(", ")}.
           Identify:
           - Code smells (long functions, duplicated logic, dead code)
           - Missing error handling
           - Potential refactorings
           - Architecture violations
           Return findings as a JSON array of {title, description, area, priority}.`,
  });
  return result;
}
```

### 5.2 constraints.ts (Agent-evaluated)

Constraints — текстовые правила. Агент оценивает соответствие, не programmatic checks.

```typescript
interface ConstraintCheckResult {
  approved: boolean;
  reason: string;
  violations?: string[];
}

// Pre-task: should this task be created?
async function checkPreTaskConstraints(
  workDir: string,
  candidate: DiscoveryCandidate,
): Promise<ConstraintCheckResult> {
  const constraints = loadConstraints(workDir);
  
  // Format constraint text for agent context
  const context = formatConstraintsForAgent(constraints);
  
  // Ask the main agent (in-flow) to evaluate
  // The agent reads candidate + constraints and decides
  return {
    approved: true/false,  // agent's decision
    reason: "...",         // agent's reasoning
  };
}

// Post-task: does this diff comply?
async function checkPostTaskConstraints(
  workDir: string,
  diff: string,
  taskId: string,
): Promise<ConstraintCheckResult> {
  // Similar: agent reads diff + constraints, decides
  // This is part of the reviewer's task, not separate
}
```

**Как работает на практике:**

Pre-task check встроен в sprint planning. Main agent получает:
1. Список discovery candidates
2. Текст constraints.yaml
3. Scope из project.yaml
И сам решает, какие candidates становятся bd tasks.

Post-task check встроен в review. Reviewer-субагент получает:
1. Git diff
2. Текст constraints.yaml
3. Task description
И сам решает approved/rework/blocked.

### 5.3 review.ts

Deep review delegation to reviewer-субагенту.

```typescript
interface ReviewRequest {
  task: {
    id: string;
    title: string;
    description: string;
    acceptance_criteria?: string[];
  };
  diff: string;                  // full git diff main...feat/<id>
  files_changed: string[];
  constraints: string;           // constraints.yaml full text
  sprint_context: string;        // goal + patterns from knowledge.jsonl
  project_patterns?: string;     // examples of existing code patterns
}

interface ReviewVerdict {
  status: "approved" | "rework" | "blocked";
  
  // Per-dimension scores and issues
  dimensions: {
    architecture: { score: 1-5; issues: string[] };
    correctness:  { score: 1-5; issues: string[] };
    security:     { score: 1-5; issues: string[] };
    performance:  { score: 1-5; issues: string [[[{ score: 1-5; issues: string[] };
    constraints:  { violations: string[] };
  };
  
  action_items: string[];        // concrete steps for rework
  lessons: string[];             // insights to persist in knowledge.jsonl
  do_not_retry?: string;         // if blocked, what approach failed
}

async function reviewTask(workDir: string, task: SprintTask): Promise<ReviewVerdict> {
  const diff = await getGitDiff(workDir, `main...feat/${task.bd_id}`);
  const constraints = readConstraintsText(workDir);
  const patterns = extractPatternsFromKnowledge(workDir);
  
  const verdict = await subagent({
    agent: "reviewer",
    context: "fresh",
    task: buildReviewerPrompt(task, diff, constraints, patterns),
  });
  
  // Persist lessons to knowledge.jsonl
  if (verdict.lessons?.length) {
    appendKnowledge(workDir, verdict.lessons.map(l => ({
      type: "lesson", task_id: task.bd_id, finding: l,
    })));
  }
  
  return verdict;
}
```

### 5.4 sprint.ts

Sprint lifecycle orchestrator.

```typescript
class SprintLoop {
  private sprintNum = 0;
  private running = false;
  
  async start(workDir: string) {
    this.running = true;
    while (this.running) {
      this.sprintNum++;
      
      // 1. PLAN
      const sprint = await this.planSprint(workDir);
      if (sprint.status === "done") {
        // Stop criteria met at planning time
        break;
      }
      
      // 2. EXECUTE
      await this.executeSprint(workDir, sprint);
      
      // 3. RETROSPECTIVE
      const retroResult = await this.retrospective(workDir, sprint);
      
      if (retroResult.shouldStop) {
        break;
      }
    }
    
    this.running = false;
  }
  
  stop() {
    this.running = false;
  }
}
```

### 5.5 knowledge.ts

Persistent memory management.

```typescript
interface KnowledgeEntry {
  type: "lesson" | "dead_end" | "pattern" | "constraint_violation" | "sprint_summary";
  task_id?: string;
  sprint?: number;
  ts: string;
  [key: string]: unknown;
}

class KnowledgeBase {
  private entries: KnowledgeEntry[] = [];
  
  load(workDir: string): void {
    const path = join(workDir, ".agile", "knowledge.jsonl");
    if (existsSync(path)) {
      this.entries = readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
    }
  }
  
  append(entry: KnowledgeEntry): void {
    entry.ts = new Date().toISOString();
    this.entries.push(entry);
  }
  
  save(workDir: string): void {
    const path = join(workDir, ".agile", "knowledge.jsonl");
    ensureParentDir(path);
    writeFileSync(path, this.entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  }
  
  // Get dead-ends for do_not_retry checking
  getDeadEnds(): DeadEnd[] {
    return this.entries
      .filter(e => e.type === "dead_end")
      .map(e => ({ approach: e.approach, do_not_retry: e.do_not_retry }));
  }
  
  // Get patterns for reviewer context
  getPatterns(): string[] {
    return this.entries
      .filter(e => e.type === "pattern")
      .map(e => e.finding);
  }
  
  // Get lessons for sprint planning context
  getLessons(sprint?: number): KnowledgeEntry[] {
    return this.entries.filter(e => 
      e.type === "lesson" && (!sprint || e.sprint === sprint)
    );
  }
  
  // Compute SimHash for dedup
  getSimHashes(): Map<string, number> {
    // Returns map of task description → simhash
    // Used by discovery to avoid re-creating completed tasks
  }
}
```

### 5.6 observer.ts (adapted)

Мониторинг здоровья спринта. Адаптация observer.ts из autoresearch.

**Что остаётся:**
- Trigger system pattern
- State tracking
- Config-driven enable/disable
- Steer delivery (pi.sendUserMessage)

**Что меняется:**

| Было (autoresearch) | Стало (pi-agile) |
|---|---|
| `checkStagnation` (metric streak) | `checkSprintStagnation` (no tasks done in N attempts) |
| `checkFloor` (metric plateau) | `checkSprintExhausted` (all remaining tasks blocked) |
| `checkParallelOpportunity` | `checkDependencyBlocked` (tasks blocked by deps) |
| `classifyStagnationPattern` | `classifySprintPattern` (velocity patterns) |
| `checkFinalize` | `checkStopCriteria` (from project.yaml) |
| metric-based triggers | task-count + review-score triggers |

**Sprint health triggers:**

| Trigger | Condition | Action |
|---|---|---|
| `checkSprintStagnation` | 3+ consecutive rework on same task | Steer: "Task is stuck in rework loop. Consider blocking." |
| `checkSprintExhausted` | All remaining tasks blocked | Steer: "Sprint exhausted — all remaining tasks blocked. End sprint." |
| `checkDependencyBlocked` | Task can't start (deps unmet) | Steer: "Task blocked by dependency. Reorder or unblock dependency." |
| `checkVelocityDrop` | Velocity dropped > 50% vs last sprint | Steer: "Velocity dropped. Retrospective may reveal why." |
| `checkConstraintViolation` | Same constraint violated 3+ times | Steer: "Constraint 'X' violated 3+ times. Add to do_not_retry." |

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

**`/agile status`** выводит:
```
🏃 Sprint #3 (active)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Goal: Fix lint warnings in auth module
Progress: 4/10 tasks done

📊 Velocity (this sprint):
   Done: 4    Rework: 2    Blocked: 0
   
🔄 In progress:
   • bd-42: Add rate limiting tests [Worker #2]
   • bd-45: Fix ESLint no-unused-vars [Reviewer]
   
✅ Done:
   • bd-38: Extract token validation
   • bd-39: Add unit tests for password hash
   • bd-40: Remove dead code in auth.ts
   • bd-41: Fix security finding: SQL injection

📈 Stop criteria:
   Coverage: 62% / 80% (not met)
   Lint errors: 3 / 0 (not met)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 6.2 bd CLI integration

pi-agile вызывает bd через `ctx_shell`:

```typescript
async function bdCreate(title: string, description: string, priority?: number) {
  const cmd = `bd create "${title.replace(/"/g, '\\"')}" --description "${description.replace(/"/g, '\\"')}"${priority ? ` --priority ${priority}` : ""}`;
  const result = await ctx_shell(cmd);
  return parseBdId(result);  // extract task ID from output
}

async function bdReady(scope?: string[]): Promise<BdTask[]> {
  const cmd = `bd ready${scope ? ` --area ${scope.join(",")}` : ""}`;
  const result = await ctx_shell(cmd);
  return parseBdTasks(result);
}

async function bdClaim(taskId: string) {
  await ctx_shell(`bd update ${taskId} --claim`);
}

async function bdClose(taskId: string) {
  await ctx_shell(`bd close ${id}`);
  await ctx_shell(`bd dolt push`);
}
```

### 6.3 Skill: agile-setup

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

3. **Constraints
   Ask: "What rules must be followed?"
   Record as text rules (the agent will evaluate compliance).

4. **Stop Criteria** (optional)
   Ask: "When should the agent stop?"
   Options: goal-driven (metrics), budget (max sprints), continuous.

5. **Review Depth**
   Ask: "How thorough should reviews be?"
   Options: deep (architecture + correctness + security + performance + tests + constraints)
            standard (correctness + tests + constraints)

6. **Generate Config Files**
   Write .agile/project.yaml and .agile/constraints.yaml.

7. **Ready**
   Tell user: "Setup complete. Run /agile run to start."
```

---

## 4. Git Workflow

### Feature branch per task + trunk-based

```
main (trunk) ──────────●──────●──────●──────●──────●──
                        \     /\     /      /\     /
                         \   /  \   /      /  \   /
              feat/bd-42  ●    ● bd-39    ●    ● bd-45
                             bd-38        bd-40
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
- Делает main green check (lint + test) после каждого merge
- Если main red → revert + mark task rework

**Worker:**
- Получает feature branch (worktree)
- Делает изменения только в branch
- Commit с conventional commit format
- Возвращает summary изменений

**Reviewer:**
- Fresh context, read-only
- Читает `git diff main...feat/<id>`
- Не делает изменений
- Возвращает verdict

---

## 8. Subagent Contracts

### 8.1 Worker Task

```typescript
// buildWorkerTask — формирует task string для worker-субагента

function buildWorkerTask(task: BdTask, constraints: string, context: SprintContext): string {
  return `# Task: ${task.title}

## Description
${task.description}

## Acceptance Criteria
${task.acceptance_criteria || "Change resolves the issue described above."}

## Project Constraints (MUST follow)
${constraints}

## Sprint Context
Goal: ${context.goal}
Sprint: ${context.sprintNum}

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
function buildReviewerTask(task: SprintTask, diff: string, constraints: string, patterns: string[]): string {
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
${patterns.join("\\n") || "(none recorded yet)"}

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

## 9. SimHash — Task Deduplication

Переиспользуем `simhash.ts` из autoresearch (без изменений).

**Использование:**
1. Discovery находит issue
2. Compute SimHash(candidate.title + candidate.description)
3. Compare against knowledge.jsonl entries (completed tasks)
4. If SimHash distance ≤ 3 → likely duplicate, skip
5. If > 3 → new task, create in bd

```typescript
function isDuplicate(candidate: DiscoveryCandidate, knowledge: KnowledgeBase): boolean {
  const candidateHash = computeSimhash(candidate.title + " " + candidate.description);
  
  for (const entry of knowledge.entries) {
    if (entry.type === "lesson" || entry.type === "dead_end") {
      const entryHash = entry.simhash;
      if (entryHash) {
        const distance = hammingDistance(candidateHash, entryHash);
        if (distance <= SIMHASH_LIKELY) {  // ≤ 3
          return true;
        }
      }
    }
  }
  return false;
}
```

---

## 10. Observer — Sprint Health

Адаптация observer.ts из autoresearch.

### 10.1 State

```typescript
interface SprintObserverState {
  sprintNum: number;
  tasksAttempted: number;
  tasksDone: number;
  tasksRework: number;
  tasksBlocked: number;
  
  consecutiveReworks: Map<string, number>;  // taskId → count
  constraintViolations: Map<string, number>; // constraintId → count
  
  recentReviews: ReviewVerdict[];           // last 10
  recentTaskStatuses: string[];             // last 10
}
```

### 10.2 Triggers

| Trigger | Condition | Steer |
|---|---|---|
| `checkSprintStagnation` | Same task rework ≥ 3 | "Task bd-42 stuck in rework loop. Consider blocking." |
| `checkAllBlocked` | All pending tasks blocked | "Sprint exhausted — all remaining tasks blocked. End sprint." |
| `checkConstraintSpam` | Same constraint violated ≥ 3 | "Constraint 'max-loc' violated 3+ times. Workers may need clearer instructions." |
| `checkVelocityDrop` | Done rate dropped > 50% vs last sprint | "Velocity dropped. Check retrospective for root cause." |
| `checkStopCriteria` | Stop criteria from project.yaml | "Stop criteria met: coverage 82% ≥ 80%. Ending." |
| `checkDiscoveryEmpty` | Discovery found 0 new issues | "Discovery found nothing new. Project may be at goal." |

---

## 11. Stop Criteria Check

После retrospective main agent получает сообщение проверить критерии завершения.

```typescript
interface StopCriteriaConfig {
  mode: "any_of" | "all_of";
  conditions: StopCondition[];
}

interface StopCondition {
  metric: string;       // "coverage" | "lint_errors" | "max_sprints" | custom
  target: number;
  area?: string;        // file glob
  command?: string;     // shell command to measure
  extract?: string;     // how to extract value from command output
}

async function checkStopCriteria(workDir: string, config: StopCriteriaConfig): Promise<StopResult> {
  const results = await Promise.all(
    config.conditions.map(cond => evaluateCondition(workDir, cond))
  );
  
  const met = config.mode === "any_of"
    ? results.some(r => r.met)
    : results.every(r => r.met);
  
  return {
    met,
    reason: met ? formatStopReason(results) : null,
    results,  // per-condition status
  };
}
```

**Evaluation:**
- `coverage`: run coverage command → extract % → compare ≥ target
- `lint_errors`: run lint command → extract error count → compare ≤ target (0)
- `max_sprints`: check sprintNum ≥ target
- Custom: run command → extract via regex/jsonpath → compare

---

## 12. Implementation Phases

### Phase 0: Fork & Cleanup (1-2 hours)
- Fork pi-autoresearch → pi-agile
- Remove benchmark-specific code (run_experiment, log_experiment, tree.ts, etc.)
- Keep simhash.ts, config system, subagent dispatch
- Rename package, update imports
- Verify esbuild compiles

### Phase 1: Core Infrastructure (3-4 hours)
- `knowledge.ts`: knowledge.jsonl read/write
- `constraints.ts`: load constraints.yaml, format for agent context
- `sprint.ts`: SprintState lifecycle, sprint-N.json persistence
- bd CLI integration layer
- Config system: .agile/project.yaml loading

### Phase 2: Discovery (2-3 hours)
- `discovery.ts`: multi-source analysis
- Lint parsing (ESLint JSON, golangci-lint)
- Coverage parsing (jest, go test)
- TODO/FIXME scanning
- Semgrep integration
- Scout subagent delegation for code reading

### Phase 3: Sprint Loop (3-4 hours)
- `/agile run`: SprintLoop.start()
- Sprint planning (discovery → pre-task check → bd create → scope select)
- Sprint execution (parallel worker dispatch + review)
- Sprint retrospective (velocity + knowledge update)
- Stop criteria check
- `/agile status`, `/agile stop`

### Phase 4: Review System (2-3 hours)
- `review.ts`: reviewer subagent delegation
- Deep review prompt building
- Verdict parsing
- Knowledge persistence (lessons, dead-ends)

### Phase 5: Observer (1-2 hours)
- Adapt observer.ts triggers for sprint health
- Sprint stagnation, constraint spam, velocity drop
- Stop criteria trigger

### Phase 6: Setup Skill (1 hour)
- `skills/agile-setup/SKILL.md`
- Interactive wizard
- Config file generation

### Phase 4: Polish (1-2 hours)
- Dashboard/widget (sprint status)
- Config UI
- Documentation
- README

---

## 13. Open Questions

| # | Question | Default | Defer to implementation? |
|---|---|---|---|
| 1 | Exact bd CLI command syntax for `create`? | `bd create "title" --description "..."` | Yes — verify at runtime |
| 2 | How to extract coverage % from different tools? | Regex per tool | Yes — tool-specific parsers |
| 3 | Worker self-assessment format? | Freeform text summary | Yes |
| завершения | How to handle merge conflicts between parallel workers? | Sequential merge, rebase if conflict | Yes |
| 5 | Squash merge vs regular merge? | Squash (1 commit per task) | Yes |

---

## 14. Migration from pi-autoresearch

### Что копируем как-есть
- `parallel/simhash.ts` (135 lines)
- Config system (readConfig, writeConfig pattern)
- Subagent dispatch infrastructure
- esbuild setup

### Что адаптируем
- `observer.ts`: keep trigger pattern, replace metric triggers with sprint triggers
- `config-ui.ts`: replace experiment config with sprint config
- Extension registration: rename tools, commands

### Что НЕ копируем
- Everything related to experiments, metrics, benchmarks
- tree.ts, ucb1.ts, treeview.ts, compose.ts
- run_experiment, log_experiment
- BestOfN, SpaceSearch, valleyProbe, phases
- measure.sh, noise floor, confidence scores

---

## 15. Test Plan

### Unit Tests
- `simhash.ts`: known hash values, hamming distance correctness
- `knowledge.ts`: load/save/append, dead-end retrieval
- `sprint.ts`: lifecycle state transitions
- `constraints.ts`: load + format

### Integration Tests
- Discovery pipeline: mock linter outputs → candidates
- bd integration: mock bd CLI → task lifecycle
- Review: mock reviewer verdict → sprint state transition
- Stop criteria: mock metric evaluation → stop decision

### End-to-End Test
- Setup project with known codebase (e.g., tree-test fixture)
- Run 1 sprint with max 3 tasks
- Verify: tasks created in bd, workers executed, reviews happened, knowledge persisted
- Verify: sprint completed, retrospective ran, stop criteria checked
