import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import {
  decodeSessionBuffer,
  parseSessionText,
  discoverSessions,
  readSessionFile,
} from "../src/core/session-reader.mjs";
import { writeSyntheticSession, sessionHeader, assistantEvent } from "./helpers.mjs";

const tempDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test("解密多帧 zstd 容器：可跨帧拼接并解析事件", () => {
  const header = sessionHeader({ id: "session-frames" });
  const events = [
    assistantEvent({ time: 1_700_000_001_000, inputTokens: 100, outputTokens: 10 }),
    assistantEvent({ time: 1_700_000_002_000, inputTokens: 200, outputTokens: 20 }),
  ];
  const buffer = Buffer.concat([header, ...events].map((line) => zstdCompressSync(Buffer.from(`${line}\n`, "utf8"))));
  const parsed = parseSessionText(decodeSessionBuffer(buffer));
  assert.equal(parsed.header.id, "session-frames");
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[1].type, "assistant/message");
});

test("明文 JSONL 直接解析，跳过损坏行", () => {
  const text = [
    sessionHeader({ id: "session-plain" }),
    '{"type":"assistant/message","data":{"usage":{"inputTokens":1,"outputTokens":1}}}',
    "{not-json",
    "",
  ].join("\n");
  const parsed = parseSessionText(decodeSessionBuffer(Buffer.from(text, "utf8")));
  assert.equal(parsed.header.id, "session-plain");
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.skipped, 1);
});

test("尾部明文行不影响解码（不抛错、不丢帧）", () => {
  const root = tempDir("cockpit-tail-");
  const { path } = writeSyntheticSession(root, {
    lines: [sessionHeader({ id: "session-tail" }), assistantEvent({ time: 1_700_000_003_000, inputTokens: 5, outputTokens: 5 })],
  });
  const parsed = readSessionFile(path);
  assert.equal(parsed.header.id, "session-tail");
  assert.ok(parsed.events.length >= 1);
});

test("discoverSessions 只认 session.v*.jsonl(.zstd) 且有界", () => {
  const root = tempDir("cockpit-discover-");
  writeSyntheticSession(root, { sessionId: "session-a", version: 4 });
  writeSyntheticSession(root, { sessionId: "session-b", version: 3, projectSlug: "--other--" });
  mkdirSync(join(root, "--noise--", "session-x"), { recursive: true });
  writeFileSync(join(root, "--noise--", "session-x", "notes.txt"), "ignore me");
  writeFileSync(join(root, "--noise--", "session-x", "session.v4.jsonl"), `${sessionHeader({ id: "plain" })}\n`);

  const { sessions, stats } = discoverSessions(root);
  assert.equal(sessions.length, 3);
  assert.ok(stats.bytes > 0);
  assert.ok(sessions.every((item) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(item.path.split(/[\\/]/).pop())));
});

test("缺失目录返回空结果而非抛错", () => {
  const { sessions } = discoverSessions(join(tempDir("cockpit-missing-"), "nope"));
  assert.deepEqual(sessions, []);
});
