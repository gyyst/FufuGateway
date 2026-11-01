// 无依赖的 SVG 迷你图表。数据全部由调用方传入，空数据返回空串。
import { esc } from "../text.js";

export function sparkline(values, options = {}) {
  const data = (values || []).map(Number).filter((value) => Number.isFinite(value));
  if (data.length === 0) return "";
  const width = options.width || 160;
  const height = options.height || 48;
  const pad = 3;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const step = data.length > 1 ? (width - pad * 2) / (data.length - 1) : 0;
  const points = data.map((value, index) => {
    const x = pad + index * step;
    const y = height - pad - ((value - min) / span) * (height - pad * 2);
    return [x, y];
  });
  const line = points
    .map(([x, y], index) => (index === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1))
    .join(" ");
  const lastX = (pad + (data.length - 1) * step).toFixed(1);
  const area =
    line +
    " L" +
    lastX +
    " " +
    (height - pad) +
    " L" +
    pad +
    " " +
    (height - pad) +
    " Z";
  return (
    '<svg class="sparkline" viewBox="0 0 ' +
    width +
    " " +
    height +
    '" preserveAspectRatio="none" role="img" aria-label="' +
    esc(options.label || "趋势") +
    '"><path class="spark-area" d="' +
    area +
    '"/><path class="spark-line" d="' +
    line +
    '"/></svg>'
  );
}

// 等宽柱状序列图。items: { label, value, title }[]；空数据返回空串。
export function barSeries(items, options = {}) {
  const list = (items || []).filter((item) => item && Number.isFinite(Number(item.value)));
  if (list.length === 0) return "";
  const format = typeof options.formatter === "function" ? options.formatter : (value) => String(value);
  const width = options.width || 320;
  const height = options.height || 84;
  const pad = 2;
  const gap = 2;
  const max = Math.max(1, ...list.map((item) => Number(item.value)));
  const rawWidth = (width - pad * 2 - gap * (list.length - 1)) / list.length;
  const barWidth = Math.max(1, Math.min(40, rawWidth));
  const bars = list
    .map((item, index) => {
      const value = Number(item.value);
      const barHeight =
        value > 0 ? Math.max(1, Math.round((value / max) * (height - pad * 2))) : 0;
      const x = pad + index * (barWidth + gap);
      const y = height - pad - barHeight;
      return (
        '<rect class="series-bar" x="' +
        x.toFixed(1) +
        '" y="' +
        y.toFixed(1) +
        '" width="' +
        barWidth.toFixed(1) +
        '" height="' +
        barHeight +
        '"><title>' +
        esc(item.title || item.label + " · " + format(value)) +
        "</title></rect>"
      );
    })
    .join("");
  return (
    '<svg class="series-chart" viewBox="0 0 ' +
    width +
    " " +
    height +
    '" preserveAspectRatio="none" role="img" aria-label="' +
    esc(options.label || "趋势") +
    '">' +
    bars +
    '<line class="series-axis" x1="' +
    pad +
    '" y1="' +
    (height - pad) +
    '" x2="' +
    (width - pad) +
    '" y2="' +
    (height - pad) +
    '"/></svg>'
  );
}
