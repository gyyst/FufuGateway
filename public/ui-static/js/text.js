// 共享的 HTML 转义。所有拼接进 HTML/属性的动态文本都应经过此函数。
export function esc(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[&<>"']/g, (ch) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}
