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
  metrics: Record<string, number>;
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

  // Check common Git Bash locations
  const candidates = [
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Check via PROGRAMFILES env var
  const pf = process.env.PROGRAMFILES || "C:\\Program Files";
  const viaEnv = path.join(pf, "Git", "usr", "bin", "bash.exe");
  if (fs.existsSync(viaEnv)) return viaEnv;

  // Fallback: 'bash' from PATH (might be WSL2 or Git Bash)
  return "bash";
}

/** Get the bash command for running a script (quoted path to bash exe). */
function bashCommand(scriptPath: string): string {
  const bash = getBashExecutable();
  const quoted = bash.includes(" ") ? `"${bash}"` : bash;
  return `${quoted} "${scriptPath.replace(/\\/g, "/")}"`;
}

/** Try running a command with a timeout. Returns stdout on success, or error text. */
function tryExecSync(cmd: string, workDir: string, timeoutMs = 60_000): string {
  try {
    return execSync(cmd, { cwd: workDir, timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  } catch (e: unknown) {
    if (e && typeof e === "object" && "stdout" in e) {
      return String((e as { stdout: string }).stdout);
    }
    if (e && typeof e === "object" && "stderr" in e && (e as { stderr: string }).stderr) {
      return String((e as { stderr: string }).stderr);
    }
    return `[discovery error] ${e instanceof Error ? e.message : String(e)}`;
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
 * Returns a summary of what was created and what needs manual setup.
 */
export function initChecks(workDir: string): { created: string[]; warnings: string[] } {
  const checksDir = path.join(workDir, ".agile", "checks");
  fs.mkdirSync(checksDir, { recursive: true });

  const ecosystem = detectEcosystem(workDir);
  const created: string[] = [];
  const warnings: string[] = [];

  // Always create todos.sh (works for any language, minimal deps)
  const todosScript = `#!/bin/bash
# .agile/checks/todos.sh — Scan for TODO/FIXME/HACK/XXX markers
# Adjust extensions as needed for your project.

EXTENSIONS=".ts .js .jsx .tsx .go .py .rs .java .rb .php .cs .c .cpp .h"
PATTERNS="TODO|FIXME|HACK|XXX"
EXCLUDE="./node_modules/*:./.git/*:./dist/*:./target/*:./__pycache__/*:./build/*:./.agile/*"

for ext in $EXTENSIONS; do
  find . -name "*$ext" -not -path "./node_modules/*" -not -path "./.git/*" \\
       -not -path "./dist/*" -not -path "./target/*" -not -path "./__pycache__/*" \\
       -not -path "./build/*" -not -path "./.agile/*" 2>/dev/null | while read -r f; do
    grep -HnE "$PATTERNS" "$f" 2>/dev/null
  done
done

TODO=$(grep -rn "TODO" . --include="*.ts" --include="*.js" --include="*.go" --include="*.py" --include="*.rs" --include="*.java" --include="*.rb" --include="*.php" --include="*.cs" 2>/dev/null | grep -cv "node_modules\|\.git\|dist\|target\|__pycache__" || echo 0)
FIXME=$(grep -rn "FIXME\|HACK" . --include="*.ts" --include="*.js" --include="*.go" --include="*.py" --include="*.rs" --include="*.java" --include="*.rb" --include="*.php" --include="*.cs" 2>/dev/null | grep -cv "node_modules\|\.git\|dist\|target\|__pycache__" || echo 0)
echo ""
echo "METRIC todo_count=$TODO"
echo "METRIC fixme_count=$FIXME"
`;

  fs.writeFileSync(path.join(checksDir, "todos.sh"), todosScript, "utf8");
  created.push("todos.sh");

  // Determine lint tools
  const lintTools = ecosystem
    ? ecosystem.tools.filter(t =>
        t.name.includes("lint") || t.name === "eslint" || t.name === "ruff" ||
        t.name.includes("clippy") || t.name.includes("format") ||
        t.name.includes("rubocop") || t.name.includes("checkstyle")
      )
    : [];

  // Always create lint.sh (ecosystem-specific or generic)
  let lintContent = "#!/bin/bash\n# .agile/checks/lint.sh — Lint checker\n";
  if (lintTools.length > 0) {
    for (const tool of lintTools) {
      const metricName = tool.name.replace(/[^a-zA-Z0-9_]/g, "_");
      lintContent += `# Tool: ${tool.name}\n# Install: ${tool.install}\n`;
      lintContent += `if command -v ${tool.name.split(" ")[0]} &>/dev/null; then\n`;
      lintContent += `  echo "--- ${tool.name} ---"\n`;
      lintContent += `  ${tool.check} 2>/dev/null || true\n`;
      lintContent += `  ${tool.check} 2>&1 | grep -cE "error|warning" | awk '{print "METRIC ${metricName}_errors=" $1}' || echo "METRIC ${metricName}_errors=0"\n`;
      lintContent += `else\n`;
      lintContent += `  echo "# ${tool.name} not installed — run: ${tool.install}"\n`;
      lintContent += `fi\n\n`;
    }
  } else {
    lintContent += `# Project type not auto-detected. Add your linter command here.\n`;
    lintContent += `# Examples:\n`;
    lintContent += `#   npx eslint . --format compact\n`;
    lintContent += `#   dotnet format --verify-no-changes\n`;
    lintContent += `#   cargo clippy -- -D warnings\n`;
    lintContent += `#   ruff check .\n`;
    lintContent += `echo "(no linter configured — edit this script)"\n`;
    lintContent += `echo "METRIC lint_errors=0"\n`;
  }
  fs.writeFileSync(path.join(checksDir, "lint.sh"), lintContent, "utf8");
  created.push("lint.sh");

  // Coverage / test script
  const testTools = ecosystem
    ? ecosystem.tools.filter(t =>
        t.name.includes("test") || t.name.includes("jest") || t.name.includes("vitest") ||
        t.name.includes("pytest") || t.name.includes("rspec") || t.name.includes("mvn")
      )
    : [];
  let covContent = "#!/bin/bash\n# .agile/checks/coverage.sh — Test coverage\n";
  if (testTools.length > 0) {
    for (const tool of testTools) {
      covContent += `# Tool: ${tool.name}\n# Install: ${tool.install}\n`;
      covContent += `if command -v ${tool.name.split(" ")[0]} &>/dev/null; then\n`;
      covContent += `  echo "--- ${tool.name} ---"\n`;
      // dotnet test needs the solution/project path when not in src dir
      if (tool.name === "dotnet test") {
        covContent += `  SLN=\$(find . -name "*.sln" -not -path "./.agile/*" 2>/dev/null | head -1)\n`;
        covContent += `  if [ -n "\$SLN" ]; then\n`;
        covContent += `    ${tool.check} "\$SLN" 2>/dev/null || true\n`;
        covContent += `  else\n`;
        covContent += `    ${tool.check} 2>/dev/null || true\n`;
        covContent += `  fi\n`;
      } else {
        covContent += `  ${tool.check} 2>/dev/null || true\n`;
      }
      covContent += `else\n`;
      covContent += `  echo "# ${tool.name} not installed — run: ${tool.install}"\n`;
      covContent += `fi\n\n`;
    }
  } else {
    covContent += `# Project type not auto-detected. Add your test command here.\n`;
    covContent += `# Examples:\n`;
    covContent += `#   npx vitest run\n`;
    covContent += `#   dotnet test\n`;
    covContent += `#   cargo test\n`;
    covContent += `#   go test -cover ./...\n`;
    covContent += `echo "(no test runner configured — edit this script)"\n`;
    covContent += `echo "METRIC coverage_pct=0"\n`;
  }
  fs.writeFileSync(path.join(checksDir, "coverage.sh"), covContent, "utf8");
  created.push("coverage.sh");

  // Check tool availability for warnings
  if (ecosystem) {
    for (const tool of ecosystem.tools) {
      const cmd = tool.name.split(" ")[0];
      try {
        execSync(`${cmd} --version`, { cwd: workDir, timeout: 5000, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
      } catch {
        warnings.push(`⚠️  \`${tool.name}\` not found. Install: \`${tool.install}\``);
      }
    }
  } else {
    warnings.push(`ℹ️  Project type not auto-detected. Edit \`.agile/checks/lint.sh\` and \`.agile/checks/coverage.sh\` with your actual linter and test commands.`);
  }

  // chmod +x (Unix only)
  if (process.platform !== "win32") {
    try {
      execSync(`chmod +x "${checksDir}"/*.sh`, { timeout: 3000, encoding: "utf8" });
    } catch { /* non-critical */ }
  }

  return { created, warnings };
}

// ─── Auto-install ────────────────────────────────────────────────────────

/**
 * Try to install missing ecosystem tools via package manager.
 * Returns lists of what was installed and what still needs manual setup.
 */
export function autoInstallTools(workDir: string, ecosystem: EcosystemInfo | null): { installed: string[]; failed: string[] } {
  if (!ecosystem) return { installed: [], failed: [] };

  const installed: string[] = [];
  const failed: string[] = [];

  for (const tool of ecosystem.tools) {
    const cmd = tool.name.split(" ")[0];
    // Check if already installed
    try {
      execSync(`${cmd} --version`, { cwd: workDir, timeout: 5000, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
      continue;
    } catch { /* need install */ }

    const installCmd = tool.install;
    if (installCmd.startsWith("npm") || installCmd.startsWith("pip") || installCmd.startsWith("go")) {
      try {
        execSync(installCmd, { cwd: workDir, timeout: 120000, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
        installed.push(tool.name);
        continue;
      } catch {
        failed.push(tool.name);
        continue;
      }
    }
    // tools that ship with SDK (dotnet format, go test) — mark as needing SDK
    if (installCmd === "(built-in)" || installCmd === "(included in .NET SDK)") {
      failed.push(tool.name + " (needs SDK installed)");
      continue;
    }
    failed.push(tool.name);
  }

  return { installed, failed };
}

/**
 * Validate generated checks scripts by running them and collecting output.
 */
export function validateCheckScripts(workDir: string, created: string[]): string[] {
  const checksDir = path.join(workDir, ".agile", "checks");
  const results: string[] = [];

  for (const script of created) {
    const scriptPath = path.join(checksDir, script).replace(/\\/g, "/");
    try {
      const out = execSync(bashCommand(scriptPath), { cwd: workDir, timeout: 30000, encoding: "utf8", maxBuffer: 50 * 1024 });
      const lines = out.trim().split("\n").filter(l => !l.startsWith("METRIC"));
      const nonMetric = lines.filter(l => l.trim()).join("\n").slice(0, 500);
      results.push(`## ${script}\n${nonMetric || "(no output)"}`);
    } catch (e: unknown) {
      const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
      const stderr = err.stderr?.toString().trim() || err.message || "unknown error";
      const stdout = err.stdout?.toString().trim() || "";
      const outLines = stdout.split("\n").concat(stderr.split("\n")).filter((l: string) => !l.startsWith("METRIC") && l.trim()).slice(0, 5);
      results.push(`## ${script}\n⚠ ${outLines.join("\n") || "script failed"}`);
    }
  }

  return results;
}

// ─── Check runner ──────────────────────────────────────────────────────

/**
 * Run all scripts in .agile/checks/, parse METRIC lines, collect reports.
 */
export function runChecks(workDir: string): DiscoveryResult {
  const checksDir = path.join(workDir, ".agile", "checks");
  const scripts = fs.readdirSync(checksDir).filter(f => f.endsWith(".sh"));

  const metrics: Record<string, number> = {};
  const reports: Record<string, string> = {};
  const scriptsFound: string[] = [];

  for (const script of scripts) {
    const name = script.replace(/\.sh$/, "");
    scriptsFound.push(name);

    const raw = tryExecSync(bashCommand(path.join(checksDir, script)), workDir, 120_000);

    // Parse METRIC lines and split from report text
    const reportLines: string[] = [];
    for (const line of raw.split("\n")) {
      const m = line.match(/^METRIC\s+(\w[\w.]+)\s*=\s*([\d.]+)\s*$/);
      if (m) {
        metrics[m[1]] = parseFloat(m[2]);
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
    const truncated = report.length > 3000
      ? report.slice(0, 3000) + `\n... (truncated, ${report.length - 3000} more chars)`
      : report;
    parts.push(`## ${heading} Results\n${truncated}`);
  }

  // Notice when using fallback
  if (result.scriptsFound.length === 0 && metricKeys.length === 0) {
    parts.push("## ℹ️  No .agile/checks/ Scripts");
    parts.push("Run `/agile init-checks` to generate template scripts for your project ecosystem.");
    parts.push("Scripts give you full control over discovery — custom metrics, any language, any tool.");
  }

  return parts.length > 0 ? parts.join("\n\n") : "(no discovery results)";
}
