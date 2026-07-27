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
 * Best-effort: extract JSON from the response text.
 */
export function parseReviewVerdict(responseText: string): ReviewVerdictResult {
  // Try to find a JSON block in the response
  const jsonMatch = responseText.match(/```json\s*([\s\S]*?)```/) ?? responseText.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : responseText.trim();

  try {
    const parsed = JSON.parse(jsonStr.trim());
    return {
      status: parsed.status === "approved" ? "approved" : parsed.status === "blocked" ? "blocked" : "rework",
      dimensions: parsed.dimensions ?? {},
      action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
      lessons: Array.isArray(parsed.lessons) ? parsed.lessons : [],
      do_not_retry: typeof parsed.do_not_retry === "string" ? parsed.do_not_retry : undefined,
    };
  } catch {
    // Fallback: if JSON parsing fails, infer from text
    const lower = responseText.toLowerCase();
    let status: "approved" | "rework" | "blocked" = "rework";
    if (lower.includes("approved") || lower.includes("lgtm")) status = "approved";
    if (lower.includes("blocked") || lower.includes("fundamentally")) status = "blocked";

    return {
      status,
      dimensions: {},
      action_items: [responseText.slice(0, 500)],
      lessons: [],
    };
  }
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
  deadEnds: string,
): string {
  return `# Task: ${taskTitle}

## Description
${taskDescription}

## Acceptance Criteria
${acceptanceCriteria ?? "Change resolves the issue described above."}

## Project Constraints (MUST follow)
${constraints || "(none specified)"}

## Known Dead-Ends (do NOT repeat these approaches)
${deadEnds || "(none recorded yet)"}

## Instructions
1. Implement ONLY the change needed to satisfy the acceptance criteria.
2. Follow existing code patterns and conventions.
3. Add or update tests for ALL changed code.
4. Verify your code works: run linting and tests before committing.
5. Commit with conventional commit format (feat:, fix:, refactor:, test:, docs:).
6. Do NOT merge to main — the orchestrator handles merge after review.
7. Do NOT modify files outside the project scope.
8. Keep changes minimal — no refactoring beyond what the task requires.

## Returns
Return a summary of changes made: files modified, approach taken, lines of code.`;
}
