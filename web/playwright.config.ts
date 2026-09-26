import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: ".e2e/report" }]],
  use: {
    baseURL: "http://127.0.0.1:5174",
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
      command: "cargo run --manifest-path ../server/Cargo.toml --bin videoflow-runtime-fixture",
      url: "http://127.0.0.1:8789/health",
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        VIDEOFLOW_PORT: "8789",
        VIDEOFLOW_DB: ".e2e/conversations.sqlite",
        VIDEOFLOW_PRODUCT_DB: ".e2e/product.sqlite",
      },
    },
    {
      command: "pnpm dev -- --port 5174 --strictPort",
      url: "http://127.0.0.1:5174",
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        VIDEOFLOW_API_TARGET: "http://127.0.0.1:8789",
      },
    },
  ],
});
