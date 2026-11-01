# Component Guidelines

> 管理台为零构建原生 JS 单页，本文记录实际约定。

## Overview

- `src/ui/index.ts` 输出 HTML 外壳与安全头，静态资源由 `public/ui-static/` 提供。
- `public/ui-static/app.js` 是 ES module 入口，内部保持 IIFE；页面逻辑集中于此。
- 可复用控件放在 `public/ui-static/js/`，不引入框架、构建工具或第三方依赖。

## Component Structure

- 组件模块导出「生成 HTML 字符串」与「绑定事件」两类函数，例如：
  - `comboboxHtml(...)` + `bindComboboxes(root)`
  - `sparkline(values, options)` 返回 SVG 字符串
- 事件绑定一律使用 `onclick` / `addEventListener` 赋值，不使用内联事件属性（CSP `script-src 'self'`）。
- 弹窗通过 `modal(title, html)` 创建，创建后自动调用 `bindComboboxes` 与 `bindCheckListSearch`；新增控件绑定应接入该入口或调用方显式绑定。

## Props Conventions

- HTML 生成函数参数保持简单：`(name, entries, current, options)`；`options` 为可选对象，默认值在函数内处理。
- 数据条目统一为 `{ value, label, group?, description? }`；值一律转换为字符串后再比较。
- 所有插入 HTML 的用户/配置数据必须经过 `esc()` 转义，包括属性值。

## Styling Patterns

- 所有颜色、阴影、遮罩使用 `app.css` 的语义 CSS 变量；新增颜色必须同时定义 `:root`（深色）与 `:root[data-theme="light"]`。
- 组件样式追加在 `app.css` 对应区块，沿用现有命名（`.combobox-*`、`.table-toolbar`、`.empty-state` 等）。
- 主题由 `theme-init.js` 在首帧前应用（读 `localStorage["fufu.theme"]`），`js/theme.js` 负责切换。

## Accessibility

- 可搜索选择器需保留 `role="combobox"`、`aria-expanded`、`aria-controls`、`aria-activedescendant` 与选项的 `aria-selected`。
- 抽屉导航需维护汉堡按钮的 `aria-expanded`，支持 `Esc` 关闭与遮罩点击关闭。
- 表头排序使用可点击的 `th` 并显示方向指示；主题按钮使用 `aria-label` 描述目标动作。

## Common Mistakes

- 忘记在隐藏 input 上同步值，导致 `readForm` 读不到字段：combobox 一律通过同名 `.combobox-hidden` 提交。
- 在亮色主题下写死深色颜色（如 `#0d141d`）：应使用 `--input-bg`、`--panel` 等变量。
- 表格新增列时忘记 `nowrap` / `cell-actions`，造成徽章或按钮异常换行。
- 弹窗内新增选择器后未调用 `bindComboboxes`，控件显示但不可交互。
