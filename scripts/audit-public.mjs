#!/usr/bin/env node
/**
 * 发布前防泄漏审计（复刻参考产品 `scripts/audit-public.mjs` 的思路）。
 * 检查：真实本机路径 / 真实会话 id / API key / 二进制会话文件 / 超大文件。
 * 任何命中 → exit 1。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".git", "docs", ".cockpit-smoke"]);
const SKIP_EXT = new Set([".png", ".ico", ".woff2", ".zstd", ".zip", ".pdf"]);
const MAX_BYTES = 2 * 1024 * 1024;

const RULES = [
  { id: "HOME_PATH", pattern: /[A-Za-z]:\\Users\\[^\\\s"']+/g, hint: "本机绝对路径" },
  { id: "POSIX_HOME", pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+\//g, hint: "本机绝对路径（POSIX）" },
  { id: "SESSION_ID", pattern: /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, hint: "真实会话 id" },
  { id: "API_KEY", pattern: /sk-[A-Za-z0-9]{16,}/g, hint: "疑似 API Key" },
  { id: "ZSTD_SESSION", pattern: /session\.v\d+\.jsonl\.zstd/g, hint: "真实会话文件引用" },
];

const findings = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    const stat = statSync(path);
    const rel = relative(ROOT, path).replaceAll("\\", "/");
    if (stat.size > MAX_BYTES) findings.push({ rule: "BIG_FILE", file: rel, detail: `${stat.size} bytes` });
    const ext = extname(entry.name).toLowerCase();
    if (SKIP_EXT.has(ext)) continue;
    if (stat.size > 512 * 1024) continue;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const rule of RULES) {
      const matches = text.match(rule.pattern);
      if (matches) {
        findings.push({ rule: rule.id, file: rel, detail: `${rule.hint}（${[...new Set(matches)].slice(0, 3).join(", ")}）` });
      }
    }
  }
}

walk(ROOT);

if (findings.length === 0) {
  console.log("audit:public 通过：未发现真实路径/会话 id/密钥/超大文件。");
  process.exit(0);
}

console.error(`audit:public 失败：${findings.length} 处可疑内容`);
for (const finding of findings) console.error(`  [${finding.rule}] ${finding.file} — ${finding.detail}`);
process.exit(1);
