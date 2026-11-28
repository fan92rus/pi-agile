import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installTaskflowAssets } from "../extensions/pi-agile/taskflow-install.ts";

function fixture() {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "tf-install-source-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-install-project-"));
  const base = path.join(source, "docs", "plans", "taskflow-pilot");
  fs.mkdirSync(path.join(base, "campaign"), { recursive: true });
  fs.mkdirSync(path.join(base, "mvp", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(base, "campaign", "make-campaign-flow.mjs"), "campaign v1\n");
  fs.writeFileSync(path.join(base, "mvp", "flow.json"), '{"v":1}\n');
  fs.writeFileSync(path.join(base, "mvp", "scripts", "phase-runner.mjs"), "runner v1\n");
  return { source, project, base, target: path.join(project, ".pi", "taskflows", "tf") };
}

function cleanup(fx) {
  fs.rmSync(fx.source, { recursive: true, force: true });
  fs.rmSync(fx.project, { recursive: true, force: true });
}

test("installs packaged tf assets into .pi/taskflows/tf", () => {
  const fx = fixture();
  try {
    const result = installTaskflowAssets({ sourceRoot: fx.source, projectRoot: fx.project, version: "0.2.0" });
    assert.equal(result.installed, true);
    assert.equal(result.reason, "installed");
    assert.ok(fs.readFileSync(path.join(fx.target, "campaign", "make-campaign-flow.mjs"), "utf8").includes("campaign v1"));
    assert.ok(fs.readFileSync(path.join(fx.target, "mvp", "flow.json"), "utf8").includes('"v":1'));
    const stamp = JSON.parse(fs.readFileSync(path.join(fx.target, "INSTALL.json"), "utf8"));
    assert.equal(stamp.version, "0.2.0");
    assert.deepEqual(stamp.assets, ["campaign", "mvp"]);
    assert.ok(stamp.files["campaign/make-campaign-flow.mjs"]);
  } finally { cleanup(fx); }
});

test("same version is up-to-date when managed files are unchanged", () => {
  const fx = fixture();
  try {
    installTaskflowAssets({ sourceRoot: fx.source, projectRoot: fx.project, version: "0.2.0" });
    const result = installTaskflowAssets({ sourceRoot: fx.source, projectRoot: fx.project, version: "0.2.0" });
    assert.equal(result.installed, false);
    assert.equal(result.reason, "up-to-date");
  } finally { cleanup(fx); }
});

test("version bump refreshes unmodified managed files", () => {
  const fx = fixture();
  try {
    installTaskflowAssets({ sourceRoot: fx.source, projectRoot: fx.project, version: "0.2.0" });
    fs.writeFileSync(path.join(fx.base, "campaign", "make-campaign-flow.mjs"), "campaign v2\n");
    const result = installTaskflowAssets({ sourceRoot: fx.source, projectRoot: fx.project, version: "0.3.0" });
    assert.equal(result.installed, true);
    assert.deepEqual(result.conflicts, undefined);
    assert.equal(fs.readFileSync(path.join(fx.target, "campaign", "make-campaign-flow.mjs"), "utf8"), "campaign v2\n");
    const stamp = JSON.parse(fs.readFileSync(path.join(fx.target, "INSTALL.json"), "utf8"));
    assert.equal(stamp.version, "0.3.0");
  } finally { cleanup(fx); }
});

test("version bump preserves user edits and unrelated files", () => {
  const fx = fixture();
  try {
    installTaskflowAssets({ sourceRoot: fx.source, projectRoot: fx.project, version: "0.2.0" });
    const managed = path.join(fx.target, "campaign", "make-campaign-flow.mjs");
    const extra = path.join(fx.target, "campaign", "my-helper.mjs");
    fs.writeFileSync(managed, "local edit\n");
    fs.writeFileSync(extra, "mine\n");
    fs.writeFileSync(path.join(fx.base, "campaign", "make-campaign-flow.mjs"), "campaign v2\n");
    const result = installTaskflowAssets({ sourceRoot: fx.source, projectRoot: fx.project, version: "0.3.0" });
    assert.equal(result.installed, true);
    assert.deepEqual(result.conflicts, ["campaign/make-campaign-flow.mjs"]);
    assert.equal(fs.readFileSync(managed, "utf8"), "local edit\n");
    assert.equal(fs.readFileSync(extra, "utf8"), "mine\n");
    const stamp = JSON.parse(fs.readFileSync(path.join(fx.target, "INSTALL.json"), "utf8"));
    assert.deepEqual(stamp.conflicts, ["campaign/make-campaign-flow.mjs"]);
  } finally { cleanup(fx); }
});

test("preserved user edit survives consecutive version bumps", () => {
  const fx = fixture();
  try {
    installTaskflowAssets({ sourceRoot: fx.source, projectRoot: fx.project, version: "0.2.0" });
    const managed = path.join(fx.target, "campaign", "make-campaign-flow.mjs");
    fs.writeFileSync(managed, "REVIEW LOCAL EDIT\n");

    fs.writeFileSync(path.join(fx.base, "campaign", "make-campaign-flow.mjs"), "campaign v2\n");
    const first = installTaskflowAssets({ sourceRoot: fx.source, projectRoot: fx.project, version: "0.3.0" });
    assert.deepEqual(first.conflicts, ["campaign/make-campaign-flow.mjs"]);
    assert.equal(fs.readFileSync(managed, "utf8"), "REVIEW LOCAL EDIT\n");

    fs.writeFileSync(path.join(fx.base, "campaign", "make-campaign-flow.mjs"), "campaign v3\n");
    const second = installTaskflowAssets({ sourceRoot: fx.source, projectRoot: fx.project, version: "0.4.0" });
    assert.deepEqual(second.conflicts, ["campaign/make-campaign-flow.mjs"]);
    assert.equal(fs.readFileSync(managed, "utf8"), "REVIEW LOCAL EDIT\n");
    const stamp = JSON.parse(fs.readFileSync(path.join(fx.target, "INSTALL.json"), "utf8"));
    assert.equal(stamp.version, "0.4.0");
    assert.deepEqual(stamp.conflicts, ["campaign/make-campaign-flow.mjs"]);
    assert.ok(stamp.conflictHashes["campaign/make-campaign-flow.mjs"]);
  } finally { cleanup(fx); }
});

test("missing source assets fail closed without creating a target tree", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "tf-install-empty-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-install-empty-project-"));
  try {
    const result = installTaskflowAssets({ sourceRoot: source, projectRoot: project, version: "0.2.0" });
    assert.equal(result.installed, false);
    assert.equal(result.reason, "source-missing");
    assert.deepEqual(result.missing, ["campaign", "mvp"]);
    assert.equal(fs.existsSync(path.join(project, ".pi", "taskflows", "tf")), false);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
