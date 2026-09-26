import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "..");
const specs = readdirSync(resolve(projectRoot, "e2e"))
  .filter((name) => name.endsWith(".spec.ts"))
  .sort();
const playwrightCli = resolve(projectRoot, "node_modules", "@playwright", "test", "cli.js");

for (const spec of specs) {
  console.log(`\n=== ${spec} ===`);
  const result = spawnSync(process.execPath, [playwrightCli, "test", `e2e/${spec}`], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
