/**
 * Discovery unit tests — parallel/discovery.ts + buildDiscoveryScoutTask
 * (parallel/review.ts). Covers the functions requested in the stale
 * pi-autoresearch-9st / -hgb tasks (METRIC parsing, detectEcosystem,
 * initChecks, formatDiscoveryResult, buildDiscoveryScoutTask).
 *
 * Run with: node --experimental-strip-types tests/discovery.test.mjs
 * (no redirect-loader needed — neither module imports @sinclair/typebox)
 */
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const EXT_DIR = path.join(import.meta.dirname, "..", "extensions", "pi-agile");

async function importModule(relPath) {
  return import(pathToFileURL(path.join(EXT_DIR, relPath)).href);
}

const { detectEcosystem, initChecks, runChecks, formatDiscoveryResult } = await importModule("parallel/discovery.ts");
const { buildDiscoveryScoutTask } = await importModule("parallel/review.ts");

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ❌ ${name}: ${e.message}`);
  }
}

function makeDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pa-disc-${prefix}-`));
}

// ── detectEcosystem ────────────────────────────────────────────────────

await test("detectEcosystem: go.mod → go with golangci-lint + go test", () => {
  const dir = makeDir("go");
  try {
    fs.writeFileSync(path.join(dir, "go.mod"), "module test\n");
    const eco = detectEcosystem(dir);
    assert.ok(eco, "expected ecosystem");
    assert.strictEqual(eco.language, "go");
    assert.ok(eco.tools.some((t) => t.name === "golangci-lint" && t.check === "golangci-lint run ./..."));
    assert.ok(eco.tools.some((t) => t.name === "go test" && t.check === "go test -cover ./..."));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test("detectEcosystem: Cargo.toml → rust", () => {
  const dir = makeDir("rs");
  try {
    fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\n");
    assert.strictEqual(detectEcosystem(dir).language, "rust");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test("detectEcosystem: nested .csproj → dotnet (recursive search)", () => {
  const dir = makeDir("cs");
  try {
    fs.mkdirSync(path.join(dir, "src", "App"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "App", "App.csproj"), "<Project />");
    assert.strictEqual(detectEcosystem(dir).language, "dotnet");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test("detectEcosystem: pyproject.toml → python; Gemfile → ruby; pom.xml → java", () => {
  for (const [file, lang] of [["pyproject.toml", "python"], ["Gemfile", "ruby"], ["pom.xml", "java"]]) {
    const dir = makeDir("eco");
    try {
      fs.writeFileSync(path.join(dir, file), "# x");
      assert.strictEqual(detectEcosystem(dir).language, lang, `expected ${lang} for ${file}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

await test("detectEcosystem: package.json → js/ts (fallback)", () => {
  const dir = makeDir("js");
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    assert.strictEqual(detectEcosystem(dir).language, "js/ts");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test("detectEcosystem: empty dir → null", () => {
  const dir = makeDir("none");
  try {
    assert.strictEqual(detectEcosystem(dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── initChecks ─────────────────────────────────────────────────────────

await test("initChecks: creates todos/lint/coverage scripts with ecosystem hint", () => {
  const dir = makeDir("init");
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const res = initChecks(dir);
    assert.deepStrictEqual(res.created.sort(), ["coverage.sh", "lint.sh", "todos.sh"]);
    assert.deepStrictEqual(res.warnings, []);
    for (const f of ["todos.sh", "lint.sh", "coverage.sh"]) {
      const p = path.join(dir, ".agile", "checks", f);
      assert.ok(fs.existsSync(p), `${f} created`);
      assert.ok(fs.readFileSync(p, "utf8").includes("METRIC"), `${f} has METRIC template`);
    }
    const lint = fs.readFileSync(path.join(dir, ".agile", "checks", "lint.sh"), "utf8");
    assert.ok(lint.includes("Detected: js/ts"), "lint.sh has ecosystem hint");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test("initChecks: second call is idempotent, marks (exists)", () => {
  const dir = makeDir("init2");
  try {
    initChecks(dir);
    const res = initChecks(dir);
    assert.ok(res.created.every((c) => c.endsWith(" (exists)")), `expected (exists) suffixes: ${res.created}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── runChecks: real METRIC parsing via Git Bash ────────────────────────

await test("runChecks: parses numeric / quoted / bare METRIC values, collects report text", async () => {
  const dir = makeDir("rc");
  try {
    fs.mkdirSync(path.join(dir, ".agile", "checks"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".agile", "checks", "metrics.sh"), [
      "#!/bin/bash",
      'echo "METRIC todo_count=5"',
      'echo "METRIC fixme_count=0"',
      'echo "METRIC coverage_pct=87.5"',
      'echo "METRIC label=\\"critical\\""',
      'echo "METRIC branch=main"',
      'echo "raw report line one"',
      'echo "raw report line two"',
      "",
    ].join("\n"), "utf8");

    const res = await runChecks(dir);
    assert.deepStrictEqual(res.scriptsFound, ["metrics"]);
    assert.strictEqual(res.metrics.todo_count, 5, "numeric metric");
    assert.strictEqual(res.metrics.fixme_count, 0, "zero metric");
    assert.strictEqual(res.metrics.coverage_pct, 87.5, "float metric");
    assert.strictEqual(res.metrics.label, "critical", "quoted-string metric");
    assert.strictEqual(res.metrics.branch, "main", "bare-string metric");
    assert.ok(res.reports.metrics.includes("raw report line one"), "report text kept");
    assert.ok(res.reports.metrics.includes("raw report line two"), "report text kept 2");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test("runDiscovery: no checks dir → fallback detectors shape (no scripts, empty metrics)", async () => {
  const dir = makeDir("nochk");
  try {
    // runChecks assumes .agile/checks exists; runDiscovery handles the
    // fallback. Assert runDiscovery on an empty dir returns the fallback shape.
    const { runDiscovery } = await importModule("parallel/discovery.ts");
    const res = await runDiscovery(dir, []);
    assert.deepStrictEqual(res.metrics, {});
    assert.deepStrictEqual(res.scriptsFound, []);
    assert.ok(res.reports.lint === "(no linter found)" || typeof res.reports.lint === "string");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── formatDiscoveryResult ──────────────────────────────────────────────

await test("formatDiscoveryResult: metrics section sorted, report headings", () => {
  const out = formatDiscoveryResult({
    metrics: { b: 2, a: 1 },
    reports: { lint: "eslint: 3 problems", coverage: "(no coverage tool found)" },
    scriptsFound: ["lint.sh"],
  });
  assert.ok(out.includes("## Metrics"), "metrics heading");
  const aIdx = out.indexOf("a = 1");
  const bIdx = out.indexOf("b = 2");
  assert.ok(aIdx >= 0 && bIdx > aIdx, "metrics sorted alphabetically");
  assert.ok(out.includes("## Lint Results"), "report heading");
  assert.ok(!out.includes("Coverage"), "(no ...) report skipped");
  assert.ok(!out.includes("No .agile/checks"), "no fallback notice when scripts ran");
});

await test("formatDiscoveryResult: fallback notice + empty result", () => {
  const fallback = formatDiscoveryResult({ metrics: {}, reports: {}, scriptsFound: [] });
  assert.ok(fallback.includes("## No .agile/checks/ Scripts"), "fallback notice");
  assert.ok(fallback.includes("Run `/agile init-checks`"), "init-checks hint");

  const empty = formatDiscoveryResult({ metrics: {}, reports: { lint: "" }, scriptsFound: ["lint"] });
  assert.strictEqual(empty, "(no discovery results)", "empty result");
});

// ── buildDiscoveryScoutTask ────────────────────────────────────────────

await test("buildDiscoveryScoutTask: embeds goal/constraints/patterns/scope", () => {
  const task = buildDiscoveryScoutTask("/repo", "Fix bugs", "No deps", "use TS", ["src/**", "lib/**"]);
  assert.ok(task.includes("/repo"), "workDir");
  assert.ok(task.includes("Fix bugs"), "goal");
  assert.ok(task.includes("No deps"), "constraints");
  assert.ok(task.includes("use TS"), "patterns");
  assert.ok(task.includes("src/**, lib/**"), "scope joined");
});

await test("buildDiscoveryScoutTask: sensible defaults for empty inputs", () => {
  const task = buildDiscoveryScoutTask("/repo", "", "", "", []);
  assert.ok(task.includes("(not specified"), "default goal");
  assert.ok(task.includes("(none specified)"), "default constraints/patterns");
  assert.ok(task.includes("(entire project)"), "default scope");
});

// ── Results ────────────────────────────────────────────────────────────

console.log(`\n# Results: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.error("Failed tests:");
  process.exit(1);
}
