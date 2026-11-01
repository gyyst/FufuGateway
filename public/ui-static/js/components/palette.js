// 全局命令面板：Ctrl/Cmd+K 打开，搜索页面与实体并执行跳转。
import { esc } from "../text.js";

export function initCommandPalette(options) {
  const { button, getItems, prepare } = options;
  const overlay = document.createElement("div");
  overlay.className = "palette hidden";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "命令面板");
  overlay.innerHTML =
    '<div class="palette-backdrop" data-palette-close></div>' +
    '<div class="palette-panel">' +
    '<input type="text" class="palette-input" id="palette-input" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" placeholder="搜索页面、Provider、模型、别名、Combo、用户…">' +
    '<div class="palette-list" id="palette-list" role="listbox"></div>' +
    '<div class="palette-empty hidden">没有匹配项</div>' +
    '<div class="palette-hint">↑↓ 选择 · Enter 打开 · Esc 关闭</div>' +
    "</div>";
  document.body.appendChild(overlay);

  const input = overlay.querySelector(".palette-input");
  const list = overlay.querySelector(".palette-list");
  const empty = overlay.querySelector(".palette-empty");
  let items = [];
  let filtered = [];
  let active = -1;
  let previousFocus = null;
  let opening = false;

  const isOpen = () => !overlay.classList.contains("hidden");

  const setActive = (index) => {
    active = index;
    const nodes = Array.from(list.querySelectorAll(".palette-item"));
    nodes.forEach((node, i) => {
      const on = i === index;
      node.classList.toggle("active", on);
      node.setAttribute("aria-selected", String(on));
    });
    if (nodes[index]) {
      nodes[index].scrollIntoView({ block: "nearest" });
      input.setAttribute("aria-activedescendant", nodes[index].id);
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };

  const render = () => {
    const query = input.value.trim().toLowerCase();
    filtered = items
      .filter((item) => query === "" || item.words.includes(query))
      .slice(0, 50);
    let index = 0;
    let lastGroup = null;
    const parts = [];
    filtered.forEach((item) => {
      if (item.group !== lastGroup) {
        parts.push('<div class="palette-group">' + esc(item.group) + "</div>");
        lastGroup = item.group;
      }
      const id = "palette-item-" + index;
      parts.push(
        '<div class="palette-item" role="option" id="' +
          id +
          '" data-index="' +
          index +
          '" aria-selected="false">' +
          '<span class="palette-label">' +
          esc(item.label) +
          "</span>" +
          (item.description ? '<span class="palette-desc">' + esc(item.description) + "</span>" : "") +
          "</div>",
      );
      index += 1;
    });
    list.innerHTML = parts.join("");
    empty.classList.toggle("hidden", filtered.length > 0);
    setActive(filtered.length ? 0 : -1);
  };

  const close = () => {
    overlay.classList.add("hidden");
    input.value = "";
    list.innerHTML = "";
    active = -1;
    if (previousFocus && typeof previousFocus.focus === "function") previousFocus.focus();
    previousFocus = null;
  };

  const runItem = (item) => {
    if (!item) return;
    close();
    item.run();
  };

  const open = async () => {
    if (opening || isOpen()) return;
    opening = true;
    try {
      if (typeof prepare === "function") {
        try {
          await prepare();
        } catch (error) {
          // 实体加载失败时仍保留页面跳转条目。
        }
      }
      previousFocus = document.activeElement;
      items = (typeof getItems === "function" ? getItems() : []) || [];
      overlay.classList.remove("hidden");
      input.value = "";
      render();
      input.focus();
    } finally {
      opening = false;
    }
  };

  if (button) button.addEventListener("click", open);

  document.addEventListener("keydown", (event) => {
    const shortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
    if (shortcut) {
      event.preventDefault();
      if (isOpen()) close();
      else open();
      return;
    }
    if (!isOpen()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (active < filtered.length - 1) setActive(active + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (active > 0) setActive(active - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runItem(filtered[active]);
    }
  });

  input.addEventListener("input", render);
  overlay.addEventListener("click", (event) => {
    if (event.target.closest("[data-palette-close]")) {
      close();
      return;
    }
    const item = event.target.closest(".palette-item");
    if (!item) return;
    runItem(filtered[Number(item.dataset.index)]);
  });

  return { open, close };
}
