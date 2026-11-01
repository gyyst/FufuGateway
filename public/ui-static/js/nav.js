// 侧边栏分组配置。路由仍以 "#/<key>" 表示，展平后与既有 renderers 一一对应。
export const NAV_GROUPS = [
  {
    title: null,
    items: [
      ["setup", "快速开始"],
      ["overview", "概览"],
    ],
  },
  {
    title: "接入",
    items: [
      ["providers", "Provider"],
      ["aliases", "别名"],
      ["combos", "Combo"],
    ],
  },
  {
    title: "访问",
    items: [
      ["users", "用户"],
      ["keys", "API Key"],
    ],
  },
  {
    title: "观测",
    items: [
      ["usage", "用量与请求"],
      ["pricing", "价格表"],
      ["diagnostics", "路由诊断"],
    ],
  },
  {
    title: "设置",
    items: [
      ["connect", "客户端接入"],
      ["config", "配置与审计"],
    ],
  },
];
