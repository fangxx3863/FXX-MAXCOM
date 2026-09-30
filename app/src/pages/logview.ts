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
//
// ── 粘底（自动滚动）──
// 「自动滚动」复选框是唯一权威状态，只在用户主动表态时改写：滚轮/触屏向上、↑、PageUp、Home
// → 解锁；滚轮/触屏向下且已在底部 → 恢复跟随；拖滚动条期间跟手；手动勾选/取消即时生效。
// 数据增长、程序性 scrollToBottom、分页装卸产生的 scroll 一律不改开关，突发数据冲不掉它。
import type { EntriesBatch, LogEntryDto } from "../types";
import { t } from "../i18n";

interface QuickFilter {
  regex?: RegExp;
  text?: string;
}

/** 单行数据（partial 续行已在入队时合并） */
interface Row {
  /** 单调时间戳偏移(ms)：wall = anchor + ts */
  ts: number;
  /** 该行所属 batch 的墙钟锚点(ms)：absolute 模式据此转墙钟，改格式历史重算也需要 */
  anchor: number;
  /** 当前时间戳模式下的时间戳串（none 模式为 ""）；切换模式时按 anchor+ts 重算 */
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

  // ── 粘底（自动滚动）状态机 ──
  // autoscroll.checked 是「是否跟随最新数据」的唯一权威状态，只在**用户主动表态**时改写：
  //   · 手动勾选 / 取消勾选（change）
  //   · 滚轮 / 触屏滑动 向上 → 解锁（用户要看历史）
  //   · 滚轮 / 触屏滑动 向下且此刻已在底部 → 恢复跟随
  //   · 按住原生滚动条拖拽期间随位置实时跟手（拖拽一定是用户造成的）
  // 判定全部在输入事件内部同步完成，不依赖后续 scroll 事件 → 不存在"这次 scroll 到底是谁
  // 造成的"归因歧义。数据增长、程序性 scrollToBottom、分页装卸引发的 scroll 一律不改开关：
  // 否则突发数据会在「内容已变高、尚未重新贴底」的那一帧被误判为离开底部，把开关冲掉。
  /** 是否正按住原生滚动条拖拽（拖拽期间 scroll 均由用户造成） */
  private dragging = false;
  /** 拖拽兜底定时器：万一收不到 pointerup，到时自动解除 dragging */
  private dragGuard: number | null = null;
  /** 是否允许「滚回底部即恢复跟随」。手动取消勾选时置否，用户确实离开过底部后置是，
   *  避免刚取消就在原地被一次不产生位移的滚轮悄悄勾回去。 */
  private relockAllowed = true;
  /** 上一次触屏触点 Y（判定滑动方向；手指下移 = 内容上移 = 看历史） */
  private lastTouchY = 0;

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
    // scroll 只用于懒加载窗口对齐；粘底开关的改判另看输入事件（测试桩可能传纯对象，做能力守卫）
    if (typeof this.view.addEventListener === "function") {
      this.view.addEventListener("scroll", () => this.onScroll());
      this.view.addEventListener("wheel", (e: WheelEvent) => this.onUserWheel(e), { passive: true });
      this.view.addEventListener("keydown", (e: KeyboardEvent) => this.onUserKey(e));
      this.view.addEventListener("pointerdown", (e: PointerEvent) => this.onUserPointerDown(e));
      this.view.addEventListener("touchstart", (e: TouchEvent) => this.onUserTouchStart(e), { passive: true });
      this.view.addEventListener("touchmove", (e: TouchEvent) => this.onUserTouchMove(e), { passive: true });
    }
    if (typeof this.autoscroll.addEventListener === "function") {
      this.autoscroll.addEventListener("change", () => {
        // 手动勾选/取消 = 用户显式表态。程序性赋值 .checked 不派发 change，不会自激。
        this.relockAllowed = this.autoscroll.checked;
        if (this.autoscroll.checked) this.scrollToBottom();
      });
    }
    // 松手/失焦即结束滚动条拖拽（此后残留的 scroll 不再当作拖拽）
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      const endDrag = () => this.endDrag();
      window.addEventListener("pointerup", endDrag);
      window.addEventListener("pointercancel", endDrag);
      window.addEventListener("blur", endDrag);
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

  // ── 用户意图 ──

  /**
   * 统一的「想往上翻 / 想往下翻」判定。全部在输入事件内同步完成，不依赖后续 scroll 事件，
   * 因此内容增长不会污染结论。
   *   up=true  → 用户要看历史：解锁
   *   up=false → 用户要看最新：仅当此刻确实已在底部、且此前确实离开过底部时才恢复跟随
   */
  private onUserScrollIntent(up: boolean): void {
    const atBottom = this.isAtBottom();
    if (!atBottom) this.relockAllowed = true; // 确实离开过底部 → 允许"滚回底部即恢复跟随"
    if (up) this.setSticky(false);
    else if (atBottom && this.relockAllowed) this.setSticky(true);
  }

  private onUserWheel(e: WheelEvent): void {
    if (!e.deltaX && !e.deltaY) return;
    this.onUserScrollIntent(e.deltaY < 0);
  }

  /** 键盘翻页（视图可聚焦时） */
  private onUserKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case "PageUp":
      case "ArrowUp":
      case "Home":
        this.onUserScrollIntent(true);
        break;
      case "PageDown":
      case "ArrowDown":
      case "End":
      case " ":
        this.onUserScrollIntent(false);
        break;
      default:
        break;
    }
  }

  /** 触屏滑动：手指下移 = 内容上移 = 看历史（与滚轮同构） */
  private onUserTouchStart(e: TouchEvent): void {
    const t = e.touches?.[0];
    if (t) this.lastTouchY = t.clientY;
  }

  private onUserTouchMove(e: TouchEvent): void {
    const t = e.touches?.[0];
    if (!t) return;
    const dy = t.clientY - this.lastTouchY;
    this.lastTouchY = t.clientY;
    if (Math.abs(dy) < 1) return;
    this.onUserScrollIntent(dy > 0);
  }

  /** 按住原生滚动条时，随后的 scroll 才算用户手势（点正文/选文本不当作滚动意图） */
  private onUserPointerDown(e: PointerEvent): void {
    const rect = typeof this.view.getBoundingClientRect === "function" ? this.view.getBoundingClientRect() : null;
    if (!rect) return;
    const onVertBar = e.clientX - rect.left >= this.view.clientWidth; // 右缘竖向滚动条
    const onHorzBar = e.clientY - rect.top >= this.view.clientHeight;
    if (!onVertBar && !onHorzBar) return;
    this.dragging = true;
    // 兜底：拖拽被系统接管等异常下收不到 pointerup，超时自动解除，
    // 否则「scroll 改判开关」这条路径会常开 → 正是本次要修掉的病症。
    if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
      if (this.dragGuard !== null) window.clearTimeout(this.dragGuard);
      this.dragGuard = window.setTimeout(() => this.endDrag(), 10_000);
    }
  }

  private endDrag(): void {
    this.dragging = false;
    if (this.dragGuard !== null && typeof window !== "undefined") {
      window.clearTimeout(this.dragGuard);
      this.dragGuard = null;
    }
  }

  /** 滚动事件：懒加载窗口对齐 + 仅「拖拽滚动条」期间跟手改判粘底开关 */
  private onScroll(): void {
    const atBottom = this.isAtBottom();
    if (!atBottom) this.relockAllowed = true;
    // 非拖拽产生的 scroll（程序性贴底、数据增长、分页装卸）一律不改开关
    if (this.dragging) this.setSticky(atBottom && this.relockAllowed);
    this.ensureWindow();
  }

  /** 设置粘底开关（幂等）。程序性赋值 .checked 不派发 change，不会与 change 处理器自激。 */
  private setSticky(on: boolean): void {
    if (this.autoscroll.checked !== on) this.autoscroll.checked = on;
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

  /** 当前窗口的历史快照：沿用当前时间戳、HEX 显示及快捷过滤状态 */
  historyText(): string {
    const lines: string[] = [];
    for (const row of this.rows) {
      if (!this.rowVisible(row)) continue;
      const body = this.hexDisplay ? row.rawHex || t("log.empty") : row.text;
      lines.push(row.tsText ? row.tsText.padEnd(12) + " " + body : body);
    }
    return lines.length ? lines.join("\n") + "\n" : "";
  }

  /** 收到批量日志条目：入队数据模型 + 追加/刷新渲染（成本恒定，与总行数无关） */
  append(batch: EntriesBatch) {
    this.refreshRowHeight();
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
      // 新行：初始时间戳串按入队时刻的模式生成；anchor 一并记录以便切换模式时重算历史
      const row: Row = {
        ts: item.ts_ms,
        anchor: batch.epoch_anchor_ms,
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
    // 粘底：只有开关为「跟随」态时才贴底。不再看 wasBottom——否则用户刻意取消勾选后，
    // 只要恰好停在底部就会被下一批数据拽走，等于开关白关。
    if (appendedRows > 0 && this.autoscroll.checked) {
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
    const start = ci * this.rowsPerPage;
    const end = Math.min(start + this.rowsPerPage, this.rows.length);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const row = this.rows[i];
      const line = this.createLine(row);
      if (!this.rowVisible(row)) line.classList.add("hidden");
      frag.appendChild(line);
    }
    el.replaceChildren(frag);
  }

  /** 快捷过滤命中判定：渲染与导出共用，保证保存内容等同当前窗口。 */
  private rowVisible(row: Row): boolean {
    const f = this.quickFilter;
    if (!f) return true;
    return f.regex ? f.regex.test(row.text) : row.text.includes(f.text!);
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

  /** 时间戳模式切换：对全量历史按新模式重算时间戳串并重渲染（改格式对历史数据也生效）。
     delta 模式按行到达顺序重算差值链；链尾 lastTs 保留，新来的行继续接在链尾。 */
  setTsMode() {
    this.lastTs = null;
    for (const row of this.rows) {
      row.tsText = this.formatTs(row.ts, row.anchor);
    }
    this.rebuildChunks();
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
