/**
 * 聚合引擎（v2）：支持日期范围 + 模型/任务/项目筛选，产出 totals/byDay/models/tasks/projects/sessions/tools。
 * 所有统计基于 usage 桶；任务 = 一个 DSH 会话（标题+工作区），子代理会话按 delegationDepth 标记。
 */
import { round } from "./math.mjs";
import { normalizeModel } from "./pricing.mjs";

const TOP_N = 5;

function emptyService() {
  return { webSearch: { success: 0, failed: 0 }, webFetch: { success: 0, failed: 0 } };
}

function addService(target, source) {
  for (const kind of ["webSearch", "webFetch"]) {
    target[kind].success += source?.[kind]?.success ?? 0;
    target[kind].failed += source?.[kind]?.failed ?? 0;
  }
  return target;
}

function emptyReliability() {
  return { retries: 0, rateLimit: 0, toolResults: 0, toolErrors: 0, byCode: {} };
}

export function zeroMetrics() {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costCny: 0,
    costKnownTokens: 0,
    costUnknownTokens: 0,
    messages: 0,
  };
}

export function mergeMetrics(target, source) {
  if (!source) return target;
  target.inputTokens += source.inputTokens ?? 0;
  target.cacheReadTokens += source.cacheReadTokens ?? 0;
  target.cacheWriteTokens += source.cacheWriteTokens ?? 0;
  target.outputTokens += source.outputTokens ?? 0;
  target.reasoningTokens += source.reasoningTokens ?? 0;
  target.totalTokens += source.totalTokens ?? 0;
  target.costCny += source.costCny ?? 0;
  target.costKnownTokens += source.costKnownTokens ?? 0;
  target.costUnknownTokens += source.costUnknownTokens ?? 0;
  target.messages += source.messages ?? 0;
  return target;
}

/** FNV-1a 32bit → 稳定短 key（任务/项目标识）。 */
export function stableKey(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value ?? "")) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function taskKeyOf(summary) {
  return stableKey(`${summary.title ?? ""}|${summary.projectSlug ?? ""}|${summary.id ?? ""}`);
}

/**
 * @param {{range: object, model?: string|null, project?: string|null, task?: string|null, includeSubagents?: boolean}} options
 */
export function createFilter(options) {
  const includeSubagents = options.includeSubagents !== false;
  const model = typeof options.model === "string" && options.model.length > 0 ? normalizeModel(options.model) : null;
  const project = typeof options.project === "string" && options.project.length > 0 ? options.project : null;
  const task = typeof options.task === "string" && options.task.length > 0 ? options.task : null;
  return {
    model,
    project,
    task,
    includeSubagents,
    startDate: options.range.startDate,
    endDate: options.range.endDate,
    /** 会话级过滤 */
    acceptSummary(summary) {
      if (!includeSubagents && (summary.delegationDepth ?? 0) > 0) return false;
      if (project && summary.projectSlug !== project) return false;
      if (task && taskKeyOf(summary) !== task) return false;
      return true;
    },
    acceptDate(dateKey) {
      return dateKey >= options.range.startDate && dateKey <= options.range.endDate;
    },
    acceptModel(modelName) {
      return !model || modelName === model;
    },
  };
}

/**
 * 聚合（模型维度遍历 → 支持 model 过滤）。
 * @returns {{totals:object, byDay:object, models:Map<string,object>, tasks:Map<string,object>, projects:Map<string,object>, sessions:object[], tools:Map<string,number>}}
 */
export function aggregateAll(summaries, filter) {
  const totals = zeroMetrics();
  const byDay = {};
  const models = new Map();
  const tasks = new Map();
  const projects = new Map();
  const sessions = [];
  const tools = new Map();
  const service = emptyService();
  const reliability = emptyReliability();
  const estimation = { messages: 0, tokens: 0 };

  for (const summary of summaries) {
    if (!filter.acceptSummary(summary)) continue;
    const tKey = taskKeyOf(summary);
    let sessionMetrics = zeroMetrics();
    let touched = false;

    for (const [dateKey, modelMap] of Object.entries(summary.byDayModel ?? {})) {
      if (!filter.acceptDate(dateKey)) continue;
      for (const [model, metrics] of Object.entries(modelMap)) {
        if (!filter.acceptModel(model)) continue;
        touched = true;
        mergeMetrics(totals, metrics);
        if (!byDay[dateKey]) byDay[dateKey] = zeroMetrics();
        mergeMetrics(byDay[dateKey], metrics);
        mergeMetrics(sessionMetrics, metrics);

        if (!models.has(model)) models.set(model, zeroMetrics());
        mergeMetrics(models.get(model), metrics);

        const taskRow = tasks.get(tKey) ?? {
          key: tKey,
          title: summary.title ?? summary.id ?? "(untitled)",
          project: summary.projectSlug ?? null,
          metrics: zeroMetrics(),
          models: new Set(),
          lastAt: 0,
          isSubagent: (summary.delegationDepth ?? 0) > 0,
          parentSession: summary.parentSession ?? null,
          sessionId: summary.id ?? null,
        };
        mergeMetrics(taskRow.metrics, metrics);
        taskRow.models.add(model);
        if ((summary.lastAt ?? 0) > taskRow.lastAt) taskRow.lastAt = summary.lastAt ?? 0;
        tasks.set(tKey, taskRow);

        const projectKey = summary.projectSlug ?? "(unknown)";
        const projectRow = projects.get(projectKey) ?? { project: projectKey, metrics: zeroMetrics(), sessions: new Set(), tasks: new Set(), lastAt: 0 };
        mergeMetrics(projectRow.metrics, metrics);
        projectRow.sessions.add(summary.id ?? "?");
        projectRow.tasks.add(tKey);
        if ((summary.lastAt ?? 0) > projectRow.lastAt) projectRow.lastAt = summary.lastAt ?? 0;
        projects.set(projectKey, projectRow);
      }
    }

    for (const [dateKey, toolMap] of Object.entries(summary.byDayTools ?? {})) {
      if (!filter.acceptDate(dateKey)) continue;
      for (const [name, count] of Object.entries(toolMap)) tools.set(name, (tools.get(name) ?? 0) + count);
    }

    for (const [dateKey, dayService] of Object.entries(summary.byDayService ?? {})) {
      if (!filter.acceptDate(dateKey)) continue;
      addService(service, dayService);
    }

    for (const [dateKey, dayReliability] of Object.entries(summary.byDayReliability ?? {})) {
      if (!filter.acceptDate(dateKey)) continue;
      reliability.retries += dayReliability.retries ?? 0;
      reliability.rateLimit += dayReliability.rateLimit ?? 0;
      reliability.toolResults += dayReliability.toolResults ?? 0;
      reliability.toolErrors += dayReliability.toolErrors ?? 0;
      for (const [code, count] of Object.entries(dayReliability.byCode ?? {})) {
        reliability.byCode[code] = (reliability.byCode[code] ?? 0) + count;
      }
    }

    for (const [dateKey, dayEstimation] of Object.entries(summary.byDayEstimation ?? {})) {
      if (!filter.acceptDate(dateKey)) continue;
      estimation.messages += dayEstimation.messages ?? 0;
      estimation.tokens += dayEstimation.tokens ?? 0;
    }

    if (touched) {
      sessions.push({
        id: summary.id,
        title: summary.title ?? summary.id ?? "(untitled)",
        project: summary.projectSlug ?? null,
        taskKey: tKey,
        tokens: sessionMetrics.totalTokens,
        costCny: round(sessionMetrics.costCny, 4),
        messages: sessionMetrics.messages,
        lastAt: summary.lastAt ?? null,
        delegationDepth: summary.delegationDepth ?? 0,
      });
    }
  }

  totals.costCny = round(totals.costCny, 4);
  for (const row of tasks.values()) row.metrics.costCny = round(row.metrics.costCny, 4);
  for (const row of projects.values()) row.metrics.costCny = round(row.metrics.costCny, 4);
  sessions.sort((a, b) => b.tokens - a.tokens);

  return { totals, byDay, models, tasks, projects, sessions, tools, service, reliability, estimation };
}

export function topModels(models, limit = TOP_N) {
  return [...models.entries()]
    .map(([model, metrics]) => ({ model, tokens: metrics.totalTokens, costCny: round(metrics.costCny, 4), messages: metrics.messages }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit);
}

export function topTools(tools, limit = TOP_N) {
  return [...tools.entries()]
    .map(([name, calls]) => ({ name, calls }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, limit);
}

/** 子代理树：parentSession → children。 */
export function buildSubagentTree(summaries) {
  const byId = new Map();
  for (const summary of summaries) {
    if (summary.id) byId.set(summary.id, summary);
  }
  const parentRows = new Map();
  const orphans = [];
  for (const summary of summaries) {
    const depth = summary.delegationDepth ?? 0;
    if (depth <= 0) continue;
    const tokens = Object.values(summary.byDay ?? {}).reduce((sum, metrics) => sum + (metrics.totalTokens ?? 0), 0);
    const cost = Object.values(summary.byDay ?? {}).reduce((sum, metrics) => sum + (metrics.costCny ?? 0), 0);
    const child = {
      sessionId: summary.id,
      title: summary.title ?? summary.id,
      depth,
      tokens,
      costCny: round(cost, 4),
      lastAt: summary.lastAt ?? null,
    };
    const parentId = summary.parentSession ?? null;
    if (parentId && byId.has(parentId)) {
      const parent = byId.get(parentId);
      const row = parentRows.get(parentId) ?? { parentSessionId: parentId, parentTitle: parent.title ?? parentId, parentTokens: 0, children: [] };
      row.parentTokens += tokens;
      row.children.push(child);
      parentRows.set(parentId, row);
    } else {
      orphans.push(child);
    }
  }
  return { items: [...parentRows.values()].sort((a, b) => b.parentTokens - a.parentTokens), orphans };
}

/** 任务/项目 → 可序列化行（含占比、分页、搜索、排序）。 */
export function taskRows(tasks, totals, options = {}) {
  const query = typeof options.q === "string" ? options.q.trim().toLowerCase() : "";
  const sort = ["tokens", "cost", "messages", "lastAt"].includes(options.sort) ? options.sort : "tokens";
  const order = options.order === "asc" ? 1 : -1;
  const page = Math.max(1, Number.parseInt(options.page ?? "1", 10) || 1);
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(options.pageSize ?? "20", 10) || 20));
  const totalTokens = totals.totalTokens || 1;

  let rows = [...tasks.values()].map((row) => ({
    key: row.key,
    title: row.title,
    project: row.project,
    models: [...row.models],
    tokens: row.metrics.totalTokens,
    costCny: round(row.metrics.costCny, 4),
    messages: row.metrics.messages,
    lastAt: row.lastAt ? new Date(row.lastAt).toISOString() : null,
    sharePercent: round((row.metrics.totalTokens / totalTokens) * 100, 2),
    subagentTokens: row.isSubagent ? row.metrics.totalTokens : 0,
    isSubagent: row.isSubagent,
  }));

  if (query) rows = rows.filter((row) => row.title.toLowerCase().includes(query) || (row.project ?? "").toLowerCase().includes(query));
  rows.sort((left, right) => {
    if (sort === "lastAt") return ((left.lastAt ?? "") < (right.lastAt ?? "") ? -1 : 1) * order;
    return ((left[sort] ?? 0) - (right[sort] ?? 0)) * order;
  });

  const total = rows.length;
  const start = (page - 1) * pageSize;
  return { items: rows.slice(start, start + pageSize), total, page, pageSize };
}

export function projectRows(projects, totals) {
  const totalTokens = totals.totalTokens || 1;
  return [...projects.values()]
    .map((row) => ({
      project: row.project,
      tokens: row.metrics.totalTokens,
      costCny: round(row.metrics.costCny, 4),
      sessions: row.sessions.size,
      tasks: row.tasks.size,
      lastAt: row.lastAt ? new Date(row.lastAt).toISOString() : null,
      sharePercent: round((row.metrics.totalTokens / totalTokens) * 100, 2),
    }))
    .sort((a, b) => b.tokens - a.tokens);
}
