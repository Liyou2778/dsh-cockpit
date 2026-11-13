/* ENDFIELD // TALOS TERMINAL shell — 导航/主题/特效/状态轨 */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- 1. boot sequence ---------- */
const BOOT_LINES = [
  "RHODES ISLAND TERMINAL // LINK ......... <b>OK</b>",
  "PRTS / LOCAL VAULT ..................... <b>MOUNTED</b>",
  "TELEMETRY BUS .......................... <b>LOCAL ONLY</b>",
  "INDUSTRIAL SYSTEM ...................... <b>ONLINE</b>",
  "RHODES PROTOCOL ........................ <b>SYNCED</b>",
];
function boot() {
  const overlay = $("#boot");
  const log = $("#boot-log");
  if (!overlay || !log) return;
  if (navigator.webdriver) {
    overlay.remove();
    document.body.classList.remove("is-booting");
    return;
  }
  let index = 0;
  const timer = setInterval(() => {
    if (index >= BOOT_LINES.length) {
      clearInterval(timer);
      setTimeout(() => {
        overlay.classList.add("is-done");
        document.body.classList.remove("is-booting");
        setTimeout(() => overlay.remove(), 600);
      }, 260);
      return;
    }
    const line = document.createElement("div");
    line.innerHTML = BOOT_LINES[index];
    log.appendChild(line);
    index += 1;
  }, 150);
}

/* ---------- 2. clock ---------- */
function clock() {
  const node = $("#rail-clock");
  if (!node) return;
  const tick = () => {
    const now = new Date();
    node.textContent = now.toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
  };
  tick();
  setInterval(tick, 1000);
}

/* ---------- 3. theme ---------- */
function setupTheme() {
  const btn = $("#theme-toggle");
  const apply = (theme) => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("dsh.theme", theme); } catch { /* ignore */ }
    window.dispatchEvent(new Event("resize"));
  };
  let saved = null;
  try { saved = localStorage.getItem("dsh.theme"); } catch { /* ignore */ }
  if (!saved) { document.documentElement.dataset.theme = "light"; }
  if (btn) {
    btn.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      apply(next);
      btn.textContent = next === "light" ? "☀" : "◐";
    });
    btn.textContent = document.documentElement.dataset.theme === "light" ? "☀" : "◐";
  }
  // app.js 会按配置应用主题；在其后覆盖为用户手选主题
  if (saved === "light" || saved === "dark") {
    setTimeout(() => apply(saved), 900);
  }
}

/* ---------- 4. fx toggle ---------- */
function setupFx() {
  const btn = $("#fx-toggle");
  let off = false;
  try { off = localStorage.getItem("dsh.fx") === "off"; } catch { /* ignore */ }
  if (off) document.body.classList.add("fx-off");
  if (btn) btn.classList.toggle("is-off", off);
  if (!btn) return;
  btn.addEventListener("click", () => {
    off = !off;
    document.body.classList.toggle("fx-off", off);
    btn.classList.toggle("is-off", off);
    try { localStorage.setItem("dsh.fx", off ? "off" : "on"); } catch { /* ignore */ }
  });
}

/* ---------- 5. nav ---------- */
const NAV_TARGETS = {
  overview: "#main",
  usage: "#sec-usage",
  tasks: "#sec-tasks",
  team: "#sec-tasks",
  receipt: "#sec-receipt",
  sys: null,
};
function setupNav() {
  const items = $$(".rail-item");
  if (!items.length) return;
  let lockUntil = 0;

  const sectionOf = (key) => {
    if (key === "overview") return $("#main");
    if (key === "usage") return $("#sec-usage");
    if (key === "tasks" || key === "team") return $("#sec-tasks");
    if (key === "receipt") return $("#sec-receipt");
    return null;
  };
  const setActive = (key) => items.forEach((item) => item.classList.toggle("is-active", item.dataset.nav === key));
  const go = (key) => {
    if (key === "team") { const tab = $("#tab-members"); if (tab) tab.click(); }
    if (key === "tasks") { const tab = $("#tab-tasks"); if (tab) tab.click(); }
    if (key === "sys") { const settings = $("#settings-btn"); if (settings) settings.click(); return; }
    const node = sectionOf(key);
    if (!node) return;
    lockUntil = Date.now() + 900;
    setActive(key);
    window.scrollTo({ top: Math.max(0, node.getBoundingClientRect().top + window.scrollY - 92), behavior: "smooth" });
  };
  items.forEach((item) => item.addEventListener("click", () => go(item.dataset.nav)));

  const spy = () => {
    if (Date.now() < lockUntil) return;
    const probe = window.scrollY + 140;
    const points = [
      ["overview", $("#main")],
      ["usage", $("#sec-usage")],
      ["tasks", $("#sec-tasks")],
      ["receipt", $("#sec-receipt")],
    ].filter(([, node]) => node);
    let activeKey = "overview";
    for (const [key, node] of points) {
      const top = node.getBoundingClientRect().top + window.scrollY;
      if (probe >= top) activeKey = key;
    }
    // 与 tasks 区同锚的成员导航保持用户选择
    if (activeKey === "tasks") {
      const current = items.find((item) => item.classList.contains("is-active"));
      if (current && current.dataset.nav === "team") return;
    }
    setActive(activeKey);
  };
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { spy(); ticking = false; });
  }, { passive: true });
  window.addEventListener("resize", spy);
  spy();
}

/* ---------- 6. status rail ---------- */
const fmt = {
  tokens(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
    if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
    return n.toLocaleString("zh-CN");
  },
  cny(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? `¥${n.toFixed(2)}` : "—";
  },
  time(iso) {
    const date = iso ? new Date(iso) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString("zh-CN", { hour12: false }) : "—";
  },
};
function setText(sel, text) {
  const node = $(sel);
  if (!node || text === undefined) return;
  if (node.textContent !== String(text)) {
    node.textContent = String(text);
    node.classList.remove("is-updated");
    void node.offsetWidth;
    node.classList.add("is-updated");
  }
}
function renderRail(status) {
  if (!status) return;
  setText("#rail-mode", status.mode === "balance" ? "BALANCE" : "LOCAL");
  setText("#rail-sync", fmt.time(status.generatedAt));
  setText("#rail-range", status.range?.label ?? "—");
  const account = status.account;
  const balanceNode = $("#rail-balance");
  if (balanceNode) {
    if (account?.available) {
      const rawBalance = String(account.normalBalance ?? "—");
      balanceNode.textContent = /^\d/.test(rawBalance) ? Number(rawBalance).toFixed(2) : rawBalance;
      balanceNode.title = rawBalance;
      balanceNode.parentElement?.classList.toggle("is-low", Number(account.normalBalanceNum) > 0 && Number(account.normalBalanceNum) < 20);
      setText("#rail-account-state", "LIVE");
      setText("#rail-total-cost", fmt.cny(account.totalCostCny ?? account.totalCost));
      setText("#rail-precision", status.precision?.strict ? "STRICT" : "NORMAL");
    } else {
      balanceNode.textContent = "—";
      setText("#rail-account-state", account?.enabled === false ? "OFF" : "N/A");
      setText("#rail-total-cost", "—");
      setText("#rail-precision", status.precision?.strict ? "STRICT" : "NORMAL");
    }
  }
  const heroBalance = $("#hero-balance");
  if (heroBalance && /\d{4,}\.\d{6,}/.test(heroBalance.textContent)) {
    heroBalance.textContent = heroBalance.textContent.replace(/(\d+)\.(\d{6,})/, (_m, int, frac) => `${int}.${frac.slice(0, 2)}`);
    heroBalance.title = "官方账户余额（完整精度）";
  }
  const gateway = status.gateway;
  setText("#rail-gateway-state", gateway?.enabled ? "ON" : "OFF");
  setText("#rail-gw-req", gateway?.enabled ? String(gateway.requests ?? 0) : "—");
  setText("#rail-gw-tokens", gateway?.enabled ? fmt.tokens(gateway.tokens?.total) : "—");

  // alerts
  const alerts = [];
  const used = Number(status.quota?.usedPercent);
  if (Number.isFinite(used) && used >= 90) alerts.push({ level: "warn", text: `预算用量 ${used.toFixed(1)}% · 接近上限` });
  const pressure = Number(status.context?.percent);
  if (Number.isFinite(pressure) && pressure >= 70) alerts.push({ level: "warn", text: `上下文压力 ${pressure.toFixed(0)}% · 压缩风险上升` });
  const forecast = Number(status.forecast?.score);
  if (Number.isFinite(forecast) && forecast >= 60) alerts.push({ level: "warn", text: `压缩预测 ${forecast.toFixed(0)}% · 建议拆分会话` });
  if (status.pace?.status === "over_pace") alerts.push({ level: "warn", text: "配速超标 · 建议降低用量" });
  if (status.precision?.strict) alerts.push({ level: "ok", text: "精确优先模式 · 推算值已标 ≈" });
  const list = $("#rail-alerts");
  if (list) {
    list.innerHTML = "";
    if (!alerts.length) alerts.push({ level: "ok", text: "无异常 · 系统稳定" });
    for (const alert of alerts.slice(0, 6)) {
      const li = document.createElement("li");
      li.className = alert.level === "warn" ? "is-warn" : "is-ok";
      li.textContent = alert.text;
      list.appendChild(li);
    }
    setText("#rail-alert-count", String(alerts.filter((a) => a.level === "warn").length));
  }
}
async function pollRail() {
  try {
    const response = await fetch("/api/status?range=cycle", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    renderRail(await response.json());
  } catch {
    setText("#rail-sync", "OFFLINE");
    const list = $("#rail-alerts");
    if (list) {
      list.innerHTML = "";
      const li = document.createElement("li");
      li.className = "is-warn";
      li.textContent = "后端不可达 · 显示最近缓存";
      list.appendChild(li);
    }
  }
}

/* ---------- 6.5 精度格式化 ---------- */
function formatBalance() {
  const hero = $("#hero-balance");
  if (!hero) return;
  const text = hero.textContent;
  const match = /(\d+)\.(\d{6,})/.exec(text);
  if (!match) return;
  hero.title = "官方账户余额（完整精度：" + text.trim() + "）";
  hero.textContent = text.replace(match[0], match[1] + '.' + match[2].slice(0, 2));
}
const balanceObserver = new MutationObserver(formatBalance);
const balanceNode = $("#hero-balance");
if (balanceNode) balanceObserver.observe(balanceNode, { childList: true, characterData: true, subtree: true });
setInterval(formatBalance, 2000);

/* ---------- 7. boot everything ---------- */
boot();
clock();
setupTheme();
setupFx();
setupNav();
pollRail();
setInterval(pollRail, 15_000);
