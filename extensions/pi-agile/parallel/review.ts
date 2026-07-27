/**
 * review.ts — Deep review delegation
 *
 * Delegates code review to a fresh-context reviewer subagent.
 * Returns a structured verdict — the agent acts on it (merge / rework / block).
 */

import { KnowledgeBase } from "./knowledge.ts";

export interface ReviewDimension {
  score: number; // 1-5
  issues: string[];
}

export interface ReviewVerdictResult {
  status: "approved" | "rework" | "blocked";
  dimensions: {
    architecture?: ReviewDimension;
    correctness?: ReviewDimension;
    security?: ReviewDimension;
    performance?: ReviewDimension;
    tests?: ReviewDimension;
    constraints?: { violations: string[] };
  };
  action_items: string[];
  lessons: string[];
  do_not_retry?: string;
}

/**
 * Build the reviewer prompt.
 * Constraints and patterns are injected as text — reviewer agent evaluates compliance.
 */
export function buildReviewerTask(
  taskTitle: string,
  taskDescription: string,
  diff: string,
  constraints: string,
  patterns: string,
  reviewDepth: "deep" | "standard" = "deep",
): string {
  const deepDimensions = `1. **Architecture** — Does this follow existing patterns? Clean separation of concerns?
2. **Correctness** — Edge cases? Error handling? Logic errors?
3. **Security** — Vulnerabilities? Input validation? Injection risks?
4. **Performance** — Algorithmic complexity? Unnecessary allocations?
5. **Tests** — Meaningful coverage? Edge cases tested?
6. **Constraints** — Does the change comply with ALL project constraints?`;

  const standardDimensions = `1. **Correctness** — Edge cases? Error handling? Logic errors?
2. **Tests** — Coverage for changed code?
3. **Constraints** — Does the change comply with ALL project constraints?`;

  const dimensions = reviewDepth === "deep" ? deepDimensions : standardDimensions;

  return `# Code Review: ${taskTitle}

## Task Description
${taskDescription}

## Git Diff
\`\`\`diff
${diff}
\`\`\`

## Project Constraints
${constraints || "(none specified)"}

## Known Codebase Patterns
${patterns || "(none recorded yet)"}

## Review Checklist
Score each dimension 1-5 and list issues:

${dimensions}

## Verdict
Return ONE of:
- "approved" — change is ready to merge
- "rework" — change needs fixes (list specific action items)
- "blocked" — approach is fundamentally flawed (explain why)

Return your review as a JSON object:
\`\`\`json
{
  "status": "approved" | "rework" | "blocked",
  "dimensions": {
    "architecture": { "score": 1-5, "issues": ["..."] },
    "correctness": { "score": 1-5, "issues": ["..."] },
    "security": { "score": 1-5, "issues": ["..."] },
    "performance": { "score": 1-5, "issues": ["..."] },
    "tests": { "score": 1-5, "issues": ["..."] },
    "constraints": { "violations": ["..."] }
  },
  "action_items": ["specific actionable fixes"],
  "lessons": ["insights about the codebase for future tasks"],
  "do_not_retry": "..." 
}
\`\`\`
If "blocked", explain the fundamental flaw in action_items.
If "rework", do_not_retry is optional.
If "approved", lessons can still be recorded.`;
}

/**
 * Parse the reviewer subagent's text response into a ReviewVerdictResult.
 * First extracts the explicit text verdict (## Verdict: approved/rework/blocked),
 * then enriches with JSON fields (dimensions, action_items, lessons) when available.
 */
export function parseReviewVerdict(responseText: string): ReviewVerdictResult {
  // 1. Extract verdict from explicit text markdown line first
  const verdictLine = responseText.match(/##\s*Verdict\s*:?\s*\*{0,2}(approved|rework|blocked)\*{0,2}/i);
  const textStatus = verdictLine ? verdictLine[1].toLowerCase() as "approved" | "rework" | "blocked" : undefined;

  // 2. Try to find a JSON block for structured fields (dimensions, action_items, lessons)
  //    IMPORTANT: prefer the SHALLOWEST/outermost ```json block, not nested acceptance-report
  const outerJsonMatch = responseText.match(/^```json\s*\{/m);
  let jsonMatch: RegExpMatchArray | null;
  if (outerJsonMatch) {
    // Found a ```json block at line start — match until its closing ```
    jsonMatch = responseText.match(/```json\s*([\s\S]*?)```/);
  } else {
    // Fall back to any ```json block or bare object
    jsonMatch = responseText.match(/```json\s*([\s\S]*?)```/) ?? responseText.match(/\{[\s\S]*\}/);
  }
  const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : null;

  let parsedJson: Record<string, unknown> | null = null;
  if (jsonStr) {
    try {
      parsedJson = JSON.parse(jsonStr.trim());
    } catch { /* ignore parse failures */ }
  }

  // 3. Determine status: prefer text verdict, fall back to JSON status
  let status: "approved" | "rework" | "blocked";
  if (textStatus) {
    status = textStatus;
  } else if (parsedJson && parsedJson.status === "approved") {
    status = "approved";
  } else if (parsedJson && parsedJson.status === "blocked") {
    status = "blocked";
  } else {
    // Last resort: text heuristic
    const lower = responseText.toLowerCase();
    if (lower.includes("approved") || lower.includes("lgtm")) status = "approved";
    else if (lower.includes("blocked") || lower.includes("fundamentally")) status = "blocked";
    else status = "rework";
  }

  return {
    status,
    dimensions: (parsedJson?.dimensions as Record<string, unknown>) ?? {},
    action_items: Array.isArray(parsedJson?.action_items) ? parsedJson.action_items : [],
    lessons: Array.isArray(parsedJson?.lessons) ? parsedJson.lessons : [],
    do_not_retry: typeof parsedJson?.do_not_retry === "string" ? parsedJson.do_not_retry : undefined,
  };
}

/** Build task text for a chain agent (scout, researcher, planner, etc.) */
export function buildChainAgentTask(
  agent: string,
  taskTitle: string,
  taskDescription: string,
  acceptanceCriteria: string | undefined,
  constraints: string,
  patterns: string,
  chainContext: { agent: string; output: string }[],
): string {
  const priorContext = chainContext.length > 0
    ? "\n## Previous Chain Steps Output\n" + chainContext.map(c =>
        `### ${c.agent}\n${c.output}\n`
      ).join("\n---\n")
    : "";

  const prompts: Record<string, string> = {
    scout: `You are a codebase scout. Your task is to EXPLORE the codebase and understand the relevant code for this task.

## Instructions
1. Find the key files and functions related to the task
2. Map the dependencies and data flow
3. Identify existing patterns, conventions, and risks
4. Do NOT write code — only explore and report
5. Be specific: file paths, function names, line numbers

Return a structured report with sections:
- Files to modify (with specific locations)
- Key functions/classes to understand
- Dependencies and data flow
- Potential risks and pitfalls
- Recommended approach (high-level)`,

    researcher: `You are a technical researcher. Your task is to research best practices, APIs, and patterns relevant to this task.

## Instructions
1. Search for relevant documentation, APIs, and patterns
2. If this is a new technology or library, find its documentation
3. Recommend concrete approaches based on research
4. Do NOT write code — only research and recommend

Return a structured report with sections:
- Research findings
- Recommended approach
- Relevant documentation links or references`,

    planner: `You are a technical planner. Your task is to decompose this task into concrete implementation steps.

## Instructions
1. Break down the task into sequential sub-steps
2. For each step, specify: files, approach, edge cases
3. Estimate complexity: simple | medium | hard
4. Do NOT write code — only plan

Return a structured plan with sections:
- Step-by-step breakdown
- Files to modify per step
- Edge cases and testing approach`,
  };

  return `# Chain Agent: ${agent}
## Task: ${taskTitle}
## Description
${taskDescription}
## Acceptance Criteria
${acceptanceCriteria ?? "Change resolves the issue described above."}
## Project Constraints (MUST follow)
${constraints || "(none specified)"}
## Known Codebase Patterns
${patterns || "(none recorded yet)"}${priorContext}

${prompts[agent] ?? `You are a ${agent} agent supporting this task. Explore the codebase and provide relevant context for the next agent.`}

Return your findings as structured text. Be specific: file paths, function names, concrete recommendations.`;
}

/**
 * Build the worker task prompt.
 * Constraints and dead-ends injected as text.
 */
export function buildWorkerTask(
  taskTitle: string,
  taskDescription: string,
  acceptanceCriteria: string | undefined,
  constraints: string,
  patterns: string,
  deadEnds: string,
  feedback?: string,
  chainContext?: { agent: string; output: string }[],
): string {
  const ctx = chainContext && chainContext.length > 0
    ? "\n## Prior Analysis (from chain agents)\n" + chainContext.map(c =>
        `### ${c.agent} Output\n${c.output}\n`
      ).join("\n---\n") + "\n"
    : "";

  return `# Task: ${taskTitle}

## Description
${taskDescription}

## Acceptance Criteria
${acceptanceCriteria ?? "Change resolves the issue described above."}

## Project Constraints (MUST follow)
${constraints || "(none specified)"}
## Known Codebase Patterns (follow these)
${patterns || "(none recorded yet)"}

## Known Dead-Ends (do NOT repeat these approaches)
${deadEnds || "(none recorded yet)"}
${ctx}${feedback ? "## Rework Feedback (from previous review)\n" + feedback + "\n" : ""}
## Instructions
1. Implement ONLY the change needed to satisfy the acceptance criteria.
2. Follow existing code patterns and conventions.
3. Add or update tests for ALL changed code.
4. Run the tests to verify your code works.
5. **IMPORTANT: Commit your changes**
   - \`git add -A && git commit -m "feat: <description of change>"\`
   - Use conventional commit format (feat:, fix:, refactor:, test:, docs:).
   - Only commit the files you changed for this task.
   - Do NOT merge to main — the orchestrator handles merge after review.
6. Do NOT modify files outside the project scope.
7. Keep changes minimal — no refactoring beyond what the task requires.
8. Do NOT close the bd task (bd close) — the orchestrator does that after merge.

## Returns
Return a summary of changes made: files modified, approach taken, lines of code.`;
}
