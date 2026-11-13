/**
 * DSH 会话读取器（只读）。
 *
 * 格式（实测，119 个会话验证）：
 *   ~/.dsh/sessions/<workspace-slug>/<session-dir>/session.v{3,4}.jsonl[.zstd]
 *   .zstd 文件是「连续多个 zstd 帧」的 append-batch 容器（单文件可达 2269 帧），
 *   尾部可能跟随明文 JSON 行；因此不能用一次性 zstdDecompress，必须逐帧游走。
 *
 * 设计约束（PRD FR-1）：
 *   - 绝不写入 DSH 目录；
 *   - 有界：最多 4000 文件，单文件上限 64MB，超限跳过并计数；
 *   - 单文件失败不影响全局。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { CockpitError, ERROR_CODES } from "./errors.mjs";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
export const SESSION_FILE_PATTERN = /^session\.v(\d+)\.jsonl(\.zstd)?$/;
export const MAX_SESSION_FILES = 4000;
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;

export function zstdAvailable() {
  return typeof zlib.zstdDecompressSync === "function";
}

function magicOffsets(buf) {
  const offsets = [];
  let index = 0;
  while ((index = buf.indexOf(ZSTD_MAGIC, index)) !== -1) {
    offsets.push(index);
    index += 4;
  }
  return offsets;
}

/**
 * 解码 zstd 多帧容器；兼容明文 JSONL。
 * @param {Buffer} buf
 * @returns {string}
 */
export function decodeSessionBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return "";
  if (!buf.subarray(0, 4).equals(ZSTD_MAGIC)) return buf.toString("utf8");

  if (!zstdAvailable()) {
    throw new CockpitError(
      ERROR_CODES.ZSTD_UNSUPPORTED,
      `当前 Node 不支持 zstd（需要 >=22.15）。当前版本：${process.version}`,
    );
  }

  const offsets = magicOffsets(buf);
  if (offsets.length === 0) return buf.toString("utf8");

  const parts = [];
  let frameIndex = 0;
  let index = 0;
  let failures = 0;

  while (index < offsets.length) {
    const start = offsets[index];
    let decoded = null;
    let nextIndex = index + 1;

    // 一帧的边界 = 下一个 magic；若解压失败（magic 出现在压缩数据内部），向后顺延重试。
    for (let probe = index + 1; probe <= Math.min(index + 3, offsets.length); probe += 1) {
      const end = probe < offsets.length ? offsets[probe] : buf.length;
      try {
        decoded = zlib.zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
        nextIndex = probe;
        break;
      } catch {
        /* 继续顺延 */
      }
    }

    if (decoded === null) {
      failures += 1;
      index += 1;
      continue;
    }
    parts.push(decoded);
    frameIndex += 1;
    index = nextIndex;
  }

  if (parts.length === 0) {
    throw new CockpitError(
      ERROR_CODES.SESSION_DECODE_FAILED,
      `会话文件解码失败（${failures} 个帧无法解析）`,
    );
  }
  return parts.join("");
}

/**
 * 解析 JSONL 文本。
 * @param {string} text
 * @returns {{header: object|null, events: object[], skipped: number}}
 */
export function parseSessionText(text) {
  const lines = text.split("\n");
  let header = null;
  const events = [];
  let skipped = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    if (value === null || typeof value !== "object" || typeof value.type !== "string") {
      skipped += 1;
      continue;
    }
    if (!header && value.type === "session") {
      header = value;
      continue;
    }
    events.push(value);
  }
  return { header, events, skipped };
}

/**
 * 读取单个会话文件。
 * @param {string} path
 * @param {{maxBytes?: number}} [options]
 */
export function readSessionFile(path, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_SESSION_BYTES;
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    throw new CockpitError(ERROR_CODES.SESSION_PARSE_FAILED, `会话文件不存在：${path}`);
  }
  if (stat.size > maxBytes) {
    throw new CockpitError(
      ERROR_CODES.SESSION_PARSE_FAILED,
      `会话文件过大已跳过（${Math.round(stat.size / 1024 / 1024)}MB > ${Math.round(maxBytes / 1024 / 1024)}MB）`,
    );
  }
  const buffer = readFileSync(path);
  const text = decodeSessionBuffer(buffer);
  const parsed = parseSessionText(text);
  return { ...parsed, bytes: buffer.length, mtimeMs: stat.mtimeMs, size: stat.size };
}

/**
 * 发现会话文件（有界递归，忽略符号链接）。
 * @param {string} root `~/.dsh/sessions`
 * @param {{maxFiles?: number}} [options]
 * @returns {{sessions: Array<{path:string,sessionId:string|null,projectSlug:string,version:number,compressed:boolean,size:number,mtimeMs:number}>, stats: {seen:number, skipped:number, bytes:number}}}
 */
export function discoverSessions(root, options = {}) {
  const maxFiles = options.maxFiles ?? MAX_SESSION_FILES;
  const sessions = [];
  const stats = { seen: 0, skipped: 0, bytes: 0 };
  if (!existsSync(root)) return { sessions, stats };

  const projects = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const project of projects) {
    const projectDir = join(root, project.name);
    let sessionDirs;
    try {
      sessionDirs = readdirSync(projectDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      stats.skipped += 1;
      continue;
    }
    for (const sessionDir of sessionDirs) {
      const dirPath = join(projectDir, sessionDir.name);
      let files;
      try {
        files = readdirSync(dirPath, { withFileTypes: true }).filter((entry) => entry.isFile());
      } catch {
        stats.skipped += 1;
        continue;
      }
      for (const file of files) {
        const match = SESSION_FILE_PATTERN.exec(file.name);
        if (!match) continue;
        stats.seen += 1;
        if (sessions.length >= maxFiles) {
          stats.skipped += 1;
          continue;
        }
        const path = join(dirPath, file.name);
        const stat = statSync(path, { throwIfNoEntry: false });
        if (!stat) {
          stats.skipped += 1;
          continue;
        }
        stats.bytes += stat.size;
        sessions.push({
          path,
          sessionId: sessionDir.name,
          projectSlug: project.name,
          version: Number.parseInt(match[1], 10),
          compressed: match[2] === ".zstd",
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  }
  sessions.sort((a, b) => a.path.localeCompare(b.path));
  return { sessions, stats };
}
