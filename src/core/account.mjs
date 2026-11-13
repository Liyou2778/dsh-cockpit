/**
 * 官方账户数据（ACCOUNT_V1）—— 使用 DSH 已保存的账号授权（grant）读取官方 Platform 接口。
 *
 * 与 `balance.mjs`（API Key 调公开 `/user/balance`）的区别：
 * - balance：需要用户在环境变量提供 API Key，只能拿余额；
 * - account：读取 DSH 凭据库中 `deepseek-account-platform/default` 的 grant token，
 *   调 Platform 内部接口拿【官方余额 + 官方累计花费 total_costs】——都是精准值，不是估算。
 *
 * 边界（用户显式授权后才启用，默认关闭）：
 * - 只读 `~/.dsh/.credentials.yaml`，不写、不改、不复制 token；
 * - token 只在本进程内用于请求，不落盘、不写日志、不进错误信息；
 * - 只允许发往 grant 的 issuer（必须等于配置的 platform origin）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dshHome } from "./paths.mjs";

export const ACCOUNT_POLICY_VERSION = "ACCOUNT_V1";
export const DEFAULT_ACCOUNT_ORIGIN = "https://platform.deepseek.com";
export const DEFAULT_ACCOUNT_TTL_MS = 60_000;
export const DEFAULT_ACCOUNT_TIMEOUT_MS = 8_000;
export const ACCOUNT_SUMMARY_PATH = "/api/v0/users/get_user_summary";
export const ACCOUNT_PROFILE_PATH = "/auth-api/v0/users/current";

// grant 可能是 base64url / JWT / opaque token：只做保守的字符集与长度校验
const GRANT_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{32,256}$/;

/** 极简 YAML 解析：只用于读取 DSH 凭据结构（缩进映射），不处理复杂 YAML。 */
export function parseCredentialsYaml(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const match = /^([A-Za-z0-9_./-]+):\s*(.*)$/.exec(rawLine.trim());
    if (!match) continue;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    const key = match[1];
    const value = match[2].replace(/^["']|["']$/g, "");
    if (value === "") {
      parent[key] = {};
      stack.push({ indent, obj: parent[key] });
    } else {
      parent[key] = value;
    }
  }
  return root;
}

/** 读取 DSH 账号 grant（只返回内存结构，不打印、不落盘）。 */
export function readDshGrant(env = process.env) {
  const path = join(dshHome(env), ".credentials.yaml");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, code: "ACCOUNT_NO_CREDENTIALS", message: "未找到 DSH 凭据文件（~/.dsh/.credentials.yaml）" };
  }
  const parsed = parseCredentialsYaml(text);
  const record = parsed?.records?.["deepseek-account-platform/default"];
  const token = record?.payload?.token;
  const issuer = record?.payload?.issuer;
  if (typeof token !== "string" || !GRANT_TOKEN_PATTERN.test(token)) {
    return { ok: false, code: "ACCOUNT_NO_GRANT", message: "DSH 未登录账号（缺少账号授权）", hint: "在 DSH 中登录 DeepSeek 账号后重试" };
  }
  if (typeof issuer !== "string" || !issuer.startsWith("https://")) {
    return { ok: false, code: "ACCOUNT_BAD_ISSUER", message: "账号授权缺少合法 issuer" };
  }
  return { ok: true, token, issuer };
}

/**
 * 解析 Platform user summary：余额与累计花费都是官方字符串，保留原样与数字两种形式。
 * `token_estimation` 形状不稳定，不用于展示。
 */
export function normalizeAccountSummary(payload) {
  const data = payload?.data?.biz_data ?? payload?.biz_data ?? null;
  if (!data || typeof data !== "object") return null;
  const wallets = (list, kind) => (Array.isArray(list) ? list : [])
    .filter((row) => row && typeof row.currency === "string")
    .map((row) => ({
      kind,
      currency: row.currency,
      balance: typeof row.balance === "string" && row.balance.trim() !== "" ? row.balance : null,
    }));
  const totalCosts = (Array.isArray(data.total_costs) ? data.total_costs : [])
    .filter((row) => row && typeof row.currency === "string" && typeof row.amount === "string")
    .map((row) => ({ currency: row.currency, amount: row.amount }));
  const normal = wallets(data.normal_wallets, "normal");
  const bonus = wallets(data.bonus_wallets, "bonus");
  if (normal.length === 0 && bonus.length === 0 && totalCosts.length === 0) return null;
  return { normalWallets: normal, bonusWallets: bonus, totalCosts };
}

function numberOrNull(value) {
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 调用官方账号接口；失败返回结构化错误（不含 token）。 */
export async function fetchAccountSummary({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_ACCOUNT_TIMEOUT_MS, origin = DEFAULT_ACCOUNT_ORIGIN } = {}) {
  const grant = readDshGrant(env);
  if (!grant.ok) return grant;
  if (grant.issuer.replace(/\/+$/, "") !== String(origin).replace(/\/+$/, "")) {
    return { ok: false, code: "ACCOUNT_ISSUER_MISMATCH", message: `账号授权 issuer 与配置不一致（issuer=${grant.issuer}）` };
  }
  if (typeof fetchImpl !== "function") return { ok: false, code: "ACCOUNT_NO_FETCH", message: "当前运行环境没有 fetch" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${origin}${ACCOUNT_SUMMARY_PATH}`, {
      method: "GET",
      headers: { "x-dsh-auth-token": grant.token, accept: "application/json" },
      signal: controller.signal,
    });
    if (!response?.ok) {
      const status = response?.status ?? 0;
      const code = status === 401 || status === 403 ? "ACCOUNT_UNAUTHORIZED" : `ACCOUNT_HTTP_${status || "UNKNOWN"}`;
      return { ok: false, code, message: `官方账号接口返回 HTTP ${status || "?"}` };
    }
    const payload = await response.json();
    const normalized = normalizeAccountSummary(payload);
    if (!normalized) return { ok: false, code: "ACCOUNT_BAD_RESPONSE", message: "官方账号接口返回结构不识别" };
    const currency = normalized.normalWallets[0]?.currency ?? normalized.totalCosts[0]?.currency ?? null;
    const normal = normalized.normalWallets.find((row) => row.currency === currency) ?? normalized.normalWallets[0] ?? null;
    const bonus = normalized.bonusWallets.find((row) => row.currency === currency) ?? normalized.bonusWallets[0] ?? null;
    const totalCost = normalized.totalCosts.find((row) => row.currency === currency) ?? normalized.totalCosts[0] ?? null;
    return {
      ok: true,
      source: "dsh-account-grant",
      currency,
      normalBalance: normal?.balance ?? null,
      normalBalanceNum: numberOrNull(normal?.balance),
      bonusBalance: bonus?.balance ?? null,
      bonusBalanceNum: numberOrNull(bonus?.balance),
      totalCost: totalCost?.amount ?? null,
      totalCostNum: numberOrNull(totalCost?.amount),
      wallets: normalized,
    };
  } catch (error) {
    if (error?.name === "AbortError") return { ok: false, code: "ACCOUNT_TIMEOUT", message: `官方账号请求超时（>${timeoutMs}ms）` };
    return { ok: false, code: "ACCOUNT_NETWORK", message: "官方账号接口网络错误" };
  } finally {
    clearTimeout(timer);
  }
}

/** TTL + 并发合并的账号服务（与 balance 服务同构）。 */
export function createAccountService({ env = process.env, fetchImpl = globalThis.fetch, ttlMs = DEFAULT_ACCOUNT_TTL_MS, timeoutMs = DEFAULT_ACCOUNT_TIMEOUT_MS, origin = DEFAULT_ACCOUNT_ORIGIN, now = Date.now } = {}) {
  let cached = null;
  let inflight = null;
  async function get({ force = false } = {}) {
    if (!force && cached && now() - cached.at < ttlMs) {
      return { ...cached.value, cached: true, ageMs: now() - cached.at, ttlMs };
    }
    if (inflight) return inflight;
    inflight = (async () => {
      const fetched = await fetchAccountSummary({ env, fetchImpl, timeoutMs, origin });
      const at = now();
      const value = fetched.ok
        ? {
            enabled: true,
            available: true,
            policyVersion: ACCOUNT_POLICY_VERSION,
            source: fetched.source,
            currency: fetched.currency,
            normalBalance: fetched.normalBalance,
            bonusBalance: fetched.bonusBalance,
            totalCost: fetched.totalCost,
            totalCostCny: fetched.totalCostNum,
            fetchedAt: new Date(at).toISOString(),
            error: null,
          }
        : {
            enabled: true,
            available: false,
            policyVersion: ACCOUNT_POLICY_VERSION,
            fetchedAt: new Date(at).toISOString(),
            error: { code: fetched.code, message: fetched.message, ...(fetched.hint ? { hint: fetched.hint } : {}) },
          };
      cached = { at, value };
      return { ...value, cached: false, ageMs: 0, ttlMs };
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }
  return { get };
}

const sharedServices = new Map();
export function getSharedAccountService(env = process.env, options = {}) {
  const key = `${String(env.DSH_COCKPIT_HOME ?? "")}::${options.ttlMs ?? DEFAULT_ACCOUNT_TTL_MS}`;
  if (!sharedServices.has(key)) sharedServices.set(key, createAccountService({ env, ...options }));
  return sharedServices.get(key);
}
