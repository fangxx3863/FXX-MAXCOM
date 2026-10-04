// 交互式终端（模式 A）：xterm.js 承担 ANSI 解析与渲染（ADR-0018），击键直传
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { SearchAddon } from "@xterm/addon-search";
import type { SessionApi } from "../api";
import { t } from "../i18n";

export class TerminalPage {
  private term = new Terminal({
    // \n 也视为换行（很多设备只发 \n；标准终端要求 \r\n，这里宽容处理）
    convertEol: true,
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Consolas, "Cascadia Mono", monospace',
    theme: {
      background: "#14161a",
      foreground: "#dce0e8",
      cursor: "#4da3ff",
    },
    scrollback: 10000,
    // SearchAddon 的 decorations（命中高亮 + 滚动条 overview ruler）内部走
    // terminal.registerDecoration()，那是 xterm 的 **proposed API**，不开这个开关
    // 会在 findNext 里抛 "You must set the allowProposedApi option to true"。
    // 抛点发生在 _highlightAllMatches 的 createHighlightDecorations，位于
    // updateResults 之后、fireResults 之前 → 表现为「搜索永远无命中、计数不刷新」。
    allowProposedApi: true,
  });
  private fit = new FitAddon();
  private search = new SearchAddon();
  private lastCols = 0;
  private lastRows = 0;

  // ── 常驻查找条（工具条右侧）──
  private findInput: HTMLInputElement | null = null;
  private findCount: HTMLElement | null = null;
  /** 命中变化回调：转发给 main，用于同步全局计数（终端页与收发页共用一套查找语义） */
  private onSearchResultsCb: ((r: { resultIndex: number; resultCount: number }) => void) | null = null;

  constructor(el: HTMLElement, private api: SessionApi, private onSendError?: (msg: string) => void) {
    // 宿主容器占工具条以下剩余空间；FitAddon 按 parentElement 测量，
    // 若直接以页面为父级会把工具条高度也算进行数 → 内容溢出引发整页滚动
    const host = document.createElement("div");
    host.className = "term-host";
    el.appendChild(host);

    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.open(host);
    this.syncPtySize();
    new ResizeObserver(() => this.syncPtySize()).observe(host);

    this.term.onResize(({ cols, rows }) => {
      if (cols > 0 && rows > 0 && (cols !== this.lastCols || rows !== this.lastRows)) {
        this.lastCols = cols;
        this.lastRows = rows;
        this.api.resizePty(cols, rows).catch(() => {});
      }
    });

    // 击键直传：xterm 给出完整转义序列（方向键等），原样发往端口
    let localEcho = false;
    this.term.onData((data) => {
      this.api
        .send({ text: data, newline: "none" })
        .then(() => {
          if (localEcho) this.term.write(data); // 回显只在写入成功后做
        })
        .catch((e) => this.onSendError?.(t("log.send.error", { e })));
    });

    // 工具条：本地回显 / 清屏
    const bar = document.createElement("div");
    bar.className = "term-bar";
    const echoLabel = document.createElement("label");
    echoLabel.className = "chk";
    const echoChk = document.createElement("input");
    echoChk.type = "checkbox";
    echoChk.addEventListener("change", () => {
      localEcho = echoChk.checked;
    });
    echoLabel.append(echoChk, document.createTextNode(t("term.localEcho")));
    const clearBtn = document.createElement("button");
    clearBtn.textContent = t("term.clear");
    clearBtn.addEventListener("click", () => this.clear());

    // 常驻查找条：放在工具条右侧的空白区（左侧只有「本地回显 / 清屏」，本就空着），
    // 不占额外垂直空间、不需要任何快捷键触发。
    //
    // 为什么不接 Ctrl+F：终端是直通远端的。远端 shell 里 Ctrl+F 有真实用途
    // （readline/emacs 的 forward-char、vim 的翻页等），**拦下来就等于吃掉用户的按键**，
    // 因此这里绝不调 attachCustomKeyEventHandler 去抢 Ctrl+F —— 让 xterm 照常把它
    // 编成 ^F(0x06) 发给远端。查找改为「常驻可见、鼠标点进去打字」。
    const findWrap = document.createElement("div");
    findWrap.id = "term-find";
    const findInput = document.createElement("input");
    findInput.id = "term-find-input";
    findInput.type = "text";
    findInput.spellcheck = false;
    findInput.autocomplete = "off";
    findInput.placeholder = t("find.placeholder");
    findInput.title = t("find.term.title");
    const findCount = document.createElement("span");
    findCount.id = "term-find-count";
    findCount.className = "empty";
    findCount.textContent = t("find.none");
    const mkBtn = (id: string, label: string, title: string) => {
      const b = document.createElement("button");
      b.id = id;
      b.textContent = label;
      b.title = title;
      return b;
    };
    const prevBtn = mkBtn("term-find-prev", "↑", t("find.prev"));
    const nextBtn = mkBtn("term-find-next", "↓", t("find.next"));
    const clearBtn2 = mkBtn("term-find-clear", "✕", t("find.clear"));
    findWrap.append(findInput, findCount, prevBtn, nextBtn, clearBtn2);
    bar.append(echoLabel, clearBtn, findWrap);
    el.prepend(bar);

    this.findInput = findInput;
    this.findCount = findCount;

    findInput.addEventListener("input", () => this.applyTermFind(true));
    findInput.addEventListener("keydown", (e) => {
      // 查找框自身的按键不得穿透到终端：xterm 的 textarea 也在监听，必须止住冒泡。
      // （这是**输入框内**的按键，与「终端里的 Ctrl+F」是两回事，不影响直通。）
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        this.termFindStep(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        // Esc 只清空查找框并清高亮，不隐藏查找条（常驻），焦点交回终端
        e.preventDefault();
        findInput.value = "";
        this.clearSearch();
        this.updateTermFindCount(-1, 0);
        this.term.focus();
      }
    });
    nextBtn.addEventListener("click", () => this.termFindStep(1));
    prevBtn.addEventListener("click", () => this.termFindStep(-1));
    clearBtn2.addEventListener("click", () => {
      findInput.value = "";
      this.clearSearch();
      this.updateTermFindCount(-1, 0);
      this.term.focus();
    });

    // 命中计数由 SearchAddon 的事件回传，统一刷到内联计数与全局查找栏（若同屏开着）
    this.search.onDidChangeResults((r) => {
      const n = r?.resultCount ?? 0;
      const i = r?.resultIndex ?? -1;
      this.updateTermFindCount(i, n);
      this.onSearchResultsCb?.(r);
    });

    // 刻意**不**注册 attachCustomKeyEventHandler：终端是直通远端的，
    // 任何按键（含 Ctrl+F）都要原样送到远端 shell，不能被网页截胡。
    // 查找条常驻在工具条上，用鼠标即可操作，无需快捷键。

    // 原始流由 main 按会话路由进来（feed）；窗口尺寸变化时自适应。
    // 注意：resize 监听挂在 window 上，多标签共享无妨——fit 只作用于本实例。
    window.addEventListener("resize", () => this.fit.fit());
  }

  /** 原始字节流入终端渲染（main 的事件路由按 session 分发） */
  feed(bytes: Uint8Array) {
    this.term.write(bytes);
  }

  writeln(s: string) {
    this.term.writeln(s);
  }

  setFontSize(px: number) {
    this.term.options.fontSize = px;
    this.syncPtySize();
  }

  getCols(): number {
    return this.term.cols || 80;
  }

  getRows(): number {
    return this.term.rows || 24;
  }

  syncPtySize() {
    try {
      this.fit.fit();
    } catch {}
    const cols = this.term.cols;
    const rows = this.term.rows;
    if (cols > 0 && rows > 0 && (cols !== this.lastCols || rows !== this.lastRows)) {
      this.lastCols = cols;
      this.lastRows = rows;
      this.api.resizePty(cols, rows).catch(() => {});
    }
  }

  setTheme(theme: { background: string; foreground: string; cursor: string }) {
    this.term.options.theme = theme;
  }

  clear() {
    // reset 连滚动缓冲一起清（clear() 只清视口上方，用户感知为'没清掉'）
    this.term.reset();
  }

  /** 终端选区文本（右键复制用；xterm 内部选区，与 DOM 选区不同，不能用 window.getSelection()） */
  getSelectionText(): string {
    return this.term.getSelection();
  }

  /** 全选整个滚动缓冲 */
  selectAllTerm() {
    this.term.selectAll();
  }

  /** 粘贴到终端：写入文本并经 onData 发往端口（含本地回显逻辑，与击键同路径） */
  pasteTerm(text: string) {
    if (!text) return;
    this.term.paste(text);
  }

  // ── 查找（Ctrl+F）：xterm 内建滚动缓冲检索 ──
  // xterm 的 SearchAddon 自带 decorations（高亮全部命中 + 当前命中）与 overview ruler
  // （滚动条缩略图，等价于 VSCode 的右侧预览），因此终端页无需自绘高亮层。
  // 计数（第几个/共几个）由 onDidChangeResults 事件回传，交由主窗口统一渲染。

  /** 全部命中的高亮 + 当前命中的强调色 + overview ruler 色（随主题 accent 走） */
  private searchDecorationOptions() {
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#4da3ff";
    const hex = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : "#4da3ff";
    return {
      caseSensitive: false,
      regex: false,
      decorations: {
        matchBackground: hex + "38",       // 半透明底：全部命中
        matchOverviewRuler: hex,
        activeMatchBackground: hex,        // 实色：当前命中
        activeMatchColorOverviewRuler: hex,
      },
    };
  }

  /**
   * 检索并跳到下一个命中（无命中返回 false）。
   * incremental=true 时，若只是把词加长且仍命中，会原地扩展选区而不跳走 —— 边打字边搜的体验。
   *
   * 这里包一层 try：SearchAddon 的高亮装饰走 proposed API，环境异常时内部可能抛错；
   * 一旦抛出，onDidChangeResults 就不会触发，用户会看到「搜了没反应」。
   * 兜底为「不带 decorations 再搜一次」——至少保证计数与跳转可用，只是没有高亮。
   */
  searchNext(term: string, incremental = false): boolean {
    if (!term) {
      this.clearSearch();
      return false;
    }
    try {
      return this.search.findNext(term, { ...this.searchDecorationOptions(), incremental });
    } catch {
      try {
        return this.search.findNext(term, { caseSensitive: false, regex: false, incremental });
      } catch {
        return false;
      }
    }
  }

  searchPrev(term: string): boolean {
    if (!term) return false;
    try {
      return this.search.findPrevious(term, this.searchDecorationOptions());
    } catch {
      try {
        return this.search.findPrevious(term, { caseSensitive: false, regex: false });
      } catch {
        return false;
      }
    }
  }

  /**
   * 注册检索结果回调（resultIndex 0 基 / resultCount 总数）。
   * 注意：SearchAddon 的 onDidChangeResults 在构造期已注册一次（驱动内联计数），
   * 这里只是把同一事件再转发给 main，避免重复 addListener。
   */
  onSearchResults(cb: (r: { resultIndex: number; resultCount: number }) => void): void {
    this.onSearchResultsCb = cb;
  }

  clearSearch(): void {
    this.search.clearDecorations();
  }

  // ── 终端页常驻查找条 ──
  // 说明：终端直通远端，Ctrl+F 必须原样发给远端（见构造器注释），
  // 因此查找条不做快捷键、不做显隐，永远可见，纯鼠标操作。

  /** 聚焦到查找框（供外部调用，例如工具条点击；不拦截任何按键） */
  focusTermFind() {
    this.findInput?.focus();
    this.findInput?.select();
  }

  /** 清空查找框并清高亮 */
  clearTermFind() {
    if (this.findInput) this.findInput.value = "";
    this.clearSearch();
    this.updateTermFindCount(-1, 0);
  }

  /** 按输入框当前词重搜；reset=true 时跳到第一个命中（边打字边搜不跳走） */
  private applyTermFind(reset: boolean) {
    if (!this.findInput) return;
    const v = this.findInput.value;
    if (!v) {
      this.clearSearch();
      this.updateTermFindCount(-1, 0);
      return;
    }
    this.searchNext(v, !reset);
  }

  /** 在命中间跳转（Enter / Shift+Enter / ↑↓ 按钮） */
  private termFindStep(dir: 1 | -1) {
    if (!this.findInput) return;
    const v = this.findInput.value;
    if (!v) return;
    if (dir > 0) this.searchNext(v);
    else this.searchPrev(v);
  }

  private updateTermFindCount(i: number, n: number) {
    if (!this.findCount) return;
    this.findCount.textContent = n > 0 ? t("find.count", { i: i + 1, n }) : t("find.none");
    this.findCount.classList.toggle("empty", n === 0);
  }

  /** 调试/回归探针：读取终端查找的内部状态（生产无副作用，仅只读） */
  debugFindState() {
    return {
      query: this.findInput?.value ?? "",
      count: this.findCount?.textContent ?? "",
      bufferLine0: this.term.buffer.active.getLine(0)?.translateToString(true) ?? "",
      bufferLength: this.term.buffer.active.length,
    };
  }

  /** 调试/回归探针：直接向终端缓冲写入文本（jsdom 下 mock 不产生终端字节，测试用它造数据） */
  debugWrite(text: string) {
    this.term.write(text);
  }
}
