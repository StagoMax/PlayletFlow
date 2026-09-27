import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "..");
const fixtureManifest = resolve(projectRoot, "../server/Cargo.toml");
const build = spawnSync("cargo", ["build", "--manifest-path", fixtureManifest, "--bin", "videoflow-runtime-fixture", "--locked"], {
  cwd: projectRoot,
  stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const specs = readdirSync(resolve(projectRoot, "e2e"))
  .filter((name) => name.endsWith(".spec.ts"))
  .sort();
const playwrightCli = resolve(projectRoot, "node_modules", "@playwright", "test", "cli.js");
const portBase = 20_000 + (process.pid % 1_000) * 20;

for (const [index, spec] of specs.entries()) {
  const apiPort = portBase + index * 2;
  const webPort = apiPort + 1;
  console.log(`\n=== ${spec} (API ${apiPort}, web ${webPort}) ===`);
  const result = spawnSync(process.execPath, [playwrightCli, "test", `e2e/${spec}`], {
    cwd: projectRoot,
    env: {
      ...process.env,
      VIDEOFLOW_E2E_BUILT_FIXTURE: "1",
      PLAYLETFLOW_E2E_API_PORT: String(apiPort),
      PLAYLETFLOW_E2E_WEB_PORT: String(webPort),
    },
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
