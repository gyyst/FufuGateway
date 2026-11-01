// 零依赖的可搜索选择器：输入过滤、分组、键盘导航、单选/多选。
// 表单值统一写入隐藏 input，因此沿用现有 readForm 的取值方式。

function esc(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[&<>"']/g, (ch) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

function normalizeEntries(entries) {
  return (entries || []).map((entry) => ({
    value: String(entry.value),
    label: entry.label === undefined ? String(entry.value) : String(entry.label),
    group: entry.group ? String(entry.group) : "",
    description: entry.description ? String(entry.description) : "",
  }));
}

export function comboboxHtml(name, entries, current, options = {}) {
  const items = normalizeEntries(entries);
  const multiple = options.multiple === true;
  const selected = multiple
    ? (Array.isArray(current) ? current : current ? [current] : []).map(String)
    : current === undefined || current === null || current === ""
      ? []
      : [String(current)];
  const hiddenValue = multiple ? JSON.stringify(selected) : selected[0] || "";
  const inputId = name + "-input";
  const panelId = name + "-panel";
  const placeholder = options.placeholder || (multiple ? "搜索并选择" : "搜索或选择");

  let optionIndex = 0;
  let lastGroup = null;
  const body = [];
  for (const item of items) {
    if (multiple) {
      const group = item.group || "";
      if (group !== lastGroup) {
        if (lastGroup !== null || group) {
          body.push('<div class="combobox-group-title">' + esc(group || "其他") + "</div>");
        }
        lastGroup = group;
      }
    } else if (item.group && item.group !== lastGroup) {
      body.push('<div class="combobox-group-title">' + esc(item.group) + "</div>");
      lastGroup = item.group;
    }
    const selectedAttr = selected.includes(item.value) ? ' aria-selected="true"' : ' aria-selected="false"';
    body.push(
      '<div class="combobox-option" role="option" id="' +
        esc(name + "-opt-" + optionIndex) +
        '" data-value="' +
        esc(item.value) +
        '" data-label="' +
        esc(item.label) +
        '" data-desc="' +
        esc(item.description) +
        '"' +
        selectedAttr +
        ">" +
        '<span class="label">' +
        esc(item.label) +
        "</span>" +
        (item.description ? '<span class="desc">' + esc(item.description) + "</span>" : "") +
        "</div>",
    );
    optionIndex += 1;
  }
  const emptyText = options.emptyText || "无可选项";
  if (!items.length) {
    body.push(
      '<div class="combobox-empty" data-empty-text="' +
        esc(emptyText) +
        '">' +
        esc(emptyText) +
        "</div>",
    );
  } else {
    body.push('<div class="combobox-empty hidden" data-empty-text="无匹配项">无匹配项</div>');
  }

  const currentLabel = multiple
    ? ""
    : (items.find((item) => item.value === selected[0]) || {}).label || selected[0] || "";

  return (
    '<div class="combobox" data-combobox data-multiple="' +
    String(multiple) +
    '">' +
    (multiple ? '<div class="combobox-tags"></div>' : "") +
    '<input type="text" class="combobox-input" id="' +
    esc(inputId) +
    '" autocomplete="off" role="combobox" aria-label="' +
    esc(options.label || placeholder) +
    '" aria-expanded="false" aria-controls="' +
    esc(panelId) +
    '" aria-autocomplete="list" placeholder="' +
    esc(placeholder) +
    '" value="' +
    esc(currentLabel) +
    '">' +
    (!multiple && !options.required
      ? '<button type="button" class="combobox-clear' +
        (selected.length ? "" : " hidden") +
        '" aria-label="清除选择">×</button>'
      : "") +
    '<input type="hidden" class="combobox-hidden" id="' +
    esc(name) +
    '" name="' +
    esc(name) +
    '" value="' +
    esc(hiddenValue) +
    '"' +
    (options.attrs || "") +
    ">" +
    '<div class="combobox-panel hidden" id="' +
    esc(panelId) +
    '" role="listbox">' +
    body.join("") +
    "</div>" +
    "</div>"
  );
}

export function bindComboboxes(root = document) {
  root.querySelectorAll("[data-combobox]").forEach((box) => {
    if (box.dataset.bound === "1") return;
    bindOne(box);
  });
}

function bindOne(box) {
  box.dataset.bound = "1";
  const input = box.querySelector(".combobox-input");
  const hidden = box.querySelector(".combobox-hidden");
  const panel = box.querySelector(".combobox-panel");
  const tags = box.querySelector(".combobox-tags");
  const clear = box.querySelector(".combobox-clear");
  const multiple = box.dataset.multiple === "true";
  const options = Array.from(panel.querySelectorAll(".combobox-option"));
  const groupTitles = Array.from(panel.querySelectorAll(".combobox-group-title"));
  const empty = panel.querySelector(".combobox-empty");
  let active = -1;
  let visible = options;
  let docHandler = null;

  const selectedValues = () => {
    if (!multiple) return hidden.value ? [hidden.value] : [];
    try {
      const parsed = JSON.parse(hidden.value || "[]");
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch (error) {
      return [];
    }
  };

  const optionByValue = (value) => options.find((option) => option.dataset.value === String(value));

  const renderTags = () => {
    if (!multiple || !tags) return;
    tags.innerHTML = selectedValues()
      .map((value) => {
        const option = optionByValue(value);
        const label = option ? option.dataset.label : value;
        return (
          '<span class="combobox-tag">' +
          esc(label) +
          '<button type="button" data-remove="' +
          esc(value) +
          '" aria-label="移除 ' +
          esc(label) +
          '">×</button></span>'
        );
      })
      .join("");
    tags.querySelectorAll("[data-remove]").forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        const next = selectedValues().filter((value) => value !== button.dataset.remove);
        hidden.value = JSON.stringify(next);
        syncSelected();
        notifyChange();
        filter("");
        input.focus();
      };
    });
  };

  const syncSelected = () => {
    const values = selectedValues();
    options.forEach((option) => {
      option.setAttribute("aria-selected", String(values.includes(option.dataset.value)));
    });
    if (!multiple) {
      const option = optionByValue(hidden.value);
      input.value = option ? option.dataset.label : hidden.value || "";
    }
    if (clear) clear.classList.toggle("hidden", !hidden.value);
    renderTags();
  };

  const notifyChange = () => {
    hidden.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const setActive = (index) => {
    visible.forEach((option, i) => option.classList.toggle("active", i === index));
    active = index;
    if (visible[index]) {
      input.setAttribute("aria-activedescendant", visible[index].id);
      visible[index].scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };

  const filter = (query) => {
    const q = query.trim().toLowerCase();
    visible = options.filter((option) => {
      const text = (
        option.dataset.label +
        " " +
        option.dataset.value +
        " " +
        (option.dataset.desc || "")
      ).toLowerCase();
      const show = q === "" || text.includes(q);
      option.classList.toggle("hidden", !show);
      return show;
    });
    groupTitles.forEach((title) => {
      let node = title.nextElementSibling;
      let any = false;
      while (node && !node.classList.contains("combobox-group-title")) {
        if (node.classList.contains("combobox-option") && !node.classList.contains("hidden")) {
          any = true;
        }
        node = node.nextElementSibling;
      }
      title.classList.toggle("hidden", !any);
    });
    if (empty) {
      if (options.length === 0) {
        empty.textContent = empty.dataset.emptyText || "无可选项";
        empty.classList.remove("hidden");
      } else {
        empty.textContent = "无匹配项";
        empty.classList.toggle("hidden", visible.length > 0);
      }
    }
    setActive(visible.length ? 0 : -1);
  };

  const closePanel = () => {
    panel.classList.add("hidden");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
    if (!multiple) syncSelected();
    if (docHandler) {
      document.removeEventListener("mousedown", docHandler);
      docHandler = null;
    }
  };

  const openPanel = () => {
    panel.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
    filter("");
    input.select();
    if (!docHandler) {
      docHandler = (event) => {
        if (!box.contains(event.target)) closePanel();
      };
      document.addEventListener("mousedown", docHandler);
    }
  };

  const selectOption = (option) => {
    if (!option) return;
    if (multiple) {
      const values = selectedValues();
      const value = option.dataset.value;
      const next = values.includes(value)
        ? values.filter((item) => item !== value)
        : values.concat(value);
      hidden.value = JSON.stringify(next);
      syncSelected();
      notifyChange();
      input.value = "";
      filter("");
      input.focus();
      return;
    }
    hidden.value = option.dataset.value;
    input.value = option.dataset.label;
    syncSelected();
    closePanel();
    notifyChange();
  };

  input.addEventListener("focus", openPanel);
  input.addEventListener("input", () => {
    panel.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
    filter(input.value);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      panel.classList.remove("hidden");
      if (active < visible.length - 1) setActive(active + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (active > 0) setActive(active - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active >= 0 && visible[active]) selectOption(visible[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closePanel();
      input.blur();
    } else if (event.key === "Tab") {
      closePanel();
    }
  });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (!box.contains(document.activeElement)) closePanel();
    }, 120);
  });

  options.forEach((option) => {
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("click", () => selectOption(option));
  });

  if (clear) {
    clear.addEventListener("mousedown", (event) => event.preventDefault());
    clear.addEventListener("click", () => {
      hidden.value = "";
      input.value = "";
      syncSelected();
      notifyChange();
      input.focus();
    });
  }

  syncSelected();
}
