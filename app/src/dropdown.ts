// 自绘下拉组件：原生 <select> 的 option 弹层无法完全定制（系统高亮色/边框），
// 这里用 div 实现；editable 模式 = 可输入 + 候选过滤（波特率等场景）。

export interface DropdownItem {
  value: string;
  label: string;
}

export interface DropdownHandle {
  el: HTMLElement;
  get value(): string;
  setValue(v: string): void;
  setItems(items: DropdownItem[]): void;
}

export interface DropdownOptions {
  items: DropdownItem[];
  value?: string;
  editable?: boolean;
  placeholder?: string;
  width?: number;
  onChange?: (v: string) => void;
}

let openDropdown: HTMLElement | null = null;

function closeOpen() {
  // 隐藏而非移除：remove 会让节点游离出 DOM，二次 open 操作的是游离节点 → 永远打不开
  openDropdown?.classList.add("hidden");
  openDropdown = null;
}
document.addEventListener("click", (e) => {
  if (openDropdown && !openDropdown.parentElement?.contains(e.target as Node)) closeOpen();
});

export function createDropdown(opts: DropdownOptions): DropdownHandle {
  let items = [...opts.items];
  let value = opts.value ?? items[0]?.value ?? "";
  const root = document.createElement("div");
  root.className = "dd";
  if (opts.width) root.style.width = `${opts.width}px`;

  // 控件面：editable 用 input，否则按钮
  const face = document.createElement(opts.editable ? "input" : "button");
  if (face instanceof HTMLInputElement) {
    face.type = "text";
    face.className = "dd-face dd-input";
    face.value = value;
    face.placeholder = opts.placeholder ?? "";
    face.spellcheck = false;
  } else {
    face.type = "button";
    face.className = "dd-face";
    face.innerHTML = `<span class="dd-label"></span><span class="dd-arrow"></span>`;
  }
  root.appendChild(face);

  const popup = document.createElement("div");
  popup.className = "dd-popup hidden";
  root.appendChild(popup);

  const renderLabel = () => {
    if (face instanceof HTMLInputElement) return;
    const item = items.find((i) => i.value === value);
    face.querySelector<HTMLElement>(".dd-label")!.textContent =
      item?.label ?? value ?? opts.placeholder ?? "";
  };

  const renderPopup = (filter: string) => {
    popup.replaceChildren(
      ...items
        .filter((i) => !filter || i.label.toLowerCase().includes(filter.toLowerCase()) || i.value === filter)
        .map((i) => {
          const el = document.createElement("div");
          el.className = "dd-item" + (i.value === value ? " active" : "");
          el.textContent = i.label;
          el.addEventListener("click", () => {
            value = i.value;
            if (face instanceof HTMLInputElement) face.value = i.label;
            renderLabel();
            closeOpen();
            opts.onChange?.(value);
          });
          return el;
        }),
    );
  };

  // open 可带过滤词：聚焦/点击时全量展示，仅键入时过滤（否则打开即被当前值筛剩 1~2 项）
  const open = (filter = "") => {
    closeOpen();
    renderPopup(filter);
    popup.classList.remove("hidden");
    openDropdown = popup;
    // 弹层朝下展开；贴近视口底部时朝上
    const rect = root.getBoundingClientRect();
    popup.style.top = "";
    popup.style.bottom = "";
    if (rect.bottom + popup.offsetHeight > window.innerHeight - 8) {
      popup.style.bottom = "calc(100% + 2px)";
    } else {
      popup.style.top = "calc(100% + 2px)";
    }
  };

  face.addEventListener("click", () => {
    if (!(face instanceof HTMLInputElement)) {
      if (openDropdown === popup) closeOpen();
      else open();
    }
  });
  if (face instanceof HTMLInputElement) {
    face.addEventListener("focus", () => open());
    face.addEventListener("input", () => {
      value = face.value; // 自由输入即值（波特率）
      open(face.value); // 仅键入时按内容过滤候选
    });
    face.addEventListener("blur", () => {
      // 失焦时若精确匹配候选项则取其规范 label
      const hit = items.find((i) => i.value === face.value || i.label === face.value);
      if (hit) {
        value = hit.value;
        face.value = hit.label;
      }
      opts.onChange?.(value);
    });
  }

  renderLabel();

  return {
    el: root,
    get value() {
      return value;
    },
    setValue(v: string) {
      value = v;
      if (face instanceof HTMLInputElement) {
        const hit = items.find((i) => i.value === v);
        face.value = hit?.label ?? v;
      }
      renderLabel();
    },
    setItems(next: DropdownItem[]) {
      items = [...next];
      if (!items.some((i) => i.value === value)) value = items[0]?.value ?? "";
      renderLabel();
    },
  };
}
