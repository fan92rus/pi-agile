/**
 * discovery.ts — Multi-source codebase analysis
 *
 * Primary: runs .agile/checks/*.sh scripts written by the project agent.
 * Each script can output METRIC key=value lines (parsed into structured metrics)
 * and free-form text (returned as report).
 *
 * Fallback: hardcoded detectors for common ecosystems when no scripts exist.
 *
 * Extension DOES NOT parse findings into structured candidates.
 * The agent reads the raw output and decides what tasks to create.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

export interface DiscoveryResult {
  /** Parsed METRIC lines from all scripts */
  metrics: Record<string, number | string>;
  /** Free-text reports per script */
  reports: Record<string, string>;
  /** Script names that were run */
  scriptsFound: string[];
}

/**
 * Find a bash executable that understands Windows paths.
 * On Windows, prefers Git Bash over WSL2 bash (which can't access D:\\).
 * On Unix, just returns 'bash'.
 */
function getBashExecutable(): string {
  if (process.platform !== "win32") return "bash";

  // Common Git Bash locations
  const candidates = [
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Check via PROGRAMFILES env var
  for (const envVar of ["PROGRAMFILES", "PROGRAMFILES(X86)"]) {
    const pf = process.env[envVar];
    if (pf) {
      const p1 = path.join(pf, "Git", "usr", "bin", "bash.exe");
      if (fs.existsSync(p1)) return p1;
      const p2 = path.join(pf, "Git", "bin", "bash.exe");
      if (fs.existsSync(p2)) return p2;
    }
  }

  // Scoop installs
  const userprofile = process.env.USERPROFILE || "";
  if (userprofile) {
    const scoopPaths = [
      path.join(userprofile, "scoop", "apps", "git", "current", "bin", "bash.exe"),
      path.join(userprofile, "scoop", "apps", "git", "current", "usr", "bin", "bash.exe"),
    ];
    for (const s of scoopPaths) {
      if (fs.existsSync(s)) return s;
    }
  }

  // winget / LocalAppData installs
  const localAppData = process.env.LOCALAPPDATA || "";
  if (localAppData) {
    const wingetPath = path.join(localAppData, "Programs", "Git", "bin", "bash.exe");
    if (fs.existsSync(wingetPath)) return wingetPath;
  }

  // Fallback: 'bash' from PATH (might be WSL2 or Git Bash)
  return "bash";
}

/** Get the bash command for running a script. Uses --login so /usr/bin is in PATH. */
function bashCommand(scriptPath: string): string {
  const bash = getBashExecutable();
  const quoted = bash.includes(" ") ? `"${bash}"` : bash;
  // --login: makes Git Bash read /etc/profile which adds /usr/bin to PATH
  // Without it, grep/find/tail/rm/wc are unavailable on Windows Git Bash
  return `${quoted} --login "${scriptPath.replace(/\\/g, "/")}"`;
}

/** Try running a command with a timeout. Returns stdout on success, or error text. */
function tryExecSync(cmd: string, workDir: string, timeoutMs = 60_000): string {
  try {
    return execSync(cmd, { cwd: workDir, timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    // Return stdout if non-empty (script ran but exited non-zero)
    if (err.stdout) return String(err.stdout);
    // Return stderr if non-empty (script crashed with an error message)
    if (err.stderr) return String(err.stderr);
    // Last resort: error message so the report shows the script failed
    return `[discovery error] ${err.message ?? String(e)}`;
  }
}

// ─── Ecosystem detection ────────────────────────────────────────────────

export interface EcosystemInfo {
  language: string;
  tools: { name: string; check: string; install: string }[];
  configFiles: string[];
}

export function detectEcosystem(workDir: string): EcosystemInfo | null {
  if (fs.existsSync(path.join(workDir, "go.mod"))) {
    return {
      language: "go",
      tools: [
        { name: "golangci-lint", check: "golangci-lint run ./...", install: "go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest" },
        { name: "go test", check: "go test -cover ./...", install: "(built-in)" },
      ],
      configFiles: [".golangci.yml", ".golangci.yaml"],
    };
  }

  if (fs.existsSync(path.join(workDir, "Cargo.toml"))) {
    return {
      language: "rust",
      tools: [
        { name: "cargo clippy", check: "cargo clippy -- -D warnings", install: "rustup component add clippy" },
        { name: "cargo test", check: "cargo test", install: "(built-in)" },
        { name: "cargo fmt", check: "cargo fmt --check", install: "rustup component add rustfmt" },
      ],
      configFiles: ["rustfmt.toml", ".clippy.toml"],
    };
  }

  // .NET / C# — search recursively for .csproj or .sln
  function findFiles(dir: string, ext: string): boolean {
    try {
      return fs.readdirSync(dir).some(f => f.endsWith(ext)) ||
        fs.readdirSync(dir).some(e => {
          const p = path.join(dir, e);
          return e !== ".git" && fs.statSync(p).isDirectory() && findFiles(p, ext);
        });
    } catch { return false; }
  }
  if (findFiles(workDir, ".csproj") || findFiles(workDir, ".sln")) {
    return {
      language: "dotnet",
      tools: [
        { name: "dotnet format", check: "dotnet format --verify-no-changes", install: "(included in .NET SDK)" },
        { name: "dotnet test", check: "dotnet test", install: "(built-in)" },
      ],
      configFiles: [".editorconfig"],
    };
  }

  // Python
  const pythonFiles = ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"];
  if (pythonFiles.some(f => fs.existsSync(path.join(workDir, f)))) {
    return {
      language: "python",
      tools: [
        { name: "ruff", check: "ruff check .", install: "pip install ruff" },
        { name: "pytest", check: "pytest --cov", install: "pip install pytest pytest-cov" },
      ],
      configFiles: ["pyproject.toml (ruff section)", ".ruff.toml"],
    };
  }

  // Ruby
  if (fs.existsSync(path.join(workDir, "Gemfile"))) {
    return {
      language: "ruby",
      tools: [
        { name: "rubocop", check: "rubocop", install: "gem install rubocop" },
        { name: "rspec", check: "rspec", install: "gem install rspec" },
      ],
      configFiles: [".rubocop.yml"],
    };
  }

  // Java
  if (fs.existsSync(path.join(workDir, "pom.xml")) || fs.existsSync(path.join(workDir, "build.gradle"))) {
    return {
      language: "java",
      tools: [
        { name: "mvn test", check: "mvn test", install: "(mvn wrapper or system install)" },
      ],
      configFiles: ["checkstyle.xml"],
    };
  }

  // JS/TS — most common, fallback
  if (fs.existsSync(path.join(workDir, "package.json"))) {
    return {
      language: "js/ts",
      tools: [
        { name: "eslint", check: "npx eslint . --format compact", install: "npm install --save-dev eslint" },
        { name: "vitest/jest", check: "npx vitest run --reporter=verbose || npx jest --passWithNoTests", install: "npm install --save-dev vitest" },
      ],
      configFiles: ["eslint.config.js", ".eslintrc.js"],
    };
  }

  return null;
}

// ─── Script generation ─────────────────────────────────────────────────

/**
 * Generate .agile/checks/*.sh template scripts for the detected ecosystem.
 * Templates are EMPTY — only comments about what to check and how to return.
 * The agent fills in the actual commands.
 */
export function initChecks(workDir: string): { created: string[]; warnings: string[] } {
  const checksDir = path.join(workDir, ".agile", "checks");
  fs.mkdirSync(checksDir, { recursive: true });

  const ecosystem = detectEcosystem(workDir);
  const created: string[] = [];
  const warnings: string[] = [];

  const ecoHint = ecosystem
    ? `# Detected: ${ecosystem.language}. Tools: ${ecosystem.tools.map(t => t.name).join(", ")}.\n# Install missing tools before running.\n`
    : `# Project type not auto-detected. Identify your linter/test runner and add commands below.\n`;

  const todosScript = [
    "#!/bin/bash",
    "# .agile/checks/todos.sh - Scan for TODO/FIXME/HACK/XXX markers",
    "#",
    "# WHAT TO CHECK:",
    "#   Search source files for TODO, FIXME, HACK, XXX comments.",
    "#   Exclude vendor/build dirs (node_modules, dist, .git, etc).",
    "#",
    "# HOW TO RETURN RESULTS:",
    "#   Print raw output (lines with file:line:content).",
    "#   End with METRIC lines:",
    "#     METRIC todo_count=N",
    "#     METRIC fixme_count=N",
    "",
    "# TODO: add your grep/find command here",
    "",
    'echo "METRIC todo_count=0"',
    'echo "METRIC fixme_count=0"',
    "",
  ].join("\n");

  const lintScript = [
    "#!/bin/bash",
    "# .agile/checks/lint.sh - Lint checker",
    "#",
    ecoHint.trimEnd(),
    "#",
    "# WHAT TO CHECK:",
    "#   Run your project's linter/formatter and report errors/warnings.",
    "#",
    "# HOW TO RETURN RESULTS:",
    "#   Print raw linter output.",
    "#   End with METRIC lines:",
    "#     METRIC lint_errors=N",
    "",
    "# TODO: add your linter command here",
    "",
    'echo "METRIC lint_errors=0"',
    "",
  ].join("\n");

  const coverageScript = [
    "#!/bin/bash",
    "# .agile/checks/coverage.sh - Test runner / coverage",
    "#",
    ecoHint.trimEnd(),
    "#",
    "# WHAT TO CHECK:",
    "#   Run your project's test suite and/or coverage tool.",
    "#   If your tests need a specific solution/project path, specify it.",
    "#",
    "# HOW TO RETURN RESULTS:",
    "#   Print raw test output (last ~10 lines is enough).",
    "#   End with METRIC lines:",
    "#     METRIC tests_passed=N   (1 if all pass, 0 if any fail)",
    "#     METRIC coverage_pct=N  (optional, 0-100)",
    "",
    "# TODO: add your test command here",
    "",
    'echo "METRIC tests_passed=0"',
    'echo "METRIC coverage_pct=0"',
    "",
  ].join("\n");

  for (const [name, content] of [
    ["todos.sh", todosScript],
    ["lint.sh", lintScript],
    ["coverage.sh", coverageScript],
  ] as [string, string][]) {
    const filePath = path.join(checksDir, name);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, "utf8");
      created.push(name);
    } else {
      created.push(name + " (exists)");
    }
  }

  // chmod +x (Unix only)
  if (process.platform !== "win32") {
    try {
      execSync(`chmod +x "${checksDir}"/*.sh`, { timeout: 3000, encoding: "utf8" });
    } catch { /* non-critical */ }
  }

  return { created, warnings };
}

// ─── Check runner ──────────────────────────────────────────────────────

/**
 * Run all scripts in .agile/checks/, parse METRIC lines, collect reports.
 */
export function runChecks(workDir: string): DiscoveryResult {
  const checksDir = path.join(workDir, ".agile", "checks");
  const scripts = fs.readdirSync(checksDir).filter(f => f.endsWith(".sh"));

  const metrics: Record<string, number | string> = {};
  const reports: Record<string, string> = {};
  const scriptsFound: string[] = [];

  for (const script of scripts) {
    const name = script.replace(/\.sh$/, "");
    scriptsFound.push(name);

    const raw = tryExecSync(bashCommand(path.join(checksDir, script)), workDir, 120_000);

    // Parse METRIC lines and split from report text
    const reportLines: string[] = [];
    for (const line of raw.split("\n")) {
      // METRIC key=number  OR  METRIC key="string"  OR  METRIC key=bare_value
      const mNum = line.match(/^METRIC\s+(\w[\w.]*)\s*=\s*(-?[\d.]+)\s*$/);
      const mStr = line.match(/^METRIC\s+(\w[\w.]*)\s*=\s*"([^"]*)"\s*$/);
      const mRaw = line.match(/^METRIC\s+(\w[\w.]*)\s*=\s*(.+?)\s*$/);
      if (mNum) {
        metrics[mNum[1]] = parseFloat(mNum[2]);
      } else if (mStr) {
        metrics[mStr[1]] = mStr[2];
      } else if (mRaw) {
        metrics[mRaw[1]] = mRaw[2];
      } else {
        reportLines.push(line);
      }
    }
    reports[name] = reportLines.join("\n").trim();
  }

  return { metrics, reports, scriptsFound };
}

// ─── Fallback hardcoded detectors ──────────────────────────────────────

function detectTool(workDir: string) {
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
  const tools = detectTool(workDir);
  const output: string[] = [];

  if (tools.hasEslint) {
    const scopeStr = buildScopeGlobs(scope);
    output.push("--- ESLint ---");
    output.push(tryExecSync(`npx eslint ${scopeStr} -f compact 2>&1 || true`, workDir));
  }

  if (fs.existsSync(path.join(workDir, "go.mod"))) {
    output.push("--- golangci-lint ---");
    output.push(tryExecSync("golangci-lint run ./... 2>&1 || true", workDir));
  }

  return output.join("\n") || "(no linter found)";
}

async function runCoverage(workDir: string, scope: string[]): Promise<string> {
  const tools = detectTool(workDir);

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
  const extensions = [".ts", ".js", ".jsx", ".tsx", ".go", ".py", ".rs", ".java", ".rb", ".php", ".c", ".cpp", ".h", ".cs"];
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
      if (["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", ".agile"].includes(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!extensions.includes(ext)) continue;
        const relPath = path.relative(workDir, fullPath).replace(/\\/g, "/");
        const inScope = scope.length === 0 || scope.some((s) => {
          const glob = s.replace(/\*\*/g, "").replace(/\*/g, "");
          return relPath.startsWith(glob.replace(/\/$/, ""));
        });
        if (!inScope) continue;
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > 1024 * 1024) continue; // skip files > 1MB
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
  const scopeStr = buildScopeGlobs(scope);
  return tryExecSync(`semgrep scan --config p/default ${scopeStr} --json 2>&1 || true`, workDir);
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Run discovery.
 *
 * Primary: runs .agile/checks/*.sh scripts.
 * Fallback: hardcoded detectors when no checks directory exists or it's empty.
 */
export async function runDiscovery(workDir: string, scope: string[]): Promise<DiscoveryResult> {
  const checksDir = path.join(workDir, ".agile", "checks");

  // Primary path: run .agile/checks/ scripts
  if (fs.existsSync(checksDir)) {
    const scripts = fs.readdirSync(checksDir).filter(f => f.endsWith(".sh"));
    if (scripts.length > 0) {
      return runChecks(workDir);
    }
  }

  // Fallback: no scripts — use hardcoded detectors
  const [lint, coverage, complexity, todos, security] = await Promise.all([
    runLinters(workDir, scope),
    runCoverage(workDir, scope),
    runComplexity(workDir, scope),
    scanTODOs(workDir, scope),
    runSecurityScan(workDir, scope),
  ]);

  return {
    metrics: {},
    reports: { lint, coverage, complexity, todos, security },
    scriptsFound: [],
  };
}

/** Maximum chars per report section (dotnet test verbose can be 10000+). */
const REPORT_MAX_CHARS = 20000;

/**
 * Format discovery results into a single block for tool output.
 */
export function formatDiscoveryResult(result: DiscoveryResult): string {
  const parts: string[] = [];

  // Metrics summary
  const metricKeys = Object.keys(result.metrics);
  if (metricKeys.length > 0) {
    parts.push("## Metrics");
    for (const key of metricKeys.sort()) {
      parts.push(`  ${key} = ${result.metrics[key]}`);
    }
    parts.push("");
  }

  // Text reports
  for (const [name, report] of Object.entries(result.reports)) {
    if (!report || report.startsWith("(no ")) continue;
    const heading = name.charAt(0).toUpperCase() + name.slice(1);
    const truncated = report.length > REPORT_MAX_CHARS
      ? report.slice(0, REPORT_MAX_CHARS) + `\n... (truncated, ${report.length - REPORT_MAX_CHARS} more chars)`
      : report;
    parts.push(`## ${heading} Results\n${truncated}`);
  }

  // Notice when using fallback
  if (result.scriptsFound.length === 0 && metricKeys.length === 0) {
    parts.push("## No .agile/checks/ Scripts");
    parts.push("Run `/agile init-checks` to generate template scripts for your project ecosystem.");
    parts.push("Scripts give you full control over discovery — custom metrics, any language, any tool.");
  }

  return parts.length > 0 ? parts.join("\n\n") : "(no discovery results)";
}
