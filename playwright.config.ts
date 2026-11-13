/**
 * Playwright E2E 配置（DSH Cockpit）。
 *
 * 隔离策略：
 *   - DSH_HOME / DSH_COCKPIT_HOME 指向系统临时目录 <tmp>/dsh-cockpit-e2e/{dsh-home,cockpit-home}，
 *     绝不触碰真实 ~/.dsh；每次启动由 test/e2e/seed.mjs 重建合成数据。
 *   - 独立端口 7811，webServer 自行启动 `node src/cli.mjs serve --port 7811`。
 *   - 产物写入 .cockpit-e2e/（已被 .gitignore 中以 .cockpit- 开头的目录规则覆盖）。
 *
 * 本地运行：npx playwright install chromium；npx playwright test
 * 纯 Node 替代（无浏览器）：node test/e2e/smoke.node.mjs
 */
import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const E2E_ROOT = join(tmpdir(), "dsh-cockpit-e2e");
const DSH_HOME = join(E2E_ROOT, "dsh-home");
const COCKPIT_HOME = join(E2E_ROOT, "cockpit-home");
const PORT = Number.parseInt(process.env.E2E_PORT ?? "7811", 10);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const serverEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === "string") serverEnv[key] = value;
}
serverEnv.DSH_HOME = DSH_HOME;
serverEnv.DSH_COCKPIT_HOME = COCKPIT_HOME;
serverEnv.E2E_PORT = String(PORT);

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "./.cockpit-e2e/artifacts",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command: "node test/e2e/seed.mjs && node src/cli.mjs serve --port 7811",
    url: `${BASE_URL}/api/health`,
    cwd: ROOT,
    env: serverEnv,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
