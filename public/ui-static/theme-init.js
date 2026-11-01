// 首帧前应用已保存的主题，避免深色/浅色切换闪烁。
// 独立同源同步脚本，以兼容 script-src 'self' 的 CSP 限制。
(function () {
  try {
    var theme = localStorage.getItem("fufu.theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
    }
  } catch (error) {
    // 隐私模式或存储被禁用时保持默认主题。
  }
})();
