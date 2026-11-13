import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageFromBody, usageFromJson, modelFromRequestBody } from "../src/gateway/usage.mjs";
import { readGatewayRecords, summarizeGateway, gatewayLogPath } from "../src/gateway/log.mjs";
import { createGatewayServer, normalizeGatewayConfig } from "../src/gateway/server.mjs";

const OPENAI_JSON = JSON.stringify({
  id: "chatcmpl-1",
  model: "deepseek-flash",
  usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 400 } },
  choices: [{ message: { content: "hi" } }],
});
const ANTHROPIC_JSON = JSON.stringify({
  type: "message",
  model: "deepseek-v4-pro",
  usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
});
const OPENAI_SSE = [
  'data: {"choices":[{"delta":{"content":"hi"}}]}',
  "",
  'data: {"model":"deepseek-flash","usage":{"prompt_tokens":300,"completion_tokens":50,"total_tokens":350}}',
  "",
  "data: [DONE]",
  "",
].join("\n");
const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1,"cache_read_input_tokens":50}}}',
  "",
  'event: message_delta',
  'data: {"type":"message_delta","usage":{"output_tokens":80}}',
  "",
].join("\n");

test("usage 解析：OpenAI/Anthropic JSON + 流式 SSE；缺失返回 null", () => {
  const openai = usageFromJson(JSON.parse(OPENAI_JSON));
  assert.equal(openai.format, "openai");
  assert.equal(openai.inputTokens, 600); // prompt 1000 - cached 400
  assert.equal(openai.cacheReadTokens, 400);
  assert.equal(openai.outputTokens, 200);
  assert.equal(openai.totalTokens, 1200);

  const anthropic = usageFromJson(JSON.parse(ANTHROPIC_JSON));
  assert.equal(anthropic.format, "anthropic");
  assert.equal(anthropic.inputTokens, 500);
  assert.equal(anthropic.cacheReadTokens, 200);
  assert.equal(anthropic.outputTokens, 100);

  assert.equal(usageFromBody(OPENAI_SSE).inputTokens, 300);
  assert.equal(usageFromBody(ANTHROPIC_SSE).inputTokens, 100);
  assert.equal(usageFromBody(ANTHROPIC_SSE).cacheReadTokens, 50);
  assert.equal(usageFromBody("data: [DONE]"), null);
  assert.equal(usageFromBody("not json"), null);
  assert.equal(modelFromRequestBody(OPENAI_JSON), "deepseek-flash");
});

test("网关注入：精确 usage 落盘、凭据不落盘、成本标推算", async () => {
  const env = { DSH_COCKPIT_HOME: mkdtempSync(join(tmpdir(), "cockpit-gw-")) };
  const upstream = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer sk-secret-test");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(OPENAI_JSON);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const gateway = createGatewayServer({ env, config: { enabled: true, upstreams: [{ name: "mock", origin: `http://127.0.0.1:${upstreamPort}` }] } });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const gatewayPort = gateway.server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/u/mock/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-secret-test" },
      body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.usage.prompt_tokens, 1000);

    const records = readGatewayRecords(env);
    assert.equal(records.length, 1);
    assert.equal(records[0].provider, "mock");
    assert.equal(records[0].usage.inputTokens, 600);
    assert.equal(records[0].usage.outputTokens, 200);
    const logText = readFileSync(gatewayLogPath(env), "utf8");
    assert.ok(!logText.includes("sk-secret-test"), "日志不得包含 Authorization");

    const summary = summarizeGateway(records, { nowMs: Date.now() });
    assert.equal(summary.requests, 1);
    assert.equal(summary.tokens.total, 1200);
    assert.equal(summary.unknownUsage, 0);
    assert.ok(summary.costCny > 0);
    assert.equal(summary.costEstimated, true);
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(env.DSH_COCKPIT_HOME, { recursive: true, force: true });
  }
});

test("网关配置归一：只允许回环监听与 https/本机上游", () => {
  const normalized = normalizeGatewayConfig({
    enabled: true,
    host: "0.0.0.0",
    port: 20,
    upstreams: [{ name: "bad name", origin: "ftp://x" }, { name: "ok", origin: "https://api.deepseek.com/" }],
  });
  assert.equal(normalized.host, "127.0.0.1");
  assert.equal(normalized.port, 7891);
  assert.deepEqual(normalized.upstreams, [{ name: "ok", origin: "https://api.deepseek.com" }]);
});
