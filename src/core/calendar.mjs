/**
 * 日历下钻（月视图）：每一天的 tokens/成本/舒适度/Top 任务/Top 模型。
 * 对应参考产品 UsageCalendar 的详情能力。
 */
import { round } from "./math.mjs";
import { stableKey } from "./aggregate.mjs";

function monthDays(month) {
  const [year, mon] = month.split("-").map(Number);
  if (!year || !mon) return [];
  const days = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return Array.from({ length: days }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
}

/**
 * @param {{summaries: object[], month: string, config: object, comfortEntries: object[], filter: object}} input
 */
export function buildCalendar(input) {
  const month = /^\d{4}-\d{2}$/.test(input.month) ? input.month : new Date().toISOString().slice(0, 7);
  const comfortByDate = new Map((input.comfortEntries ?? []).map((entry) => [entry.date, entry.level]));
  const rows = new Map(monthDays(month).map((date) => [date, { tokens: 0, costCny: 0, sessions: new Set(), tasks: new Map(), models: new Map() }]));

  for (const summary of input.summaries) {
    if (input.filter && !input.filter.acceptSummary(summary)) continue;
    const taskTitle = summary.title ?? summary.id ?? "(untitled)";
    const taskKey = stableKey(`${taskTitle}|${summary.projectSlug ?? ""}`);
    for (const [dateKey, modelMap] of Object.entries(summary.byDayModel ?? {})) {
      if (!dateKey.startsWith(month) || !rows.has(dateKey)) continue;
      const row = rows.get(dateKey);
      for (const [model, metrics] of Object.entries(modelMap)) {
        if (input.filter && !input.filter.acceptModel(model)) continue;
        row.tokens += metrics.totalTokens ?? 0;
        row.costCny += metrics.costCny ?? 0;
        row.sessions.add(summary.id ?? "?");
        const task = row.tasks.get(taskKey) ?? { title: taskTitle, tokens: 0 };
        task.tokens += metrics.totalTokens ?? 0;
        row.tasks.set(taskKey, task);
        const modelRow = row.models.get(model) ?? { model, tokens: 0 };
        modelRow.tokens += metrics.totalTokens ?? 0;
        row.models.set(model, modelRow);
      }
    }
  }

  const days = [...rows.entries()].map(([date, row]) => ({
    date,
    tokens: row.tokens,
    costCny: round(row.costCny, 4),
    comfort: comfortByDate.get(date) ?? null,
    sessions: row.sessions.size,
    topTasks: [...row.tasks.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 5),
    topModels: [...row.models.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 5),
  }));

  return { month, days };
}
