import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureDbBase = join(tmpdir(), `videoflow-e2e-${process.pid}-${Date.now()}`);
const apiPort = e2ePort("PLAYLETFLOW_E2E_API_PORT", 8789);
const webPort = e2ePort("PLAYLETFLOW_E2E_WEB_PORT", 5174);
const fixtureCommand = process.env.VIDEOFLOW_E2E_BUILT_FIXTURE === "1"
  ? process.platform === "win32"
    ? "..\\server\\target\\debug\\videoflow-runtime-fixture.exe"
    : "../server/target/debug/videoflow-runtime-fixture"
  : "cargo run --manifest-path ../server/Cargo.toml --bin videoflow-runtime-fixture";

function e2ePort(name: string, fallback: number) {
  const value = process.env[name];
  const port = value ? Number(value) : fallback;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${name} must be an integer between 1024 and 65535`);
  }
  return port;
}

export default defineConfig({
  testDir: "./e2e",
  outputDir: join(".e2e", "results", String(webPort)),
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: join(".e2e", "report", String(webPort)) }]],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: fixtureCommand,
      url: `http://127.0.0.1:${apiPort}/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        VIDEOFLOW_PORT: String(apiPort),
        VIDEOFLOW_DB: `${fixtureDbBase}-conversations.sqlite`,
        VIDEOFLOW_PRODUCT_DB: `${fixtureDbBase}-product.sqlite`,
      },
    },
    {
      command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        VIDEOFLOW_API_TARGET: `http://127.0.0.1:${apiPort}`,
      },
    },
  ],
});
