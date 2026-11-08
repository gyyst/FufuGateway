import type { Context } from "hono";
import type { AppEnv } from "../app";
import { GATEWAY_VERSION } from "../core/version";

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FufuGateway 管理台</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="/ui-static/app.css">
  <script src="/ui-static/theme-init.js"></script>
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
      <p class="hint">令牌保存在浏览器本地（localStorage）中，关闭标签页后仍保持登录；退出登录会清除。</p>
      <div id="login-error" class="error-text"></div>
    </form>
  </div>

  <div id="app" class="app-shell hidden">
    <aside class="sidebar" id="sidebar">
      <div class="brand small">FufuGateway</div>
      <nav id="nav"></nav>
      <div class="sidebar-footer">
        <button id="logout" class="btn ghost small-btn" type="button">退出登录</button>
      </div>
    </aside>
    <div id="nav-backdrop" class="nav-backdrop hidden"></div>
    <main class="main">
      <header class="topbar">
        <div class="topbar-left">
          <button id="nav-toggle" class="btn ghost small-btn nav-toggle" type="button" aria-label="打开导航" aria-expanded="false">菜单</button>
          <h1 id="page-title">概览</h1>
        </div>
        <div class="topbar-actions">
          <span id="config-state" class="status-chip">配置 --</span>
          <span id="breaker-state" class="status-chip">熔断 --</span>
          <span id="status-dot" class="dot"></span>
          <span id="status-text">未连接</span>
          <button id="palette-toggle" class="btn ghost small-btn" type="button" aria-label="打开命令面板（Ctrl+K）">搜索 <span class="kbd">Ctrl K</span></button>
          <button id="theme-toggle" class="btn ghost small-btn" type="button">浅色</button>
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
  <script type="module" src="/ui-static/app.js"></script>
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
