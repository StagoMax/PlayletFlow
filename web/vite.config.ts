import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const apiTarget = env.VIDEOFLOW_API_TARGET?.trim() || "http://127.0.0.1:8788";

  return {
    plugins: [react()],
    server: {
      watch: {
        // Playwright writes HTML reports and traces inside the web workspace.
        // They are build artifacts, not application inputs, and watching them
        // causes Vite to force unrelated full-page reloads during test runs.
        ignored: ["**/.e2e/**", "**/test-results/**", "**/playwright-report/**"],
      },
      proxy: {
        "/api": apiTarget,
        "/health": apiTarget,
      },
    },
  };
});
