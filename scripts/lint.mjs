#!/usr/bin/env node
/**
 * 零依赖 lint（DSH Cockpit）。
 *
 * 规则（全部本地、无网络、无第三方依赖）：
 *   R1 SYNTAX   src/ scripts/ web/ test/(根目录) dsh-plugin/ 下全部 .mjs/.js 通过 `node --check`
 *               （test/e2e/ 是 Playwright .ts 与纯 Node 冒烟，不纳入 Node 语法门禁）
 *   R2 FORBIDDEN 禁止 console.* / debugger / TODO|FIXME|XXX（白名单机制见 CONSOLE_ALLOW）
 *   R3 WIDTH    单行 ≤160 字符：本任务可维护文件为硬门禁；冻结只读文件（src/ web/ 等）仅告警
 *   R4 JSON     全部 *.json 可被 JSON.parse 解析
 *   R5 YAML     *.yml/*.yaml 子集结构检查（零依赖，不是完整 YAML 解析器）
 *   R6 HTML     web/index.html 引用的本地资源存在、id 不重复
 *
 * 退出码：0 = 通过（允许告警）；1 = 存在错误。--strict 时告警也视为失败。
 * 用法：node scripts/lint.mjs [--syntax-only] [--strict] [--help]
 *
 * 说明：playwright.config.ts 是 TypeScript，零依赖环境下不解析；由 Playwright 自身校验。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ARGS = new Set(process.argv.slice(2));
const STRICT = ARGS.has("--strict");
const SYNTAX_ONLY = ARGS.has("--syntax-only");
const MAX_WIDTH = 160;
const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", "test-results", "playwright-report", ".cache"]);

if (ARGS.has("--help") || ARGS.has("-h")) {
  console.log("用法：node scripts/lint.mjs [--syntax-only] [--strict]");
  console.log("  --syntax-only  只跑 node --check（CI 的语法门禁）");
  console.log("  --strict       行宽告警也视为失败（需先清理冻结文件的既有超长行）");
  process.exit(0);
}

/**
 * console 白名单：只有明确承担“终端用户输出”职责的文件才允许。
 * web/ 为浏览器面向用户输出（任务允许）；src/cli.mjs 是命令行入口。
 */
const CONSOLE_ALLOW = new Map([
  ["src/cli.mjs", "CLI 用户输出"],
  ["scripts/audit-public.mjs", "既有发布审计脚本（保持原样，不得覆盖）"],
  ["scripts/lint.mjs", "lint 工具自身终端报告"],
  ["scripts/coverage.mjs", "覆盖率工具自身终端报告"],
  ["test/e2e/smoke.node.mjs", "纯 Node E2E 冒烟的报告输出"],
]);
const WEB_PREFIX = "web/";

const SYNTAX_DIRS = ["src", "scripts", "web", "test", "dsh-plugin"];
const DEBUG_SCOPE = [/^src\//, /^scripts\//, /^web\//, /^test\/e2e\//, /^playwright\.config\./];
const HARD_WIDTH_SCOPE = [/^scripts\//, /^test\/e2e\//, /^\.github\//, /^skills\//, /^playwright\.config\./];
const WIDTH_EXT = new Set([".mjs", ".js", ".ts", ".yml", ".yaml"]);
const CODE_EXT = new Set([".mjs", ".js"]);

const errors = [];
const warnings = [];
const ruleStats = new Map();

function relOf(file) {
  return relative(ROOT, file).split(sep).join("/");
}

function record(rule, level, file, line, message) {
  const item = { rule, file, line, message };
  if (level === "error") errors.push(item);
  else warnings.push(item);
  const key = `${rule}/${level}`;
  ruleStats.set(key, (ruleStats.get(key) ?? 0) + 1);
}

function walk(dir, onFile, skip = SKIP_DIRS) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skip.has(entry.name) || entry.name.startsWith(".cockpit")) continue;
      walk(join(dir, entry.name), onFile, skip);
    } else if (entry.isFile()) {
      onFile(join(dir, entry.name));
    }
  }
}

function readText(file) {
  return readFileSync(file, "utf8").replace(/^\uFEFF/, "");
}

// ── 收集文件 ────────────────────────────────────────────────────────────────
const syntaxFiles = [];
for (const dir of SYNTAX_DIRS) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  walk(abs, (file) => {
    // test/e2e/ 是 Playwright .ts 与纯 Node 冒烟，不属于 `node --check` 语法门禁；
    // 它由 `npx playwright test` / `node test/e2e/smoke.node.mjs` 自行校验。
    if (relOf(file).startsWith("test/e2e/")) return;
    if (CODE_EXT.has(extnameOf(file))) syntaxFiles.push(file);
  });
}
syntaxFiles.sort();

function extnameOf(file) {
  const index = file.lastIndexOf(".");
  return index === -1 ? "" : file.slice(index).toLowerCase();
}

// ── R1 语法：node --check ──────────────────────────────────────────────────
function checkSyntax() {
  for (const file of syntaxFiles) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) {
      const detail = String(result.stderr ?? "")
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .slice(0, 2)
        .join(" | ")
        .split(ROOT)
        .join("");
      record("SYNTAX", "error", relOf(file), 0, detail || "node --check 失败");
    }
  }
  console.log(`✓ R1 语法 node --check：${syntaxFiles.length} 个文件`);
}

checkSyntax();
if (SYNTAX_ONLY) finish();

// ── R2 禁用词：console.* / debugger / TODO ─────────────────────────────────
const FORBIDDEN = [
  {
    rule: "CONSOLE",
    re: /\bconsole\s*\.\s*[A-Za-z_$]/,
    hint: "禁止 console.*（白名单：src/cli.mjs、接受终端输出的脚本、web/）",
  },
  { rule: "DEBUGGER", re: /\bdebugger\b/, hint: "禁止提交 debugger" },
  { rule: "TODO", re: /\b(?:TODO|FIXME|XXX)\b/, hint: "TODO/FIXME/XXX 必须清零或转 issue" },
];

function consoleAllowed(relPath) {
  return CONSOLE_ALLOW.has(relPath) || relPath.startsWith(WEB_PREFIX);
}

function checkForbidden() {
  let scanned = 0;
  for (const file of syntaxFiles) {
    const relPath = relOf(file);
    if (!DEBUG_SCOPE.some((re) => re.test(relPath))) continue;
    // lint 自身包含规则字面量（TODO/debugger 的检索模式），跳过以避免自证。
    if (relPath === "scripts/lint.mjs") continue;
    scanned += 1;
    const lines = readText(file).split(/\r?\n/);
    lines.forEach((text, index) => {
      for (const rule of FORBIDDEN) {
        if (rule.rule === "CONSOLE" && consoleAllowed(relPath)) continue;
        if (!rule.re.test(text)) continue;
        record(rule.rule, "error", relPath, index + 1, rule.hint);
      }
    });
  }
  console.log(`✓ R2 禁用词 console/debugger/TODO：扫描 ${scanned} 个文件`);
}

checkForbidden();

// ── R3 行宽 ≤160 ────────────────────────────────────────────────────────────
function checkWidth() {
  let hardFiles = 0;
  let frozenFiles = 0;
  const widthFiles = [];
  for (const file of syntaxFiles) {
    if (WIDTH_EXT.has(extnameOf(file))) widthFiles.push(file);
  }
  const workflowDir = join(ROOT, ".github");
  if (existsSync(workflowDir)) {
    walk(workflowDir, (file) => {
      if (/\.ya?ml$/i.test(file)) widthFiles.push(file);
    });
  }
  const playwrightConfig = join(ROOT, "playwright.config.ts");
  if (existsSync(playwrightConfig)) widthFiles.push(playwrightConfig);
  for (const file of widthFiles) {
    const relPath = relOf(file);
    const hard = HARD_WIDTH_SCOPE.some((re) => re.test(relPath));
    if (hard) hardFiles += 1;
    else frozenFiles += 1;
    const lines = readText(file).split(/\r?\n/);
    lines.forEach((text, index) => {
      if (text.length <= MAX_WIDTH) return;
      const message = `${text.length} 字符 > ${MAX_WIDTH}`;
      if (hard) record("WIDTH", "error", relPath, index + 1, message);
      else record("WIDTH", "warning", relPath, index + 1, `${message}（冻结只读文件，仅告警）`);
    });
  }
  console.log(`✓ R3 行宽 ≤${MAX_WIDTH}：硬门禁 ${hardFiles} 个文件 / 冻结告警 ${frozenFiles} 个文件`);
}

checkWidth();

// ── R4 JSON 可解析 ─────────────────────────────────────────────────────────
function checkJson() {
  const jsonFiles = [];
  walk(ROOT, (file) => {
    if (extnameOf(file) === ".json") jsonFiles.push(file);
  });
  jsonFiles.sort();
  for (const file of jsonFiles) {
    const relPath = relOf(file);
    try {
      JSON.parse(readText(file));
    } catch (error) {
      record("JSON", "error", relPath, 0, `JSON.parse 失败：${error.message}`);
    }
  }
  console.log(`✓ R4 JSON 可解析：${jsonFiles.length} 个文件`);
}

checkJson();

// ── R5 YAML 子集结构检查 ───────────────────────────────────────────────────
function checkYaml() {
  const yamlFiles = [];
  walk(ROOT, (file) => {
    if (/\.ya?ml$/i.test(file)) yamlFiles.push(file);
  });
  yamlFiles.sort();
  for (const file of yamlFiles) {
    const relPath = relOf(file);
    const lines = readText(file).split(/\r?\n/);
    let blockIndent = -1;
    const topKeys = new Map();
    lines.forEach((text, index) => {
      const lineNo = index + 1;
      const indent = text.length - text.trimStart().length;
      if (blockIndent >= 0) {
        if (text.trim() === "" || indent > blockIndent) return;
        blockIndent = -1;
      }
      if (/^\s*\t/.test(text)) record("YAML", "error", relPath, lineNo, "缩进中禁止使用 Tab");
      if (/[ \t]+$/.test(text)) record("YAML", "warning", relPath, lineNo, "行尾多余空白");
      if (/:\s*[|>][+-]?\s*$/.test(text)) {
        blockIndent = indent;
        return;
      }
      const trimmed = text.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      if (trimmed.startsWith("-")) return;
      if (!trimmed.includes(":")) {
        record("YAML", "error", relPath, lineNo, `无法识别的 YAML 行（缺少 ':'）：${trimmed.slice(0, 40)}`);
        return;
      }
      if (indent === 0) {
        const key = trimmed.slice(0, trimmed.indexOf(":")).trim();
        if (topKeys.has(key)) {
          record("YAML", "error", relPath, lineNo, `顶层键重复：${key}（首次出现于第 ${topKeys.get(key)} 行）`);
        } else {
          topKeys.set(key, lineNo);
        }
      }
    });
  }
  console.log(`✓ R5 YAML 子集检查：${yamlFiles.length} 个文件`);
}

checkYaml();

// ── R6 web/index.html 本地资源 & id 唯一 ────────────────────────────────────
function checkWebIndex() {
  const indexPath = join(ROOT, "web", "index.html");
  if (!existsSync(indexPath)) {
    record("HTML", "error", "web/index.html", 0, "缺少 web/index.html");
    return;
  }
  const html = readText(indexPath);
  const refRe = /<(?:script|link|img|source|iframe|video|audio)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let refCount = 0;
  let match;
  while ((match = refRe.exec(html)) !== null) {
    const ref = match[1].trim();
    if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:|javascript:)/i.test(ref)) continue;
    refCount += 1;
    const clean = ref.split("?")[0].split("#")[0];
    const target = resolve(join(ROOT, "web"), clean.replace(/^\//, ""));
    const webRoot = resolve(join(ROOT, "web"));
    if (target !== webRoot && !target.startsWith(webRoot + sep)) {
      record("HTML", "error", "web/index.html", 0, `本地资源越界：${ref}`);
      continue;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      record("HTML", "error", "web/index.html", 0, `引用的本地资源不存在：${ref}`);
    }
  }
  const ids = new Map();
  const idRe = /\bid\s*=\s*["']([^"']+)["']/gi;
  while ((match = idRe.exec(html)) !== null) {
    const id = match[1];
    if (ids.has(id)) record("HTML", "error", "web/index.html", 0, `DOM id 重复：${id}`);
    else ids.set(id, true);
  }
  console.log(`✓ R6 web/index.html：${refCount} 个本地资源引用、${ids.size} 个 DOM id`);
}

checkWebIndex();

finish();

// ── 汇总输出 ───────────────────────────────────────────────────────────────
function finish() {
  const widthWarnings = warnings.filter((item) => item.rule === "WIDTH");
  if (widthWarnings.length > 0) {
    const byFile = new Map();
    for (const item of widthWarnings) {
      byFile.set(item.file, (byFile.get(item.file) ?? 0) + 1);
    }
    const summary = [...byFile.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([file, count]) => `${file}(${count})`)
      .join(", ");
    console.warn(`⚠ 冻结文件既有超长行 ${widthWarnings.length} 处：${summary}`);
    console.warn("  （属于冻结只读范围，不在本任务修复；--strict 可查看明细/纳入失败）");
  }
  const otherWarnings = warnings.filter((item) => item.rule !== "WIDTH");
  for (const item of otherWarnings.slice(0, 20)) {
    console.warn(`⚠ [${item.rule}] ${item.file}${item.line ? `:${item.line}` : ""} — ${item.message}`);
  }

  if (errors.length > 0) {
    for (const item of errors) {
      console.error(`✗ [${item.rule}] ${item.file}${item.line ? `:${item.line}` : ""} — ${item.message}`);
    }
    console.error(`lint 失败：${errors.length} 个错误、${warnings.length} 个告警`);
    process.exit(1);
  }
  const strictFailed = STRICT && warnings.length > 0;
  if (strictFailed) {
    console.error(`lint --strict 失败：0 个错误、${warnings.length} 个告警（告警在 strict 下视为失败）`);
    process.exit(1);
  }
  const stats = [...ruleStats.entries()].map(([key, count]) => `${key}=${count}`).join(" ");
  console.log(`lint 通过：0 错误、${warnings.length} 告警${stats ? `（${stats}）` : ""}`);
  process.exit(0);
}
