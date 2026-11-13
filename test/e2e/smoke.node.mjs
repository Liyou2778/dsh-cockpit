#!/usr/bin/env node
/**
 * 纯 Node E2E 冒烟（不依赖浏览器）：fetch 页面与关键 API，断言 DOM 关键 id 存在。
 *
 * 用途：Playwright/浏览器不可用时的可执行替代；也可在 CI 手动 e2e job 中快跑。
 *
 *   node test/e2e/smoke.node.mjs [--strict]
 *
 * 退出码：0 = 通过（v2 API 未就绪时打印 WARN 但仍通过）；1 = 页面/核心 API/DOM id 不满足。
 * --strict：v2 新 API 也必须是 200，否则失败（用于 v2 落地后的门禁）。
 *
 * 隔离：DSH_HOME / DSH_COCKPIT_HOME 默认落在系统临时目录 dsh-cockpit-e2e/，绝不触碰真实 ~/.dsh。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { e2ePaths, seed } from "./seed.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = Number.parseInt(process.env.E2E_PORT ?? "7811", 10);
const BASE = `http://127.0.0.1:${PORT}`;
const STRICT = process.argv.includes("--strict");
const REQUIRED_IDS = ["main", "ring-quota", "ring-ctx", "receipt-btn", "settings-btn", "drawer", "toast"];
const V2_APIS = [
  "/api/tasks?range=7d",
  "/api/projects?range=7d",
  "/api/subagents?range=7d",
  "/api/insights?range=7d",
  "/api/calendar",
  "/api/notifications",
  "/api/backup",
];

const failures = [];
const warnings = [];
const passes = [];

function ok(message) {
  passes.push(message);
  console.log(`✓ ${message}`);
}

function fail(message) {
  failures.push(message);
  console.error(`✗ ${message}`);
}

function warn(message) {
  warnings.push(message);
  console.warn(`⚠ ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(path) {
  const response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { response, body, text };
}

function assert(condition, message) {
  if (condition) ok(message);
  else fail(message);
}

async function waitForServer(child) {
  const deadline = Date.now() + 45_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`serve 进程提前退出（code=${child.exitCode}）`);
    try {
      const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(250);
  }
  throw new Error(`等待 ${BASE}/api/health 超时：${lastError}`);
}

async function checkPage() {
  const response = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(15_000) });
  assert(response.ok, `GET / 返回 200（实际 ${response.status}）`);
  const html = await response.text();
  assert(/<title>[^<]*驾驶舱[^<]*<\/title>/i.test(html), "页面标题包含「驾驶舱」");
  for (const id of REQUIRED_IDS) {
    assert(html.includes(`id="${id}"`), `DOM 关键 id 存在：#${id}`);
  }
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((match) => match[1]);
  assert(scripts.length > 0, `页面包含入口脚本（${scripts.length} 个）`);
  for (const src of scripts) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) continue;
    const scriptPath = src.startsWith("/") ? src : `/${src.replace(/^\.\//, "")}`;
    const scriptResponse = await fetch(`${BASE}${scriptPath}`, { signal: AbortSignal.timeout(15_000) });
    assert(scriptResponse.ok, `入口脚本可访问：${src}（HTTP ${scriptResponse.status}）`);
  }
}

async function checkCoreApis() {
  const status = await fetchJson("/api/status");
  const body = status.body ?? {};
  assert(status.response.ok, `/api/status 返回 200（实际 ${status.response.status}）`);
  assert(Boolean(body.quota) && Boolean(body.pace) && Boolean(body.plan) && Boolean(body.forecast), "status 含 quota/pace/plan/forecast");
  assert(body.health?.errors === 0, `status.health.errors === 0（实际 ${body.health?.errors}）`);
  assert(typeof body.totals?.cycleTokens === "number", "status.totals.cycleTokens 为数字");

  const history = await fetchJson("/api/history?days=7");
  assert(history.response.ok && Array.isArray(history.body?.days), "/api/history 返回 days 数组");

  const receipt = await fetchJson("/api/receipt");
  assert(receipt.response.ok && Array.isArray(receipt.body?.lines), "/api/receipt 返回 lines 数组");

  const config = await fetchJson("/api/config");
  assert(config.response.ok && typeof config.body === "object", "/api/config 可读取");
}

async function checkV2Apis() {
  for (const path of V2_APIS) {
    const { response, body } = await fetchJson(path);
    if (!response.ok) {
      const message = `v2 API 未就绪：GET ${path} → HTTP ${response.status}`;
      if (STRICT) fail(message);
      else warn(`${message}（--strict 时失败）`);
      continue;
    }
    if (body && body.ok === false) {
      fail(`v2 API 返回业务错误：GET ${path} → ${body.error?.code ?? "UNKNOWN"}`);
      continue;
    }
    const hasPayload = payloadLooksConsumable(body);
    assert(Boolean(hasPayload), `v2 API 返回可消费载荷：GET ${path}`);
  }
}

/** v2 API 的载荷形态各不相同：数组字段 / 备份 schemaVersion / 范围回显 任一即可。 */
function payloadLooksConsumable(body) {
  if (!body || typeof body !== "object") return false;
  if (body.ok === true) return true;
  if (typeof body.schemaVersion === "number") return true;
  if (body.range) return true;
  const arrayFields = ["items", "days", "alerts", "lines", "snapshots", "devices", "entries"];
  return arrayFields.some((field) => Array.isArray(body[field]));
}

async function main() {
  const { dshHome, cockpitHome } = e2ePaths();
  const seeded = seed();
  console.log(`seed：${seeded.sessions} 个合成会话 → ${dshHome}`);
  console.log(`cockpit home：${cockpitHome}`);
  const child = spawn(process.execPath, ["src/cli.mjs", "serve", "--port", String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: dshHome, DSH_COCKPIT_HOME: cockpitHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stdout.on("data", (chunk) => {
    serverLog += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    serverLog += chunk.toString();
  });
  const stop = () => {
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  try {
    await waitForServer(child);
    ok(`本地服务就绪：${BASE}`);
    await checkPage();
    await checkCoreApis();
    await checkV2Apis();
  } catch (error) {
    fail(`冒烟异常：${error.message}`);
    if (serverLog.trim()) console.error(`— serve 日志 —\n${serverLog.trim().slice(-2_000)}`);
  } finally {
    stop();
    await sleep(300);
  }

  console.log(`\nsmoke 结果：${passes.length} 通过 / ${warnings.length} 告警 / ${failures.length} 失败`);
  if (failures.length > 0) {
    console.error("smoke 失败：E2E 契约未满足。");
    process.exit(1);
  }
  process.exit(0);
}

await main();
