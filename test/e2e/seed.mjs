/**
 * E2E / 冒烟的合成数据种子。
 *
 * 安全边界（AGENTS.md 红线段）：**只允许写入系统临时目录下 dsh-cockpit-e2e/**，
 * 绝不写入真实 ~/.dsh。seed() 会校验 DSH_HOME 路径包含 "dsh-cockpit-e2e"，否则直接抛错。
 *
 * 数据全部合成：伪造的会话 id / 标题 / 项目 / token 用量，不含任何真实数据。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assistantEvent,
  compactionEvent,
  contextEvent,
  sessionHeader,
  titleEvent,
  toolEvent,
  writeSyntheticSession,
} from "../helpers.mjs";

export const E2E_DIR_NAME = "dsh-cockpit-e2e";

function safeEnvPath(candidate, fallback) {
  // 宿主环境可能已设置 DSH_HOME（如 DSH 运行器自身），只接受指向 E2E 临时目录的值，
  // 避免 E2E 误用/误删真实 ~/.dsh。其余情况一律回退到系统临时目录。
  return typeof candidate === "string" && candidate.replace(/\\/g, "/").includes(E2E_DIR_NAME) ? candidate : fallback;
}

export function e2ePaths(env = process.env) {
  return {
    dshHome: safeEnvPath(env.DSH_HOME, join(tmpdir(), E2E_DIR_NAME, "dsh-home")),
    cockpitHome: safeEnvPath(env.DSH_COCKPIT_HOME, join(tmpdir(), E2E_DIR_NAME, "cockpit-home")),
  };
}

export function assertSafeHome(dshHome) {
  const normalized = String(dshHome).replace(/\\/g, "/");
  if (!normalized.includes(E2E_DIR_NAME)) {
    throw new Error(`拒绝写入非 E2E 临时目录的 DSH_HOME（保护真实 ~/.dsh）：${dshHome}`);
  }
}

const PROJECTS = [
  { slug: "--e2e-alpha--", cwd: "C:/synthetic/e2e-alpha" },
  { slug: "--e2e-beta--", cwd: "C:/synthetic/e2e-beta" },
];

const TASKS = [
  { title: "合成任务 Alpha · 报告盘点", model: "deepseek-flash", project: 0 },
  { title: "合成任务 Beta · 数据修复", model: "deepseek-pro", project: 1 },
  { title: "合成任务 Gamma · 重构梳理", model: "deepseek-flash", project: 0 },
  { title: "合成任务 Delta · 回归验证", model: "deepseek-flash", project: 1 },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 播种合成会话（跨 ~45 天、2 个项目、4 个任务标题、2 个模型）。
 * @returns {{dshHome:string, cockpitHome:string, sessions:number}}
 */
export function seed() {
  const { dshHome, cockpitHome } = e2ePaths();
  assertSafeHome(dshHome);
  rmSync(dshHome, { recursive: true, force: true });
  rmSync(cockpitHome, { recursive: true, force: true });
  const sessionsRoot = join(dshHome, "sessions");
  mkdirSync(sessionsRoot, { recursive: true });
  mkdirSync(cockpitHome, { recursive: true });

  const now = Date.now();
  // 每项：距今天数、任务索引、token 规模（用于排序/搜索断言）
  const plan = [
    { day: 0, task: 0, scale: 6 },
    { day: 0, task: 1, scale: 3 },
    { day: 1, task: 0, scale: 4 },
    { day: 2, task: 2, scale: 5 },
    { day: 3, task: 1, scale: 2 },
    { day: 6, task: 3, scale: 7 },
    { day: 12, task: 0, scale: 3 },
    { day: 20, task: 2, scale: 4 },
    { day: 29, task: 3, scale: 2 },
    { day: 44, task: 1, scale: 3 },
  ];

  plan.forEach((entry, index) => {
    const task = TASKS[entry.task];
    const project = PROJECTS[task.project];
    const sessionId = `session-e2e-${String(index + 1).padStart(4, "0")}`;
    const baseTime = now - entry.day * DAY_MS - index * 60_000;
    const scale = entry.scale;
    const lines = [
      sessionHeader({ id: sessionId, createdAt: baseTime, cwd: project.cwd }),
      contextEvent({ model: task.model, time: baseTime + 1_000 }),
      toolEvent({ time: baseTime + 2_000, name: index % 2 === 0 ? "pwsh" : "read" }),
      assistantEvent({
        time: baseTime + 5_000,
        inputTokens: 1_000 * scale,
        cacheReadTokens: 200 * scale,
        outputTokens: 120 * scale,
        model: task.model,
      }),
      titleEvent({ time: baseTime + 6_000, title: task.title }),
      assistantEvent({
        time: baseTime + 9_000,
        inputTokens: 800 * scale,
        cacheReadTokens: 100 * scale,
        outputTokens: 90 * scale,
        model: task.model,
      }),
    ];
    if (index % 3 === 0) lines.push(compactionEvent({ time: baseTime + 10_000, shadowedTokenCount: 12_000 }));
    writeSyntheticSession(sessionsRoot, {
      projectSlug: project.slug,
      sessionId,
      version: 4,
      lines,
    });
  });

  return { dshHome, cockpitHome, sessions: plan.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = seed();
  process.stdout.write(`seed: ok sessions=${result.sessions} dshHome=${result.dshHome}\n`);
}
