/** 测试夹具：构造合成的 DSH 会话文件（多帧 zstd 容器），不含任何真实数据。 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

export function encodeFrames(lines) {
  return Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(`${line}\n`, "utf8"))));
}

export function sessionHeader({ id = "session-synthetic", version = 4, createdAt = 1_700_000_000_000, cwd = "C:/synthetic/workspace" } = {}) {
  return JSON.stringify({ type: "session", version, id, createdAt, cwd, isSeeded: false, delegationDepth: 0, agentPreset: "standard" });
}

export function contextEvent({ provider = "deepseek-official", model = "deepseek-flash", contextWindow = 1_000_000, time = 1_700_000_000_100 } = {}) {
  return JSON.stringify({ type: "request/context", seq: 1, time, data: { provider, model, contextWindow, systemPromptUpdate: "in-history" } });
}

export function assistantEvent({ time, inputTokens, cacheReadTokens = 0, cacheWriteTokens = 0, outputTokens = 0, model = "deepseek-flash", provider = "deepseek-official", includeUsage = true }) {
  const data = {
    turn: 1,
    step: 1,
    message: { role: "assistant", content: [{ type: "text", text: "[synthetic]" }], source: { kind: "model", provider, model }, id: `msg-${time}` },
  };
  if (includeUsage) {
    const totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
    data.usage = { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, totalTokens, reasoningTokens: 0 };
  }
  return JSON.stringify({ type: "assistant/message", seq: 2, time, data });
}

export function toolEvent({ time, name = "pwsh" }) {
  return JSON.stringify({ type: "tool/call", seq: 3, time, data: { turn: 1, step: 1, callId: "call-1", name, arguments: "{}" } });
}

export function compactionEvent({ time, shadowedTokenCount = 12_000 }) {
  return JSON.stringify({ type: "compaction/prune", seq: 4, time, data: { shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1], shadowedTokenCount } });
}

export function titleEvent({ time, title = "合成会话" }) {
  return JSON.stringify({ type: "session/title", seq: 5, time, data: { title, messageSeqs: [9], source: { kind: "fallback" } } });
}

/**
 * 写入一个合成会话文件。
 * @param {string} sessionsRoot
 * @param {{projectSlug?: string, sessionId?: string, version?: number, lines?: string[], tail?: boolean}} options
 */
export function writeSyntheticSession(sessionsRoot, options = {}) {
  const projectSlug = options.projectSlug ?? "--synthetic-workspace--";
  const sessionId = options.sessionId ?? "session-synthetic";
  const version = options.version ?? 4;
  const dir = join(sessionsRoot, projectSlug, sessionId);
  mkdirSync(dir, { recursive: true });
  const lines = options.lines ?? [sessionHeader({ version, id: sessionId })];
  const frames = encodeFrames(lines);
  const tail = options.tail === false ? Buffer.alloc(0) : Buffer.from('{"type":"session/end-seed","seq":99,"time":1700000009999,"data":{}}\n', "utf8");
  const path = join(dir, `session.v${version}.jsonl.zstd`);
  writeFileSync(path, Buffer.concat([frames, tail]));
  return { path, dir, projectSlug, sessionId };
}
