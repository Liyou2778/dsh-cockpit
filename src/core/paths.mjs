/**
 * 路径解析：所有可配置路径集中在此，便于测试注入与未来迁移。
 * 只读 DSH 目录；写入仅发生在驾驶舱自己的 home。
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const TIME_ZONE = "Asia/Shanghai";

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), ".dsh");
}

export function sessionsRoot(env = process.env) {
  return join(dshHome(env), "sessions");
}

export function cockpitHome(env = process.env) {
  return env.DSH_COCKPIT_HOME || join(homedir(), ".dsh-cockpit");
}

export function configPath(env = process.env) {
  return join(cockpitHome(env), "config.json");
}

export function statePath(env = process.env) {
  return join(cockpitHome(env), "state.json");
}

export function comfortPath(env = process.env) {
  return join(cockpitHome(env), "comfort.json");
}

export function metricsPath(env = process.env) {
  return join(cockpitHome(env), "metrics.jsonl");
}

export function balancePath(env = process.env) {
  return join(cockpitHome(env), "balance.json");
}
