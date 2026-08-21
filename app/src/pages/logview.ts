// 传统收发页（模式 B）：时间戳 + 自动染色 + 过滤 + 发送面板
// 控件所有权在 main.ts（自绘下拉），本类只收：视图、自动滚动框、时间戳模式取值器
import type { EntriesBatch, LogEntryDto } from "../types";

const MAX_LINES = 100_000; // ADR-0010：接收区上限，超出丢旧行

export class LogViewPage {
  private view: HTMLElement;
  private autoscroll: HTMLInputElement;
  private getTsMode: () => string;
  private hexDisplay = false;
  private epochAnchor = Date.now();
  private lastTs: number | null = null;
  private lines = 0;

  constructor(view: HTMLElement, opts: { autoscroll: HTMLInputElement; getTsMode: () => string }) {
    this.view = view;
    this.autoscroll = opts.autoscroll;
    this.getTsMode = opts.getTsMode;
  }

  setHexDisplay(on: boolean) {
    this.hexDisplay = on;
  }

  /** 时间戳模式切换后重置差值基准 */
  resetDeltaBase() {
    this.lastTs = null;
  }

  /** 收到批量日志条目 */
  append(batch: EntriesBatch) {
    this.epochAnchor = batch.epoch_anchor_ms;
    const frag = document.createDocumentFragment();
    for (const item of batch.items) {
      frag.appendChild(this.renderLine(item));
      this.lines++;
    }
    this.view.appendChild(frag);
    while (this.lines > MAX_LINES && this.view.firstChild) {
      this.view.removeChild(this.view.firstChild);
      this.lines--;
    }
    if (this.autoscroll.checked) this.view.scrollTop = this.view.scrollHeight;
  }

  private renderLine(e: LogEntryDto): HTMLElement {
    const div = document.createElement("div");
    div.className = "log-line";
    const mode = this.getTsMode();
    if (mode !== "none") {
      const ts = document.createElement("span");
      ts.className = "log-ts";
      ts.textContent = this.formatTs(e.ts_ms);
      div.appendChild(ts);
    }
    if (this.hexDisplay) {
      // HEX 模式：原始字节十六进制（染色让位——二进制没有"颜色语义"）
      const s = document.createElement("span");
      s.className = "log-hex";
      s.textContent = e.raw_hex || "(空)";
      div.appendChild(s);
      return div;
    }
    for (const seg of e.segments) {
      const s = document.createElement("span");
      s.textContent = seg.text;
      if (seg.fg) s.style.color = cssColor(seg.fg);
      if (seg.bg) s.style.backgroundColor = cssColor(seg.bg);
      if (seg.bold) s.classList.add("seg-bold");
      div.appendChild(s);
    }
    return div;
  }

  private formatTs(tsMs: number): string {
    switch (this.getTsMode()) {
      case "relative":
        return `+${tsMs}ms`;
      case "delta": {
        const base = this.lastTs ?? tsMs;
        const d = tsMs - base;
        this.lastTs = tsMs;
        return d >= 0 ? `Δ+${d}ms` : `Δ${d}ms`;
      }
      default: {
        // absolute：anchor(墙钟) + monotonic 偏移
        const wall = new Date(this.epochAnchor + tsMs);
        const p = (n: number, w = 2) => String(n).padStart(w, "0");
        return `${p(wall.getHours())}:${p(wall.getMinutes())}:${p(wall.getSeconds())}.${p(wall.getMilliseconds(), 3)}`;
      }
    }
  }

  clear() {
    this.view.replaceChildren();
    this.lines = 0;
    this.lastTs = null;
  }
}

/** 命名色 → CSS 颜色（与 Rust Palette 的 ANSI16 表一致） */
const NAMED_RGB: Record<string, string> = {
  black: "#000000", red: "#cc0000", green: "#00cc00", yellow: "#cccc00",
  blue: "#0000cc", magenta: "#cc00cc", cyan: "#00cccc", white: "#cccccc",
  gray: "#666666", bright_red: "#ff3333", bright_green: "#33ff33",
  bright_yellow: "#ffff33", bright_blue: "#3333ff", bright_magenta: "#ff33ff",
  bright_cyan: "#33ffff", bright_white: "#ffffff",
};

function cssColor(name: string): string {
  if (name.startsWith("#")) return name;
  return NAMED_RGB[name] ?? "#dce0e8";
}
