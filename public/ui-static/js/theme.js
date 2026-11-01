const STORAGE_KEY = "fufu.theme";

export function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch (error) {
    // 存储不可用时仅当前页面生效。
  }
  return next;
}

export function initThemeToggle(button) {
  if (!button) return;
  const sync = () => {
    const theme = currentTheme();
    button.textContent = theme === "light" ? "深色" : "浅色";
    button.setAttribute("aria-label", theme === "light" ? "切换到深色主题" : "切换到浅色主题");
    button.setAttribute("aria-pressed", String(theme === "light"));
  };
  button.onclick = () => {
    applyTheme(currentTheme() === "light" ? "dark" : "light");
    sync();
  };
  sync();
}
