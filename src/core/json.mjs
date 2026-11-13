/**
 * JSON 读写工具：容错读取 + 原子写（tmp + rename）。
 * - 文件损坏时不崩溃、不覆盖用户数据，先备份再回退默认值；
 * - 写入使用同目录临时文件，避免半损文件；
 * - 所有落盘数据都是"派生统计"，不包含对话正文。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import { CockpitError, ERROR_CODES } from "./errors.mjs";

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * 读取 JSON；不存在返回 fallback；损坏时备份 `.corrupt-<ts>` 后返回 fallback。
 * @template T
 * @param {string} path
 * @param {T} fallback
 * @param {{onCorrupt?: (info: {path: string, backup: string}) => void}} [options]
 * @returns {{value: T, existed: boolean, repaired: boolean}}
 */
export function readJson(path, fallback, options = {}) {
  if (!existsSync(path)) return { value: fallback, existed: false, repaired: false };
  try {
    const raw = readFileSync(path, "utf8");
    return { value: JSON.parse(raw), existed: true, repaired: false };
  } catch (error) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try {
      copyFileSync(path, backup);
    } catch {
      /* 备份失败不阻塞 */
    }
    options.onCorrupt?.({ path, backup });
    return { value: fallback, existed: true, repaired: true };
  }
}

/** 原子写 JSON（先写临时文件再 rename，Windows 上 rename 覆盖是原子的）。 */
export function writeJsonAtomic(path, value) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    throw new CockpitError(ERROR_CODES.STATE_INVALID, `写入失败：${path}`, { cause: error });
  }
}

export function readTextLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
}
