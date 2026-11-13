#!/usr/bin/env node
/**
 * 覆盖率门禁（零依赖）：调用 Node 内置测试运行器与内置覆盖率。
 *
 *   node scripts/coverage.mjs [--threshold=70] [--report-only]
 *
 * 口径：`src/core/**`（核心领域层）的行覆盖率（line coverage）。
 *   - 主路径：`node --test --experimental-test-coverage --test-reporter=lcov`，
 *     把 lcov 写到系统临时目录后解析（LF/LH 精确汇总），不落仓库。
 *   - 降级 1（lcov 不可用/解析失败）：解析 `--experimental-test-coverage` 的表格输出（δ 近似聚合）。
 *   - 降级 2（表格也解析不了）：直接跑 `--test-coverage-lines=<阈值>`，以 Node 自身阈值退出码为准。
 *
 * 退出码：测试失败 → 1；核心覆盖率 < 阈值 → 1（--report-only 时为 0，仅报告）。
 * 阈值也可用环境变量 CORE_LINE_THRESHOLD 覆盖；CI 中建议显式传参以便日志可读。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ARGS = process.argv.slice(2);
const HELP = ARGS.includes("--help") || ARGS.includes("-h");
const REPORT_ONLY = ARGS.includes("--report-only") || process.env.COVERAGE_REPORT_ONLY === "1";
let threshold = Number.parseInt(process.env.CORE_LINE_THRESHOLD ?? "70", 10);
for (let index = 0; index < ARGS.length; index += 1) {
  const arg = ARGS[index];
  const equals = arg.match(/^--threshold=(.+)$/);
  if (equals) threshold = Number.parseInt(equals[1], 10);
  else if (arg === "--threshold" && ARGS[index + 1]) threshold = Number.parseInt(ARGS[index + 1], 10);
}
if (Number.isNaN(threshold) || threshold < 0 || threshold > 100) threshold = 70;

if (HELP) {
  console.log("用法：node scripts/coverage.mjs [--threshold=70] [--report-only]");
  console.log("  --threshold=NN   src/core/** 行覆盖率门槛（默认 70，环境变量 CORE_LINE_THRESHOLD）");
  console.log("  --report-only    未达标只报告、不失败（用于基线观测）");
  process.exit(0);
}

const CORE_PREFIX = "src/core/";
const TEST_GLOB = "test/*.test.mjs";
const LCOV_PATH = join(tmpdir(), `dsh-cockpit-lcov-${process.pid}.info`);
const cleanups = [LCOV_PATH];

function cleanup() {
  for (const path of cleanups) {
    try {
      if (existsSync(path)) rmSync(path, { force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
}

/**
 * 运行一次测试。
 * 只跑仓库根目录的 `test/*.test.mjs`（node test runner 的 glob 参数）：
 * `test/e2e/**` 是 Playwright/纯 Node 冒烟，不参与 node:test 发现。
 * @param {string[]} extra 额外 node 参数
 * @returns {{status:number|null, stdout:string, stderr:string, error?:Error}}
 */
function runTests(extra) {
  const args = ["--test", "--experimental-test-coverage", ...extra, TEST_GLOB];
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

function toRelative(rawPath) {
  let path = String(rawPath).trim().replace(/\\/g, "/");
  const rootPosix = ROOT.replace(/\\/g, "/").replace(/\/+$/, "");
  if (path.startsWith(rootPosix + "/")) path = path.slice(rootPosix.length + 1);
  if (path.startsWith("./")) path = path.slice(2);
  return path;
}

function parseLcov(text) {
  const files = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      current = { file: toRelative(line.slice(3)), lf: null, lh: null };
    } else if (current && line.startsWith("LF:")) {
      current.lf = Number.parseInt(line.slice(3), 10);
    } else if (current && line.startsWith("LH:")) {
      current.lh = Number.parseInt(line.slice(3), 10);
    } else if (line === "end_of_record" && current) {
      if (Number.isFinite(current.lf) && Number.isFinite(current.lh)) files.set(current.file, current);
      current = null;
    }
  }
  return files;
}

function summarize(files, mode) {
  const core = [...files.values()].filter((entry) => entry.file.startsWith(CORE_PREFIX) && entry.file.endsWith(".mjs"));
  if (core.length === 0) return null;
  let totalLines = 0;
  let hitLines = 0;
  for (const entry of core) {
    totalLines += entry.lf;
    hitLines += entry.lh;
  }
  const coreFiles = core
    .map((entry) => ({
      file: entry.file,
      pct: entry.lf === 0 ? 100 : (entry.lh / entry.lf) * 100,
      lf: entry.lf,
      lh: entry.lh,
    }))
    .sort((a, b) => a.pct - b.pct);
  let overallTotal = 0;
  let overallHit = 0;
  for (const entry of files.values()) {
    overallTotal += entry.lf;
    overallHit += entry.lh;
  }
  return {
    mode,
    corePct: totalLines === 0 ? 100 : (hitLines / totalLines) * 100,
    coreLines: totalLines,
    coreHit: hitLines,
    coreFiles,
    overallPct: overallTotal === 0 ? 100 : (overallHit / overallTotal) * 100,
  };
}

/** 降级：解析 Node 覆盖率表格（按文件百分比近似聚合）。 */
function parseCoverageTable(text) {
  const files = new Map();
  const stack = [];
  let inReport = false;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.includes("start of coverage report")) {
      inReport = true;
      continue;
    }
    if (raw.includes("end of coverage report")) break;
    if (!inReport) continue;
    const row = raw.replace(/^ℹ\s?/, "");
    const cells = row.split("|").map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const nameCell = cells[0];
    if (!nameCell) continue;
    const depth = nameCell.length - nameCell.trimStart().length;
    const name = nameCell.trim();
    const numbers = cells.slice(1, 4).map((cell) => Number.parseFloat(cell));
    const isFileRow = numbers.every((value) => Number.isFinite(value));
    if (!isFileRow) {
      if (name && cells.slice(1).every((cell) => cell === "")) {
        stack[depth] = name;
        stack.length = depth + 1;
      }
      continue;
    }
    const parts = [...stack.slice(0, depth), name].filter(Boolean);
    const file = parts.join("/").replace(/\\/g, "/");
    if (file.startsWith(CORE_PREFIX) && file.endsWith(".mjs")) {
      const pct = numbers[0];
      files.set(file, { file, lf: 1, lh: pct / 100 });
    }
  }
  return summarize(files, "table（近似聚合）");
}

function printTestSummary(stdout, stderr) {
  const combined = `${stdout}\n${stderr}`;
  const counts = {};
  for (const raw of combined.split(/\r?\n/)) {
    const match = raw.match(/ℹ\s*(tests|pass|fail|skipped|cancelled)\s+(\d+)\s*$/);
    if (match) counts[match[1]] = Number.parseInt(match[2], 10);
  }
  const parts = Object.entries(counts).map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? parts.join(" ") : "（无法解析测试计数，以退出码为准）";
}

function printFailureTail(output, stderr) {
  const combined = `${output}\n${stderr}`.trim();
  if (!combined) return;
  const lines = combined.split(/\r?\n/);
  const tail = lines.slice(-40).join("\n");
  console.error("— 测试输出末尾（40 行）—");
  console.error(tail);
  console.error("— 输出结束 —");
}

function printReport(result) {
  console.log(`覆盖率口径：${result.mode}`);
  console.log(
    `src/core/** 行覆盖：${result.corePct.toFixed(2)}%（${result.coreHit}/${result.coreLines} 行，` +
      `${result.coreFiles.length} 个文件；阈值 ${threshold}%）`,
  );
  console.log(`全部文件行覆盖：${result.overallPct.toFixed(2)}%`);
  const low = result.coreFiles.filter((entry) => entry.pct < threshold);
  if (low.length > 0) {
    console.log(`低于阈值的 core 文件（${low.length}）：`);
    for (const entry of low.slice(0, 15)) {
      console.log(`  - ${entry.file}  ${entry.pct.toFixed(2)}%（${entry.lh}/${entry.lf}）`);
    }
    if (low.length > 15) console.log(`  … 其余 ${low.length - 15} 个见完整覆盖表`);
    console.log("提示：补 node:test 用例提升覆盖；不要为达标改业务代码。");
  } else {
    console.log("所有 src/core 文件均不低于阈值。");
  }
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
let testRun;
try {
  console.log("运行 node --test --experimental-test-coverage …");
  testRun = runTests([
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${LCOV_PATH}`,
  ]);
  const summary = printTestSummary(testRun.stdout, testRun.stderr);
  if (testRun.error) {
    console.error(`测试进程启动失败：${testRun.error.message}`);
    cleanup();
    process.exit(1);
  }
  console.log(`测试结果：exit=${testRun.status}，${summary}`);
  if (testRun.status !== 0) {
    printFailureTail(testRun.stdout, testRun.stderr);
    console.error("覆盖率门禁：测试未通过，覆盖率不作数。");
    cleanup();
    process.exit(1);
  }

  let result = null;
  if (existsSync(LCOV_PATH)) {
    const lcovText = readFileSync(LCOV_PATH, "utf8");
    result = summarize(parseLcov(lcovText), "lcov（精确 LF/LH）");
    if (!result) console.warn("! lcov 中没有 src/core 记录，降级为表格解析。");
  } else {
    console.warn("! lcov 输出不存在（当前 Node 可能不支持 lcov reporter），降级为表格解析。");
  }
  if (!result) result = parseCoverageTable(testRun.stdout);
  if (!result) {
    console.warn("! 表格解析失败，降级为 Node 内置阈值模式（--test-coverage-lines）。");
    const thresholdRun = runTests([`--test-coverage-lines=${threshold}`, "--test-reporter=spec"]);
    if (thresholdRun.status === 0) {
      console.log(`覆盖率门禁（降级模式）：Node 内置 --test-coverage-lines=${threshold} 通过。`);
      cleanup();
      process.exit(0);
    }
    printFailureTail(thresholdRun.stdout, thresholdRun.stderr);
    console.error(`覆盖率门禁失败：Node 内置行覆盖率阈值为 ${threshold}%。`);
    cleanup();
    process.exit(1);
  }

  printReport(result);
  const passed = result.corePct >= threshold;
  if (passed) {
    console.log(`覆盖率门禁：PASS（src/core 行覆盖 ${result.corePct.toFixed(2)}% ≥ ${threshold}%）`);
    cleanup();
    process.exit(0);
  }
  console.error(`覆盖率门禁：FAIL（src/core 行覆盖 ${result.corePct.toFixed(2)}% < ${threshold}%）`);
  if (REPORT_ONLY) {
    console.log("--report-only：仅报告，按 0 退出。");
    cleanup();
    process.exit(0);
  }
  cleanup();
  process.exit(1);
} finally {
  if (testRun && testRun.error) cleanup();
}
