// 传统收发页（模式 B）：时间戳 + 自动染色 + 过滤 + 发送面板
// 控件所有权在 main.ts（自绘下拉），本类只收：视图、自动滚动框、时间戳模式取值器
//
// ── 渲染模型（超大日志不丢行、不滞后）──
// 数据层：entries 全量保留在 this.rows（每行 { ts, tsText, text, segments, rawHex }），
// partial 续行在入队时合并进同一行（文本/段/HEX 拼接，跨批正确），时间戳串在入队时
// 按当时的时间戳模式生成并随行存储 → 重渲染不会污染 delta 基准。
// DOM 层：#log-view 按 rowsPerPage 行分页（chunk），只挂载视口 ±pageBuffer 页，
// 远端 chunk 卸载成按实测高度占位的空骨架 → 滚动高度稳定、append 成本恒定，
// 行数再多渲染成本也不变。数据永不丢弃（原来 MAX_LINES 丢旧行的行为已废除）。
import type { EntriesBatch, LogEntryDto } from "../types";
import { t } from "../i18n";

interface QuickFilter {
  regex?: RegExp;
  text?: string;
}

/** 单行数据（partial 续行已在入队时合并） */
interface Row {
  ts: number;
  /** 入队时按当时时间戳模式生成的时间戳串（none 模式为 ""） */
  tsText: string;
  text: string;
  segments: LogEntryDto["segments"];
  rawHex: string;
}

function compileQuickFilter(pattern: string): QuickFilter | null {
  const p = pattern.trim();
  if (!p) return null;
  try {
    return { regex: new RegExp(p) };
  } catch {
    return { text: p }; // 非法正则 → 按子串匹配
  }
}

export class LogViewPage {
  private view: HTMLElement;
  private autoscroll: HTMLInputElement;
  private getTsMode: () => string;
  private hexDisplay = false;
  private lastTs: number | null = null;
  private quickFilter: QuickFilter | null = null;
  private rowCss = "";

  // ── 数据模型 ──
  /** 全量行（永不丢弃） */
  private rows: Row[] = [];
  /** 尚未结束的行下标（-1 = 无 pending；后续 partial/结束条目续接到它） */
  private pendingIdx = -1;

  // ── 分页窗口 ──
  /** chunk[i] = 已挂载的容器；null = 未挂载（DOM 里不存在该容器） */
  private chunks: (HTMLElement | null)[] = [];
  /** 卸载时实测的 chunk 高度（含换行），占位用；0 = 未测量 → 按行数×行高估算 */
  private chunkHeights: number[] = [];
  /** 每页行数（设置页可配） */
  private rowsPerPage = 500;
  /** 视口上下各预渲染页数 */
  private pageBuffer = 2;

  constructor(view: HTMLElement, opts: { autoscroll: HTMLInputElement; getTsMode: () => string }) {
    this.view = view;
    this.autoscroll = opts.autoscroll;
    this.getTsMode = opts.getTsMode;
    // 粘性自动滚动 + 懒加载窗口同挂 scroll（测试桩可能传纯对象，做能力守卫）
    if (typeof this.view.addEventListener === "function") {
      this.view.addEventListener("scroll", () => this.onScroll());
    }
    if (typeof this.autoscroll.addEventListener === "function") {
      this.autoscroll.addEventListener("change", () => {
        if (this.autoscroll.checked) this.scrollToBottom();
      });
    }
    this.refreshRowHeight();
  }

  /** 设置每页行数（设置页「每页行数」）。触发窗口重建并回到底部 */
  setRowsPerPage(n: number): void {
    const v = Math.max(50, Math.min(5000, Math.floor(n) || 500));
    if (v === this.rowsPerPage) return;
    this.rowsPerPage = v;
    this.rebuildChunks();
    this.scrollToBottom();
  }

  getRowsPerPage(): number {
    return this.rowsPerPage;
  }

  /** 立即拉到底部（取整到整数设备像素，粘性滚动要求） */
  scrollToBottom() {
    const el = this.view;
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const maxCss = el.scrollHeight - el.clientHeight;
    el.scrollTop = Math.round(maxCss * dpr) / dpr;
  }

  /** 每行格子高度钉成「整数设备像素」：xterm 固定行高原理。
    任意 DPR/缩放下每行都占整数个设备像素 → 累计高度为整数 → scrollTop 不抖。 */
  refreshRowHeight() {
    // 非浏览器环境（node 测试等）无 DOM/DPR，直接跳过
    if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return;
    const fs = parseFloat(window.getComputedStyle(this.view).fontSize);
    if (!Number.isFinite(fs) || fs <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const natural = fs * 1.5; // styles.css #log-view line-height: 1.5
    const rowCss = Math.ceil(natural * dpr) / dpr;
    const key = rowCss.toFixed(3);
    if (key !== this.rowCss) {
      this.rowCss = key;
      this.view.style.lineHeight = rowCss + "px";
      // 空行条目会坍缩成 0 高：用 --log-row-h 钉一行高作 min-height
      this.view.style.setProperty("--log-row-h", rowCss + "px");
    }
  }

  /** 是否已滚动到底部（粘性自动滚动的判定） */
  private isAtBottom(): boolean {
    const el = this.view;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
  }

  /** 滚动事件：同步自动滚动开关 + 懒加载窗口 */
  private onScroll(): void {
    this.syncAutoscroll();
    this.ensureWindow();
  }

  /** 按当前滚动位置同步自动滚动开关 */
  private syncAutoscroll() {
    this.autoscroll.checked = this.isAtBottom();
  }

  setHexDisplay(on: boolean) {
    this.hexDisplay = on;
    // HEX/文本切换影响所有行的渲染内容 → 重建窗口（数据层 text/rawHex 都保留，可随时切）
    this.rebuildChunks();
  }

  /** 当前是否 HEX 显示模式（日志捕获据此决定写 raw_hex 还是 text） */
  get hexView(): boolean {
    return this.hexDisplay;
  }

  /** 当前总行数（测试/调试用） */
  get lineCount(): number {
    return this.rows.length;
  }

  /** 快捷过滤：命中才显示（空 = 全显）。只重渲染当前已挂载的 chunk */
  setQuickFilter(pattern: string) {
    this.quickFilter = compileQuickFilter(pattern);
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i]) this.fillChunk(i);
    }
  }

  /** 收到批量日志条目：入队数据模型 + 追加/刷新渲染（成本恒定，与总行数无关） */
  append(batch: EntriesBatch) {
    this.refreshRowHeight();
    const wasBottom = this.isAtBottom();
    let appendedRows = 0;
    let mergedChunk = -1; // 本批若发生了 partial 续接，该行所在 chunk 需刷新
    for (const item of batch.items) {
      const isPartial = !!item.partial;
      if (this.pendingIdx >= 0 && this.pendingIdx < this.rows.length) {
        // 续接 pending 行（文本/段/HEX 都累积，渲染模式切换时两种数据都在）
        const row = this.rows[this.pendingIdx];
        row.text += item.text;
        if (row.rawHex && item.raw_hex) row.rawHex += " ";
        row.rawHex += item.raw_hex;
        row.segments.push(...item.segments);
        mergedChunk = Math.floor(this.pendingIdx / this.rowsPerPage);
        if (!isPartial) this.pendingIdx = -1;
        continue;
      }
      // 新行：时间戳串按入队时刻的模式生成（与旧行为一致：模式切换只影响新行）
      const row: Row = {
        ts: item.ts_ms,
        tsText: this.formatTs(item.ts_ms, batch.epoch_anchor_ms),
        text: item.text,
        segments: item.segments.slice(),
        rawHex: item.raw_hex,
      };
      this.rows.push(row);
      if (isPartial) this.pendingIdx = this.rows.length - 1;
      appendedRows++;
    }
    if (appendedRows > 0) {
      this.growChunks();
      this.renderTail();
    }
    if (mergedChunk >= 0 && this.chunks[mergedChunk]) {
      this.fillChunk(mergedChunk);
    }
    // 粘底：用户原本在底部（或自动滚动已开）才维持贴底；否则不打扰用户
    if (appendedRows > 0 && (this.autoscroll.checked || wasBottom)) {
      this.scrollToBottom();
    }
  }

  /** rows 增长后补齐 chunk 高度表与槽位数组 */
  private growChunks() {
    const need = Math.ceil(this.rows.length / this.rowsPerPage);
    while (this.chunks.length < need) {
      this.chunks.push(null);
      this.chunkHeights.push(0);
    }
  }

  /** 尾页保证挂载且内容最新（贴底实时流的高频路径；已挂载也重渲染以纳入新行） */
  private renderTail() {
    const last = this.chunks.length - 1;
    if (last >= 0) this.fillChunk(last);
  }

  /** 渲染 chunk ci：容器不存在则创建并按序插入，然后填入该页全部行 */
  private fillChunk(ci: number) {
    let el = this.chunks[ci];
    if (!el) {
      // 卸载时占位容器仍保留在 DOM（稳住滚动高度）；先复用，顺序天然正确。
      const existing = Array.from(this.view.children).find(
        (c) => c instanceof HTMLElement && c.dataset.chunk === String(ci),
      ) as HTMLElement | undefined;
      if (existing) {
        el = existing;
      } else {
        el = document.createElement("div");
        el.className = "log-chunk";
        el.dataset.chunk = String(ci);
        // 按序插入：找第一个已挂载且序号更大的兄弟插它前面；否则追加到末尾
        let inserted = false;
        for (const child of Array.from(this.view.children) as HTMLElement[]) {
          const other = Number(child.dataset.chunk);
          if (Number.isFinite(other) && other > ci) {
            this.view.insertBefore(el, child);
            inserted = true;
            break;
          }
        }
        if (!inserted) this.view.appendChild(el);
      }
      this.chunks[ci] = el;
    }
    el.style.minHeight = "";
    const f = this.quickFilter;
    const start = ci * this.rowsPerPage;
    const end = Math.min(start + this.rowsPerPage, this.rows.length);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const row = this.rows[i];
      const line = this.createLine(row);
      const hide = !!f && (f.regex ? !f.regex.test(row.text) : !row.text.includes(f.text!));
      if (hide) line.classList.add("hidden");
      frag.appendChild(line);
    }
    el.replaceChildren(frag);
  }

  /** 卸载 chunk：清空内容保留容器，高度改为实测（首查）或估算占位 */
  private unmountChunk(ci: number) {
    const el = this.chunks[ci];
    if (!el) return;
    let h = this.chunkHeights[ci];
    if (!h) {
      h = el.offsetHeight || this.estimateChunkHeight(ci);
      this.chunkHeights[ci] = h;
    }
    el.replaceChildren();
    el.style.minHeight = h > 0 ? `${h}px` : "";
    // 关键：槽位置空，让 ensureWindow 能重新挂载；占位容器留在 DOM 稳住滚动高度，
    // fillChunk 会优先复用该容器重新填充内容，避免向上翻页出现空白。
    this.chunks[ci] = null;
  }

  /** 估算 chunk 高度：行数 × 行高（未测量时的兜底） */
  private estimateChunkHeight(ci: number): number {
    const rh = parseFloat(this.rowCss || "0") || 0;
    const start = ci * this.rowsPerPage;
    const count = Math.max(0, Math.min(this.rowsPerPage, this.rows.length - start));
    return rh > 0 ? count * rh : 0;
  }

  /** 懒加载窗口：视口 ±pageBuffer 页内装载，页外卸载 */
  private ensureWindow() {
    const el = this.view;
    if (!el.clientHeight || !this.chunks.length) return;
    const chunkH = el.scrollHeight / this.chunks.length; // 行高恒定 → 每页近等高
    const first = Math.max(0, Math.floor(el.scrollTop / chunkH) - this.pageBuffer);
    const last = Math.min(this.chunks.length - 1, Math.ceil((el.scrollTop + el.clientHeight) / chunkH) + this.pageBuffer);
    for (let i = 0; i < this.chunks.length; i++) {
      const inWin = i >= first && i <= last;
      if (inWin && this.chunks[i] === null) this.fillChunk(i);
      else if (!inWin && this.chunks[i] !== null) this.unmountChunk(i);
    }
  }

  /** rowsPerPage 变更 / HEX 切换后重建：清空 DOM 全部重排，按滚动比例恢复位置 */
  private rebuildChunks() {
    const el = this.view;
    const total = el.scrollHeight;
    const keepRatio = total > 0 ? el.scrollTop / total : 0;
    el.replaceChildren();
    this.chunks = [];
    this.chunkHeights = [];
    this.growChunks();
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i] === null) this.fillChunk(i);
    }
    el.scrollTop = keepRatio * el.scrollHeight;
    this.ensureWindow();
  }

  /** 新建一行 DOM（dataset.raw 供快捷过滤/测试用） */
  private createLine(row: Row): HTMLElement {
    const div = document.createElement("div");
    div.className = "log-line";
    div.dataset.raw = row.text;
    if (row.tsText) {
      const ts = document.createElement("span");
      ts.className = "log-ts";
      ts.textContent = row.tsText;
      div.appendChild(ts);
    }
    const content = document.createElement("div");
    content.className = "log-content";
    div.appendChild(content);
    this.appendContentTo(content, row);
    return div;
  }

  /** 把行内容（HEX 或染色段）追加到给定内容块 */
  private appendContentTo(content: HTMLElement, row: Row) {
    if (this.hexDisplay) {
      // HEX 模式：原始字节十六进制（染色让位——二进制没有"颜色语义"）
      const s = document.createElement("span");
      s.className = "log-hex";
      s.textContent = row.rawHex || t("log.empty");
      content.appendChild(s);
      return;
    }
    for (const seg of row.segments) {
      const s = document.createElement("span");
      s.textContent = seg.text;
      if (seg.fg) s.style.color = cssColor(seg.fg);
      if (seg.bg) s.style.backgroundColor = cssColor(seg.bg);
      if (seg.bold) s.classList.add("seg-bold");
      content.appendChild(s);
    }
  }

  /** 生成时间戳串（入队时调用一次；重渲染复用 row.tsText，不重算 delta 基准） */
  private formatTs(tsMs: number, anchorMs: number): string {
    switch (this.getTsMode()) {
      case "relative":
        return `+${tsMs}ms`;
      case "delta": {
        const base = this.lastTs ?? tsMs;
        const d = tsMs - base;
        this.lastTs = tsMs;
        return d >= 0 ? `Δ+${d}ms` : `Δ${d}ms`;
      }
      case "none":
        return "";
      default: {
        // absolute：anchor(墙钟) + monotonic 偏移
        const wall = new Date(anchorMs + tsMs);
        const p = (n: number, w = 2) => String(n).padStart(w, "0");
        return `${p(wall.getHours())}:${p(wall.getMinutes())}:${p(wall.getSeconds())}.${p(wall.getMilliseconds(), 3)}`;
      }
    }
  }

  /** 时间戳模式切换后重置差值基准 */
  resetDeltaBase() {
    this.lastTs = null;
  }

  clear() {
    this.view.replaceChildren();
    this.rows = [];
    this.chunks = [];
    this.chunkHeights = [];
    this.pendingIdx = -1;
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
