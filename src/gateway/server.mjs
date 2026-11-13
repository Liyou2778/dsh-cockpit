/**
 * 本机代理网关（GATEWAY_V1）：
 * - 只监听回环地址（127.0.0.1），用于让各类 AI 编程工具把 base_url 指过来；
 * - 转发请求/响应，**精确记录上游官方 usage**（缺失则 null，不估算）；
 * - 绝不记录 Authorization、请求/响应正文、工具参数；只落盘元数据 + usage。
 *
 * 用法：工具配置 base_url = http://127.0.0.1:7891/v1（单上游）
 *       或 http://127.0.0.1:7891/u/<name>/v1（多上游按名称路由）。
 */
import { createServer } from "node:http";
import { appendGatewayRecord, gatewayLogPath } from "./log.mjs";
import { modelFromRequestBody, usageFromBody } from "./usage.mjs";

export const GATEWAY_POLICY_VERSION = "GATEWAY_V1";
export const DEFAULT_GATEWAY_PORT = 7891;
export const DEFAULT_CAPTURE_LIMIT_BYTES = 2_097_152;
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const HOP_HEADERS = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "content-length", "accept-encoding"]);

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "localhost";
}

function validOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

export function normalizeGatewayConfig(config = {}) {
  const source = config && typeof config === "object" ? config : {};
  const upstreams = Array.isArray(source.upstreams)
    ? source.upstreams
        .filter((item) => item && typeof item.name === "string" && /^[a-z0-9-]{1,20}$/.test(item.name) && typeof item.origin === "string" && validOrigin(item.origin))
        .slice(0, 8)
        .map((item) => ({ name: item.name, origin: item.origin.replace(/\/+$/, "") }))
    : [];
  return {
    enabled: source.enabled === true,
    host: isLoopbackHost(source.host) ? source.host : "127.0.0.1",
    port: Number.isInteger(source.port) && source.port >= 1024 && source.port <= 65535 ? source.port : DEFAULT_GATEWAY_PORT,
    captureLimitBytes: Math.min(Math.max(Number(source.captureLimitBytes) || DEFAULT_CAPTURE_LIMIT_BYTES, 65_536), 8 * 1024 * 1024),
    upstreams: upstreams.length > 0 ? upstreams : [{ name: "deepseek", origin: "https://api.deepseek.com" }],
  };
}

function chooseUpstream(pathname, upstreams) {
  const match = /^\/u\/([a-z0-9-]{1,20})(\/.*)?$/.exec(pathname);
  if (match) {
    const found = upstreams.find((item) => item.name === match[1]);
    if (!found) return { error: { status: 404, message: `未知上游：${match[1]}` } };
    return { upstream: found, upstreamPath: match[2] || "/" };
  }
  return { upstream: upstreams[0], upstreamPath: pathname };
}

function forwardHeaders(req) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const key = name.toLowerCase();
    if (HOP_HEADERS.has(key)) continue;
    if (key === "authorization" || key === "x-api-key" || key === "anthropic-version") {
      headers[name] = value; // 只透传，不记录
      continue;
    }
    if (Array.isArray(value)) headers[name] = value.join(", ");
    else if (typeof value === "string") headers[name] = value;
  }
  headers["accept-encoding"] = "identity";
  return headers;
}

/** 启动网关。返回 { server, close, url }，供测试与 CLI 复用。 */
export function createGatewayServer({ env = process.env, config, record = true } = {}) {
  const gateway = normalizeGatewayConfig(config);
  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    const requestPath = new URL(req.url, "http://127.0.0.1").pathname + (req.url.includes("?") ? `?${req.url.split("?")[1]}` : "");
    const { upstream, upstreamPath, error } = chooseUpstream(new URL(req.url, "http://127.0.0.1").pathname, gateway.upstreams);
    if (error) {
      res.writeHead(error.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message, type: "gateway_error" } }));
      return;
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) throw new Error("请求体过大");
        chunks.push(chunk);
      }
    } catch (readError) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(readError?.message ?? readError), type: "gateway_error" } }));
      return;
    }
    const requestBody = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const modelHint = modelFromRequestBody(requestBody?.toString("utf8") ?? "");
    const target = `${upstream.origin}${upstreamPath}${requestPath.includes("?") ? `?${requestPath.split("?")[1]}` : ""}`;
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(target, {
        method: req.method,
        headers: forwardHeaders(req),
        body: requestBody,
        redirect: "manual",
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } catch (fetchError) {
      if (record) {
        appendGatewayRecord(env, {
          at: startedAt,
          provider: upstream.name,
          path: requestPath.split("?")[0],
          status: 502,
          stream: false,
          model: modelHint,
          usage: null,
          latencyMs: Date.now() - startedAt,
          error: { code: "UPSTREAM_ERROR", message: "上游请求失败" },
        });
      }
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "网关上游请求失败", type: "gateway_error" } }));
      return;
    }

    const headers = {};
    for (const [name, value] of upstreamResponse.headers.entries()) {
      const key = name.toLowerCase();
      if (HOP_HEADERS.has(key) || key === "content-encoding" || key === "set-cookie") continue;
      headers[name] = value;
    }
    headers["content-type"] ??= "application/json";
    res.writeHead(upstreamResponse.status, headers);

    const captured = [];
    let capturedBytes = 0;
    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    const streamed = contentType.includes("text/event-stream");
    if (upstreamResponse.body) {
      for await (const chunk of upstreamResponse.body) {
        res.write(chunk);
        if (capturedBytes < gateway.captureLimitBytes) {
          captured.push(Buffer.from(chunk));
          capturedBytes += chunk.length;
        }
      }
    }
    res.end();

    if (record) {
      const bodyText = Buffer.concat(captured).toString("utf8");
      const usage = usageFromBody(bodyText, modelHint);
      appendGatewayRecord(env, {
        at: startedAt,
        provider: upstream.name,
        path: requestPath.split("?")[0],
        status: upstreamResponse.status,
        stream: streamed,
        model: usage?.model ?? modelHint,
        usage: usage
          ? {
              inputTokens: usage.inputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
              outputTokens: usage.outputTokens,
              reasoningTokens: usage.reasoningTokens,
              totalTokens: usage.totalTokens,
            }
          : null,
        latencyMs: Date.now() - startedAt,
        error: null,
      });
    }
  });

  return {
    server,
    gateway,
    logPath: gatewayLogPath(env),
    url: `http://${gateway.host}:${gateway.port}`,
    start() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(gateway.port, gateway.host, () => resolve(`http://${gateway.host}:${gateway.port}`));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
