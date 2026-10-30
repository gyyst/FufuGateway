(() => {
  "use strict";

  const state = {
    token: sessionStorage.getItem("fufu_admin_token") || "",
    providers: [],
    users: [],
    page: "overview",
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const PAGES = [
    ["overview", "概览"],
    ["providers", "Provider"],
    ["models", "模型"],
    ["aliases", "别名"],
    ["wildcards", "通配符"],
    ["combos", "Combo"],
    ["keys", "API Key"],
    ["users", "用户"],
    ["pricing", "价格表"],
    ["usage", "用量与请求"],
    ["config", "配置与审计"],
  ];

  const PROVIDER_TYPES = ["OPENAI_COMPATIBLE", "ANTHROPIC", "GOOGLE_GEMINI", "CUSTOM"];
  const PROTOCOLS = [
    ["openai-chat", "OpenAI Chat"],
    ["openai-responses", "OpenAI Responses"],
    ["anthropic", "Anthropic Messages"],
    ["gemini", "Google Gemini"],
  ];
  const STRATEGIES = [
    "fallback",
    "round_robin",
    "weighted_round_robin",
    "random",
    "priority",
    "lowest_latency",
    "lowest_cost",
    "race",
    "fusion",
  ];

  function esc(value) {
    return String(value === undefined || value === null ? "" : value).replace(/[&<>"']/g, (ch) => {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function fmtTime(ts) {
    if (!ts) return "-";
    const date = new Date(ts);
    return date.toLocaleString();
  }

  function fmtUsd(value) {
    const number = Number(value || 0);
    return "$" + number.toFixed(number >= 1 ? 2 : 6);
  }

  function fmtNumber(value) {
    return Number(value || 0).toLocaleString();
  }

  function badge(ok, text) {
    return '<span class="badge ' + (ok ? "ok" : "bad") + '">' + esc(text || (ok ? "启用" : "停用")) + "</span>";
  }

  function setStatus(ok, text) {
    const dot = $("#status-dot");
    const label = $("#status-text");
    if (!dot || !label) return;
    dot.className = "dot " + (ok ? "ok" : "bad");
    label.textContent = text || (ok ? "已连接" : "连接异常");
  }

  let toastTimer = null;
  function notify(message, kind) {
    const toast = $("#toast");
    if (!toast) return;
    toast.textContent = String(message);
    toast.className = "toast " + (kind === "ok" ? "ok" : kind === "bad" ? "bad" : "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), 4500);
  }

  async function api(path, options) {
    const opts = options || {};
    const headers = { authorization: "Bearer " + state.token };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(path, {
      method: opts.method || "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (response.status === 401) {
      sessionStorage.removeItem("fufu_admin_token");
      state.token = "";
      showLogin();
      const error = new Error("管理员令牌无效或已过期");
      error.status = 401;
      throw error;
    }
    if (!response.ok) {
      const message =
        payload && payload.error && payload.error.message
          ? payload.error.message
          : "HTTP " + response.status;
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function ensureLookups(force) {
    if (force || state.providers.length === 0) {
      const data = await api("/admin/providers");
      state.providers = data.data || [];
    }
    if (force || state.users.length === 0) {
      const data = await api("/admin/users");
      state.users = data.data || [];
    }
  }

  function providerName(id) {
    const provider = state.providers.find((item) => item.id === id);
    return provider ? provider.name : id;
  }

  function userName(id) {
    const user = state.users.find((item) => item.id === id);
    return user ? user.email || user.displayName || user.id : id;
  }

  // ---------------------------------------------------------------------
  // 登录与路由
  // ---------------------------------------------------------------------

  function showLogin() {
    $("#app").classList.add("hidden");
    $("#login").classList.remove("hidden");
    setStatus(false, "未连接");
  }

  function showApp() {
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
  }

  async function attemptLogin(token) {
    state.token = token;
    try {
      await api("/admin/health");
      sessionStorage.setItem("fufu_admin_token", token);
      showApp();
      await ensureLookups(true);
      setStatus(true, "已连接");
      await route();
    } catch (error) {
      state.token = "";
      sessionStorage.removeItem("fufu_admin_token");
      showLogin();
      if (error.status !== 401) {
        $("#login-error").textContent = error.message;
      }
    }
  }

  function renderNav() {
    const nav = $("#nav");
    nav.innerHTML = PAGES.map(([key, label]) => {
      return '<a href="#/' + key + '" data-page="' + key + '">' + esc(label) + "</a>";
    }).join("");
  }

  function activePage() {
    const raw = location.hash.replace(/^#\/?/, "");
    const found = PAGES.find(([key]) => key === raw);
    return found ? found[0] : "overview";
  }

  async function route() {
    if (!state.token) {
      showLogin();
      return;
    }
    showApp();
    const page = activePage();
    state.page = page;
    const label = (PAGES.find(([key]) => key === page) || ["", "概览"])[1];
    $("#page-title").textContent = label;
    $$("#nav a").forEach((link) => {
      link.classList.toggle("active", link.dataset.page === page);
    });
    const content = $("#content");
    content.innerHTML = '<div class="loading">加载中...</div>';
    try {
      await renderers[page](content);
      setStatus(true, "已连接");
    } catch (error) {
      if (error.status === 401) return;
      content.innerHTML =
        '<div class="card"><h3>加载失败</h3><p class="error-text">' +
        esc(error.message) +
        "</p></div>";
      setStatus(false, "请求失败");
    }
  }

  // ---------------------------------------------------------------------
  // 模态框与表单
  // ---------------------------------------------------------------------

  function modal(title, bodyHtml) {
    $("#modal-title").textContent = title;
    const body = $("#modal-body");
    body.innerHTML = bodyHtml;
    $("#modal").classList.remove("hidden");
    return body;
  }

  function closeModal() {
    $("#modal").classList.add("hidden");
    $("#modal-body").innerHTML = "";
  }

  function optionList(field) {
    if (field.options) {
      return field.options.map((option) => {
        if (Array.isArray(option)) return { value: option[0], label: option[1] };
        return { value: option, label: option };
      });
    }
    if (field.optionsFrom === "providers") {
      return state.providers.map((provider) => ({
        value: provider.id,
        label: provider.name + " (" + provider.id + ")",
      }));
    }
    if (field.optionsFrom === "users") {
      return state.users.map((user) => ({
        value: user.id,
        label: (user.email || user.displayName || user.id) + " (" + user.id + ")",
      }));
    }
    return [];
  }

  function fieldValue(field, row) {
    if (!row) return field.default;
    if (typeof field.get === "function") return field.get(row);
    return row[field.name];
  }

  function fieldHtml(field, row) {
    const name = "f_" + field.name;
    const value = fieldValue(field, row);
    const span = field.span === 2 ? " span-2" : "";
    let control = "";
    if (field.type === "checkbox") {
      const checked = value === undefined ? field.default === true : value === true;
      control =
        '<label class="checkbox-row"><input type="checkbox" id="' +
        name +
        '" name="' +
        field.name +
        '"' +
        (checked ? " checked" : "") +
        "><span>" +
        esc(field.checkboxLabel || field.label) +
        "</span></label>";
      return (
        '<div class="field' +
        span +
        '"><span>' +
        esc(field.label) +
        "</span>" +
        control +
        (field.help ? '<div class="help">' + esc(field.help) + "</div>" : "") +
        "</div>"
      );
    }
    if (field.type === "select") {
      const options = optionList(field);
      const current = value === undefined ? field.default : value;
      control =
        '<select id="' +
        name +
        '" name="' +
        field.name +
        '"' +
        (field.required ? " required" : "") +
        ">" +
        (field.allowEmpty ? '<option value="">未设置</option>' : "") +
        options
          .map((option) => {
            return (
              '<option value="' +
              esc(option.value) +
              '"' +
              (String(option.value) === String(current) ? " selected" : "") +
              ">" +
              esc(option.label) +
              "</option>"
            );
          })
          .join("") +
        "</select>";
    } else if (field.type === "json") {
      const raw = value === undefined ? field.default : value;
      const text = raw === undefined ? "" : JSON.stringify(raw, null, 2);
      control =
        '<textarea id="' +
        name +
        '" name="' +
        field.name +
        '" rows="' +
        (field.rows || 6) +
        '">' +
        esc(text) +
        "</textarea>";
    } else if (field.type === "csv") {
      const raw = value === undefined ? field.default : value;
      const text = Array.isArray(raw) ? raw.join(", ") : raw || "";
      control =
        '<input id="' + name + '" name="' + field.name + '" type="text" value="' + esc(text) + '">';
    } else if (field.type === "number") {
      control =
        '<input id="' +
        name +
        '" name="' +
        field.name +
        '" type="number" step="' +
        (field.step || "1") +
        '"' +
        (field.min !== undefined ? ' min="' + field.min + '"' : "") +
        (field.required ? " required" : "") +
        ' value="' +
        esc(value === undefined ? field.default === undefined ? "" : field.default : value) +
        '">';
    } else if (field.type === "datetime") {
      let local = "";
      if (value) {
        const date = new Date(value);
        const pad = (n) => String(n).padStart(2, "0");
        local =
          date.getFullYear() +
          "-" +
          pad(date.getMonth() + 1) +
          "-" +
          pad(date.getDate()) +
          "T" +
          pad(date.getHours()) +
          ":" +
          pad(date.getMinutes());
      }
      control =
        '<input id="' + name + '" name="' + field.name + '" type="datetime-local" value="' + esc(local) + '">';
    } else if (field.type === "password") {
      control =
        '<input id="' +
        name +
        '" name="' +
        field.name +
        '" type="password" autocomplete="new-password" value="' +
        esc(value || "") +
        '"' +
        (field.required ? " required" : "") +
        ">";
    } else {
      control =
        '<input id="' +
        name +
        '" name="' +
        field.name +
        '" type="text" value="' +
        esc(value === undefined ? field.default === undefined ? "" : field.default : value) +
        '"' +
        (field.required ? " required" : "") +
        ">";
    }
    return (
      '<label class="field' +
      span +
      '"><span>' +
      esc(field.label) +
      "</span>" +
      control +
      (field.help ? '<div class="help">' + esc(field.help) + "</div>" : "") +
      "</label>"
    );
  }

  function formHtml(fields, row) {
    return (
      '<form id="entity-form"><div class="form-grid">' +
      fields
        .filter((field) => !(field.createOnly && row) && !(field.editOnly && !row))
        .map((field) => fieldHtml(field, row))
        .join("") +
      '</div><div class="form-actions"><button type="button" class="btn ghost" data-cancel>取消</button><button type="submit" class="btn primary">保存</button></div></form>'
    );
  }

  function readForm(form, fields, isEdit) {
    const payload = {};
    for (const field of fields) {
      if (field.createOnly && isEdit) continue;
      if (field.editOnly && !isEdit) continue;
      const element = form.elements.namedItem(field.name);
      if (!element) continue;
      if (field.type === "checkbox") {
        payload[field.name] = element.checked;
        continue;
      }
      const value = element.value;
      if (value === "" || value === null) continue;
      if (field.type === "number") {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error(field.label + " 必须是数字");
        payload[field.name] = number;
      } else if (field.type === "json") {
        try {
          payload[field.name] = JSON.parse(value);
        } catch {
          throw new Error(field.label + " 不是合法 JSON");
        }
      } else if (field.type === "csv") {
        payload[field.name] = value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
      } else if (field.type === "datetime") {
        payload[field.name] = new Date(value).getTime();
      } else {
        payload[field.name] = value;
      }
    }
    return payload;
  }

  async function openEntityForm(entity, row) {
    await ensureLookups();
    const body = modal(
      entity.title + (row ? " · 编辑" : " · 新建"),
      formHtml(entity.fields, row || null),
    );
    const form = $("#entity-form", body);
    $("[data-cancel]", form).onclick = closeModal;
    form.onsubmit = async (event) => {
      event.preventDefault();
      try {
        const payload = readForm(form, entity.fields, Boolean(row));
        await api(entity.endpoint + (row ? "/" + row.id : ""), {
          method: row ? "PUT" : "POST",
          body: payload,
        });
        closeModal();
        notify("已保存", "ok");
        await route();
      } catch (error) {
        notify(error.message, "bad");
      }
    };
  }

  async function removeEntity(entity, row) {
    if (!confirm("确认删除 " + (row.name || row.modelId || row.id) + "？此操作不可撤销。")) return;
    try {
      await api(entity.endpoint + "/" + row.id, { method: "DELETE" });
      notify("已删除", "ok");
      await route();
    } catch (error) {
      notify(error.message, "bad");
    }
  }

  function tableHtml(entity, rows) {
    if (!rows.length) {
      return '<div class="table-wrap"><div class="empty">暂无数据</div></div>';
    }
    const head =
      "<tr>" +
      entity.columns.map((column) => "<th>" + esc(column.label) + "</th>").join("") +
      "<th>操作</th></tr>";
    const body = rows
      .map((row) => {
        const cells = entity.columns
          .map((column) => {
            let value;
            if (typeof column.render === "function") value = column.render(row);
            else value = esc(row[column.key] === undefined ? "-" : row[column.key]);
            return "<td" + (column.mono ? ' class="mono"' : "") + ">" + value + "</td>";
          })
          .join("");
        const extra = (entity.actions || [])
          .map((action) => {
            return (
              '<button class="btn small-btn' +
              (action.danger ? " danger" : "") +
              '" data-action="' +
              action.key +
              '" data-id="' +
              esc(row.id) +
              '">' +
              esc(action.label) +
              "</button>"
            );
          })
          .join("");
        return (
          '<tr>' +
          cells +
          '<td><div class="row-actions"><button class="btn small-btn" data-action="edit" data-id="' +
          esc(row.id) +
          '">编辑</button>' +
          extra +
          '<button class="btn small-btn danger" data-action="delete" data-id="' +
          esc(row.id) +
          '">删除</button></div></td></tr>'
        );
      })
      .join("");
    return '<div class="table-wrap"><table><thead>' + head + "</thead><tbody>" + body + "</tbody></table></div>";
  }

  function crudPage(entity) {
    return async (root) => {
      await ensureLookups();
      const response = await api(entity.endpoint);
      const rows = response.data || [];
      root.innerHTML =
        '<div class="section-head"><h2>' +
        esc(entity.title) +
        '</h2><div class="actions"><button class="btn primary" data-new>新建</button></div></div>' +
        (entity.note ? '<p class="hint">' + esc(entity.note) + "</p>" : "") +
        tableHtml(entity, rows);
      $("[data-new]", root).onclick = () => openEntityForm(entity, null);
      $$("[data-action]", root).forEach((button) => {
        button.onclick = () => {
          const row = rows.find((item) => item.id === button.dataset.id);
          if (!row) return;
          const action = button.dataset.action;
          if (action === "edit") {
            openEntityForm(entity, row);
            return;
          }
          if (action === "delete") {
            removeEntity(entity, row);
            return;
          }
          const definition = (entity.actions || []).find((item) => item.key === action);
          if (definition) definition.run(row);
        };
      });
    };
  }

  // ---------------------------------------------------------------------
  // 实体定义
  // ---------------------------------------------------------------------

  const providerFields = [
    { name: "name", label: "名称", required: true, help: "用于 provider/model 前缀，不含斜杠" },
    { name: "type", label: "类型", type: "select", options: PROVIDER_TYPES, required: true },
    { name: "protocol", label: "协议", type: "select", options: PROTOCOLS, required: true },
    { name: "baseUrl", label: "Base URL", required: true, span: 2 },
    { name: "enabled", label: "启用", type: "checkbox", default: true },
    { name: "priority", label: "优先级", type: "number", default: 100 },
    { name: "weight", label: "权重", type: "number", default: 1 },
    { name: "timeoutMs", label: "请求超时 (ms)", type: "number", default: 60000 },
    { name: "firstTokenTimeoutMs", label: "首 Token 超时 (ms)", type: "number", default: 20000 },
    { name: "idleTimeoutMs", label: "流空闲超时 (ms)", type: "number", default: 60000 },
    { name: "maxRetries", label: "最大重试次数", type: "number", default: 2 },
    {
      name: "customHeaders",
      label: "自定义请求头 (JSON)",
      type: "json",
      default: {},
      span: 2,
      help: "禁止设置 authorization、x-api-key 等受保护头部",
    },
    {
      name: "extraConfig",
      label: "扩展配置 (JSON)",
      type: "json",
      default: {},
      span: 2,
      help: "例如 authMode、endpointPath、breaker、maxTokensField",
    },
  ];

  const modelFields = [
    { name: "providerId", label: "Provider", type: "select", optionsFrom: "providers", required: true },
    { name: "modelId", label: "模型 ID", required: true },
    { name: "upstreamModelId", label: "上游模型 ID" },
    { name: "displayName", label: "显示名称" },
    { name: "inputModalities", label: "输入模态", type: "csv", default: ["text"], get: (row) => row && row.capabilities ? row.capabilities.inputModalities : undefined },
    { name: "outputModalities", label: "输出模态", type: "csv", default: ["text"], get: (row) => row && row.capabilities ? row.capabilities.outputModalities : undefined },
    { name: "supportsStream", label: "支持流式", type: "checkbox", default: true, get: (row) => row && row.capabilities ? row.capabilities.supportsStream : undefined },
    { name: "supportsTools", label: "支持工具", type: "checkbox", default: false, get: (row) => row && row.capabilities ? row.capabilities.supportsTools : undefined },
    { name: "supportsParallelTools", label: "并行工具", type: "checkbox", default: false, get: (row) => row && row.capabilities ? row.capabilities.supportsParallelTools : undefined },
    { name: "supportsJsonSchema", label: "JSON Schema", type: "checkbox", default: false, get: (row) => row && row.capabilities ? row.capabilities.supportsJsonSchema : undefined },
    { name: "supportsReasoning", label: "推理", type: "checkbox", default: false, get: (row) => row && row.capabilities ? row.capabilities.supportsReasoning : undefined },
    { name: "supportsVision", label: "视觉", type: "checkbox", default: false, get: (row) => row && row.capabilities ? row.capabilities.supportsVision : undefined },
    { name: "supportsAudio", label: "音频", type: "checkbox", default: false, get: (row) => row && row.capabilities ? row.capabilities.supportsAudio : undefined },
    { name: "supportsVideo", label: "视频", type: "checkbox", default: false, get: (row) => row && row.capabilities ? row.capabilities.supportsVideo : undefined },
    { name: "supportsPromptCache", label: "Prompt Cache", type: "checkbox", default: false, get: (row) => row && row.capabilities ? row.capabilities.supportsPromptCache : undefined },
    { name: "contextWindow", label: "上下文窗口", type: "number", get: (row) => row && row.capabilities ? row.capabilities.contextWindow : undefined },
    { name: "maxOutputTokens", label: "最大输出 Token", type: "number", get: (row) => row && row.capabilities ? row.capabilities.maxOutputTokens : undefined },
    { name: "inputPrice", label: "输入价格 / 百万 Token", type: "number", step: "0.000001", default: 0, get: (row) => row && row.pricing ? row.pricing.inputPrice : undefined },
    { name: "outputPrice", label: "输出价格 / 百万 Token", type: "number", step: "0.000001", default: 0, get: (row) => row && row.pricing ? row.pricing.outputPrice : undefined },
    { name: "cachedInputPrice", label: "缓存输入价格", type: "number", step: "0.000001", get: (row) => row && row.pricing ? row.pricing.cachedInputPrice : undefined },
    { name: "reasoningPrice", label: "推理输出价格", type: "number", step: "0.000001", get: (row) => row && row.pricing ? row.pricing.reasoningPrice : undefined },
    { name: "enabled", label: "启用", type: "checkbox", default: true },
  ];

  const aliasFields = [
    { name: "name", label: "别名", required: true },
    {
      name: "target",
      label: "目标 (JSON)",
      type: "json",
      required: true,
      default: "openai/gpt-4o-mini",
      span: 2,
      help: '字符串表示模型引用，也可用 {"combo":"name"} / {"wildcard":"pattern"} / {"alias":"name"}',
    },
    { name: "enabled", label: "启用", type: "checkbox", default: true },
    { name: "priority", label: "优先级", type: "number", default: 100 },
    { name: "description", label: "说明", span: 2 },
  ];

  const wildcardFields = [
    { name: "pattern", label: "Pattern", required: true, help: "仅支持 * 与 ?" },
    { name: "strategy", label: "策略", type: "select", options: STRATEGIES, default: "fallback" },
    {
      name: "targets",
      label: "目标列表 (JSON)",
      type: "json",
      default: ["openai/gpt-4o-mini"],
      span: 2,
      rows: 5,
      help: '字符串或 {"combo":"name"}、{"alias":"name"}、{"wildcard":"pattern"}',
    },
    { name: "priority", label: "优先级", type: "number", default: 100 },
    { name: "enabled", label: "启用", type: "checkbox", default: true },
    { name: "description", label: "说明", span: 2 },
  ];

  const pricingFields = [
    { name: "providerId", label: "Provider", type: "select", optionsFrom: "providers", required: true },
    { name: "modelId", label: "上游模型 ID", required: true },
    { name: "inputPrice", label: "输入价格 / 1M", type: "number", step: "0.000001", required: true },
    { name: "outputPrice", label: "输出价格 / 1M", type: "number", step: "0.000001", required: true },
    { name: "cachedInputPrice", label: "缓存输入价格", type: "number", step: "0.000001" },
    { name: "reasoningPrice", label: "推理输出价格", type: "number", step: "0.000001" },
    { name: "currency", label: "币种", default: "USD" },
    { name: "effectiveFrom", label: "生效时间", type: "datetime" },
  ];

  const comboFields = [
    { name: "name", label: "名称", required: true },
    { name: "strategy", label: "策略", type: "select", options: STRATEGIES, default: "fallback" },
    { name: "judgeModel", label: "Judge Model", help: "fusion 策略必填，例如 openai/gpt-4o-mini" },
    {
      name: "nodes",
      label: "节点 (JSON)",
      type: "json",
      required: true,
      span: 2,
      rows: 8,
      default: ["openai/gpt-4o-mini"],
      help: '字符串为模型引用；对象可带 weight、priority、timeoutMs、maxRetries，或 {"combo":"name"}',
    },
    { name: "timeoutMs", label: "整体超时 (ms)", type: "number" },
    { name: "maxConcurrency", label: "最大并发", type: "number", min: 1 },
    {
      name: "sticky",
      label: "会话粘性 (JSON)",
      type: "json",
      span: 2,
      help: '{"enabled":true,"ttlSeconds":300,"mode":"round_robin"}',
    },
    { name: "enabled", label: "启用", type: "checkbox", default: true },
    { name: "description", label: "说明", span: 2 },
  ];

  const userFields = [
    { name: "email", label: "邮箱" },
    { name: "displayName", label: "显示名称" },
    { name: "role", label: "角色", type: "select", options: ["user", "admin"], default: "user" },
    {
      name: "status",
      label: "状态",
      type: "select",
      options: ["active", "disabled"],
      default: "active",
      editOnly: true,
    },
    { name: "tenantId", label: "租户" },
    { name: "rpmLimit", label: "RPM 限制", type: "number" },
    { name: "tpmLimit", label: "TPM 限制", type: "number" },
    { name: "concurrencyLimit", label: "并发限制", type: "number" },
    { name: "dailyBudgetUsd", label: "每日预算 (USD)", type: "number", step: "0.000001" },
    { name: "monthlyBudgetUsd", label: "每月预算 (USD)", type: "number", step: "0.000001" },
  ];

  function enabledColumn() {
    return { label: "状态", render: (row) => badge(row.enabled !== false) };
  }

  const entities = {
    providers: {
      title: "Provider",
      endpoint: "/admin/providers",
      fields: providerFields,
      columns: [
        { label: "名称", key: "name" },
        { label: "类型", key: "type", mono: true },
        { label: "协议", key: "protocol", mono: true },
        { label: "Base URL", render: (row) => '<span class="mono tight" title="' + esc(row.baseUrl) + '">' + esc(row.baseUrl) + "</span>" },
        enabledColumn(),
        { label: "账户", render: (row) => esc((row.enabledAccountCount || 0) + " / " + (row.accountCount || 0)) },
        { label: "优先级", key: "priority" },
      ],
      actions: [
        {
          key: "accounts",
          label: "账户",
          run: (row) => openAccounts(row),
        },
        {
          key: "test",
          label: "测试",
          run: async (row) => {
            try {
              const result = await api("/admin/providers/" + row.id + "/test", { method: "POST" });
              modal("连通性测试", '<pre class="mono">' + esc(JSON.stringify(result, null, 2)) + "</pre>");
            } catch (error) {
              notify(error.message, "bad");
            }
          },
        },
        {
          key: "sync",
          label: "同步模型",
          run: async (row) => {
            if (!confirm("从上游同步模型？同步结果默认禁用，需人工确认能力后启用。")) return;
            try {
              const result = await api("/admin/providers/" + row.id + "/sync-models", { method: "POST" });
              notify("同步完成：新增 " + result.created + "，跳过 " + result.skipped, "ok");
              await route();
            } catch (error) {
              notify(error.message, "bad");
            }
          },
        },
      ],
    },
    models: {
      title: "模型",
      endpoint: "/admin/models",
      fields: modelFields,
      columns: [
        { label: "模型 ID", key: "modelId", mono: true },
        { label: "Provider", render: (row) => esc(providerName(row.providerId)) },
        { label: "上游模型", key: "upstreamModelId", mono: true },
        enabledColumn(),
        {
          label: "能力",
          render: (row) => {
            const capabilities = row.capabilities || {};
            const flags = [];
            if (capabilities.supportsStream) flags.push("stream");
            if (capabilities.supportsTools) flags.push("tools");
            if (capabilities.supportsVision) flags.push("vision");
            if (capabilities.supportsReasoning) flags.push("reasoning");
            return esc(flags.join(", ") || "-");
          },
        },
        {
          label: "价格 / 1M",
          render: (row) => {
            const pricing = row.pricing || {};
            return esc(fmtUsd(pricing.inputPrice) + " / " + fmtUsd(pricing.outputPrice));
          },
        },
      ],
    },
    aliases: {
      title: "别名",
      endpoint: "/admin/aliases",
      fields: aliasFields,
      columns: [
        { label: "别名", key: "name", mono: true },
        { label: "目标", render: (row) => '<span class="mono">' + esc(JSON.stringify(row.target)) + "</span>" },
        enabledColumn(),
        { label: "优先级", key: "priority" },
      ],
    },
    wildcards: {
      title: "通配符",
      endpoint: "/admin/wildcards",
      fields: wildcardFields,
      columns: [
        { label: "Pattern", key: "pattern", mono: true },
        { label: "策略", key: "strategy", mono: true },
        { label: "目标", render: (row) => '<span class="mono">' + esc(JSON.stringify(row.targets)) + "</span>" },
        enabledColumn(),
        { label: "优先级", key: "priority" },
      ],
      actions: [
        {
          key: "preview",
          label: "预览",
          run: async (row) => {
            const pattern = prompt("通配符 pattern", row.pattern || "");
            if (!pattern) return;
            try {
              const result = await api("/admin/wildcards/preview", {
                method: "POST",
                body: { pattern },
              });
              modal("通配符预览", '<pre class="mono">' + esc(JSON.stringify(result.data, null, 2)) + "</pre>");
            } catch (error) {
              notify(error.message, "bad");
            }
          },
        },
      ],
    },
    combos: {
      title: "Combo",
      endpoint: "/admin/combos",
      fields: comboFields,
      columns: [
        { label: "名称", key: "name", mono: true },
        { label: "策略", key: "strategy", mono: true },
        { label: "节点数", render: (row) => esc((row.nodes || []).length) },
        { label: "Judge", render: (row) => esc(row.judgeModel || "-") },
        enabledColumn(),
      ],
      actions: [
        {
          key: "validate",
          label: "校验",
          run: async (row) => {
            try {
              const result = await api("/admin/combos/" + row.id + "/validate", { method: "POST" });
              modal(
                "Combo 校验",
                '<p>' +
                  (result.valid ? '<span class="badge ok">通过</span>' : '<span class="badge bad">失败</span>') +
                  '</p><pre class="mono">' +
                  esc(JSON.stringify(result.issues, null, 2)) +
                  "</pre>",
              );
            } catch (error) {
              notify(error.message, "bad");
            }
          },
        },
        {
          key: "preview",
          label: "预览",
          run: async (row) => {
            try {
              const result = await api("/admin/combos/" + row.id + "/preview", { method: "POST" });
              modal("Combo 预览", '<pre class="mono">' + esc(JSON.stringify(result.data, null, 2)) + "</pre>");
            } catch (error) {
              notify(error.message, "bad");
            }
          },
        },
      ],
    },
    pricing: {
      title: "价格表",
      endpoint: "/admin/pricing",
      fields: pricingFields,
      columns: [
        { label: "Provider", render: (row) => esc(providerName(row.providerId)) },
        { label: "上游模型", key: "modelId", mono: true },
        { label: "输入 / 1M", render: (row) => esc(fmtUsd(row.inputPrice)) },
        { label: "输出 / 1M", render: (row) => esc(fmtUsd(row.outputPrice)) },
        { label: "缓存输入", render: (row) => esc(fmtUsd(row.cachedInputPrice)) },
        { label: "推理输出", render: (row) => esc(fmtUsd(row.reasoningPrice)) },
        { label: "币种", key: "currency" },
      ],
    },
    users: {
      title: "用户",
      endpoint: "/admin/users",
      fields: userFields,
      columns: [
        { label: "邮箱 / 名称", render: (row) => esc(row.email || row.displayName || row.id) },
        { label: "ID", key: "id", mono: true },
        { label: "角色", key: "role" },
        {
          label: "状态",
          render: (row) => badge(row.status === "active", row.status),
        },
        {
          label: "限制",
          render: (row) => {
            const parts = [];
            if (row.rpmLimit) parts.push("RPM " + row.rpmLimit);
            if (row.tpmLimit) parts.push("TPM " + row.tpmLimit);
            if (row.concurrencyLimit) parts.push("并发 " + row.concurrencyLimit);
            if (row.dailyBudgetUsd) parts.push("日预算 " + fmtUsd(row.dailyBudgetUsd));
            return esc(parts.join(" · ") || "-");
          },
        },
      ],
    },
  };

  async function openAccounts(provider) {
    let detail;
    try {
      detail = await api("/admin/providers/" + provider.id);
    } catch (error) {
      notify(error.message, "bad");
      return;
    }
    const accounts = detail.data.accounts || [];
    const rows = accounts.length
      ? accounts
          .map((account) => {
            return (
              "<tr><td class=\"mono\">" +
              esc(account.name) +
              "</td><td>" +
              esc(account.credentialType) +
              "</td><td>" +
              esc(account.weight) +
              "</td><td>" +
              esc(account.priority) +
              "</td><td>" +
              badge(account.enabled) +
              '</td><td><div class="row-actions">' +
              '<button class="btn small-btn" data-toggle="' +
              esc(account.id) +
              '" data-enabled="' +
              String(account.enabled) +
              '">' +
              (account.enabled ? "停用" : "启用") +
              "</button>" +
              '<button class="btn small-btn" data-key="' +
              esc(account.id) +
              '">更新密钥</button>' +
              '<button class="btn small-btn danger" data-delete="' +
              esc(account.id) +
              '">删除</button>' +
              "</div></td></tr>"
            );
          })
          .join("")
      : '<tr><td colspan="6" class="empty">暂无账户</td></tr>';

    const body = modal(
      "账户 · " + provider.name,
      '<div class="table-wrap"><table><thead><tr><th>名称</th><th>凭据</th><th>权重</th><th>优先级</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
        rows +
        "</tbody></table></div>" +
        '<h3 style="margin-top:18px">新增账户</h3>' +
        '<form id="account-form"><div class="form-grid">' +
        '<label class="field"><span>名称</span><input name="name" required></label>' +
        '<label class="field"><span>上游 API Key</span><input name="apiKey" type="password" autocomplete="new-password"></label>' +
        '<label class="field"><span>或 Secret 名称</span><input name="secretRef" placeholder="UPSTREAM_KEY"></label>' +
        '<label class="field"><span>权重</span><input name="weight" type="number" value="1"></label>' +
        '<label class="field"><span>优先级</span><input name="priority" type="number" value="100"></label>' +
        '<label class="field"><span>启用</span><span class="checkbox-row"><input name="enabled" type="checkbox" checked></span></label>' +
        '</div><div class="form-actions"><button type="submit" class="btn primary">添加账户</button></div></form>',
    );

    const form = $("#account-form", body);
    form.onsubmit = async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const apiKey = String(data.get("apiKey") || "");
      const secretRef = String(data.get("secretRef") || "");
      if ((apiKey === "") === (secretRef === "")) {
        notify("apiKey 与 secretRef 必须二选一", "bad");
        return;
      }
      try {
        await api("/admin/providers/" + provider.id + "/accounts", {
          method: "POST",
          body: {
            name: String(data.get("name") || ""),
            ...(apiKey ? { apiKey } : {}),
            ...(secretRef ? { secretRef } : {}),
            weight: Number(data.get("weight") || 1),
            priority: Number(data.get("priority") || 100),
            enabled: data.get("enabled") === "on",
          },
        });
        closeModal();
        notify("账户已添加", "ok");
        await openAccounts(provider);
      } catch (error) {
        notify(error.message, "bad");
      }
    };

    $$("[data-toggle]", body).forEach((button) => {
      button.onclick = async () => {
        try {
          await api("/admin/providers/" + provider.id + "/accounts/" + button.dataset.toggle, {
            method: "PUT",
            body: { enabled: button.dataset.enabled !== "true" },
          });
          await openAccounts(provider);
        } catch (error) {
          notify(error.message, "bad");
        }
      };
    });
    $$("[data-key]", body).forEach((button) => {
      button.onclick = async () => {
        const apiKey = prompt("输入新的上游 API Key（留空取消）");
        if (!apiKey) return;
        try {
          await api("/admin/providers/" + provider.id + "/accounts/" + button.dataset.key, {
            method: "PUT",
            body: { apiKey },
          });
          notify("密钥已更新", "ok");
          await openAccounts(provider);
        } catch (error) {
          notify(error.message, "bad");
        }
      };
    });
    $$("[data-delete]", body).forEach((button) => {
      button.onclick = async () => {
        if (!confirm("删除该账户？")) return;
        try {
          await api("/admin/providers/" + provider.id + "/accounts/" + button.dataset.delete, {
            method: "DELETE",
          });
          await openAccounts(provider);
        } catch (error) {
          notify(error.message, "bad");
        }
      };
    });
  }

  // ---------------------------------------------------------------------
  // API Key 页面
  // ---------------------------------------------------------------------

  const keyFields = [
    { name: "userId", label: "用户", type: "select", optionsFrom: "users", required: true, createOnly: true },
    { name: "name", label: "名称", required: true },
    { name: "scopes", label: "Scopes", type: "csv", default: ["inference"] },
    { name: "modelAllowlist", label: "模型白名单", type: "csv" },
    { name: "providerAllowlist", label: "Provider 白名单", type: "csv" },
    { name: "rpmLimit", label: "RPM 限制", type: "number" },
    { name: "tpmLimit", label: "TPM 限制", type: "number" },
    { name: "concurrencyLimit", label: "并发限制", type: "number" },
    { name: "dailyBudgetUsd", label: "每日预算 (USD)", type: "number", step: "0.000001" },
    { name: "monthlyBudgetUsd", label: "每月预算 (USD)", type: "number", step: "0.000001" },
    { name: "expiresAt", label: "过期时间", type: "datetime" },
    {
      name: "status",
      label: "状态",
      type: "select",
      options: ["active", "disabled", "revoked"],
      editOnly: true,
    },
  ];

  function showPlaintextKey(key) {
    const body = modal(
      "API Key 已生成",
      '<p class="hint">明文只显示一次，请立即保存。</p>' +
        '<pre class="mono" id="plaintext-key">' +
        esc(key) +
        "</pre>" +
        '<div class="form-actions"><button class="btn primary" id="copy-key">复制</button></div>',
    );
    $("#copy-key", body).onclick = async () => {
      try {
        await navigator.clipboard.writeText(key);
        notify("已复制", "ok");
      } catch {
        notify("复制失败，请手动选择", "bad");
      }
    };
  }

  function keysPage(root) {
    return (async () => {
      await ensureLookups();
      const response = await api("/admin/api-keys");
      const rows = response.data || [];
      root.innerHTML =
        '<div class="section-head"><h2>API Key</h2><div class="actions"><button class="btn primary" data-new>新建 API Key</button></div></div>' +
        '<p class="hint">明文只在创建或轮换时返回一次；列表仅显示前缀。</p>' +
        '<div class="table-wrap"><table><thead><tr><th>名称</th><th>前缀</th><th>用户</th><th>状态</th><th>Scopes</th><th>限制</th><th>过期</th><th>最近使用</th><th>操作</th></tr></thead><tbody>' +
        (rows.length
          ? rows
              .map((key) => {
                const limits = [];
                if (key.rpmLimit) limits.push("RPM " + key.rpmLimit);
                if (key.tpmLimit) limits.push("TPM " + key.tpmLimit);
                if (key.concurrencyLimit) limits.push("并发 " + key.concurrencyLimit);
                if (key.dailyBudgetUsd) limits.push("日预算 " + fmtUsd(key.dailyBudgetUsd));
                if (key.monthlyBudgetUsd) limits.push("月预算 " + fmtUsd(key.monthlyBudgetUsd));
                return (
                  "<tr><td>" +
                  esc(key.name) +
                  '</td><td class="mono">' +
                  esc(key.keyPrefix) +
                  "</td><td>" +
                  esc(userName(key.userId)) +
                  "</td><td>" +
                  badge(key.status === "active", key.status) +
                  '</td><td class="mono">' +
                  esc((key.scopes || []).join(", ")) +
                  "</td><td>" +
                  esc(limits.join(" · ") || "-") +
                  "</td><td>" +
                  esc(key.expiresAt ? fmtTime(key.expiresAt) : "-") +
                  "</td><td>" +
                  esc(key.lastUsedAt ? fmtTime(key.lastUsedAt) : "-") +
                  '</td><td><div class="row-actions">' +
                  '<button class="btn small-btn" data-edit="' +
                  esc(key.id) +
                  '">编辑</button>' +
                  '<button class="btn small-btn" data-rotate="' +
                  esc(key.id) +
                  '">轮换</button>' +
                  '<button class="btn small-btn danger" data-delete="' +
                  esc(key.id) +
                  '">删除</button>' +
                  "</div></td></tr>"
                );
              })
              .join("")
          : '<tr><td colspan="9" class="empty">暂无 API Key</td></tr>') +
        "</tbody></table></div>";

      $("[data-new]", root).onclick = async () => {
        await ensureLookups();
        const body = modal("新建 API Key", formHtml(keyFields, null));
        const form = $("#entity-form", body);
        $("[data-cancel]", form).onclick = closeModal;
        form.onsubmit = async (event) => {
          event.preventDefault();
          try {
            const payload = readForm(form, keyFields, false);
            const result = await api("/admin/api-keys", { method: "POST", body: payload });
            closeModal();
            showPlaintextKey(result.key);
            await route();
          } catch (error) {
            notify(error.message, "bad");
          }
        };
      };

      $$("[data-edit]", root).forEach((button) => {
        button.onclick = () => {
          const key = rows.find((item) => item.id === button.dataset.edit);
          if (!key) return;
          const body = modal("编辑 API Key", formHtml(keyFields, key));
          const form = $("#entity-form", body);
          $("[data-cancel]", form).onclick = closeModal;
          form.onsubmit = async (event) => {
            event.preventDefault();
            try {
              const payload = readForm(form, keyFields, true);
              await api("/admin/api-keys/" + key.id, { method: "PUT", body: payload });
              closeModal();
              notify("已保存", "ok");
              await route();
            } catch (error) {
              notify(error.message, "bad");
            }
          };
        };
      });

      $$("[data-rotate]", root).forEach((button) => {
        button.onclick = async () => {
          if (!confirm("轮换后将立即吊销旧 Key，是否继续？")) return;
          try {
            const result = await api("/admin/api-keys/" + button.dataset.rotate + "/rotate", {
              method: "POST",
              body: {},
            });
            showPlaintextKey(result.key);
            await route();
          } catch (error) {
            notify(error.message, "bad");
          }
        };
      });

      $$("[data-delete]", root).forEach((button) => {
        button.onclick = async () => {
          if (!confirm("删除该 API Key？")) return;
          try {
            await api("/admin/api-keys/" + button.dataset.delete, { method: "DELETE" });
            notify("已删除", "ok");
            await route();
          } catch (error) {
            notify(error.message, "bad");
          }
        };
      });
    })();
  }

  // ---------------------------------------------------------------------
  // 概览
  // ---------------------------------------------------------------------

  function cards(items) {
    return (
      '<div class="grid cols-4">' +
      items
        .map((item) => {
          return (
            '<div class="card"><h3>' +
            esc(item.label) +
            '</h3><div class="metric">' +
            item.value +
            (item.hint ? "<small>" + esc(item.hint) + "</small>" : "") +
            "</div></div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  async function overviewPage(root) {
    const [health, summary, config, requests, breakers] = await Promise.all([
      api("/admin/health"),
      api("/admin/usage/summary?groupBy=day"),
      api("/admin/config/current"),
      api("/admin/requests?limit=8"),
      api("/admin/health/breakers"),
    ]);
    const totals = summary.data.totals || {};
    const status = health.data || health;
    const configData = config.data || {};
    const openBreakers = [];
    (breakers.data || []).forEach((provider) => {
      provider.accounts.forEach((account) => {
        if (account.state !== "closed") openBreakers.push(provider.providerName + " / " + account.name + " (" + account.state + ")");
      });
      provider.models.forEach((model) => {
        if (model.state !== "closed") openBreakers.push(provider.providerName + " / " + model.name + " (" + model.state + ")");
      });
    });

    root.innerHTML =
      cards([
        { label: "数据库", value: status.db ? "正常" : "异常" },
        {
          label: "生效配置",
          value: configData.activeVersion === null ? "未发布" : "v" + configData.activeVersion,
          hint: configData.pendingChanges ? "有待发布变更" : "已同步",
        },
        { label: "近 30 天请求", value: fmtNumber(totals.requests) },
        { label: "近 30 天费用", value: fmtUsd(totals.costUsd) },
      ]) +
      '<div class="grid cols-2">' +
      '<div class="card"><h3>熔断状态</h3>' +
      (openBreakers.length
        ? '<div class="issue-list">' +
          openBreakers
            .slice(0, 12)
            .map((item) => '<div class="issue warning">' + esc(item) + "</div>")
            .join("") +
          "</div>"
        : '<p class="hint">所有 Provider、账户与模型均处于 CLOSED。</p>') +
      "</div>" +
      '<div class="card"><h3>配置校验</h3><p class="hint">' +
      (configData.validation && configData.validation.valid
        ? "当前 D1 配置通过校验。"
        : "配置存在问题，发布前请检查。") +
      '</p><a class="btn" href="#/config">前往配置</a></div>' +
      "</div>" +
      '<div class="section-head"><h2>最近请求</h2><div class="actions"><a class="btn" href="#/usage">查看全部</a></div></div>' +
      requestsTable(requests.data || []);
    bindRequestDetails(root, requests.data || []);
  }

  function requestsTable(rows) {
    return (
      '<div class="table-wrap"><table><thead><tr><th>时间</th><th>模型</th><th>Provider</th><th>状态</th><th>Token</th><th>耗时</th><th>费用</th><th>操作</th></tr></thead><tbody>' +
      (rows.length
        ? rows
            .map((row) => {
              return (
                "<tr><td>" +
                esc(fmtTime(row.createdAt)) +
                '</td><td class="mono">' +
                esc(row.requestedModel) +
                (row.actualModel && row.actualModel !== row.requestedModel ? " → " + esc(row.actualModel) : "") +
                "</td><td>" +
                esc(row.providerId || "-") +
                "</td><td>" +
                badge(row.status === "success", row.status) +
                "</td><td>" +
                esc(fmtNumber(row.totalTokens)) +
                "</td><td>" +
                esc((row.durationMs || 0) + " ms") +
                "</td><td>" +
                esc(fmtUsd((row.actualCost || 0) + (row.estimatedCost || 0))) +
                '</td><td><button class="btn small-btn" data-request="' +
                esc(row.requestId) +
                '">详情</button></td></tr>'
              );
            })
            .join("")
        : '<tr><td colspan="8" class="empty">暂无请求</td></tr>') +
      "</tbody></table></div>"
    );
  }

  function bindRequestDetails(root, rows) {
    $$("[data-request]", root).forEach((button) => {
      button.onclick = async () => {
        try {
          const result = await api("/admin/requests/" + button.dataset.request);
          modal(
            "请求详情",
            '<pre class="mono">' + esc(JSON.stringify(result.data, null, 2)) + "</pre>",
          );
        } catch (error) {
          notify(error.message, "bad");
        }
      };
    });
  }

  // ---------------------------------------------------------------------
  // 用量
  // ---------------------------------------------------------------------

  async function usagePage(root) {
    root.innerHTML =
      '<div class="section-head"><h2>用量汇总</h2><div class="actions">' +
      '<select id="usage-days" class="btn"><option value="7">近 7 天</option><option value="30" selected>近 30 天</option><option value="90">近 90 天</option></select>' +
      '<select id="usage-group" class="btn"><option value="day">按日</option><option value="week">按周</option><option value="month">按月</option></select>' +
      "</div></div><div id=\"usage-summary\"></div>" +
      '<div class="section-head"><h2>请求日志</h2><div class="actions"><input id="request-model" placeholder="模型过滤" style="width:180px"></div></div>' +
      '<div id="usage-requests"></div>';

    const load = async () => {
      const days = Number($("#usage-days").value || 30);
      const groupBy = $("#usage-group").value || "day";
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
      const modelFilter = ($("#request-model").value || "").trim();
      const requestQuery =
        "/admin/requests?limit=50&from=" +
        from +
        "&to=" +
        to +
        (modelFilter ? "&model=" + encodeURIComponent(modelFilter) : "");
      const [summary, requests] = await Promise.all([
        api("/admin/usage/summary?from=" + from + "&to=" + to + "&groupBy=" + groupBy),
        api(requestQuery),
      ]);
      const data = summary.data;
      const max = Math.max(1, ...data.buckets.map((bucket) => bucket.costUsd || 0));
      const bars = data.buckets.length
        ? '<div class="bars">' +
          data.buckets
            .map((bucket) => {
              const width = Math.max(2, Math.round(((bucket.costUsd || 0) / max) * 100));
              return (
                '<div class="bar-row"><span class="mono">' +
                esc(bucket.period) +
                '</span><div class="bar-track"><div class="bar-fill" style="width:' +
                width +
                '%"></div></div><span class="bar-value">' +
                esc(fmtUsd(bucket.costUsd)) +
                " · " +
                esc(fmtNumber(bucket.requests)) +
                "</span></div>"
              );
            })
            .join("") +
          "</div>"
        : '<div class="empty">暂无数据</div>';

      $("#usage-summary").innerHTML =
        cards([
          { label: "请求数", value: fmtNumber(data.totals.requests) },
          { label: "输入 Token", value: fmtNumber(data.totals.inputTokens) },
          { label: "输出 Token", value: fmtNumber(data.totals.outputTokens) },
          { label: "费用", value: fmtUsd(data.totals.costUsd) },
        ]) +
        '<div class="card" style="margin-top:14px"><h3>费用趋势</h3>' +
        bars +
        "</div>";
      $("#usage-requests").innerHTML = requestsTable(requests.data || []);
      bindRequestDetails($("#usage-requests"), requests.data || []);
    };

    $("#usage-days").onchange = load;
    $("#usage-group").onchange = load;
    $("#request-model").onchange = load;
    await load();
  }

  // ---------------------------------------------------------------------
  // 配置与审计
  // ---------------------------------------------------------------------

  async function configPage(root) {
    const [current, versions, audits, settings] = await Promise.all([
      api("/admin/config/current"),
      api("/admin/config/versions?limit=20"),
      api("/admin/audit-logs?limit=30"),
      api("/admin/settings"),
    ]);
    const status = current.data;
    const issues = (status.validation && status.validation.issues) || [];
    root.innerHTML =
      cards([
        {
          label: "生效版本",
          value: status.activeVersion === null ? "未发布" : "v" + status.activeVersion,
          hint: status.activeChecksum ? status.activeChecksum.slice(0, 12) : "",
        },
        {
          label: "待发布",
          value: status.pendingChanges ? "是" : "否",
          hint: status.pendingChecksum ? status.pendingChecksum.slice(0, 12) : "",
        },
        {
          label: "校验",
          value: status.validation && status.validation.valid ? "通过" : "失败",
          hint: issues.length + " 条问题",
        },
        { label: "版本总数", value: String((versions.data || []).length) },
      ]) +
      '<div class="section-head"><h2>配置操作</h2><div class="actions">' +
      '<button class="btn" id="validate-config">校验配置</button>' +
      '<button class="btn primary" id="publish-config">发布配置</button>' +
      "</div></div>" +
      '<div class="card"><h3>系统设置</h3>' +
      '<p class="hint">保存后需要发布配置版本才会生效。数值单位为字节或毫秒。</p>' +
      '<textarea id="settings-json" rows="16">' +
      esc(JSON.stringify(settings.data || {}, null, 2)) +
      '</textarea>' +
      '<div class="form-actions"><button class="btn primary" id="save-settings">保存设置</button></div>' +
      "</div>" +
      '<div class="card"><h3>校验问题</h3>' +
      (issues.length
        ? '<div class="issue-list">' +
          issues
            .map((issue) => {
              return (
                '<div class="issue ' +
                (issue.severity === "error" ? "error" : "warning") +
                '"><strong>' +
                esc(issue.code) +
                "</strong> · " +
                esc(issue.message) +
                (issue.entityId ? ' <span class="mono">' + esc(issue.entityId) + "</span>" : "") +
                "</div>"
              );
            })
            .join("") +
          "</div>"
        : '<p class="hint">暂无问题。</p>') +
      "</div>" +
      '<div class="section-head"><h2>版本历史</h2></div>' +
      '<div class="table-wrap"><table><thead><tr><th>版本</th><th>状态</th><th>Checksum</th><th>说明</th><th>创建者</th><th>时间</th><th>大小</th><th>操作</th></tr></thead><tbody>' +
      (versions.data || [])
        .map((version) => {
          return (
            "<tr><td>v" +
            esc(version.version) +
            "</td><td>" +
            badge(version.status === "published", version.status) +
            '</td><td class="mono">' +
            esc((version.checksum || "").slice(0, 12)) +
            "</td><td>" +
            esc(version.note || "-") +
            "</td><td>" +
            esc(version.createdBy || "-") +
            "</td><td>" +
            esc(fmtTime(version.createdAt)) +
            "</td><td>" +
            esc(fmtNumber(version.sizeBytes)) +
            ' B</td><td><button class="btn small-btn" data-rollback="' +
            esc(version.version) +
            '">回滚</button></td></tr>'
          );
        })
        .join("") +
      "</tbody></table></div>" +
      '<div class="section-head"><h2>审计日志</h2></div>' +
      '<div class="table-wrap"><table><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>目标</th><th>详情</th></tr></thead><tbody>' +
      (audits.data || [])
        .map((log) => {
          return (
            "<tr><td>" +
            esc(fmtTime(log.createdAt)) +
            "</td><td>" +
            esc(log.actorType + " / " + (log.actorId || "-")) +
            '</td><td class="mono">' +
            esc(log.action) +
            "</td><td>" +
            esc((log.targetType || "-") + " " + (log.targetId || "")) +
            '</td><td class="mono tight" title="' +
            esc(JSON.stringify(log.details)) +
            '">' +
            esc(JSON.stringify(log.details) || "-") +
            "</td></tr>"
          );
        })
        .join("") +
      "</tbody></table></div>";

    $("#save-settings", root).onclick = async () => {
      let payload;
      try {
        payload = JSON.parse($("#settings-json").value);
      } catch {
        notify("系统设置必须是合法 JSON", "bad");
        return;
      }
      try {
        await api("/admin/settings", { method: "PUT", body: payload });
        notify("设置已保存，请发布配置以生效", "ok");
        await route();
      } catch (error) {
        notify(error.message, "bad");
      }
    };
    $("#validate-config", root).onclick = async () => {
      try {
        const result = await api("/admin/config/validate", { method: "POST", body: {} });
        modal("配置校验", '<pre class="mono">' + esc(JSON.stringify(result.data, null, 2)) + "</pre>");
      } catch (error) {
        notify(error.message, "bad");
      }
    };
    $("#publish-config", root).onclick = async () => {
      const note = prompt("发布说明（可留空）", "") || undefined;
      try {
        const result = await api("/admin/config/publish", { method: "POST", body: note ? { note } : {} });
        notify(
          result.data.unchanged ? "配置无变化，版本 v" + result.data.version + " 保持生效" : "已发布 v" + result.data.version,
          "ok",
        );
        await route();
      } catch (error) {
        notify(error.message, "bad");
        if (error.payload && error.payload.error && error.payload.error.details) {
          modal(
            "发布失败",
            '<pre class="mono">' + esc(JSON.stringify(error.payload.error.details, null, 2)) + "</pre>",
          );
        }
      }
    };
    $$("[data-rollback]", root).forEach((button) => {
      button.onclick = async () => {
        if (!confirm("回滚到 v" + button.dataset.rollback + "？")) return;
        try {
          await api("/admin/config/rollback", {
            method: "POST",
            body: { version: Number(button.dataset.rollback) },
          });
          notify("已回滚", "ok");
          await route();
        } catch (error) {
          notify(error.message, "bad");
        }
      };
    });
  }

  // ---------------------------------------------------------------------
  // 初始化
  // ---------------------------------------------------------------------

  const renderers = {
    overview: overviewPage,
    providers: crudPage(entities.providers),
    models: crudPage(entities.models),
    aliases: crudPage(entities.aliases),
    wildcards: crudPage(entities.wildcards),
    combos: crudPage(entities.combos),
    keys: keysPage,
    users: crudPage(entities.users),
    pricing: crudPage(entities.pricing),
    usage: usagePage,
    config: configPage,
  };

  function init() {
    renderNav();
    $("#modal-close").onclick = closeModal;
    $("#modal").addEventListener("click", (event) => {
      if (event.target === $("#modal")) closeModal();
    });
    $("#logout").onclick = () => {
      sessionStorage.removeItem("fufu_admin_token");
      state.token = "";
      state.providers = [];
      state.users = [];
      showLogin();
    };
    $("#login-form").onsubmit = (event) => {
      event.preventDefault();
      const token = $("#login-token").value.trim();
      if (token) attemptLogin(token);
    };
    window.addEventListener("hashchange", () => {
      if (state.token) route();
    });
    if (state.token) {
      attemptLogin(state.token);
    } else {
      showLogin();
    }
  }

  init();
})();
