import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(process.cwd(), "..", "..");
const coreDir = resolve(repoRoot, "src", "contract-core");
const lockfilePath = resolve(coreDir, "package-lock.json");
const installedLockPath = resolve(coreDir, "node_modules", ".package-lock.json");

const run = (command, args) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const needsInstall =
  !existsSync(installedLockPath) ||
  (existsSync(lockfilePath) && statSync(lockfilePath).mtimeMs > statSync(installedLockPath).mtimeMs);

if (needsInstall) {
  run(npmCommand, ["--prefix", coreDir, "ci"]);
}

run(npmCommand, ["--prefix", coreDir, "run", "build"]);
