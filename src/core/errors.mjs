/**
 * 结构化错误：核心层不抛裸字符串（参考产品教训：158 处 Result<_, String> 无法分类）。
 * 每类错误带稳定 code，UI/CLI 可据此分支，而不用解析文案。
 */
export const ERROR_CODES = Object.freeze({
  DSH_HOME_MISSING: "DSH_HOME_MISSING",
  SESSIONS_ROOT_MISSING: "SESSIONS_ROOT_MISSING",
  ZSTD_UNSUPPORTED: "ZSTD_UNSUPPORTED",
  SESSION_DECODE_FAILED: "SESSION_DECODE_FAILED",
  SESSION_PARSE_FAILED: "SESSION_PARSE_FAILED",
  CONFIG_INVALID: "CONFIG_INVALID",
  STATE_INVALID: "STATE_INVALID",
  PORT_UNAVAILABLE: "PORT_UNAVAILABLE",
  UNKNOWN: "UNKNOWN",
});

export class CockpitError extends Error {
  /**
   * @param {string} code 稳定错误码（ERROR_CODES）
   * @param {string} message 面向人的说明（中文）
   * @param {{cause?: unknown, detail?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CockpitError";
    this.code = code;
    this.detail = options.detail ?? null;
  }

  toJSON() {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

export function asCockpitError(error) {
  if (error instanceof CockpitError) return error;
  return new CockpitError(ERROR_CODES.UNKNOWN, error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}
