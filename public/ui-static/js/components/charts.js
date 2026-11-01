// 无依赖的 SVG 迷你图表。数据全部由调用方传入，空数据返回空串。
function escAttr(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[&<>"']/g, (ch) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

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
    escAttr(options.label || "趋势") +
    '"><path class="spark-area" d="' +
    area +
    '"/><path class="spark-line" d="' +
    line +
    '"/></svg>'
  );
}
