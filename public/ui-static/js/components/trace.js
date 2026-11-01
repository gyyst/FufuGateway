// 路由轨迹、执行树与 Combo 计划的可视化渲染。输入为后端只读数据，所有文本转义。

function esc(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[&<>"']/g, (ch) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

const STATUS_LABELS = {
  ok: "成功",
  failed: "失败",
  skipped: "跳过",
  cancelled: "取消",
};

function statusClass(status) {
  if (status === "ok") return "ok";
  if (status === "failed") return "bad";
  if (status === "cancelled" || status === "skipped") return "warn";
  return "muted";
}

function durationOf(node) {
  if (typeof node.finishedAt === "number" && typeof node.startedAt === "number") {
    return Math.max(0, node.finishedAt - node.startedAt);
  }
  return null;
}

function renderAttempt(attempt) {
  if (!attempt || typeof attempt !== "object") return "";
  const parts = [];
  if (attempt.providerId) parts.push(attempt.providerId);
  if (attempt.accountId) parts.push(attempt.accountId);
  return (
    '<li class="trace-attempt">' +
    '<span class="trace-attempt-index">#' +
    esc(attempt.index === undefined ? "-" : Number(attempt.index) + 1) +
    "</span>" +
    (parts.length ? '<span class="muted">' + esc(parts.join(" / ")) + "</span>" : "") +
    '<span class="trace-attempt-status ' +
    statusClass(typeof attempt.status === "number" ? (attempt.status < 400 ? "ok" : "failed") : attempt.status) +
    '">' +
    esc(attempt.status === undefined ? "-" : attempt.status) +
    "</span>" +
    '<span class="trace-duration">' +
    esc(attempt.durationMs === undefined ? "-" : attempt.durationMs + " ms") +
    "</span>" +
    (attempt.errorCode ? '<span class="error-text">' + esc(attempt.errorCode) + "</span>" : "") +
    "</li>"
  );
}

export function renderExecutionTree(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 32) return "";
  const duration = durationOf(node);
  const attempts = Array.isArray(node.attempts) ? node.attempts : [];
  const children = Array.isArray(node.children) ? node.children : [];
  return (
    '<li class="trace-node">' +
    '<div class="trace-row">' +
    '<span class="trace-status ' +
    statusClass(node.status) +
    '"></span>' +
    '<span class="trace-label mono">' +
    esc(node.label || node.modelId || node.id || "节点") +
    "</span>" +
    '<span class="badge">' +
    esc(node.kind || "node") +
    "</span>" +
    (node.providerId ? '<span class="muted">' + esc(node.providerId) + "</span>" : "") +
    (duration === null ? "" : '<span class="trace-duration">' + duration + " ms</span>") +
    '<span class="muted">' +
    esc(STATUS_LABELS[node.status] || node.status || "") +
    "</span>" +
    "</div>" +
    (attempts.length
      ? '<ul class="trace-attempts">' + attempts.map(renderAttempt).join("") + "</ul>"
      : "") +
    (children.length
      ? '<ul class="trace-children">' +
        children.map((child) => renderExecutionTree(child, depth + 1)).join("") +
        "</ul>"
      : "") +
    "</li>"
  );
}

function planLabel(node) {
  if (node.kind === "model") {
    const target = node.target || {};
    const prefix = target.providerName ? target.providerName + " / " : "";
    return prefix + (target.modelId || "未知模型");
  }
  return node.name || node.kind || "节点";
}

function planMeta(node) {
  const parts = [];
  if (node.weight !== undefined && node.weight !== null) parts.push("权重 " + node.weight);
  if (node.priority !== undefined && node.priority !== null) parts.push("优先级 " + node.priority);
  if (node.timeoutMs) parts.push("超时 " + node.timeoutMs + " ms");
  if (node.strategy) parts.push("策略 " + node.strategy);
  return parts.join(" · ");
}

function renderPlanNode(node) {
  if (!node || typeof node !== "object") return "";
  const children = Array.isArray(node.nodes) ? node.nodes : [];
  const meta = planMeta(node);
  return (
    '<li class="trace-node">' +
    '<div class="trace-row">' +
    '<span class="trace-status ok"></span>' +
    '<span class="trace-label mono">' +
    esc(planLabel(node)) +
    "</span>" +
    '<span class="badge">' +
    esc(node.kind || "node") +
    "</span>" +
    (meta ? '<span class="trace-meta">' + esc(meta) + "</span>" : "") +
    "</div>" +
    (children.length
      ? '<ul class="trace-children">' + children.map(renderPlanNode).join("") + "</ul>"
      : "") +
    "</li>"
  );
}

export function renderRoutePlan(plan) {
  if (!plan || typeof plan !== "object") return "";
  const nodes = Array.isArray(plan.nodes) ? plan.nodes : [];
  if (!nodes.length) return "";
  const title = [plan.name || plan.kind || "路由计划", plan.strategy].filter(Boolean).join(" · ");
  return (
    '<div class="trace-section"><h4>路由计划 · ' +
    esc(title) +
    '</h4><ul class="trace-tree plan-tree">' +
    nodes.map(renderPlanNode).join("") +
    "</ul></div>"
  );
}

export function renderRouteTrace(trace) {
  if (!trace || typeof trace !== "object") {
    return '<p class="hint">该记录未包含路由轨迹。</p>';
  }
  const route = Array.isArray(trace.route) ? trace.route : [];
  const execution = trace.execution;
  return (
    (route.length
      ? '<div class="trace-section"><h4>路由轨迹</h4><ol class="trace-steps">' +
        route.map((step) => "<li>" + esc(step) + "</li>").join("") +
        "</ol></div>"
      : "") +
    (execution && typeof execution === "object"
      ? '<div class="trace-section"><h4>执行树</h4><ul class="trace-tree">' +
        renderExecutionTree(execution) +
        "</ul></div>"
      : '<p class="hint">该记录未包含执行轨迹。</p>')
  );
}

export function renderExplainResult(data) {
  if (!data || typeof data !== "object") return '<p class="hint">没有解析结果。</p>';
  const match = data.match || {};
  const summary = [
    ["请求模型", data.requestedModel || "-"],
    ["匹配类型", match.type || "-"],
  ];
  if (match.provider) summary.push(["Provider", match.provider]);
  if (match.model) summary.push(["模型", match.model]);
  summary.push([
    "配置版本",
    data.configVersion === null || data.configVersion === undefined ? "-" : "v" + data.configVersion,
  ]);
  const steps = Array.isArray(data.trace) ? data.trace : [];
  const error = data.error;
  return (
    '<div class="detail-grid">' +
    summary
      .map(
        ([label, value]) =>
          '<div><span>' + esc(label) + "</span><strong>" + esc(value) + "</strong></div>",
      )
      .join("") +
    "</div>" +
    (error
      ? '<div class="issue error"><strong>' +
        esc(error.code || "错误") +
        "</strong><p>" +
        esc(error.message || "路由解析失败") +
        "</p></div>"
      : "") +
    (steps.length
      ? '<div class="trace-section"><h4>匹配轨迹</h4><ol class="trace-steps">' +
        steps.map((step) => "<li>" + esc(step) + "</li>").join("") +
        "</ol></div>"
      : "") +
    renderRoutePlan(data.plan) +
    '<details class="raw-json"><summary>原始 JSON</summary><pre class="mono">' +
    esc(JSON.stringify(data, null, 2)) +
    "</pre></details>"
  );
}
