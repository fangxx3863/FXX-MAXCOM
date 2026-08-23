// 自定义右键菜单：原生菜单被屏蔽后的替代品（编辑四件套 + 各页面扩展项）。
// Shift+右键 不拦截，保留原生菜单用于调试。
import { t } from "./i18n";

export interface CtxItem {
  label?: string;
  /** 分隔线 */
  sep?: boolean;
  enabled?: boolean;
  hint?: string;
  action?: () => void;
}

let el: HTMLDivElement | null = null;

function cleanup() {
  window.removeEventListener("pointerdown", onDocPointer, true);
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", close);
  window.removeEventListener("resize", close);
}

function close() {
  if (!el) return;
  cleanup();
  el.remove();
  el = null;
}

function onDocPointer(e: PointerEvent) {
  if (el && !el.contains(e.target as Node)) close();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}

export function openContextMenu(items: CtxItem[], x: number, y: number): void {
  close();
  const usable = items.filter((it) => it.sep || it.label);
  if (!usable.length) return;
  el = document.createElement("div");
  el.className = "ctx-menu";
  for (const it of usable) {
    if (it.sep) {
      const s = document.createElement("div");
      s.className = "ctx-sep";
      el.appendChild(s);
      continue;
    }
    const b = document.createElement("div");
    b.className = "ctx-item" + (it.enabled === false ? " disabled" : "");
    b.textContent = it.label!;
    if (it.hint) b.title = it.hint;
    const act = it.action;
    b.addEventListener("click", () => {
      close();
      if (it.enabled !== false && act) act();
    });
    el.appendChild(b);
  }
  document.body.appendChild(el);
  // 视口内收拢（先渲染再量尺寸）
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(2, Math.min(x, innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(2, Math.min(y, innerHeight - r.height - 4))}px`;
  // 异步挂关闭监听：避免触发本菜单的 pointer 事件立即把它关掉
  window.setTimeout(() => {
    if (!el) return;
    window.addEventListener("pointerdown", onDocPointer, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
  });
}

// ── 编辑操作 ──

type Editable = HTMLInputElement | HTMLTextAreaElement;

/** 右键目标若可编辑则聚焦，返回聚焦后的可编辑元素（无则 null） */
export function focusEditable(target: EventTarget | null): Editable | null {
  const t = target as HTMLElement | null;
  if (t instanceof HTMLInputElement && !["checkbox", "radio", "file", "button"].includes(t.type)) {
    t.focus();
    return t;
  }
  if (t instanceof HTMLTextAreaElement) {
    t.focus();
    return t;
  }
  return null;
}

function selText(ed: Editable | null): string {
  if (ed && ed.selectionStart !== null && ed.selectionEnd !== null) {
    return ed.value.slice(ed.selectionStart, ed.selectionEnd);
  }
  return window.getSelection()?.toString() ?? "";
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 常用编辑项：剪切/复制/粘贴/全选（按当前焦点与选区计算可用性） */
export function commonEditItems(): CtxItem[] {
  const ed = focusEditable(document.activeElement);
  const edNow = editableActive();
  const hasSel = selText(edNow ?? ed).length > 0;
  const items: CtxItem[] = [];
  const isEditable = !!(edNow ?? ed);
  if (isEditable) {
    const target = (edNow ?? ed)!;
    const readOnly = "readOnly" in target && target.readOnly;
    items.push({
      label: t("ctx.cut"),
      enabled: hasSel && !readOnly,
      action: () => {
        const s = target.selectionStart ?? 0;
        const e = target.selectionEnd ?? 0;
        void writeClipboard(target.value.slice(s, e));
        target.setRangeText("", s, e, "end");
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      },
    });
  }
  items.push({
    label: t("ctx.copy"),
    enabled: hasSel,
    action: () => {
      const text = selText(edNow ?? ed);
      if (text) void writeClipboard(text);
    },
  });
  if (isEditable) {
    const target = (edNow ?? ed)!;
    items.push({
      label: t("ctx.paste"),
      hint: t("ctx.paste.hint"),
      action: () => {
        navigator.clipboard
          .readText()
          .then((t) => {
            const s = target.selectionStart ?? target.value.length;
            const e = target.selectionEnd ?? target.value.length;
            target.setRangeText(t, s, e, "end");
            target.dispatchEvent(new Event("input", { bubbles: true }));
            target.dispatchEvent(new Event("change", { bubbles: true }));
          })
          .catch(() => {});
      },
    });
    items.push({
      label: t("ctx.selectAll"),
      action: () => {
        target.focus();
        target.select();
      },
    });
  }
  return items;
}

function editableActive(): Editable | null {
  const el0 = document.activeElement;
  if (el0 instanceof HTMLInputElement && !["checkbox", "radio", "file", "button"].includes(el0.type)) return el0;
  if (el0 instanceof HTMLTextAreaElement) return el0;
  return null;
}
