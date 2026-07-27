# PRD: pi-agile

> Автономный Agile-движок для pi. Агент сам анализирует кодовую базу, заводит задачи, делегирует субагентам, ревьюит, рефлексирует и повторяет — в рамках заданных человеком ограничений.

---

## 1. Vision

**Проблема:** Существующие AI-кодинг-агенты хороши в точечных задачах, но не работают как **самоуправляемая команда**. Человек вынужден постоянно ставить задачи, проверять, перенаправлять. Нет системы, которая автономно улучшает кодовую базу спринт за спринтом.

**Решение:** pi-agile — расширение для pi, превращающее LLM-агента в автономного project owner + scrum master + tech lead. Агент:
- Сам находит, что улучшать (discovery)
- Сам создаёт задачи (в `bd` CLI)
- Сам делегирует worker-субагентам (до 5 параллельно)
- Сам проводит глубокое ревью (reviewer-субагент)
- Сам рефлексирует и учится (knowledge base)
- Сам решает, когда остановиться (опциональные stop criteria)

Человек задаёт направление один раз через setup wizard и запускает `/agile run`.

---

## 2. Target Users

- **Solo-developers** — хотят автономно улучшать legacy-проекты, технический долг, test coverage
- **Small teams** — хотят автоматического "ночного" ревью и рефакторинга
- **Open-source maintainers** — хотят автономно закрывать backlog из small issues

---

## 3. Key Features

### 3.1 Autonomous Sprint Loop

Система работает циклами (спринтами). Каждый спринт:
1. **Discovery** — анализ кодовой базы (linters, coverage, complexity, security, TODO scanning, agent code reading)
2. **Planning** — создание задач в `bd`, prioritization, scope selection
3. **Execution** — делегирование worker-субагентам (до 5 параллельно, feature branch per task)
4. **Review** — глубокое ревью reviewer-субагентом (architecture, correctness, security, performance, tests, constraints)
5. **Retrospective** — velocity, quality metrics, knowledge update

### 3.2 Bounded Autonomy (Constraints)

Человек задаёт ограничения в текстовом виде. **Агент сам оценивает соответствие** (не programmatic checks):
- **Pre-task:** агент читает proposed task + constraints → решает, создавать ли задачу
- **Post-task:** reviewer-агент читает git diff + constraints → решает, approve/rework

Ограничения включают: технические правила, архитектурные принципы, процессные требования, списки "не делать".

### 3.3 bd CLI Integration

`bd` — существующая CLI-утилита (Dolt-backed task tracker). pi-agile использует её как task backend:
- Discovery → `bd create`
- Planning → `bd ready`, `bd show`
- Execution → `bd update <id> --claim`
- Completion → `bd close <id>`

Зависимости между задачами управляются `bd`.

### 3.4 Optional Stop Criteria

Три режима работы:
- **Goal-driven:** остановка при достижении метрик (coverage ≥ 80%, lint errors = 0)
- **Budget-driven:** остановка после N спринтов (`max_sprints: 5`)
- **Continuous:** бесконечное улучшение до остановки человеком

Если stop criteria не заданы — система работает непрерывно.

### 3.5 Deep Review

Каждая задача проходит ревью по 6 измерениям:
1. Architecture — следует ли существующим паттернам
2. Correctness — edge cases, error handling, logic
3. Security — уязвимости
4. Performance — сложность алгоритмов
5. Tests — качество и покрытие
6. Constraints — соответствие правилам проекта

Ревью — fresh-context, read-only субагент. Результат: approved / rework (с action items) / blocked.

### 3.6 Persistent Knowledge Base

Накапливает знания между спринтами:
- **Lessons** — что обнаружено в ревью
- **Dead-ends** — провальные подходы (do_not_retry)
- **Patterns** — паттерны кодовой базы
- **Sprint summaries** — velocity, quality metrics

Используется для SimHash-дедупликации (не создавать уже сделанные задачи) и do_not_retry (не повторять провальные подходы).

### 3.7 Setup Wizard (pi skill)

`/agile setup` — интерактивный диалог:
1. Project goal
2. Scope (include/exclude areas)
3. Constraints (rules, principles, do_not_do)
4. Stop criteria (optional)
5. Review depth

Результат: `.agile/project.yaml` + `.agile/constraints.yaml`.

---

## 4. User Stories

### US-1: Setup
```
As a developer,
I want to run /agile setup,
answer 5 questions about my project,
and have the system ready to run.
```

### US-2: Autonomous run
```
As a developer,
I want to run /agile run,
and have the system autonomously:
  - discover issues in my codebase,
  - create tasks,
  - implement fixes,
  - review them,
  - repeat until goal is met,
without my intervention.
```

### US-3: Constraint enforcement
```
As a developer,
I want to specify "don't touch migrations/**",
and have the system NEVER create tasks
or merge changes that touch that path.
```

### US-4: Stop conditions
```
As a developer,
I want to say "stop when coverage reaches 80%",
and have the system stop automatically
when that goal is achieved.
```

### US5: Observability
```
As a developer,
I want to run /agile status,
and see the current sprint state:
  - how many tasks done/rework/blocked,
  - what's being worked on right now,
  - sprint velocity.
```

### US-6: Emergency stop
```
As a developer,
I want to press a key or run /agile stop,
and have the system finish current work
and halt gracefully.
```

### US-7: Continuous improvement
```
As a developer,
I want the system to learn from each sprint,
so that repeated mistakes (constraint violations,
failed approaches) don't happen again.
```

---

## 5. Success Metrics

| Metric | Target |
|---|---|
| Autonomy | После `/agile run` — ноль человеческих вмешательств до завершения спринта |
| Review quality | ≥90% approved tasks не требуют последующего человеческого ревью |
| Constraint compliance | 100% merged changes соответствуют constraints |
| Knowledge retention | Провальный подход не повторяется в следующих спринтах |
| Sprint velocity | ≥3 tasks completed per sprint (baseline) |

---

## 6. Non-Goals

- **Не replaces bd** — pi-agile использует bd как backend, не заменяет его
- **Не заменяет человеческое ревью для production-critical изменений** — это инструмент для автономного улучшения, не для final-mile review
- **Не работает с multiple repos одновременно** — один проект = один sprint loop
- **Не делает deploy/release** — только code changes до merge to main
- **Не генерирует гипотезы** — discovery основан на реальных findings (lint/coverage/security), не на догадках

---

## 7. Constraints & Assumptions

- **pi extension** — работает только внутри pi
- **bd CLI** — должен быть установлен и доступен
- **Git** — проект должен быть git-репозиторием
- **Analysis tools** — linters/coverage/semgrep должны быть установлены для discovery
- **Single project** — один sprint loop на проект
- **Max 5 workers** — ограничение параллельности

---

## 8. Out of Scope (v1)

- Multi-repo orchestration
- CI/CD pipeline integration
- Automated deployment
- Human-in-the-loop approval gates
- Semantic code search (RustDex) integration
- IDE integrations
- Custom analysis tools beyond standard linters
