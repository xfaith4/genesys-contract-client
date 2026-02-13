import { spawnSync } from "node:child_process";

const roundsRaw = process.env.BREAK_ROUNDS;
const parsed = Number(roundsRaw ?? "5");
const rounds = Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : 5;

const testFiles = ["dist/mcp/mcp.integration.test.js", "dist/smoke.test.js"];

for (let round = 1; round <= rounds; round += 1) {
  console.log(`\n[break] round ${round}/${rounds}`);
  const run = spawnSync(process.execPath, ["--test", ...testFiles], { stdio: "inherit" });
  if (run.error) {
    throw run.error;
  }
  if ((run.status ?? 1) !== 0) {
    process.exit(run.status ?? 1);
  }
}

console.log(`\n[break] completed ${rounds} rounds with no failures.`);
