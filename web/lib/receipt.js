/* ============================================================
 * DSH 驾驶舱 · 小票渲染与下载（零依赖）
 * 2× 分辨率 canvas PNG：等宽字体、虚线分隔、撕纸锯齿边。
 * ============================================================ */

const MONO = '"Cascadia Mono", "SFMono-Regular", Consolas, Menlo, monospace';
const PAPER = '#f4efe4';
const INK = '#2e2921';
const INK_SOFT = '#5b5346';
const INK_FAINT = '#8a8172';
const DASH = '#c3b9a7';

function safeNumber(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatInt(value) {
  const parsed = safeNumber(value);
  return parsed === null ? '—' : new Intl.NumberFormat('zh-CN').format(Math.round(parsed));
}

function formatCny(value) {
  const parsed = safeNumber(value);
  return parsed === null ? '—' : `¥${parsed.toFixed(2)}`;
}

function formatTime(iso, locale) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

/**
 * 绘制小票，返回 canvas（逻辑宽 440，实际 2×）。
 * @param {object} data /api/receipt 响应
 * @param {{titleFallback:string, range:string, lines:string, tokens:string, amount:string,
 *          total:string, created:string, footer:string, locale:string}} labels
 */
export function drawReceipt(data, labels = {}) {
  const lines = Array.isArray(data?.lines) ? data.lines : [];
  const notes = Array.isArray(data?.notes) ? data.notes.filter((note) => typeof note === 'string' && note.trim()) : [];
  const W = 440;
  const scale = 2;
  const zig = 9;
  const rowHeight = 26;
  const listTop = 152;
  const listHeight = Math.max(lines.length, 1) * rowHeight;
  const totalY = listTop + listHeight + 14;
  const notesHeight = Math.min(notes.length, 3) * 15;
  const H = Math.max(460, totalY + 118 + notesHeight);
  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  // 纸张 + 底部撕纸锯齿
  ctx.fillStyle = PAPER;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(W, 0);
  ctx.lineTo(W, H - zig);
  for (let x = W; x > 0; x -= 18) {
    ctx.lineTo(x - 9, H);
    ctx.lineTo(x - 18, H - zig);
  }
  ctx.closePath();
  ctx.fill();
  const dashed = (y) => {
    ctx.strokeStyle = DASH;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(22, y);
    ctx.lineTo(W - 22, y);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  ctx.fillStyle = INK;
  ctx.font = `700 19px ${MONO}`;
  ctx.fillText(truncate(data?.title || labels.titleFallback || 'DSH Cockpit', 24), W / 2, 44);
  ctx.font = `10px ${MONO}`;
  ctx.fillStyle = INK_FAINT;
  ctx.fillText('DSH COCKPIT · RECEIPT', W / 2, 64);
  const rangeLabel = data?.range?.label || data?.range?.kind || '';
  if (rangeLabel) ctx.fillText(truncate(`${labels.range || 'Range'}: ${rangeLabel}`, 40), W / 2, 82);
  dashed(100);
  ctx.textAlign = 'left';
  ctx.fillStyle = INK_FAINT;
  ctx.font = `10px ${MONO}`;
  ctx.fillText(labels.lines || 'Items', 24, 124);
  ctx.textAlign = 'right';
  ctx.fillText(labels.tokens || 'TOKENS', W - 96, 124);
  ctx.fillText(labels.amount || 'AMOUNT', W - 24, 124);
  ctx.font = `12px ${MONO}`;
  lines.forEach((line, index) => {
    const y = listTop + index * rowHeight;
    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    ctx.fillText(truncate(line.label || '—', 21), 24, y);
    ctx.textAlign = 'right';
    ctx.fillStyle = INK_SOFT;
    ctx.fillText(formatInt(line.tokens), W - 96, y);
    ctx.fillText(formatCny(line.costCny), W - 24, y);
  });
  if (!lines.length) {
    ctx.textAlign = 'left';
    ctx.fillStyle = INK_FAINT;
    ctx.font = `12px ${MONO}`;
    ctx.fillText('—', 24, listTop);
  }
  dashed(totalY);
  ctx.fillStyle = INK;
  ctx.font = `700 13px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillText(labels.total || 'TOTAL', 24, totalY + 26);
  ctx.textAlign = 'right';
  ctx.fillText(formatInt(data?.totalTokens), W - 96, totalY + 26);
  ctx.fillText(formatCny(data?.totalCostCny), W - 24, totalY + 26);
  ctx.textAlign = 'center';
  ctx.fillStyle = INK_FAINT;
  ctx.font = `10px ${MONO}`;
  let footerY = H - 40;
  if (notes.length) {
    ctx.textAlign = 'left';
    notes.slice(0, 3).forEach((note, index) => {
      ctx.fillText(truncate(note, 42), 24, totalY + 62 + index * 15);
    });
  }
  ctx.textAlign = 'center';
  ctx.fillText((labels.created || 'Generated {time}').replace('{time}', formatTime(data?.generatedAt, labels.locale)), W / 2, footerY - 16);
  footerY += 0;
  ctx.fillText(labels.footer || '', W / 2, footerY);
  return canvas;
}

export function receiptBlob(canvas) {
  return new Promise((resolve, reject) => {
    if (!canvas) {
      reject(new Error('receipt canvas missing'));
      return;
    }
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG generation failed'))), 'image/png');
  });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
}

export function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  downloadBlob(blob, filename);
}

/** 尝试写剪贴板；不可用/被拒时返回 false（调用方降级为下载提示）。 */
export async function copyPng(blob) {
  try {
    if (!navigator.clipboard?.write || !window.ClipboardItem) return false;
    await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}
