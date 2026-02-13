import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function collectTestFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.js")) {
      out.push(fullPath);
    }
  }
}

const distDir = resolve("dist");
const testFiles = [];

collectTestFiles(distDir, testFiles);
testFiles.sort((a, b) => a.localeCompare(b));

if (testFiles.length === 0) {
  console.error(`No compiled test files found under ${distDir}.`);
  process.exit(1);
}

const run = spawnSync(process.execPath, ["--test", ...testFiles], { stdio: "inherit" });
if (run.error) {
  throw run.error;
}
process.exit(run.status ?? 1);
