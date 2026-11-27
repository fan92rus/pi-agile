import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const base = process.argv[2];
const target = base || "HEAD";
const diff = execFileSync("git", ["diff", target], { cwd: process.cwd(), encoding: "utf8" });
const criteriaFiles = [
  "D:/Documents/Repositories/pi-agile/docs/plans/taskflow-pilot/PLAN.md",
  "D:/Documents/Repositories/pi-agile/docs/plans/taskflow-pilot/flow.json",
  "D:/Documents/Repositories/pi-agile/docs/plans/taskflow-pilot/rework-flow.json",
];
const criteria = criteriaFiles.map((file) => readFileSync(file, "utf8")).join("\n");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fingerprint = `diff=${sha(diff)}\ncriteria=${sha(criteria)}\n`;
writeFileSync(".taskflow-review-fingerprint.txt", fingerprint);
console.log(`FINGERPRINT ${sha(diff)}`);
