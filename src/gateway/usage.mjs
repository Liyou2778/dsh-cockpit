/**
 * 网关用量解析（精确优先）：只从上游响应的官方 usage 字段提取，缺失一律 null（不估算）。
 *
 * 支持两类协议：
 * - OpenAI 兼容：usage.prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens
 * - Anthropic 兼容：usage.input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens
 *
 * 流式（SSE）：逐行累积，OpenAI 取最后含 usage 的 chunk，Anthropic 合并 message_start / message_delta。
 */

function num(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function openAiUsage(usage) {
  const prompt = num(usage.prompt_tokens);
  const completion = num(usage.completion_tokens);
  const cacheRead = num(usage.prompt_tokens_details?.cached_tokens) ?? num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.prompt_tokens_details?.cache_write_tokens) ?? num(usage.cache_creation_input_tokens);
  if (prompt === null && completion === null) return null;
  const input = prompt === null ? null : Math.max(0, prompt - (cacheRead ?? 0));
  return {
    format: "openai",
    model: typeof usage.model === "string" ? usage.model : null,
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: completion,
    reasoningTokens: num(usage.completion_tokens_details?.reasoning_tokens),
    totalTokens: num(usage.total_tokens),
  };
}

function anthropicUsage(usage) {
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  if (input === null && output === null) return null;
  return {
    format: "anthropic",
    model: null,
    inputTokens: input,
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens),
    outputTokens: output,
    reasoningTokens: null,
    totalTokens: input === null || output === null ? null : input + output,
  };
}

export function usageFromJson(payload, modelHint = null) {
  if (!payload || typeof payload !== "object") return null;
  const usage = payload.usage;
  if (!usage || typeof usage !== "object") return null;
  const normalized = "prompt_tokens" in usage || "completion_tokens" in usage
    ? openAiUsage(usage)
    : anthropicUsage(usage);
  if (!normalized) return null;
  if (!normalized.model && typeof modelHint === "string") normalized.model = modelHint;
  return normalized;
}

/** 从响应文本（可能是 JSON 或 SSE）提取 usage；失败返回 null。 */
export function usageFromBody(text, modelHint = null) {
  if (typeof text !== "string" || text.length === 0) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return usageFromJson(JSON.parse(trimmed), modelHint);
    } catch {
      return null;
    }
  }
  let found = null;
  let anthropicInput = null;
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event?.type === "message_start" && event.message?.usage) {
      anthropicInput = anthropicUsage(event.message.usage);
    } else if (event?.type === "message_delta" && event.usage) {
      const delta = anthropicUsage(event.usage);
      if (delta && anthropicInput) {
        found = {
          ...anthropicInput,
          outputTokens: delta.outputTokens ?? anthropicInput.outputTokens,
          totalTokens: anthropicInput.inputTokens !== null && delta.outputTokens !== null ? anthropicInput.inputTokens + delta.outputTokens : null,
        };
      } else if (delta) found = delta;
    } else if (event?.usage) {
      const usage = usageFromJson(event, modelHint);
      if (usage) found = usage;
    }
  }
  return found;
}

/** 从请求体取 model（仅用于标注，不改变用量）。 */
export function modelFromRequestBody(bodyText) {
  if (typeof bodyText !== "string" || !bodyText.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(bodyText);
    return typeof parsed?.model === "string" ? parsed.model.slice(0, 120) : null;
  } catch {
    return null;
  }
}
