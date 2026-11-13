/**
 * Worker 侧密码学 / 序列化工具（零依赖，只用 Web Crypto，Node ≥22 与 Workers 通用）。
 *
 * 设计要点：
 * - 令牌（`ccs_` + 43 字符 base64url）与邀请码（`CCI-` + 16 字符 base64url = 96bit）
 *   一律用 CSPRNG 生成；入库只存 SHA-256（数据库泄漏不等于令牌泄漏）；
 * - 快照去重哈希使用"稳定序列化"（对象键递归排序），保证同一快照在不同序列化顺序下哈希一致；
 * - bootstrap secret 用常量时间比较，降低时序侧信道风险。
 */

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** 无填充 base64url 编码（RFC 4648 §5）。32 字节 → 43 字符；12 字节 → 16 字符。 */
export function base64urlEncode(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.length; i += 3) {
    const b0 = view[i];
    const b1 = i + 1 < view.length ? view[i + 1] : undefined;
    const b2 = i + 2 < view.length ? view[i + 2] : undefined;
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += BASE64URL_ALPHABET[((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += BASE64URL_ALPHABET[b2 & 0b111111];
  }
  return out;
}

/** 密码学安全随机字节。Workers 与 Node ≥22 都暴露全局 `crypto.getRandomValues`。 */
export function randomBytes(length) {
  if (!Number.isInteger(length) || length <= 0) throw new TypeError("randomBytes(length) 需要正整数");
  const buffer = new Uint8Array(length);
  globalThis.crypto.getRandomValues(buffer);
  return buffer;
}

/** 设备令牌：`ccs_` + 256bit 随机数的 base64url（43 字符）。 */
export function randomToken() {
  return `ccs_${base64urlEncode(randomBytes(32))}`;
}

/** 邀请码：`CCI-` + 96bit 随机数的 base64url（16 字符），单次使用，24h 过期。 */
export function randomInviteCode() {
  return `CCI-${base64urlEncode(randomBytes(12))}`;
}

/** 空间 / 成员 ID：可读前缀 + 随机 base64url。 */
export function randomId(prefix, bytes = 12) {
  return `${prefix}_${base64urlEncode(randomBytes(bytes))}`;
}

/** SHA-256 → 小写 hex。令牌、邀请码、快照 payload 统一用这个哈希。 */
export async function sha256Hex(input) {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("Web Crypto 不可用：需要 Workers 运行时或 Node ≥22");
  }
  const data = new TextEncoder().encode(String(input));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 稳定序列化（用于去重哈希）：对象键递归排序，数组保持顺序，输出无空白的 JSON。
 * 与 Node 客户端 `snapshotHash()` 的序列化规则保持一致，确保两端哈希可互换。
 */
export function stableStringify(value) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "number") {
    if (!Number.isFinite(value)) throw new TypeError("stableStringify 不支持非有限数字");
    return JSON.stringify(value);
  }
  if (type === "boolean") return value ? "true" : "false";
  if (type === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (type === "object") {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      const item = value[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${stableStringify(item)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`stableStringify 不支持的类型：${type}`);
}

/** 常量时间字符串比较（长度不同也不提前返回）。 */
export function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}
