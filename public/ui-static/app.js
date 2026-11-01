import { barSeries, sparkline } from "./js/components/charts.js";
import { bindComboboxes, comboboxHtml } from "./js/components/combobox.js";
import { initCommandPalette } from "./js/components/palette.js";
import {
  renderExecutionTree,
  renderExplainResult,
  renderRouteTrace,
} from "./js/components/trace.js";
import { NAV_GROUPS } from "./js/nav.js";
import { initThemeToggle } from "./js/theme.js";

(() => {
  "use strict";

  const state = {
    token: sessionStorage.getItem("fufu_admin_token") || "",
    providers: [],
    users: [],
    models: [],
    aliases: [],
    combos: [],
    routeLookupsLoaded: false,
    page: "overview",
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const PAGES = NAV_GROUPS.flatMap((group) => group.items);

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

  async function ensureRouteLookups(force) {
    if (!force && state.routeLookupsLoaded) return;
    const [models, aliases, combos] = await Promise.all([
      api("/admin/models"),
      api("/admin/aliases"),
      api("/admin/combos"),
    ]);
    state.models = models.data || [];
    state.aliases = aliases.data || [];
    state.combos = combos.data || [];
    state.routeLookupsLoaded = true;
  }

  function providerName(id) {
    const provider = state.providers.find((item) => item.id === id);
    return provider ? provider.name : id;
  }

  function allModelEntries() {
    const entries = [];
    const seen = new Set();
    for (const model of state.models) {
      const provider = state.providers.find((item) => item.id === model.providerId);
      if (!provider) continue;
      const value = provider.name + "/" + model.modelId;
      if (seen.has(value)) continue;
      seen.add(value);
      const providerDisabled = provider.enabled === false;
      const modelDisabled = model.enabled === false;
      const suffix = modelDisabled
        ? "（未启用）"
        : providerDisabled
          ? "（Provider 停用）"
          : "";
      entries.push({
        value,
        label: provider.name + " / " + model.modelId + suffix,
        group: provider.name,
        disabled: providerDisabled || modelDisabled,
      });
    }
    entries.sort((a, b) => a.label.localeCompare(b.label));
    return entries;
  }

  function activeModelEntries() {
    return allModelEntries().filter((entry) => !entry.disabled);
  }

  function routeTargetEntries(except) {
    const entries = allModelEntries().map((entry) => ({
      value: JSON.stringify(entry.value),
      label: "模型 · " + entry.label,
      group: "模型",
    }));
    const seen = new Set(entries.map((entry) => entry.value));
    for (const alias of state.aliases) {
      if (alias.enabled === false) continue;
      if (except && (except.aliasId === alias.id || except.aliasName === alias.name)) continue;
      const value = JSON.stringify({ alias: alias.name });
      if (seen.has(value)) continue;
      seen.add(value);
      entries.push({ value, label: "别名 · " + alias.name, group: "别名" });
    }
    for (const combo of state.combos) {
      if (combo.enabled === false) continue;
      if (except && (except.comboId === combo.id || except.comboName === combo.name)) continue;
      const value = JSON.stringify({ combo: combo.name });
      if (seen.has(value)) continue;
      seen.add(value);
      const glob = combo.name.includes("*") || combo.name.includes("?");
      entries.push({
        value,
        label: "Combo · " + combo.name + (glob ? "（通配符）" : ""),
        group: "Combo",
      });
    }
    return entries;
  }

  function nativeModelEntries() {
    const entries = [];
    const seen = new Set();
    for (const model of state.models) {
      if (seen.has(model.modelId)) continue;
      seen.add(model.modelId);
      entries.push({
        value: model.modelId,
        label: model.modelId + " · " + providerName(model.providerId),
        group: providerName(model.providerId),
      });
    }
    entries.sort((a, b) => a.label.localeCompare(b.label));
    return entries;
  }

  function routeNameEntries() {
    const entries = nativeModelEntries();
    const seen = new Set(entries.map((entry) => entry.value));
    for (const alias of state.aliases) {
      if (seen.has(alias.name)) continue;
      seen.add(alias.name);
      entries.push({ value: alias.name, label: "别名 · " + alias.name });
    }
    for (const combo of state.combos) {
      if (seen.has(combo.name)) continue;
      seen.add(combo.name);
      entries.push({ value: combo.name, label: "Combo · " + combo.name, group: "Combo" });
    }
    return entries;
  }

  function diagnosticEntries() {
    const entries = activeModelEntries().map((entry) => ({
      value: entry.value,
      label: "模型 · " + entry.label,
      group: "模型",
    }));
    const seen = new Set(entries.map((entry) => entry.value));
    for (const alias of state.aliases) {
      if (alias.enabled === false || seen.has(alias.name)) continue;
      seen.add(alias.name);
      entries.push({ value: alias.name, label: "别名 · " + alias.name, group: "别名" });
    }
    for (const combo of state.combos) {
      if (combo.enabled === false || seen.has(combo.name)) continue;
      seen.add(combo.name);
      entries.push({ value: combo.name, label: "Combo · " + combo.name, group: "Combo" });
    }
    return entries;
  }

  function providerEntries() {
    return state.providers.map((provider) => ({
      value: provider.name,
      label: provider.name + (provider.enabled === false ? "（禁用）" : ""),
    }));
  }

  function mergeCurrentEntries(entries, values, prefix) {
    const merged = entries.slice();
    const seen = new Set(merged.map((entry) => String(entry.value)));
    for (const value of values) {
      const normalized = String(value);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push({ value: normalized, label: prefix + normalized });
    }
    return merged;
  }

  function optionListHtml(entries, current, placeholder, required) {
    return (
      '<option value="">' +
      esc(placeholder) +
      "</option>" +
      entries
        .map((entry) => {
          return (
            '<option value="' +
            esc(entry.value) +
            '"' +
            (String(entry.value) === String(current) ? " selected" : "") +
            ">" +
            esc(entry.label) +
            "</option>"
          );
        })
        .join("")
    );
  }

  function checkListHtml(name, entries, selectedValues, emptyText) {
    if (entries.length === 0) {
      return '<div class="empty small">' + esc(emptyText) + "</div>";
    }
    const selected = new Set(selectedValues.map((value) => String(value)));
    return (
      '<div class="check-list-block">' +
      '<input type="search" class="check-list-search" placeholder="过滤选项" aria-label="过滤选项" data-check-search="' +
      esc(name) +
      '">' +
      '<div class="check-list" data-check-list="' +
      esc(name) +
      '">' +
      entries
        .map((entry) => {
          return (
            '<label class="check-item"><input type="checkbox" name="' +
            esc(name) +
            '" value="' +
            esc(entry.value) +
            '"' +
            (selected.has(String(entry.value)) ? " checked" : "") +
            "><span>" +
            esc(entry.label) +
            "</span></label>"
          );
        })
        .join("") +
      "</div></div>"
    );
  }

  function bindCheckListSearch(root) {
    $$(".check-list-search", root).forEach((input) => {
      const list = input.parentElement && input.parentElement.querySelector(".check-list");
      if (!list) return;
      input.oninput = () => {
        const query = input.value.trim().toLowerCase();
        $$(".check-item", list).forEach((item) => {
          const text = item.textContent.toLowerCase();
          item.classList.toggle("hidden", query !== "" && !text.includes(query));
        });
      };
    });
  }

  function routeTargetJson(value) {
    return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
  }

  function routeTargetLabel(target) {
    if (!isPlainObject(target)) return String(target || "");
    if (target.model) return "模型 · " + target.model;
    if (target.alias) return "别名 · " + target.alias;
    if (target.combo) return "Combo · " + target.combo;
    if (target.wildcard) return "Combo · " + target.wildcard;
    return routeTargetJson(target);
  }

  function selectHtml(name, options, current, placeholder) {
    return (
      '<select name="' +
      esc(name) +
      '">' +
      (placeholder === undefined ? "" : '<option value="">' + esc(placeholder) + "</option>") +
      options
        .map(([value, label]) => {
          return (
            '<option value="' +
            esc(value) +
            '"' +
            (String(value) === String(current) ? " selected" : "") +
            ">" +
            esc(label) +
            "</option>"
          );
        })
        .join("") +
      "</select>"
    );
  }

  function kvRowHtml(key, value, keyPlaceholder, valuePlaceholder) {
    return (
      '<div class="kv-row" data-kv-row><input data-kv-key placeholder="' +
      esc(keyPlaceholder) +
      '" value="' +
      esc(key) +
      '"><input data-kv-value placeholder="' +
      esc(valuePlaceholder) +
      '" value="' +
      esc(value) +
      '"><button type="button" class="btn small-btn danger" data-kv-remove>删除</button></div>'
    );
  }

  function keyValueEditorHtml(fieldName, entries, keyPlaceholder, valuePlaceholder) {
    const rows = entries.length > 0 ? entries : [{ key: "", value: "" }];
    return (
      '<div class="kv-editor" data-kv-field="' +
      esc(fieldName) +
      '" data-kv-key-placeholder="' +
      esc(keyPlaceholder) +
      '" data-kv-value-placeholder="' +
      esc(valuePlaceholder) +
      '"><div class="kv-rows">' +
      rows
        .map((entry) => kvRowHtml(entry.key, entry.value, keyPlaceholder, valuePlaceholder))
        .join("") +
      '</div><button type="button" class="btn small-btn" data-kv-add>添加一项</button></div>'
    );
  }

  function readKeyValue(container) {
    const result = {};
    if (!container) return result;
    for (const row of container.querySelectorAll("[data-kv-row]")) {
      const key = row.querySelector("[data-kv-key]")?.value.trim() ?? "";
      if (key === "") continue;
      result[key] = row.querySelector("[data-kv-value]")?.value ?? "";
    }
    return result;
  }

  function bindKeyValueEditors(root) {
    for (const container of root.querySelectorAll("[data-kv-field]")) {
      const rows = container.querySelector(".kv-rows");
      const add = container.querySelector("[data-kv-add]");
      if (!rows || !add) continue;
      add.onclick = () => {
        rows.insertAdjacentHTML(
          "beforeend",
          kvRowHtml(
            "",
            "",
            container.dataset.kvKeyPlaceholder || "键",
            container.dataset.kvValuePlaceholder || "值",
          ),
        );
      };
      container.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof Element) || !target.closest("[data-kv-remove]")) return;
        const row = target.closest("[data-kv-row]");
        if (row) row.remove();
        if (!rows.querySelector("[data-kv-row]")) {
          rows.insertAdjacentHTML(
            "beforeend",
            kvRowHtml(
              "",
              "",
              container.dataset.kvKeyPlaceholder || "键",
              container.dataset.kvValuePlaceholder || "值",
            ),
          );
        }
      });
    }
  }

  const BREAKER_DEFAULTS = {
    failureThreshold: 3,
    failureRate: 0.5,
    minSamples: 5,
    windowMs: 60000,
    openMs: 30000,
    halfOpenProbes: 2,
  };

  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function providerExtraEditorHtml(extra) {
    const config = isPlainObject(extra) ? extra : {};
    const known = new Set([
      "authMode",
      "authHeader",
      "authQueryParam",
      "endpointPath",
      "anthropicVersion",
      "maxTokensField",
      "includeStreamUsage",
      "autoSyncModels",
      "breaker",
    ]);
    const customEntries = [];
    const preserved = {};
    for (const [key, value] of Object.entries(config)) {
      if (known.has(key)) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        customEntries.push({ key, value: String(value) });
      } else {
        preserved[key] = value;
      }
    }
    const authMode = typeof config.authMode === "string" && config.authMode !== "" ? config.authMode : "default";
    const maxTokensField =
      config.maxTokensField === "max_completion_tokens" ? "max_completion_tokens" : config.maxTokensField === "max_tokens" ? "max_tokens" : "";
    const tri = (value) => (value === true ? "true" : value === false ? "false" : "");
    const breaker = isPlainObject(config.breaker) ? config.breaker : null;
    const breakerValue = (key) => {
      const value = breaker ? breaker[key] : BREAKER_DEFAULTS[key];
      return typeof value === "number" && Number.isFinite(value) ? String(value) : String(BREAKER_DEFAULTS[key]);
    };

    return (
      '<div class="extra-grid" data-provider-extra data-extra-preserved="' +
      esc(JSON.stringify(preserved)) +
      '">' +
      '<label class="field"><span>认证方式</span>' +
      selectHtml(
        "extra_authMode",
        [
          ["default", "默认"],
          ["bearer", "Authorization: Bearer"],
          ["x-api-key", "x-api-key"],
          ["x-goog-api-key", "x-goog-api-key"],
          ["header", "自定义 Header"],
          ["query", "查询参数"],
          ["none", "无认证"],
        ],
        authMode,
      ) +
      "</label>" +
      '<label class="field"><span>自定义认证 Header</span><input name="extra_authHeader" value="' +
      esc(typeof config.authHeader === "string" ? config.authHeader : "") +
      '" placeholder="例如 api-key"></label>' +
      '<label class="field"><span>认证查询参数名</span><input name="extra_authQueryParam" value="' +
      esc(typeof config.authQueryParam === "string" ? config.authQueryParam : "") +
      '" placeholder="例如 key"></label>' +
      '<label class="field"><span>自定义端点路径</span><input name="extra_endpointPath" value="' +
      esc(typeof config.endpointPath === "string" ? config.endpointPath : "") +
      '" placeholder="/v1/chat/completions"></label>' +
      '<label class="field"><span>Anthropic 版本头</span><input name="extra_anthropicVersion" value="' +
      esc(typeof config.anthropicVersion === "string" ? config.anthropicVersion : "") +
      '" placeholder="2023-06-01"></label>' +
      '<label class="field"><span>最大 Token 字段</span>' +
      selectHtml(
        "extra_maxTokensField",
        [
          ["", "默认"],
          ["max_tokens", "max_tokens"],
          ["max_completion_tokens", "max_completion_tokens"],
        ],
        maxTokensField,
      ) +
      "</label>" +
      '<label class="field"><span>流式 Usage</span>' +
      selectHtml(
        "extra_includeStreamUsage",
        [["", "默认"], ["true", "启用"], ["false", "禁用"]],
        tri(config.includeStreamUsage),
      ) +
      "</label>" +
      '<label class="field"><span>定时同步模型</span>' +
      selectHtml(
        "extra_autoSyncModels",
        [["", "默认"], ["true", "启用"], ["false", "禁用"]],
        tri(config.autoSyncModels),
      ) +
      "</label>" +
      '<div class="extra-block span-2"><label class="checkbox-row"><input type="checkbox" name="extra_breaker_enabled"' +
      (breaker !== null ? " checked" : "") +
      "><span>自定义熔断参数</span></label>" +
      '<div class="form-grid">' +
      '<label class="field"><span>失败阈值</span><input name="extra_breaker_failureThreshold" type="number" min="1" value="' +
      esc(breakerValue("failureThreshold")) +
      '"></label>' +
      '<label class="field"><span>失败率阈值</span><input name="extra_breaker_failureRate" type="number" min="0" max="1" step="0.01" value="' +
      esc(breakerValue("failureRate")) +
      '"></label>' +
      '<label class="field"><span>最小样本</span><input name="extra_breaker_minSamples" type="number" min="1" value="' +
      esc(breakerValue("minSamples")) +
      '"></label>' +
      '<label class="field"><span>统计窗口 (ms)</span><input name="extra_breaker_windowMs" type="number" min="1" value="' +
      esc(breakerValue("windowMs")) +
      '"></label>' +
      '<label class="field"><span>打开时长 (ms)</span><input name="extra_breaker_openMs" type="number" min="1" value="' +
      esc(breakerValue("openMs")) +
      '"></label>' +
      '<label class="field"><span>半开探测数</span><input name="extra_breaker_halfOpenProbes" type="number" min="1" value="' +
      esc(breakerValue("halfOpenProbes")) +
      '"></label>' +
      "</div></div>" +
      '<div class="span-2"><div class="extra-subhead">其他扩展字段</div>' +
      keyValueEditorHtml("extraConfig:custom", customEntries, "键", "值") +
      (Object.keys(preserved).length > 0
        ? '<p class="hint">未展示的嵌套扩展字段会保持原值。</p>'
        : "") +
      "</div></div>"
    );
  }

  function readProviderExtra(form) {
    const container = form.querySelector("[data-provider-extra]");
    if (!container) return undefined;
    const output = {};
    try {
      Object.assign(output, JSON.parse(container.dataset.extraPreserved || "{}"));
    } catch {
      // 保留值为空时忽略。
    }
    const value = (name) => form.elements.namedItem(name)?.value ?? "";
    const authMode = value("extra_authMode");
    if (authMode !== "" && authMode !== "default") output.authMode = authMode;
    for (const [name, key] of [
      ["extra_authHeader", "authHeader"],
      ["extra_authQueryParam", "authQueryParam"],
      ["extra_endpointPath", "endpointPath"],
      ["extra_anthropicVersion", "anthropicVersion"],
    ]) {
      const current = value(name).trim();
      if (current !== "") output[key] = current;
    }
    const maxTokensField = value("extra_maxTokensField");
    if (maxTokensField !== "") output.maxTokensField = maxTokensField;
    for (const [name, key] of [
      ["extra_includeStreamUsage", "includeStreamUsage"],
      ["extra_autoSyncModels", "autoSyncModels"],
    ]) {
      const current = value(name);
      if (current === "true") output[key] = true;
      else if (current === "false") output[key] = false;
    }
    if (form.elements.namedItem("extra_breaker_enabled")?.checked === true) {
      const breaker = {};
      for (const key of [
        "failureThreshold",
        "failureRate",
        "minSamples",
        "windowMs",
        "openMs",
        "halfOpenProbes",
      ]) {
        const raw = value("extra_breaker_" + key);
        const number = Number(raw);
        if (raw !== "" && Number.isFinite(number)) breaker[key] = number;
      }
      output.breaker = breaker;
    }
    Object.assign(output, readKeyValue(container.querySelector('[data-kv-field="extraConfig:custom"]')));
    return output;
  }

  function stickyEditorHtml(sticky) {
    const value = isPlainObject(sticky) ? sticky : {};
    const enabled = value.enabled === true;
    const ttl = typeof value.ttlSeconds === "number" ? value.ttlSeconds : 300;
    const mode = value.mode === "first_available" ? "first_available" : "round_robin";
    return (
      '<div class="sticky-editor" data-sticky-editor>' +
      '<label class="checkbox-row"><input type="checkbox" name="sticky_enabled"' +
      (enabled ? " checked" : "") +
      "><span>启用会话粘性</span></label>" +
      '<div class="form-grid">' +
      '<label class="field"><span>TTL (秒)</span><input name="sticky_ttlSeconds" type="number" min="1" value="' +
      esc(ttl) +
      '"></label>' +
      '<label class="field"><span>模式</span>' +
      selectHtml(
        "sticky_mode",
        [
          ["round_robin", "轮询"],
          ["first_available", "第一个可用"],
        ],
        mode,
      ) +
      "</label>" +
      '<label class="field"><span>首条消息哈希</span><label class="checkbox-row"><input type="checkbox" name="sticky_hashFirstUserMessage"' +
      (value.hashFirstUserMessage === true ? " checked" : "") +
      "><span>允许用首条 user 消息作为会话标识</span></label></label>" +
      "</div></div>"
    );
  }

  function readSticky(form) {
    const enabled = form.elements.namedItem("sticky_enabled")?.checked === true;
    const ttl = Number(form.elements.namedItem("sticky_ttlSeconds")?.value || 300);
    const mode =
      form.elements.namedItem("sticky_mode")?.value === "first_available"
        ? "first_available"
        : "round_robin";
    return {
      enabled,
      ttlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : 300,
      mode,
      hashFirstUserMessage:
        form.elements.namedItem("sticky_hashFirstUserMessage")?.checked === true,
    };
  }

  function bindStickyEditors(root) {
    for (const editor of root.querySelectorAll("[data-sticky-editor]")) {
      const enabled = editor.querySelector('[name="sticky_enabled"]');
      if (!enabled) continue;
      const toggle = () => {
        for (const input of editor.querySelectorAll(
          '[name="sticky_ttlSeconds"], [name="sticky_mode"], [name="sticky_hashFirstUserMessage"]',
        )) {
          input.disabled = !enabled.checked;
        }
      };
      enabled.addEventListener("change", toggle);
      toggle();
    }
  }

  function comboNodeTargetValue(node) {
    if (typeof node === "string") return JSON.stringify(node);
    if (!isPlainObject(node)) return "";
    for (const key of ["model", "alias", "combo", "wildcard"]) {
      if (typeof node[key] === "string") return JSON.stringify({ [key]: node[key] });
    }
    return "";
  }

  let comboNodeSeq = 0;
  function comboNodeRowHtml(node, excludeRoute) {
    const extras = isPlainObject(node) ? node : {};
    const target = comboNodeTargetValue(node);
    const entries = mergeCurrentEntries(
      routeTargetEntries(excludeRoute),
      target === "" ? [] : [target],
      "当前目标 · ",
    );
    const value = (key) => (typeof extras[key] === "number" ? String(extras[key]) : "");
    const strategy = typeof extras.strategy === "string" ? extras.strategy : "";
    return (
      '<div class="combo-node-row" data-combo-node><div class="field"><span>目标</span>' +
      comboboxHtml("combo-target-" + ++comboNodeSeq, entries, target, {
        required: true,
        placeholder: "搜索模型/别名/Combo",
        attrs: ' data-node-target="1"',
      }) +
      "</div>" +
      '<label class="field"><span>权重</span><input data-node-weight type="number" min="1" step="1" value="' +
      esc(value("weight")) +
      '"></label>' +
      '<label class="field"><span>优先级</span><input data-node-priority type="number" min="0" step="1" value="' +
      esc(value("priority")) +
      '"></label>' +
      '<label class="field"><span>超时 (ms)</span><input data-node-timeout type="number" min="100" step="1" value="' +
      esc(value("timeoutMs")) +
      '"></label>' +
      '<label class="field"><span>重试</span><input data-node-retries type="number" min="0" step="1" value="' +
      esc(value("maxRetries")) +
      '"></label>' +
      '<label class="field"><span>策略</span><select data-node-strategy><option value="">默认</option>' +
      STRATEGIES.map(
        (item) =>
          '<option value="' + esc(item) + '"' + (item === strategy ? " selected" : "") + ">" + esc(item) + "</option>",
      ).join("") +
      "</select></label>" +
      '<button type="button" class="btn small-btn danger" data-node-remove>删除</button></div>'
    );
  }

  function comboNodesEditorHtml(nodes, excludeRoute) {
    const list = Array.isArray(nodes) && nodes.length > 0 ? nodes : [null];
    return (
      '<div class="combo-node-editor" data-combo-node-editor><div class="combo-node-list" data-combo-node-list>' +
      list.map((node) => comboNodeRowHtml(node, excludeRoute)).join("") +
      '</div><button type="button" class="btn small-btn" data-combo-node-add>添加节点</button></div>'
    );
  }

  function readComboNodes(form) {
    const nodes = [];
    for (const row of form.querySelectorAll("[data-combo-node]")) {
      const targetRaw = row.querySelector("[data-node-target]")?.value ?? "";
      if (targetRaw === "") continue;
      let target;
      try {
        target = JSON.parse(targetRaw);
      } catch {
        throw new Error("节点目标无效");
      }
      const node = {};
      if (typeof target === "string") node.model = target;
      else if (isPlainObject(target)) {
        for (const key of ["model", "alias", "combo", "wildcard"]) {
          if (typeof target[key] === "string") node[key] = target[key];
        }
      }
      if (!node.model && !node.alias && !node.combo && !node.wildcard) {
        throw new Error("节点目标无效");
      }
      for (const [selector, key] of [
        ["[data-node-weight]", "weight"],
        ["[data-node-priority]", "priority"],
        ["[data-node-timeout]", "timeoutMs"],
        ["[data-node-retries]", "maxRetries"],
      ]) {
        const input = row.querySelector(selector);
        const raw = input ? input.value.trim() : "";
        if (raw === "") continue;
        const number = Number(raw);
        if (!Number.isFinite(number)) throw new Error("节点 " + key + " 必须是数字");
        node[key] = number;
      }
      const strategy = row.querySelector("[data-node-strategy]")?.value;
      if (strategy) node.strategy = strategy;
      nodes.push(node);
    }
    if (nodes.length === 0) throw new Error("至少添加一个 Combo 节点");
    return nodes;
  }

  function bindComboNodeEditor(root, fields) {
    const field = fields.find((item) => item.type === "comboNodes");
    const excludeRoute = field ? field.excludeRoute : undefined;
    for (const editor of root.querySelectorAll("[data-combo-node-editor]")) {
      const list = editor.querySelector("[data-combo-node-list]");
      const add = editor.querySelector("[data-combo-node-add]");
      if (!list || !add) continue;
      add.onclick = () => {
        list.insertAdjacentHTML("beforeend", comboNodeRowHtml(null, excludeRoute));
        bindComboboxes(list);
      };
      editor.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof Element) || !target.closest("[data-node-remove]")) return;
        const row = target.closest("[data-combo-node]");
        if (row) row.remove();
        if (!list.querySelector("[data-combo-node]")) {
          list.insertAdjacentHTML("beforeend", comboNodeRowHtml(null, excludeRoute));
          bindComboboxes(list);
        }
      });
    }
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
    nav.innerHTML = NAV_GROUPS.map((group) => {
      const links = group.items
        .map(([key, label]) => {
          return '<a href="#/' + key + '" data-page="' + key + '">' + esc(label) + "</a>";
        })
        .join("");
      return (
        '<div class="nav-group">' +
        (group.title ? '<div class="nav-group-title">' + esc(group.title) + "</div>" : "") +
        links +
        "</div>"
      );
    }).join("");
  }

  function initNavDrawer() {
    const sidebar = $("#sidebar");
    const backdrop = $("#nav-backdrop");
    const toggle = $("#nav-toggle");
    if (!sidebar || !backdrop || !toggle) return;
    const close = () => {
      sidebar.classList.remove("open");
      backdrop.classList.add("hidden");
      toggle.setAttribute("aria-expanded", "false");
    };
    const open = () => {
      sidebar.classList.add("open");
      backdrop.classList.remove("hidden");
      toggle.setAttribute("aria-expanded", "true");
    };
    toggle.onclick = () => {
      if (sidebar.classList.contains("open")) close();
      else open();
    };
    backdrop.onclick = close;
    sidebar.addEventListener("click", (event) => {
      if (event.target.closest("a")) close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
  }

  function activePage() {
    const raw = location.hash.replace(/^#\/?/, "");
    const found = PAGES.find(([key]) => key === raw);
    return found ? found[0] : "overview";
  }

  let pendingListQuery = "";

  function goToList(page, query) {
    pendingListQuery = query || "";
    if (activePage() === page) {
      route();
    } else {
      location.hash = "#/" + page;
    }
  }

  function commandItems() {
    if (!state.token) return [];
    const items = PAGES.map(([key, label]) => ({
      group: "页面",
      label,
      description: "跳转到 " + label,
      words: (key + " " + label).toLowerCase(),
      run: () => {
        location.hash = "#/" + key;
      },
    }));
    const push = (group, label, description, words, page, query) => {
      items.push({
        group,
        label,
        description,
        words: (label + " " + (description || "") + " " + (words || "")).toLowerCase(),
        run: () => goToList(page, query),
      });
    };
    state.providers.forEach((provider) => {
      push("Provider", provider.name, provider.type, provider.id, "providers", provider.name);
    });
    state.models.forEach((model) => {
      const label = providerName(model.providerId) + " / " + model.modelId;
      push(
        "模型",
        label,
        model.modelId,
        model.upstreamModelId || "",
        "providers",
        providerName(model.providerId),
      );
    });
    state.aliases.forEach((alias) => {
      push("别名", alias.name, JSON.stringify(alias.target || ""), alias.id, "aliases", alias.name);
    });
    state.combos.forEach((combo) => {
      push("Combo", combo.name, combo.strategy, combo.id, "combos", combo.name);
    });
    state.users.forEach((user) => {
      const label = user.email || user.displayName || user.id;
      push("用户", label, user.role, user.id, "users", label);
    });
    return items;
  }

  let statusRefreshedAt = 0;

  async function refreshStatusBar() {
    if (Date.now() - statusRefreshedAt < 30000) return;
    statusRefreshedAt = Date.now();
    const configEl = $("#config-state");
    const breakerEl = $("#breaker-state");
    if (!configEl || !breakerEl) return;
    const [config, breakers] = await Promise.allSettled([
      api("/admin/config/current"),
      api("/admin/health/breakers"),
    ]);
    if (config.status === "fulfilled") {
      const data = config.value.data || config.value || {};
      const version =
        data.activeVersion === null || data.activeVersion === undefined
          ? "未发布"
          : "v" + data.activeVersion;
      configEl.textContent = "配置 " + version + (data.pendingChanges ? " · 待发布" : "");
      configEl.className = "status-chip " + (data.pendingChanges ? "warn" : "ok");
    } else {
      configEl.textContent = "配置 --";
      configEl.className = "status-chip";
    }
    if (breakers.status === "fulfilled") {
      const list = Array.isArray(breakers.value) ? breakers.value : breakers.value.data || [];
      let open = 0;
      list.forEach((provider) => {
        if (provider.providerState && provider.providerState.state !== "closed") open += 1;
        (provider.accounts || []).forEach((account) => {
          if (account.state !== "closed") open += 1;
        });
        (provider.models || []).forEach((model) => {
          if (model.state !== "closed") open += 1;
        });
      });
      breakerEl.textContent = open > 0 ? "熔断 " + open : "熔断 0";
      breakerEl.className = "status-chip " + (open > 0 ? "warn" : "ok");
    } else {
      breakerEl.textContent = "熔断 --";
      breakerEl.className = "status-chip";
    }
  }

  async function route() {
    if (!state.token) {
      showLogin();
      return;
    }
    const rawPage = location.hash.replace(/^#\/?/, "");
    if (rawPage === "models" || rawPage === "wildcards") {
      location.hash = "#/providers";
      return;
    }
    showApp();
    refreshStatusBar();
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
    bindComboboxes(body);
    bindCheckListSearch(body);
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

  function fieldValue(field, row, overrides) {
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, field.name)) {
      return overrides[field.name];
    }
    if (!row) return field.default;
    if (typeof field.get === "function") return field.get(row);
    return row[field.name];
  }

  function fieldHtml(field, row, overrides) {
    const name = "f_" + field.name;
    const value = fieldValue(field, row, overrides);
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
    if (field.type === "routeTarget") {
      const current = fieldValue(field, row, overrides);
      const currentJson =
        current === undefined || current === null || current === ""
          ? ""
          : routeTargetJson(current);
      const baseEntries = routeTargetEntries(field.excludeRoute);
      const entries =
        currentJson && !baseEntries.some((entry) => entry.value === currentJson)
          ? [{ value: currentJson, label: routeTargetLabel(current) + "（当前值）" }, ...baseEntries]
          : baseEntries;
      control = comboboxHtml(field.name, entries, currentJson, {
        required: field.required,
        label: field.label,
        placeholder: "搜索模型、别名或 Combo",
        emptyText: "暂无模型、别名或 Combo",
      });
    } else if (field.type === "modelSelect") {
      const current = fieldValue(field, row, overrides) || "";
      const entries = mergeCurrentEntries(
        allModelEntries(),
        current === "" ? [] : [current],
        "当前值 · ",
      );
      control = comboboxHtml(field.name, entries, current, {
        required: field.required,
        label: field.label,
        placeholder: "搜索模型",
        emptyText: "暂无可选模型",
      });
    } else if (field.type === "providerModelSelect") {
      const providerId = row && row.providerId ? row.providerId : state.providers[0] ? state.providers[0].id : "";
      const models = state.models.filter((model) => model.providerId === providerId);
      const current = fieldValue(field, row, overrides) || "";
      const entries = mergeCurrentEntries(
        models.map((model) => ({
          value: field.modelValue === "upstreamModelId" ? model.upstreamModelId : model.modelId,
          label:
            field.modelValue === "upstreamModelId"
              ? model.modelId + " → " + model.upstreamModelId
              : model.modelId,
        })),
        current === "" ? [] : [current],
        "当前值 · ",
      );
      control =
        '<select id="' +
        name +
        '" name="' +
        field.name +
        '"' +
        (field.required ? " required" : "") +
        ' data-provider-model="1">' +
        optionListHtml(entries, current, models.length ? "选择模型" : "该 Provider 暂无模型", field.required) +
        "</select>";
    } else if (
      field.type === "routeTargetMulti" ||
      field.type === "modelMulti" ||
      field.type === "providerMulti"
    ) {
      const current = fieldValue(field, row, overrides) || [];
      if (field.type === "routeTargetMulti") {
        const currentJson = current.map(routeTargetJson);
        control = checkListHtml(
          field.name,
          mergeCurrentEntries(routeTargetEntries(field.excludeRoute), currentJson, "当前目标 · "),
          currentJson,
          "暂无模型、别名或 Combo",
        );
      } else if (field.type === "modelMulti") {
        control = checkListHtml(
          field.name,
          mergeCurrentEntries(routeNameEntries(), current, "当前值 · "),
          current,
          "暂无模型",
        );
      } else {
        control = checkListHtml(
          field.name,
          mergeCurrentEntries(providerEntries(), current, "当前值 · "),
          current,
          "暂无 Provider",
        );
      }
    } else if (field.type === "keyValue") {
      const current = fieldValue(field, row, overrides) || {};
      const entries = isPlainObject(current)
        ? Object.entries(current).map(([key, value]) => ({ key, value: String(value) }))
        : [];
      control = keyValueEditorHtml(
        field.name,
        entries,
        field.keyPlaceholder || "键",
        field.valuePlaceholder || "值",
      );
    } else if (field.type === "providerExtra") {
      control = providerExtraEditorHtml(fieldValue(field, row, overrides) || {});
    } else if (field.type === "sticky") {
      control = stickyEditorHtml(fieldValue(field, row, overrides));
    } else if (field.type === "comboNodes") {
      const current = fieldValue(field, row, overrides) || [];
      control = comboNodesEditorHtml(current, field.excludeRoute);
    } else if (field.type === "select") {
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
    const complexField = new Set([
      "keyValue",
      "providerExtra",
      "sticky",
      "comboNodes",
      "routeTargetMulti",
      "modelMulti",
      "providerMulti",
    ]).has(field.type);
    const tag = complexField ? "div" : "label";
    return (
      "<" +
      tag +
      ' class="field' +
      span +
      '"><span>' +
      esc(field.label) +
      "</span>" +
      control +
      (field.help ? '<div class="help">' + esc(field.help) + "</div>" : "") +
      "</" +
      tag +
      ">"
    );
  }

  function formHtml(fields, row, overrides) {
    return (
      '<form id="entity-form"><div class="form-grid">' +
      fields
        .filter((field) => !(field.createOnly && row) && !(field.editOnly && !row))
        .map((field) => fieldHtml(field, row, overrides))
        .join("") +
      '</div><div class="form-actions"><button type="button" class="btn ghost" data-cancel>取消</button><button type="submit" class="btn primary">保存</button></div></form>'
    );
  }

  function readForm(form, fields, isEdit) {
    const payload = {};
    for (const field of fields) {
      if (field.createOnly && isEdit) continue;
      if (field.editOnly && !isEdit) continue;
      if (field.type === "comboNodes") {
        payload[field.name] = readComboNodes(form);
        continue;
      }
      if (field.type === "providerExtra") {
        const extra = readProviderExtra(form);
        if (extra !== undefined) payload[field.name] = extra;
        continue;
      }
      if (field.type === "sticky") {
        payload[field.name] = readSticky(form);
        continue;
      }
      if (field.type === "keyValue") {
        payload[field.name] = readKeyValue(
          form.querySelector('[data-kv-field="' + field.name + '"]'),
        );
        continue;
      }
      const element = form.elements.namedItem(field.name);
      if (!element) {
        if (field.type === "routeTargetMulti" && field.required) {
          throw new Error(field.label + " 至少选择一项");
        }
        continue;
      }
      if (field.type === "checkbox") {
        payload[field.name] = element.checked;
        continue;
      }
      if (
        field.type === "routeTargetMulti" ||
        field.type === "modelMulti" ||
        field.type === "providerMulti"
      ) {
        const inputs = Array.from(
          form.querySelectorAll('input[type="checkbox"][name="' + field.name + '"]'),
        );
        let values = inputs.filter((input) => input.checked).map((input) => input.value);
        if (field.type === "routeTargetMulti") {
          try {
            values = values.map((value) => JSON.parse(value));
          } catch {
            throw new Error(field.label + " 包含无效目标");
          }
        }
        if (field.required && values.length === 0) {
          throw new Error(field.label + " 至少选择一项");
        }
        payload[field.name] = values;
        continue;
      }
      if (field.type === "routeTarget") {
        if (element.value === "") {
          if (field.required) throw new Error(field.label + " 不能为空");
          continue;
        }
        try {
          payload[field.name] = JSON.parse(element.value);
        } catch {
          throw new Error(field.label + " 不是合法路由目标");
        }
        continue;
      }
      const value = element.value;
      if (value === "" || value === null) continue;
      if (field.type === "number") {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error(field.label + " 必须是数字");
        payload[field.name] = number;
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

  function bindProviderModelSelects(body, fields, row) {
    const providerField = fields.find(
      (field) => field.name === "providerId" && field.type === "select",
    );
    const providerSelect = providerField ? body.querySelector('[name="providerId"]') : null;
    const modelFields = fields.filter((field) => field.type === "providerModelSelect");
    if (!providerSelect || modelFields.length === 0) return;

    const update = () => {
      const providerId = providerSelect.value;
      const models = state.models.filter((model) => model.providerId === providerId);
      for (const field of modelFields) {
        const select = body.querySelector('[name="' + field.name + '"]');
        if (!select) continue;
        const current =
          row && row.providerId === providerId && row[field.name] !== undefined
            ? row[field.name]
            : "";
        const entries = mergeCurrentEntries(
          models.map((model) => ({
            value:
              field.modelValue === "upstreamModelId"
                ? model.upstreamModelId
                : model.modelId,
            label:
              field.modelValue === "upstreamModelId"
                ? model.modelId + " → " + model.upstreamModelId
                : model.modelId,
          })),
          current === "" ? [] : [current],
          "当前值 · ",
        );
        select.innerHTML = optionListHtml(
          entries,
          current,
          models.length ? "选择模型" : "该 Provider 暂无模型",
          field.required,
        );
      }
    };

    providerSelect.addEventListener("change", update);
    update();
  }

  function entityNeedsRouteLookups(entity) {
    const types = new Set([
      "routeTarget",
      "routeTargetMulti",
      "modelSelect",
      "providerModelSelect",
      "modelMulti",
      "providerMulti",
      "comboNodes",
    ]);
    return entity.fields.some((field) => types.has(field.type));
  }

  async function openEntityForm(entity, row, overrides) {
    await ensureLookups();
    if (entityNeedsRouteLookups(entity)) {
      await ensureRouteLookups();
    }
    const fields = entity.fields.map((field) => {
      let excludeRoute;
      if (entity.endpoint === "/admin/aliases" && field.name === "target" && row) {
        excludeRoute = { aliasId: row.id, aliasName: row.name };
      } else if (entity.endpoint === "/admin/combos" && field.name === "nodes" && row) {
        excludeRoute = { comboId: row.id, comboName: row.name };
      }
      return excludeRoute === undefined ? field : { ...field, excludeRoute };
    });
    const body = modal(
      entity.title + (row ? " · 编辑" : " · 新建"),
      formHtml(fields, row || null, overrides || null),
    );
    bindProviderModelSelects(body, fields, row);
    bindKeyValueEditors(body);
    bindStickyEditors(body);
    bindComboNodeEditor(body, fields);
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
        state.providers = [];
        state.users = [];
        state.routeLookupsLoaded = false;
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
      state.providers = [];
      state.users = [];
      state.routeLookupsLoaded = false;
      await route();
    } catch (error) {
      notify(error.message, "bad");
    }
  }

  function emptyStateHtml(state) {
    return (
      '<div class="table-wrap"><div class="empty-state"><h4>' +
      esc(state.title || "暂无数据") +
      "</h4>" +
      (state.text ? "<p>" + esc(state.text) + "</p>" : "") +
      (state.actionLabel ? '<button class="btn primary" data-empty-action>' + esc(state.actionLabel) + "</button>" : "") +
      "</div></div>"
    );
  }

  function rowSearchText(entity, row) {
    const parts = [JSON.stringify(row)];
    for (const column of entity.columns || []) {
      if (typeof column.searchValue === "function") {
        const value = column.searchValue(row);
        if (value !== undefined && value !== null) parts.push(String(value));
        continue;
      }
      if (!column.key) continue;
      const raw = row[column.key];
      if (raw !== undefined && raw !== null) parts.push(String(raw));
    }
    parts.push(String(row.id || ""));
    return parts.join(" ").toLowerCase();
  }

  function compareValues(a, b) {
    if (a === undefined || a === null) return 1;
    if (b === undefined || b === null) return -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b));
  }

  function tableHtml(entity, rows, options) {
    const opts = options || {};
    if (!rows.length) {
      if (opts.emptyState) return emptyStateHtml(opts.emptyState);
      return '<div class="table-wrap"><div class="empty">暂无数据</div></div>';
    }
    const sort = opts.sort || null;
    const head =
      "<tr>" +
      entity.columns
        .map((column) => {
          const sortable = Boolean(column.key);
          const active = sort && sort.key === column.key;
          const indicator = active
            ? '<span class="sort-indicator">' + (sort.dir > 0 ? "▲" : "▼") + "</span>"
            : "";
          return (
            "<th" +
            (sortable
              ? ' class="sortable" tabindex="0" data-sort-key="' +
                esc(column.key) +
                '"' +
                (active
                  ? ' aria-sort="' + (sort.dir > 0 ? "ascending" : "descending") + '"'
                  : "")
              : "") +
            ">" +
            esc(column.label) +
            indicator +
            "</th>"
          );
        })
        .join("") +
      "<th>操作</th></tr>";
    const body = rows
      .map((row) => {
        const cells = entity.columns
          .map((column) => {
            let value;
            if (typeof column.render === "function") value = column.render(row);
            else value = esc(row[column.key] === undefined ? "-" : row[column.key]);
            const classes = [column.mono ? "mono" : "", column.nowrap ? "nowrap" : ""]
              .filter(Boolean)
              .join(" ");
            return "<td" + (classes ? ' class="' + classes + '"' : "") + ">" + value + "</td>";
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
          '<td class="cell-actions"><div class="row-actions"><button class="btn small-btn" data-action="edit" data-id="' +
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

  function paginationHtml(state, total, totalPages) {
    if (total === 0) return "";
    return (
      '<div class="pagination">' +
      '<button class="btn small-btn" data-page-prev' +
      (state.page <= 1 ? " disabled" : "") +
      ">上一页</button>" +
      "<span>" +
      state.page +
      " / " +
      totalPages +
      " · 共 " +
      total +
      " 条</span>" +
      '<button class="btn small-btn" data-page-next' +
      (state.page >= totalPages ? " disabled" : "") +
      ">下一页</button></div>"
    );
  }

  function bindListControls(body, state, render) {
    $$("th[data-sort-key]", body).forEach((th) => {
      const activate = () => {
        const key = th.dataset.sortKey;
        if (state.sortKey === key) {
          state.sortDir = -state.sortDir;
        } else {
          state.sortKey = key;
          state.sortDir = 1;
        }
        state.page = 1;
        render();
      };
      th.onclick = activate;
      th.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      };
    });
    const prev = $("[data-page-prev]", body);
    if (prev) {
      prev.onclick = () => {
        if (state.page > 1) {
          state.page -= 1;
          render();
        }
      };
    }
    const next = $("[data-page-next]", body);
    if (next) {
      next.onclick = () => {
        state.page += 1;
        render();
      };
    }
  }

  function healthRow(name, state, failures, windowFailures, windowTotal) {
    const ok = state === "closed";
    return (
      '<div class="health-row"><span class="trace-status ' +
      (ok ? "ok" : "bad") +
      '"></span><span class="health-name mono">' +
      esc(name || "-") +
      '</span><span class="badge ' +
      (ok ? "ok" : "bad") +
      '">' +
      esc(state || "-") +
      '</span><span class="health-meta">连续失败 ' +
      esc(failures === undefined ? 0 : failures) +
      " · 窗口 " +
      esc(windowFailures === undefined ? 0 : windowFailures) +
      "/" +
      esc(windowTotal === undefined ? 0 : windowTotal) +
      "</span></div>"
    );
  }

  function renderProviderHealth(provider) {
    const state = provider.providerState || {};
    const accounts = Array.isArray(provider.accounts) ? provider.accounts : [];
    const models = Array.isArray(provider.models) ? provider.models : [];
    return (
      '<div class="trace-section"><h4>Provider</h4><div class="health-list">' +
      healthRow(
        provider.providerName || state.name || provider.providerId,
        state.state,
        state.consecutiveFailures,
        state.windowFailures,
        state.windowTotal,
      ) +
      "</div></div>" +
      '<div class="trace-section"><h4>账户 · ' +
      accounts.length +
      "</h4>" +
      (accounts.length
        ? '<div class="health-list">' +
          accounts
            .map((account) =>
              healthRow(
                account.name || account.id,
                account.state,
                account.consecutiveFailures,
                account.windowFailures,
                account.windowTotal,
              ),
            )
            .join("") +
          "</div>"
        : '<p class="hint">暂无账户。</p>') +
      "</div>" +
      '<div class="trace-section"><h4>模型 · ' +
      models.length +
      "</h4>" +
      (models.length
        ? '<div class="health-list">' +
          models
            .map((model) =>
              healthRow(
                model.name || model.id,
                model.state,
                model.consecutiveFailures,
                model.windowFailures,
                model.windowTotal,
              ),
            )
            .join("") +
          "</div>"
        : '<p class="hint">暂无模型。</p>') +
      "</div>"
    );
  }

  async function openProviderHealth(row) {
    try {
      const response = await api("/admin/health/breakers");
      const list = unwrapData(response) || [];
      const provider = list.find((item) => item.providerId === row.id);
      if (!provider) {
        modal("Provider 健康 · " + row.name, '<p class="hint">健康数据中未找到该 Provider。</p>');
        return;
      }
      modal("Provider 健康 · " + row.name, renderProviderHealth(provider));
    } catch (error) {
      notify(error.message, "bad");
    }
  }

  function todayUtc() {
    return new Date().toISOString().slice(0, 10);
  }

  function monthStartUtc() {
    return todayUtc().slice(0, 7) + "-01";
  }

  function budgetCard(label, spent, budget, failed) {
    if (failed) {
      return (
        '<div class="card"><h3>' + esc(label) + '</h3><p class="error-text">用量不可用。</p></div>'
      );
    }
    if (!budget) {
      return (
        '<div class="card"><h3>' +
        esc(label) +
        '</h3><div class="metric">' +
        fmtUsd(spent) +
        '</div><p class="hint">未设置预算。</p></div>'
      );
    }
    const percent = budget > 0 ? (spent / budget) * 100 : 0;
    const over = percent > 100;
    return (
      '<div class="card"><h3>' +
      esc(label) +
      '</h3><div class="metric">' +
      fmtUsd(spent) +
      " <small>上限 " +
      fmtUsd(budget) +
      '</small></div><div class="bar-track budget-track"><div class="bar-fill' +
      (over ? " over" : "") +
      '" style="width:' +
      Math.min(100, percent).toFixed(1) +
      '%"></div></div><p class="hint' +
      (over ? " error-text" : "") +
      '">' +
      percent.toFixed(1) +
      "% · 剩余 " +
      fmtUsd(Math.max(0, budget - spent)) +
      "</p></div>"
    );
  }

  async function openBudgetDetail(options) {
    const today = todayUtc();
    const monthStart = monthStartUtc();
    const query = (from, to) => {
      const params = ["from=" + from, "to=" + to, "groupBy=day"];
      if (options.userId) params.push("userId=" + encodeURIComponent(options.userId));
      if (options.apiKeyId) params.push("apiKeyId=" + encodeURIComponent(options.apiKeyId));
      return "/admin/usage/summary?" + params.join("&");
    };
    const [todayResult, monthResult] = await Promise.allSettled([
      api(query(today, today)),
      api(query(monthStart, today)),
    ]);
    const spentOf = (result) => {
      if (result.status !== "fulfilled") return null;
      const data = unwrapData(result.value) || {};
      return (data.totals || {}).costUsd || 0;
    };
    const todaySpent = spentOf(todayResult);
    const monthSpent = spentOf(monthResult);
    modal(
      options.title || "预算",
      '<div class="grid cols-2">' +
        budgetCard("今日", todaySpent || 0, options.dailyBudgetUsd, todaySpent === null) +
        budgetCard("本月", monthSpent || 0, options.monthlyBudgetUsd, monthSpent === null) +
        "</div>" +
        '<p class="hint">用量按 UTC 日统计；预算为只读展示。</p>',
    );
  }

  function crudPage(entity) {
    return async (root) => {
      await ensureLookups();
      const response = await api(entity.endpoint);
      const rows = response.data || [];
      const listState = { query: "", sortKey: null, sortDir: 1, page: 1, pageSize: 20 };

      const filteredRows = () => {
        let list = rows;
        const query = listState.query.trim().toLowerCase();
        if (query) {
          list = list.filter((row) => rowSearchText(entity, row).includes(query));
        }
        if (listState.sortKey) {
          const key = listState.sortKey;
          const dir = listState.sortDir;
          list = list.slice().sort((a, b) => compareValues(a[key], b[key]) * dir);
        }
        return list;
      };

      const renderList = () => {
        const list = filteredRows();
        const totalPages = Math.max(1, Math.ceil(list.length / listState.pageSize));
        if (listState.page > totalPages) listState.page = totalPages;
        const start = (listState.page - 1) * listState.pageSize;
        const pageRows = list.slice(start, start + listState.pageSize);
        const body = $("#list-body", root);
        body.innerHTML =
          tableHtml(entity, pageRows, {
            sort: listState.sortKey ? { key: listState.sortKey, dir: listState.sortDir } : null,
            emptyState:
              list.length === 0
                ? listState.query.trim()
                  ? { title: "没有匹配的记录", text: "调整搜索条件后重试。" }
                  : entity.empty || { title: "暂无数据" }
                : null,
          }) +
          paginationHtml(listState, list.length, totalPages);
        const meta = $("#list-meta", root);
        if (meta) meta.textContent = list.length + " 条";
        $$("[data-action]", body).forEach((button) => {
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
        $$("th[data-sort-key]", body).forEach((th) => {
          const activate = () => {
            const key = th.dataset.sortKey;
            if (listState.sortKey === key) {
              listState.sortDir = -listState.sortDir;
            } else {
              listState.sortKey = key;
              listState.sortDir = 1;
            }
            listState.page = 1;
            renderList();
          };
          th.onclick = activate;
          th.onkeydown = (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              activate();
            }
          };
        });
        const prev = $("[data-page-prev]", body);
        if (prev) {
          prev.onclick = () => {
            if (listState.page > 1) {
              listState.page -= 1;
              renderList();
            }
          };
        }
        const next = $("[data-page-next]", body);
        if (next) {
          next.onclick = () => {
            listState.page += 1;
            renderList();
          };
        }
        const emptyAction = $("[data-empty-action]", body);
        if (emptyAction) {
          emptyAction.onclick = () => {
            if (entity.empty && entity.empty.action === "preset" && entity.presetPicker) {
              openProviderPresetPicker();
            } else {
              openEntityForm(entity, null);
            }
          };
        }
      };

      const showToolbar = rows.length > 0;
      root.innerHTML =
        '<div class="section-head"><h2>' +
        esc(entity.title) +
        '</h2><div class="actions">' +
        (entity.presetPicker ? '<button class="btn" data-from-preset>从预设添加</button>' : "") +
        '<button class="btn primary" data-new>新建</button></div></div>' +
        (entity.note ? '<p class="hint">' + esc(entity.note) + "</p>" : "") +
        (showToolbar
          ? '<div class="table-toolbar">' +
            '<input type="search" id="list-search" placeholder="搜索 ' +
            esc(entity.title) +
            '" aria-label="搜索">' +
            '<span class="spacer"></span>' +
            '<span class="table-meta" id="list-meta"></span>' +
            '<select id="list-page-size" aria-label="每页条数"><option value="20">20 条/页</option><option value="50">50 条/页</option></select>' +
            "</div>"
          : "") +
        '<div id="list-body"></div>';

      $("[data-new]", root).onclick = () => openEntityForm(entity, null);
      if (entity.presetPicker) {
        $("[data-from-preset]", root).onclick = openProviderPresetPicker;
      }
      if (showToolbar) {
        $("#list-search", root).oninput = () => {
          listState.query = $("#list-search", root).value;
          listState.page = 1;
          renderList();
        };
        $("#list-page-size", root).onchange = () => {
          listState.pageSize = Number($("#list-page-size", root).value) || 20;
          listState.page = 1;
          renderList();
        };
      }
      if (pendingListQuery) {
        listState.query = pendingListQuery;
        pendingListQuery = "";
        const search = $("#list-search", root);
        if (search) search.value = listState.query;
      }
      renderList();
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
      label: "自定义请求头",
      type: "keyValue",
      span: 2,
      keyPlaceholder: "Header 名称",
      valuePlaceholder: "Header 值",
      help: "禁止设置 authorization、x-api-key 等受保护头部。",
    },
    {
      name: "extraConfig",
      label: "扩展配置",
      type: "providerExtra",
      span: 2,
      help: "认证方式、端点路径、熔断器和其他扩展参数。",
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
      label: "目标",
      type: "routeTarget",
      required: true,
      span: 2,
      help: "从下拉选择模型、别名或 Combo；模型使用 provider/model 形式。名称含 * 或 ? 的 Combo 按通配符匹配。",
    },
    { name: "enabled", label: "启用", type: "checkbox", default: true },
    { name: "priority", label: "优先级", type: "number", default: 100 },
    { name: "description", label: "说明", span: 2 },
  ];

  const pricingFields = [
    { name: "providerId", label: "Provider", type: "select", optionsFrom: "providers", required: true },
    {
      name: "modelId",
      label: "上游模型 ID",
      type: "providerModelSelect",
      modelValue: "upstreamModelId",
      required: true,
      help: "从当前 Provider 的模型中选择；没有模型时请先同步或创建模型。",
    },
    { name: "inputPrice", label: "输入价格 / 1M", type: "number", step: "0.000001", required: true },
    { name: "outputPrice", label: "输出价格 / 1M", type: "number", step: "0.000001", required: true },
    { name: "cachedInputPrice", label: "缓存输入价格", type: "number", step: "0.000001" },
    { name: "reasoningPrice", label: "推理输出价格", type: "number", step: "0.000001" },
    { name: "currency", label: "币种", default: "USD" },
    { name: "effectiveFrom", label: "生效时间", type: "datetime" },
  ];

  const comboFields = [
    {
      name: "name",
      label: "名称",
      required: true,
      help: "名称含 * 或 ? 时按通配符匹配（如 gpt-*）；否则精确匹配。",
    },
    { name: "strategy", label: "策略", type: "select", options: STRATEGIES, default: "fallback" },
    {
      name: "priority",
      label: "优先级",
      type: "number",
      default: 100,
      help: "通配符 Combo 按优先级从高到低匹配；精确 Combo 优先于所有通配符。",
    },
    {
      name: "judgeModel",
      label: "Judge Model",
      type: "modelSelect",
      help: "fusion 策略必填；从已启用模型中选择，使用 provider/model 形式。",
    },
    {
      name: "nodes",
      label: "节点",
      type: "comboNodes",
      required: true,
      span: 2,
      rows: 8,
      default: [],
      help: "选择目标并设置权重/优先级/超时/重试/策略。未启用模型会标记，使用前请在 Provider 的「模型」操作中启用。",
    },
    { name: "timeoutMs", label: "整体超时 (ms)", type: "number" },
    { name: "maxConcurrency", label: "最大并发", type: "number", min: 1 },
    {
      name: "sticky",
      label: "会话粘性",
      type: "sticky",
      span: 2,
      help: "启用后，同一会话优先保持在上一次命中的节点。",
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
      presetPicker: true,
      empty: {
        title: "还没有 Provider",
        text: "从预设添加常见厂商，或手动新建一个兼容端点。添加后还需要账户与模型。",
        action: "preset",
        actionLabel: "从预设添加",
      },
      note: "可以手工新建，也可以从预设添加。添加 Provider 后还需要账户、模型并发布配置。",
      columns: [
        { label: "名称", key: "name", nowrap: true },
        { label: "类型", key: "type", mono: true, nowrap: true },
        { label: "协议", key: "protocol", mono: true, nowrap: true },
        { label: "Base URL", render: (row) => '<span class="mono tight" title="' + esc(row.baseUrl) + '">' + esc(row.baseUrl) + "</span>" },
        enabledColumn(),
        { label: "账户", nowrap: true, render: (row) => esc((row.enabledAccountCount || 0) + " / " + (row.accountCount || 0)) },
        { label: "优先级", key: "priority" },
      ],
      actions: [
        {
          key: "health",
          label: "健康",
          run: (row) => openProviderHealth(row),
        },
        {
          key: "setup",
          label: "设置",
          run: (row) => openProviderSetup(row),
        },
        {
          key: "models",
          label: "模型",
          run: (row) => openProviderModels(row),
        },
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
      empty: {
        title: "还没有模型",
        text: "先在 Provider 页同步上游模型，或手动添加模型。同步结果默认禁用，需要确认能力后启用。",
        action: "new",
        actionLabel: "新建模型",
      },
      columns: [
        { label: "模型 ID", key: "modelId", mono: true },
        {
          label: "Provider",
          render: (row) => esc(providerName(row.providerId)),
          searchValue: (row) => providerName(row.providerId),
        },
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
      actions: [
        {
          key: "toggle",
          label: "启用/停用",
          run: async (row) => {
            try {
              await api("/admin/models/" + row.id, {
                method: "PUT",
                body: { enabled: row.enabled !== true },
              });
              notify(row.enabled ? "模型已停用" : "模型已启用", "ok");
              await route();
            } catch (error) {
              notify(error.message, "bad");
            }
          },
        },
      ],
    },
    aliases: {
      title: "别名",
      endpoint: "/admin/aliases",
      fields: aliasFields,
      empty: {
        title: "还没有别名",
        text: "为常用模型创建稳定别名，客户端可以忽略上游模型改名。",
        action: "new",
        actionLabel: "新建别名",
      },
      columns: [
        { label: "别名", key: "name", mono: true },
        { label: "目标", render: (row) => '<span class="mono">' + esc(JSON.stringify(row.target)) + "</span>" },
        enabledColumn(),
        { label: "优先级", key: "priority" },
      ],
    },
    combos: {
      title: "Combo",
      endpoint: "/admin/combos",
      fields: comboFields,
      empty: {
        title: "还没有 Combo",
        text: "Combo 把多个模型组合成一个逻辑模型，支持故障转移、轮询、竞速等策略。",
        action: "new",
        actionLabel: "新建 Combo",
      },
      columns: [
        { label: "名称", key: "name", mono: true },
        {
          label: "匹配",
          render: (row) => {
            const name = String(row.name || "");
            const glob = name.includes("*") || name.includes("?");
            return glob ? '<span class="badge warn">通配符</span>' : '<span class="badge">精确</span>';
          },
        },
        { label: "策略", key: "strategy", mono: true },
        { label: "节点数", render: (row) => esc((row.nodes || []).length) },
        { label: "Judge", render: (row) => esc(row.judgeModel || "-") },
        { label: "优先级", key: "priority", nowrap: true },
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
      empty: {
        title: "还没有价格配置",
        text: "为模型配置输入/输出价格后，用量页才能计算费用。",
        action: "new",
        actionLabel: "新建价格",
      },
      columns: [
        {
          label: "Provider",
          render: (row) => esc(providerName(row.providerId)),
          searchValue: (row) => providerName(row.providerId),
        },
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
      empty: {
        title: "还没有用户",
        text: "创建用户后即可为其签发下游 API Key，并设置模型权限与限流。",
        action: "new",
        actionLabel: "新建用户",
      },
      columns: [
        {
          label: "邮箱 / 名称",
          render: (row) => esc(row.email || row.displayName || row.id),
          searchValue: (row) => [row.email, row.displayName].filter(Boolean).join(" "),
        },
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
      actions: [
        {
          key: "budget",
          label: "预算",
          run: (row) =>
            openBudgetDetail({
              title: "用户预算 · " + (row.email || row.displayName || row.id),
              userId: row.id,
              dailyBudgetUsd: row.dailyBudgetUsd,
              monthlyBudgetUsd: row.monthlyBudgetUsd,
            }),
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
        await route();
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
          await route();
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
          await route();
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
          await route();
          await openAccounts(provider);
        } catch (error) {
          notify(error.message, "bad");
        }
      };
    });
  }

  // ---------------------------------------------------------------------
  // Provider 预设、设置面板与模型
  // ---------------------------------------------------------------------

  async function openProviderPresetPicker() {
    let presets = [];
    try {
      const response = await api("/admin/provider-presets");
      presets = response.data || [];
    } catch (error) {
      notify(error.message, "bad");
      return;
    }
    const body = modal(
      "从预设添加 Provider",
      '<div class="preset-toolbar"><input id="preset-search" placeholder="搜索 Provider 名称或说明"></div>' +
        '<div id="preset-list" class="preset-list"></div>',
    );
    const list = $("#preset-list", body);
    const render = () => {
      const query = ($("#preset-search", body).value || "").trim().toLowerCase();
      const filtered = presets.filter((preset) => {
        if (!query) return true;
        return (
          String(preset.label || "").toLowerCase().includes(query) ||
          String(preset.description || "").toLowerCase().includes(query) ||
          String(preset.id || "").toLowerCase().includes(query)
        );
      });
      if (!filtered.length) {
        list.innerHTML = '<div class="empty">没有匹配的预设</div>';
        return;
      }
      list.innerHTML = filtered
        .map((preset) => {
          return (
            '<div class="preset-item"><div class="preset-copy"><h3>' +
            esc(preset.label) +
            "</h3><p>" +
            esc(preset.description) +
            '</p><div class="mono tight">' +
            esc(preset.type + " · " + preset.protocol + " · " + (preset.baseUrl || "自定义 Base URL")) +
            "</div>" +
            (preset.notes ? '<div class="help">' + esc(preset.notes) + "</div>" : "") +
            (preset.docsUrl
              ? '<div class="help"><a href="' +
                esc(preset.docsUrl) +
                '" target="_blank" rel="noopener noreferrer">厂商文档</a></div>'
              : "") +
            '</div><button class="btn primary small-btn" data-preset="' +
            esc(preset.id) +
            '">使用</button></div>'
          );
        })
        .join("");
      $$("[data-preset]", list).forEach((button) => {
        button.onclick = () => {
          const preset = presets.find((item) => item.id === button.dataset.preset);
          if (!preset) return;
          closeModal();
          openEntityForm(entities.providers, null, {
            name: preset.suggestedName,
            type: preset.type,
            protocol: preset.protocol,
            baseUrl: preset.baseUrl,
            extraConfig: preset.extraConfig || {},
            enabled: true,
          });
        };
      });
    };
    $("#preset-search", body).oninput = render;
    render();
  }

  async function openProviderSetup(provider) {
    let detail;
    try {
      const response = await api("/admin/providers/" + provider.id);
      detail = response.data;
    } catch (error) {
      notify(error.message, "bad");
      return;
    }
    const accounts = detail.accounts || [];
    const models = detail.models || [];
    const enabledModels = models.filter((model) => model.enabled).length;
    const body = modal(
      "设置 · " + provider.name,
      '<div class="grid cols-3">' +
        '<div class="card"><h3>账户</h3><div class="metric">' +
        esc(accounts.length) +
        " <small>个</small></div></div>" +
        '<div class="card"><h3>模型</h3><div class="metric">' +
        esc(models.length) +
        " <small>个 / 启用 " +
        esc(enabledModels) +
        "</small></div></div>" +
        '<div class="card"><h3>凭据</h3><div class="metric" style="font-size:16px">' +
        esc(accounts.length > 0 ? "已配置" : "未配置") +
        "</div></div>" +
        "</div>" +
        (accounts.length === 0
          ? '<div class="callout warn"><strong>先添加账户</strong><p>Provider 没有账户时无法同步模型或发起请求。建议使用 Worker Secret 引用，避免在页面保存明文密钥。</p></div>'
          : "") +
        (models.length === 0
          ? '<div class="callout warn"><strong>还没有模型</strong><p>同步上游模型或手动添加模型；同步结果默认禁用，能力必须人工确认。</p></div>'
          : "") +
        '<div class="form-actions">' +
        '<button class="btn" id="setup-accounts">管理账户</button>' +
        '<button class="btn" id="setup-sync">同步模型</button>' +
        '<button class="btn" id="setup-models">查看模型</button>' +
        '<button class="btn" id="setup-test">模型列表测试</button>' +
        '<button class="btn" id="setup-chat-test">Chat 自测</button>' +
        '<button class="btn primary" id="setup-publish">去发布配置</button>' +
        "</div>" +
        '<p class="hint">完成账户和模型后，请在「配置与审计」发布配置版本；未发布时推理入口会回退到 D1 草稿。</p>',
    );
    $("#setup-accounts", body).onclick = () => {
      closeModal();
      openAccounts(provider);
    };
    $("#setup-sync", body).onclick = async () => {
      if (!confirm("从上游同步模型？同步结果默认禁用，需要人工确认能力。")) return;
      try {
        const result = await api("/admin/providers/" + provider.id + "/sync-models", {
          method: "POST",
        });
        notify("同步完成：新增 " + result.created + "，跳过 " + result.skipped, "ok");
        state.routeLookupsLoaded = false;
        closeModal();
        await route();
      } catch (error) {
        notify(error.message, "bad");
      }
    };
    $("#setup-models", body).onclick = () => openProviderModels(provider);
    $("#setup-test", body).onclick = async () => {
      try {
        const result = await api("/admin/providers/" + provider.id + "/test", { method: "POST" });
        modal(
          "Provider 模型列表测试 · " + provider.name,
          '<pre class="mono">' + esc(JSON.stringify(result, null, 2)) + "</pre>",
        );
      } catch (error) {
        notify(error.message, "bad");
      }
    };
    $("#setup-chat-test", body).onclick = async () => {
      const enabled = models.filter((model) => model.enabled);
      const fallback = enabled[0] || models[0];
      const modelId = prompt(
        "输入模型 ID 做 Chat 自测（会产生真实上游费用）",
        fallback ? fallback.modelId : "",
      );
      if (!modelId) return;
      if (!confirm("Chat 自测会发起真实上游请求并可能产生费用，继续？")) return;
      try {
        const result = await api("/admin/gateway/test", {
          method: "POST",
          body: {
            model: provider.name + "/" + modelId,
            prompt: "Reply with OK.",
            maxOutputTokens: 16,
          },
        });
        modal(
          "Chat 自测 · " + provider.name,
          '<pre class="mono">' + esc(JSON.stringify(result, null, 2)) + "</pre>",
        );
      } catch (error) {
        notify(error.message, "bad");
      }
    };
    $("#setup-publish", body).onclick = () => {
      closeModal();
      location.hash = "#/config";
    };
  }

  async function openProviderModels(provider) {
    let models = [];
    try {
      const response = await api("/admin/models?providerId=" + encodeURIComponent(provider.id));
      models = response.data || [];
    } catch (error) {
      notify(error.message, "bad");
      return;
    }
    const rows = models.length
      ? models
          .map((model) => {
            const capabilities = model.capabilities || {};
            const flags = [];
            if (capabilities.supportsStream) flags.push("stream");
            if (capabilities.supportsTools) flags.push("tools");
            if (capabilities.supportsVision) flags.push("vision");
            if (capabilities.supportsReasoning) flags.push("reasoning");
            return (
              '<tr><td class="mono">' +
              esc(model.modelId) +
              '</td><td class="mono">' +
              esc(model.upstreamModelId) +
              "</td><td>" +
              badge(model.enabled) +
              '</td><td class="mono">' +
              esc(flags.join(", ") || "-") +
              '</td><td><div class="row-actions">' +
              '<button class="btn small-btn" data-model-edit="' +
              esc(model.id) +
              '">编辑并确认能力</button>' +
              '<button class="btn small-btn" data-model-toggle="' +
              esc(model.id) +
              '">' +
              (model.enabled ? "停用" : "启用") +
              "</button></div></td></tr>"
            );
          })
          .join("")
      : '<tr><td colspan="5" class="empty">暂无模型</td></tr>';
    const body = modal(
      "模型 · " + provider.name,
      '<p class="hint">同步模型的初始能力全部为 false，必须编辑确认后再启用。这里不会按模型名称猜测能力。</p>' +
        '<div class="table-wrap"><table><thead><tr><th>模型 ID</th><th>上游模型</th><th>状态</th><th>能力</th><th>操作</th></tr></thead><tbody>' +
        rows +
        "</tbody></table></div>" +
        '<div class="form-actions"><button class="btn" id="models-sync">同步模型</button><button class="btn primary" id="models-add">手动添加模型</button></div>',
    );
    $$("[data-model-edit]", body).forEach((button) => {
      button.onclick = () => {
        const model = models.find((item) => item.id === button.dataset.modelEdit);
        if (model) openEntityForm(entities.models, model);
      };
    });
    $$("[data-model-toggle]", body).forEach((button) => {
      button.onclick = async () => {
        const model = models.find((item) => item.id === button.dataset.modelToggle);
        if (!model) return;
        if (!model.enabled && !confirm("启用该模型？请确认已经在编辑表单中确认能力。")) return;
        try {
          await api("/admin/models/" + model.id, {
            method: "PUT",
            body: { enabled: model.enabled !== true },
          });
          state.routeLookupsLoaded = false;
          closeModal();
          await route();
          await openProviderModels(provider);
        } catch (error) {
          notify(error.message, "bad");
        }
      };
    });
    $("#models-sync", body).onclick = async () => {
      if (!confirm("从上游同步模型？同步结果默认禁用，需要人工确认能力。")) return;
      try {
        const result = await api("/admin/providers/" + provider.id + "/sync-models", {
          method: "POST",
        });
        notify("同步完成：新增 " + result.created + "，跳过 " + result.skipped, "ok");
        state.routeLookupsLoaded = false;
        closeModal();
        await route();
        await openProviderModels(provider);
      } catch (error) {
        notify(error.message, "bad");
      }
    };
    $("#models-add", body).onclick = () => {
      closeModal();
      openEntityForm(entities.models, null, {
        providerId: provider.id,
        supportsStream: true,
        enabled: true,
      });
    };
  }

  // ---------------------------------------------------------------------
  // API Key 页面
  // ---------------------------------------------------------------------

  const keyFields = [
    { name: "userId", label: "用户", type: "select", optionsFrom: "users", required: true, createOnly: true },
    { name: "name", label: "名称", required: true },
    { name: "scopes", label: "Scopes", type: "csv", default: ["inference"] },
    {
      name: "modelAllowlist",
      label: "模型白名单",
      type: "modelMulti",
      span: 2,
      help: "不选择表示不限制；可选择原生模型 ID、别名或 Combo。",
    },
    {
      name: "providerAllowlist",
      label: "Provider 白名单",
      type: "providerMulti",
      span: 2,
      help: "不选择表示不限制；只能访问所选 Provider。",
    },
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
      await ensureRouteLookups();
      const response = await api("/admin/api-keys");
      const rows = response.data || [];
      const listState = { query: "", sortKey: null, sortDir: 1, page: 1, pageSize: 20 };

      const limitText = (key) => {
        const limits = [];
        if (key.rpmLimit) limits.push("RPM " + key.rpmLimit);
        if (key.tpmLimit) limits.push("TPM " + key.tpmLimit);
        if (key.concurrencyLimit) limits.push("并发 " + key.concurrencyLimit);
        if (key.dailyBudgetUsd) limits.push("日预算 " + fmtUsd(key.dailyBudgetUsd));
        if (key.monthlyBudgetUsd) limits.push("月预算 " + fmtUsd(key.monthlyBudgetUsd));
        return limits.join(" · ") || "-";
      };

      const entity = {
        title: "API Key",
        endpoint: "/admin/api-keys",
        fields: keyFields,
        columns: [
          { label: "名称", key: "name", mono: true },
          { label: "前缀", key: "keyPrefix", mono: true, nowrap: true },
          {
            label: "用户",
            render: (row) => esc(userName(row.userId)),
            searchValue: (row) => userName(row.userId),
          },
          { label: "状态", render: (row) => badge(row.status === "active", row.status) },
          { label: "Scopes", render: (row) => esc((row.scopes || []).join(", ")) },
          { label: "限制", render: (row) => esc(limitText(row)) },
          {
            label: "过期",
            key: "expiresAt",
            render: (row) => esc(row.expiresAt ? fmtTime(row.expiresAt) : "-"),
          },
          {
            label: "最近使用",
            key: "lastUsedAt",
            render: (row) => esc(row.lastUsedAt ? fmtTime(row.lastUsedAt) : "-"),
          },
        ],
        actions: [
          { key: "rotate", label: "轮换", run: (row) => rotateKey(row) },
          {
            key: "budget",
            label: "预算",
            run: (row) =>
              openBudgetDetail({
                title: "API Key 预算 · " + row.name,
                apiKeyId: row.id,
                dailyBudgetUsd: row.dailyBudgetUsd,
                monthlyBudgetUsd: row.monthlyBudgetUsd,
              }),
          },
        ],
        empty: {
          title: "还没有 API Key",
          text: "创建用户和 API Key 后，客户端才能调用网关。明文 Key 只在创建或轮换时显示一次。",
          action: "new",
          actionLabel: "新建 API Key",
        },
      };

      const openCreateKey = async () => {
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

      const openEditKey = (key) => {
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

      const rotateKey = async (key) => {
        if (!confirm("轮换后将立即吊销旧 Key，是否继续？")) return;
        try {
          const result = await api("/admin/api-keys/" + key.id + "/rotate", {
            method: "POST",
            body: {},
          });
          showPlaintextKey(result.key);
          await route();
        } catch (error) {
          notify(error.message, "bad");
        }
      };

      const renderList = () => {
        let list = rows.filter((row) => {
          const query = listState.query.trim().toLowerCase();
          return query === "" || rowSearchText(entity, row).includes(query);
        });
        if (listState.sortKey) {
          const sortKey = listState.sortKey;
          const dir = listState.sortDir;
          list = list.slice().sort((a, b) => compareValues(a[sortKey], b[sortKey]) * dir);
        }
        const totalPages = Math.max(1, Math.ceil(list.length / listState.pageSize));
        if (listState.page > totalPages) listState.page = totalPages;
        const start = (listState.page - 1) * listState.pageSize;
        const pageRows = list.slice(start, start + listState.pageSize);
        const body = $("#list-body", root);
        body.innerHTML =
          tableHtml(entity, pageRows, {
            sort: listState.sortKey ? { key: listState.sortKey, dir: listState.sortDir } : null,
            emptyState:
              list.length === 0
                ? listState.query.trim()
                  ? { title: "没有匹配的记录", text: "调整搜索条件后重试。" }
                  : entity.empty
                : null,
          }) + paginationHtml(listState, list.length, totalPages);
        const meta = $("#list-meta", root);
        if (meta) meta.textContent = list.length + " 条";
        $$("[data-action]", body).forEach((button) => {
          button.onclick = () => {
            const key = rows.find((item) => item.id === button.dataset.id);
            if (!key) return;
            const action = button.dataset.action;
            if (action === "edit") {
              openEditKey(key);
              return;
            }
            if (action === "delete") {
              removeEntity(entity, key);
              return;
            }
            const definition = (entity.actions || []).find((item) => item.key === action);
            if (definition && typeof definition.run === "function") definition.run(key);
          };
        });
        bindListControls(body, listState, renderList);
        const emptyAction = $("[data-empty-action]", body);
        if (emptyAction) emptyAction.onclick = openCreateKey;
      };

      root.innerHTML =
        '<div class="section-head"><h2>API Key</h2><div class="actions"><button class="btn primary" data-new>新建 API Key</button></div></div>' +
        '<p class="hint">明文只在创建或轮换时返回一次；列表仅显示前缀。</p>' +
        (rows.length
          ? '<div class="table-toolbar"><input type="search" id="list-search" placeholder="搜索 API Key" aria-label="搜索"><span class="spacer"></span><span class="table-meta" id="list-meta"></span><select id="list-page-size" aria-label="每页条数"><option value="20">20 条/页</option><option value="50">50 条/页</option></select></div>'
          : "") +
        '<div id="list-body"></div>';

      $("[data-new]", root).onclick = openCreateKey;
      if (rows.length) {
        $("#list-search", root).oninput = () => {
          listState.query = $("#list-search", root).value;
          listState.page = 1;
          renderList();
        };
        $("#list-page-size", root).onchange = () => {
          listState.pageSize = Number($("#list-page-size", root).value) || 20;
          listState.page = 1;
          renderList();
        };
      }
      if (pendingListQuery) {
        listState.query = pendingListQuery;
        pendingListQuery = "";
        const search = $("#list-search", root);
        if (search) search.value = listState.query;
      }
      renderList();
    })();
  }

  // ---------------------------------------------------------------------
  // 概览
  // ---------------------------------------------------------------------

  function cards(items, options) {
    const columns = options && options.columns ? options.columns : 4;
    return (
      '<div class="grid cols-' +
      columns +
      '">' +
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

  function unwrapData(value) {
    if (value === undefined || value === null) return value;
    return value.data !== undefined ? value.data : value;
  }

  async function overviewPage(root) {
    const results = await Promise.allSettled([
      api("/admin/health"),
      api("/admin/usage/summary?groupBy=day"),
      api("/admin/config/current"),
      api("/admin/requests?limit=8"),
      api("/admin/health/breakers"),
    ]);
    if (results.some((item) => item.status === "rejected" && item.reason && item.reason.status === 401)) {
      return;
    }
    const [healthR, summaryR, configR, requestsR, breakersR] = results;
    const health = healthR.status === "fulfilled" ? unwrapData(healthR.value) : null;
    const summary = summaryR.status === "fulfilled" ? unwrapData(summaryR.value) : null;
    const config = configR.status === "fulfilled" ? unwrapData(configR.value) : null;
    const requests = (requestsR.status === "fulfilled" ? unwrapData(requestsR.value) : null) || [];
    const breakers = breakersR.status === "fulfilled" ? unwrapData(breakersR.value) : null;
    const totals = (summary && summary.totals) || {};
    const buckets = (summary && summary.buckets) || [];
    const errorRate = totals.requests ? (totals.errors || 0) / totals.requests : 0;

    const openBreakers = [];
    (breakers || []).forEach((provider) => {
      if (provider.providerState && provider.providerState.state !== "closed") {
        openBreakers.push(
          provider.providerName + " / Provider (" + provider.providerState.state + ")",
        );
      }
      (provider.accounts || []).forEach((account) => {
        if (account.state !== "closed") {
          openBreakers.push(provider.providerName + " / " + account.name + " (" + account.state + ")");
        }
      });
      (provider.models || []).forEach((model) => {
        if (model.state !== "closed") {
          openBreakers.push(provider.providerName + " / " + model.name + " (" + model.state + ")");
        }
      });
    });

    const modelCounts = new Map();
    requests.forEach((row) => {
      const name = row.requestedModel || "未知模型";
      modelCounts.set(name, (modelCounts.get(name) || 0) + 1);
    });
    const topModels = Array.from(modelCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const validation = config && config.validation;
    const invalid = Boolean(validation && validation.valid === false);
    const unpublished = Boolean(
      config && (config.activeVersion === null || config.activeVersion === undefined),
    );
    const pending = Boolean(config && config.pendingChanges);
    const issues = (validation && validation.issues) || [];

    let guide = "";
    if (invalid || unpublished) {
      const count = issues.filter((issue) => issue.severity === "error").length;
      guide =
        '<div class="callout warn"><strong>' +
        (invalid ? "配置校验未通过" : "配置尚未发布") +
        "</strong><p>" +
        (invalid
          ? "存在 " + count + " 个错误，发布前请先修复。"
          : "当前使用 D1 草稿配置，建议完成初始化后发布版本。") +
        ' <a href="#/setup">前往快速开始</a></p></div>';
    } else if (pending) {
      guide =
        '<div class="callout warn"><strong>有未发布的变更</strong><p>修改只有发布后才会对推理入口生效。<a href="#/config">前往配置与审计</a></p></div>';
    }

    const requestSeries = buckets.map((bucket) => bucket.requests || 0);
    const costSeries = buckets.map((bucket) => bucket.costUsd || 0);

    root.innerHTML =
      guide +
      cards([
        {
          label: "数据库",
          value: health
            ? health.db
              ? "正常"
              : '<span class="metric-error">异常</span>'
            : '<span class="metric-error">不可用</span>',
        },
        {
          label: "生效配置",
          value: config
            ? unpublished
              ? "未发布"
              : "v" + config.activeVersion
            : '<span class="metric-error">不可用</span>',
          hint: config ? (pending ? "有待发布变更" : "已同步") : "",
        },
        {
          label: "近 30 天请求",
          value: summary ? fmtNumber(totals.requests) : '<span class="metric-error">不可用</span>',
          hint: summary ? "错误率 " + (errorRate * 100).toFixed(1) + "%" : "",
        },
        {
          label: "近 30 天费用",
          value: summary ? fmtUsd(totals.costUsd) : '<span class="metric-error">不可用</span>',
          hint: summary
            ? "输入 " + fmtNumber(totals.inputTokens) + " · 输出 " + fmtNumber(totals.outputTokens)
            : "",
        },
      ]) +
      '<div class="grid cols-2">' +
      '<div class="card"><h3>请求量趋势</h3><div class="metric">' +
      (summary ? fmtNumber(totals.requests) : "--") +
      ' <small>次</small></div>' +
      (summary && requestSeries.length
        ? sparkline(requestSeries, { label: "请求量趋势" })
        : '<p class="hint">暂无趋势数据。</p>') +
      "</div>" +
      '<div class="card"><h3>费用趋势</h3><div class="metric">' +
      (summary ? fmtUsd(totals.costUsd) : "--") +
      "</div>" +
      (summary && costSeries.length
        ? sparkline(costSeries, { label: "费用趋势" })
        : '<p class="hint">暂无趋势数据。</p>') +
      "</div>" +
      "</div>" +
      '<div class="grid cols-2">' +
      '<div class="card"><h3>熔断状态</h3>' +
      (breakers === null
        ? '<p class="hint">状态不可用。</p>'
        : openBreakers.length
          ? '<div class="issue-list">' +
            openBreakers
              .slice(0, 8)
              .map((item) => '<div class="issue warning">' + esc(item) + "</div>")
              .join("") +
            "</div>"
          : '<p class="hint">所有 Provider、账户与模型均处于 CLOSED。</p>') +
      "</div>" +
      '<div class="card"><h3>最近请求模型</h3>' +
      (topModels.length
        ? '<div class="rank-list">' +
          topModels
            .map(([name, count]) => {
              return (
                '<div class="rank-row"><span class="rank-name mono">' +
                esc(name) +
                '</span><span class="rank-value">' +
                count +
                " 次</span></div>"
              );
            })
            .join("") +
          "</div>"
        : '<p class="hint">暂无请求数据。</p>') +
      "</div>" +
      "</div>" +
      '<div class="section-head"><h2>最近请求</h2><div class="actions"><a class="btn" href="#/usage">查看全部</a></div></div>' +
      requestsTable(requests);
    bindRequestDetails(root, requests);
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

  function requestDetailHtml(data) {
    if (!data || typeof data !== "object") return '<p class="hint">没有请求详情。</p>';
    const summary = [
      ["时间", fmtTime(data.createdAt)],
      ["状态", data.status || "-"],
      ["请求模型", data.requestedModel || "-"],
      ["实际模型", data.actualModel || "-"],
      ["Provider", data.providerId || "-"],
      ["账户", data.providerAccountId || "-"],
      [
        "协议",
        (data.sourceProtocol || "-") + (data.targetProtocol ? " → " + data.targetProtocol : ""),
      ],
      ["Token", fmtNumber(data.totalTokens || 0)],
      ["输入 / 输出", fmtNumber(data.inputTokens || 0) + " / " + fmtNumber(data.outputTokens || 0)],
      ["缓存 / 推理", fmtNumber(data.cachedTokens || 0) + " / " + fmtNumber(data.reasoningTokens || 0)],
      ["耗时", (data.durationMs || 0) + " ms"],
      ["费用", fmtUsd((data.actualCost || 0) + (data.estimatedCost || 0))],
    ];
    if (data.comboId) summary.push(["Combo", data.comboId]);
    if (data.errorCode) summary.push(["错误码", data.errorCode]);
    if (data.httpStatus) summary.push(["HTTP 状态", String(data.httpStatus)]);
    if (data.retryCount) summary.push(["重试", String(data.retryCount)]);
    return (
      '<div class="detail-grid">' +
      summary
        .map(
          ([label, value]) =>
            '<div><span>' + esc(label) + "</span><strong>" + esc(value) + "</strong></div>",
        )
        .join("") +
      "</div>" +
      renderRouteTrace(data.routeTrace) +
      '<details class="raw-json"><summary>原始 JSON</summary><pre class="mono">' +
      esc(JSON.stringify(data, null, 2)) +
      "</pre></details>"
    );
  }

  function bindRequestDetails(root, rows) {
    $$("[data-request]", root).forEach((button) => {
      button.onclick = async () => {
        try {
          const result = await api("/admin/requests/" + button.dataset.request);
          modal("请求详情", requestDetailHtml(result.data));
        } catch (error) {
          notify(error.message, "bad");
        }
      };
    });
  }

  // ---------------------------------------------------------------------
  // 用量
  // ---------------------------------------------------------------------

  function weekStart(day) {
    const date = new Date(day + "T00:00:00Z");
    const offset = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - offset);
    return date.toISOString().slice(0, 10);
  }

  function buildSeries(buckets, from, to, groupBy) {
    const byPeriod = new Map((buckets || []).map((bucket) => [bucket.period, bucket]));
    const periods = [];
    if (groupBy === "week") {
      const start = new Date(weekStart(from) + "T00:00:00Z");
      const end = new Date(weekStart(to) + "T00:00:00Z");
      for (let day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 7)) {
        periods.push(day.toISOString().slice(0, 10));
      }
    } else if (groupBy === "month") {
      const end = to.slice(0, 7);
      const parts = from.slice(0, 7).split("-").map(Number);
      let year = parts[0];
      let month = parts[1];
      while (true) {
        const key = String(year) + "-" + String(month).padStart(2, "0");
        periods.push(key);
        if (key === end) break;
        month += 1;
        if (month > 12) {
          month = 1;
          year += 1;
        }
      }
    } else {
      const start = new Date(from + "T00:00:00Z");
      const end = new Date(to + "T00:00:00Z");
      for (let day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
        periods.push(day.toISOString().slice(0, 10));
      }
    }
    return periods.slice(-90).map((period) => {
      const bucket = byPeriod.get(period) || {};
      return {
        label: period,
        requests: bucket.requests || 0,
        errors: bucket.errors || 0,
        costUsd: bucket.costUsd || 0,
      };
    });
  }

  async function usagePage(root) {
    await ensureLookups();
    await ensureRouteLookups();
    root.innerHTML =
      '<div class="section-head"><h2>用量汇总</h2><div class="actions">' +
      '<select id="usage-days" class="btn"><option value="7">近 7 天</option><option value="30" selected>近 30 天</option><option value="90">近 90 天</option></select>' +
      '<select id="usage-group" class="btn"><option value="day">按日</option><option value="week">按周</option><option value="month">按月</option></select>' +
      '</div></div><div id="usage-summary"></div>' +
      '<div class="section-head"><h2>请求日志</h2><div class="actions">' +
      comboboxHtml("request-model", nativeModelEntries(), "", {
        label: "模型筛选",
        placeholder: "全部模型",
        emptyText: "暂无模型",
      }) +
      '</div></div>' +
      '<div id="usage-requests"></div>';

    bindComboboxes(root);
    const chartCard = (title, series, key, formatter) => {
      return (
        '<div class="card"><h3>' +
        esc(title) +
        "</h3>" +
        (series.length
          ? barSeries(
              series.map((point) => ({
                label: point.label,
                value: point[key],
                title: point.label + " · " + formatter(point[key]),
              })),
              { formatter, label: title },
            )
          : '<p class="hint">暂无数据</p>') +
        "</div>"
      );
    };
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
      const data = summary.data || {};
      const totals = data.totals || {};
      const errorRate = totals.requests ? (totals.errors || 0) / totals.requests : 0;
      const cacheRate = totals.inputTokens ? (totals.cachedTokens || 0) / totals.inputTokens : null;
      const series = buildSeries(data.buckets || [], data.from || from, data.to || to, groupBy);
      const hasData = (totals.requests || 0) > 0;

      $("#usage-summary").innerHTML =
        cards(
          [
            { label: "请求数", value: fmtNumber(totals.requests) },
            {
              label: "错误率",
              value: (errorRate * 100).toFixed(1) + "%",
              hint: fmtNumber(totals.errors) + " 次错误",
            },
            { label: "总 Token", value: fmtNumber(totals.totalTokens) },
            {
              label: "缓存 Token",
              value: fmtNumber(totals.cachedTokens),
              hint: cacheRate === null ? "" : "命中率 " + (cacheRate * 100).toFixed(1) + "%",
            },
            { label: "推理 Token", value: fmtNumber(totals.reasoningTokens) },
            { label: "费用", value: fmtUsd(totals.costUsd) },
          ],
          { columns: 3 },
        ) +
        (hasData
          ? '<div class="grid cols-3">' +
            chartCard("请求量", series, "requests", fmtNumber) +
            chartCard("错误数", series, "errors", fmtNumber) +
            chartCard("费用", series, "costUsd", fmtUsd) +
            "</div>"
          : '<div class="card"><h3>趋势</h3><p class="hint">所选时间范围内暂无请求数据。</p></div>');

      const requestRows = requests.data || [];
      $("#usage-requests").innerHTML = requestRows.length
        ? requestsTable(requestRows)
        : '<div class="table-wrap"><div class="empty-state"><h4>还没有请求</h4><p>创建 API Key 并通过客户端发起请求后，这里会显示用量与请求日志。</p><a class="btn" href="#/connect">前往客户端接入</a></div></div>';
      if (requestRows.length) bindRequestDetails($("#usage-requests"), requestRows);
    };

    $("#usage-days").onchange = load;
    $("#usage-group").onchange = load;
    $("#request-model").onchange = load;
    await load();
  }

  // ---------------------------------------------------------------------
  // 快速开始、路由诊断与客户端接入
  // ---------------------------------------------------------------------

  async function setupPage(root) {
    const response = await api("/admin/setup/status");
    const data = response.data || {};
    const steps = data.steps || [];
    const issues = (data.config && data.config.issues) || [];
    const lastTest = data.lastGatewayTest;
    root.innerHTML =
      '<div class="section-head"><h2>快速开始</h2><div class="actions">' +
      '<button class="btn" id="setup-refresh">刷新</button>' +
      (data.config && data.config.pendingChanges
        ? '<button class="btn primary" id="setup-publish">发布配置</button>'
        : "") +
      "</div></div>" +
      '<div class="callout ' +
      (data.readyForInference ? "ok" : "warn") +
      '"><strong>' +
      (data.readyForInference ? "网关已具备推理条件。" : "还需要完成初始化步骤。") +
      '</strong> <span class="muted">按清单完成 Provider、账户、模型、发布和 API Key。</span></div>' +
      cards([
        {
          label: "Provider",
          value: String((data.counts && data.counts.providers) || 0),
          hint: "有账户 " + String((data.counts && data.counts.providersWithAccounts) || 0),
        },
        {
          label: "启用模型",
          value: String((data.counts && data.counts.enabledModels) || 0),
          hint: "共 " + String((data.counts && data.counts.models) || 0) + " 个",
        },
        {
          label: "配置版本",
          value: data.config && data.config.activeVersion !== null ? "v" + data.config.activeVersion : "未发布",
          hint: data.config && data.config.pendingChanges ? "有未发布变更" : "已同步",
        },
        {
          label: "活跃 API Key",
          value: String((data.counts && data.counts.activeApiKeys) || 0),
          hint: lastTest ? (lastTest.success ? "最近自测成功" : "最近自测失败") : "尚未自测",
        },
      ]) +
      '<div class="setup-grid">' +
      steps
        .map((step) => {
          const action = step.action
            ? '<a class="btn small-btn" href="#/' + esc(step.action.page) + '">前往处理</a>'
            : "";
          return (
            '<div class="step-card ' +
            (step.complete ? "done" : "pending") +
            '"><div class="step-head"><h3>' +
            esc(step.label) +
            "</h3>" +
            badge(step.complete, step.complete ? "完成" : "待完成") +
            '</div><p class="muted">' +
            esc(step.detail) +
            "</p>" +
            action +
            "</div>"
          );
        })
        .join("") +
      "</div>" +
      (issues.length
        ? '<div class="card"><h3>配置提示</h3><div class="issue-list">' +
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
          "</div></div>"
        : "");
    $("#setup-refresh", root).onclick = () => route();
    if ($("#setup-publish", root)) {
      $("#setup-publish", root).onclick = () => {
        location.hash = "#/config";
      };
    }
  }

  function renderGatewayTest(data) {
    if (!data || typeof data !== "object") return '<p class="hint">没有自测结果。</p>';
    const usage = data.usage || {};
    const summary = [
      ["Provider", data.provider || "-"],
      ["模型", data.modelId || "-"],
      ["HTTP 状态", data.httpStatus === undefined ? "-" : String(data.httpStatus)],
      ["延迟", data.latencyMs === undefined ? "-" : data.latencyMs + " ms"],
      ["重试", data.retryCount === undefined ? "-" : String(data.retryCount)],
      ["Token", fmtNumber(usage.totalTokens || 0)],
      ["缓存输入", fmtNumber(usage.cachedInputTokens || 0)],
      ["推理 Token", fmtNumber(usage.reasoningTokens || 0)],
    ];
    const routeTrace = Array.isArray(data.routeTrace) ? data.routeTrace : [];
    return (
      '<div class="detail-grid">' +
      summary
        .map(
          ([label, value]) =>
            '<div><span>' + esc(label) + "</span><strong>" + esc(value) + "</strong></div>",
        )
        .join("") +
      "</div>" +
      (data.text
        ? '<div class="trace-section"><h4>回复</h4><pre class="mono">' + esc(data.text) + "</pre></div>"
        : "") +
      (data.executionTrace
        ? '<div class="trace-section"><h4>执行树</h4><ul class="trace-tree">' +
          renderExecutionTree(data.executionTrace) +
          "</ul></div>"
        : "") +
      (routeTrace.length
        ? '<div class="trace-section"><h4>路由轨迹</h4><ol class="trace-steps">' +
          routeTrace.map((step) => "<li>" + esc(step) + "</li>").join("") +
          "</ol></div>"
        : "") +
      '<details class="raw-json"><summary>原始 JSON</summary><pre class="mono">' +
      esc(JSON.stringify(data, null, 2)) +
      "</pre></details>"
    );
  }

  async function diagnosticsPage(root) {
    await ensureLookups();
    await ensureRouteLookups();
    const entries = diagnosticEntries();
    root.innerHTML =
      '<div class="section-head"><h2>路由诊断</h2></div>' +
      '<div class="card"><div class="form-grid">' +
      '<div class="field"><span>模型</span>' +
      comboboxHtml("diag-model", entries, "", {
        required: true,
        label: "模型",
        placeholder: entries.length ? "搜索模型、别名或 Combo" : "暂无可用模型",
        emptyText: "暂无可用模型",
      }) +
      "</div>" +
      '<label class="field"><span>测试提示词</span><input id="diag-prompt" value="Reply with OK."></label>' +
      '<label class="field"><span>最大输出 Token</span><input id="diag-max" type="number" min="1" max="32" value="16"></label>' +
      '</div><div class="form-actions">' +
      '<button class="btn" id="diag-explain">解析路由</button>' +
      '<button class="btn primary" id="diag-test">运行网关自测</button>' +
      '</div><p class="hint">网关自测会发起一次真实上游请求，可能产生费用；最多 32 个输出 Token。</p></div>' +
      '<div id="diag-result"></div>';

    const showError = (title, error) => {
      $("#diag-result").innerHTML =
        '<div class="card"><h3>' +
        esc(title) +
        " " +
        badge(false, "失败") +
        '</h3><p class="error-text">' +
        esc(error.message) +
        "</p>" +
        (error.payload
          ? '<details class="raw-json"><summary>原始错误</summary><pre class="mono">' +
            esc(JSON.stringify(error.payload, null, 2)) +
            "</pre></details>"
          : "") +
        "</div>";
    };
    const show = (title, data) => {
      const ok = data && data.ok === true;
      const body = title === "路由解析" ? renderExplainResult(data) : renderGatewayTest(data);
      $("#diag-result").innerHTML =
        '<div class="card"><h3>' +
        esc(title) +
        " " +
        badge(ok, ok ? "成功" : "失败") +
        "</h3>" +
        body +
        "</div>";
    };
    bindComboboxes(root);
    $("#diag-explain", root).onclick = async () => {
      const model = $("#diag-model", root).value.trim();
      if (!model) {
        notify("请选择模型", "bad");
        return;
      }
      try {
        const response = await api("/admin/routing/explain", {
          method: "POST",
          body: { model },
        });
        show("路由解析", response.data || response);
      } catch (error) {
        notify(error.message, "bad");
        showError("路由解析", error);
      }
    };
    $("#diag-test", root).onclick = async () => {
      const model = $("#diag-model", root).value.trim();
      if (!model) {
        notify("请选择模型", "bad");
        return;
      }
      if (!confirm("自测会发起真实上游请求并可能产生费用，继续？")) return;
      const prompt = $("#diag-prompt", root).value.trim() || "Reply with OK.";
      const maxOutputTokens = Number($("#diag-max", root).value || 16);
      try {
        const response = await api("/admin/gateway/test", {
          method: "POST",
          body: { model, prompt, maxOutputTokens },
        });
        show("网关自测", response.data || response);
      } catch (error) {
        notify(error.message, "bad");
        showError("网关自测", error);
      }
    };
  }

  function connectPage(root) {
    const origin = location.origin;
    const openaiBase = origin + "/v1";
    const placeholderKey = "fufu_sk_...";
    const clients = [
      {
        id: "claude-code",
        label: "Claude Code",
        title: "Claude Code",
        note: "使用 Anthropic 兼容入口；Bearer 与 x-api-key 认证均支持。",
        content: [
          "# Claude Code",
          'export ANTHROPIC_BASE_URL="' + origin + '"',
          'export ANTHROPIC_AUTH_TOKEN="' + placeholderKey + '"',
        ].join("\n"),
      },
      {
        id: "codex",
        label: "Codex",
        title: "Codex",
        note: "使用 OpenAI 兼容入口。",
        content: [
          "# Codex",
          'export OPENAI_BASE_URL="' + openaiBase + '"',
          'export OPENAI_API_KEY="' + placeholderKey + '"',
        ].join("\n"),
      },
      {
        id: "gemini-cli",
        label: "Gemini CLI",
        title: "Gemini CLI",
        note: "网关提供 Gemini 兼容入口，客户端会自行追加 /v1beta。",
        content: [
          "# Gemini CLI",
          'export GOOGLE_GEMINI_BASE_URL="' + origin + '"',
          'export GEMINI_API_KEY="' + placeholderKey + '"',
        ].join("\n"),
      },
      {
        id: "openai-python",
        label: "OpenAI Python",
        title: "OpenAI Python SDK",
        note: "模型名使用 provider/model，或使用已配置的别名与 Combo。",
        content: [
          "from openai import OpenAI",
          "",
          "client = OpenAI(",
          '    base_url="' + openaiBase + '",',
          '    api_key="' + placeholderKey + '",',
          ")",
          "response = client.chat.completions.create(",
          '    model="provider/model",',
          '    messages=[{"role": "user", "content": "Hello"}],',
          ")",
          "print(response.choices[0].message.content)",
        ].join("\n"),
      },
      {
        id: "openai-curl",
        label: "curl · OpenAI",
        title: "curl · OpenAI Chat",
        note: "最小 Chat Completions 请求。",
        content: [
          'curl "' + openaiBase + '/chat/completions" \\',
          '  -H "Authorization: Bearer $FUFU_API_KEY" \\',
          '  -H "Content-Type: application/json" \\',
          '  -d \'{"model":"provider/model","messages":[{"role":"user","content":"Hello"}]}\'',
        ].join("\n"),
      },
      {
        id: "anthropic-curl",
        label: "curl · Anthropic",
        title: "curl · Anthropic Messages",
        note: "最小 Messages 请求，使用 x-api-key 认证。",
        content: [
          'curl "' + origin + '/v1/messages" \\',
          '  -H "x-api-key: ' + placeholderKey + '" \\',
          '  -H "anthropic-version: 2023-06-01" \\',
          '  -H "Content-Type: application/json" \\',
          '  -d \'{"model":"provider/model","max_tokens":64,"messages":[{"role":"user","content":"Hello"}]}\'',
        ].join("\n"),
      },
    ];
    let selected = "claude-code";

    root.innerHTML =
      '<div class="section-head"><h2>客户端接入</h2></div>' +
      '<div class="callout"><strong>Base URL</strong><p class="mono">OpenAI Chat/Responses: ' +
      esc(openaiBase) +
      "<br>Anthropic: " +
      esc(origin) +
      "<br>Gemini: " +
      esc(origin) +
      '（客户端自行追加 /v1beta）</p></div>' +
      '<p class="hint">API Key 只在创建或轮换时显示一次。请先到 <a href="#/keys">API Key</a> 页面创建，不要把真实 Key 写入仓库或截图。</p>' +
      '<div class="card"><div class="section-head"><h3>选择客户端</h3></div>' +
      '<div class="segmented" id="connect-tabs" role="tablist">' +
      clients
        .map(
          (client) =>
            '<button type="button" class="segment' +
            (client.id === selected ? " active" : "") +
            '" role="tab" aria-selected="' +
            (client.id === selected ? "true" : "false") +
            '" data-connect-client="' +
            esc(client.id) +
            '">' +
            esc(client.label) +
            "</button>",
        )
        .join("") +
      '</div><div id="connect-panel"></div></div>' +
      '<div class="callout warn"><strong>接入提示</strong><p>不同代理的环境变量名称可能不同；以代理文档为准。网关同时支持 Bearer、x-api-key 和 x-goog-api-key 认证。</p></div>';

    const renderPanel = () => {
      const client = clients.find((item) => item.id === selected) || clients[0];
      const panel = $("#connect-panel", root);
      panel.innerHTML =
        '<div class="connect-block"><div class="section-head"><h4>' +
        esc(client.title) +
        '</h4><button type="button" class="btn small-btn" data-copy="connect-snippet">复制</button></div>' +
        (client.note ? '<p class="hint">' + esc(client.note) + "</p>" : "") +
        '<pre class="mono" id="connect-snippet">' +
        esc(client.content) +
        "</pre></div>";
      const copy = $("[data-copy]", panel);
      if (copy) {
        copy.onclick = async () => {
          try {
            await navigator.clipboard.writeText(client.content);
            notify("已复制", "ok");
          } catch (error) {
            notify("复制失败，请手动选择", "bad");
          }
        };
      }
    };

    $("#connect-tabs", root).addEventListener("click", (event) => {
      const button = event.target.closest("[data-connect-client]");
      if (!button) return;
      selected = button.dataset.connectClient;
      $$(".segment", root).forEach((segment) => {
        const active = segment.dataset.connectClient === selected;
        segment.classList.toggle("active", active);
        segment.setAttribute("aria-selected", String(active));
      });
      renderPanel();
    });
    renderPanel();
  }

  // ---------------------------------------------------------------------
  // 配置与审计
  // ---------------------------------------------------------------------

  const SETTING_FIELDS = [
    { key: "gateway.name", label: "网关名称", type: "text" },
    {
      key: "compat.default_policy",
      label: "兼容策略",
      type: "select",
      options: [
        ["strict", "STRICT"],
        ["warn", "WARN"],
        ["drop", "DROP"],
        ["passthrough", "PASSTHROUGH"],
      ],
    },
    { key: "limits.max_body_bytes", label: "最大请求体 (bytes)", type: "number", min: 0 },
    { key: "limits.max_response_bytes", label: "最大响应体 (bytes)", type: "number", min: 0 },
    { key: "limits.max_stream_event_bytes", label: "最大 SSE 事件 (bytes)", type: "number", min: 0 },
    { key: "limits.max_combo_depth", label: "最大 Combo 深度", type: "number", min: 0 },
    { key: "limits.max_combo_nodes", label: "最大 Combo 节点数", type: "number", min: 0 },
    { key: "limits.max_combo_concurrency", label: "最大 Combo 并发", type: "number", min: 0 },
    { key: "timeouts.request_ms", label: "请求总超时 (ms)", type: "number", min: 0 },
    { key: "logging.retention_days", label: "日志保留天数", type: "number", min: 0 },
    { key: "config.cache_ttl_ms", label: "配置缓存 TTL (ms)", type: "number", min: 0 },
  ];

  function corsRowHtml(value) {
    return (
      '<div class="cors-row" data-cors-row><input data-cors-value placeholder="https://example.com" value="' +
      esc(value) +
      '"><button type="button" class="btn small-btn danger" data-cors-remove>删除</button></div>'
    );
  }

  function settingsFormHtml(data) {
    const values = isPlainObject(data) ? data : {};
    const fields = SETTING_FIELDS.map((field) => {
      const current = values[field.key];
      if (field.type === "select") {
        return (
          '<label class="field"><span>' +
          esc(field.label) +
          "</span>" +
          selectHtml(
            "setting_" + field.key,
            field.options,
            typeof current === "string" ? current : "",
          ) +
          "</label>"
        );
      }
      if (field.type === "number") {
        return (
          '<label class="field"><span>' +
          esc(field.label) +
          '</span><input data-setting-key="' +
          esc(field.key) +
          '" type="number" min="' +
          esc(field.min) +
          '" value="' +
          esc(typeof current === "number" ? current : "") +
          '"></label>'
        );
      }
      return (
        '<label class="field"><span>' +
        esc(field.label) +
        '</span><input data-setting-key="' +
        esc(field.key) +
        '" type="text" value="' +
        esc(typeof current === "string" ? current : "") +
        '"></label>'
      );
    });
    const origins = Array.isArray(values["cors.allowed_origins"])
      ? values["cors.allowed_origins"].filter((value) => typeof value === "string")
      : [];
    return (
      '<div class="form-grid">' +
      fields.join("") +
      '<div class="field span-2"><span>CORS 允许来源</span><div class="cors-editor" data-cors-editor><div class="kv-rows" data-cors-list>' +
      (origins.length > 0 ? origins.map(corsRowHtml).join("") : corsRowHtml("")) +
      '</div><button type="button" class="btn small-btn" data-cors-add>添加来源</button></div><div class="help">留空表示不返回 CORS 头。</div></div>' +
      "</div>"
    );
  }

  function readSettingsForm(root) {
    const payload = {};
    for (const input of root.querySelectorAll("[data-setting-key]")) {
      const key = input.dataset.settingKey;
      if (!key) continue;
      if (input.type === "number") {
        if (input.value === "") continue;
        const number = Number(input.value);
        if (!Number.isFinite(number)) throw new Error(key + " 必须是数字");
        payload[key] = number;
      } else {
        payload[key] = input.value;
      }
    }
    payload["compat.default_policy"] = root.querySelector('[name="setting_compat.default_policy"]')?.value;
    const origins = Array.from(root.querySelectorAll("[data-cors-row]"))
      .map((row) => row.querySelector("[data-cors-value]")?.value.trim() ?? "")
      .filter((value) => value !== "");
    payload["cors.allowed_origins"] = origins;
    return payload;
  }

  function bindSettingsForm(root) {
    for (const editor of root.querySelectorAll("[data-cors-editor]")) {
      const list = editor.querySelector("[data-cors-list]");
      const add = editor.querySelector("[data-cors-add]");
      if (!list || !add) continue;
      add.onclick = () => {
        list.insertAdjacentHTML("beforeend", corsRowHtml(""));
      };
      editor.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof Element) || !target.closest("[data-cors-remove]")) return;
        const row = target.closest("[data-cors-row]");
        if (row) row.remove();
        if (!list.querySelector("[data-cors-row]")) {
          list.insertAdjacentHTML("beforeend", corsRowHtml(""));
        }
      });
    }
  }

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
      (status.pendingChanges
        ? '<div class="callout warn"><strong>有未发布变更</strong><p>Provider、账户、模型或系统设置已修改，请发布配置版本后推理入口才会稳定使用新配置。</p></div>'
        : "") +
      '<div class="section-head"><h2>配置操作</h2><div class="actions">' +
      '<button class="btn" id="validate-config">校验配置</button>' +
      '<button class="btn primary" id="publish-config">发布配置</button>' +
      "</div></div>" +
      '<div class="card"><h3>系统设置</h3>' +
      '<p class="hint">保存后需要发布配置版本才会生效。数值单位为字节或毫秒。</p>' +
      settingsFormHtml(settings.data || {}) +
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

    bindSettingsForm(root);
    $("#save-settings", root).onclick = async () => {
      let payload;
      try {
        payload = readSettingsForm(root);
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
        statusRefreshedAt = 0;
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
          statusRefreshedAt = 0;
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
    setup: setupPage,
    overview: overviewPage,
    providers: crudPage(entities.providers),
    aliases: crudPage(entities.aliases),
    combos: crudPage(entities.combos),
    keys: keysPage,
    users: crudPage(entities.users),
    pricing: crudPage(entities.pricing),
    usage: usagePage,
    diagnostics: diagnosticsPage,
    connect: connectPage,
    config: configPage,
  };

  function init() {
    renderNav();
    initThemeToggle($("#theme-toggle"));
    initNavDrawer();
    initCommandPalette({
      button: $("#palette-toggle"),
      prepare: async () => {
        if (!state.token) return;
        await ensureLookups();
        await ensureRouteLookups();
      },
      getItems: commandItems,
    });
    $("#modal-close").onclick = closeModal;
    $("#modal").addEventListener("click", (event) => {
      if (event.target === $("#modal")) closeModal();
    });
    $("#logout").onclick = () => {
      sessionStorage.removeItem("fufu_admin_token");
      state.token = "";
      state.providers = [];
      state.users = [];
      statusRefreshedAt = 0;
      const sidebar = $("#sidebar");
      const backdrop = $("#nav-backdrop");
      const toggle = $("#nav-toggle");
      if (sidebar) sidebar.classList.remove("open");
      if (backdrop) backdrop.classList.add("hidden");
      if (toggle) toggle.setAttribute("aria-expanded", "false");
      showLogin();
      $("#config-state").textContent = "配置 --";
      $("#config-state").className = "status-chip";
      $("#breaker-state").textContent = "熔断 --";
      $("#breaker-state").className = "status-chip";
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
