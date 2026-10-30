import type { Context } from "hono";
import type { AppEnv } from "../app";
import { GATEWAY_VERSION } from "../core/version";

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FufuGateway 管理台</title>
  <link rel="stylesheet" href="/ui-static/app.css">
</head>
<body>
  <div id="login" class="login-shell">
    <form id="login-form" class="login-card">
      <div class="brand">FufuGateway</div>
      <div class="brand-sub">Multi-protocol AI Gateway · v${GATEWAY_VERSION}</div>
      <label class="field">
        <span>管理员令牌</span>
        <input id="login-token" type="password" autocomplete="current-password" placeholder="ADMIN_TOKEN" required>
      </label>
      <button class="btn primary" type="submit">进入管理台</button>
      <p class="hint">令牌仅保存在当前标签页的 sessionStorage 中，关闭标签页即失效。</p>
      <div id="login-error" class="error-text"></div>
    </form>
  </div>

  <div id="app" class="app-shell hidden">
    <aside class="sidebar">
      <div class="brand small">FufuGateway</div>
      <nav id="nav"></nav>
      <div class="sidebar-footer">
        <button id="logout" class="btn ghost small-btn" type="button">退出登录</button>
      </div>
    </aside>
    <main class="main">
      <header class="topbar">
        <h1 id="page-title">概览</h1>
        <div class="topbar-actions">
          <span id="status-dot" class="dot"></span>
          <span id="status-text">未连接</span>
        </div>
      </header>
      <div id="toast" class="toast hidden"></div>
      <section id="content" class="content"></section>
    </main>
  </div>

  <div id="modal" class="modal hidden">
    <div class="modal-card">
      <header class="modal-head">
        <h2 id="modal-title"></h2>
        <button id="modal-close" class="btn ghost small-btn" type="button">关闭</button>
      </header>
      <div id="modal-body" class="modal-body"></div>
    </div>
  </div>

  <noscript>此管理台需要启用 JavaScript。</noscript>
  <script src="/ui-static/app.js" defer></script>
</body>
</html>`;

const SECURITY_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

export function uiHandler(_c: Context<AppEnv>): Response {
  return new Response(HTML, { status: 200, headers: SECURITY_HEADERS });
}
