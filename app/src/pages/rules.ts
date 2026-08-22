// 过滤与染色规则编辑面板：多会话版——每标签页独立实例，
// 数据由 SessionApp 注入/收集（随标签页快照持久化），变更即推本会话引擎热更新。
import type { SessionApi } from "../api";
import { createDropdown, type DropdownHandle } from "../dropdown";

export interface FilterRuleUi {
  enabled: boolean;
  pattern: string;
  action: "show" | "hide";
}

export interface ColorRuleUi {
  enabled: boolean;
  pattern: string;
  target: "line" | "match";
  color: string;
  bold: boolean;
  priority?: number;
}

export interface RulesSnapshot {
  filters: FilterRuleUi[];
  colors: ColorRuleUi[];
  master: boolean;
  ansiYield: boolean;
}

const PALETTE = ["#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d19a66", "#abb2bf"];

export class RulesPanel {
  private filters: FilterRuleUi[];
  private colors: ColorRuleUi[];
  private master: boolean;
  private ansiYield: boolean;
  private dropdowns: DropdownHandle[] = [];
  private root: HTMLElement;

  constructor(
    root: HTMLElement,
    private api: SessionApi,
    initial: Partial<RulesSnapshot>,
    private onChange: () => void,
  ) {
    this.root = root;
    this.filters = initial.filters ?? [];
    this.colors = initial.colors ?? [];
    this.master = initial.master ?? true;
    this.ansiYield = initial.ansiYield ?? true;

    const q = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!;

    q<HTMLButtonElement>("#toggle-rules").addEventListener("click", () => {
      root.querySelector("#rules-panel")!.classList.toggle("hidden");
    });
    // 面板内 ✕ 关闭
    q<HTMLButtonElement>("#rules-close").addEventListener("click", () => {
      root.querySelector("#rules-panel")!.classList.add("hidden");
    });

    const masterChk = q<HTMLInputElement>("#color-master");
    const yieldChk = q<HTMLInputElement>("#color-yield");
    masterChk.checked = this.master;
    yieldChk.checked = this.ansiYield;
    masterChk.addEventListener("change", () => {
      this.master = masterChk.checked;
      this.changed();
    });
    yieldChk.addEventListener("change", () => {
      this.ansiYield = yieldChk.checked;
      this.changed();
    });

    q<HTMLButtonElement>("#flt-add").addEventListener("click", () => {
      this.filters.push({ enabled: true, pattern: "", action: "hide" });
      this.renderFilters();
      this.changed();
    });
    q<HTMLButtonElement>("#flt-clear").addEventListener("click", () => {
      this.filters = [];
      this.renderFilters();
      this.changed();
    });
    q<HTMLButtonElement>("#color-add").addEventListener("click", () => {
      this.colors.push({
        enabled: true,
        pattern: "",
        target: "match",
        color: PALETTE[this.colors.length % PALETTE.length],
        bold: false,
      });
      this.renderColors();
      this.changed();
    });
    q<HTMLButtonElement>("#color-clear").addEventListener("click", () => {
      this.colors = [];
      this.renderColors();
      this.changed();
    });

    this.renderFilters();
    this.renderColors();
    this.push(); // 创建时同步引擎
  }

  /** 收集当前规则（标签页快照持久化用） */
  snapshot(): RulesSnapshot {
    const cp = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
    return { filters: cp(this.filters), colors: cp(this.colors), master: this.master, ansiYield: this.ansiYield };
  }

  private changed() {
    this.onChange();
    this.push();
  }

  private push() {
    void this.api.setFilters(
      this.filters.filter((r) => r.pattern).map((r, i) => ({ name: `f${i}`, ...r })),
    );
    void this.api.setColorRules(
      this.master,
      this.ansiYield,
      this.colors.filter((r) => r.pattern).map((r, i) => ({ name: `u${i}`, bg_color: null, ...r })),
    );
  }

  private renderFilters() {
    const holder = this.root.querySelector("#flt-rows")!;
    holder.replaceChildren(
      ...this.filters.map((rule, idx) => {
        const div = div_("flt-row");
        const chk = checkbox(rule.enabled, (v) => {
          rule.enabled = v;
          this.changed();
        });
        const input = textInput(rule.pattern, "正则，如 HEARTBEAT|DEBUG", (v) => {
          rule.pattern = v;
          this.changed();
        });
        const dd = createDropdown({
          items: [
            { value: "hide", label: "隐藏" },
            { value: "show", label: "显示" },
          ],
          value: rule.action,
          width: 84,
          onChange: (v) => {
            rule.action = v as "show" | "hide";
            this.changed();
          },
        });
        this.dropdowns.push(dd);
        const del = delBtn(() => {
          this.filters.splice(idx, 1);
          this.renderFilters();
          this.changed();
        });
        div.append(chk, input, dd.el, del);
        return div;
      }),
    );
  }

  private renderColors() {
    const holder = this.root.querySelector("#color-rows")!;
    holder.replaceChildren(
      ...this.colors.map((rule, idx) => {
        const div = div_("color-row");
        const chk = checkbox(rule.enabled, (v) => {
          rule.enabled = v;
          this.changed();
        });
        const input = textInput(rule.pattern, "正则，如 temp:\\s*\\d+", (v) => {
          rule.pattern = v;
          this.changed();
        });
        const target = createDropdown({
          items: [
            { value: "match", label: "命中段" },
            { value: "line", label: "整行" },
          ],
          value: rule.target,
          width: 88,
          onChange: (v) => {
            rule.target = v as "line" | "match";
            this.changed();
          },
        });
        const color = document.createElement("input");
        color.type = "color";
        color.value = rule.color;
        color.title = "颜色";
        color.addEventListener("input", () => {
          rule.color = color.value;
          this.changed();
        });
        const boldLabel = document.createElement("label");
        boldLabel.className = "chk";
        const bold = checkbox(rule.bold, (v) => {
          rule.bold = v;
          this.changed();
        });
        boldLabel.append(bold, document.createTextNode("粗"));
        const del = delBtn(() => {
          this.colors.splice(idx, 1);
          this.renderColors();
          this.changed();
        });
        div.append(chk, input, target.el, color, boldLabel, del);
        return div;
      }),
    );
  }
}

function div_(cls: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = cls;
  return el;
}
function checkbox(checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "checkbox";
  el.checked = checked;
  el.addEventListener("change", () => onChange(el.checked));
  return el;
}
function textInput(value: string, placeholder: string, onChange: (v: string) => void): HTMLInputElement {
  const el = document.createElement("input");
  el.className = "ms-content";
  el.value = value;
  el.placeholder = placeholder;
  el.spellcheck = false;
  el.addEventListener("change", () => onChange(el.value));
  return el;
}
function delBtn(onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.textContent = "✕";
  el.title = "删除本行";
  el.addEventListener("click", onClick);
  return el;
}
