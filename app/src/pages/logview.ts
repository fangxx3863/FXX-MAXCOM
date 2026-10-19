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
  /** 行来源方向：rx = 设备发来，tx = 本地回显的本机发送内容（续行沿用首段的方向） */
  dir: "rx" | "tx";
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

/** 转义正则元字符：查找词非法时退化为字面子串匹配（与快捷过滤同策略） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 补渲染 partial 续接行前的能力守卫：序号有效且该 chunk 仍挂载着（未挂载说明不在窗口内） */
function needMergeSafe(ci: number, chunks: (HTMLElement | null)[]): boolean {
  return ci >= 0 && ci < chunks.length && !!chunks[ci];
}

export class LogViewPage {
  private view: HTMLElement;
  private autoscroll: HTMLInputElement;
  private getTsMode: () => string;
  private hexDisplay = false;
  /** 时间戳后是否标 ←/→ 方向（设置开关 ∧ 本地回显，由 main 计算后下发） */
  private dirMark = false;
  private lastTs: number | null = null;
  private quickFilter: QuickFilter | null = null;
  private rowCss = "";

  // ── 查找（Ctrl+F）──
  // 设计前提：查找**不过滤任何行**，全部日志原样保留；命中的行加高亮、命中片段加 <mark>。
  // 这样用户能直接看出命中「散布在日志的哪几段」——这是定位分布的前提条件。
  private findRegex: RegExp | null = null;
  private findText = "";
  /** 命中行下标（升序，预先全量扫出 → 计数与分布刻度都不必等渲染） */
  private findHits: number[] = [];
  /** 当前命中在 findHits 中的序号（-1 = 无） */
  private findCur = -1;
  /** 命中变化回调（main 用它刷新计数与刻度；分布刻度 DOM 由 main 持有） */
  private onFindChange: (() => void) | null = null;

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

  // ── 选中态暂停（selection pause）──
  // 症状：收发区持续收到数据时，按住左键拖选一段文本，只要中途来一条新数据，
  //       **选区会被拽回顶部**，正在做的选择当场报废（想复制一段历史几乎不可能）。
  // 成因：高频实时流下「尾页重渲染 + 程序性贴底」两条路径都会动 DOM：
  //   · renderTail() 会 fillChunk(尾页) —— 该页含用户正在拖选的节点 → 选中段落被换掉；
  //   · append 的贴底会把 scrollTop 顶到最新 → 用户视口被搬走，拖选跟着跳。
  // 修法：**只要视图里有非空选区，就把实时流的 DOM 更新整段延后**（append 照常入队数据
  //       与时间戳，只不碰 DOM），待 selectionchange 报「选区消失」再一次性补渲染 + 补贴底。
  //       —— 用户看得见的内容在此期间完全静止，选区因此不可能被冲掉。
  // 边界（都刻意保留）：
  //   · 用户手动滚动 / 拖滚动条照常工作（那正是「我要离开底部」的表态），本机制只冻结渲染；
  //   · 用户主动改开关（粘底/HEX/时间戳/过滤/查找）仍然立即生效，不因暂停而失灵；
  //   · 暂停期间行数照常增长（数据不丢），所以暂停前后的 renderTail 只会多做一次尾页重渲染；
  //   · selectionchange 不保证在 headless/桩环境里派发 → 另加 mousedown 同步兜底与轮询兜底，
  //     保证暂停态一定能解除（见 hasLiveSelection / armSelectionProbe）。
  /** 暂停期间累计的、尚未补渲染的批次数（0 = 无待办） */
  private pendingRenders = 0;
  /** 暂停期间是否发生过 partial 续接（需补渲染对应 chunk） */
  private pendingMerge = false;
  /** pendingMerge 时要补渲染的 chunk 序号（-1 = 无） */
  private pendingMergeChunk = -1;
  /** 左键正按在视图内容区（拖选进行中）。selectionchange 是异步派发的，
      从按下到选区成形有一帧空窗——这期间到达的数据仍会动 DOM，必须在
      pointerdown 那一刻就同步暂停，否则正是用户报的「刚选上就被冲掉」。 */
  private pointerSelecting = false;
  /** 探针轮询句柄（selectionchange 缺失环境的兜底；正常浏览器从不启动） */
  private selProbe: number | null = null;

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

  // ── 容器尺寸（侧栏开合 / 窗口缩放 / 浮窗拉伸）──
  /** 上次观察到的滚动容器内部尺寸，用于判重（ResizeObserver 会连发多次） */
  private lastW = 0;
  private lastH = 0;
  private ro: ResizeObserver | null = null;

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
      // 选中态暂停的解除入口：选区一消失就把暂停期间欠下的渲染补齐。
      // 另有 mousedown 同步兜底（下方）——selectionchange 在某些 WebView 组合里不派发。
      if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
        document.addEventListener("selectionchange", () => this.onSelectionMaybeChanged());
      }
      // 按下左键（非滚动条）即进入「选择中」：同步暂停，堵住 selectionchange 的一帧空窗
      this.view.addEventListener("mousedown", (e: MouseEvent) => {
        if (e.button !== 0) return;
        const rect = typeof this.view.getBoundingClientRect === "function" ? this.view.getBoundingClientRect() : null;
        if (rect) {
          const onVertBar = e.clientX - rect.left >= this.view.clientWidth;
          const onHorzBar = e.clientY - rect.top >= this.view.clientHeight;
          if (onVertBar || onHorzBar) return; // 滚动条拖拽不是选择，照常实时渲染
        }
        this.pointerSelecting = true;
      });
      // 松手即重判：拖出选区 → 继续暂停（用户要复制）；只是点一下 → 立即恢复实时
      const endPointerSelect = () => {
        this.pointerSelecting = false;
        this.onSelectionMaybeChanged();
      };
      if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        window.addEventListener("pointerup", endPointerSelect);
        window.addEventListener("pointercancel", endPointerSelect);
        window.addEventListener("blur", endPointerSelect);
      }
      // 鼠标按下也清一次「待补渲染」：双击选中、拖选结束后的下一次点击会先走这里，
      // 即便 selectionchange 不来，视口也会在用户下一次交互时立刻恢复最新。
      this.view.addEventListener("mouseup", () => this.onSelectionMaybeChanged());
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
    this.observeSize();
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

  /**
   * 视图内是否存在**非空**选区（含跨出视图的锚点/焦点在视图内的情况）。
   * 返回 false 时调用方可以安全地动 DOM（重渲染、贴底）而不会打断用户的选择。
   * 叠加 pointerSelecting：从按下左键到选区成形之间 selectionchange 还没来得及派发，
   * 这段空窗必须当作「正在选择」处理，否则第一批数据仍会把刚成形的选区冲掉。
   * 能力守卫：selectionchange 之外的桩环境（jsdom）可能没有 getSelection。
   */
  private hasLiveSelection(): boolean {
    if (this.pointerSelecting) return true;
    const sel = typeof window !== "undefined" && typeof window.getSelection === "function" ? window.getSelection() : null;
    if (!sel) return false;
    if (sel.isCollapsed) return false;
    const node = sel.anchorNode ?? sel.focusNode;
    if (!node) return false;
    if (typeof this.view.contains !== "function") return false;
    const el = node instanceof Node ? (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)) : null;
    return !!(el && this.view.contains(el));
  }

  /**
   * 选中态开始/结束的监听入口。
   * 只在「有非空选区 → 无」的跳变上做补渲染，中间态一律忽略：拖选过程中浏览器会
   * 连发多次 selectionchange，若每次都去补渲染就等于没有暂停。
   * 桩环境无 selectionchange 时启用轮询兜底（见 armSelectionProbe）。
   */
  private onSelectionMaybeChanged(): void {
    if (this.hasLiveSelection()) {
      this.armSelectionProbe();
      return;
    }
    this.flushPausedRenders();
  }

  /** selectionchange 缺失时的兜底：60ms 轮询一次选区是否消失（与 60fps 渲染节奏同量级） */
  private armSelectionProbe(): void {
    if (this.selProbe !== null) return;
    if (typeof window === "undefined" || typeof window.setInterval !== "function") return;
    this.selProbe = window.setInterval(() => {
      if (this.hasLiveSelection()) return;
      this.stopSelectionProbe();
      this.flushPausedRenders();
    }, 60);
  }

  private stopSelectionProbe(): void {
    if (this.selProbe === null) return;
    if (typeof window !== "undefined" && typeof window.clearInterval === "function") {
      window.clearInterval(this.selProbe);
    }
    this.selProbe = null;
  }

  /** 选区消失后一次性补齐暂停期间欠下的 DOM 更新（幂等：无欠账即空转） */
  private flushPausedRenders(): void {
    this.stopSelectionProbe();
    if (!this.pendingRenders && !this.pendingMerge) return;
    const needTail = this.pendingRenders > 0;
    const mergeCi = this.pendingMergeChunk;
    this.pendingRenders = 0;
    this.pendingMerge = false;
    this.pendingMergeChunk = -1;
    if (needMergeSafe(mergeCi, this.chunks)) this.fillChunk(mergeCi);
    if (needTail) {
      this.growChunks();
      this.renderTail();
      // 粘底：恢复暂停前的跟随意图（暂停期间开关未被改写，这里只是补上被延后的贴底）
      if (this.autoscroll.checked) this.scrollToBottom();
      this.ensureWindow();
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

  /**
   * 时间戳后是否标方向（← 接收 / → 发送）。
   *
   * 只影响渲染，不改数据层：方向是逐行事实（`Row.dir`），开关随时可来回切。
   * 重渲染当前已挂载的 chunk 即可——未挂载的占位容器会在下次 `ensureWindow` 装载时
   * 按新开关渲染，所以不必整窗重建（那会把滚动位置也一并重置）。
   */
  setDirMark(on: boolean) {
    if (on === this.dirMark) return;
    this.dirMark = on;
    this.forEachMountedChunk((ci) => this.fillChunk(ci));
  }

  /** 当前是否标方向（供测试/调试） */
  get dirMarkEnabled(): boolean {
    return this.dirMark;
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

  // ── 查找（Ctrl+F）：定位分布 ──
  // 与「快捷过滤」相反：过滤是从视图中剔除，查找是**全部保留 + 高亮命中**。
  // 因此这里只往命中行加类、给片段套 <mark>，行数与会话内容完全不变。

  /** 注入变更回调（分布刻度与计数文案由 main 统一渲染） */
  bindFindUi(onChange: () => void): void {
    this.onFindChange = onChange;
  }

  /** 命中行下标（供 main 画分布刻度与计数） */
  get findMatches(): readonly number[] {
    return this.findHits;
  }

  get findCurrent(): number {
    return this.findCur;
  }

  /** 当前查找词（用于状态提示） */
  get findQuery(): string {
    return this.findText;
  }

  /** 该行是否命中（供渲染期判定） */
  private rowHits(row: Row): boolean {
    const re = this.findRegex;
    if (!re) return false;
    re.lastIndex = 0;
    return re.test(this.rowSearchText(row));
  }

  /** 查找的检索面：与当前显示一致（HEX 模式检索 HEX 串，否则检索解码文本） */
  private rowSearchText(row: Row): string {
    return this.hexDisplay ? row.rawHex || "" : row.text;
  }

  /**
   * 设置查找词并全量重扫。
   * 全量扫描（而非仅扫已挂载 chunk）是刻意的：只有扫完全部行，才能算出总命中数与
   * 分布刻度；代价是 O(行数) 的正则匹配，对数万行日志仍在毫秒级。
   */
  setFind(pattern: string) {
    const p = pattern.trim();
    if (!p) {
      this.clearFind();
      return;
    }
    // 与快捷过滤同策略：非法正则退化为转义后的子串匹配
    try {
      this.findRegex = new RegExp(p, "gi");
    } catch {
      this.findRegex = new RegExp(escapeRegExp(p), "gi");
    }
    this.findText = p;
    const hits: number[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      if (this.rowHits(this.rows[i])) hits.push(i);
    }
    this.findHits = hits;
    // findCur 的语义是「在 findHits 中的序号」（findStep/渲染计数都按序号用），
    // 因此重扫后只需把序号夹回有效范围，改词时尽量停留在同一命中附近，
    // 而不是拿序号去和「行号」比对（那样会算出越界序号 → 计数显示成 5/1）。
    this.findCur = this.findHits.length ? Math.min(Math.max(this.findCur, 0), this.findHits.length - 1) : -1;
    this.forEachMountedChunk((ci) => this.fillChunk(ci));
    this.onFindChange?.();
  }

  clearFind() {
    this.findRegex = null;
    this.findText = "";
    this.findHits = [];
    this.findCur = -1;
    this.forEachMountedChunk((ci) => this.fillChunk(ci));
    this.onFindChange?.();
  }

  /** 在命中之间跳转：dir=1 下一个 / -1 上一个。返回是否发生跳转 */
  findStep(dir: 1 | -1): boolean {
    if (!this.findHits.length) return false;
    const n = this.findHits.length;
    if (this.findCur < 0) {
      this.findCur = dir > 0 ? 0 : n - 1;
    } else {
      this.findCur = (this.findCur + dir + n) % n;
    }
    const rowIdx = this.findHits[this.findCur];
    this.forEachMountedChunk((ci) => this.fillChunk(ci));
    this.scrollRowIntoView(rowIdx);
    this.onFindChange?.();
    return true;
  }

  /**
   * 滚动到指定行：先把该行所在 chunk 挂载出来，再滚进视口。
   *
   * 两个必须守住的点（都踩过）：
   *
   * 1. **不要用 `chunk.offsetTop + line.offsetTop` 求目标位置。**
   *    `.log-chunk` 是 `position: static`，所以 `.log-line` 的 `offsetTop` 并不相对
   *    chunk，而是相对最近的定位祖先（即滚动容器本身）。两者相加等于把偏移算了
   *    两遍：chunk 0 时 `chunkTop≈0` 看不出问题，一旦跨到后面的 chunk，目标位置
   *    就会翻倍偏下，命中行被丢在视口上方 → 表现为「从后往前跳转时定位不到行」。
   *    改用 `getBoundingClientRect` 直接量出**行相对视口**的偏移，再叠加当前
   *    `scrollTop`，与 offsetParent 是谁完全无关。
   *
   * 2. **需要「两轮」收敛。** 挂载目标 chunk 会改变它上方 chunk 的累计高度
   *    （未访问过的 chunk 此前只有估算高度），并且装载窗口会随新的 scrollTop
   *    变化，所以赋完 scrollTop 后要再跑一轮 `ensureWindow` 并校正落点。
   */
  private scrollRowIntoView(rowIdx: number) {
    if (rowIdx < 0) return;
    const ci = Math.floor(rowIdx / this.rowsPerPage);
    if (this.chunks[ci] === null || this.chunks[ci] === undefined) {
      // 目标页未挂载：先把它换进来（fillChunk 会撑起估算高度）
      this.fillChunk(ci);
    }
    const place = (): boolean => {
      const chunk = this.chunks[ci];
      const line = chunk?.children[rowIdx - ci * this.rowsPerPage] as HTMLElement | undefined;
      if (!line || typeof line.getBoundingClientRect !== "function") return false;
      // 行相对**视口**的偏移换算成相对滚动容器内容的偏移，再叠加当前 scrollTop
      const target = line.getBoundingClientRect().top - this.view.getBoundingClientRect().top + this.view.scrollTop;
      const h = this.view.clientHeight || 0;
      const visTop = this.view.scrollTop;
      const visBottom = visTop + h;
      if (target >= visTop && target + (line.offsetHeight || 0) <= visBottom) return true; // 已在视口内，不必动
      // 放到视口上 1/3 处，让上下文（前后各若干行）同时可见
      this.view.scrollTop = Math.max(0, target - Math.floor(h / 3));
      return true;
    };
    if (!place()) return;
    // 挂载窗口随新的 scrollTop 变化 → 上方 chunk 可能装卸，几何再次改变 → 校正一次
    this.ensureWindow();
    place();
  }

  /** 对当前已挂载的 chunk 执行回调（重渲染以让 <mark> 生效） */
  private forEachMountedChunk(fn: (ci: number) => void) {
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i]) fn(i);
    }
  }

  /** 当前窗口的历史快照：沿用当前时间戳、HEX 显示、方向标记及快捷过滤状态 */
  historyText(): string {
    const lines: string[] = [];
    for (const row of this.rows) {
      if (!this.rowVisible(row)) continue;
      const body = this.hexDisplay ? row.rawHex || t("log.empty") : row.text;
      const mark = this.dirMark ? dirGlyph(row.dir) + " " : "";
      lines.push(row.tsText ? row.tsText.padEnd(12) + " " + mark + body : mark + body);
    }
    return lines.length ? lines.join("\n") + "\n" : "";
  }

  /** 收到批量日志条目：入队数据模型 + 追加/刷新渲染（成本恒定，与总行数无关） */
  append(batch: EntriesBatch) {
    this.refreshRowHeight();
    let appendedRows = 0;
    let mergedChunk = -1; // 本批若发生了 partial 续接，该行所在 chunk 需刷新
    // 选中态暂停：视图里有非空选区时，本批只入队数据、不动 DOM（renderTail/fillChunk/贴底
    // 全部延后到 flushPausedRenders）。否则用户正在拖选的尾页节点会被换掉、视口被贴底搬走，
    // 选区当场报废。行数照常增长 → 数据不丢，只是晚一点显示。
    const paused = this.hasLiveSelection();
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
        dir: item.dir === "tx" ? "tx" : "rx", // 缺省/未知一律按接收，老后端也能用
      };
      this.rows.push(row);
      if (isPartial) this.pendingIdx = this.rows.length - 1;
      appendedRows++;
    }
    if (paused) {
      // 只记账，不渲染。ensureWindow 也跳过：滚动位置没变，装载窗口无需重算。
      if (appendedRows > 0) this.pendingRenders++;
      if (mergedChunk >= 0) {
        this.pendingMerge = true;
        if (mergedChunk > this.pendingMergeChunk) this.pendingMergeChunk = mergedChunk;
      }
      return;
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
      const ci = this.chunks.length;
      this.chunks.push(null);
      // 新槽位一律先写入**估算**高度，绝不留 0：0 会让 scrollHeight 虚低，
      // 进而使 scrollTop 被浏览器钳制 —— 向上（向前）跳转到远处的命中行时，
      // 目标和实际能滚到的位置差出成千像素，表现为「跳不过去 / 定位不到行」。
      this.chunkHeights.push(this.estimateChunkHeight(ci));
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
      const existing = this.chunkEl(ci);
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
    // 先把容器撑到已记录的高度（实测值，或 growChunks 写下的估算值）。
    // 这一步对「向上跳转到未访问过的 chunk」至关重要：若不撑，该容器高度为 0，
    // 它上方所有 chunk 的 offsetTop 都会偏小，scrollHeight 也随之虚低，
    // scrollTop 被钳制 → 目标行滚不进视口。填内容后再由 unmountChunk 换成实测值。
    const known = this.chunkHeights[ci];
    el.style.minHeight = known > 0 ? `${known}px` : "";
    const start = ci * this.rowsPerPage;
    const end = Math.min(start + this.rowsPerPage, this.rows.length);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const row = this.rows[i];
      const line = this.createLine(row, i);
      if (!this.rowVisible(row)) line.classList.add("hidden");
      frag.appendChild(line);
    }
    el.replaceChildren(frag);
    // 填充后以实测高度为准回写（min-height 只是下限；内容更高时容器会自然撑开）。
    // 这样滚动高度随访问逐步收敛到真实值，向上跳转的落点也随之准确。
    const measured = el.offsetHeight;
    if (measured > 0) this.chunkHeights[ci] = measured;
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

  /** 估算 chunk 高度：行数 × 行高（未测量时的兜底；不含折行，故只作下限用） */
  private estimateChunkHeight(ci: number): number {
    const rh = parseFloat(this.rowCss || "0") || 0;
    return rh > 0 ? this.chunkRowCount(ci) * rh : 0;
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

  /**
   * 监听滚动容器自身的尺寸变化，并在**宽度**变化时作废高度缓存。
   *
   * 为什么必须盯着它：`chunkHeights` 与占位容器的 `min-height` 都是**实测值**，
   * 而实测高度取决于当时的容器宽度（长行折不折行）。宽度一变（开合侧栏、缩放窗口、
   * 拉伸浮窗），这些值就不再代表真实布局，而且**没有任何其他代码会知道**——
   * 行本身没变、数据没来、滚动事件也不会因为一次纯布局变化而必然发生。
   *
   * 不修的症状（2026-10 真实浏览器复现）：侧栏打开时某页被记成 2071px，关闭侧栏后
   * 宽布局下真实只有 950px，但占位容器仍按 2071px 撑着 —— scrollHeight 虚高 1824px，
   * 而"跟随最新"会一路贴底，正好落进这段被撑出来的空隙：收发区一行都看不见，
   * 数据却仍在到达、开关也没被关掉。点开侧栏（宽度又变）才会歪打正着地重新可见。
   *
   * jsdom 不做布局、也没有 ResizeObserver，此路径只能由真实浏览器回归覆盖
   * （见 scripts/log-resize-test.mjs）。
   */
  private observeSize() {
    if (this.ro) return; // 重复 observe 会叠加回调
    if (typeof ResizeObserver === "undefined") return;
    this.lastW = this.view.clientWidth;
    this.lastH = this.view.clientHeight;
    this.ro = new ResizeObserver(() => this.onViewResize());
    this.ro.observe(this.view);
  }

  /** 容器尺寸变化：宽度变化 → 作废高度缓存并重测；仅高度变化 → 重排装载窗口即可 */
  private onViewResize() {
    const w = this.view.clientWidth;
    const h = this.view.clientHeight;
    if (w === this.lastW && h === this.lastH) return;
    // lastW 为 0 说明还没拿到过有效布局（首帧），此时没有实测值可作废
    const widthChanged = this.lastW > 0 && w !== this.lastW;
    this.lastW = w;
    this.lastH = h;
    if (!this.rows.length) return;
    if (!widthChanged) {
      this.ensureWindow();
      return;
    }
    // 字号可能随缩放一起变（同一次尺寸变化内到达）→ 先钉行高，再谈测量
    this.refreshRowHeight();
    // 撤销高度前先记住用户正在读哪一行，撤销后据此放回去
    const anchor = this.topVisibleRow();
    // 1) 清掉全部容器的旧高度：留着的话，本次测量读到的还是上一个宽度撑出来的值
    for (const child of Array.from(this.view.children) as HTMLElement[]) {
      if (this.chunks[Number(child.dataset.chunk)]) child.style.minHeight = "";
    }
    // 2) 已挂载的页按当前布局重测；未挂载的页用「新的每行平均高度」重估
    //    （比"行数 × 行高"准得多：它把折行也算了进去，而折行正是宽度变化的核心影响）
    let sum = 0;
    let rows = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const el = this.chunks[i];
      if (!el) continue;
      const measured = el.offsetHeight;
      if (measured <= 0) continue;
      this.chunkHeights[i] = measured;
      el.style.minHeight = measured + "px";
      sum += measured;
      rows += this.chunkRowCount(i);
    }
    const perRow = rows > 0 ? sum / rows : 0;
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i]) continue;
      const est = perRow > 0 ? Math.round(perRow * this.chunkRowCount(i)) : this.estimateChunkHeight(i);
      this.chunkHeights[i] = est;
      const ph = this.chunkEl(i); // 未挂载页的占位骨架还在 DOM 里撑着高度
      if (ph) ph.style.minHeight = est > 0 ? est + "px" : "";
    }
    // 3) 窗口按新高度重排，然后把阅读位置放回去（跟随最新 → 贴新底部）
    this.ensureWindow();
    if (this.autoscroll.checked) this.scrollToBottom();
    else if (anchor >= 0) this.alignRowToTop(anchor);
  }

  /** DOM 中序号为 ci 的容器（可能是未挂载的空占位骨架） */
  private chunkEl(ci: number): HTMLElement | undefined {
    return Array.from(this.view.children).find(
      (c) => c instanceof HTMLElement && c.dataset.chunk === String(ci),
    ) as HTMLElement | undefined;
  }

  /** 第 ci 页当前实际持有的行数（末页可能不满） */
  private chunkRowCount(ci: number): number {
    const start = ci * this.rowsPerPage;
    return Math.max(0, Math.min(this.rowsPerPage, this.rows.length - start));
  }

  /**
   * 视口顶部第一行的全局行号（-1 = 视口内没有已挂载的行）。
   * 未挂载的占位骨架没有子行，跳过——它的位置正是待修的对象，不能用来当锚点。
   */
  private topVisibleRow(): number {
    const viewTop = this.view.getBoundingClientRect().top;
    for (const child of Array.from(this.view.children) as HTMLElement[]) {
      const ci = Number(child.dataset.chunk);
      if (!Number.isFinite(ci) || !this.chunks[ci]) continue;
      const lines = child.children;
      for (let k = 0; k < lines.length; k++) {
        if ((lines[k] as HTMLElement).getBoundingClientRect().bottom > viewTop + 1) {
          return ci * this.rowsPerPage + k;
        }
      }
    }
    return -1;
  }

  /**
   * 把指定行贴到视口顶部（容器尺寸变化后恢复阅读位置）。
   * 与 `scrollRowIntoView` 同源的两条纪律：几何一律用 `getBoundingClientRect` 换算
   * （与 `offsetParent` 无关）；赋完 `scrollTop` 后再收敛一轮（挂载目标页会改变其
   * 上方各页的累计高度，装载窗口也随之变化）。
   */
  private alignRowToTop(rowIdx: number) {
    const ci = Math.floor(rowIdx / this.rowsPerPage);
    if (!this.chunks[ci]) this.fillChunk(ci);
    const place = (): boolean => {
      const chunk = this.chunks[ci];
      const line = chunk?.children[rowIdx - ci * this.rowsPerPage] as HTMLElement | undefined;
      if (!line) return false;
      const target = line.getBoundingClientRect().top - this.view.getBoundingClientRect().top + this.view.scrollTop;
      this.view.scrollTop = Math.max(0, target);
      return true;
    };
    if (!place()) return;
    this.ensureWindow();
    place();
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
  private createLine(row: Row, rowIdx: number): HTMLElement {
    const div = document.createElement("div");
    div.className = "log-line";
    div.dataset.raw = row.text;
    // 查找高亮：命中行淡底，当前命中行重底（行本身照常显示，不做任何剔除）
    if (this.findRegex) {
      if (this.findHits.includes(rowIdx)) {
        div.classList.add("find-hit");
        if (this.findHits[this.findCur] === rowIdx) div.classList.add("find-current");
      }
    }
    if (row.tsText) {
      const ts = document.createElement("span");
      ts.className = "log-ts";
      ts.textContent = row.tsText;
      div.appendChild(ts);
    }
    // 方向列：定宽（见 styles.css .log-dir），所以有/无标记的行内容列都对齐。
    // 时间戳模式为 none 时时间戳列不存在，标记自然顶到行首 —— 仍输出（方向是行的事实，
    // 与"是否显示时间戳"无关）。
    if (this.dirMark) {
      const dir = document.createElement("span");
      dir.className = "log-dir " + (row.dir === "tx" ? "dir-tx" : "dir-rx");
      dir.dataset.dir = row.dir;
      dir.textContent = dirGlyph(row.dir);
      dir.title = row.dir === "tx" ? t("log.dir.tx") : t("log.dir.rx");
      div.appendChild(dir);
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
      const hex = row.rawHex || t("log.empty");
      if (this.findRegex) this.appendMarked(s, hex);
      else s.textContent = hex;
      content.appendChild(s);
      return;
    }
    for (const seg of row.segments) {
      const s = document.createElement("span");
      if (seg.fg) s.style.color = cssColor(seg.fg);
      if (seg.bg) s.style.backgroundColor = cssColor(seg.bg);
      if (seg.bold) s.classList.add("seg-bold");
      // 查找高亮：在**段落内部**套 <mark>，因此同一行的多个命中片段各自独立高亮，
      // 且不破坏 ANSI 染色（<mark> 为 inline，颜色继承自外层 span）。
      if (this.findRegex) this.appendMarked(s, seg.text);
      else s.textContent = seg.text;
      content.appendChild(s);
    }
  }

  /**
   * 把 text 按查找正则切分后写入 parent：命中片段包 <mark class="find-mark">，
   * 未命中片段按纯文本。用零宽捕获组切分，保留分隔符于数组奇数位。
   */
  private appendMarked(parent: HTMLElement, text: string) {
    const re = this.findRegex!;
    re.lastIndex = 0;
    if (!re.test(text)) {
      parent.textContent = text;
      return;
    }
    re.lastIndex = 0;
    const parts = text.split(new RegExp(`(${re.source})`, "gi"));
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      // split 的奇数位即被捕获的命中片段
      if (i % 2 === 1) {
        const m = document.createElement("mark");
        m.className = "find-mark";
        m.textContent = parts[i];
        parent.appendChild(m);
      } else {
        parent.appendChild(document.createTextNode(parts[i]));
      }
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
    // 选中态暂停的欠账一并作废：行都没了，补渲染已无意义（探针也停掉，避免空转）
    this.stopSelectionProbe();
    this.pendingRenders = 0;
    this.pendingMerge = false;
    this.pendingMergeChunk = -1;
  }
}

/** 方向标记字形：← 接收（设备 → 主机）/ → 发送（主机 → 设备）。渲染与导出共用同一字形。 */
function dirGlyph(dir: "rx" | "tx"): string {
  return dir === "tx" ? "→" : "←";
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
