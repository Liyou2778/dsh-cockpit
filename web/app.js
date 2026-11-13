/* ============================================================
 * DSH 驾驶舱 · 前端逻辑 v2（原生 ES2022，零依赖、零构建）
 * 分节：工具 → 状态 → i18n/主题 → API → 范围 → 加载 → 各区块渲染
 *       → 图表交互 → 小票 → 通知 → 日历 → 设置 → 事件 → 启动
 * 约定：字段缺失显示「—」；请求失败保留上次数据 + 顶部横幅；
 *       所有请求经 api() 拼接 window.__COCKPIT_BASE__。
 * ============================================================ */

import { translate, normalizeLanguage } from './lib/i18n.js';
import { paletteFor, drawTrend, drawRiskMap, drawComfortCurve, drawBinned } from './lib/charts.js';
import { drawReceipt, receiptBlob, downloadBlob, downloadJson, copyPng } from './lib/receipt.js';

/* ---------- 1. 常量与状态 ---------- */
const BASE = (typeof window !== 'undefined' && window.__COCKPIT_BASE__) || '';
const api = (path) => `${BASE}/api${path}`;
const POLL_MS = 10_000;
const AUX_POLL_TICKS = 6;
const RANGE_KINDS = ['cycle', 'today', '7d', '30d', '90d', 'all', 'custom'];
const RANGE_KEYS = { cycle: 'range.cycle', today: 'range.today', '7d': 'range.7d', '30d': 'range.30d', '90d': 'range.90d', all: 'range.all' };
const COMFORT_EMOJI = ['😌', '🙂', '😐', '😣', '🥵'];
const COMFORT_LEVEL_KEYS = ['comfort.level1', 'comfort.level2', 'comfort.level3', 'comfort.level4', 'comfort.level5'];

const state = {
  lang: 'zh',
  prefs: { theme: 'dark', fontScale: 1, density: 'comfortable' },
  status: null,
  config: null,
  history: [],
  history90: [],
  metric: 'tokens',
  tasks: { items: [], total: 0, page: 1, pageSize: 20, q: '', sort: 'tokens', order: 'desc', loading: false, error: false, loaded: false },
  projects: { items: [], total: 0, loading: false, error: false, loaded: false },
  subagents: { items: [], orphans: [], loading: false, error: false, loaded: false },
  team: { enabled: false, loading: false, loaded: false, error: null, data: null },
  taskTab: 'tasks',
  expandedTask: null,
  collapsedParents: new Set(),
  insights: null,
  notifications: { settings: null, alerts: [], unread: 0, loaded: false },
  readAlertIds: readStoredSet('dsh-cockpit-read-alerts'),
  notifiedAlertIds: new Set(),
  comfort: { entries: [], fit: null, binned: [], calendar: [], loaded: false },
  calendar: { month: null, days: [], selected: null, loading: false, error: false },
  receiptSelection: new Set(),
  range: { kind: 'cycle', from: null, to: null },
  localComfort: null,
  heatFocus: -1,
  trendHover: -1,
  trendGeo: null,
  riskGeo: null,
  bannerDismissed: false,
  lastRefresh: null,
  loadedOnce: false,
  busy: false,
  pollTicks: 0,
};
let rangeEpoch = 0;
let taskSeq = 0;
let searchTimer = 0;
let toastTimer = 0;

function readStoredSet(key) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}
function persistSet(key, set) {
  try { window.localStorage.setItem(key, JSON.stringify([...set])); } catch { /* storage 不可用时静默 */ }
}

/* ---------- 2. 工具函数 ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const t = (key, vars) => translate(state.lang, key, vars);
const setText = (sel, value) => { const node = $(sel); if (node) node.textContent = value; };
const setHTML = (sel, value) => { const node = $(sel); if (node) node.innerHTML = value; };
const setHidden = (sel, hidden) => { const node = $(sel); if (node) node.hidden = hidden; };

function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
  return null;
}
const clamp = (value, lo = 0, hi = 100) => (value === null ? null : Math.min(hi, Math.max(lo, value)));
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const nf = new Intl.NumberFormat('zh-CN');
const localeTag = () => (state.lang === 'en' ? 'en-US' : 'zh-CN');
const timeFmt = (options) => new Intl.DateTimeFormat(localeTag(), { hour12: false, ...options });
const dateOf = (iso) => {
  const date = iso === null || iso === undefined || iso === '' ? new Date(NaN) : new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
};
const fmtInt = (value) => { const n = num(value); return n === null ? '—' : nf.format(Math.round(n)); };
const fmtCompact = (value) => {
  const n = num(value);
  if (n === null) return '—';
  const abs = Math.abs(n);
  if (state.lang === 'en') {
    if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return nf.format(Math.round(n));
  }
  return abs >= 1e8 ? `${(n / 1e8).toFixed(2)}亿` : abs >= 1e4 ? `${(n / 1e4).toFixed(1)}万` : nf.format(Math.round(n));
};
const fmtPct = (value, digits = 1) => { const n = num(value); return n === null ? '—' : `${n.toFixed(digits)}%`; };
const fmtCny = (value, digits = 2) => { const n = num(value); return n === null ? '—' : `¥${n.toFixed(digits)}`; };
const fmtEta = (value) => {
  const n = num(value);
  if (n === null) return '—';
  if (n <= 0.25) return t('hero.etaSoon');
  return state.lang === 'en' ? `~${n.toFixed(1)}h` : `~${n.toFixed(1)} 小时`;
};
const fmtRate = (value) => { const n = num(value); return n === null ? '—' : `${(n <= 1.5 ? n * 100 : n).toFixed(0)}%`; };
const fmtFull = (iso) => { const date = dateOf(iso); return date ? timeFmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date) : '—'; };
const hhmm = (iso) => { const date = dateOf(iso); return date ? timeFmt({ hour: '2-digit', minute: '2-digit' }).format(date) : '—'; };
const localKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const hoursUntil = (iso) => { const date = dateOf(iso); return date ? (date.getTime() - Date.now()) / 3.6e6 : null; };
const fmtRel = (iso) => {
  const date = dateOf(iso);
  if (!date) return '—';
  const mins = (Date.now() - date.getTime()) / 60000;
  if (mins < 1) return t('date.justNow');
  if (mins < 60) return t('date.minutesAgo', { n: Math.round(mins) });
  if (mins < 1440) return t('date.hoursAgo', { n: Math.round(mins / 60) });
  return t('date.daysAgo', { n: Math.round(mins / 1440) });
};
const truncate = (text, max) => { const s = String(text ?? ''); return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s; };
const quantiles = (values, qs) => {
  if (!values.length) return qs.map(() => null);
  const sorted = [...values].sort((a, b) => a - b);
  return qs.map((q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]);
};
const palette = () => paletteFor(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
function levelFor(value, thresholds) {
  if (value === null || value === undefined) return -1;
  if (value <= 0) return 0;
  let level = 0;
  thresholds.forEach((threshold) => { if (threshold !== null && value > threshold) level += 1; });
  return level;
}
function maskTitle(title, fallback) {
  const raw = String(title || fallback || '').trim();
  if (!raw) return '—';
  if (!state.config?.ui?.maskTitles || raw.endsWith('***')) return raw;
  return raw.length <= 2 ? '••' : `${raw.slice(0, 2)}••••`;
}
function comfortLabel(level) {
  const index = clamp(num(level), 1, 5);
  return index === null ? '—' : t(COMFORT_LEVEL_KEYS[index - 1]);
}
function statusLabel(status) {
  return t({ on_track: 'status.on_track', over_pace: 'status.over_pace', unknown: 'status.unknown' }[status] || 'status.unknown');
}

/* ---------- 3. i18n / 主题 / 外观 ---------- */
function applyI18n(root = document) {
  $$('[data-i18n]', root).forEach((node) => { node.textContent = t(node.dataset.i18n); });
  $$('[data-i18n-aria]', root).forEach((node) => node.setAttribute('aria-label', t(node.dataset.i18nAria)));
  $$('[data-i18n-placeholder]', root).forEach((node) => node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder)));
  $$('[data-i18n-title]', root).forEach((node) => node.setAttribute('title', t(node.dataset.i18nTitle)));
  document.title = t('app.title');
  document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-CN';
}
function resolveTheme(theme) {
  if (theme === 'light') return 'light';
  if (theme === 'dark') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function applyDisplay(prefs) {
  state.prefs = { ...state.prefs, ...prefs };
  const resolved = resolveTheme(state.prefs.theme);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePref = state.prefs.theme;
  document.documentElement.style.setProperty('--font-scale', String(state.prefs.fontScale));
  document.documentElement.dataset.density = state.prefs.density;
}
function applyUiFromConfig() {
  const ui = state.config?.ui || {};
  state.lang = normalizeLanguage(ui.language ?? state.lang);
  applyDisplay({
    theme: ui.theme === 'light' || ui.theme === 'auto' ? ui.theme : 'dark',
    fontScale: [0.9, 1, 1.15].includes(Number(ui.fontScale)) ? Number(ui.fontScale) : 1,
    density: ui.density === 'compact' ? 'compact' : 'comfortable',
  });
  applyI18n();
}
function rerenderAll() {
  renderRangeBar();
  renderTopbar();
  renderHero();
  renderPace();
  renderPlan();
  renderForecast();
  renderRiskMap();
  renderInsights();
  renderDistribution();
  renderComfort();
  renderReceiptStats();
  renderHealth();
  renderTrend();
  renderHeatmap();
  renderTasks();
  renderProjects();
  renderSubagents();
  renderNotifications();
  renderReceiptTasks();
  renderComfortCalendar();
  if (state.calendar.month) renderCalendar();
  renderSettingsReadonly();
}
function setLanguage(lang) {
  const next = normalizeLanguage(lang);
  if (state.lang === next) return;
  state.lang = next;
  applyI18n();
  rerenderAll();
}

/* ---------- 4. API / 网络状态 / toast ---------- */
function buildUrl(path, params) {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '' || value === false) return;
    search.set(key, String(value));
  });
  const query = search.toString();
  return api(path) + (query ? `?${query}` : '');
}
async function request(path, params, options) {
  const res = await fetch(buildUrl(path, params), { cache: 'no-store', ...options });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data || typeof data !== 'object') throw new Error('bad payload');
  return data;
}
const getJSON = (path, params) => request(path, params, { headers: { Accept: 'application/json' } });
const postJSON = (path, body) => request(path, null, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify(body ?? {}),
});
function rangeParams() {
  return state.range.kind === 'custom'
    ? { range: 'custom', from: state.range.from, to: state.range.to }
    : { range: state.range.kind };
}
function reportOffline(err) {
  if (state.bannerDismissed) { $('#net-banner').hidden = true; return; }
  setText('#banner-text', `${t('common.offline')}${err?.message ? `（${err.message}）` : ''}`);
  $('#net-banner').hidden = false;
}
function reportOnline() {
  const banner = $('#net-banner');
  if (banner) banner.hidden = true;
  state.bannerDismissed = false;
}
function showToast(message, tone = 'ok') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast is-visible${tone === 'error' ? ' is-error' : ''}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.className = 'toast'; }, 2800);
}

/* ---------- 5. 范围条 / URL hash ---------- */
function parseHash() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const kind = RANGE_KINDS.includes(params.get('range')) ? params.get('range') : 'cycle';
  return { kind, from: params.get('from'), to: params.get('to') };
}
function syncHash() {
  const params = new URLSearchParams();
  params.set('range', state.range.kind);
  if (state.range.kind === 'custom') {
    if (state.range.from) params.set('from', state.range.from);
    if (state.range.to) params.set('to', state.range.to);
  }
  const next = `#${params.toString()}`;
  if (window.location.hash !== next) window.history.replaceState(null, '', next);
}
function renderRangeBar() {
  $$('#range-tabs .seg-btn').forEach((button) => {
    const active = button.dataset.range === state.range.kind;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const custom = $('#range-custom');
  custom.hidden = state.range.kind !== 'custom';
  if (state.range.kind === 'custom') {
    if (state.range.from && !$('#range-from').value) $('#range-from').value = state.range.from;
    if (state.range.to && !$('#range-to').value) $('#range-to').value = state.range.to;
  }
  const range = state.status?.range;
  const fallbackLabel = t(RANGE_KEYS[state.range.kind] || 'range.cycle');
  const label = state.lang === 'zh' ? (range?.label || fallbackLabel) : fallbackLabel;
  setText('#range-label', t('range.label', { label }));
  setText('#receipt-range', label);
}
function setRange(range, options = {}) {
  const next = { kind: RANGE_KINDS.includes(range.kind) ? range.kind : 'cycle', from: range.from || null, to: range.to || null };
  if (next.kind === 'custom') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next.from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(next.to || '') || next.from > next.to) {
      showToast(t('range.invalid'), 'error');
      return false;
    }
  }
  state.range = next;
  if (!options.skipHash) syncHash();
  renderRangeBar();
  if (options.reload !== false) reloadRangeData();
  return true;
}

/* ---------- 6. 数据加载 ---------- */
function finishBoot() {
  if (state.loadedOnce) return;
  state.loadedOnce = true;
  document.body.classList.remove('is-booting');
}
async function loadStatus(options = {}) {
  try {
    const params = { ...rangeParams() };
    if (options.balanceRefresh) params.refresh = '1';
    state.status = await getJSON('/status', params);
    state.lastRefresh = new Date();
    reportOnline();
    renderTopbar();
    renderHero();
    renderPace();
    renderPlan();
    renderForecast();
    renderRiskMap();
    renderInsights();
    renderDistribution();
    renderComfort();
    renderReceiptStats();
    renderHealth();
    renderRangeBar();
    return true;
  } catch (err) {
    reportOffline(err);
    return false;
  } finally {
    finishBoot();
  }
}
async function loadHistory() {
  const epoch = rangeEpoch;
  try {
    const data = await getJSON('/history', { ...rangeParams(), days: 30 });
    if (epoch !== rangeEpoch) return;
    if (Array.isArray(data.days)) state.history = data.days;
    reportOnline();
  } catch (err) {
    reportOffline(err);
  }
  if (epoch !== rangeEpoch) return;
  try {
    if (state.range.kind === '90d') state.history90 = state.history;
    else {
      const heat = await getJSON('/history', { range: '90d' });
      if (epoch === rangeEpoch && Array.isArray(heat.days)) state.history90 = heat.days;
    }
    reportOnline();
  } catch (err) {
    reportOffline(err);
    if (!state.history90.length && state.history.length) state.history90 = state.history;
  }
  if (epoch !== rangeEpoch) return;
  renderTrend();
  renderHeatmap();
}
async function loadTasks() {
  const epoch = rangeEpoch;
  const seq = ++taskSeq;
  state.tasks.loading = true;
  state.tasks.error = false;
  renderTasks();
  try {
    const params = {
      ...rangeParams(),
      q: state.tasks.q,
      sort: state.tasks.sort,
      order: state.tasks.order,
      page: state.tasks.page,
      pageSize: state.tasks.pageSize,
    };
    const data = await getJSON('/tasks', params);
    if (epoch !== rangeEpoch || seq !== taskSeq) return;
    state.tasks.items = Array.isArray(data.items) ? data.items : [];
    state.tasks.total = num(data.total) ?? state.tasks.items.length;
    if (num(data.page)) state.tasks.page = num(data.page);
    state.tasks.loaded = true;
    reportOnline();
  } catch (err) {
    if (epoch !== rangeEpoch || seq !== taskSeq) return;
    state.tasks.error = true;
    reportOffline(err);
  } finally {
    if (epoch === rangeEpoch && seq === taskSeq) {
      state.tasks.loading = false;
      renderTasks();
    }
  }
}
async function loadProjects() {
  const epoch = rangeEpoch;
  state.projects.loading = true;
  renderProjects();
  try {
    const data = await getJSON('/projects', rangeParams());
    if (epoch !== rangeEpoch) return;
    state.projects.items = Array.isArray(data.items) ? data.items : [];
    state.projects.total = num(data.total) ?? state.projects.items.length;
    state.projects.loaded = true;
    reportOnline();
  } catch (err) {
    if (epoch !== rangeEpoch) return;
    state.projects.error = true;
    reportOffline(err);
  } finally {
    if (epoch === rangeEpoch) {
      state.projects.loading = false;
      renderProjects();
    }
  }
}
async function loadSubagents() {
  const epoch = rangeEpoch;
  state.subagents.loading = true;
  renderSubagents();
  try {
    const data = await getJSON('/subagents', rangeParams());
    if (epoch !== rangeEpoch) return;
    state.subagents.items = Array.isArray(data.items) ? data.items : [];
    state.subagents.orphans = Array.isArray(data.orphans) ? data.orphans : [];
    state.subagents.loaded = true;
    reportOnline();
  } catch (err) {
    if (epoch !== rangeEpoch) return;
    state.subagents.error = true;
    reportOffline(err);
  } finally {
    if (epoch === rangeEpoch) {
      state.subagents.loading = false;
      renderSubagents();
    }
  }
}
async function loadInsights() {
  const epoch = rangeEpoch;
  try {
    const data = await getJSON('/insights', rangeParams());
    if (epoch !== rangeEpoch) return;
    state.insights = Array.isArray(data.items) ? data.items : [];
    reportOnline();
  } catch (err) {
    reportOffline(err);
    if (!Array.isArray(state.insights) && Array.isArray(state.status?.insights)) state.insights = state.status.insights;
  }
  if (epoch === rangeEpoch) renderInsights();
}
async function loadComfort() {
  try {
    const data = await getJSON('/comfort');
    state.comfort = {
      entries: Array.isArray(data.entries) ? data.entries : [],
      fit: data.fit && typeof data.fit === 'object' ? data.fit : null,
      binned: Array.isArray(data.binned) ? data.binned : [],
      calendar: Array.isArray(data.calendar) ? data.calendar : [],
      loaded: true,
    };
    reportOnline();
  } catch (err) {
    reportOffline(err);
  }
  renderComfort();
  renderComfortCalendar();
}
async function loadNotifications() {
  try {
    const data = await getJSON('/notifications');
    state.notifications = {
      settings: data.settings && typeof data.settings === 'object' ? data.settings : null,
      alerts: Array.isArray(data.alerts) ? data.alerts : [],
      unread: num(data.unread) ?? 0,
      loaded: true,
    };
    reportOnline();
    renderNotifications();
    maybeSystemNotify();
  } catch (err) {
    reportOffline(err);
    if (!state.notifications.loaded && state.status?.notifications) {
      state.notifications = {
        settings: null,
        alerts: Array.isArray(state.status.notifications.alerts) ? state.status.notifications.alerts : [],
        unread: num(state.status.notifications.unread) ?? 0,
        loaded: false,
      };
      renderNotifications();
    }
  }
}
async function loadConfig() {
  try {
    state.config = await getJSON('/config');
    reportOnline();
  } catch (err) {
    reportOffline(err);
  }
  applyUiFromConfig();
  renderSettingsForm();
}
function reloadRangeData() {
  rangeEpoch += 1;
  state.tasks.page = 1;
  state.expandedTask = null;
  state.trendHover = -1;
  Promise.all([loadStatus(), loadHistory(), loadTasks(), loadProjects(), loadSubagents(), loadInsights()]);
}
async function refreshAll() {
  if (state.busy) return;
  state.busy = true;
  const button = $('#refresh-btn');
  button.disabled = true;
  button.classList.add('is-busy');
  try { await postJSON('/rescan', {}); reportOnline(); }
  catch (err) { reportOffline(err); }
  rangeEpoch += 1;
  const [ok] = await Promise.all([loadStatus({ balanceRefresh: true }), loadHistory(), loadTasks(), loadProjects(), loadSubagents(), loadInsights(), loadComfort(), loadNotifications()]);
  if (state.config?.sync?.enabled) await loadTeam();
  state.busy = false;
  button.disabled = false;
  button.classList.remove('is-busy');
  showToast(ok ? t('common.refreshed') : t('common.refreshFailed'), ok ? 'ok' : 'error');
}

/* ---------- 7. 双环 / 配速 / 计划 / 预测 ---------- */
function ringSet(id, pct) {
  const node = document.getElementById(id);
  if (node) node.style.strokeDashoffset = String(100 - (clamp(num(pct)) ?? 0));
}
function renderTopbar() {
  const mode = state.status?.mode;
  const badge = $('#mode-badge');
  badge.textContent = mode === 'balance' ? t('top.mode.balance') : mode === 'local' ? t('top.mode.local') : t('top.mode.unknown');
  badge.className = `mode-badge ${mode === 'balance' ? 'is-balance' : mode === 'local' ? 'is-local' : 'is-unknown'}`;
  badge.title = mode === 'balance' ? t('top.mode.balanceTitle') : mode === 'local' ? t('top.mode.localTitle') : t('top.mode.unknownTitle');
  if (!state.lastRefresh) return;
  const time = $('#last-refresh');
  time.textContent = t('common.updated', { time: hhmm(state.lastRefresh.toISOString()) });
  time.dateTime = state.lastRefresh.toISOString();
  time.title = fmtFull(state.status?.generatedAt);
}
function renderHero() {
  const quota = state.status?.quota || {};
  const ctx = state.status?.context || {};
  const used = num(quota.usedPercent);
  const remaining = num(quota.remainingPercent) ?? (used === null ? null : clamp(100 - used));
  const resetAt = quota.resetsAt || quota.cycleEnd;
  ringSet('ring-quota-progress', used);
  setText('#quota-pct', fmtPct(used));
  setText('#quota-caption', quota.label || t('hero.quotaCaption'));
  setText('#quota-remaining', fmtPct(remaining));
  setText('#quota-reset', hhmm(resetAt));
  $('#quota-reset').title = resetAt ? t('hero.resetAtTitle', { time: fmtFull(resetAt) }) : t('hero.resetUnknown');
  const left = hoursUntil(resetAt);
  setText('#quota-countdown', left === null ? '—' : left > 0 ? fmtEta(left) : t('hero.soonReset'));
  const unit = quota.unit === 'cny' ? (state.lang === 'en' ? 'CNY' : '元') : quota.unit === 'tokens' ? 'token' : '';
  setText('#quota-used', num(quota.used) === null ? '—' : `${fmtCompact(quota.used)}${num(quota.limit) === null ? '' : ` / ${fmtCompact(quota.limit)}`} ${unit}`.trim());
  setText('#quota-axis', quota.axis === 'budget' ? t('settings.axis.budget') : quota.axis === 'balance' ? t('settings.axis.balance') : quota.axis === 'context' ? t('settings.axis.context') : '—');
  $('#ring-quota').setAttribute('aria-label', t('hero.quotaAria', { used: fmtPct(used), remaining: fmtPct(remaining), time: hhmm(resetAt) }));
  const ctxPct = num(ctx.percent);
  const eta = num(state.status?.forecast?.etaHours) ?? num(ctx.etaHours);
  const pressure = num(ctx.pressure);
  const windowSize = num(ctx.contextWindow);
  ringSet('ring-ctx-progress', ctxPct);
  setText('#ctx-pct', fmtPct(ctxPct));
  setText('#ctx-used', pressure === null ? '—' : `${fmtCompact(pressure)}${windowSize === null ? '' : ` / ${fmtCompact(windowSize)}`}`);
  setText('#ctx-eta', eta === null ? '—' : fmtEta(eta));
  setText('#ctx-compactions', num(ctx.compactions24h) === null ? '—' : `${fmtInt(ctx.compactions24h)} ${t('common.times')}`);
  const title = ctx.title || ctx.sessionId;
  setText('#ctx-title', title ? maskTitle(title, ctx.sessionId) : t('hero.noSession'));
  $('#ctx-title').title = title ? String(title) : t('hero.noSession');
  // 服务费 + 限流（P1/P2）：紧凑展示在双环底部
  const serviceCost = num(state.status?.serviceFees?.costCny);
  const rateLimit = num(state.status?.reliability?.rateLimit);
  const extraParts = [];
  if (serviceCost !== null) extraParts.push(`${state.lang === 'en' ? 'Fees' : '服务费'} ${fmtCny(serviceCost)}`);
  if (rateLimit !== null) extraParts.push(`429 ${fmtInt(rateLimit)}`);
  setText('#hero-extra', extraParts.length ? extraParts.join(' · ') : '—');
  // 官方账户优先（精准余额 + 官方累计花费），API Key 余额接口作回退
  const account = state.status?.account;
  const balance = state.status?.balance;
  const balanceEl = $('#hero-balance');
  if (balanceEl) {
    let text = '—';
    let title = '';
    if (account?.available) {
      text = `${state.lang === 'en' ? 'Balance' : '官方余额'} ${account.normalBalance ?? '—'} ${account.currency ?? 'CNY'}`;
      title = `官方账户 · 赠金 ${account.bonusBalance ?? '—'} · 官方累计花费 ${account.totalCost ?? '—'} · ${account.fetchedAt ?? ''}`;
    } else if (balance?.available) {
      text = `${state.lang === 'en' ? 'Balance' : '官方余额'} ${fmtCny(balance.total)}`;
      title = `${balance.currency ?? 'CNY'} · ${balance.fetchedAt ?? ''}${balance.cached ? '（缓存）' : '（实时）'}`;
    } else if (account?.enabled === false && balance?.enabled === false) {
      title = account.hint || balance.hint || '未开启';
    } else if (account?.error) {
      title = account.error.message || '官方账户不可用';
    } else if (balance?.error) {
      title = balance.error.message || '余额不可用';
    }
    setText('#hero-balance', text);
    balanceEl.title = title;
  }
  $('#ring-ctx').setAttribute('aria-label', t('hero.ctxAria', { percent: fmtPct(ctxPct), etaText: eta === null ? '' : t('hero.ctxEtaText', { hours: fmtEta(eta) }) }));
}
function renderPace() {
  const pace = state.status?.pace || {};
  const known = pace.status === 'on_track' || pace.status === 'over_pace';
  const rec = num(pace.recommendedUsedPercent);
  const actual = num(pace.usedPercent) ?? num(state.status?.quota?.usedPercent);
  const badge = $('#pace-badge');
  badge.textContent = t(`pace.${pace.status === 'over_pace' ? 'over_pace' : pace.status === 'on_track' ? 'on_track' : 'unknown'}`);
  badge.className = `badge ${pace.status === 'over_pace' ? 'is-warn' : pace.status === 'on_track' ? 'is-good' : 'is-muted'}`;
  if (!known || rec === null || actual === null) {
    setText('#pace-sentence', known ? t('pace.insufficient') : t('pace.unknownHint'));
  } else {
    const diff = actual - rec;
    const over = diff > 0.5;
    setHTML('#pace-sentence', t('pace.sentence', {
      rec: `<b>${esc(fmtPct(rec))}</b>`,
      act: `<b>${esc(fmtPct(actual))}</b>`,
      dir: `<span class="${over ? 'is-over' : 'is-under'}">${esc(over ? t('pace.over') : t('pace.under'))}</span>`,
      diff: `<span class="${over ? 'is-over' : 'is-under'}">${esc(fmtPct(Math.abs(diff)))}</span>`,
    }));
  }
  const fillPct = clamp(actual) ?? 0;
  $('#pace-fill').style.width = `${fillPct}%`;
  $('#pace-tick').style.left = `${clamp(rec) ?? 0}%`;
  const meter = $('#pace-meter');
  meter.className = `meter${pace.status === 'over_pace' ? (fillPct > 90 ? ' is-bad' : ' is-warn') : ''}`;
  meter.setAttribute('aria-valuenow', String(Math.round(fillPct)));
  setText('#pace-actual', fmtPct(actual));
  setText('#pace-recommended', fmtPct(rec));
  setText('#pace-today', fmtPct(pace.todayUsedPercent));
  setText('#pace-today-left', fmtPct(pace.todayRemainingPercent));
  const rate = num(pace.averageRate);
  setText('#pace-rate', rate === null ? '—' : `${rate.toFixed(2)}${pace.unit === 'hour' ? t('pace.perHour') : pace.unit === 'day' ? t('pace.perDay') : ''}`);
}
function renderPlan() {
  const plan = state.status?.plan || {};
  setText('#plan-suggested', fmtPct(plan.suggestedUsagePercent));
  setText('#plan-remaining', t('plan.keep', { value: fmtPct(plan.suggestedRemainingPercent) }));
  [['uniform', plan.uniformPacePercent], ['boost', plan.resetRiskBoostPercent], ['cap', plan.softCapPercent]].forEach(([key, value]) => {
    const row = $(`#plan-breakdowns .break-row[data-key="${key}"]`);
    if (!row) return;
    $('.mini-meter i', row).style.width = `${clamp(num(value)) ?? 0}%`;
    $('b', row).textContent = fmtPct(value);
  });
  const risk = num(plan.riskPercent);
  const chip = $('#plan-risk');
  chip.textContent = t('plan.risk', { value: risk === null ? '—' : String(Math.round(risk)) });
  chip.className = `risk-chip${risk === null ? '' : risk >= 60 ? ' is-high' : risk >= 35 ? ' is-mid' : ' is-low'}`;
  setText('#plan-daily-cap', fmtPct(plan.dailyCapPercent ?? state.config?.budget?.dailyCapPercent, 0));
  setText('#plan-day-total', fmtPct(plan.dayTotalPercent ?? state.config?.budget?.dayTotalPercent, 0));
}
function renderForecast() {
  const forecast = state.status?.forecast || {};
  const score = clamp(num(forecast.score));
  setText('#fc-score', score === null ? '—' : `${Math.round(score)}%`);
  setText('#fc-window', num(forecast.windowHours) === null ? '—' : t('forecast.window', { hours: fmtInt(forecast.windowHours) }));
  const sourceKey = forecast.source === 'history' ? 'history' : forecast.source === 'pressure' ? 'pressure' : 'heuristic';
  setText('#fc-source', t(`forecast.source.${sourceKey}`));
  $('#fc-gauge-fill').style.width = `${score ?? 0}%`;
  const marker = $('#fc-gauge-marker');
  marker.style.left = `${score ?? 0}%`;
  marker.style.opacity = score === null ? '0' : '1';
  const gauge = $('#fc-gauge');
  gauge.className = `gauge${score !== null && score >= 60 ? ' is-high' : ''}`;
  gauge.setAttribute('aria-valuenow', String(Math.round(score ?? 0)));
  const eta = num(forecast.etaHours) ?? num(state.status?.context?.etaHours);
  setHTML('#fc-eta', eta === null ? esc(t('forecast.etaUnknown')) : t('forecast.etaIn', { hours: `<b>${esc(fmtEta(eta))}</b>` }));
  const factors = Array.isArray(forecast.factors) ? forecast.factors.filter(Boolean).slice(0, 6) : [];
  setHTML('#fc-factors', factors.length ? factors.map((factor) => `<li>${esc(factor)}</li>`).join('') : `<li class="empty sm">${esc(t('forecast.noFactors'))}</li>`);
}

/* ---------- 8. 风险热力图 / 洞察 ---------- */
function renderRiskMap() {
  const riskMap = state.status?.riskMap;
  const empty = !riskMap || !Array.isArray(riskMap.cells) || riskMap.cells.length === 0;
  $('#risk-empty').hidden = !empty;
  $('#risk-canvas').hidden = empty;
  setText('#risk-x-label', t('risk.xLabel'));
  setText('#risk-y-label', t('risk.yLabel'));
  if (empty) {
    state.riskGeo = null;
    $('#risk-tip').hidden = true;
    $('#risk-canvas').setAttribute('aria-label', t('risk.empty'));
    return;
  }
  const geo = drawRiskMap($('#risk-canvas'), { riskMap, palette: palette(), formatPct: (value) => fmtPct(value, 0) });
  state.riskGeo = geo;
  const current = riskMap.current || {};
  $('#risk-canvas').setAttribute('aria-label', t('risk.aria', { x: fmtPct(current.pacePercent, 0), y: fmtPct(current.riskPercent, 0) }));
}
function renderInsights() {
  const items = Array.isArray(state.insights) ? state.insights : (Array.isArray(state.status?.insights) ? state.status.insights : []);
  const list = $('#insights-list');
  list.innerHTML = items.map((item) => {
    const severity = item.severity === 'warn' ? 'warn' : 'info';
    const action = ['open-tasks', 'open-calendar', 'open-settings'].includes(item.action) ? item.action : '';
    return `<li class="insight-item" data-insight-id="${esc(item.id || '')}"><span class="insight-severity is-${severity}">${esc(t(`insights.severity.${severity}`))}</span><div class="insight-body"><strong class="insight-title">${esc(item.title || '—')}</strong><p class="insight-text">${esc(item.body || '')}</p></div>${action ? `<button class="btn btn-xs insight-action" type="button" data-action="${action}">${esc(t(`insights.action.${action}`))}</button>` : ''}</li>`;
  }).join('');
  $('#insights-empty').hidden = items.length > 0;
  setText('#insights-count', items.length ? String(items.length) : '—');
}

/* ---------- 9. 趋势图 ---------- */
const trendRows = () => (Array.isArray(state.history) ? state.history : [])
  .filter((day) => day && typeof day.date === 'string')
  .map((day) => ({ date: day.date, status: day.status || 'unknown', tokens: num(day.tokens), cost: num(day.costCny) }))
  .sort((a, b) => a.date.localeCompare(b.date));
const trendValue = (row) => (state.metric === 'tokens' ? row.tokens : row.cost);
function renderTrend() {
  const rows = trendRows();
  const hasData = rows.some((row) => (trendValue(row) ?? 0) > 0);
  $('#trend-empty').hidden = hasData;
  $('#trend-canvas').hidden = !hasData;
  setText('#trend-hint', t('trend.hint', { n: rows.length }));
  if (!hasData) {
    state.trendGeo = null;
    $('#trend-tooltip').hidden = true;
    setText('#trend-desc', t('trend.empty'));
    return;
  }
  const result = drawTrend($('#trend-canvas'), {
    rows,
    metric: state.metric,
    hoverIndex: state.trendHover,
    palette: palette(),
    formatTick: (value) => (state.metric === 'tokens' ? fmtCompact(value) : fmtCny(value, value >= 10 ? 0 : 1)),
  });
  state.trendGeo = result?.geo || null;
  const last = rows[rows.length - 1];
  const value = state.metric === 'tokens' ? t('trend.tokensUnit', { value: fmtCompact(trendValue(last)) }) : t('trend.costUnit', { value: fmtCny(trendValue(last)) });
  setText('#trend-desc', t('trend.desc', { n: rows.length, metric: t(state.metric === 'tokens' ? 'trend.metric.tokens' : 'trend.metric.cost'), date: last.date, value }));
  $('#trend-canvas').setAttribute('aria-label', t('trend.aria', { n: rows.length }));
}
function handleTrendMove(ev) {
  const geo = state.trendGeo;
  if (!geo) return;
  const rect = $('#trend-canvas').getBoundingClientRect();
  const index = Math.min(geo.n - 1, Math.max(0, Math.floor((ev.clientX - rect.left - geo.pad.l) / geo.slot)));
  const row = trendRows()[index];
  if (!row) return;
  if (state.trendHover !== index) { state.trendHover = index; renderTrend(); }
  const value = state.metric === 'tokens' ? `${fmtCompact(row.tokens)} token` : fmtCny(row.cost);
  const tip = $('#trend-tooltip');
  tip.innerHTML = `<strong>${esc(row.date)}</strong><span>${esc(t(state.metric === 'tokens' ? 'trend.metric.tokens' : 'trend.metric.cost'))}：${esc(value)}</span><span>${esc(t('heat.status', { status: statusLabel(row.status) }))}</span>`;
  tip.hidden = false;
  const wrap = $('#trend-chart').getBoundingClientRect();
  const width = tip.offsetWidth || 130;
  tip.style.left = `${Math.min(wrap.width - width - 6, Math.max(6, ev.clientX - wrap.left - width / 2))}px`;
  tip.style.top = `${Math.max(8, Math.min(wrap.height - 76, ev.clientY - wrap.top - 64))}px`;
}
function leaveTrend() {
  state.trendHover = -1;
  $('#trend-tooltip').hidden = true;
  renderTrend();
}

/* ---------- 10. 热力日历 ---------- */
function heatDays() {
  const map = new Map();
  (state.history90.length ? state.history90 : state.history).forEach((day) => { if (day?.date) map.set(day.date, day); });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 83; i >= 0; i -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const key = localKey(date);
    const row = map.get(key);
    const noData = !row || (num(row.tokens) === 0 && (row.status ?? 'unknown') === 'unknown');
    days.push({ key, tokens: noData ? null : num(row.tokens), status: row?.status || 'unknown' });
  }
  return days;
}
function renderHeatmap() {
  const days = heatDays();
  const values = days.map((day) => day.tokens).filter((value) => value !== null);
  const thresholds = quantiles(values, [0.2, 0.4, 0.6, 0.8]);
  const todayKey = days.some((day) => day.key === localKey()) ? localKey() : days[days.length - 1].key;
  const grid = $('#heatmap');
  grid.innerHTML = days.map((day) => `<span class="heat-cell" role="gridcell" tabindex="-1" data-level="${levelFor(day.tokens, thresholds)}" data-date="${day.key}" data-tokens="${day.tokens ?? ''}" data-status="${esc(day.status)}"${day.key === todayKey ? ' data-today="1"' : ''} aria-label="${esc(day.key)}"></span>`).join('');
  const max = values.length ? Math.max(...values) : null;
  const maxDay = max === null ? null : days.find((day) => day.tokens === max);
  const desc = max === null ? t('heat.empty') : t('heat.desc', { max: fmtCompact(max), date: maxDay.key });
  setText('#heat-desc', desc);
  grid.setAttribute('aria-label', max === null ? t('heat.empty') : t('heat.aria', { value: fmtCompact(max), date: maxDay.key }));
  if (state.heatFocus >= days.length) state.heatFocus = days.length - 1;
}
function handleHeatMove(ev) {
  const cell = ev.target.closest('.heat-cell');
  if (!cell) { $('#heat-tooltip').hidden = true; return; }
  const tokens = num(cell.dataset.tokens);
  const tip = $('#heat-tooltip');
  tip.innerHTML = `<strong>${esc(cell.dataset.date)}</strong><span>${esc(tokens === null ? t('heat.noData') : `${fmtCompact(tokens)} token`)}</span><span>${esc(t('heat.status', { status: statusLabel(cell.dataset.status) }))}</span><span>${esc(t('heat.clickHint', { date: cell.dataset.date }))}</span>`;
  tip.hidden = false;
  const wrap = $('.heat-wrap').getBoundingClientRect();
  const width = tip.offsetWidth || 150;
  tip.style.left = `${Math.min(wrap.width - width - 6, Math.max(6, ev.clientX - wrap.left + 12))}px`;
  tip.style.top = `${Math.max(6, ev.clientY - wrap.top - tip.offsetHeight - 10)}px`;
}
function focusHeatCell(index) {
  const cells = $$('#heatmap .heat-cell');
  if (!cells.length) return;
  const next = Math.max(0, Math.min(cells.length - 1, index));
  cells.forEach((cell) => cell.classList.remove('is-focus'));
  state.heatFocus = next;
  const cell = cells[next];
  cell.classList.add('is-focus');
  cell.setAttribute('tabindex', '0');
  cell.focus({ preventScroll: true });
  cells.forEach((other, i) => { if (i !== next) other.setAttribute('tabindex', '-1'); });
}
function handleHeatKey(ev) {
  const cells = $$('#heatmap .heat-cell');
  if (!cells.length) return;
  const current = state.heatFocus >= 0 ? state.heatFocus : cells.findIndex((cell) => cell.getAttribute('tabindex') === '0');
  if (ev.key === 'ArrowRight') { ev.preventDefault(); focusHeatCell((current < 0 ? 0 : current) + 7); }
  else if (ev.key === 'ArrowLeft') { ev.preventDefault(); focusHeatCell((current < 0 ? cells.length - 1 : current) - 7); }
  else if (ev.key === 'ArrowDown') { ev.preventDefault(); focusHeatCell((current < 0 ? 0 : current) + 1); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); focusHeatCell((current < 0 ? cells.length - 1 : current) - 1); }
  else if (ev.key === 'Home') { ev.preventDefault(); focusHeatCell(0); }
  else if (ev.key === 'End') { ev.preventDefault(); focusHeatCell(cells.length - 1); }
  else if (ev.key === 'Enter' || ev.key === ' ') {
    if (current >= 0) { ev.preventDefault(); openCalendar(cells[current].dataset.date); }
  }
}

/* ---------- 11. 任务 / 项目 / 子代理 ---------- */
function emptyRow(colspan, text) {
  return `<tr><td colspan="${colspan}" class="empty sm">${esc(text)}</td></tr>`;
}
function renderSortState() {
  $$('.sort-btn').forEach((button) => {
    const active = button.dataset.sort === state.tasks.sort;
    button.classList.toggle('is-active', active);
    const th = button.closest('th');
    if (th) {
      th.setAttribute('aria-sort', active ? (state.tasks.order === 'asc' ? 'ascending' : 'descending') : 'none');
      if (!active) th.removeAttribute('aria-sort');
    }
  });
}
async function loadTeam() {
  state.team.loading = true;
  try {
    const report = await getJSON('/sync/members');
    state.team = {
      enabled: report.enabled === true,
      loading: false,
      loaded: true,
      error: report.offline ? (report.error ?? { message: 'offline' }) : null,
      data: report,
    };
  } catch (err) {
    state.team = { enabled: false, loading: false, loaded: true, error: { message: String(err?.message ?? err) }, data: null };
  }
  renderMembers();
}

function renderMembers() {
  const body = $('#members-body');
  if (!body) return;
  const team = state.team;
  const data = team.data;
  const enabled = Boolean(data?.enabled);
  const edit = $('#team-plan-edit');
  if (edit) edit.hidden = !enabled;
  if (!enabled) {
    // 未开启时给用户可操作文案（服务端 hint 是 CLI 语境，不直接展示）
    body.innerHTML = emptyRow(7, t('team.disabled'));
    setText('#team-plan', '—');
    setText('#team-status', '—');
    return;
  }
  const plan = data.plan ?? { dailyTokenCap: null, dayTotalPercent: 100 };
  const dayPlan = data.dayPlan ?? null;
  if (dayPlan?.available) {
    setText('#team-plan', t('team.dayPlanSummary', {
      rec: dayPlan.recommendation,
      alloc: dayPlan.totalAllocated,
      risk: dayPlan.risk?.value ?? 0,
    }));
  } else {
    setText('#team-plan', plan.dailyTokenCap
      ? t('team.planSummary', { cap: fmtCompact(plan.dailyTokenCap), percent: plan.dayTotalPercent })
      : t('team.planUnset'));
  }
  if (data.totals) {
    setText('#team-status', t('team.total', {
      members: fmtInt(data.totals.members),
      tokens: fmtCompact(data.totals.todayTokens),
      cost: fmtCny(data.totals.todayCostCny),
    }));
  } else {
    setText('#team-status', '—');
  }
  // 每日共享计划：本人份额滑块 + 共享风险
  const dayBar = $('#team-dayplan');
  if (dayBar) {
    dayBar.hidden = !dayPlan?.available;
    if (dayPlan?.available) {
      const selfPerson = (data.people ?? []).find((person) => person.self);
      const selfEntry = dayPlan.people.find((person) => person.personId === selfPerson?.personId);
      const slider = $('#team-share-slider');
      const riskInput = $('#team-risk-input');
      if (selfEntry && slider) {
        slider.disabled = false;
        if (document.activeElement !== slider) slider.value = String(selfEntry.value);
        setText('#team-share-value', `${selfEntry.value}%`);
      } else if (slider) {
        slider.disabled = true;
        setText('#team-share-value', '—');
      }
      if (riskInput) {
        riskInput.disabled = false;
        if (document.activeElement !== riskInput) riskInput.value = String(dayPlan.risk?.value ?? 0);
      }
      setText('#team-dayplan-status', t('team.planRisk', { risk: dayPlan.risk?.value ?? 0 }));
    } else {
      setText('#team-dayplan-status', '—');
    }
  }
  const capInput = $('#team-cap');
  const percentInput = $('#team-percent');
  if (capInput && document.activeElement !== capInput) capInput.value = plan.dailyTokenCap ?? '';
  if (percentInput && document.activeElement !== percentInput) percentInput.value = plan.dayTotalPercent ?? 100;
  if (team.error) {
    body.innerHTML = emptyRow(7, t('team.offline', { message: team.error.message ?? '—' }));
    return;
  }
  const rows = Array.isArray(data.members) ? data.members : [];
  const people = Array.isArray(data.people) ? data.people : [];
  if (!rows.length) {
    body.innerHTML = emptyRow(7, t('team.empty'));
    return;
  }
  if (people.length > 0) {
    const personRows = people.map((person) => {
      const comfortEmoji = person.comfort ? (COMFORT_EMOJI[clamp(person.comfort.level, 1, 5) - 1] ?? '') : '';
      const tags = [
        person.self ? t('team.self') : null,
        person.todayTasks === null || person.todayTasks === undefined ? null : t('team.tasksToday', { n: person.todayTasks }),
        person.tasks?.length ? t('team.topTask', { title: person.tasks[0].title }) : null,
        comfortEmoji ? comfortEmoji : null,
        person.planValue === null ? null : t('team.consumedPercent', { consumed: person.consumedPercent ?? 0 }),
      ].filter(Boolean).join(' · ');
      const planCell = person.planValue === null
        ? '—'
        : `<div class="share-bar" title="${esc(t('team.planPercentValue', { value: person.planValue }))}"><i style="width:${clamp(person.planUtilizationPercent ?? 0)}%"></i></div><span class="share-value">${esc(fmtPct(person.planValue))}${person.overPlan ? ` <em class="is-warn">${esc(t('team.overPlan'))}</em>` : ''}${person.allocatedPercent === null || person.allocatedPercent === undefined ? '' : ` <small>${esc(t('team.costShare', { percent: person.allocatedPercent }))}</small>`}</span>`;
      const lastSeen = person.devices.map((device) => device.lastSeenAt).filter(Boolean).sort().at(-1);
      return `<tr data-person="${esc(person.personId)}" class="${person.activeDeviceCount === 0 ? 'is-muted' : ''}"><td class="cell-task"><span class="task-name">${esc(person.name)}</span>${tags ? `<span class="task-sub">${esc(tags)}</span>` : ''}</td><td class="hide-md">${esc(t('team.personRole'))}</td><td class="num">${person.today ? esc(fmtCompact(person.today.tokens)) : '—'}</td><td class="num hide-sm">${person.today ? esc(fmtCny(person.today.costCny ?? 0)) : '—'}</td><td class="num hide-sm">${planCell}</td><td class="hide-md">${esc(lastSeen ? fmtRel(Date.parse(lastSeen)) : '—')}</td><td><div class="member-actions"><span class="share-value">${esc(fmtInt(person.deviceCount))} ${esc(t('team.devicesCount'))}</span></div></td></tr>`;
    }).join('');
    const unassigned = (data.unassignedDevices ?? []).filter((row) => !row.revoked);
    const unassignedRows = unassigned.map((row) => `<tr data-device="${esc(row.deviceId)}" class="is-muted"><td class="cell-task"><span class="task-name">${esc(row.displayName)}</span><span class="task-sub">${esc(t('team.unassigned'))}</span></td><td class="hide-md">${esc(t('team.deviceRole'))}</td><td class="num">${row.today ? esc(fmtCompact(row.today.tokens)) : '—'}</td><td class="num hide-sm">${row.today ? esc(fmtCny(row.today.costCny ?? 0)) : '—'}</td><td class="num hide-sm">—</td><td class="hide-md">${esc(row.lastSeenAt ? fmtRel(Date.parse(row.lastSeenAt)) : '—')}</td><td><div class="member-actions"><button class="btn btn-sm" type="button" data-action="rename" data-device="${esc(row.deviceId)}">${esc(t('team.rename'))}</button></div></td></tr>`).join('');
    body.innerHTML = personRows + unassignedRows;
    return;
  }
  body.innerHTML = rows.map((row) => {
    const tags = [row.isSelf ? t('team.self') : null, row.revoked ? t('team.revoked') : null].filter(Boolean).join(' · ');
    const role = row.role === 'owner' ? t('team.owner') : t('team.member');
    const lastSeen = row.lastSeenAt ? fmtRel(Date.parse(row.lastSeenAt)) : '—';
    const planCell = row.planPercent === null || row.planPercent === undefined
      ? '—'
      : `<div class="share-bar" title="${esc(t('team.planPercent', { percent: row.planPercent }))}"><i style="width:${clamp(row.planPercent)}%"></i></div><span class="share-value">${esc(fmtPct(row.planPercent))}</span>`;
    const actions = row.revoked
      ? ''
      : `<button class="btn btn-sm" type="button" data-action="rename" data-device="${esc(row.deviceId)}">${esc(t('team.rename'))}</button>${row.isSelf ? '' : `<button class="btn btn-sm" type="button" data-action="remove" data-device="${esc(row.deviceId)}">${esc(t('team.remove'))}</button>`}`;
    return `<tr class="${row.revoked ? 'is-muted' : ''}" data-device="${esc(row.deviceId)}"><td class="cell-task"><span class="task-name">${esc(row.displayName)}</span>${tags ? `<span class="task-sub">${esc(tags)}</span>` : ''}</td><td class="hide-md">${esc(role)}</td><td class="num">${row.today ? esc(fmtCompact(row.today.tokens)) : '—'}</td><td class="num hide-sm">${row.today ? esc(fmtCny(row.today.costCny ?? 0)) : '—'}</td><td class="num hide-sm">${planCell}</td><td class="hide-md">${esc(lastSeen)}</td><td><div class="member-actions">${actions}</div></td></tr>`;
  }).join('');
}

function renderTasks() {
  const tasks = state.tasks;
  const body = $('#tasks-body');
  if (!body) return;
  if (tasks.loading && !tasks.loaded) {
    body.innerHTML = emptyRow(6, t('tasks.loading'));
  } else if (!tasks.items.length) {
    body.innerHTML = emptyRow(6, tasks.q ? t('tasks.searchEmpty') : t('tasks.empty'));
  } else {
    body.innerHTML = tasks.items.map((item) => {
      const key = String(item.key ?? item.id ?? '');
      const expanded = state.expandedTask === key;
      const share = clamp(num(item.sharePercent)) ?? 0;
      const models = Array.isArray(item.models) ? item.models.filter(Boolean) : [];
      return `<tr class="task-row${expanded ? ' is-expanded' : ''}" data-key="${esc(key)}"><td class="cell-task"><button class="task-toggle" type="button" aria-expanded="${expanded}" data-key="${esc(key)}" aria-label="${esc(t(expanded ? 'tasks.collapseAria' : 'tasks.expandAria', { title: maskTitle(item.title, key) }))}"><span class="task-name">${esc(maskTitle(item.title, key))}</span><span class="task-sub">${esc([item.project, models.join(', ')].filter(Boolean).join(' · ') || '—')}</span></button></td><td class="num">${esc(fmtCompact(item.tokens))}</td><td class="num hide-sm">${state.status?.precision?.strict ? '≈' : ''}${esc(fmtCny(item.costCny))}</td><td class="num hide-md">${esc(fmtInt(item.messages))}</td><td class="hide-sm">${esc(fmtRel(item.lastAt))}</td><td class="hide-md"><div class="share-bar" title="${esc(fmtPct(share))}"><i style="width:${share.toFixed(1)}%"></i></div><span class="share-value">${esc(fmtPct(share))}</span></td></tr>${expanded ? `<tr class="task-detail-row"><td colspan="6"><div class="task-detail-grid"><div><span class="detail-label">${esc(t('tasks.models'))}</span><div class="detail-chips">${models.length ? models.map((model) => `<span class="detail-chip">${esc(model)}</span>`).join('') : '<span class="detail-value">—</span>'}</div></div><div><span class="detail-label">${esc(t('tasks.subagentTokens'))}</span><span class="detail-value">${esc(fmtCompact(item.subagentTokens))}${item.isSubagent ? ` · ${esc(t('subagents.title'))}` : ''}</span></div><div><span class="detail-label">${esc(t('tasks.key'))}</span><span class="detail-value">${esc(key || '—')}</span></div></div></td></tr>` : ''}`;
    }).join('');
  }
  const pages = Math.max(1, Math.ceil(tasks.total / tasks.pageSize));
  setText('#tasks-count', tasks.total ? `${fmtInt(tasks.total)}` : '—');
  setText('#task-pageinfo', t('common.pageInfo', { page: tasks.page, pages, total: fmtInt(tasks.total) }));
  $('#task-prev').disabled = tasks.page <= 1 || tasks.loading;
  $('#task-next').disabled = tasks.page >= pages || tasks.loading;
  renderSortState();
  renderReceiptTasks();
}
function renderProjects() {
  const projects = state.projects;
  const body = $('#projects-body');
  body.innerHTML = projects.loading && !projects.loaded
    ? emptyRow(6, t('common.loading'))
    : projects.items.map((item) => `<tr class="project-row"><td class="cell-task"><span class="task-name">${esc(item.project || '—')}</span></td><td class="num">${esc(fmtCompact(item.tokens))}</td><td class="num hide-sm">${esc(fmtCny(item.costCny))}</td><td class="num hide-sm">${esc(fmtInt(item.sessions))}</td><td class="num hide-md">${esc(fmtInt(item.tasks))}</td><td class="hide-md">${esc(fmtRel(item.lastAt))}</td></tr>`).join('');
  const empty = !projects.loading && !projects.items.length;
  $('#projects-empty').hidden = !empty;
  if (empty) body.innerHTML = '';
}
function renderSubagents() {
  const data = state.subagents;
  const tree = $('#subagents-tree');
  if (!data.items.length && !data.orphans.length) {
    tree.innerHTML = '';
    $('#subagents-empty').hidden = !(data.loaded && !data.loading);
    return;
  }
  $('#subagents-empty').hidden = true;
  tree.innerHTML = data.items.map((group) => {
    const parentId = String(group.parentSessionId ?? '');
    const collapsed = state.collapsedParents.has(parentId);
    const children = Array.isArray(group.children) ? group.children : [];
    const total = children.reduce((sum, child) => sum + (num(child.tokens) ?? 0), 0);
    return `<div class="subagent-group"><button class="subagent-parent" type="button" aria-expanded="${!collapsed}" data-parent="${esc(parentId)}" aria-label="${esc(t(collapsed ? 'subagents.expand' : 'subagents.collapse', { title: maskTitle(group.parentTitle, parentId) }))}"><span class="subagent-chevron" aria-hidden="true">▶</span><span class="subagent-title">${esc(maskTitle(group.parentTitle, parentId))}</span><span class="subagent-meta">${esc(t('subagents.children', { n: children.length }))} · ${esc(fmtCompact(total))} token</span></button><ul class="subagent-list"${collapsed ? ' hidden' : ''}>${children.map((child) => {
      const tokens = num(child.tokens) ?? 0;
      const share = total > 0 ? (tokens / total) * 100 : 0;
      return `<li class="subagent-child" style="--depth:${Math.max(1, num(child.depth) ?? 1)}"><div class="subagent-child-main"><span class="subagent-child-title">${esc(maskTitle(child.title, child.sessionId))}</span><div class="subagent-child-bar"><i style="width:${Math.max(2, share).toFixed(1)}%"></i></div></div><span class="subagent-child-meta">${esc(fmtCompact(tokens))}<br>${esc(fmtPct(share))}</span></li>`;
    }).join('')}</ul></div>`;
  }).join('');
  if (data.orphans.length) {
    tree.innerHTML += `<p class="orphan-title">${esc(t('subagents.orphans'))}</p>${data.orphans.map((orphan) => `<span class="detail-chip">${esc(maskTitle(orphan.title, orphan.sessionId))}</span>`).join(' ')}`;
  }
}
function switchTaskTab(tab) {
  state.taskTab = ['tasks', 'projects', 'subagents', 'members'].includes(tab) ? tab : 'tasks';
  $$('.tab-btn').forEach((button) => {
    const active = button.dataset.tab === state.taskTab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  ['tasks', 'projects', 'subagents', 'members'].forEach((name) => {
    const panel = $(`#panel-${name}`);
    if (panel) panel.hidden = name !== state.taskTab;
  });
  if (state.taskTab === 'members' && !state.team.loading && (!state.team.loaded || state.team.error)) loadTeam();
}
function toggleTask(key, toggle) {
  state.expandedTask = state.expandedTask === key ? null : key;
  if (toggle) toggle.setAttribute('aria-expanded', String(state.expandedTask === key));
  renderTasks();
}

/* ---------- 12. 分布 / 健康 / 小票统计 ---------- */
function renderRank(root, items, emptyText) {
  const rows = items.filter((item) => item.value !== null).sort((a, b) => b.value - a.value).slice(0, 5);
  if (!rows.length) { root.innerHTML = `<p class="empty sm">${esc(emptyText)}</p>`; return; }
  const max = Math.max(...rows.map((row) => row.value), 1);
  root.innerHTML = rows.map((row, index) => `<div class="rank-row"><span class="rank-idx">${index + 1}</span><div class="rank-main"><div class="rank-top"><span class="rank-name" title="${esc(row.name)}">${esc(row.name)}</span><span class="rank-value">${esc(fmtCompact(row.value))}</span></div><div class="rank-bar"><i style="width:${Math.max(3, (row.value / max) * 100).toFixed(1)}%"></i></div>${row.sub ? `<span class="rank-sub">${esc(row.sub)}</span>` : ''}</div></div>`).join('');
}
function renderDistribution() {
  const breakdown = state.status?.breakdown || {};
  renderRank($('#dist-models'), (breakdown.models || []).map((row) => ({ name: row.model || '—', value: num(row.tokens), sub: `${fmtCny(row.costCny)} · ${fmtInt(row.messages)}` })), t('dist.emptyModels'));
  renderRank($('#dist-tools'), (breakdown.tools || []).map((row) => ({ name: row.name || '—', value: num(row.calls), sub: '' })), t('dist.emptyTools'));
  renderRank($('#dist-sessions'), (breakdown.sessions || []).map((row) => ({ name: maskTitle(row.title, row.id), value: num(row.tokens), sub: `${fmtCny(row.costCny)} · ${fmtRel(row.lastAt)}` })), t('dist.emptySessions'));
}
function renderReceiptStats() {
  const totals = state.status?.totals || {};
  setText('#receipt-tokens', fmtCompact(totals.todayTokens ?? totals.cycleTokens));
  setText('#receipt-cost', fmtCny(totals.todayCostCny ?? totals.cycleCostCny));
}
function renderHealth() {
  const health = state.status?.health || {};
  const sessions = health.rangeSessions ?? health.sessionsScanned;
  setText('#health-line', t('health.line', {
    sessions: fmtInt(sessions), errors: fmtInt(health.errors), ms: fmtInt(health.durationMs), rate: fmtRate(health.cacheHitRate),
  }));
}

/* ---------- 13. 舒适度（记录 + 分箱 + 曲线 + 历史日历） ---------- */
function comfortData() {
  const statusComfort = state.status?.comfort || {};
  const fetched = state.comfort || {};
  const fit = {
    fitted: fetched.fit?.fitted ?? statusComfort.fitted ?? false,
    k: fetched.fit?.k ?? statusComfort.k ?? null,
    sampleSize: fetched.fit?.sampleSize ?? statusComfort.sampleSize ?? 0,
    curve: Array.isArray(statusComfort.curve) ? statusComfort.curve : [],
    points: Array.isArray(statusComfort.points) ? statusComfort.points : [],
  };
  const binned = fetched.binned?.length ? fetched.binned : (Array.isArray(statusComfort.binned) ? statusComfort.binned : []);
  const calendar = fetched.calendar?.length ? fetched.calendar : (Array.isArray(statusComfort.calendar) ? statusComfort.calendar : []);
  return { fit, binned, calendar, entries: fetched.entries || [] };
}
const kneeOf = (fit) => { const k = num(fit?.k); return k === null ? null : clamp(k <= 1.5 ? k * 100 : k, 1, 99); };
function renderComfort() {
  const { fit, binned, calendar, entries } = comfortData();
  const today = localKey();
  const todayEntry = entries.find((entry) => entry?.date === today);
  const recorded = num(state.localComfort) ?? num(todayEntry?.level) ?? (() => {
    const hit = (state.history.length ? state.history : state.status?.history || []).find((day) => day?.date === today && num(day.comfort) !== null);
    return hit ? num(hit.comfort) : null;
  })();
  const buttons = $('#comfort-buttons');
  if (!buttons.children.length) {
    buttons.innerHTML = COMFORT_EMOJI.map((emoji, index) => `<button class="comfort-btn" type="button" data-level="${index + 1}" aria-pressed="false" aria-label="${esc(t(COMFORT_LEVEL_KEYS[index]))}"><span class="comfort-emoji" aria-hidden="true">${emoji}</span><span class="comfort-label">${esc(t(COMFORT_LEVEL_KEYS[index]))}</span></button>`).join('');
  }
  $$('.comfort-btn', buttons).forEach((button) => {
    const active = recorded === Number(button.dataset.level);
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  setText('#comfort-recorded', recorded ? t('comfort.recorded', { label: comfortLabel(recorded) }) : t('comfort.notRecorded'));
  const knee = kneeOf(fit);
  setText('#comfort-meta', fit.fitted ? t('comfort.meta', { knee: knee === null ? '—' : `${Math.round(knee)}%`, n: fmtInt(fit.sampleSize) }) : t('comfort.noFit'));
  const binnedCanvas = $('#comfort-binned');
  $('#comfort-binned-empty').hidden = binned.length > 0;
  binnedCanvas.hidden = binned.length === 0;
  if (binned.length) {
    drawBinned(binnedCanvas, { bins: binned, palette: palette() });
    binnedCanvas.setAttribute('aria-label', t('comfort.binnedAria'));
  }
  const curveCanvas = $('#comfort-curve');
  const hasCurve = fit.fitted && fit.curve.length >= 2;
  $('#comfort-curve-empty').hidden = hasCurve;
  curveCanvas.hidden = !hasCurve;
  if (hasCurve) {
    drawComfortCurve(curveCanvas, {
      curve: fit.curve,
      points: fit.points.map((point) => ({ x: num(point.x), y: num(point.y) > 1.5 ? (num(point.y) - 1) / 4 : num(point.y) })).filter((point) => point.x !== null && point.y !== null),
      knee,
      palette: palette(),
    });
    curveCanvas.setAttribute('aria-label', t('comfort.curveAria', { knee: knee === null ? '—' : `${Math.round(knee)}%`, n: fmtInt(fit.points.length) }));
  }
  renderComfortCalendar(calendar);
}
function renderComfortCalendar(calendar) {
  const data = Array.isArray(calendar) ? calendar : comfortData().calendar;
  const container = $('#comfort-calendar');
  if (!container) return;
  const recent = [...data].filter((entry) => entry?.date).sort((a, b) => a.date.localeCompare(b.date)).slice(-63);
  container.innerHTML = recent.map((entry) => {
    const level = clamp(num(entry.level), 1, 5);
    return `<span class="comfort-cell" data-level="${level ?? 0}" title="${esc(`${entry.date} · ${level === null ? t('common.noData') : comfortLabel(level)} · ${fmtCompact(entry.tokens)} token`)}"></span>`;
  }).join('');
  $('#comfort-history-empty').hidden = recent.length > 0;
}
async function recordComfort(level, button) {
  if (!level) return;
  button.classList.add('is-pending');
  const note = $('#comfort-note').value.trim().slice(0, 120);
  try {
    await postJSON('/comfort', { level, note });
    state.localComfort = level;
    reportOnline();
    renderComfort();
    showToast(t('comfort.saved', { label: comfortLabel(level) }));
    loadStatus();
    loadComfort();
  } catch (err) {
    reportOffline(err);
    showToast(t('comfort.saveFailed'), 'error');
  } finally {
    button.classList.remove('is-pending');
  }
}

/* ---------- 14. 小票构建器 ---------- */
function renderReceiptTasks() {
  const container = $('#receipt-tasks');
  if (!container) return;
  const items = state.tasks.items;
  if (!items.length) {
    container.innerHTML = '';
    $('#receipt-tasks-empty').hidden = false;
    setText('#receipt-selected', t('receipt.selected', { n: state.receiptSelection.size }));
    return;
  }
  $('#receipt-tasks-empty').hidden = true;
  container.innerHTML = items.map((item) => {
    const key = String(item.key);
    const checked = state.receiptSelection.has(key);
    return `<label class="receipt-task" data-testid="receipt-task"><input type="checkbox" value="${esc(key)}"${checked ? ' checked' : ''}><span class="receipt-task-name">${esc(maskTitle(item.title, key))}</span><span class="receipt-task-tokens">${esc(fmtCompact(item.tokens))}</span></label>`;
  }).join('');
  setText('#receipt-selected', t('receipt.selected', { n: state.receiptSelection.size }));
}
async function generateReceipt() {
  const button = $('#receipt-btn');
  button.disabled = true;
  button.textContent = t('receipt.generating');
  setText('#receipt-status', t('receipt.requesting'));
  try {
    const body = { ...rangeParams(), tasks: [...state.receiptSelection] };
    const title = $('#receipt-title-input').value.trim();
    if (title) body.title = title;
    const data = await postJSON('/receipt', body);
    reportOnline();
    const canvas = drawReceipt(data, {
      titleFallback: t('receipt.defaultTitle'),
      range: t('receipt.range'),
      lines: t('receipt.lines'),
      tokens: t('receipt.tokens'),
      amount: t('receipt.amount'),
      total: t('receipt.total'),
      created: t('receipt.created'),
      footer: t('receipt.footer'),
      locale: state.lang,
    });
    const blob = await receiptBlob(canvas);
    downloadBlob(blob, `dsh-cockpit-receipt-${localKey()}.png`);
    const copied = await copyPng(blob);
    setText('#receipt-status', copied ? t('receipt.copied') : t('receipt.clipboardFallback'));
    showToast(copied ? t('receipt.copied') : t('receipt.clipboardFallback'));
  } catch (err) {
    reportOffline(err);
    setText('#receipt-status', t('receipt.failed'));
    showToast(t('receipt.failed'), 'error');
  } finally {
    button.disabled = false;
    button.textContent = t('receipt.generate');
  }
}

/* ---------- 15. 通知 ---------- */
function renderNotifications() {
  const source = state.notifications.loaded || !state.status?.notifications ? state.notifications : {
    settings: null,
    alerts: Array.isArray(state.status.notifications.alerts) ? state.status.notifications.alerts : [],
    unread: num(state.status.notifications.unread) ?? 0,
  };
  const alerts = Array.isArray(source.alerts) ? source.alerts : [];
  const unread = num(source.unread) ?? 0;
  const badge = $('#notif-count');
  badge.hidden = !(unread > 0);
  badge.textContent = unread > 99 ? '99+' : String(unread);
  $('#notif-btn').setAttribute('aria-label', t('top.notifyAria', { count: unread }));
  const list = $('#notif-list');
  list.innerHTML = alerts.map((alert) => {
    const level = ['warn', 'critical'].includes(alert.level) ? alert.level : 'info';
    const read = state.readAlertIds.has(String(alert.id));
    return `<li class="notif-item level-${level}${read ? ' is-read' : ''}"><button class="notif-item-btn" type="button" data-alert-id="${esc(alert.id)}" aria-label="${esc(t('notify.markRead'))}"><span class="notif-item-top"><strong>${esc(alert.title || '—')}</strong><span class="notif-level">${esc(t(`notify.level.${level}`))}</span></span><p>${esc(alert.body || '')}</p>${num(alert.metric) === null ? '' : `<span class="notif-metric">${esc(fmtPct(alert.metric))}</span>`}</button></li>`;
  }).join('');
  $('#notif-empty').hidden = alerts.length > 0;
}
function toggleNotifPanel(force) {
  const panel = $('#notif-panel');
  const next = force === undefined ? panel.hidden : force;
  panel.hidden = !next;
  $('#notif-btn').setAttribute('aria-expanded', String(next));
}
function markAlertsRead(ids, all) {
  const idList = [...ids].filter(Boolean);
  idList.forEach((id) => state.readAlertIds.add(String(id)));
  persistSet('dsh-cockpit-read-alerts', state.readAlertIds);
  if (all) state.notifications.unread = 0;
  renderNotifications();
  postJSON('/notifications/read', all ? { all: true } : { ids: idList })
    .then(() => { reportOnline(); loadNotifications(); })
    .catch((err) => reportOffline(err));
}
function maybeSystemNotify() {
  if (typeof window.Notification !== 'function' || window.Notification.permission !== 'granted') return;
  if (state.notifications.settings?.enabled === false) return;
  state.notifications.alerts.forEach((alert) => {
    const id = String(alert.id);
    if (state.readAlertIds.has(id) || state.notifiedAlertIds.has(id)) return;
    state.notifiedAlertIds.add(id);
    try { new window.Notification(alert.title || t('notify.title'), { body: alert.body || '', tag: `dsh-cockpit-${id}` }); } catch { /* 系统通知失败静默降级 */ }
  });
}
async function enableSystemNotifications() {
  if (typeof window.Notification !== 'function') { showToast(t('notify.systemBlocked')); return; }
  try {
    const permission = await window.Notification.requestPermission();
    showToast(permission === 'granted' ? t('notify.systemOn') : t('notify.systemBlocked'));
    if (permission === 'granted') maybeSystemNotify();
  } catch {
    showToast(t('notify.systemBlocked'));
  }
}

/* ---------- 16. 日历下钻 ---------- */
function monthLabel(month) {
  const date = dateOf(`${month}-01T12:00:00`);
  return date ? timeFmt({ year: 'numeric', month: 'long' }).format(date) : month;
}
function shiftMonth(month, delta) {
  const [year, mon] = month.split('-').map(Number);
  const date = new Date(year, mon - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
async function openCalendar(dateStr) {
  const selected = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') ? dateStr : localKey();
  state.calendar.selected = selected;
  state.calendar.month = selected.slice(0, 7);
  $('#calendar-modal').hidden = false;
  document.body.classList.add('modal-open');
  $('#calendar-close').focus();
  await loadCalendarMonth(state.calendar.month);
}
function closeCalendar() {
  $('#calendar-modal').hidden = true;
  document.body.classList.remove('modal-open');
}
async function loadCalendarMonth(month) {
  state.calendar.month = month;
  state.calendar.loading = true;
  state.calendar.error = false;
  state.calendar.days = [];
  renderCalendar();
  try {
    const data = await getJSON('/calendar', { month });
    state.calendar.days = Array.isArray(data.days) ? data.days : [];
    if (!state.calendar.selected || !state.calendar.selected.startsWith(month)) state.calendar.selected = `${month}-01`;
    reportOnline();
  } catch (err) {
    state.calendar.error = true;
    reportOffline(err);
  } finally {
    state.calendar.loading = false;
    renderCalendar();
  }
}
function renderCalendar() {
  const month = state.calendar.month || localKey().slice(0, 7);
  $('#calendar-month').textContent = monthLabel(month);
  const weekdayNames = t('calendar.weekdays').split(',');
  $('#calendar-weekdays').innerHTML = weekdayNames.map((name) => `<span>${esc(name)}</span>`).join('');
  const [year, mon] = month.split('-').map(Number);
  const first = new Date(year, mon - 1, 1);
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, mon, 0).getDate();
  const map = new Map(state.calendar.days.filter((day) => day?.date).map((day) => [day.date, day]));
  const values = state.calendar.days.map((day) => num(day.tokens)).filter((value) => value !== null);
  const thresholds = quantiles(values, [0.2, 0.4, 0.6, 0.8]);
  const max = values.length ? Math.max(...values) : 1;
  const today = localKey();
  const cells = [];
  for (let i = 0; i < offset; i += 1) cells.push('<span class="cal-day is-empty" aria-hidden="true"></span>');
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const data = map.get(date);
    const tokens = num(data?.tokens);
    const level = levelFor(tokens, thresholds);
    const selected = state.calendar.selected === date;
    cells.push(`<button class="cal-day${selected ? ' is-selected' : ''}${date === today ? ' is-today' : ''}" type="button" data-date="${date}" aria-label="${esc(date)}"><span class="cal-daynum">${day}</span>${tokens !== null ? `<span class="cal-bar"><i style="width:${Math.max(4, (tokens / max) * 100).toFixed(1)}%"></i></span>` : ''}${num(data?.comfort) !== null ? `<span class="cal-dot" data-level="${clamp(Math.round(num(data.comfort)), 1, 5)}"></span>` : ''}${tokens !== null && level >= 0 ? '' : ''}</button>`);
  }
  $('#calendar-grid').innerHTML = cells.join('');
  renderCalendarDetail(map);
}
function renderCalendarDetail(map) {
  const date = state.calendar.selected;
  const detail = $('#calendar-detail');
  const data = date ? (map || new Map(state.calendar.days.map((day) => [day.date, day]))).get(date) : null;
  if (state.calendar.loading) { detail.innerHTML = `<p class="empty sm">${esc(t('calendar.loading'))}</p>`; return; }
  if (state.calendar.error) { detail.innerHTML = `<p class="empty sm">${esc(t('calendar.loadFailed'))}</p>`; return; }
  const head = `<div class="cal-detail-head"><strong>${esc(date || '—')}</strong><span class="cal-weekday">${esc(data ? timeFmt({ weekday: 'long' }).format(dateOf(`${date}T12:00:00`) || new Date()) : '')}</span></div>`;
  if (!data) {
    detail.innerHTML = `${head}<p class="empty sm">${esc(t('calendar.noData'))}</p>`;
    return;
  }
  const topTasks = Array.isArray(data.topTasks) ? data.topTasks.slice(0, 5) : [];
  const topModels = Array.isArray(data.topModels) ? data.topModels.slice(0, 5) : [];
  detail.innerHTML = `${head}<div class="cal-stats"><div class="cal-stat"><span>Token</span><b>${esc(fmtCompact(data.tokens))}</b></div><div class="cal-stat"><span>${esc(t('calendar.cost'))}</span><b>${esc(fmtCny(data.costCny))}</b></div><div class="cal-stat"><span>${esc(t('calendar.sessions'))}</span><b>${esc(fmtInt(data.sessions))}</b></div><div class="cal-stat"><span>${esc(t('calendar.comfort'))}</span><b>${esc(comfortLabel(data.comfort))}</b></div></div><div class="cal-section"><h4>${esc(t('calendar.topTasks'))}</h4><ul class="cal-list">${topTasks.length ? topTasks.map((item) => `<li><span>${esc(maskTitle(item.title, ''))}</span><b>${esc(fmtCompact(item.tokens))}</b></li>`).join('') : `<li><span>${esc(t('calendar.none'))}</span></li>`}</ul></div><div class="cal-section"><h4>${esc(t('calendar.topModels'))}</h4><ul class="cal-list">${topModels.length ? topModels.map((item) => `<li><span>${esc(item.model || '—')}</span><b>${esc(fmtCompact(item.tokens))}</b></li>`).join('') : `<li><span>${esc(t('calendar.none'))}</span></li>`}</ul></div>`;
}

/* ---------- 17. 设置抽屉 ---------- */
function openDrawer() {
  renderSettingsForm();
  $('#drawer').hidden = false;
  $('#drawer-backdrop').hidden = false;
  document.body.classList.add('drawer-open');
  window.requestAnimationFrame(() => {
    $('#drawer').classList.add('is-open');
    $('#drawer-backdrop').classList.add('is-open');
    $('#cfg-mode').focus();
  });
}
function closeDrawer() {
  $('#drawer').classList.remove('is-open');
  $('#drawer-backdrop').classList.remove('is-open');
  document.body.classList.remove('drawer-open');
  window.setTimeout(() => {
    if (!$('#drawer').classList.contains('is-open')) { $('#drawer').hidden = true; $('#drawer-backdrop').hidden = true; }
  }, 240);
  if (state.config) {
    applyUiFromConfig();
    rerenderAll();
    renderSettingsForm();
  }
  $('#settings-btn').focus();
}
function renderPricingRows(pricing) {
  const rows = Object.entries(pricing || {}).map(([model, prices]) => {
    const value = (field) => { const n = num(prices?.[field]); return n === null ? '' : n; };
    return `<tr data-model="${esc(model)}"><td class="model-cell" title="${esc(model)}">${esc(model)}</td><td><input type="number" min="0" step="0.01" inputmode="decimal" data-field="input" value="${value('input')}" aria-label="${esc(model)} ${esc(t('settings.pricingInput'))}"></td><td><input type="number" min="0" step="0.01" inputmode="decimal" data-field="cacheRead" value="${value('cacheRead')}" aria-label="${esc(model)} ${esc(t('settings.pricingCacheRead'))}"></td><td><input type="number" min="0" step="0.01" inputmode="decimal" data-field="cacheWrite" value="${value('cacheWrite')}" aria-label="${esc(model)} ${esc(t('settings.pricingCacheWrite'))}"></td><td><input type="number" min="0" step="0.01" inputmode="decimal" data-field="output" value="${value('output')}" aria-label="${esc(model)} ${esc(t('settings.pricingOutput'))}"></td></tr>`;
  }).join('');
  $('#pricing-rows').innerHTML = rows || `<tr><td colspan="5" class="empty sm">${esc(t('common.noData'))}</td></tr>`;
}
function renderSettingsForm() {
  const config = state.config || {};
  const budget = config.budget || {};
  const ui = config.ui || {};
  const notify = config.notify || {};
  $('#cfg-mode').value = ['daily', 'weekly', 'monthly'].includes(budget.mode) ? budget.mode : 'daily';
  $('#cfg-axis').value = ['budget', 'balance', 'context'].includes(budget.axis) ? budget.axis : 'budget';
  $('#cfg-tokens').value = num(budget.tokens) ?? '';
  $('#cfg-cost').value = num(budget.costCny) ?? '';
  $('#cfg-day-start').value = num(budget.dayStartHour) ?? 4;
  $('#cfg-daily-cap').value = num(budget.dailyCapPercent) ?? 90;
  $('#cfg-day-total').value = num(budget.dayTotalPercent) ?? 100;
  updateRangeOutputs();
  renderPricingRows(config.pricing || {});
  $('#cfg-theme').value = ['dark', 'light', 'auto'].includes(ui.theme) ? ui.theme : state.prefs.theme;
  $('#cfg-font-scale').value = String([0.9, 1, 1.15].includes(Number(ui.fontScale)) ? Number(ui.fontScale) : state.prefs.fontScale);
  $('#cfg-density').value = ui.density === 'compact' ? 'compact' : 'comfortable';
  $('#cfg-lang').value = normalizeLanguage(ui.language ?? state.lang);
  $('#cfg-mask').checked = Boolean(ui.maskTitles);
  $('#cfg-notify-enabled').checked = notify.enabled !== false;
  $('#cfg-budget-warn').value = num(notify.budgetWarn) ?? 80;
  $('#cfg-budget-critical').value = num(notify.budgetCritical) ?? 95;
  $('#cfg-compaction-score').value = num(notify.compactionScore) ?? 70;
  $('#cfg-notify-daily-cap').value = num(notify.dailyCap) ?? 90;
  renderSettingsReadonly();
}
function renderSettingsReadonly() {
  const sync = state.config?.sync || {};
  setText('#sync-enabled', sync.enabled ? t('common.on') : t('common.off'));
  setText('#sync-endpoint', sync.endpoint || '—');
  setText('#sync-space', sync.spaceLabel || '—');
}
function updateRangeOutputs() {
  setText('#cfg-daily-cap-value', `${$('#cfg-daily-cap').value}%`);
  setText('#cfg-day-total-value', `${$('#cfg-day-total').value}%`);
}
function cfgError(message) {
  const box = $('#cfg-error');
  box.textContent = message;
  box.hidden = false;
  return false;
}
async function saveSettings(ev) {
  ev.preventDefault();
  $('#cfg-error').hidden = true;
  const mode = $('#cfg-mode').value;
  const tokens = num($('#cfg-tokens').value);
  const cost = num($('#cfg-cost').value);
  const dayStartHour = num($('#cfg-day-start').value);
  if (!['daily', 'weekly', 'monthly'].includes(mode)) return cfgError(t('settings.errorMode'));
  if (tokens === null && cost === null) return cfgError(t('settings.errorAtLeast'));
  if ((tokens !== null && tokens < 0) || (cost !== null && cost < 0)) return cfgError(t('settings.errorNegative'));
  if (dayStartHour !== null && (dayStartHour < 0 || dayStartHour > 23)) return cfgError(t('settings.errorDayStart'));
  const pricing = {};
  $$('#pricing-rows tr[data-model]').forEach((row) => {
    const field = (name) => num($(`input[data-field="${name}"]`, row)?.value) ?? 0;
    pricing[row.dataset.model] = { input: field('input'), cacheRead: field('cacheRead'), cacheWrite: field('cacheWrite'), output: field('output') };
  });
  const previous = state.config || {};
  const payload = {
    budget: {
      ...(previous.budget || {}),
      mode,
      axis: $('#cfg-axis').value,
      tokens,
      costCny: cost,
      dayStartHour: dayStartHour ?? 4,
      dailyCapPercent: num($('#cfg-daily-cap').value) ?? 90,
      dayTotalPercent: num($('#cfg-day-total').value) ?? 100,
    },
    pricing,
    ui: {
      ...(previous.ui || {}),
      maskTitles: $('#cfg-mask').checked,
      language: $('#cfg-lang').value === 'en' ? 'en' : 'zh',
      theme: $('#cfg-theme').value,
      fontScale: num($('#cfg-font-scale').value) ?? 1,
      density: $('#cfg-density').value,
    },
    notify: {
      ...(previous.notify || {}),
      enabled: $('#cfg-notify-enabled').checked,
      budgetWarn: num($('#cfg-budget-warn').value) ?? 80,
      budgetCritical: num($('#cfg-budget-critical').value) ?? 95,
      compactionScore: num($('#cfg-compaction-score').value) ?? 70,
      dailyCap: num($('#cfg-notify-daily-cap').value) ?? 90,
    },
  };
  const button = $('#cfg-save');
  button.disabled = true;
  button.textContent = t('common.saving');
  try {
    const result = await postJSON('/config', payload);
    state.config = result.config || { ...previous, ...payload };
    reportOnline();
    applyUiFromConfig();
    renderSettingsForm();
    closeDrawer();
    showToast(t('settings.saved'));
    await Promise.all([loadStatus(), loadHistory(), loadTasks(), loadComfort(), loadNotifications()]);
  } catch (err) {
    reportOffline(err);
    cfgError(t('settings.saveFailed'));
  } finally {
    button.disabled = false;
    button.textContent = t('common.save');
  }
}
async function backupData() {
  const button = $('#backup-btn');
  button.disabled = true;
  setText('#data-status', t('settings.backupStatus'));
  try {
    const data = await getJSON('/backup');
    downloadJson(data, `dsh-cockpit-backup-${localKey()}.json`);
    reportOnline();
    setText('#data-status', t('settings.backupDone'));
  } catch (err) {
    reportOffline(err);
    setText('#data-status', t('settings.backupFailed'));
  } finally {
    button.disabled = false;
  }
}
async function restoreData(file) {
  if (!file) return;
  const button = $('#restore-btn');
  button.disabled = true;
  setText('#data-status', t('settings.restoreStatus'));
  try {
    const text = await file.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { setText('#data-status', t('settings.invalidJson')); return; }
    if (!window.confirm(t('settings.restoreConfirm'))) { setText('#data-status', ''); return; }
    await postJSON('/restore', parsed);
    reportOnline();
    setText('#data-status', t('settings.restoreDone'));
    await loadConfig();
    await Promise.all([loadStatus(), loadHistory(), loadTasks(), loadComfort(), loadNotifications()]);
  } catch (err) {
    reportOffline(err);
    setText('#data-status', t('settings.restoreFailed'));
  } finally {
    button.disabled = false;
    $('#restore-file').value = '';
  }
}

/* ---------- 18. 事件 ---------- */
function switchMetric(metric) {
  state.metric = metric === 'cost' ? 'cost' : 'tokens';
  $$('.seg-btn[data-metric]').forEach((button) => {
    const active = button.dataset.metric === state.metric;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  renderTrend();
}
function initEvents() {
  $('#banner-close').addEventListener('click', () => { state.bannerDismissed = true; $('#net-banner').hidden = true; });
  $('#refresh-btn').addEventListener('click', refreshAll);
  $('#settings-btn').addEventListener('click', openDrawer);
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-cancel').addEventListener('click', closeDrawer);
  $('#drawer-backdrop').addEventListener('click', closeDrawer);
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#cfg-daily-cap').addEventListener('input', updateRangeOutputs);
  $('#cfg-day-total').addEventListener('input', updateRangeOutputs);
  ['#cfg-theme', '#cfg-font-scale', '#cfg-density'].forEach((selector) => {
    $(selector).addEventListener('change', () => {
      applyDisplay({
        theme: $('#cfg-theme').value,
        fontScale: num($('#cfg-font-scale').value) ?? 1,
        density: $('#cfg-density').value,
      });
      rerenderAll();
    });
  });
  $('#cfg-lang').addEventListener('change', () => setLanguage($('#cfg-lang').value));
  $('#backup-btn').addEventListener('click', backupData);
  $('#restore-btn').addEventListener('click', () => $('#restore-file').click());
  $('#restore-file').addEventListener('change', (ev) => restoreData(ev.target.files?.[0]));

  $$('#range-tabs .seg-btn').forEach((button) => button.addEventListener('click', () => {
    const kind = button.dataset.range;
    if (kind === 'custom') {
      const today = new Date();
      const from = new Date(today); from.setDate(from.getDate() - 29);
      $('#range-from').value = state.range.from || localKey(from);
      $('#range-to').value = state.range.to || localKey(today);
      state.range = { kind: 'custom', from: $('#range-from').value, to: $('#range-to').value };
      renderRangeBar();
      syncHash();
      return;
    }
    setRange({ kind });
  }));
  $('#range-apply').addEventListener('click', () => {
    setRange({ kind: 'custom', from: $('#range-from').value, to: $('#range-to').value });
  });
  window.addEventListener('hashchange', () => {
    const parsed = parseHash();
    if (parsed.kind !== state.range.kind || parsed.from !== state.range.from || parsed.to !== state.range.to) setRange(parsed, { skipHash: true });
  });

  $('#notif-btn').addEventListener('click', (ev) => { ev.stopPropagation(); toggleNotifPanel(); });
  $('#notif-panel').addEventListener('click', (ev) => ev.stopPropagation());
  $('#notif-mark-all').addEventListener('click', () => markAlertsRead(state.notifications.alerts.map((alert) => alert.id), true));
  $('#notif-enable').addEventListener('click', enableSystemNotifications);
  $('#notif-list').addEventListener('click', (ev) => {
    const button = ev.target.closest('[data-alert-id]');
    if (button) markAlertsRead([button.dataset.alertId], false);
  });
  document.addEventListener('click', () => { if (!$('#notif-panel').hidden) toggleNotifPanel(false); });

  $$('.seg-btn[data-metric]').forEach((button) => button.addEventListener('click', () => switchMetric(button.dataset.metric)));
  $('#trend-canvas').addEventListener('pointermove', handleTrendMove);
  $('#trend-canvas').addEventListener('pointerleave', leaveTrend);

  $('#heatmap').addEventListener('pointermove', handleHeatMove);
  $('#heatmap').addEventListener('pointerleave', () => { $('#heat-tooltip').hidden = true; });
  $('#heatmap').addEventListener('click', (ev) => {
    const cell = ev.target.closest('.heat-cell');
    if (cell) openCalendar(cell.dataset.date);
  });
  $('#heatmap').addEventListener('keydown', handleHeatKey);
  $('#heatmap').addEventListener('focus', () => { if (state.heatFocus < 0) focusHeatCell($$('#heatmap .heat-cell').length - 1); });

  $('#risk-canvas').addEventListener('pointermove', (ev) => {
    const geo = state.riskGeo;
    if (!geo) return;
    const rect = $('#risk-canvas').getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const cell = geo.cells.find((entry) => x >= entry.px - 2 && x <= entry.px + entry.w + 2 && y >= entry.py - 2 && y <= entry.py + entry.h + 2);
    const tip = $('#risk-tip');
    if (!cell) { tip.hidden = true; return; }
    tip.innerHTML = `<strong>${esc(t('risk.current'))}</strong><span>${esc(t('risk.tooltip', { x: fmtPct(cell.x, 0), y: fmtPct(cell.y, 0), z: fmtPct(cell.suggestedPercent, 0) }))}</span>`;
    tip.hidden = false;
    const wrap = $('#risk-plot').getBoundingClientRect();
    tip.style.left = `${Math.min(wrap.width - 150, Math.max(4, x + 10))}px`;
    tip.style.top = `${Math.max(4, y - 44)}px`;
  });
  $('#risk-canvas').addEventListener('pointerleave', () => { $('#risk-tip').hidden = true; });

  $('#insights-list').addEventListener('click', (ev) => {
    const button = ev.target.closest('[data-action]');
    if (!button) return;
    if (button.dataset.action === 'open-tasks') { switchTaskTab('tasks'); document.querySelector('.card--tasks').scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' }); $('#task-search').focus(); }
    else if (button.dataset.action === 'open-calendar') openCalendar(localKey());
    else if (button.dataset.action === 'open-settings') openDrawer();
  });

  $$('.tab-btn').forEach((button) => button.addEventListener('click', () => switchTaskTab(button.dataset.tab)));
  $('#team-refresh').addEventListener('click', () => loadTeam());
  $('#team-share-slider').addEventListener('input', (ev) => {
    setText('#team-share-value', `${ev.target.value}%`);
  });
  $('#team-plan-save').addEventListener('click', async () => {
    const data = state.team.data;
    const dayPlan = data?.dayPlan;
    if (!dayPlan?.available) return;
    const selfPerson = (data.people ?? []).find((person) => person.self);
    const selfEntry = dayPlan.people.find((person) => person.personId === selfPerson?.personId);
    const changes = [];
    const sliderValue = Number($('#team-share-slider').value);
    if (selfEntry && Number.isFinite(sliderValue) && sliderValue !== selfEntry.value) {
      changes.push({ kind: 'person', personId: selfEntry.personId, value: sliderValue, expectedRevision: selfEntry.revision });
    }
    const riskValue = Number($('#team-risk-input').value);
    if (Number.isFinite(riskValue) && riskValue !== (dayPlan.risk?.value ?? 0)) {
      changes.push({ kind: 'risk', value: riskValue, expectedRevision: dayPlan.risk?.revision ?? 0 });
    }
    if (!changes.length) return;
    try {
      for (const change of changes) {
        await postJSON('/sync/dayplan', { basis: dayPlan.basis, change });
      }
      showToast(t('team.planUpdated'), 'ok');
      await loadTeam();
    } catch (err) {
      showToast(String(err?.message ?? err), 'error');
      await loadTeam();
    }
  });
  $('#team-plan-edit').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const cap = Number($('#team-cap').value || 0);
    const percent = Number($('#team-percent').value || 100);
    try {
      await postJSON('/sync/space', { plan: { dailyTokenCap: cap > 0 ? cap : null, dayTotalPercent: percent } });
      showToast(t('team.planSaved'), 'ok');
      await loadTeam();
    } catch (err) {
      showToast(String(err?.message ?? err), 'error');
    }
  });
  $('#members-body').addEventListener('click', async (ev) => {
    const button = ev.target.closest('button[data-action]');
    if (!button) return;
    const deviceId = button.dataset.device;
    try {
      if (button.dataset.action === 'rename') {
        const name = window.prompt(t('team.promptRename'), '');
        if (!name || !name.trim()) return;
        await postJSON('/sync/members/rename', { deviceId, displayName: name.trim() });
        showToast(t('team.renamed'), 'ok');
      } else if (button.dataset.action === 'remove') {
        if (!window.confirm(t('team.confirmRemove'))) return;
        await postJSON('/sync/members/remove', { deviceId });
        showToast(t('team.removed'), 'ok');
      }
      await loadTeam();
    } catch (err) {
      showToast(String(err?.message ?? err), 'error');
    }
  });
  $$('.sort-btn').forEach((button) => button.addEventListener('click', () => {
    const sort = button.dataset.sort;
    if (!['tokens', 'cost', 'messages', 'lastAt'].includes(sort)) return;
    if (state.tasks.sort === sort) state.tasks.order = state.tasks.order === 'desc' ? 'asc' : 'desc';
    else { state.tasks.sort = sort; state.tasks.order = 'desc'; }
    state.tasks.page = 1;
    loadTasks();
  }));
  $('#task-search').addEventListener('input', (ev) => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => { state.tasks.q = ev.target.value.trim(); state.tasks.page = 1; loadTasks(); }, 300);
  });
  $('#task-prev').addEventListener('click', () => { if (state.tasks.page > 1) { state.tasks.page -= 1; loadTasks(); } });
  $('#task-next').addEventListener('click', () => { state.tasks.page += 1; loadTasks(); });
  $('#tasks-body').addEventListener('click', (ev) => {
    const toggle = ev.target.closest('.task-toggle');
    if (toggle) { ev.preventDefault(); toggleTask(toggle.dataset.key, toggle); }
  });
  $('#subagents-tree').addEventListener('click', (ev) => {
    const parent = ev.target.closest('.subagent-parent');
    if (!parent) return;
    const id = parent.dataset.parent;
    if (state.collapsedParents.has(id)) state.collapsedParents.delete(id);
    else state.collapsedParents.add(id);
    renderSubagents();
  });

  $('#comfort-buttons').addEventListener('click', (ev) => {
    const button = ev.target.closest('.comfort-btn');
    if (button) recordComfort(Number(button.dataset.level), button);
  });
  $('#receipt-tasks').addEventListener('change', (ev) => {
    const input = ev.target.closest('input[type="checkbox"]');
    if (!input) return;
    if (input.checked) state.receiptSelection.add(input.value);
    else state.receiptSelection.delete(input.value);
    setText('#receipt-selected', t('receipt.selected', { n: state.receiptSelection.size }));
  });
  $('#receipt-select-all').addEventListener('click', () => {
    state.tasks.items.forEach((item) => state.receiptSelection.add(String(item.key)));
    renderReceiptTasks();
  });
  $('#receipt-clear').addEventListener('click', () => { state.receiptSelection.clear(); renderReceiptTasks(); });
  $('#receipt-btn').addEventListener('click', generateReceipt);

  $('#calendar-close').addEventListener('click', closeCalendar);
  $('#calendar-prev').addEventListener('click', () => loadCalendarMonth(shiftMonth(state.calendar.month, -1)));
  $('#calendar-next').addEventListener('click', () => loadCalendarMonth(shiftMonth(state.calendar.month, 1)));
  $('#calendar-grid').addEventListener('click', (ev) => {
    const cell = ev.target.closest('.cal-day[data-date]');
    if (!cell) return;
    state.calendar.selected = cell.dataset.date;
    renderCalendar();
  });
  $('#calendar-modal').addEventListener('click', (ev) => { if (ev.target.id === 'calendar-modal') closeCalendar(); });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (!$('#calendar-modal').hidden) { ev.preventDefault(); closeCalendar(); return; }
      if (!$('#notif-panel').hidden) { ev.preventDefault(); toggleNotifPanel(false); return; }
      if (!$('#drawer').hidden) { ev.preventDefault(); closeDrawer(); return; }
    }
    if (!$('#drawer').hidden && ev.key === 'Tab') {
      const focusables = $$('button, input, select, textarea, a[href]', $('#drawer')).filter((node) => !node.disabled && node.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!state.lastRefresh || Date.now() - state.lastRefresh.getTime() > POLL_MS)) loadStatus({ balanceRefresh: true });
  });
  const media = window.matchMedia('(prefers-color-scheme: light)');
  media.addEventListener?.('change', () => {
    if (state.prefs.theme === 'auto') { applyDisplay({}); rerenderAll(); }
  });
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(() => window.requestAnimationFrame(() => {
      renderTrend();
      renderRiskMap();
      renderComfort();
    }));
    observer.observe($('.grid'));
  }
}
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function startPolling() {
  window.setInterval(async () => {
    if (state.busy || document.hidden) return;
    await loadStatus();
    state.pollTicks += 1;
    if (state.pollTicks % AUX_POLL_TICKS === 0) loadNotifications();
  }, POLL_MS);
}

/* ---------- 19. 启动 ---------- */
async function boot() {
  const initial = parseHash();
  if (initial.kind === 'custom' && (!initial.from || !initial.to || initial.from > initial.to)) state.range = { kind: 'cycle', from: null, to: null };
  else state.range = initial;
  applyI18n();
  initEvents();
  switchTaskTab('tasks');
  await loadConfig();
  renderRangeBar();
  syncHash();
  await Promise.all([loadStatus({ balanceRefresh: true }), loadHistory(), loadTasks(), loadProjects(), loadSubagents(), loadInsights(), loadComfort(), loadNotifications()]);
  if (state.config?.sync?.enabled) loadTeam();
  else renderMembers();
  finishBoot();
  startPolling();
}

boot();
