// MAXCOM 前端外壳：多标签页会话管理（每标签=独立串口/TCP 会话）+ 自绘标题栏 +
// 标签持久化（Notepad++ 式恢复）。单会话逻辑整体封装在 SessionApp；
// 标签栏/持久化/事件路由由模块级 TabManager 承担。
import "./styles.css";
import { IS_TAURI, makeApi, closeSession, onRaw, onEntries, onState, pickSavePath } from "./api";
import type { ConnConfig, ConnState, DataFormat, DType, PortInfo, StatsSnapshot } from "./types";
import { createDropdown, type DropdownHandle } from "./dropdown";
import { openContextMenu, commonEditItems, type CtxItem } from "./contextmenu";
import { TerminalPage } from "./pages/terminal";
import { LogViewPage } from "./pages/logview";
import { PlotPage, Y_PRESETS, type PlotLayout, type ViewMode } from "./pages/plot";
import { StatsPage } from "./pages/stats";
import { RulesPanel, type RulesSnapshot } from "./pages/rules";

type PageId = "terminal" | "logview" | "plot" | "stats" | "settings";
const PAGES: readonly PageId[] = ["terminal", "logview", "plot", "stats", "settings"];

interface MsRow {
  enabled: boolean;
  content: string;
  hex: boolean;
  delayMs: number;
}

// ── 设置（全局共享：字体/字号/配色跨标签一致）──
interface AppSettings {
  logSize: number;
  logFamily: string;
  termSize: number;
  theme: string;
}
const DEFAULT_SETTINGS: AppSettings = {
  logSize: 12.5,
  logFamily: 'Consolas, "Cascadia Mono", monospace',
  termSize: 14,
  theme: "dark",
};
const SETTINGS_KEY = "maxcom.settings";
const THEME_PRESETS: Record<string, string> = {
  dark: "dark",
  light: "light",
  midnight: "midnight",
  solar: "solar",
  oled: "oled",
  nord: "nord",
  dracula: "dracula",
  "solar-light": "solar-light",
};

const TERMINAL_THEMES: Record<string, { background: string; foreground: string; cursor: string }> = {
  dark: { background: "#14161a", foreground: "#dce0e8", cursor: "#4da3ff" },
  light: { background: "#f4f6f9", foreground: "#1b1f27", cursor: "#1f6feb" },
  midnight: { background: "#0b1020", foreground: "#d5e2ff", cursor: "#6aa9ff" },
  solar: { background: "#002b36", foreground: "#eee8d5", cursor: "#268bd2" },
  oled: { background: "#000000", foreground: "#e8e8ea", cursor: "#4da3ff" },
  nord: { background: "#2e3440", foreground: "#eceff4", cursor: "#88c0d0" },
  dracula: { background: "#282a36", foreground: "#f8f8f2", cursor: "#bd93f9" },
  "solar-light": { background: "#fdf6e3", foreground: "#586e75", cursor: "#268bd2" },
};

function loadSettings(): AppSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<AppSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
let currentSettings = loadSettings();
applyTheme();

function resolveThemeId(): string {
  if (currentSettings.theme === "system") {
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return THEME_PRESETS[currentSettings.theme] ?? "dark";
}

function applyTheme() {
  document.documentElement.dataset.theme = resolveThemeId();
}

// 跟随系统时监听系统深浅色变化
if (typeof window.matchMedia === "function") {
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  mq.addEventListener?.("change", () => {
    if (currentSettings.theme === "system") applyTheme();
  });
}

function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ── 会话模板：启动时把 #session-root 的静态子树克隆留档，之后每个标签页各克隆一份 ──
const rootEl = document.getElementById("session-root")!;
const PRISTINE: HTMLElement[] = [...rootEl.children].map((n) => n.cloneNode(true) as HTMLElement);
rootEl.replaceChildren();

const BAUD_PRESETS = [
  "1200", "2400", "4800", "9600", "14400", "19200", "28800", "38400", "57600",
  "76800", "115200", "230400", "250000", "460800", "500000", "921600",
  "1000000", "1152000", "1500000", "2000000",
];

function seededMsRows(): MsRow[] {
  return [
    { enabled: true, content: "13 00 FF 88", hex: true, delayMs: 1000 },
    { enabled: true, content: "output string", hex: false, delayMs: 1000 },
  ];
}

/** 发送历史（全局共享，所有标签页共用一份 ↑↓ 历史） */
const HISTORY: string[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem("maxcom.sendhist") ?? "[]");
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
})();
function pushHistory(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const i = HISTORY.indexOf(trimmed);
  if (i >= 0) HISTORY.splice(i, 1);
  HISTORY.unshift(trimmed);
  if (HISTORY.length > 50) HISTORY.pop();
  localStorage.setItem("maxcom.sendhist", JSON.stringify(HISTORY));
}

/** TCP/UDP 主机历史（全局共享） */
function loadTcpHosts(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("maxcom.tcphosts") ?? '["127.0.0.1"]');
    return Array.isArray(v) && v.length ? (v as string[]) : ["127.0.0.1"];
  } catch {
    return ["127.0.0.1"];
  }
}
function saveTcpHost(host: string): string[] {
  const hosts = [...new Set([host, ...loadTcpHosts()])].slice(0, 8);
  localStorage.setItem("maxcom.tcphosts", JSON.stringify(hosts));
  return hosts;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** 串口设备短名：Windows 保留 COMx，Linux/macOS 只显示 ttyUSB/ttyACM/cu.* 等 */
function shortPortName(device: string): string {
  const base = device.replace(/\\/g, "/").split("/").pop() ?? device;
  const m = base.match(/(tty(?:USB|ACM|AMA|S|O|LP|THS|XR)?\d+|cu\.[A-Za-z0-9._-]+|COM\d+)/i);
  return m ? m[0] : base;
}

/** 串口下拉标签：避免 Windows "COM14 | WCH-Link SERIAL (COM14)" 重复显示 COM 号 */
function formatPortLabel(p: PortInfo): string {
  const dev = shortPortName(p.device);
  const desc = (p.description || "").trim();
  if (!desc) return dev;
  const dl = desc.toLowerCase();
  const dvl = dev.toLowerCase();
  const pvl = p.device.toLowerCase();
  if (dl.includes(dvl) || dl.includes(pvl)) return desc;
  return `${dev} | ${desc}`;
}

/** 状态栏/标签标题里的串口长路径也换成短名 */
function displayLabel(label: string): string {
  return label.replace(/\/dev\/[^\s@]+/g, (m) => shortPortName(m));
}

// ══════════════════════════ 单个会话（一个标签页）══════════════════════════
class SessionApp {
  readonly id: string;
  readonly seqNo: number;
  customName: string | null;
  el: HTMLDivElement;

  // 连接态
  connected = false;
  connKind = "serial";
  dtrOn = false;
  rtsOn = false;
  stateLabel: string | null = null;
  lastError: string | null = null;

  currentPage: PageId = "logview";

  // 定时器
  timerHandle: number | null = null; // 定时发送
  msLoopTimer: number | null = null; // 多字符串循环
  private hintTimer: number | null = null;
  private quickFilterTimer: number | null = null;

  api: ReturnType<typeof makeApi>;
  terminalPage!: TerminalPage;
  logViewPage!: LogViewPage;
  plotPage!: PlotPage;
  statsPage!: StatsPage;
  rulesPanel!: RulesPanel;

  connTypeDd!: DropdownHandle;
  portDd!: DropdownHandle;
  baudDd!: DropdownHandle;
  parityDd!: DropdownHandle;
  databitsDd!: DropdownHandle;
  stopbitsDd!: DropdownHandle;
  flowctlDd!: DropdownHandle;
  tsModeDd!: DropdownHandle;
  encodingDd!: DropdownHandle;
  tcpHostDd!: DropdownHandle;
  newlineDd!: DropdownHandle;
  sendModeDd!: DropdownHandle;
  plotFmtDd!: DropdownHandle;
  plotDtypeDd!: DropdownHandle;
  plotEndianDd!: DropdownHandle;
  plotASplitDd!: DropdownHandle;
  plotFrameLenDd!: DropdownHandle;
  plotViewDd!: DropdownHandle;
  plotLayoutDd!: DropdownHandle;
  plotYRangeDd!: DropdownHandle;

  historyIdx = -1;
  msRows: MsRow[];
  private pendingPort: string | null = null;

  constructor(id: string, name: string | null, snap?: Record<string, string>) {
    this.id = id;
    this.seqNo = ++seqCounter;
    this.customName = name;
    this.el = document.createElement("div");
    this.el.className = "session-ui hidden-session";
    for (const n of PRISTINE) this.el.appendChild(n.cloneNode(true));

    this.api = makeApi(id);

    // 快照派生数据先解析（页面构造时要用）
    let rules0: Partial<RulesSnapshot> = {};
    if (snap?.["rulesjson"]) {
      try {
        rules0 = JSON.parse(snap["rulesjson"]) as Partial<RulesSnapshot>;
      } catch {
        /* 忽略坏数据 */
      }
    }
    this.msRows = snap?.["msjson"] ? this.parseMsRows(snap["msjson"]) : seededMsRows();

    this.wireConnectionArea();
    this.wirePages(rules0);
    this.wireLogBar();
    this.wirePanels();
    this.wireSendArea();
    this.wireMultistr();
    this.wirePlotControls();
    this.applySettingsInputs(currentSettings);

    rootEl.appendChild(this.el);

    if (snap) this.applySnapshot(snap);
    void this.refreshPorts();
  }

  private q<T extends HTMLElement>(sel: string): T {
    return this.el.querySelector<T>(sel)!;
  }

  private parseMsRows(json: string): MsRow[] {
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? (v as MsRow[]) : seededMsRows();
    } catch {
      return seededMsRows();
    }
  }

  // ── 顶栏连接区 ──
  private wireConnectionArea() {
    this.connTypeDd = createDropdown({
      items: [
        { value: "serial", label: "串口" },
        { value: "tcp_client", label: "TCP 客户端" },
        { value: "udp_client", label: "UDP" },
      ],
      onChange: (v) => {
        this.connKind = v;
        this.syncConnTypeUI();
      },
    });
    this.q("#conn-type-dd").replaceWith(this.connTypeDd.el);

    this.portDd = createDropdown({ items: [], placeholder: "选择串口…", width: 260 });
    this.q("#serial-port-dd").replaceWith(this.portDd.el);

    this.baudDd = createDropdown({
      items: BAUD_PRESETS.map((b) => ({ value: b, label: b })),
      value: "115200",
      editable: true,
      placeholder: "波特率",
      width: 120,
    });
    this.q("#baud-dd").replaceWith(this.baudDd.el);

    this.q("#refresh-ports").addEventListener("click", () => void this.refreshPorts());

    const mkin = (id: string, items: string[], initial: string, onChange?: (v: string) => void): DropdownHandle => {
      const dd = createDropdown({ items: items.map((v) => ({ value: v, label: v })), value: initial, onChange });
      this.q(`#${id}-dd`).replaceWith(dd.el);
      return dd;
    };
    this.parityDd = mkin("parity", ["none", "even", "odd"], "none");
    this.databitsDd = mkin("databits", ["8", "7", "6", "5"], "8");
    this.stopbitsDd = mkin("stopbits", ["1", "2"], "1");
    this.flowctlDd = mkin("flowctl", ["none", "software(XON/XOFF)", "hardware(RTS/CTS)"], "none");

    this.tsModeDd = createDropdown({
      items: [
        { value: "absolute", label: "绝对" },
        { value: "relative", label: "相对" },
        { value: "delta", label: "差值 Δ" },
        { value: "none", label: "无" },
      ],
      value: "absolute",
      onChange: () => {
        this.logViewPage.resetDeltaBase();
        this.applyLogOptions();
      },
    });
    this.q("#ts-mode-dd").replaceWith(this.tsModeDd.el);

    this.encodingDd = createDropdown({
      items: [
        { value: "auto", label: "自动" },
        { value: "utf-8", label: "UTF-8" },
        { value: "gbk", label: "GBK" },
        { value: "gb2312", label: "GB2312" },
        { value: "latin-1", label: "Latin-1" },
      ],
      value: "auto",
      onChange: () => this.applyLogOptions(),
    });
    this.q("#encoding-dd").replaceWith(this.encodingDd.el);

    const dtrChk = this.q<HTMLInputElement>("#dtr-chk");
    const rtsChk = this.q<HTMLInputElement>("#rts-chk");
    dtrChk.addEventListener("change", () => {
      this.dtrOn = dtrChk.checked;
      void this.api.setDtr(this.dtrOn).catch((e) => this.setHint(`DTR 设置失败: ${e}`));
    });
    rtsChk.addEventListener("change", () => {
      this.rtsOn = rtsChk.checked;
      void this.api.setRts(this.rtsOn).catch((e) => this.setHint(`RTS 设置失败: ${e}`));
    });

    this.q("#more-serial").addEventListener("click", () => this.q("#serial-setup").classList.toggle("hidden"));
    this.q("#setup-ok").addEventListener("click", () => this.q("#serial-setup").classList.add("hidden"));

    const autoReconnectChk = this.q<HTMLInputElement>("#auto-reconnect");
    autoReconnectChk.addEventListener("change", () => void this.api.setAutoReconnect(autoReconnectChk.checked));

    this.tcpHostDd = createDropdown({
      items: loadTcpHosts().map((h) => ({ value: h, label: h })),
      value: "127.0.0.1",
      editable: true,
      placeholder: "主机",
      width: 150,
    });
    this.q("#tcp-host-dd").replaceWith(this.tcpHostDd.el);

    this.syncConnTypeUI();

    this.q("#connect-btn").addEventListener("click", () => this.toggleConnect());
  }

  refreshTcpHostItems() {
    const cur = this.tcpHostDd.value;
    this.tcpHostDd.setItems(loadTcpHosts().map((h) => ({ value: h, label: h })));
    if (cur) this.tcpHostDd.setValue(cur);
  }

  async refreshPorts() {
    try {
      const ports = await this.api.listPorts();
      this.portDd.setItems(
        ports.map((p) => ({ value: p.device, label: formatPortLabel(p) })),
      );
      // 恢复的端口可能不在当前列表（设备未插上）：setValue 可显示任意值，保住用户配置不被重置
      if (this.pendingPort) {
        this.portDd.setValue(this.pendingPort);
        this.pendingPort = null;
      }
    } catch {
      /* 浏览器演示模式由 mock 提供 */
    }
  }

  private syncConnTypeUI() {
    const isSerial = this.connKind === "serial";
    this.el.querySelectorAll<HTMLElement>(".serial-only").forEach((el) => el.classList.toggle("hidden", !isSerial));
    this.portDd.el.classList.toggle("hidden", !isSerial);
    this.q("#refresh-ports").classList.toggle("hidden", !isSerial);
    this.baudDd.el.classList.toggle("hidden", !isSerial);
    this.tcpHostDd.el.classList.toggle("hidden", isSerial);
    this.q("#tcp-port").classList.toggle("hidden", isSerial);
  }

  private toggleConnect() {
    if (this.connected) {
      void this.api.disconnect();
      return;
    }
    let cfg: ConnConfig;
    if (this.connKind === "serial") {
      cfg = {
        type: "serial",
        port: this.portDd.value,
        baud: Number(this.baudDd.value) || 115200,
        data_bits: Number(this.databitsDd.value) || 8,
        parity: this.parityDd.value as "none" | "even" | "odd",
        stop_bits: this.stopbitsDd.value === "2" ? ("2" as const) : ("1" as const),
        flow_control: this.flowctlDd.value.startsWith("software")
          ? ("software" as const)
          : this.flowctlDd.value.startsWith("hardware")
            ? ("hardware" as const)
            : ("none" as const),
      };
      if (!cfg.port) {
        alert("请先选择串口");
        return;
      }
    } else {
      const tcpCfg = {
        type: this.connKind === "tcp_client" ? ("tcp_client" as const) : ("udp_client" as const),
        host: this.tcpHostDd.value,
        port: Number(this.q<HTMLInputElement>("#tcp-port").value) || 8888,
      };
      cfg = tcpCfg;
      saveTcpHost(tcpCfg.host);
      for (const s of sessions.values()) s.refreshTcpHostItems();
    }
    void this.api.setAutoReconnect(this.q<HTMLInputElement>("#auto-reconnect").checked);
    // 串口默认拉高 DTR/RTS（多数设备期望的打开姿态）
    if (this.connKind === "serial") {
      this.dtrOn = true;
      this.rtsOn = true;
      this.q<HTMLInputElement>("#dtr-chk").checked = true;
      this.q<HTMLInputElement>("#rts-chk").checked = true;
    }
    this.api
      .connect(cfg)
      .then(() => {
        if (this.connKind === "serial") {
          void this.api.setDtr(this.dtrOn).catch(() => {});
          void this.api.setRts(this.rtsOn).catch(() => {});
        }
        // 连接即按当前绘图控件下发格式（默认 ASCII），无需手动点应用
        void this.api.setPlotFormat(this.buildPlotFormat()).catch(() => {});
      })
      .catch((e) => alert(`连接失败: ${e}`));
  }

  /** 连接状态事件（引擎推送，经全局路由进入） */
  applyConnState(s: ConnState) {
    this.connected = s.connected;
    this.stateLabel = s.label ? displayLabel(s.label) : s.label;
    this.lastError = s.error ?? null;
    if (!s.connected) this.terminalPage.clear();
    const dot = this.q("#conn-state");
    dot.className = `dot ${s.connected ? "on" : "off"}`;
    dot.title = s.error ?? (s.connected ? "已连接" : "未连接");
    this.q("#conn-label").textContent = this.stateLabel ?? "";
    this.q("#sb-state").textContent = s.error
      ? `错误: ${s.error}`
      : s.connected
        ? `已连接 ${this.stateLabel ?? ""}`
        : "未连接";
    this.q("#connect-btn").textContent = s.connected ? "断开" : "连接";
    this.q("#connect-btn").classList.toggle("danger", s.connected);
    renderTabs();
  }

  /** 轻提示：发送区 hint + 状态栏短暂红字 */
  setHint(msg: string, isError = true) {
    const hint = this.q("#send-hint");
    if (this.hintTimer !== null) window.clearTimeout(this.hintTimer);
    hint.textContent = msg;
    hint.style.color = isError ? "var(--err)" : "var(--ok)";
    this.q("#sb-state").style.color = isError ? "var(--err)" : "";
    this.hintTimer = window.setTimeout(() => {
      hint.textContent = "";
      this.q("#sb-state").style.color = "";
    }, 4000);
  }

  // ── 页面构建与切换 ──
  private wirePages(rules0: Partial<RulesSnapshot>) {
    this.terminalPage = new TerminalPage(this.q("#page-terminal"), this.api, (msg) => this.setHint(msg));
    this.logViewPage = new LogViewPage(this.q("#log-view"), {
      autoscroll: this.q<HTMLInputElement>("#autoscroll"),
      getTsMode: () => this.tsModeDd.value,
    });
    this.plotPage = new PlotPage(this.q("#plot-holder"), this.q("#plot-controls"), this.q("#plot-chbar"));
    this.statsPage = new StatsPage(this.q("#page-stats"));
    // 规则面板：初始规则来自标签快照；变更即推本会话引擎，值级持久化交给轮询
    this.rulesPanel = new RulesPanel(this.el, this.api, rules0, () => {});

    this.el.querySelectorAll<HTMLButtonElement>("#sidebar button").forEach((btn) => {
      btn.addEventListener("click", () => this.switchPage(btn.dataset.page as PageId));
    });
  }

  switchPage(id: PageId) {
    this.currentPage = id;
    for (const p of PAGES) this.q(`#page-${p}`).classList.toggle("hidden", p !== id);
    this.el.querySelectorAll<HTMLButtonElement>("#sidebar button").forEach((b) =>
      b.classList.toggle("active", b.dataset.page === id),
    );
    if (id === "plot") this.plotPage.onShow(); // 隐藏期间量不到尺寸，显示后按真实容器重建
    // 强制重新合成一层，清掉 WebView 页面切换后的右缘残影
    requestAnimationFrame(() => {
      const el = this.q<HTMLElement>("#pages");
      el.style.transform = "translateZ(0)";
      requestAnimationFrame(() => (el.style.transform = ""));
    });
  }

  /** 标签页被激活（从后台切到前台）：隐藏期尺寸失真，重建图表 */
  onActivated() {
    if (this.currentPage === "plot" || this.currentPage === "stats") this.plotPage.onShow();
  }

  // ── 日志控制条 ──
  private wireLogBar() {
    this.q("#idle-timeout").addEventListener("change", () => this.applyLogOptions());
    this.q<HTMLInputElement>("#hex-display").addEventListener("change", (e) => {
      const on = (e.target as HTMLInputElement).checked;
      this.logViewPage.setHexDisplay(on);
    });

    this.q("#clear-log").addEventListener("click", () => {
      this.logViewPage.clear();
      void this.api.clearLog();
    });

    this.q("#quick-filter").addEventListener("input", (e) => {
      const v = (e.target as HTMLInputElement).value;
      if (this.quickFilterTimer !== null) window.clearTimeout(this.quickFilterTimer);
      this.quickFilterTimer = window.setTimeout(() => this.logViewPage.setQuickFilter(v), 150);
    });

    this.q("#toggle-multistr").addEventListener("click", () => this.q("#multistr-panel").classList.toggle("hidden"));
    this.q("#ms-close").addEventListener("click", () => this.q("#multistr-panel").classList.add("hidden"));
  }

  applyLogOptions() {
    void this.api
      .setLogOptions({
        idle_timeout_ms: Number((this.q("#idle-timeout") as HTMLInputElement).value) || 10,
        timestamp_mode: this.tsModeDd.value,
        encoding: this.encodingDd.value,
      })
      .catch(() => {});
  }

  // ── 侧栏面板拖宽（按 会话+面板 记忆）──
  private wirePanels() {
    this.makePanelResizable(this.q("#multistr-panel"));
    this.makePanelResizable(this.q("#rules-panel"));
  }

  private makePanelResizable(panel: HTMLElement) {
    const h = document.createElement("div");
    h.className = "panel-resizer";
    h.title = "拖拽调整宽度";
    panel.prepend(h);
    const saved = Number(localStorage.getItem(`maxcom.panelw.${this.id}.${panel.id}`));
    if (saved >= 220) panel.style.width = `${Math.min(760, saved)}px`;
    h.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = panel.getBoundingClientRect().width;
      const move = (ev: PointerEvent) => {
        const w = Math.round(startW + (startX - ev.clientX));
        panel.style.width = `${Math.min(760, Math.max(220, w))}px`;
      };
      const up = () => {
        localStorage.setItem(`maxcom.panelw.${this.id}.${panel.id}`, String(parseInt(panel.style.width)));
        h.removeEventListener("pointermove", move);
        h.removeEventListener("pointerup", up);
      };
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
    });
  }

  // ── 发送区 ──
  private wireSendArea() {
    const sendInput = this.q<HTMLTextAreaElement>("#send-input");
    this.q("#send-btn").addEventListener("click", () => void this.doSend());

    this.newlineDd = createDropdown({
      items: [
        { value: "none", label: "无换行" },
        { value: "\\n", label: "\\n" },
        { value: "\\r", label: "\\r" },
        { value: "\\r\\n", label: "\\r\\n" },
      ],
      value: "none",
    });
    this.q("#send-newline-dd").replaceWith(this.newlineDd.el);

    this.sendModeDd = createDropdown({
      items: [
        { value: "text", label: "文本" },
        { value: "hex", label: "HEX" },
      ],
      value: "text",
    });
    this.q("#send-mode-dd").replaceWith(this.sendModeDd.el);

    // Ctrl+Enter 发送；↑↓ 历史（光标在首行末/尾行首时接管）
    sendInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void this.doSend();
        return;
      }
      if (!HISTORY.length) return;
      // 单行内容时 ↑↓ 直接翻历史；多行编辑退回边界规则
      const singleLine = !sendInput.value.includes("\n");
      const col0 = sendInput.selectionStart === 0 && sendInput.selectionEnd === 0;
      const colEnd =
        sendInput.selectionStart === sendInput.value.length && sendInput.selectionEnd === sendInput.value.length;
      if (e.key === "ArrowUp" && (singleLine || col0)) {
        e.preventDefault();
        this.historyIdx = Math.min(this.historyIdx + 1, HISTORY.length - 1);
        sendInput.value = HISTORY[this.historyIdx];
        sendInput.selectionStart = sendInput.selectionEnd = sendInput.value.length;
      } else if (e.key === "ArrowDown" && (singleLine || colEnd)) {
        e.preventDefault();
        this.historyIdx = Math.max(this.historyIdx - 1, -1);
        sendInput.value = this.historyIdx >= 0 ? HISTORY[this.historyIdx] : "";
        sendInput.selectionStart = sendInput.selectionEnd = sendInput.value.length;
      }
    });

    // 定时发送
    this.q("#timer-send").addEventListener("change", (e) => {
      const on = (e.target as HTMLInputElement).checked;
      if (this.timerHandle !== null) {
        window.clearInterval(this.timerHandle);
        this.timerHandle = null;
      }
      if (on) {
        const ms = Math.max(10, Number(this.q<HTMLInputElement>("#timer-ms").value) || 1000);
        this.timerHandle = window.setInterval(() => void this.doSend(), ms);
      }
    });

    // 文件发送：读原始字节 → HEX 分块，令牌桶按线速放行（每字节约 10bit @8N1）
    this.q("#file-btn").addEventListener("click", () => this.q("#file-input").click());
    this.q("#file-input").addEventListener("change", async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      const fileBtn = this.q<HTMLButtonElement>("#file-btn");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const CHUNK = 512;
      const baud = Math.max(1, Number(this.baudDd.value) || 115200);
      const t0 = performance.now();
      let sentBytes = 0;
      const totalChunks = Math.ceil(bytes.length / CHUNK);
      fileBtn.disabled = true;
      try {
        for (let i = 0; i < totalChunks; i++) {
          const chunk = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
          const hex = [...chunk].map((b) => b.toString(16).padStart(2, "0")).join("");
          await this.api.send({ hex, newline: "none" });
          sentBytes += chunk.length;
          fileBtn.textContent = `发文件 ${Math.min(99, Math.round((sentBytes / bytes.length) * 100))}%`;
          const dueMs = ((sentBytes * 10) / baud) * 1000;
          const wait = dueMs - (performance.now() - t0);
          if (wait > 0) await new Promise((r) => setTimeout(r, Math.ceil(wait)));
        }
        const hint = this.q("#send-hint");
        hint.textContent = `文件已发送: ${file.name} (${bytes.length} B)`;
        setTimeout(() => (hint.textContent = ""), 3000);
      } catch (err) {
        this.setHint(`发文件失败: ${err}`);
      } finally {
        fileBtn.textContent = "发文件";
        fileBtn.disabled = false;
        input.value = "";
      }
    });

    // 接收捕获
    this.q("#capture-btn").addEventListener("click", () => void this.toggleCapture());
  }

  private async doSend(textOverride?: string) {
    const sendInput = this.q<HTMLTextAreaElement>("#send-input");
    const content = textOverride ?? sendInput.value;
    if (!content) return;
    const payload =
      this.sendModeDd.value === "hex"
        ? { hex: content.trim(), newline: this.realNewline() }
        : { text: content, newline: this.realNewline() };
    try {
      await this.api.send(payload);
      if (!textOverride) {
        pushHistory(content);
        this.historyIdx = -1;
      }
    } catch (e) {
      const hint = this.q("#send-hint");
      hint.textContent = `发送失败: ${e}`;
      setTimeout(() => (hint.textContent = ""), 3000);
    }
  }

  private realNewline(): string {
    return this.newlineDd.value.replace(/\\r/g, "\r").replace(/\\n/g, "\n");
  }

  private async toggleCapture() {
    const captureBtn = this.q("#capture-btn");
    const [capturing] = await this.api.captureState();
    if (!capturing) {
      await this.api.startCapture();
      captureBtn.textContent = "■ 停止并保存";
      captureBtn.classList.add("recording");
    } else {
      const path = await pickSavePath("maxcom_capture.bin");
      if (!path) {
        // 浏览器演示模式：mock 直接触发下载
        const n = await this.api.saveCapture("maxcom_capture.bin");
        this.setHint(`已保存捕获 ${n} B`, false);
      } else {
        const n = await this.api.saveCapture(path as string);
        this.setHint(`已保存捕获 ${n} B → ${path}`, false);
      }
      captureBtn.textContent = "● 捕获";
      captureBtn.classList.remove("recording");
    }
  }

  /** 捕获徽标（轮询刷新活动标签） */
  updateCaptureBadge(size: number) {
    const captureBtn = this.q("#capture-btn");
    if (captureBtn.classList.contains("recording")) {
      captureBtn.textContent = `■ 停止并保存 (${(size / 1024).toFixed(1)} KB)`;
    }
  }

  // ── 多字符串面板 ──
  private wireMultistr() {
    this.renderMsRows();

    this.q("#ms-add").addEventListener("click", () => {
      this.msRows.push({ enabled: true, content: "", hex: false, delayMs: 1000 });
      this.persistMs();
      this.renderMsRows();
    });
    this.q("#ms-clear").addEventListener("click", () => {
      this.msRows.length = 0;
      this.persistMs();
      this.renderMsRows();
    });
    this.q("#ms-loop").addEventListener("change", (e) => {
      const on = (e.target as HTMLInputElement).checked;
      if (this.msLoopTimer !== null) {
        window.clearTimeout(this.msLoopTimer);
        this.msLoopTimer = null;
      }
      if (on) {
        const loopOnce = async () => {
          for (const row of this.msRows.filter((r) => r.enabled && r.content)) {
            if (!this.q<HTMLInputElement>("#ms-loop").checked) return;
            await this.sendMsRow(row);
            this.q("#ms-status").textContent = `已发送: ${row.content.slice(0, 24)}`;
            await new Promise((r) => setTimeout(r, Math.max(10, row.delayMs)));
          }
          if (this.q<HTMLInputElement>("#ms-loop").checked) this.msLoopTimer = window.setTimeout(loopOnce, 50);
        };
        void loopOnce();
      } else {
        this.q("#ms-status").textContent = "";
      }
    });
  }

  /** 多字符串行变更 → 随标签快照持久化（轮询比对落盘） */
  private persistMs() {
    markSnapDirty();
  }

  private renderMsRows() {
    const holder = this.q("#ms-rows");
    holder.replaceChildren(
      ...this.msRows.map((row, idx) => {
        const div = document.createElement("div");
        div.className = "ms-row";
        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.checked = row.enabled;
        chk.addEventListener("change", () => {
          row.enabled = chk.checked;
          this.persistMs();
        });
        const input = document.createElement("input");
        input.className = "ms-content";
        input.value = row.content;
        input.placeholder = row.hex ? "HEX 字节，如 13 00 FF" : "字符串内容";
        input.addEventListener("change", () => {
          row.content = input.value;
          this.persistMs();
        });
        const typeBtn = document.createElement("button");
        typeBtn.className = "ms-type";
        typeBtn.textContent = row.hex ? "HEX" : "TXT";
        typeBtn.addEventListener("click", () => {
          row.hex = !row.hex;
          this.persistMs();
          this.renderMsRows();
        });
        const delay = document.createElement("input");
        delay.type = "number";
        delay.className = "ms-delay";
        delay.value = String(row.delayMs);
        delay.min = "10";
        delay.title = "循环发送时本行之后的延时(ms)";
        delay.addEventListener("change", () => {
          row.delayMs = Number(delay.value) || 0;
          this.persistMs();
        });
        const sendOne = document.createElement("button");
        sendOne.textContent = "发送";
        sendOne.addEventListener("click", () => void this.sendMsRow(row));
        const del = document.createElement("button");
        del.textContent = "✕";
        del.title = "删除本行";
        del.addEventListener("click", () => {
          this.msRows.splice(idx, 1);
          this.persistMs();
          this.renderMsRows();
        });
        div.append(chk, input, typeBtn, delay, sendOne, del);
        return div;
      }),
    );
  }

  private async sendMsRow(row: MsRow) {
    if (row.hex) {
      await this.api.send({ hex: row.content, newline: "none" });
    } else {
      await this.api.send({ text: row.content, newline: this.realNewline() });
    }
  }

  // ── 绘图页配置 ──
  private wirePlotControls() {
    this.plotFmtDd = createDropdown({
      items: [
        { value: "ascii_delimited", label: "ASCII 分隔" },
        { value: "simple_binary", label: "Simple Binary" },
        { value: "custom_frame", label: "自定义帧" },
      ],
      value: "ascii_delimited",
      onChange: () => this.applyPlotFmtControls(),
    });
    this.q("#plot-fmt-dd").replaceWith(this.plotFmtDd.el);

    const mkin = (id: string, items: string[], initial: string, onChange?: (v: string) => void): DropdownHandle => {
      const dd = createDropdown({ items: items.map((v) => ({ value: v, label: v })), value: initial, onChange });
      this.q(`#${id}-dd`).replaceWith(dd.el);
      return dd;
    };
    this.plotDtypeDd = mkin(
      "plot-dtype",
      ["uint8", "int8", "uint16", "int16", "uint32", "int32", "float32", "float64"],
      "int16",
    );
    this.plotEndianDd = createDropdown({
      items: [
        { value: "little", label: "小端" },
        { value: "big", label: "大端" },
      ],
      value: "little",
    });
    this.q("#plot-endian-dd").replaceWith(this.plotEndianDd.el);

    this.plotASplitDd = createDropdown({
      items: [
        { value: "channel", label: "分通道" },
        { value: "package", label: "分包·整行覆盖" },
      ],
      value: "channel",
    });
    this.q("#plot-asplit-dd").replaceWith(this.plotASplitDd.el);

    this.plotFrameLenDd = createDropdown({
      items: [
        { value: "fixed", label: "定长字节" },
        { value: "payload", label: "首字节=长度" },
      ],
      value: "fixed",
      onChange: () => {
        this.q("#plot-framelen-fixed").classList.toggle("hidden", this.plotFrameLenDd.value !== "fixed");
      },
    });
    this.q("#plot-framelen-dd").replaceWith(this.plotFrameLenDd.el);
    this.applyPlotFmtControls();

    this.plotViewDd = createDropdown({
      items: [
        { value: "waveform", label: "波形图" },
        { value: "bars", label: "垂直柱状" },
        { value: "both", label: "同屏显示" },
      ],
      value: "waveform",
      onChange: (v) => this.plotPage.setViewMode(v as ViewMode),
    });
    this.q("#plot-view-dd").replaceWith(this.plotViewDd.el);

    this.plotLayoutDd = createDropdown({
      items: [
        { value: "subplots", label: "分开子图" },
        { value: "overlay", label: "单图叠加" },
      ],
      value: "subplots",
      onChange: (v) => this.plotPage.setLayout(v as PlotLayout),
    });
    this.q("#plot-layout-dd").replaceWith(this.plotLayoutDd.el);

    this.plotYRangeDd = createDropdown({
      items: [
        { value: "auto", label: "自动缩放" },
        { value: "s8", label: "int8: -128~127" },
        { value: "u8", label: "uint8: 0~255" },
        { value: "s16", label: "int16: ±32768" },
        { value: "u16", label: "uint16: 0~65535" },
        { value: "s32", label: "int32: ±2³¹" },
        { value: "u32", label: "uint32: 0~2³²" },
        { value: "pm1", label: "-1 ~ 1" },
        { value: "pm100", label: "-100 ~ 100" },
        { value: "pm1000", label: "-1000 ~ 1000" },
        { value: "custom", label: "自定义…" },
      ],
      value: "auto",
      onChange: (v) => this.applyYRangeSelection(v),
    });
    this.q("#plot-yrange-dd").replaceWith(this.plotYRangeDd.el);

    this.q("#plot-ymin").addEventListener("change", () => this.applyCustomYRange());
    this.q("#plot-ymax").addEventListener("change", () => this.applyCustomYRange());

    this.q("#plot-buffer").addEventListener("change", (e) => {
      const cap = Number((e.target as HTMLInputElement).value) || 10000;
      void this.api.setPlotBuffer(cap);
    });

    this.q("#plot-apply").addEventListener("click", () => {
      void this.api.setPlotFormat(this.buildPlotFormat());
    });
  }

  private applyPlotFmtControls() {
    const fmt = this.plotFmtDd.value;
    const binLike = fmt === "simple_binary" || fmt === "custom_frame";
    this.q("#plot-ch-ctl").classList.toggle("hidden", !binLike);
    this.q("#plot-ascii-ctl").classList.toggle("hidden", fmt !== "ascii_delimited");
    this.q("#plot-custom-ctl").classList.toggle("hidden", fmt !== "custom_frame");
  }

  private applyYRangeSelection(v: string) {
    const customCtl = this.q("#plot-ycustom-ctl");
    if (v === "custom") {
      customCtl.classList.remove("hidden");
      this.applyCustomYRange();
    } else {
      customCtl.classList.add("hidden");
      if (Y_PRESETS[v] !== undefined) this.plotPage.setYRange(v);
    }
  }

  private applyCustomYRange() {
    const lo = Number((this.q("#plot-ymin") as HTMLInputElement).value);
    const hi = Number((this.q("#plot-ymax") as HTMLInputElement).value);
    if (Number.isFinite(lo) && Number.isFinite(hi)) this.plotPage.setYRangeCustom(lo, hi);
  }

  /** 从绘图控件读取当前格式配置（应用按钮 / 连接时自动下发共用） */
  buildPlotFormat(): DataFormat {
    const channels = Math.max(1, Number((this.q("#plot-channels") as HTMLInputElement).value) || 1);
    if (this.plotFmtDd.value === "simple_binary") {
      return {
        type: "simple_binary",
        channel_count: channels,
        dtype: this.plotDtypeDd.value as DType,
        byte_order: this.plotEndianDd.value as "little" | "big",
      };
    }
    if (this.plotFmtDd.value === "custom_frame") {
      return {
        type: "custom_frame",
        frame_header: (this.q("#plot-frame-header") as HTMLInputElement).value.trim(),
        frame_length:
          this.plotFrameLenDd.value === "fixed"
            ? Math.max(1, Number((this.q("#plot-frame-size") as HTMLInputElement).value) || 1)
            : null,
        dtype: this.plotDtypeDd.value as DType,
        byte_order: this.plotEndianDd.value as "little" | "big",
        checksum: (this.q("#plot-checksum") as HTMLInputElement).checked ? "checksum" : "none",
        channel_count: channels,
      };
    }
    // ASCII：channel_count 传 0 → 引擎按首行数据自动探测列数
    return {
      type: "ascii_delimited",
      delimiter: (this.q("#plot-delimiter") as HTMLInputElement).value || ",",
      split: this.plotASplitDd.value as "channel" | "package",
      channel_count: 0,
    };
  }

  // ════════ 快照：随标签持久化 / 复制标签页共用 ════════
  snapshot(): Record<string, string> {
    const r: Record<string, string> = {};
    r["conn.kind"] = this.connKind;
    r["conn.port"] = this.portDd.value;
    r["conn.baud"] = this.baudDd.value;
    r["conn.parity"] = this.parityDd.value;
    r["conn.databits"] = this.databitsDd.value;
    r["conn.stopbits"] = this.stopbitsDd.value;
    r["conn.flowctl"] = this.flowctlDd.value;
    r["conn.tcphost"] = this.tcpHostDd.value;
    r["conn.tcpport"] = (this.q("#tcp-port") as HTMLInputElement).value;
    r["conn.autoreconn"] = this.q<HTMLInputElement>("#auto-reconnect").checked ? "1" : "";
    r["conn.dtr"] = this.dtrOn ? "1" : "";
    r["conn.rts"] = this.rtsOn ? "1" : "";
    r["tsmode"] = this.tsModeDd.value;
    r["encoding"] = this.encodingDd.value;
    r["idletimeout"] = (this.q("#idle-timeout") as HTMLInputElement).value;
    r["hexdisp"] = this.q<HTMLInputElement>("#hex-display").checked ? "1" : "";
    r["autoscroll"] = this.q<HTMLInputElement>("#autoscroll").checked ? "1" : "";
    r["quickfilter"] = (this.q("#quick-filter") as HTMLInputElement).value;
    r["sendmode"] = this.sendModeDd.value;
    r["newline"] = this.newlineDd.value;
    r["timerms"] = (this.q("#timer-ms") as HTMLInputElement).value;
    r["timeron"] = this.q<HTMLInputElement>("#timer-send").checked ? "1" : "";
    r["plot.fmt"] = this.plotFmtDd.value;
    r["plot.channels"] = (this.q("#plot-channels") as HTMLInputElement).value;
    r["plot.dtype"] = this.plotDtypeDd.value;
    r["plot.endian"] = this.plotEndianDd.value;
    r["plot.delimiter"] = (this.q("#plot-delimiter") as HTMLInputElement).value;
    r["plot.asplit"] = this.plotASplitDd.value;
    r["plot.frameheader"] = (this.q("#plot-frame-header") as HTMLInputElement).value;
    r["plot.framelenmode"] = this.plotFrameLenDd.value;
    r["plot.framesize"] = (this.q("#plot-frame-size") as HTMLInputElement).value;
    r["plot.checksum"] = (this.q("#plot-checksum") as HTMLInputElement).checked ? "1" : "";
    r["plot.view"] = this.plotViewDd.value;
    r["plot.layout"] = this.plotLayoutDd.value;
    r["plot.yrange"] = this.plotYRangeDd.value;
    r["plot.ymin"] = (this.q("#plot-ymin") as HTMLInputElement).value;
    r["plot.ymax"] = (this.q("#plot-ymax") as HTMLInputElement).value;
    r["plot.buffer"] = (this.q("#plot-buffer") as HTMLInputElement).value;
    r["rulesjson"] = JSON.stringify(this.rulesPanel.snapshot());
    r["msjson"] = JSON.stringify(this.msRows);
    return r;
  }

  /** 恢复快照：只填控件，不自动连接、不自动启动定时/循环发送 */
  private applySnapshot(r: Record<string, string>) {
    const g = (k: string) => r[k] ?? "";
    if (g("conn.kind")) {
      this.connKind = g("conn.kind");
      this.connTypeDd.setValue(this.connKind);
      this.syncConnTypeUI();
    }
    if (g("conn.port")) {
      this.pendingPort = g("conn.port");
      this.portDd.setValue(g("conn.port"));
    }
    if (g("conn.baud")) this.baudDd.setValue(g("conn.baud"));
    if (g("conn.parity")) this.parityDd.setValue(g("conn.parity"));
    if (g("conn.databits")) this.databitsDd.setValue(g("conn.databits"));
    if (g("conn.stopbits")) this.stopbitsDd.setValue(g("conn.stopbits"));
    if (g("conn.flowctl")) this.flowctlDd.setValue(g("conn.flowctl"));
    if (g("conn.tcphost")) this.tcpHostDd.setValue(g("conn.tcphost"));
    if (g("conn.tcpport")) (this.q("#tcp-port") as HTMLInputElement).value = g("conn.tcpport");
    if (g("conn.autoreconn")) this.q<HTMLInputElement>("#auto-reconnect").checked = true;
    if (g("conn.dtr")) {
      this.dtrOn = true;
      this.q<HTMLInputElement>("#dtr-chk").checked = true;
    }
    if (g("conn.rts")) {
      this.rtsOn = true;
      this.q<HTMLInputElement>("#rts-chk").checked = true;
    }
    if (g("tsmode")) this.tsModeDd.setValue(g("tsmode"));
    if (g("encoding")) this.encodingDd.setValue(g("encoding"));
    if (g("idletimeout")) (this.q("#idle-timeout") as HTMLInputElement).value = g("idletimeout");
    if (g("hexdisp")) {
      const chk = this.q<HTMLInputElement>("#hex-display");
      chk.checked = true;
      this.logViewPage.setHexDisplay(true);
    }
    if (!g("autoscroll")) this.q<HTMLInputElement>("#autoscroll").checked = false;
    if (g("quickfilter")) {
      (this.q("#quick-filter") as HTMLInputElement).value = g("quickfilter");
      this.logViewPage.setQuickFilter(g("quickfilter"));
    }
    if (g("sendmode")) this.sendModeDd.setValue(g("sendmode"));
    if (g("newline")) this.newlineDd.setValue(g("newline"));
    if (g("timerms")) (this.q("#timer-ms") as HTMLInputElement).value = g("timerms");
    if (g("timeron")) this.q<HTMLInputElement>("#timer-send").checked = true; // 仅恢复勾选态，不自动启动
    if (g("plot.fmt")) {
      this.plotFmtDd.setValue(g("plot.fmt"));
      this.applyPlotFmtControls();
    }
    if (g("plot.channels")) (this.q("#plot-channels") as HTMLInputElement).value = g("plot.channels");
    if (g("plot.dtype")) this.plotDtypeDd.setValue(g("plot.dtype"));
    if (g("plot.endian")) this.plotEndianDd.setValue(g("plot.endian"));
    if (g("plot.delimiter")) (this.q("#plot-delimiter") as HTMLInputElement).value = g("plot.delimiter");
    if (g("plot.asplit")) this.plotASplitDd.setValue(g("plot.asplit"));
    if (g("plot.frameheader")) (this.q("#plot-frame-header") as HTMLInputElement).value = g("plot.frameheader");
    if (g("plot.framelenmode")) {
      this.plotFrameLenDd.setValue(g("plot.framelenmode"));
      this.q("#plot-framelen-fixed").classList.toggle("hidden", this.plotFrameLenDd.value !== "fixed");
    }
    if (g("plot.framesize")) (this.q("#plot-frame-size") as HTMLInputElement).value = g("plot.framesize");
    if (g("plot.checksum")) (this.q("#plot-checksum") as HTMLInputElement).checked = true;
    if (g("plot.view")) {
      this.plotViewDd.setValue(g("plot.view"));
      this.plotPage.setViewMode(g("plot.view") as ViewMode);
    }
    if (g("plot.layout")) {
      this.plotLayoutDd.setValue(g("plot.layout"));
      this.plotPage.setLayout(g("plot.layout") as PlotLayout);
    }
    if (g("plot.yrange")) {
      this.plotYRangeDd.setValue(g("plot.yrange"));
      this.applyYRangeSelection(g("plot.yrange"));
    }
    if (g("plot.ymin")) (this.q("#plot-ymin") as HTMLInputElement).value = g("plot.ymin");
    if (g("plot.ymax")) (this.q("#plot-ymax") as HTMLInputElement).value = g("plot.ymax");
    if (g("plot.buffer")) (this.q("#plot-buffer") as HTMLInputElement).value = g("plot.buffer");
    this.applyLogOptions();
  }

  /** 销毁：停定时器 + 摘 DOM；后端会话由 closeSession 回收 */
  destroy() {
    if (this.timerHandle !== null) window.clearInterval(this.timerHandle);
    if (this.msLoopTimer !== null) window.clearTimeout(this.msLoopTimer);
    this.el.remove();
  }

  // ── 设置页输入框（每会话一份 DOM，值全局同步）──
  applySettingsInputs(st: AppSettings) {
    (this.q("#set-log-size") as HTMLInputElement).value = String(st.logSize);
    (this.q("#set-log-family") as HTMLSelectElement).value = st.logFamily;
    (this.q("#set-term-size") as HTMLInputElement).value = String(st.termSize);
    const themeSel = this.q<HTMLSelectElement>("#set-theme");
    if (themeSel) themeSel.value = st.theme;
  }

  wireSettings() {
    const logSizeInput = this.q<HTMLInputElement>("#set-log-size");
    const logFamilySel = this.q<HTMLSelectElement>("#set-log-family");
    const termSizeInput = this.q<HTMLInputElement>("#set-term-size");
    const themeSel = this.q<HTMLSelectElement>("#set-theme");
    logSizeInput.addEventListener("change", () =>
      saveSettings({ ...currentSettings, logSize: Number(logSizeInput.value) || DEFAULT_SETTINGS.logSize }),
    );
    logFamilySel.addEventListener("change", () => saveSettings({ ...currentSettings, logFamily: logFamilySel.value }));
    termSizeInput.addEventListener("change", () =>
      saveSettings({ ...currentSettings, termSize: Number(termSizeInput.value) || DEFAULT_SETTINGS.termSize }),
    );
    themeSel.addEventListener("change", () => saveSettings({ ...currentSettings, theme: themeSel.value }));
    this.q("#set-reset").addEventListener("click", () => saveSettings({ ...DEFAULT_SETTINGS }));
  }
}

// ══════════════════════════ 标签页管理器（模块级）══════════════════════════
const sessions = new Map<string, SessionApp>();
let activeId = "";
let seqCounter = 0;
let renamingId: string | null = null;
let lastSnapJson = "";

const TABS_KEY = "maxcom.tabs.v2";
interface TabStoreEntry {
  id: string;
  name: string | null;
  snap: Record<string, string>;
}
interface TabStore {
  tabs: TabStoreEntry[];
  active: string;
}
const MAX_TABS = 12;

function newSessionId(): string {
  return `t${Date.now().toString(36)}-${(++seqCounter).toString(36)}`;
}

function createSession(name: string | null, snap?: Record<string, string>, id?: string): SessionApp {
  const s = new SessionApp(id ?? newSessionId(), name, snap);
  sessions.set(s.id, s);
  s.wireSettings();
  return s;
}

/** 自动标题：自定义名 > 连接态标签 > 连接参数 > 序号 */
function tabTitle(s: SessionApp): string {
  if (s.customName) return s.customName;
  if (s.connected && s.stateLabel) return s.stateLabel;
  if (s.connKind === "serial" && s.portDd.value) return `${shortPortName(s.portDd.value)} @ ${s.baudDd.value}`;
  if ((s.connKind === "tcp_client" || s.connKind === "udp_client") && s.tcpHostDd.value) {
    const proto = s.connKind === "udp_client" ? "UDP" : "TCP";
    return `${proto} ${s.tcpHostDd.value}:${(s.el.querySelector<HTMLInputElement>("#tcp-port") as HTMLInputElement).value || "8888"}`;
  }
  return `新建 ${s.seqNo}`;
}

function renderTabs() {
  const strip = document.getElementById("tabstrip")!;
  strip.replaceChildren();
  for (const [id, s] of sessions) {
    const tab = document.createElement("div");
    tab.className = `tab${id === activeId ? " active" : ""}`;
    tab.title = s.lastError ? `错误: ${s.lastError}` : tabTitle(s);

    const dot = document.createElement("span");
    dot.className = `tab-dot${s.connected ? " on" : ""}${s.lastError ? " err" : ""}`;

    const label = document.createElement("span");
    label.className = "tab-label";
    if (renamingId === id) {
      label.replaceChildren(makeRenameInput(s));
    } else {
      label.textContent = tabTitle(s);
      label.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startRename(id);
      });
    }

    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "✕";
    close.title = "关闭标签页 (Ctrl+W)";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTabById(id);
    });
    close.addEventListener("auxclick", (e) => e.stopPropagation());

    tab.append(dot, label, close);
    tab.addEventListener("click", () => activate(id));
    tab.addEventListener("auxclick", (e) => {
      if (e.button === 1) closeTabById(id); // 中键关闭
    });
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation(); // 不落入全局右键菜单
      openContextMenu(
        [
          { label: "✏️ 重命名", hint: "双击标签同样有效", action: () => startRename(id) },
          { label: "🧬 复制标签页", hint: "以当前配置新开一个标签", action: () => duplicateTab(id) },
          { sep: true },
          { label: "✕ 关闭", hint: "Ctrl+W", action: () => closeTabById(id) },
          {
            label: "关闭其他标签页",
            action: () => {
              for (const k of [...sessions.keys()]) if (k !== id) closeTabById(k);
            },
          },
          {
            label: "关闭右侧标签页",
            action: () => {
              const ks = [...sessions.keys()];
              for (const k of ks.slice(ks.indexOf(id) + 1)) closeTabById(k);
            },
          },
        ],
        e.clientX,
        e.clientY,
      );
    });
    strip.appendChild(tab);
  }
  const act = sessions.get(activeId);
  document.title = act ? `${tabTitle(act)} · MAXCOM` : "MAXCOM";
}

function makeRenameInput(s: SessionApp): HTMLInputElement {
  const input = document.createElement("input");
  input.value = s.customName ?? "";
  let cancelled = false;
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation(); // 编辑中不触发全局快捷键
    if (ev.key === "Enter") input.blur();
    else if (ev.key === "Escape") {
      cancelled = true;
      input.blur();
    }
  });
  input.addEventListener("blur", () => {
    if (!cancelled) {
      const v = input.value.trim();
      s.customName = v || null; // 空名回退自动标题
      if (v) saveTabs();
    }
    if (renamingId === s.id) renamingId = null;
    renderTabs();
  });
  input.addEventListener("click", (ev) => ev.stopPropagation());
  input.addEventListener("auxclick", (ev) => ev.stopPropagation());
  window.setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
  return input;
}

function startRename(id: string) {
  renamingId = id;
  renderTabs();
}

function activate(id: string) {
  if (!sessions.has(id)) return;
  activeId = id;
  for (const [sid, s] of sessions) s.el.classList.toggle("hidden-session", sid !== id);
  const s = sessions.get(id)!;
  s.onActivated();
  saveTabs();
  markSnapBaseline();
  renderTabs();
}

function newTab(): void {
  if (sessions.size >= MAX_TABS) {
    sessions.get(activeId)?.setHint(`最多 ${MAX_TABS} 个标签页`);
    return;
  }
  const s = createSession(null);
  activate(s.id);
}

function duplicateTab(id: string): void {
  const src = sessions.get(id);
  if (!src || sessions.size >= MAX_TABS) return;
  const snap = deepCopy(src.snapshot());
  delete snap["timeron"]; // 定时发送不随复制带入勾选态
  const s = createSession(null, snap);
  activate(s.id);
}

function closeTabById(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  // 先算邻居（删除后 Map 里就没有它了）：优先右邻，其次左邻
  const ids = [...sessions.keys()];
  const pos = ids.indexOf(id);
  const next = ids[pos + 1] ?? ids[pos - 1] ?? "";
  s.destroy();
  sessions.delete(id);
  closeSession(id); // 后端回收：断开连接、停线程
  if (!sessions.size) {
    const ns = createSession(null); // 关掉最后一张 → 新建默认页
    activate(ns.id);
  } else if (activeId === id) {
    activate(next);
  } else {
    renderTabs();
    saveTabs();
  }
}

function cycleTab(dir: 1 | -1): void {
  const ids = [...sessions.keys()];
  if (ids.length < 2) return;
  const pos = ids.indexOf(activeId);
  activate(ids[(pos + dir + ids.length) % ids.length]);
}

// ── 持久化（Notepad++ 式：结构变化立即存，值变化由轮询比对落盘）──
function saveTabs() {
  const store: TabStore = { tabs: [], active: activeId };
  for (const [id, s] of sessions) store.tabs.push({ id, name: s.customName, snap: s.snapshot() });
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(store));
  } catch {
    /* 存储满等极端情况忽略 */
  }
}

function markSnapBaseline() {
  const s = sessions.get(activeId);
  lastSnapJson = s ? JSON.stringify(s.snapshot()) : "";
}

/** 值级脏标记（多字符串行编辑等主动触发；轮询兜底） */
function markSnapDirty() {
  lastSnapJson = ""; // 下次轮询必落盘
}

setInterval(() => {
  const s = sessions.get(activeId);
  if (!s) return;
  const j = JSON.stringify(s.snapshot());
  if (j !== lastSnapJson) {
    lastSnapJson = j;
    saveTabs();
  }
}, 1200);

// ── 全局事件路由：负载带 session 标签，分发到对应标签页 ──
onRaw((e) => sessions.get(e.session)?.terminalPage.feed(e.bytes));
onEntries((e) => sessions.get(e.session)?.logViewPage.append(e.batch));
onState((e) => sessions.get(e.session)?.applyConnState(e.state));

// ── 轮询循环（只处理活动标签；后台标签数据由引擎缓冲，事件照常追加）──
setInterval(() => {
  const s = sessions.get(activeId);
  if (!s) return;
  void s.api
    .getStats()
    .then((st: StatsSnapshot) => {
      s.statsPage.updateConn(st);
      const sbRx = s.el.querySelector<HTMLElement>("#sb-rx")!;
      const sbTx = s.el.querySelector<HTMLElement>("#sb-tx")!;
      const sbRate = s.el.querySelector<HTMLElement>("#sb-rate")!;
      sbRx.textContent = `RX ${fmtBytes(st.rx_bytes)}`;
      sbTx.textContent = `TX ${fmtBytes(st.tx_bytes)}`;
      sbRate.textContent = `↓ ${st.rx_rate_kbs.toFixed(2)} KB/s ↑ ${st.tx_rate_kbs.toFixed(2)} KB/s`;
    })
    .catch(() => {});
}, 500);

setInterval(() => {
  const s = sessions.get(activeId);
  if (!s || !s.connected) return;
  s.api
    .captureState()
    .then(([capturing, size]) => {
      if (capturing) s.updateCaptureBadge(size);
    })
    .catch(() => {});
}, 500);

setInterval(() => {
  const s = sessions.get(activeId);
  if (!s) return;
  s.api
    .plotSnapshot(2000)
    .then((snap) => {
      if (s.currentPage === "plot") s.plotPage.update(snap);
      if (s.currentPage === "stats") s.statsPage.updateChannels(snap);
    })
    .catch(() => {
      /* 未连接等 */
    });
}, 50);

// ── 设置广播：字体/字号跨所有标签共享 ──
function applySettingsToAll() {
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--log-size", `${currentSettings.logSize}px`);
  rootStyle.setProperty("--log-family", currentSettings.logFamily);
  applyTheme();
  const resolved = resolveThemeId();
  const termTheme = TERMINAL_THEMES[resolved] ?? TERMINAL_THEMES.dark;
  for (const s of sessions.values()) {
    s.applySettingsInputs(currentSettings);
    s.terminalPage.setFontSize(currentSettings.termSize);
    s.terminalPage.setTheme(termTheme);
  }
}

function saveSettings(st: AppSettings) {
  currentSettings = st;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(st));
  applySettingsToAll();
}

// ── 标签栏按钮 / 新建 ──
document.getElementById("tab-new")?.addEventListener("click", () => newTab());

// ── 键盘快捷键：Ctrl+T 新建 / Ctrl+W 关闭 / Ctrl+Tab 切换 ──
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === "t") {
    e.preventDefault();
    newTab();
  } else if (k === "w" && !e.shiftKey) {
    e.preventDefault();
    closeTabById(activeId);
  } else if (e.key === "Tab") {
    e.preventDefault();
    cycleTab(e.shiftKey ? -1 : 1);
  }
});

// ── 自绘标题栏：最小化 / 最大化 / 关闭（Tauri 权限已在 capabilities 开启）──
if (IS_TAURI) {
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    const win = getCurrentWindow();
    document.getElementById("win-min")?.addEventListener("click", () => void win.minimize());
    document.getElementById("win-max")?.addEventListener("click", () => void win.toggleMaximize());
    document.getElementById("win-close")?.addEventListener("click", () => void win.close());
    void win.isMaximized().then((m) => document.getElementById("win-max")?.classList.toggle("maxed", m));
    void win.onResized(() => {
      void win.isMaximized().then((m) => document.getElementById("win-max")?.classList.toggle("maxed", m));
    });
  });
} else {
  document.getElementById("win-controls")?.classList.add("hidden");
}

// ── 全局右键菜单（绘图导出等）；Shift+右键保留原生菜单调试 ──
window.addEventListener("contextmenu", (e) => {
  const me = e as MouseEvent;
  if (me.shiftKey) return;
  me.preventDefault();
  const t = me.target as HTMLElement;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) t.focus();
  const items: CtxItem[] = [];
  const S = sessions.get(activeId);
  if (S && S.currentPage === "plot") {
    const cell = t.closest?.(".plot-cell") as HTMLElement | null;
    if (cell) {
      const chAttr = cell.dataset.ch;
      items.push({
        label: "📋 复制图表为 PNG",
        hint: "写入剪贴板；失败时转为下载",
        action: () => S.plotPage.copyChartPng(chAttr === undefined ? null : Number(chAttr)),
      });
      items.push({
        label: "📄 导出 CSV",
        hint: chAttr === undefined ? "全部通道缓冲数据" : `CH${Number(chAttr) + 1} 缓冲数据`,
        action: () => S.plotPage.exportCsv(chAttr === undefined ? null : Number(chAttr)),
      });
      items.push({ sep: true });
    } else if (t.closest?.("#plot-bars") || t.closest?.("#plot-holder")) {
      items.push({
        label: "📄 导出 CSV",
        hint: "全部通道缓冲数据",
        action: () => S.plotPage.exportCsv(null),
      });
      items.push({ sep: true });
    }
  }
  items.push(...commonEditItems());
  openContextMenu(items, me.clientX, me.clientY);
});
if (!import.meta.env.DEV) {
  window.addEventListener("keydown", (e) => {
    if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "r")) {
      e.preventDefault();
    }
  });
}

// ── 启动：恢复持久化标签页（无存档则开一张默认页）──
{
  let store: TabStore | null = null;
  try {
    store = JSON.parse(localStorage.getItem(TABS_KEY) ?? "null") as TabStore | null;
  } catch {
    /* 坏档忽略 */
  }
  const seen = new Set<string>();
  let first = "";
  if (store?.tabs?.length) {
    for (const t of store.tabs.slice(0, MAX_TABS)) {
      if (!t || typeof t.id !== "string" || !t.id || seen.has(t.id)) continue;
      seen.add(t.id);
      const snap = t.snap && typeof t.snap === "object" ? (t.snap as Record<string, string>) : {};
      const name = typeof t.name === "string" && t.name ? t.name : null;
      const s = createSession(name, snap, t.id);
      if (!first) first = s.id;
    }
  }
  if (!sessions.size) first = createSession(null).id;
  activate(store?.active && sessions.has(store.active) ? store.active : first);
  applySettingsToAll();
}

// 初始化完成标记（smoke 测试断言用）
(window as unknown as { __MAXCOM_READY__?: boolean }).__MAXCOM_READY__ = true;

// 启动页淡出移除（HTML 内联元素，零依赖首帧即显）
{
  const splash = document.querySelector<HTMLElement>("#splash");
  if (splash) {
    splash.style.transition = "opacity .25s ease";
    splash.style.opacity = "0";
    window.setTimeout(() => splash.remove(), 280);
  }
}
