/**
 * HTTP 服务 v2：本地只读观测器的唯一出口。
 * - 只绑定 127.0.0.1；同一 handler 既服务 CLI 独立端口，也服务 DSH 插件子路径（mountBase）；
 * - 新增 v2 路由：tasks / projects / subagents / insights / calendar / notifications / backup / restore / comfort(GET)；
 * - 旧路由全部保留（v1 客户端兼容）。
 */
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStatus,
  buildBalanceReport,
  buildAccountReport,
  buildTasks,
  buildProjects,
  buildSubagents,
  buildInsightsReport,
  buildCalendarReport,
  buildNotificationsReport,
  markNotificationsRead,
  buildHistoryReport,
  buildReceipt,
  buildBackup,
  restoreBackup,
} from "./core/index.mjs";
import { loadConfig, saveConfig, recordComfort, loadComfort } from "./core/config.mjs";
import { createSyncClientFromConfig, buildSnapshotFromStatus, mergeRemote, isSyncEnabled } from "./sync/client.mjs";
import { buildTeamReport } from "./sync/team.mjs";
import { DEFAULT_PRICING, PRICING_REFERENCE_DATE, PRICING_VERSION } from "./core/pricing.mjs";
import { asCockpitError } from "./core/errors.mjs";

const JSON_LIMIT_BYTES = 512 * 1024;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function projectRoot() {
  return join(fileURLToPath(new URL("..", import.meta.url)), ".");
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendError(res, statusCode, error) {
  sendJson(res, statusCode, { ok: false, error: asCockpitError(error).toJSON() });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_LIMIT_BYTES) {
      const error = new Error("请求体过大");
      error.code = "PAYLOAD_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

function boolParam(value, fallback) {
  if (value === null) return fallback;
  return value === "1" || value === "true";
}

/** 从 query 提取范围/筛选参数（API v2 通用）。 */
function queryOptions(url) {
  const q = url.searchParams;
  return {
    range: q.get("range") ?? undefined,
    from: q.get("from") ?? undefined,
    to: q.get("to") ?? undefined,
    model: q.get("model") ?? undefined,
    project: q.get("project") ?? undefined,
    task: q.get("task") ?? undefined,
    includeSubagents: boolParam(q.get("includeSubagents"), true),
    q: q.get("q") ?? undefined,
    sort: q.get("sort") ?? undefined,
    order: q.get("order") ?? undefined,
    page: q.get("page") ?? undefined,
    pageSize: q.get("pageSize") ?? undefined,
    month: q.get("month") ?? undefined,
    tasks: q.get("tasks") ?? undefined,
    models: q.get("models") ?? undefined,
    title: q.get("title") ?? undefined,
    days: q.get("days") ?? undefined,
  };
}

function effectiveConfigPayload(config) {
  return {
    schemaVersion: config.schemaVersion,
    budget: config.budget,
    pricing: { ...DEFAULT_PRICING, ...config.pricing },
    pricingOverrides: config.pricing,
    pricingPolicy: config.pricingPolicy,
    estimation: config.estimation,
    pricingMeta: {
      version: PRICING_VERSION,
      referenceDate: PRICING_REFERENCE_DATE,
      currency: "CNY",
      unit: "per 1M tokens",
      timeZone: "Asia/Shanghai",
      peakWindows: config.pricingPolicy.peakWindows,
      peakWeekdays: config.pricingPolicy.peakWeekdays,
      idleRatio: config.pricingPolicy.idleRatio,
      notes: [
        "价格为高峰价；空闲时段（周末/节假日全天、工作日 12:00–14:00 与 18:00–次日 09:00）× 0.5",
        "缓存命中价对应 usage.cacheReadTokens；未命中输入对应 usage.inputTokens",
        "Search/Fetch 按官方每 1000 次 5 元单独计费，本地会话事件不含该信息，未计入",
      ],
    },
    ui: config.ui,
    notify: config.notify,
    sync: config.sync,
    comfort: config.comfort,
    server: config.server,
  };
}

/**
 * @param {{rootDir?: string, mountBase?: string, env?: NodeJS.ProcessEnv, now?: () => number, fetchImpl?: Function}} [options]
 */
export function createRequestHandler(options = {}) {
  const rootDir = options.rootDir ?? projectRoot();
  const mountBase = (options.mountBase ?? "").replace(/\/$/, "");
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const webRoot = join(rootDir, "web");

  return async function handler(req, res) {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let pathname = url.pathname;
      if (mountBase && pathname.startsWith(mountBase)) pathname = pathname.slice(mountBase.length) || "/";

      if (pathname.startsWith("/api/")) {
        if (req.method === "POST" && !originAllowed(req)) {
          sendJson(res, 403, { ok: false, error: { code: "ORIGIN_FORBIDDEN", message: "仅允许本机来源" } });
          return;
        }
        await handleApi({ req, res, url, pathname, env, now, fetchImpl: options.fetchImpl });
        return;
      }
      serveStatic({ res, pathname, webRoot, mountBase });
    } catch (error) {
      const normalized = asCockpitError(error);
      const statusCode = normalized.code === "PAYLOAD_TOO_LARGE" ? 413 : 500;
      if (!res.headersSent) sendError(res, statusCode, normalized);
      else res.end();
    }
  };
}

async function handleApi({ req, res, url, pathname, env, now, fetchImpl }) {
  const method = req.method ?? "GET";
  const base = { env, nowMs: now(), fetchImpl };

  if (pathname === "/api/status" && method === "GET") {
    const force = url.searchParams.get("force") === "1";
    const refreshBalance = url.searchParams.get("refresh") === "1";
    sendJson(res, 200, await buildStatus({ ...base, force, refreshBalance, refreshAccount: refreshBalance, ...queryOptions(url) }));
    return;
  }

  if (pathname === "/api/account" && method === "GET") {
    const refresh = url.searchParams.get("refresh") === "1";
    sendJson(res, 200, await buildAccountReport({ env, nowMs: now(), fetchImpl, refresh }));
    return;
  }

  if (pathname === "/api/balance" && method === "GET") {
    const refresh = url.searchParams.get("refresh") === "1";
    sendJson(res, 200, await buildBalanceReport({ env, nowMs: now(), fetchImpl, refresh }));
    return;
  }

  if (pathname === "/api/history" && method === "GET") {
    const options = queryOptions(url);
    sendJson(res, 200, await buildHistoryReport({ ...base, ...options }));
    return;
  }

  if (pathname === "/api/tasks" && method === "GET") {
    sendJson(res, 200, await buildTasks({ ...base, ...queryOptions(url) }));
    return;
  }

  if (pathname === "/api/projects" && method === "GET") {
    sendJson(res, 200, await buildProjects({ ...base, ...queryOptions(url) }));
    return;
  }

  if (pathname === "/api/subagents" && method === "GET") {
    sendJson(res, 200, await buildSubagents({ ...base, ...queryOptions(url) }));
    return;
  }

  if (pathname === "/api/insights" && method === "GET") {
    sendJson(res, 200, await buildInsightsReport({ ...base, ...queryOptions(url) }));
    return;
  }

  if (pathname === "/api/calendar" && method === "GET") {
    sendJson(res, 200, await buildCalendarReport({ ...base, ...queryOptions(url) }));
    return;
  }

  if (pathname === "/api/riskmap" && method === "GET") {
    const status = await buildStatus({ ...base, ...queryOptions(url) });
    sendJson(res, 200, { range: status.range, riskMap: status.riskMap });
    return;
  }

  if (pathname === "/api/comfort" && method === "GET") {
    const status = await buildStatus({ ...base, ...queryOptions(url) });
    sendJson(res, 200, { entries: loadComfort(env).entries, ...status.comfort });
    return;
  }

  if (pathname === "/api/comfort" && method === "POST") {
    const body = await readJsonBody(req);
    const level = Number(body?.level);
    if (!Number.isFinite(level) || level < 1 || level > 5) {
      sendJson(res, 400, { ok: false, error: { code: "INVALID_LEVEL", message: "level 必须为 1..5" } });
      return;
    }
    recordComfort({ level, note: body?.note ?? "", date: body?.date, nowMs: now() }, env);
    sendJson(res, 200, { ok: true, entries: loadComfort(env).entries });
    return;
  }

  if (pathname === "/api/notifications" && method === "GET") {
    sendJson(res, 200, await buildNotificationsReport({ ...base, ...queryOptions(url) }));
    return;
  }

  if (pathname === "/api/notifications/read" && method === "POST") {
    const body = await readJsonBody(req);
    sendJson(res, 200, markNotificationsRead({ ids: Array.isArray(body?.ids) ? body.ids : [], all: body?.all === true }, env));
    return;
  }

  if (pathname === "/api/receipt" && method === "GET") {
    sendJson(res, 200, await buildReceipt({ ...base, ...queryOptions(url) }));
    return;
  }

  if (pathname === "/api/receipt" && method === "POST") {
    const body = await readJsonBody(req);
    sendJson(res, 200, await buildReceipt({ ...base, ...body }));
    return;
  }

  if (pathname === "/api/backup" && method === "GET") {
    sendJson(res, 200, buildBackup({ env, nowMs: now() }));
    return;
  }

  if (pathname === "/api/restore" && method === "POST") {
    const body = await readJsonBody(req);
    sendJson(res, 200, restoreBackup({ payload: body, env }));
    return;
  }

  if (pathname === "/api/config" && method === "GET") {
    sendJson(res, 200, effectiveConfigPayload(loadConfig(env).config));
    return;
  }

  if (pathname === "/api/config" && method === "POST") {
    const body = await readJsonBody(req);
    const current = loadConfig(env).config;
    const merged = {
      ...current,
      budget: { ...current.budget, ...(body?.budget ?? {}) },
      ui: { ...current.ui, ...(body?.ui ?? {}) },
      notify: { ...current.notify, ...(body?.notify ?? {}) },
      sync: { ...current.sync, ...(body?.sync ?? {}) },
      comfort: { ...current.comfort, ...(body?.comfort ?? {}) },
      pricing: body?.pricing ?? current.pricing,
      pricingPolicy: { ...current.pricingPolicy, ...(body?.pricingPolicy ?? {}) },
    };
    sendJson(res, 200, { ok: true, config: effectiveConfigPayload(saveConfig(merged, env)) });
    return;
  }

  if (pathname === "/api/rescan" && method === "POST") {
    const started = Date.now();
    await buildStatus({ ...base, force: true });
    sendJson(res, 200, { ok: true, durationMs: Date.now() - started });
    return;
  }

  if (pathname === "/api/health" && method === "GET") {
    const status = await buildStatus({ ...base, force: false });
    sendJson(res, 200, { ok: true, health: status.health, warnings: status.warnings, versions: status.versions });
    return;
  }

  if (pathname === "/api/sync/status" && method === "GET") {
    const { config } = loadConfig(env);
    const enabled = isSyncEnabled(config);
    sendJson(res, 200, {
      ok: true,
      enabled,
      endpoint: config.sync?.endpoint ?? "",
      spaceLabel: config.sync?.spaceLabel ?? "",
      deviceId: config.sync?.deviceId ?? "",
      deviceName: config.sync?.deviceName ?? "",
      autoPush: config.sync?.autoPush === true,
      hasToken: typeof env.DSH_COCKPIT_SYNC_TOKEN === "string" && env.DSH_COCKPIT_SYNC_TOKEN.length > 0,
      tokenEnv: "DSH_COCKPIT_SYNC_TOKEN",
      reason: enabled ? null : "SYNC_DISABLED",
    });
    return;
  }

  if (["/api/sync/push", "/api/sync/pull", "/api/sync/enroll"].includes(pathname) && method === "POST") {
    const { config } = loadConfig(env);
    try {
      const client = createSyncClientFromConfig(config, { fetchImpl, env });
      if (pathname === "/api/sync/push") {
        const status = await buildStatus({ ...base, range: "7d" });
        const snapshot = buildSnapshotFromStatus(status);
        const pushed = await client.push(snapshot);
        sendJson(res, 200, {
          ok: true,
          pushed,
          snapshotMeta: { days: snapshot.days.length, models: snapshot.models.length, _ts: snapshot._ts },
        });
        return;
      }
      if (pathname === "/api/sync/pull") {
        const rows = await client.pull();
        const merged = mergeRemote(rows);
        sendJson(res, 200, { ok: true, devices: Object.keys(merged.byDevice).length, totals: merged.totals, byDevice: merged.byDevice });
        return;
      }
      const body = await readJsonBody(req);
      const enrolled = await client.enroll({ inviteCode: body?.inviteCode, displayName: body?.displayName, deviceId: body?.deviceId });
      sendJson(res, 200, { ok: true, ...enrolled });
      return;
    } catch (error) {
      const code = error?.code ?? "SYNC_ERROR";
      const statusCode = code === "SYNC_DISABLED" ? 409 : String(code).startsWith("SYNC_INVALID") ? 400 : 502;
      sendJson(res, statusCode, { ok: false, error: { code, message: error?.message ?? String(error) } });
      return;
    }
  }

  if (pathname === "/api/sync/members" && method === "GET") {
    const { config } = loadConfig(env);
    try {
      const localStatus = await buildStatus({ ...base });
      const report = await buildTeamReport({ config, env, fetchImpl, localStatus, nowMs: now() });
      sendJson(res, 200, { ok: true, ...report });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: { code: error?.code ?? "SYNC_ERROR", message: error?.message ?? String(error) } });
    }
    return;
  }

  if (["/api/sync/members/rename", "/api/sync/members/remove", "/api/sync/space", "/api/sync/shared", "/api/sync/dayplan"].includes(pathname)) {
    const { config } = loadConfig(env);
    try {
      const body = method === "POST" || method === "PUT" ? await readJsonBody(req) : {};
      const client = createSyncClientFromConfig(config, { fetchImpl, env });
      if (pathname === "/api/sync/members/rename" && method === "POST") {
        const result = await client.renameMember({ deviceId: body?.deviceId, displayName: body?.displayName });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      if (pathname === "/api/sync/members/remove" && method === "POST") {
        const result = await client.revoke(body?.deviceId);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      if (pathname === "/api/sync/space" && method === "GET") {
        const result = await client.getSpaceSettings();
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      if (pathname === "/api/sync/space" && method === "PUT") {
        const result = await client.saveSpaceSettings({ spaceName: body?.spaceName, plan: body?.plan });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      if (pathname === "/api/sync/shared" && method === "GET") {
        const result = await client.getSharedSettings();
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      if (pathname === "/api/sync/shared" && method === "PUT") {
        const result = await client.saveSharedSettings({ revision: body?.revision, settings: body?.settings });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      if (pathname === "/api/sync/dayplan" && method === "POST") {
        const result = await client.dailyPlan({ basis: body?.basis, initialRisk: body?.initialRisk ?? null, change: body?.change ?? null });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: `不支持的方法 ${method} ${pathname}` } });
      return;
    } catch (error) {
      const code = error?.code ?? "SYNC_ERROR";
      const statusCode = code === "SYNC_DISABLED" ? 409
        : String(code).startsWith("SYNC_INVALID") || code === "PLAN_INVALID" ? 400
        : code === "SETTINGS_CONFLICT" || code === "PLAN_CONFLICT" ? 409
        : code === "PLAN_PERSON_DENIED" ? 403
        : 502;
      sendJson(res, statusCode, { ok: false, error: { code, message: error?.message ?? String(error) } });
      return;
    }
  }

  sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `未知接口 ${method} ${pathname}` } });
}

function serveStatic({ res, pathname, webRoot, mountBase }) {
  const relative = pathname === "/" || pathname === "" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = normalize(join(webRoot, relative));
  if (!target.startsWith(webRoot.endsWith(sep) ? webRoot : `${webRoot}${sep}`)) {
    sendJson(res, 403, { ok: false, error: { code: "PATH_FORBIDDEN", message: "非法路径" } });
    return;
  }
  if (!existsSync(target)) {
    sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "资源不存在" } });
    return;
  }
  const ext = extname(target).toLowerCase();
  if (ext === ".html") {
    let html = readFileSync(target, "utf8");
    const inject = `<script>window.__COCKPIT_BASE__=${JSON.stringify(mountBase)};</script>`;
    html = html.includes("</head>") ? html.replace("</head>", `${inject}\n</head>`) : `${inject}\n${html}`;
    const body = Buffer.from(html, "utf8");
    res.writeHead(200, { "Content-Type": MIME[".html"], "Content-Length": body.length, "Cache-Control": "no-cache" });
    res.end(body);
    return;
  }
  const body = readFileSync(target);
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "public, max-age=60",
  });
  res.end(body);
}

/**
 * 启动独立 HTTP 服务（CLI `serve`）。端口占用自动 +1 探测。
 * @returns {Promise<{server: import('node:http').Server, url: string, port: number}>}
 */
export async function startServer(options = {}) {
  const env = options.env ?? process.env;
  const config = loadConfig(env).config;
  const host = "127.0.0.1";
  const basePort = options.port ?? config.server.port ?? 7777;
  const handler = createRequestHandler({ rootDir: options.rootDir, mountBase: "", env, now: options.now, fetchImpl: options.fetchImpl });

  for (let offset = 0; offset < 10; offset += 1) {
    const port = basePort + offset;
    const server = createServer(handler);
    const ok = await new Promise((resolve) => {
      server.once("error", (error) => resolve({ ok: false, error }));
      server.listen(port, host, () => resolve({ ok: true }));
    });
    if (ok.ok) {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      return { server, url: `http://${host}:${actualPort}/`, port: actualPort };
    }
  }
  const { CockpitError, ERROR_CODES } = await import("./core/errors.mjs");
  throw new CockpitError(ERROR_CODES.PORT_UNAVAILABLE, `端口 ${basePort}-${basePort + 9} 均被占用`);
}
