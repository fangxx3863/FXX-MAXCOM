// MAXCOM 前端外壳：多标签页会话管理（每标签=独立串口/TCP 会话）+ 自绘标题栏 +
// 标签持久化（Notepad++ 式恢复）。单会话逻辑整体封装在 SessionApp；
// 标签栏/持久化/事件路由由模块级 TabManager 承担。
import "./styles.css";
import { t, getLang, persistLang, applyStaticI18n, type Lang } from "./i18n";
import { IS_TAURI, IS_MOBILE, makeApi, closeSession, onRaw, onEntries, onState, pickSavePath, listProbes, listChips, listUsbDevices, listHidDevices, saveTextFile, openPopupWindow } from "./api";
import type { ConnConfig, ConnState, DataFormat, DType, EntriesBatch, HidDeviceInfo, PortInfo, StatsSnapshot, UsbDeviceInfo } from "./types";
import { createDropdown, type DropdownHandle } from "./dropdown";
import { flattenChips, withAuto } from "./chips";
import { openContextMenu, commonEditItems, type CtxItem } from "./contextmenu";
import { openUrl as openExternal } from "@tauri-apps/plugin-opener";
import { TerminalPage } from "./pages/terminal";
import { LogViewPage } from "./pages/logview";
import { PlotPage, Y_PRESETS, type PlotLayout, type ViewMode } from "./pages/plot";
import { StatsPage } from "./pages/stats";
import { FlashPage, type FlashRunConfig } from "./pages/flash";
import { RulesPanel, type RulesSnapshot } from "./pages/rules";
import { ProtocolPage } from "./pages/protocol";
import { ToolsPage } from "./pages/tools";
import { LogCapture, captureStem, resolveLogFmt, type CaptureLogFormat } from "./capture";

type PageId = "terminal" | "logview" | "plot" | "stats" | "flash" | "protocol" | "tools" | "settings";
const PAGES: readonly PageId[] = ["terminal", "logview", "plot", "stats", "flash", "protocol", "tools", "settings"];

interface MsRow {
  enabled: boolean;
  content: string;
  hex: boolean;
  delayMs: number;
}

// 爆炸视图布局类型（hyprland 风格平铺）
type ExplodeLayout = "master" | "grid" | "dwindle";
type ExplodeType = "terminal" | "logview";

// ── 设置（全局共享：字体/字号/配色跨标签一致）──
interface AppSettings {
  logSize: number;
  logFamily: string;
  termSize: number;
  theme: string;
  /** 图表导出样式：theme=跟随主题；paper=论文风格（白底仿 LaTeX） */
  chartStyle: string;
  /** 界面整体缩放（DPI）：100=100%，125=125% 等 */ 
  uiScale: number;
  /** 捕获日志时间戳格式 */
  captureLogFormat: CaptureLogFormat;
  /** 爆炸视图：显示收发页还是终端页 */
  explodeType: ExplodeType;
  /** 爆炸视图布局方式：master 主从 / grid 均分 / dwindle 斜向 */
  explodeLayout: ExplodeLayout;
}
const DEFAULT_SETTINGS: AppSettings = {
  logSize: 12.5,
  logFamily: 'Consolas, "Cascadia Mono", monospace',
  termSize: 14,
  theme: "dark",
  chartStyle: "theme",
  uiScale: 100,
  captureLogFormat: "follow",
  explodeType: "logview",
  explodeLayout: "master",
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
  orange: "orange",
  red: "red",
  green: "green",
  pink: "pink",
  purple: "purple",
};

const TERMINAL_THEMES: Record<string, { background: string; foreground: string; cursor: string }> = {
  dark: { background: "#14161a", foreground: "#dce0e8", cursor: "#4da3ff" },
  light: { background: "#eef1f6", foreground: "#12161d", cursor: "#6aa8ff" },
  midnight: { background: "#0b1020", foreground: "#d5e2ff", cursor: "#6aa9ff" },
  solar: { background: "#002b36", foreground: "#eee8d5", cursor: "#268bd2" },
  oled: { background: "#000000", foreground: "#e8e8ea", cursor: "#4da3ff" },
  nord: { background: "#2e3440", foreground: "#eceff4", cursor: "#88c0d0" },
  dracula: { background: "#282a36", foreground: "#f8f8f2", cursor: "#bd93f9" },
  "solar-light": { background: "#fdf6e3", foreground: "#586e75", cursor: "#268bd2" },
  orange: { background: "#1a1206", foreground: "#ffe8c7", cursor: "#ff9838" },
  red: { background: "#1c0a0d", foreground: "#ffdfe1", cursor: "#ff5b6a" },
  green: { background: "#0a160d", foreground: "#dff5e4", cursor: "#39d97c" },
  pink: { background: "#1b0e18", foreground: "#ffe1f2", cursor: "#ff6fb3" },
  purple: { background: "#120a1e", foreground: "#eee4ff", cursor: "#a678ff" },
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

// 手机/平板 UA 时标记 <html data-platform=mobile>，供 styles.css 对移动端做
// 专属布局门控（桌面 UA 永不匹配，故不触发，桌面布局不受影响）。
if (IS_MOBILE) {
  document.documentElement.setAttribute("data-platform", "mobile");
}

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

// RTT 常见目标芯片不再内置硬编码列表：芯片候选一律由 probe-rs 提供（见 loadChips），
// 浏览器演示模式由 api.ts 的 DEMO_CHIP_FAMILIES 兜底。

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

/** 4 位十六进制数字（小写） */
function hex4(n: number): string {
  return n.toString(16).padStart(4, "0").toLowerCase();
}

/** 浏览器/演示模式：触发文本文件下载（Tauri 走 saveTextFile 落盘） */
function downloadTextFile(name: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** USB 设备下拉标签 */
function usbDeviceLabel(d: UsbDeviceInfo): string {
  const label = d.product || d.manufacturer || "USB Device";
  const sn = d.serial ? ` [${d.serial}]` : "";
  return `${label} (${hex4(d.vid)}:${hex4(d.pid)})${sn}`;
}

/** HID 设备下拉标签 */
function hidDeviceLabel(d: HidDeviceInfo): string {
  const label = d.product || d.manufacturer || "HID Device";
  const sn = d.serial ? ` [${d.serial}]` : "";
  const usage = d.usage_page ? ` (usage 0x${d.usage_page.toString(16).padStart(4, "0")})` : "";
  return `${label}${sn}${usage}`;
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
  flashPage!: FlashPage;
  rulesPanel!: RulesPanel;
  protocolPage!: ProtocolPage;
  toolsPage!: ToolsPage;

  connTypeDd!: DropdownHandle;
  portDd!: DropdownHandle;
  baudDd!: DropdownHandle;
  usbDeviceDd!: DropdownHandle;
  usbIfaceDd!: DropdownHandle;
  hidDeviceDd!: DropdownHandle;
  parityDd!: DropdownHandle;
  databitsDd!: DropdownHandle;
  stopbitsDd!: DropdownHandle;
  flowctlDd!: DropdownHandle;
  tsModeDd!: DropdownHandle;
  encodingDd!: DropdownHandle;
  splitModeDd!: DropdownHandle;
  tcpHostDd!: DropdownHandle;
  probeDd!: DropdownHandle;
  chipDd!: DropdownHandle;
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
  private pendingProbe: string | null = null;
  /** 开启 HEX 显示前用户选的分包方式：关闭 HEX 后恢复。null=未处于 HEX 锁定时 */
  private hexPreSplit: string | null = null;

  /** 日志捕获累计器（进行中非 null） */
  /** 本会话的收发/终端 page 容器（爆炸视图会把它们移出 this.el，缓存后 q() 仍可回退查找） */
  private pageEls: HTMLElement[] = [];
  private logCapture: LogCapture | null = null;

  /** 是否正在捕获日志（供关闭确认等模块级判断） */
  get isLogCapturing(): boolean {
    return this.logCapture !== null;
  }

  constructor(id: string, name: string | null, snap?: Record<string, string>) {
    this.id = id;
    this.seqNo = ++seqCounter;
    this.customName = name;
    this.el = document.createElement("div");
    this.el.className = "session-ui hidden-session";
    for (const n of PRISTINE) this.el.appendChild(n.cloneNode(true));
    // 静态标签（data-i18n）按当前语言落地
    applyStaticI18n(this.el);

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
    // 捕获本会话 .page 容器引用：爆炸视图移动 pageEl 后，q() 回退仍能命中
    this.pageEls = Array.from(this.el.querySelectorAll<HTMLElement>(".page"));
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
    const inRoot = this.el.querySelector<T>(sel);
    if (inRoot) return inRoot;
    // 爆炸视图会把本会话 .page（含 send-input / log-view / 控制条）移出 this.el，
    // 此时 this.el.querySelector 返回 null，导致发送/数据更新等二次查询失效。
    // 回退到捕获的 .page 容器内查找，移动后 q() 仍能命中。
    for (const p of this.pageEls) {
      const n = p.querySelector<T>(sel);
      if (n) return n;
    }
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
        { value: "serial", label: t("conn.serial") },
        { value: "tcp_client", label: t("conn.tcp") },
        { value: "udp_client", label: t("conn.udp") },
        { value: "ssh", label: t("conn.ssh") },
        { value: "telnet", label: t("conn.telnet") },
        { value: "rtt", label: t("conn.rtt") },
        { value: "winusb", label: t("conn.winusb") },
        { value: "hid", label: t("conn.hid") },
      ],
      onChange: (v) => {
        this.connKind = v;
        const portEl = this.q<HTMLInputElement>("#tcp-port");
        if ((v === "ssh" || v === "telnet") && (portEl.value === "" || portEl.value === "8888")) {
          portEl.value = v === "ssh" ? "22" : "23";
        }
        if (v === "rtt") void this.refreshProbes();
        if (v === "winusb") void this.refreshUsbDevices();
        if (v === "hid") void this.refreshHidDevices();
        this.syncConnTypeUI();
      },
    });
    this.q("#conn-type-dd").replaceWith(this.connTypeDd.el);

    this.portDd = createDropdown({ items: [], placeholder: t("conn.port.placeholder"), width: 260 });
    this.q("#serial-port-dd").replaceWith(this.portDd.el);

    this.baudDd = createDropdown({
      items: BAUD_PRESETS.map((b) => ({ value: b, label: b })),
      value: "115200",
      editable: true,
      placeholder: t("conn.baud.placeholder"),
      width: 120,
    });
    this.q("#baud-dd").replaceWith(this.baudDd.el);

    this.q("#refresh-ports").addEventListener("click", () => void this.refreshPorts());

    // ── USB (winusb) 设备枚举 ──
    this.usbDeviceDd = createDropdown({ items: [], placeholder: t("conn.usb.placeholder"), width: 260 });
    this.q("#usb-device-dd").replaceWith(this.usbDeviceDd.el);
    // replaceWith 会丢掉 placeholder 上的 usb-only/hidden class，必须补回（syncConnTypeUI 靠它显隐）
    this.usbDeviceDd.el.classList.add("usb-only", "hidden");
    this.usbIfaceDd = createDropdown({ items: [], placeholder: t("conn.usbIface.placeholder"), width: 100 });
    this.q("#usb-iface-dd").replaceWith(this.usbIfaceDd.el);
    this.usbIfaceDd.el.classList.add("usb-only", "hidden");
    this.q("#refresh-usb").addEventListener("click", () => void this.refreshUsbDevices());
    this.usbDeviceDd.el.addEventListener("change", () => {
      this.setUsbIfaceItems();
    });

    // ── HID 设备枚举 ──
    this.hidDeviceDd = createDropdown({ items: [], placeholder: t("conn.hid.placeholder"), width: 260 });
    this.q("#hid-device-dd").replaceWith(this.hidDeviceDd.el);
    this.hidDeviceDd.el.classList.add("hid-only", "hidden");
    this.q("#refresh-hid").addEventListener("click", () => void this.refreshHidDevices());

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
        { value: "absolute", label: t("ts.absolute") },
        { value: "relative", label: t("ts.relative") },
        { value: "delta", label: t("ts.delta") },
        { value: "none", label: t("ts.none") },
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
        { value: "auto", label: t("encoding.auto") },
        { value: "utf-8", label: "UTF-8" },
        { value: "gbk", label: "GBK" },
        { value: "gb2312", label: "GB2312" },
        { value: "latin-1", label: "Latin-1" },
      ],
      value: "auto",
      onChange: () => this.applyLogOptions(),
    });
    this.q("#encoding-dd").replaceWith(this.encodingDd.el);

    this.splitModeDd = createDropdown({
      items: [
        { value: "timeout", label: t("log.splitMode.timeout") },
        { value: "line", label: t("log.splitMode.line") },
      ],
      value: "line",
      onChange: () => {
        this.applyLogOptions();
        this.syncIdleTimeout();
      },
    });
    this.q("#split-mode-dd").replaceWith(this.splitModeDd.el);
    this.syncIdleTimeout();

    const dtrChk = this.q<HTMLInputElement>("#dtr-chk");
    const rtsChk = this.q<HTMLInputElement>("#rts-chk");
    dtrChk.addEventListener("change", () => {
      this.dtrOn = dtrChk.checked;
      void this.api.setDtr(this.dtrOn).catch((e) => this.setHint(t("conn.dtr.error", { e })));
    });
    rtsChk.addEventListener("change", () => {
      this.rtsOn = rtsChk.checked;
      void this.api.setRts(this.rtsOn).catch((e) => this.setHint(t("conn.rts.error", { e })));
    });

    this.q("#more-serial").addEventListener("click", () => this.q("#serial-setup").classList.toggle("hidden"));
    this.q("#setup-ok").addEventListener("click", () => this.q("#serial-setup").classList.add("hidden"));

    const autoReconnectChk = this.q<HTMLInputElement>("#auto-reconnect");
    autoReconnectChk.addEventListener("change", () => void this.api.setAutoReconnect(autoReconnectChk.checked));

    this.tcpHostDd = createDropdown({
      items: loadTcpHosts().map((h) => ({ value: h, label: h })),
      value: "127.0.0.1",
      editable: true,
      placeholder: t("conn.host.placeholder"),
      width: 150,
    });
    this.q("#tcp-host-dd").replaceWith(this.tcpHostDd.el);

    this.probeDd = createDropdown({ items: [], placeholder: t("conn.probe.placeholder"), width: 150 });
    this.q("#probe-dd").replaceWith(this.probeDd.el);
    this.q("#refresh-probes").addEventListener("click", () => void this.refreshProbes());

    this.chipDd = createDropdown({
      items: withAuto([]),
      value: "auto",
      editable: true,
      placeholder: t("conn.chip.placeholder"),
      width: 150,
    });
    this.q("#rtt-chip-dd").replaceWith(this.chipDd.el);
    // 默认即“自动检测”；用 setValue 让输入框显示“自动检测”标签而非原始值 "auto"
    this.chipDd.setValue("auto");
    void this.loadChips();

    this.syncConnTypeUI();

    this.q("#connect-btn").addEventListener("click", () => this.toggleConnect());
  }

  async refreshProbes() {
    try {
      const probes = await listProbes();
      this.probeDd.setItems(
        probes.map((p) => ({
          value: p.selector,
          label: `${p.identifier} [${p.selector}]`,
        })),
      );
      if (this.pendingProbe) {
        this.probeDd.setValue(this.pendingProbe);
        this.pendingProbe = "";
      }
    } catch (e) {
      this.setHint(t("probe.enumerate.error", { e }));
    }
  }

  /** USB 设备下拉数据（winusb 传输）。key = "vid:pid"（hex，小写）。 */
  private usbDevs: UsbDeviceInfo[] = [];

  async refreshUsbDevices() {
    try {
      this.usbDevs = await listUsbDevices();
      const items = this.usbDevs.map((d) => ({
        value: `${hex4(d.vid)}:${hex4(d.pid)}`,
        label: usbDeviceLabel(d),
      }));
      this.usbDeviceDd.setItems(items);
      if (this.pendingUsb) {
        this.usbDeviceDd.setValue(this.pendingUsb);
        this.pendingUsb = "";
      }
      this.setUsbIfaceItems();
      if (this.pendingUsbIface) {
        this.usbIfaceDd.setValue(this.pendingUsbIface);
        this.pendingUsbIface = "";
      }
    } catch (e) {
      this.setHint(t("usb.enumerate.error", { e }));
    }
  }

  /** 按当前选中的 USB 设备刷新接口下拉（key = 接口号字符串，"" = 自动） */
  private setUsbIfaceItems() {
    const dev = this.usbDevs.find((d) => `${hex4(d.vid)}:${hex4(d.pid)}` === this.usbDeviceDd.value);
    if (!dev || dev.interfaces.length === 0) {
      this.usbIfaceDd.setItems([{ value: "", label: t("conn.usbIface.auto") }]);
      return;
    }
    this.usbIfaceDd.setItems(
      dev.interfaces.map((i) => ({
        value: String(i.number),
        label: `${t("conn.usbIface.prefix")} ${i.number} (0x${i.class.toString(16).padStart(2, "0")})`,
      })),
    );
  }

  /** HID 设备下拉数据（hid 传输）。key = "vid:pid[:serial]"（serial 非空用于区分同 VID:PID 多设备）。 */
  async refreshHidDevices() {
    try {
      const devs = await listHidDevices();
      const items = devs.map((d) => ({
        value: `${hex4(d.vid)}:${hex4(d.pid)}${d.serial ? `:${d.serial}` : ""}`,
        label: hidDeviceLabel(d),
      }));
      this.hidDeviceDd.setItems(items);
      if (this.pendingHid) {
        this.hidDeviceDd.setValue(this.pendingHid);
        this.pendingHid = "";
      }
    } catch (e) {
      this.setHint(t("hid.enumerate.error", { e }));
    }
  }

  private pendingUsb = "";
  private pendingUsbIface = "";
  private pendingHid = "";

  /** 从 probe-rs 拉取内置目标芯片候选（浏览器演示模式用少量内置列表）。 */
  private async loadChips() {
    try {
      const items = withAuto(flattenChips(await listChips()));
      const cur = this.chipDd.value;
      this.chipDd.setItems(items);
      // setItems 在“当前值不在候选”时会重置为第一项（auto）；这里回填保持用户手输芯片不被清空
      if (cur) this.chipDd.setValue(cur);
    } catch {
      /* 拉取失败时保留“自动检测”候选，仍可手动输入芯片名 */
    }
  }

  refreshTcpHostItems() {
    const cur = this.tcpHostDd.value;
    this.tcpHostDd.setItems(loadTcpHosts().map((h) => ({ value: h, label: h })));
    if (cur) this.tcpHostDd.setValue(cur);
  }

  async refreshPorts() {
    try {
      const ports = await this.api.listPorts();
      for (const p of ports) PORT_NAMES.set(p.device, p.description || "");
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
    const isRtt = this.connKind === "rtt";
    const isUsb = this.connKind === "winusb";
    const isHid = this.connKind === "hid";
    const isNetwork =
      this.connKind === "tcp_client" || this.connKind === "udp_client" ||
      this.connKind === "ssh" || this.connKind === "telnet";
    const isSsh = this.connKind === "ssh";
    this.el.querySelectorAll<HTMLElement>(".serial-only").forEach((el) => el.classList.toggle("hidden", !isSerial));
    this.el.querySelectorAll<HTMLElement>(".rtt-only").forEach((el) => el.classList.toggle("hidden", !isRtt));
    this.el.querySelectorAll<HTMLElement>(".usb-only").forEach((el) => el.classList.toggle("hidden", !isUsb));
    this.el.querySelectorAll<HTMLElement>(".hid-only").forEach((el) => el.classList.toggle("hidden", !isHid));
    this.probeDd.el.classList.toggle("hidden", !isRtt);
    this.chipDd.el.classList.toggle("hidden", !isRtt);
    // 直接引用兜底（replaceWith 换过节点的元素，防止 class 丢失时 querySelectorAll 漏管）
    this.usbDeviceDd.el.classList.toggle("hidden", !isUsb);
    this.usbIfaceDd.el.classList.toggle("hidden", !isUsb);
    this.hidDeviceDd.el.classList.toggle("hidden", !isHid);
    this.portDd.el.classList.toggle("hidden", !isSerial);
    this.q("#refresh-ports").classList.toggle("hidden", !isSerial);
    this.baudDd.el.classList.toggle("hidden", !isSerial);
    this.tcpHostDd.el.classList.toggle("hidden", !isNetwork);
    this.q("#tcp-port").classList.toggle("hidden", !isNetwork);
    this.q("#ssh-user").classList.toggle("hidden", !isSsh);
    this.q("#ssh-pass").classList.toggle("hidden", !isSsh);
  }

  private async toggleConnect(forceConnect = false) {
    const wasConnected = this.connected;
    // 与后端同步真实连接状态：读线程掉线（且不重连）后 active 可能残留，
    // 前端每次连接/断开前先查询，避免"仅允许单连接"误报。
    let backend = this.connected;
    try {
      backend = (await this.api.connState()).connected;
    } catch {
      backend = this.connected;
    }
    this.connected = backend;

    if (wasConnected && !forceConnect) {
      // 用户意图：断开。后端无论真实/残留都已释放。
      try {
        await this.api.disconnect();
      } catch {
        /* 忽略 */
      }
      this.connected = false;
      return;
    }
    // 连接意图（含 forceConnect）：后端（真实/残留）仍占用单连接 → 先断开释放再连。
    if (backend) {
      try {
        await this.api.disconnect();
      } catch {
        /* 忽略 */
      }
      this.connected = false;
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
        alert(t("conn.noPort"));
        return;
      }
    } else if (this.connKind === "rtt") {
      const probe = this.probeDd.value;
      const chip = this.chipDd.value.trim();
      const up = Math.max(0, Number(this.q<HTMLInputElement>("#rtt-up").value) || 0);
      const down = Math.max(0, Number(this.q<HTMLInputElement>("#rtt-down").value) || 0);
      const addrRaw = this.q<HTMLInputElement>("#rtt-addr").value.trim();
      const rtt_address = addrRaw ? Number(addrRaw) || 0 : null;
      // 空芯片名 / "auto" → probe-rs 自动识别目标芯片（后端处理），故不强制填写
      cfg = { type: "rtt", probe_selector: probe, chip, up_channel: up, down_channel: down, rtt_address };
    } else if (this.connKind === "winusb") {
      const key = this.usbDeviceDd.value;
      const parts = key.split(":");
      const vid = parseInt(parts[0] ?? "", 16) || 0;
      const pid = parseInt(parts[1] ?? "", 16) || 0;
      const ifaceRaw = this.usbIfaceDd.value;
      const ifaceNum = ifaceRaw === "" ? null : Number(ifaceRaw);
      cfg = { type: "winusb", vid, pid, interface: ifaceNum };
      if (!key) {
        alert(t("conn.noUsb"));
        return;
      }
    } else if (this.connKind === "hid") {
      const key = this.hidDeviceDd.value;
      const parts = key.split(":");
      const vid = parseInt(parts[0] ?? "", 16) || 0;
      const pid = parseInt(parts[1] ?? "", 16) || 0;
      const serial = parts.length > 2 ? parts.slice(2).join(":") : null;
      const report_id = Math.max(0, Number(this.q<HTMLInputElement>("#hid-report-id").value) || 0);
      const strip_report_id = this.q<HTMLInputElement>("#hid-strip").checked;
      cfg = { type: "hid", vid, pid, serial, report_id, strip_report_id };
      if (!key) {
        alert(t("conn.noHid"));
        return;
      }
    } else {
      const host = this.tcpHostDd.value;
      const port = Number(this.q<HTMLInputElement>("#tcp-port").value) || 8888;
      if (this.connKind === "ssh") {
        cfg = {
          type: "ssh",
          host,
          port,
          username: this.q<HTMLInputElement>("#ssh-user").value.trim(),
          password: this.q<HTMLInputElement>("#ssh-pass").value,
        };
      } else if (this.connKind === "telnet") {
        cfg = { type: "telnet", host, port };
      } else {
        cfg = {
          type: this.connKind === "tcp_client" ? ("tcp_client" as const) : ("udp_client" as const),
          host,
          port,
        };
      }
      saveTcpHost(host);
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
      .catch((e) => alert(t("conn.connectError", { e })));
  }

  /** 烧录页“一键运行”：把探针/芯片信息带回顶栏 RTT 配置并自动连接 */
  private connectRttAfterFlash(cfg: FlashRunConfig) {
    this.connTypeDd.setValue("rtt");
    this.connKind = "rtt";
    // 顶栏探针列表可能尚未加载（异步），用 pendingProbe 保证 refreshProbes 完成后回填
    this.pendingProbe = cfg.probe_selector;
    this.probeDd.setValue(cfg.probe_selector);
    this.chipDd.setValue(cfg.chip);
    (this.q("#rtt-up") as HTMLInputElement).value = String(cfg.up_channel);
    (this.q("#rtt-down") as HTMLInputElement).value = String(cfg.down_channel);
    (this.q("#rtt-addr") as HTMLInputElement).value = cfg.rtt_address == null ? "" : String(cfg.rtt_address);
    this.syncConnTypeUI();
    // 强制连接：无论当前是否已有连接（含后端残留 active），先同步并在 toggleConnect 内释放再连。
    void this
      .toggleConnect(true)
      .catch((e) => this.setHint(t("rtt.switchError", { e })));
  }

  /** 连接状态事件（引擎推送，经全局路由进入） */
  applyConnState(s: ConnState) {
    this.connected = s.connected;
    this.stateLabel = s.label ? displayLabel(s.label) : s.label;
    this.lastError = s.error ?? null;
    if (!s.connected) this.terminalPage.clear();
    this.protocolPage.setConnected(s.connected);
    const dot = this.q("#conn-state");
    dot.className = `dot ${s.connected ? "on" : "off"}`;
    dot.title = s.error ?? (s.connected ? t("state.connected") : t("state.disconnected"));
    this.q("#conn-label").textContent = this.stateLabel ?? "";
    this.q("#sb-state").textContent = s.error
      ? t("state.error", { e: s.error })
      : s.connected
        ? t("state.connectedWith", { label: this.stateLabel ?? "" })
        : t("state.disconnected");
    this.q("#connect-btn").textContent = s.connected ? t("conn.disconnect") : t("conn.connect");
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
    this.flashPage = new FlashPage(
      this.q("#page-flash"),
      (cfg) => this.connectRttAfterFlash(cfg),
      () => ({
        up_channel: Math.max(0, Number((this.q("#rtt-up") as HTMLInputElement).value) || 0),
        down_channel: Math.max(0, Number((this.q("#rtt-down") as HTMLInputElement).value) || 0),
        rtt_address: (() => {
          const raw = (this.q("#rtt-addr") as HTMLInputElement).value.trim();
          return raw ? (Number(raw) || null) : null;
        })(),
      }),
      this.api,
    );
    // 规则面板：初始规则来自标签快照；变更即推本会话引擎，值级持久化交给轮询
    this.rulesPanel = new RulesPanel(this.el, this.api, rules0, () => {});
    // 协议页：传输复用本会话顶部栏连接（发送走 api.send，响应走 onRaw 原始流）
    this.protocolPage = new ProtocolPage(this.q("#page-protocol"), this.api, () => this.connected);
    // 工具页：纯前端计算器目录，不依赖连接
    this.toolsPage = new ToolsPage(this.q("#page-tools"));

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
    if (id === "flash") void this.flashPage.refreshProbes();
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
      this.applyHexSplitLock(on);
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
        split_mode: this.splitModeDd.value,
      })
      .catch(() => {});
  }

  /** 分包超时(ms) 仅在「超时分包」时显示；「换行分包」时隐藏 */
  private syncIdleTimeout() {
    this.q<HTMLElement>("#idle-timeout-ctl").classList.toggle(
      "hidden",
      this.splitModeDd.value !== "timeout",
    );
  }

  /**
   * HEX 显示下只允许「超时分包」：换行分包会把行尾的换行符(CRLF 或 LF)当分隔符吞掉，
   * HEX 视图里就永远看不到这些字节。故开启 HEX → 记住当前分包方式并强制切到超时分包；
   * 关闭 HEX → 恢复之前的分包方式（若有）。HEX 开启期间锁死分包下拉，防手动再选回换行分包。
   */
  private applyHexSplitLock(on: boolean) {
    const dd = this.splitModeDd;
    if (on) {
      if (this.hexPreSplit === null) this.hexPreSplit = dd.value;
      if (dd.value !== "timeout") {
        dd.setValue("timeout");
        this.applyLogOptions();
        this.syncIdleTimeout();
      }
    } else if (this.hexPreSplit !== null) {
      if (dd.value !== this.hexPreSplit) {
        dd.setValue(this.hexPreSplit);
        this.applyLogOptions();
        this.syncIdleTimeout();
      }
      this.hexPreSplit = null;
    }
    // 锁死/解锁分包下拉（非 editable 时控件面是 <button>）
    const face = this.splitModeDd.el.querySelector("button");
    if (face) face.disabled = on;
  }

  // ── 侧栏面板拖宽（按 会话+面板 记忆）──
  private wirePanels() {
    this.makePanelResizable(this.q("#multistr-panel"));
    this.makePanelResizable(this.q("#rules-panel"));
  }

  private makePanelResizable(panel: HTMLElement) {
    const h = document.createElement("div");
    h.className = "panel-resizer";
    h.title = t("panel.resize");
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
        { value: "none", label: t("send.newline.none") },
        { value: "\\n", label: "\\n" },
        { value: "\\r", label: "\\r" },
        { value: "\\r\\n", label: "\\r\\n" },
      ],
      value: "none",
    });
    this.q("#send-newline-dd").replaceWith(this.newlineDd.el);

    this.sendModeDd = createDropdown({
      items: [
        { value: "text", label: t("send.mode.text") },
        { value: "hex", label: t("send.mode.hex") },
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

    // 定时发送：开关切换与间隔值变更都即时生效（改完即重启，无需再开关一次）
    this.q("#timer-send").addEventListener("change", () => this.applyTimer());
    this.q("#timer-ms").addEventListener("change", () => this.applyTimer());

    // 直通：点击收发区后键盘直接发送到设备（类似终端/SSCOM）
    const direct = this.q<HTMLInputElement>("#direct-input");
    const logView = this.q<HTMLElement>("#log-view");
    logView.tabIndex = 0; // 可聚焦，点击后才能接收键盘
    const sendRaw = (text: string) =>
      void this.api
        .send({ text, newline: "none" })
        .catch((e) => {
          this.q("#send-hint").textContent = t("log.send.error", { e });
        });
    const handleDirectKey = (e: KeyboardEvent) => {
      if (!direct.checked) return; // 直通关闭：完全放行，保留浏览器默认行为；常驻挂载不依赖 change 事件
      if (e.ctrlKey || e.metaKey || e.altKey) return; // 保留浏览器快捷键(复制/全选等)
      if (e.key === "Enter") {
        e.preventDefault();
        sendRaw(this.realNewline() || String.fromCharCode(13, 10));
      } else if (e.key === "Backspace") {
        e.preventDefault();
        sendRaw("\x7f");
      } else if (e.key === "Tab") {
        e.preventDefault();
        sendRaw("\t");
      } else if (e.key.length === 1) {
        e.preventDefault();
        sendRaw(e.key);
      }
      // 其余键(方向键/PgUp等)放行，让收发区正常滚动
    };
    // keydown 常驻挂载：直通关闭时 handleDirectKey 内放行；即使快照恢复勾选态、未触发 change 事件监听也在。
    logView.addEventListener("keydown", handleDirectKey);
    // 直通时点击收发区聚焦，方便直接打字
    logView.addEventListener("mousedown", () => {
      if (direct.checked) logView.focus();
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
          fileBtn.textContent = t("log.file.progress", { pct: Math.min(99, Math.round((sentBytes / bytes.length) * 100)) });
          const dueMs = ((sentBytes * 10) / baud) * 1000;
          const wait = dueMs - (performance.now() - t0);
          if (wait > 0) await new Promise((r) => setTimeout(r, Math.ceil(wait)));
        }
        const hint = this.q("#send-hint");
        hint.textContent = t("log.file.done", { name: file.name, size: bytes.length });
        setTimeout(() => (hint.textContent = ""), 3000);
      } catch (err) {
        this.setHint(t("log.file.error", { e: err }));
      } finally {
        fileBtn.textContent = t("log.file");
        fileBtn.disabled = false;
        input.value = "";
      }
    });

    // 接收捕获（二进制 + 日志两个独立功能）
    this.q("#capture-bin-btn").addEventListener("click", () => void this.toggleBinaryCapture());
    this.q("#capture-log-btn").addEventListener("click", () => this.toggleLogCapture());
  }

  /** 定时发送：按当前开关/间隔启动、停止或重启。开关切换与间隔值变更都会调用，
      间隔值改完立即生效（重启间隔），无需再开关一次。 */
  private applyTimer() {
    const input = this.q<HTMLInputElement>("#timer-ms");
    const raw = Number(input.value);
    const ms = Math.max(10, raw || 1000);
    if (String(ms) !== input.value) input.value = String(ms); // 归一化显示（min 10）
    if (this.timerHandle !== null) {
      window.clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.q<HTMLInputElement>("#timer-send").checked) {
      this.timerHandle = window.setInterval(() => void this.doSend(), ms);
    }
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
      hint.textContent = t("log.send.error", { e });
      setTimeout(() => (hint.textContent = ""), 3000);
    }
  }

  private realNewline(): string {
    return this.newlineDd.value.split("\\r").join(String.fromCharCode(13)).split("\\n").join(String.fromCharCode(10));
  }
  private captureBaseName(device: string): string {
    return this.customName || PORT_NAMES.get(device) || shortPortName(device) || device;
  }

  private async toggleBinaryCapture() {
    const btn = this.q("#capture-bin-btn");
    const [capturing] = await this.api.captureState();
    if (!capturing) {
      await this.api.startCapture();
      btn.textContent = t("log.captureBin.stop");
      btn.classList.add("recording");
      return;
    }
    // 停止并保存：默认文件名 = 串口名 + 串口号 + 开始时间(到ms)，防止重名
    const startMs = Date.now();
    const stem = captureStem(this.captureBaseName(this.portDd.value), this.portDd.value, startMs);
    const defaultName = `${stem}.bin`;
    const path = await pickSavePath(defaultName);
    if (path) {
      const n = await this.api.saveCapture(path as string);
      this.setHint(t("log.captureBin.savedPath", { size: n, path }), false);
    } else if (IS_TAURI) {
      await this.api.cancelCapture();
      this.setHint(t("log.captureBin.cancelled"), false);
    } else {
      // 浏览器演示模式：mock 直接触发下载
      const n = await this.api.saveCapture(defaultName);
      this.setHint(t("log.captureBin.saved", { size: n }), false);
    }
    btn.textContent = t("log.captureBin");
    btn.classList.remove("recording");
  }

  /** 日志捕获切换：进行中累计文本行，停止后保存为可读文本 */
  private toggleLogCapture() {
    const btn = this.q("#capture-log-btn");
    if (!this.logCapture) {
      const fmt = resolveLogFmt(currentSettings.captureLogFormat, this.tsModeDd.value);
      this.logCapture = new LogCapture(fmt);
      btn.textContent = t("log.captureLog.stop");
      btn.classList.add("recording");
      this.updateLogCaptureBadge();
      return;
    }
    const content = this.logCapture.content();
    const startMs = this.logCapture.startMs;
    const stem = captureStem(this.captureBaseName(this.portDd.value), this.portDd.value, startMs);
    this.logCapture = null;
    btn.textContent = t("log.captureLog");
    btn.classList.remove("recording");
    void this.saveLogCapture(`${stem}.log`, content);
  }

  private async saveLogCapture(defaultName: string, content: string) {
    const path = await pickSavePath(defaultName);
    if (path) {
      const n = await saveTextFile(path, content);
      this.setHint(t("log.captureLog.savedPath", { size: n, path }), false);
    } else if (IS_TAURI) {
      this.setHint(t("log.captureLog.cancelled"), false);
    } else {
      downloadTextFile(defaultName, content);
      this.setHint(t("log.captureLog.saved", { size: content.length }), false);
    }
  }

  /** 每批 entries 进入时喂给日志捕获累计器 */
  feedLogCapture(batch: EntriesBatch) {
    const lc = this.logCapture;
    if (!lc) return;
    // 跟随当前 HEX 显示模式：HEX 下捕获原始字节十六进制（raw_hex），否则解码文本
    lc.hex = this.logViewPage.hexView;
    lc.feed(batch);
    this.updateLogCaptureBadge();
  }

  /** 二进制捕获徽标（轮询刷新活动标签） */
  updateCaptureBadge(size: number) {
    const btn = this.q("#capture-bin-btn");
    if (btn.classList.contains("recording")) {
      btn.textContent = t("log.captureBin.stopsize", { size: (size / 1024).toFixed(1) });
    }
  }

  /** 日志捕获徽标（行数） */
  updateLogCaptureBadge() {
    const btn = this.q("#capture-log-btn");
    if (btn.classList.contains("recording") && this.logCapture) {
      btn.textContent = t("log.captureLog.stopsize", { size: this.logCapture.count });
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
            this.q("#ms-status").textContent = t("multistr.sent", { content: row.content.slice(0, 24) });
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
        input.placeholder = row.hex ? t("multistr.hex.placeholder") : t("multistr.text.placeholder");
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
        delay.title = t("multistr.delay.title");
        delay.addEventListener("change", () => {
          row.delayMs = Number(delay.value) || 0;
          this.persistMs();
        });
        const sendOne = document.createElement("button");
        sendOne.textContent = t("multistr.send");
        sendOne.addEventListener("click", () => void this.sendMsRow(row));
        const del = document.createElement("button");
        del.textContent = "✕";
        del.title = t("common.deleteRow");
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
        { value: "ascii_delimited", label: t("plot.fmt.ascii") },
        { value: "simple_binary", label: t("plot.fmt.binary") },
        { value: "custom_frame", label: t("plot.fmt.frame") },
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
        { value: "little", label: t("plot.endian.little") },
        { value: "big", label: t("plot.endian.big") },
      ],
      value: "little",
    });
    this.q("#plot-endian-dd").replaceWith(this.plotEndianDd.el);

    this.plotASplitDd = createDropdown({
      items: [
        { value: "channel", label: t("plot.asplit.channel") },
        { value: "package", label: t("plot.asplit.package") },
      ],
      value: "channel",
    });
    this.q("#plot-asplit-dd").replaceWith(this.plotASplitDd.el);

    this.plotFrameLenDd = createDropdown({
      items: [
        { value: "fixed", label: t("plot.frameLen.fixed") },
        { value: "payload", label: t("plot.frameLen.payload") },
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
        { value: "waveform", label: t("plot.view.waveform") },
        { value: "bars", label: t("plot.view.bars") },
        { value: "both", label: t("plot.view.both") },
      ],
      value: "waveform",
      onChange: (v) => this.plotPage.setViewMode(v as ViewMode),
    });
    this.q("#plot-view-dd").replaceWith(this.plotViewDd.el);

    this.plotLayoutDd = createDropdown({
      items: [
        { value: "subplots", label: t("plot.layout.subplots") },
        { value: "overlay", label: t("plot.layout.overlay") },
      ],
      value: "subplots",
      onChange: (v) => this.plotPage.setLayout(v as PlotLayout),
    });
    this.q("#plot-layout-dd").replaceWith(this.plotLayoutDd.el);

    this.plotYRangeDd = createDropdown({
      items: [
        { value: "auto", label: t("plot.yrange.auto") },
        { value: "s8", label: "int8: -128~127" },
        { value: "u8", label: "uint8: 0~255" },
        { value: "s16", label: "int16: ±32768" },
        { value: "u16", label: "uint16: 0~65535" },
        { value: "s32", label: "int32: ±2³¹" },
        { value: "u32", label: "uint32: 0~2³²" },
        { value: "pm1", label: "-1 ~ 1" },
        { value: "pm100", label: "-100 ~ 100" },
        { value: "pm1000", label: "-1000 ~ 1000" },
        { value: "custom", label: t("plot.yrange.custom") },
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
    r["conn.sshuser"] = (this.q("#ssh-user") as HTMLInputElement).value;
    r["conn.sshpass"] = (this.q("#ssh-pass") as HTMLInputElement).value;
    r["conn.probe"] = this.probeDd.value;
    r["conn.chip"] = this.chipDd.value;
    r["conn.rttup"] = (this.q("#rtt-up") as HTMLInputElement).value;
    r["conn.rttdown"] = (this.q("#rtt-down") as HTMLInputElement).value;
    r["conn.rttaddr"] = (this.q("#rtt-addr") as HTMLInputElement).value;
    r["conn.usbdev"] = this.usbDeviceDd.value;
    r["conn.usbiface"] = this.usbIfaceDd.value;
    r["conn.hiddev"] = this.hidDeviceDd.value;
    r["conn.hidreportid"] = (this.q("#hid-report-id") as HTMLInputElement).value;
    r["conn.hidstrip"] = this.q<HTMLInputElement>("#hid-strip").checked ? "1" : "";
    r["conn.autoreconn"] = this.q<HTMLInputElement>("#auto-reconnect").checked ? "1" : "";
    r["conn.dtr"] = this.dtrOn ? "1" : "";
    r["conn.rts"] = this.rtsOn ? "1" : "";
    r["tsmode"] = this.tsModeDd.value;
    r["encoding"] = this.encodingDd.value;
    r["splitmode"] = this.splitModeDd.value;
    r["idletimeout"] = (this.q("#idle-timeout") as HTMLInputElement).value;
    r["hexdisp"] = this.q<HTMLInputElement>("#hex-display").checked ? "1" : "";
    r["autoscroll"] = this.q<HTMLInputElement>("#autoscroll").checked ? "1" : "";
    r["quickfilter"] = (this.q("#quick-filter") as HTMLInputElement).value;
    r["sendmode"] = this.sendModeDd.value;
    r["newline"] = this.newlineDd.value;
    r["timerms"] = (this.q("#timer-ms") as HTMLInputElement).value;
    r["timeron"] = this.q<HTMLInputElement>("#timer-send").checked ? "1" : "";
    r["direct"] = this.q<HTMLInputElement>("#direct-input").checked ? "1" : "";
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
    r["protjson"] = JSON.stringify(this.protocolPage.snapshot());
    r["tooljson"] = JSON.stringify(this.toolsPage.snapshot());
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
    if (g("conn.sshuser")) (this.q("#ssh-user") as HTMLInputElement).value = g("conn.sshuser");
    if (g("conn.sshpass")) (this.q("#ssh-pass") as HTMLInputElement).value = g("conn.sshpass");
    if (g("conn.probe")) {
      this.pendingProbe = g("conn.probe");
      this.probeDd.setValue(g("conn.probe"));
    }
    if (g("conn.chip")) this.chipDd.setValue(g("conn.chip"));
    if (g("conn.rttup")) (this.q("#rtt-up") as HTMLInputElement).value = g("conn.rttup");
    if (g("conn.rttdown")) (this.q("#rtt-down") as HTMLInputElement).value = g("conn.rttdown");
    if (g("conn.rttaddr")) (this.q("#rtt-addr") as HTMLInputElement).value = g("conn.rttaddr");
    if (g("conn.usbdev")) {
      this.pendingUsb = g("conn.usbdev");
      this.usbDeviceDd.setValue(g("conn.usbdev"));
    }
    if (g("conn.usbiface")) this.pendingUsbIface = g("conn.usbiface");
    if (g("conn.hiddev")) {
      this.pendingHid = g("conn.hiddev");
      this.hidDeviceDd.setValue(g("conn.hiddev"));
    }
    if (g("conn.hidreportid")) (this.q("#hid-report-id") as HTMLInputElement).value = g("conn.hidreportid");
    if (g("conn.hidstrip")) this.q<HTMLInputElement>("#hid-strip").checked = true;
    // setValue 不触发 onChange：恢复 winusb/hid 类型时显式拉取设备列表并回填
    if (this.connKind === "winusb") void this.refreshUsbDevices();
    if (this.connKind === "hid") void this.refreshHidDevices();
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
    if (g("splitmode")) this.splitModeDd.setValue(g("splitmode"));
    this.syncIdleTimeout();
    const hexOn = !!g("hexdisp");
    {
      const chk = this.q<HTMLInputElement>("#hex-display");
      chk.checked = hexOn;
      this.logViewPage.setHexDisplay(hexOn);
    }
    this.applyHexSplitLock(hexOn);
    if (!g("autoscroll")) this.q<HTMLInputElement>("#autoscroll").checked = false;
    if (g("quickfilter")) {
      (this.q("#quick-filter") as HTMLInputElement).value = g("quickfilter");
      this.logViewPage.setQuickFilter(g("quickfilter"));
    }
    if (g("sendmode")) this.sendModeDd.setValue(g("sendmode"));
    if (g("newline")) this.newlineDd.setValue(g("newline"));
    if (g("timerms")) (this.q("#timer-ms") as HTMLInputElement).value = g("timerms");
    if (g("timeron")) this.q<HTMLInputElement>("#timer-send").checked = true; // 仅恢复勾选态，不自动启动
    if (g("direct")) this.q<HTMLInputElement>("#direct-input").checked = true; // 直通仅恢复勾选态；keydown 常驻，点击即生效
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
    if (g("protjson")) {
      try {
        this.protocolPage.applySnapshot(JSON.parse(g("protjson")) as Record<string, string>);
      } catch {
        /* 忽略坏数据 */
      }
    }
    if (g("tooljson")) {
      try {
        this.toolsPage.applySnapshot(JSON.parse(g("tooljson")) as Record<string, string>);
      } catch {
        /* 忽略坏数据 */
      }
    }
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
    const chartStyleSel = this.q<HTMLSelectElement>("#set-chart-style");
    if (chartStyleSel) chartStyleSel.value = st.chartStyle;
    const uiScaleSel = this.q<HTMLSelectElement>("#set-ui-scale");
    if (uiScaleSel) uiScaleSel.value = String(st.uiScale);
    const logFmtSel = this.q<HTMLSelectElement>("#set-capture-log-fmt");
    if (logFmtSel) logFmtSel.value = st.captureLogFormat;
    const explodeTypeSel = this.q<HTMLSelectElement>("#set-explode-type");
    if (explodeTypeSel) explodeTypeSel.value = st.explodeType;
    const explodeLayoutSel = this.q<HTMLSelectElement>("#set-explode-layout");
    if (explodeLayoutSel) explodeLayoutSel.value = st.explodeLayout;
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
    const chartStyleSel = this.q<HTMLSelectElement>("#set-chart-style");
    chartStyleSel.addEventListener("change", () =>
      saveSettings({ ...currentSettings, chartStyle: chartStyleSel.value }),
    );
    // 界面整体缩放（DPI）：即时生效并持久化；100% 时浏览器退回默认（zoom:1）
    const uiScaleSel = this.q<HTMLSelectElement>("#set-ui-scale");
    if (uiScaleSel) {
      uiScaleSel.addEventListener("change", () =>
        saveSettings({ ...currentSettings, uiScale: Number(uiScaleSel.value) || DEFAULT_SETTINGS.uiScale }),
      );
    }
    // 捕获日志时间戳格式：持久化，下次捕获生效
    const logFmtSel = this.q<HTMLSelectElement>("#set-capture-log-fmt");
    if (logFmtSel) {
      logFmtSel.addEventListener("change", () =>
        saveSettings({ ...currentSettings, captureLogFormat: logFmtSel.value as CaptureLogFormat }),
      );
    }
    // 爆炸视图：显示类型 + 布局方式（即时生效，下次打开爆炸视图应用）
    const explodeTypeSel = this.q<HTMLSelectElement>("#set-explode-type");
    if (explodeTypeSel) {
      explodeTypeSel.addEventListener("change", () =>
        saveSettings({ ...currentSettings, explodeType: explodeTypeSel.value as ExplodeType }),
      );
    }
    const explodeLayoutSel = this.q<HTMLSelectElement>("#set-explode-layout");
    if (explodeLayoutSel) {
      explodeLayoutSel.addEventListener("change", () =>
        saveSettings({ ...currentSettings, explodeLayout: explodeLayoutSel.value as ExplodeLayout }),
      );
    }
    this.q("#set-reset").addEventListener("click", () => saveSettings({ ...DEFAULT_SETTINGS }));
    // 界面语言：全局共享，切换后整页重载（标签页/设置保留）；重载前先断开所有连接
    const langSel = this.q<HTMLSelectElement>("#set-lang");
    if (langSel) {
      langSel.value = getLang();
      langSel.addEventListener("change", () => void changeLanguage(langSel.value as Lang));
    }
  }
}

// ══════════════════════════ 标签页管理器（模块级）══════════════════════════
const sessions = new Map<string, SessionApp>();
let activeId = "";
let seqCounter = 0;
let renamingId: string | null = null;
let lastSnapJson = "";

/** 串口 device → 制造商/产品名（来自 listPorts 的 description，用于捕获文件名） */
const PORT_NAMES = new Map<string, string>();

/** 是否有会话正在捕获（二进制或日志）：捕获中关闭程序需确认 */
async function anyCapturing(): Promise<boolean> {
  for (const s of sessions.values()) {
    if (s.isLogCapturing) return true;
    try {
      const [capturing] = await s.api.captureState();
      if (capturing) return true;
    } catch {
      /* 未连接等 */
    }
  }
  return false;
}

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
  if ((s.connKind === "tcp_client" || s.connKind === "udp_client" || s.connKind === "ssh" || s.connKind === "telnet") && s.tcpHostDd.value) {
    const proto =
      s.connKind === "udp_client" ? "UDP"
        : s.connKind === "ssh" ? "SSH"
          : s.connKind === "telnet" ? "Telnet"
            : "TCP";
    if (s.connKind === "ssh") {
      const user = (s.el.querySelector<HTMLInputElement>("#ssh-user")?.value || "").trim();
      return `${proto} ${user ? `${user}@` : ""}${s.tcpHostDd.value}:${(s.el.querySelector<HTMLInputElement>("#tcp-port") as HTMLInputElement).value || "8888"}`;
    }
    return `${proto} ${s.tcpHostDd.value}:${(s.el.querySelector<HTMLInputElement>("#tcp-port") as HTMLInputElement).value || "8888"}`;
  }
  return t("tab.newDefault", { n: s.seqNo });
}

function renderTabs() {
  const strip = document.getElementById("tabstrip")!;
  strip.replaceChildren();
  for (const [id, s] of sessions) {
    const tab = document.createElement("div");
    tab.className = `tab${id === activeId ? " active" : ""}`;
    tab.title = s.lastError ? t("state.error", { e: s.lastError }) : tabTitle(s);

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
    close.title = t("tab.close");
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
          { label: t("tab.rename"), hint: t("tab.rename.hint"), action: () => startRename(id) },
          { label: t("tab.duplicate"), hint: t("tab.duplicate.hint"), action: () => duplicateTab(id) },
          { sep: true },
          { label: t("tab.closeItem"), hint: "Ctrl+W", action: () => closeTabById(id) },
          {
            label: t("tab.closeOther"),
            action: () => {
              for (const k of [...sessions.keys()]) if (k !== id) closeTabById(k);
            },
          },
          {
            label: t("tab.closeRight"),
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
    sessions.get(activeId)?.setHint(t("tab.max", { n: MAX_TABS }));
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
onRaw((e) => {
  const s = sessions.get(e.session);
  if (!s) return;
  s.terminalPage.feed(e.bytes);
  s.protocolPage.onRaw(e.bytes);
});
onEntries((e) => {
  const s = sessions.get(e.session);
  if (!s) return;
  s.logViewPage.append(e.batch);
  s.feedLogCapture(e.batch);
});
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
      sbRate.textContent = t("sb.rate", { rx: st.rx_rate_kbs.toFixed(2), tx: st.tx_rate_kbs.toFixed(2) });
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
  // 界面整体缩放（DPI）：CSS zoom 等比缩放 WebView 全部内容。桌面 UA 的移动端媒体查询已
  // 平台门控，故缩放压窄 CSS 视口也不会吃掉顶部标题/连接栏。
  rootStyle.setProperty("zoom", String(currentSettings.uiScale / 100));
  applyTheme();
  const resolved = resolveThemeId();
  const termTheme = TERMINAL_THEMES[resolved] ?? TERMINAL_THEMES.dark;
  for (const s of sessions.values()) {
    s.applySettingsInputs(currentSettings);
    s.terminalPage.setFontSize(currentSettings.termSize);
    s.terminalPage.setTheme(termTheme);
    s.logViewPage.refreshRowHeight();
  }
}

function saveSettings(st: AppSettings) {
  currentSettings = st;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(st));
  applySettingsToAll();
}

/**
 * 切换语言：持久化后，先断开所有标签的连接，再整页重载。
 * 引擎是单连接设计（connect 对已有活动连接会报「已有活动连接」），
 * 若重载前不断开，重载恢复的标签再次 connect 会撞到旧连接而报错。
 */
async function changeLanguage(l: Lang): Promise<void> {
  persistLang(l);
  await Promise.allSettled([...sessions.values()].map((s) => s.api.disconnect()));
  window.location.reload();
}


// ── 爆炸视图：顶栏右键打开；hyprland 风格平铺所有已连接会话的收发/终端 ──
interface ExplodeTile {
  sid: string;
  pageEl: HTMLElement;
  tileEl: HTMLDivElement;
}

let explodeOpen = false;
let explodeTiles: ExplodeTile[] = [];
let explodeGrid: HTMLElement | null = null;

/** 收集已连接会话的目标收发/终端 page section（未连接/缺失跳过） */
function collectExplodeTiles(): ExplodeTile[] {
  const type = currentSettings.explodeType;
  const sel = type === "terminal" ? "#page-terminal" : "#page-logview";
  const out: ExplodeTile[] = [];
  for (const s of sessions.values()) {
    if (!s.connected) continue;
    const page = s.el.querySelector<HTMLElement>(sel);
    if (!page) continue;
    out.push({ sid: s.id, pageEl: page, tileEl: document.createElement("div") });
  }
  return out;
}

/** 布局百分比矩形：grid 均分 / master 主从(首个大块+侧栏) / dwindle 斜向切半递减 */
function explodeRects(
  n: number,
  layout: ExplodeLayout,
): { left: number; top: number; w: number; h: number }[] {
  const rects: { left: number; top: number; w: number; h: number }[] = [];
  if (layout === "grid") {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const w = 100 / cols;
    const h = 100 / rows;
    for (let i = 0; i < n; i++) {
      rects.push({ left: (i % cols) * w, top: Math.floor(i / cols) * h, w, h });
    }
  } else if (layout === "master") {
    if (n === 1) {
      rects.push({ left: 0, top: 0, w: 100, h: 100 });
    } else {
      rects.push({ left: 0, top: 0, w: 60, h: 100 });
      const rest = n - 1;
      const h2 = 100 / rest;
      for (let i = 1; i < n; i++) rects.push({ left: 60, top: (i - 1) * h2, w: 40, h: h2 });
    }
  } else {
    // dwindle：每个 tile 依次占当前剩余矩形的一半，横竖交替（斜向递减）
    let x = 0, y = 0, w = 100, h = 100;
    let horizontal = true;
    for (let i = 0; i < n; i++) {
      if (i === n - 1) {
        rects.push({ left: x, top: y, w, h });
        break;
      }
      rects.push({
        left: x,
        top: y,
        w: horizontal ? w / 2 : w,
        h: horizontal ? h : h / 2,
      });
      if (horizontal) {
        x += w / 2;
        w = w / 2;
      } else {
        y += h / 2;
        h = h / 2;
      }
      horizontal = !horizontal;
    }
  }
  return rects;
}

function applyExplodeRect(tile: HTMLElement, r: { left: number; top: number; w: number; h: number }) {
  tile.style.left = r.left + "%";
  tile.style.top = r.top + "%";
  tile.style.width = r.w + "%";
  tile.style.height = r.h + "%";
}

function applyExplodeLayout() {
  const rects = explodeRects(explodeTiles.length, currentSettings.explodeLayout);
  explodeTiles.forEach((t, i) => applyExplodeRect(t.tileEl, rects[i]));
}

function withinTile(tile: HTMLElement, x: number, y: number): boolean {
  const r = tile.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function wireExplodeDrag(tile: HTMLDivElement) {
  const head = tile.querySelector<HTMLElement>(".explode-tile-head");
  if (!head) return;
  const grid = explodeGrid!;

  // ── 角部 resize 手柄：拖拽调整 tile 尺寸（占 grid %，hyprland 式随意改块大小）──
  const rz = document.createElement("div");
  rz.className = "explode-resize";
  tile.appendChild(rz);
  rz.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) return;
    const gridRect = grid.getBoundingClientRect();
    if (gridRect.width < 2 || gridRect.height < 2) return;
    const startX = e.clientX, startY = e.clientY;
    const startW = tile.getBoundingClientRect().width;
    const startH = tile.getBoundingClientRect().height;
    rz.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      // 换算为 grid 百分比；夹在 [12, 100-left/top] 内，避免越界/重叠到边界外
      const pctW = ((startW + ev.clientX - startX) / gridRect.width) * 100;
      const pctH = ((startH + ev.clientY - startY) / gridRect.height) * 100;
      tile.style.width = Math.max(12, Math.min(100, pctW)).toFixed(2) + "%";
      tile.style.height = Math.max(12, Math.min(100, pctH)).toFixed(2) + "%";
    };
    const up = () => {
      rz.removeEventListener("pointermove", move);
      rz.removeEventListener("pointerup", up);
    };
    rz.addEventListener("pointermove", move);
    rz.addEventListener("pointerup", up);
  });

  // ── 拖拽重排：pointer 捕获，实时按落点换位（hyprland 风格，绕开 WebView2 HTML5 DnD 光标禁止）──
  let dragging = false;
  head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const ti = explodeTiles.findIndex((t) => t.tileEl === tile);
    if (ti < 0) return;
    dragging = true;
    tile.classList.add("dragging");
    head.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  head.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const target = explodeTiles.find((t) => t.tileEl !== tile && withinTile(t.tileEl, e.clientX, e.clientY));
    for (const t of explodeTiles) t.tileEl.classList.remove("drop-hover");
    if (!target) return;
    const from = explodeTiles.findIndex((t) => t.tileEl === tile);
    const to = explodeTiles.findIndex((t) => t.tileEl === target.tileEl);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = explodeTiles.splice(from, 1);
    explodeTiles.splice(to, 0, moved);
    if (explodeGrid) {
      explodeGrid.replaceChildren();
      for (const t of explodeTiles) explodeGrid.appendChild(t.tileEl);
    }
    applyExplodeLayout();
  });
  head.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    tile.classList.remove("dragging");
    for (const t of explodeTiles) t.tileEl.classList.remove("drop-hover");
  });
  head.addEventListener("pointercancel", () => {
    dragging = false;
    tile.classList.remove("dragging");
    for (const t of explodeTiles) t.tileEl.classList.remove("drop-hover");
  });
}

function openExplode() {
  if (explodeOpen) return;
  const grid = document.getElementById("explode-grid");
  const overlay = document.getElementById("explode-overlay");
  if (!grid || !overlay) return;
  explodeGrid = grid;
  explodeTiles = collectExplodeTiles();
  grid.replaceChildren();
  const hint = document.getElementById("explode-hint");
  if (hint) {
    hint.textContent = explodeTiles.length ? t("explode.hintDrag") : t("explode.hintNone");
  }
  explodeTiles.forEach((et) => {
    const tile = et.tileEl;
    tile.className = "explode-tile";
    // 标题头：可拖拽手柄
    const head = document.createElement("div");
    head.className = "explode-tile-head";
    head.draggable = true;
    const name = document.createElement("span");
    name.className = "explode-tile-name";
    const s = sessions.get(et.sid);
    name.textContent = s ? tabTitle(s) : et.sid;
    const live = document.createElement("span");
    live.className = "explode-tile-live";
    live.textContent = "●";
    live.title = t("explode.live");
    head.append(name, live);
    // 主体：会话收发/终端 page section
    const body = document.createElement("div");
    body.className = "explode-tile-body";
    et.pageEl.classList.remove("hidden");
    body.appendChild(et.pageEl);
    tile.append(head, body);
    wireExplodeDrag(tile);
    grid.appendChild(tile);
  });
  applyExplodeLayout();
  // 屏蔽多余 UI：藏标题栏与主会话区，露出覆盖层
  document.getElementById("titlebar")?.classList.add("hidden");
  document.getElementById("session-root")?.classList.add("hidden");
  // decorations:false 自绘窗口，可拖/缩放区集中在标题栏；标题栏被隐藏后窗口即失去拖动缩放。
  // 给爆炸视图顶栏的空区（hint）补 drag-region，窗口在爆炸视图下仍能移动/调整大小。
  // close 按钮不在 region 上，保持可点。
  const dragHint = document.getElementById("explode-hint") as HTMLElement | null;
  if (dragHint) {
    dragHint.setAttribute("data-tauri-drag-region", "");
    dragHint.style.userSelect = "none";
  }
  overlay.classList.remove("hidden");
  explodeOpen = true;
}

function closeExplode() {
  if (!explodeOpen) return;
  for (const t of explodeTiles) {
    const s = sessions.get(t.sid);
    if (s) {
      const pages = s.el.querySelector<HTMLElement>("#pages");
      if (pages) pages.appendChild(t.pageEl);
      s.switchPage(s.currentPage); // 恢复该会话页面显隐
    }
    t.tileEl.remove();
  }
  explodeTiles = [];
  document.getElementById("titlebar")?.classList.remove("hidden");
  document.getElementById("session-root")?.classList.remove("hidden");
  document.getElementById("explode-overlay")?.classList.add("hidden");
  explodeOpen = false;
}

document.getElementById("explode-close")?.addEventListener("click", () => closeExplode());
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && explodeOpen) closeExplode();
});

// 顶栏右键 → 爆炸视图入口（避开按钮/标签格）
{
  const tb = document.getElementById("titlebar");
  if (tb) {
    tb.addEventListener("contextmenu", (e) => {
      if (e.shiftKey) return; // 保留原生菜单调试
      const tv = e.target as HTMLElement;
      if (tv.closest("button") || tv.closest(".tab")) return;
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(
        [
          {
            label: t("explode.open"),
            hint: t("explode.open.hint"),
            action: () => openExplode(),
          },
        ],
        e.clientX,
        e.clientY,
      );
    });
  }
}

// ── 标签栏按钮 / 新建 ──
document.getElementById("tab-new")?.addEventListener("click", () => newTab());

// ── 外链打开逻辑──桌面 Tauri WebView 默认不响应 target=_blank 的 <a>，需经 opener
//    插件调系统浏览器（桌面：默认浏览器；移动端：对应 intent）。浏览器/演示模式走 window.open。
//    用 document 级事件委托，覆盖每个会话克隆出的「关于页」项目主页链接。 https/http 才拦。 */
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest?.("a[href]");
  if (!a) return;
  const href = (a.getAttribute("href") || "").trim();
  if (!/^https?:\/\//i.test(href)) return;
  e.preventDefault();
  if (IS_TAURI) void openExternal(href);
  else window.open(href, "_blank", "noopener");
});

// ── 标题栏静态标签（win-* 按钮 title 等）按当前语言落地 ──
{
  const titlebar = document.getElementById("titlebar");
  if (titlebar) applyStaticI18n(titlebar);
}

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
    // 捕获中关闭程序：先确认再退（防止丢失未保存的捕获数据）
    let closing = false; // 处理中标志，防 async 决策期间重复点击弹二次确认
    void (async () => {
      const { confirm } = await import("@tauri-apps/plugin-dialog");
      void win.onCloseRequested(async (event) => {
        if (closing) {
          event.preventDefault(); // 已在处理流程中：再拦一次，别弹第二个确认
          return;
        }
        closing = true;
        event.preventDefault(); // 一律先拦截，再异步判定（防 await 期间窗口已关）
        try {
          if (!(await anyCapturing())) {
            await win.destroy(); // 未在捕获：destroy 直接关（不重入 onCloseRequested，无死锁）
            return;
          }
          const ok = await confirm("正在捕获中，关闭将丢失未保存的捕获数据。确定要关闭吗？", {
            title: "确认关闭",
            okLabel: "关闭",
            cancelLabel: "取消",
          });
          if (ok) {
            await win.destroy(); // 确认：destroy 直接关（不再触发 closeRequested，规避 close() 重入不生效）
          }
        } finally {
          closing = false;
        }
      });
    })();
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
  const tv = me.target as HTMLElement;
  if (tv instanceof HTMLInputElement || tv instanceof HTMLTextAreaElement) tv.focus();
  const items: CtxItem[] = [];
  const S = sessions.get(activeId);
  // 终端页：右键走 xterm 选区/粘贴（xterm 内部选区不是 DOM 选区，commonEditItems 识别不到，
  // 且粘贴应经 onData 发往端口而非改 input 值）
  if (S && S.currentPage === "terminal" && tv.closest?.(".term-host")) {
    const tpage = S.terminalPage;
    items.push({
      label: t("ctx.copy"),
      enabled: !!tpage && tpage.getSelectionText().length > 0,
      action: () => {
        const text = tpage?.getSelectionText();
        if (text) void navigator.clipboard.writeText(text);
      },
    });
    items.push({
      label: t("ctx.paste"),
      hint: t("ctx.paste.hint"),
      action: () =>
        void navigator.clipboard
          .readText()
          .then((text) => tpage?.pasteTerm(text))
          .catch(() => {}),
    });
    items.push({ label: t("ctx.selectAll"), action: () => tpage?.selectAllTerm() });
  } else {
    if (S && S.currentPage === "plot") {
      const cell = tv.closest?.(".plot-cell") as HTMLElement | null;
      if (cell) {
        const chAttr = cell.dataset.ch;
        items.push({
          label: t("ctx.copyPng"),
          hint: t("ctx.copyPng.hint"),
          action: () => S.plotPage.copyChartPng(chAttr === undefined ? null : Number(chAttr)),
        });
        items.push({
          label: t("ctx.exportCsv"),
          hint: chAttr === undefined ? t("ctx.exportCsv.all") : t("ctx.exportCsv.ch", { n: Number(chAttr) + 1 }),
          action: () => S.plotPage.exportCsv(chAttr === undefined ? null : Number(chAttr)),
        });
        items.push({ sep: true });
      } else if (tv.closest?.("#plot-bars") || tv.closest?.("#plot-holder")) {
        items.push({
          label: t("ctx.exportCsv"),
          hint: t("ctx.exportCsv.all"),
          action: () => S.plotPage.exportCsv(null),
        });
        items.push({ sep: true });
      }
    }
    items.push(...commonEditItems());
  }
  // 顶置弹出接收窗口（收发页/终端页右键）：独立置顶小窗实时显示本会话接收区
  if (S && S.connected && (S.currentPage === "terminal" || S.currentPage === "logview")) {
    items.push({ sep: true });
    items.push({
      label: t("ctx.popupReceive"),
      hint: t("ctx.popupReceive.hint"),
      action: () => void openPopupWindow(S.id, S.currentPage === "terminal" ? "terminal" : "logview"),
    });
  }
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
