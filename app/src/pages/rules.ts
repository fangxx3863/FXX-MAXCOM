// 过滤与染色规则编辑面板：localStorage 持久化，变更即推引擎热更新
import { api } from "../api";
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

const PALETTE = ["#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d19a66", "#abb2bf"];

export class RulesPanel {
  private filters: FilterRuleUi[] = JSON.parse(localStorage.getItem("maxcom.filters") ?? "[]");
  private colors: ColorRuleUi[] = JSON.parse(localStorage.getItem("maxcom.colorrules") ?? "[]");
  private master = JSON.parse(localStorage.getItem("maxcom.colormaster") ?? "true") as boolean;
  private ansiYield = JSON.parse(localStorage.getItem("maxcom.coloryield") ?? "true") as boolean;
  private dropdowns: DropdownHandle[] = [];

  init() {
    $("#toggle-rules").addEventListener("click", () => {
      document.querySelector("#rules-panel")!.classList.toggle("hidden");
    });
    // 面板内 ✕ 关闭
    $("#rules-close").addEventListener("click", () => {
      document.querySelector("#rules-panel")!.classList.add("hidden");
    });

    const masterChk = $<HTMLInputElement>("#color-master");
    const yieldChk = $<HTMLInputElement>("#color-yield");
    masterChk.checked = this.master;
    yieldChk.checked = this.ansiYield;
    masterChk.addEventListener("change", () => {
      this.master = masterChk.checked;
      this.persistColorMeta();
      this.push();
    });
    yieldChk.addEventListener("change", () => {
      this.ansiYield = yieldChk.checked;
      this.persistColorMeta();
      this.push();
    });

    $("#flt-add").addEventListener("click", () => {
      this.filters.push({ enabled: true, pattern: "", action: "hide" });
      this.renderFilters();
      this.persist();
    });
    $("#flt-clear").addEventListener("click", () => {
      this.filters = [];
      this.renderFilters();
      this.persist();
    });
    $("#color-add").addEventListener("click", () => {
      this.colors.push({
        enabled: true,
        pattern: "",
        target: "match",
        color: PALETTE[this.colors.length % PALETTE.length],
        bold: false,
      });
      this.renderColors();
      this.persist();
    });
    $("#color-clear").addEventListener("click", () => {
      this.colors = [];
      this.renderColors();
      this.persist();
    });

    this.renderFilters();
    this.renderColors();
    this.push(); // 启动时同步引擎
  }

  private persist() {
    localStorage.setItem("maxcom.filters", JSON.stringify(this.filters));
    localStorage.setItem("maxcom.colorrules", JSON.stringify(this.colors));
  }

  private persistColorMeta() {
    localStorage.setItem("maxcom.colormaster", JSON.stringify(this.master));
    localStorage.setItem("maxcom.coloryield", JSON.stringify(this.ansiYield));
  }

  private push() {
    void api.setFilters(
      this.filters.filter((r) => r.pattern).map((r, i) => ({ name: `f${i}`, ...r })),
    );
    void api.setColorRules(
      this.master,
      this.ansiYield,
      this.colors.filter((r) => r.pattern).map((r, i) => ({ name: `u${i}`, bg_color: null, ...r })),
    );
  }

  private renderFilters() {
    this.dropdowns = this.dropdowns.filter((d) => !d.el.closest("#flt-rows"));
    const holder = document.querySelector("#flt-rows")!;
    holder.replaceChildren(
      ...this.filters.map((rule, idx) => {
        const div = div_("flt-row");
        const chk = checkbox(rule.enabled, (v) => {
          rule.enabled = v;
          this.persist();
          this.push();
        });
        const input = textInput(rule.pattern, "正则，如 HEARTBEAT|DEBUG", (v) => {
          rule.pattern = v;
          this.persist();
          this.push();
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
            this.persist();
            this.push();
          },
        });
        this.dropdowns.push(dd);
        const del = delBtn(() => {
          this.filters.splice(idx, 1);
          this.renderFilters();
          this.persist();
          this.push();
        });
        div.append(chk, input, dd.el, del);
        return div;
      }),
    );
  }

  private renderColors() {
    const holder = document.querySelector("#color-rows")!;
    holder.replaceChildren(
      ...this.colors.map((rule, idx) => {
        const div = div_("color-row");
        const chk = checkbox(rule.enabled, (v) => {
          rule.enabled = v;
          this.persist();
          this.push();
        });
        const input = textInput(rule.pattern, "正则，如 temp:\\s*\\d+", (v) => {
          rule.pattern = v;
          this.persist();
          this.push();
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
            this.persist();
            this.push();
          },
        });
        const color = document.createElement("input");
        color.type = "color";
        color.value = rule.color;
        color.title = "颜色";
        color.addEventListener("input", () => {
          rule.color = color.value;
          this.persist();
          this.push();
        });
        const boldLabel = document.createElement("label");
        boldLabel.className = "chk";
        const bold = checkbox(rule.bold, (v) => {
          rule.bold = v;
          this.persist();
          this.push();
        });
        boldLabel.append(bold, document.createTextNode("粗"));
        const del = delBtn(() => {
          this.colors.splice(idx, 1);
          this.renderColors();
          this.persist();
          this.push();
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

// 面板内使用的 $ 简写（避免整文件依赖 main 的 $）
function $<T extends HTMLElement>(sel: string): T {
  return document.querySelector<T>(sel)!;
}
