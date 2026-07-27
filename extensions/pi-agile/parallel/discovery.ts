/**
 * discovery.ts — Multi-source codebase analysis
 *
 * Returns RAW output from all discovery sources.
 * Extension DOES NOT parse into structured candidates.
 * The agent reads the raw output and decides what tasks to create.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

export interface DiscoveryResult {
  lint: string;
  coverage: string;
  complexity: string;
  todos: string;
  security: string;
  scout: string;
}

/** Try running a command with a timeout. Returns stdout on success, or error text on failure. */
function tryExecSync(cmd: string, workDir: string, timeoutMs = 30_000): string {
  try {
    return execSync(cmd, { cwd: workDir, timeout: timeoutMs, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  } catch (e: unknown) {
    if (e && typeof e === "object" && "stdout" in e) {
      return String((e as { stdout: string }).stdout);
    }
    return `[discovery error] ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Detect if a package.json exists and what linter/coverage tools are available. */
function detectProjectTools(workDir: string): { hasEslint: boolean; hasJest: boolean; hasTypeScript: boolean } {
  const pkgPath = path.join(workDir, "package.json");
  if (!fs.existsSync(pkgPath)) return { hasEslint: false, hasJest: false, hasTypeScript: false };

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    return {
      hasEslint: !!deps.eslint || !!deps["@eslint/js"],
      hasJest: !!deps.jest || !!deps.vitest || !!deps["@jest/core"],
      hasTypeScript: !!deps.typescript || !!deps.tsx,
    };
  } catch {
    return { hasEslint: false, hasJest: false, hasTypeScript: false };
  }
}

function buildScopeGlobs(scope: string[]): string {
  return scope.map((s) => `"${s}"`).join(" ");
}

async function runLinters(workDir: string, scope: string[]): Promise<string> {
  const tools = detectProjectTools(workDir);
  const output: string[] = [];

  if (tools.hasEslint) {
    const scopeStr = buildScopeGlobs(scope);
    output.push(`--- ESLint (${scopeStr}) ---`);
    output.push(tryExecSync(`npx eslint ${scopeStr} -f compact 2>&1 || true`, workDir));
  }

  // Check for golangci-lint
  if (fs.existsSync(path.join(workDir, "go.mod"))) {
    output.push("--- golangci-lint ---");
    output.push(tryExecSync("golangci-lint run ./... 2>&1 || true", workDir));
  }

  return output.join("\n") || "(no linter found)";
}

async function runCoverage(workDir: string, scope: string[]): Promise<string> {
  const tools = detectProjectTools(workDir);

  if (tools.hasJest) {
    const scopeStr = buildScopeGlobs(scope);
    return tryExecSync(`npx jest --coverage --collectCoverageFrom="${scopeStr}" --coverageReporters=text-summary 2>&1 || true`, workDir, 120_000);
  }

  if (fs.existsSync(path.join(workDir, "go.mod"))) {
    return tryExecSync("go test -cover ./... 2>&1 || true", workDir, 120_000);
  }

  return "(no coverage tool found)";
}

async function runComplexity(workDir: string, _scope: string[]): Promise<string> {
  if (fs.existsSync(path.join(workDir, "go.mod"))) {
    return tryExecSync("golangci-lint run --enable gocyclo ./... 2>&1 || true", workDir);
  }
  return "(no complexity analyzer found)";
}

async function scanTODOs(workDir: string, scope: string[]): Promise<string> {
  // Cross-platform TODO scanning using Node.js (no grep dependency)
  const extensions = [".ts", ".js", ".jsx", ".tsx", ".go", ".py", ".rs", ".java", ".rb", ".php", ".c", ".cpp", ".h"];
  const patterns = ["TODO", "FIXME", "HACK", "XXX"];
  const results: string[] = [];

  function scanDir(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Skip node_modules, .git, dist, build
      if (["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__"].includes(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!extensions.includes(ext)) continue;
        // Check if file is in scope
        const relPath = path.relative(workDir, fullPath).replace(/\\/g, "/");
        const inScope = scope.length === 0 || scope.some((s) => {
          const glob = s.replace(/\*\*/g, "").replace(/\*/g, "");
          return relPath.startsWith(glob.replace(/\/$/, ""));
        });
        if (!inScope) continue;
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (patterns.some((p) => lines[i].includes(p))) {
              results.push(`${relPath}:${i + 1}:${lines[i].trim()}`);
            }
          }
        } catch { /* skip unreadable */ }
      }
    }
  }

  scanDir(workDir);
  return results.length > 0 ? results.join("\n") : "(no TODOs found)";
}

async function runSecurityScan(workDir: string, scope: string[]): Promise<string> {
  if (fs.existsSync(path.join(workDir, ".semgrep.yml")) || fs.existsSync(path.join(workDir, ".semgrep"))) {
    const scopeStr = buildScopeGlobs(scope);
    return tryExecSync(`semgrep scan --config p/default ${scopeStr} --json 2>&1 || true`, workDir);
  }
  return "(no semgrep config found)";
}

async function agentCodeReview(workDir: string, scope: string[]): Promise<string> {
  // This is a placeholder — in production, the extension delegates to a scout subagent.
  // The agent reads the raw codebase and provides findings.
  // For now, return a message that the agent should perform code review manually.
  return `[scout-subagent] Agent code review was not delegated.
The main agent should review the codebase in scope (${scope.join(", ")}) 
and identify improvement areas.`;
}

/**
 * Run ALL discovery sources in parallel.
 * Returns raw output — the agent reads and decides what to create tasks for.
 */
export async function runDiscovery(workDir: string, scope: string[]): Promise<DiscoveryResult> {
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

/**
 * Format discovery results into a single block for tool output.
 */
export function formatDiscoveryResult(result: DiscoveryResult): string {
  const parts: string[] = [];

  if (result.lint && result.lint !== "(no linter found)") {
    parts.push("## Lint Results\n" + result.lint.slice(0, 4000));
  }
  if (result.coverage && !result.coverage.startsWith("(no coverage")) {
    parts.push("## Coverage Results\n" + result.coverage.slice(0, 4000));
  }
  if (result.complexity && !result.complexity.startsWith("(no complexity")) {
    parts.push("## Complexity Results\n" + result.complexity.slice(0, 2000));
  }
  if (result.todos && result.todos !== "(no TODOs found)") {
    parts.push("## TODO/FIXME/HACK\n" + result.todos.slice(0, 3000));
  }
  if (result.security && !result.security.startsWith("(no semgrep")) {
    parts.push("## Security Results\n" + result.security.slice(0, 3000));
  }
  if (result.scout && !result.scout.startsWith("[scout-subagent]")) {
    parts.push("## Scout Findings\n" + result.scout.slice(0, 3000));
  }

  return parts.length > 0 ? parts.join("\n\n") : "(no discovery results)";
}
