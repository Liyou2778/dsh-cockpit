/* ============================================================
 * DSH 驾驶舱 · canvas 图表库（零依赖）
 * 纯函数：接收 canvas 与数据，绘制并返回几何信息供交互层做 hover。
 * 颜色全部走 palette，保证 dark / light 主题一致可读。
 * ============================================================ */

export const PALETTES = {
  dark: {
    grid: 'rgba(255,255,255,0.08)',
    gridSoft: 'rgba(255,255,255,0.05)',
    axis: 'rgba(163,183,178,0.9)',
    text: '#a3b7b2',
    bar: '31,224,204',
    barAlt: '232,243,240',
    ma: '232,243,240',
    cyan: '#1fe0cc',
    purple: '#e8f3f0',
    amber: '#f0a52a',
    red: '#ff6b70',
    dot: '#1fe0cc',
    dotRing: 'rgba(31,224,204,0.35)',
  },
  light: {
    grid: 'rgba(18,60,55,0.10)',
    gridSoft: 'rgba(18,60,55,0.06)',
    axis: '#7d918c',
    text: '#46605b',
    bar: '16,201,181',
    barAlt: '18,33,31',
    ma: '125,145,140',
    cyan: '#10c9b5',
    purple: '#12211f',
    amber: '#e8930c',
    red: '#e5484d',
    dot: '#12211f',
    dotRing: 'rgba(18,33,31,0.3)',
  },
};

export function paletteFor(theme) {
  return theme === 'light' ? PALETTES.light : PALETTES.dark;
}

/** 按容器尺寸与 DPR 重置 canvas，返回 2D 上下文与 CSS 像素尺寸。 */
export function fitCanvas(canvas, maxDpr = 2) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const width = Math.floor(rect.width);
  const height = Math.floor(rect.height);
  if (width < 2 || height < 2) return null;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

export function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

/**
 * 30 天趋势柱状图 + 7 日均线。
 * @returns {{geo: {pad:object,slot:number,n:number}, points: Array<{x:number,y:number}>}|null}
 */
export function drawTrend(canvas, options) {
  const { rows = [], metric = 'tokens', hoverIndex = -1, palette, formatTick = String } = options;
  const valueOf = (row) => (metric === 'tokens' ? row.tokens : row.cost);
  const values = rows.map(valueOf).filter((value) => value !== null && value !== undefined);
  const box = fitCanvas(canvas);
  if (!box || !values.length) return null;
  const { ctx, width, height } = box;
  const pad = { l: 48, r: 12, t: 14, b: 26 };
  const plotW = Math.max(1, width - pad.l - pad.r);
  const plotH = Math.max(1, height - pad.t - pad.b);
  const baseY = pad.t + plotH;
  const rawMax = Math.max(...values, 1) * 1.12;
  const mag = 10 ** Math.floor(Math.log10(rawMax));
  const norm = rawMax / mag;
  const stepValue = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const yMax = stepValue * mag;
  const slot = plotW / rows.length;
  const barW = Math.max(3, Math.min(18, slot * 0.52));
  const yOf = (value) => baseY - (value / yMax) * plotH;
  const rgb = metric === 'tokens' ? palette.bar : palette.barAlt;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const ticks = [];
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.t + (plotH / 4) * i;
    const value = yMax * (1 - i / 4);
    ticks.push({ y, value });
    ctx.strokeStyle = i === 4 ? palette.grid : palette.gridSoft;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(width - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = palette.axis;
    ctx.textAlign = 'right';
    ctx.fillText(formatTick(value), pad.l - 8, y);
  }
  rows.forEach((row, index) => {
    const value = valueOf(row);
    const x = pad.l + slot * index + slot / 2 - barW / 2;
    if (Number.isFinite(value)) {
      const top = yOf(value);
      const gradient = ctx.createLinearGradient(0, top, 0, baseY);
      gradient.addColorStop(0, `rgba(${rgb},${hoverIndex === index ? 0.95 : 0.7})`);
      gradient.addColorStop(1, `rgba(${rgb},0.08)`);
      ctx.fillStyle = gradient;
      roundRect(ctx, x, top, barW, Math.max(2, baseY - top), Math.min(4, barW / 2));
      ctx.fill();
    }
    if (hoverIndex === index) {
      ctx.strokeStyle = palette.dotRing;
      ctx.lineWidth = 1;
      roundRect(ctx, x - 3, pad.t + 2, barW + 6, Math.max(2, plotH - 4), 5);
      ctx.stroke();
    }
  });
  const movingAvg = rows.map((_, index) => {
    const list = rows.slice(Math.max(0, index - 6), index + 1).map(valueOf).filter((value) => Number.isFinite(value));
    return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null;
  });
  ctx.strokeStyle = `rgba(${palette.ma},0.9)`;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let started = false;
  movingAvg.forEach((value, index) => {
    if (value === null) return;
    const x = pad.l + slot * index + slot / 2;
    const y = yOf(value);
    if (started) ctx.lineTo(x, y);
    else { ctx.moveTo(x, y); started = true; }
  });
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = palette.axis;
  const labelStep = Math.max(1, Math.ceil(rows.length / 6));
  rows.forEach((row, index) => {
    if (index % labelStep !== 0 && index !== rows.length - 1) return;
    ctx.fillText(row.date.length >= 10 ? row.date.slice(5) : row.date, pad.l + slot * index + slot / 2, baseY + 8);
  });
  return { geo: { pad, slot, n: rows.length, baseY, plotH, barW }, ticks };
}

/**
 * 风险热力图（配速 × 压缩风险 → 建议用量）。
 * @returns {{geo: {pad:object, xMin:number, xMax:number, yMin:number, yMax:number}, cells: Array<object>}|null}
 */
export function drawRiskMap(canvas, options) {
  const { riskMap, palette, formatPct = String } = options;
  const box = fitCanvas(canvas);
  if (!box || !riskMap) return null;
  const { ctx, width, height } = box;
  const xAxis = riskMap.x || {};
  const yAxis = riskMap.y || {};
  const xMin = Number.isFinite(xAxis.min) ? xAxis.min : 0;
  const xMax = Number.isFinite(xAxis.max) ? xAxis.max : 120;
  const yMin = Number.isFinite(yAxis.min) ? yAxis.min : 0;
  const yMax = Number.isFinite(yAxis.max) ? yAxis.max : 100;
  const pad = { l: 38, r: 10, t: 10, b: 24 };
  const plotW = Math.max(1, width - pad.l - pad.r);
  const plotH = Math.max(1, height - pad.t - pad.b);
  const xOf = (value) => pad.l + ((value - xMin) / Math.max(1e-6, xMax - xMin)) * plotW;
  const yOf = (value) => pad.t + (1 - (value - yMin) / Math.max(1e-6, yMax - yMin)) * plotH;
  const cells = Array.isArray(riskMap.cells) ? riskMap.cells : [];
  const xs = [...new Set(cells.map((cell) => Number(cell.x)).filter(Number.isFinite))].sort((a, b) => a - b);
  const ys = [...new Set(cells.map((cell) => Number(cell.y)).filter(Number.isFinite))].sort((a, b) => a - b);
  const cellW = xs.length > 1 ? Math.abs(xOf(xs[1]) - xOf(xs[0])) : plotW / 12;
  const cellH = ys.length > 1 ? Math.abs(yOf(ys[0]) - yOf(ys[1])) : plotH / 8;
  const values = cells.map((cell) => Number(cell.suggestedPercent)).filter(Number.isFinite);
  const minValue = values.length ? Math.min(...values) : 0;
  const maxValue = values.length ? Math.max(...values) : 100;
  // 网格与轴刻度
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = palette.gridSoft;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const value = xMin + ((xMax - xMin) / 4) * i;
    const x = xOf(value);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + plotH);
    ctx.stroke();
    ctx.fillStyle = palette.axis;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(formatPct(value), x, pad.t + plotH + 6);
    ctx.textBaseline = 'middle';
  }
  for (let i = 0; i <= 4; i += 1) {
    const value = yMin + ((yMax - yMin) / 4) * i;
    const y = yOf(value);
    ctx.fillStyle = palette.axis;
    ctx.textAlign = 'right';
    ctx.fillText(formatPct(value), pad.l - 6, y);
  }
  // 色块
  const drawn = cells.map((cell) => {
    const value = Number(cell.suggestedPercent);
    const ratio = Number.isFinite(value) ? Math.max(0, Math.min(1, (value - minValue) / Math.max(1e-6, maxValue - minValue))) : 0;
    const px = xOf(Number(cell.x)) - cellW / 2 + 1.5;
    const py = yOf(Number(cell.y)) - cellH / 2 + 1.5;
    const w = Math.max(2, cellW - 3);
    const h = Math.max(2, cellH - 3);
    ctx.fillStyle = ratio > 0.55 ? `rgba(${palette.bar},${0.3 + ratio * 0.55})` : `rgba(${palette.barAlt},${0.22 + ratio * 0.4})`;
    roundRect(ctx, px, py, w, h, Math.min(5, w / 3, h / 3));
    ctx.fill();
    return { x: Number(cell.x), y: Number(cell.y), suggestedPercent: value, px, py, w, h };
  });
  // 当前位置
  const current = riskMap.current || {};
  let currentPoint = null;
  if (Number.isFinite(Number(current.pacePercent)) && Number.isFinite(Number(current.riskPercent))) {
    const px = xOf(Number(current.pacePercent));
    const py = yOf(Number(current.riskPercent));
    currentPoint = { x: Number(current.pacePercent), y: Number(current.riskPercent) };
    ctx.beginPath();
    ctx.fillStyle = 'rgba(242,84,91,0.22)';
    ctx.arc(px, py, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = palette.red;
    ctx.arc(px, py, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = palette.dot;
    ctx.stroke();
  }
  return { geo: { pad, plotW, plotH, xMin, xMax, yMin, yMax }, cells: drawn, current: currentPoint };
}

/** 舒适度拟合曲线：x=用量 0–100，y=效率 0–1，标注 knee。 */
export function drawComfortCurve(canvas, options) {
  const { curve = [], points = [], knee = null, palette } = options;
  const box = fitCanvas(canvas);
  if (!box || curve.length < 2) return null;
  const { ctx, width, height } = box;
  const pad = { l: 30, r: 10, t: 14, b: 22 };
  const plotW = Math.max(1, width - pad.l - pad.r);
  const plotH = Math.max(1, height - pad.t - pad.b);
  const xOf = (value) => pad.l + (Math.max(0, Math.min(100, Number(value) || 0)) / 100) * plotW;
  const yOf = (value) => pad.t + (1 - Math.max(0, Math.min(1, Number(value) || 0))) * plotH;
  ctx.font = '10px system-ui, sans-serif';
  [0, 0.5, 1].forEach((value) => {
    const y = yOf(value);
    ctx.strokeStyle = palette.grid;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(width - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = palette.axis;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(value.toFixed(1), pad.l - 6, y);
  });
  [0, 50, 100].forEach((value) => {
    const x = xOf(value);
    ctx.strokeStyle = palette.gridSoft;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, height - pad.b);
    ctx.stroke();
    ctx.fillStyle = palette.axis;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`${value}%`, x, height - pad.b + 6);
  });
  ctx.strokeStyle = palette.cyan;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  curve.forEach((point, index) => {
    const x = xOf(point.x);
    const y = yOf(point.y);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  if (knee !== null && Number.isFinite(knee)) {
    const x = xOf(knee);
    ctx.strokeStyle = `rgba(${palette.ma},0.8)`;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, height - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = palette.amber;
    ctx.font = '10px system-ui, sans-serif';
    const right = x > width - 84;
    ctx.textAlign = right ? 'right' : 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`knee ≈ ${Math.round(knee)}%`, x + (right ? -4 : 4), pad.t + 1);
  }
  points.forEach((point) => {
    ctx.beginPath();
    ctx.fillStyle = palette.purple;
    ctx.arc(xOf(point.x), yOf(point.y), 2.6, 0, Math.PI * 2);
    ctx.fill();
  });
  return { geo: { pad, plotW, plotH } };
}

/** 舒适度分箱柱状图：x=用量区间，y=平均体感 1–5。 */
export function drawBinned(canvas, options) {
  const { bins = [], palette } = options;
  const box = fitCanvas(canvas);
  if (!box || !bins.length) return null;
  const { ctx, width, height } = box;
  const pad = { l: 22, r: 8, t: 16, b: 22 };
  const plotW = Math.max(1, width - pad.l - pad.r);
  const plotH = Math.max(1, height - pad.t - pad.b);
  const baseY = pad.t + plotH;
  const yOf = (level) => baseY - (Math.max(0, Math.min(5, level)) / 5) * plotH;
  ctx.font = '10px system-ui, sans-serif';
  [1, 3, 5].forEach((level) => {
    const y = yOf(level);
    ctx.strokeStyle = palette.gridSoft;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(width - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = palette.axis;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(level), pad.l - 4, y);
  });
  const slot = plotW / bins.length;
  const barW = Math.max(4, Math.min(26, slot * 0.56));
  const colors = [palette.cyan, palette.cyan, palette.purple, palette.amber, palette.red];
  bins.forEach((bin, index) => {
    const level = Number(bin.avgLevel);
    const x = pad.l + slot * index + slot / 2 - barW / 2;
    const top = yOf(Number.isFinite(level) ? level : 0);
    const color = colors[Math.max(0, Math.min(4, Math.round((Number.isFinite(level) ? level : 1) - 1)))];
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.82;
    roundRect(ctx, x, top, barW, Math.max(2, baseY - top), Math.min(4, barW / 2));
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.axis;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const label = String(bin.bin ?? '');
    if (label) ctx.fillText(label, x + barW / 2, baseY + 6);
    if (Number.isFinite(Number(bin.count)) && Number(bin.count) > 0) {
      ctx.fillStyle = palette.text;
      ctx.textBaseline = 'bottom';
      ctx.fillText(String(bin.count), x + barW / 2, top - 2);
    }
  });
  return { geo: { pad, slot } };
}
