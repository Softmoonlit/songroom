import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  webServer: {
    command: "pnpm exec vite build && pnpm exec tsx tests/start-app.ts",
    url: "http://127.0.0.1:3210/healthz",
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe"
  },
  use: {
    baseURL: "http://127.0.0.1:3210",
    trace: "retain-on-failure",
    browserName: "chromium"
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } }
  ]
});
