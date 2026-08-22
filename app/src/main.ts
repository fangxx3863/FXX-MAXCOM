// MAXCOM 前端外壳：连接管理（含串口参数/DTR/RTS/自动重连）+ 页面切换 + 轮询循环
import "./styles.css";
import { api, on, pickSavePath } from "./api";
import type { ConnState, DataFormat, DType } from "./types";
import { createDropdown, type DropdownHandle } from "./dropdown";
import { openContextMenu, commonEditItems, type CtxItem } from "./contextmenu";
import { TerminalPage } from "./pages/terminal";
import { LogViewPage } from "./pages/logview";
import { PlotPage, Y_PRESETS, type PlotLayout, type ViewMode } from "./pages/plot";
import { StatsPage } from "./pages/stats";
import { RulesPanel } from "./pages/rules";

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

let connected = false;
let connKind = "serial";

// ── 顶栏下拉 ──
const connTypeDd = createDropdown({
  items: [
    { value: "serial", label: "串口" },
    { value: "tcp_client", label: "TCP 客户端" },
    { value: "udp_client", label: "UDP" },
  ],
  onChange: (v) => {
    connKind = v;
    syncConnTypeUI();
  },
});
$("#conn-type-dd").replaceWith(connTypeDd.el);

const portDd = createDropdown({ items: [], placeholder: "选择串口…", width: 260 });
$("#serial-port-dd").replaceWith(portDd.el);

const baudPresets = [
  "1200", "2400", "4800", "9600", "14400", "19200", "28800", "38400", "57600",
  "76800", "115200", "230400", "250000", "460800", "500000", "921600",
  "1000000", "1152000", "1500000", "2000000",
];
const baudDd = createDropdown({
  items: baudPresets.map((b) => ({ value: b, label: b })),
  value: "115200",
  editable: true,
  placeholder: "波特率",
  width: 120,
});
$("#baud-dd").replaceWith(baudDd.el);

async function refreshPorts() {
  try {
    const ports = await api.listPorts();
    portDd.setItems(ports.map((p) => ({ value: p.device, label: p.description ? `${p.device} | ${p.description}` : p.device })));
  } catch {
    /* 浏览器演示模式由 mock 提供 */
  }
}
$("#refresh-ports").addEventListener("click", () => void refreshPorts());
void refreshPorts();

// ── 串口参数下拉 ──
function makeInline(id: string, items: string[], initial: string, onChange?: (v: string) => void): DropdownHandle {
  const dd = createDropdown({ items: items.map((v) => ({ value: v, label: v })), value: initial, onChange });
  $(`#${id}-dd`).replaceWith(dd.el);
  return dd;
}
const parityDd = makeInline("parity", ["none", "even", "odd"], "none");
const databitsDd = makeInline("databits", ["8", "7", "6", "5"], "8");
const stopbitsDd = makeInline("stopbits", ["1", "2"], "1");
const flowctlDd = makeInline("flowctl", ["none", "software(XON/XOFF)", "hardware(RTS/CTS)"], "none");

// 日志控制条下拉（先于页面创建；副作用经 logViewRef 可空引用挂接）
const tsModeDd = createDropdown({
  items: [
    { value: "absolute", label: "绝对" },
    { value: "relative", label: "相对" },
    { value: "delta", label: "差值 Δ" },
    { value: "none", label: "无" },
  ],
  value: "absolute",
  onChange: () => {
    logViewRef?.resetDeltaBase();
    applyLogOptions();
  },
});
document.querySelector("#ts-mode-dd")?.replaceWith(tsModeDd.el);
const encodingDd = createDropdown({
  items: [
    { value: "auto", label: "自动" },
    { value: "utf-8", label: "UTF-8" },
    { value: "gbk", label: "GBK" },
    { value: "gb2312", label: "GB2312" },
    { value: "latin-1", label: "Latin-1" },
  ],
  value: "auto",
  onChange: () => applyLogOptions(),
});
document.querySelector("#encoding-dd")?.replaceWith(encodingDd.el);
let logViewRef: { resetDeltaBase(): void; setHexDisplay(on: boolean): void } | null = null;

// DTR / RTS 引脚（复选框；连接串口时默认拉高）
let dtrOn = false;
let rtsOn = false;
const dtrChk = $<HTMLInputElement>("#dtr-chk");
const rtsChk = $<HTMLInputElement>("#rts-chk");
dtrChk.addEventListener("change", () => {
  dtrOn = dtrChk.checked;
  void api.setDtr(dtrOn).catch((e) => setHint(`DTR 设置失败: ${e}`));
});
rtsChk.addEventListener("change", () => {
  rtsOn = rtsChk.checked;
  void api.setRts(rtsOn).catch((e) => setHint(`RTS 设置失败: ${e}`));
});

// 「更多串口设置」弹窗
$("#more-serial").addEventListener("click", () => {
  $("#serial-setup").classList.toggle("hidden");
});
$("#setup-ok").addEventListener("click", () => {
  $("#serial-setup").classList.add("hidden");
});

const autoReconnectChk = $<HTMLInputElement>("#auto-reconnect");
autoReconnectChk.addEventListener("change", () => void api.setAutoReconnect(autoReconnectChk.checked));

// TCP 主机输入：可编辑下拉（保留常用主机历史）
const tcpHostDd = createDropdown({
  items: (JSON.parse(localStorage.getItem("maxcom.tcphosts") ?? '["127.0.0.1"]') as string[]).map((h) => ({ value: h, label: h })),
  value: "127.0.0.1",
  editable: true,
  placeholder: "主机",
  width: 150,
});
document.querySelector("#tcp-host-dd")?.replaceWith(tcpHostDd.el);

function syncConnTypeUI() {
  const isSerial = connKind === "serial";
  document.querySelectorAll<HTMLElement>(".serial-only").forEach((el) => el.classList.toggle("hidden", !isSerial));
  portDd.el.classList.toggle("hidden", !isSerial);
  $("#refresh-ports").classList.toggle("hidden", !isSerial);
  baudDd.el.classList.toggle("hidden", !isSerial);
  tcpHostDd.el.classList.toggle("hidden", isSerial);
  $("#tcp-port").classList.toggle("hidden", isSerial);
}
syncConnTypeUI();

// ── 连接/断开 ──
const connectBtn = $("#connect-btn");
const connDot = $("#conn-state");
const connLabel = $("#conn-label");
const sbState = $("#sb-state");

let hintTimer: number | null = null;
/** 全局轻提示：发送区 hint + 状态栏短暂红字 */
export function setHint(msg: string, isError = true) {
  const hint = $("#send-hint");
  if (hintTimer !== null) window.clearTimeout(hintTimer);
  hint.textContent = msg;
  hint.style.color = isError ? "var(--err)" : "var(--ok)";
  sbState.style.color = isError ? "var(--err)" : "";
  hintTimer = window.setTimeout(() => {
    hint.textContent = "";
    sbState.style.color = "";
  }, 4000);
}

connectBtn.addEventListener("click", () => {
  if (connected) {
    void api.disconnect();
    return;
  }
  let cfg;
  if (connKind === "serial") {
    cfg = {
      type: "serial" as const,
      port: portDd.value,
      baud: Number(baudDd.value) || 115200,
      data_bits: Number(databitsDd.value) || 8,
      parity: parityDd.value as "none" | "even" | "odd",
      stop_bits: stopbitsDd.value === "2" ? ("2" as const) : ("1" as const),
      flow_control: flowctlDd.value.startsWith("software")
        ? ("software" as const)
        : flowctlDd.value.startsWith("hardware")
          ? ("hardware" as const)
          : ("none" as const),
    };
    if (!cfg.port) {
      alert("请先选择串口");
      return;
    }
  } else {
    cfg = {
      type: connKind === "tcp_client" ? ("tcp_client" as const) : ("udp_client" as const),
      host: tcpHostDd.value,
      port: Number($<HTMLInputElement>("#tcp-port").value) || 8888,
    };
    // 记住主机历史
    const hosts = new Set<string>([cfg.host, ...((JSON.parse(localStorage.getItem("maxcom.tcphosts") ?? "[]") as string[]) || [])]);
    localStorage.setItem("maxcom.tcphosts", JSON.stringify([...hosts].slice(0, 8)));
  }
  void api.setAutoReconnect(autoReconnectChk.checked);
  // 串口默认拉高 DTR/RTS（多数设备期望的打开姿态）
  if (connKind === "serial") {
    dtrOn = true;
    rtsOn = true;
    dtrChk.checked = true;
    rtsChk.checked = true;
  }
  api
    .connect(cfg)
    .then(() => {
      if (connKind === "serial") {
        void api.setDtr(dtrOn).catch(() => {});
        void api.setRts(rtsOn).catch(() => {});
      }
      // 连接即按当前绘图控件下发格式（默认 ASCII），无需手动点应用
      void api.setPlotFormat(buildPlotFormat()).catch(() => {});
    })
    .catch((e) => alert(`连接失败: ${e}`));
});

on.state((s: ConnState) => {
  connected = s.connected;
  if (!s.connected) terminalPage.clear();
  connDot.className = `dot ${s.connected ? "on" : "off"}`;
  connDot.title = s.error ?? (s.connected ? "已连接" : "未连接");
  connLabel.textContent = s.label;
  sbState.textContent = s.error ? `错误: ${s.error}` : s.connected ? `已连接 ${s.label}` : "未连接";
  connectBtn.textContent = s.connected ? "断开" : "连接";
});


// ── 页面 ──
const pages = ["terminal", "logview", "plot", "stats", "settings"] as const;
type PageId = (typeof pages)[number];
const terminalPage = new TerminalPage($("#page-terminal"), (msg) => setHint(msg));
const logViewPage = new LogViewPage($("#log-view"), {
  autoscroll: $<HTMLInputElement>("#autoscroll"),
  getTsMode: () => tsModeDd.value,
});
logViewRef = logViewPage;
const plotPage = new PlotPage($("#plot-holder"), $("#plot-controls"), $("#plot-chbar"));
const statsPage = new StatsPage($("#page-stats"));

let currentPage: PageId = "logview";
document.querySelectorAll<HTMLButtonElement>("#sidebar button").forEach((btn) => {
  btn.addEventListener("click", () => switchPage(btn.dataset.page as PageId));
});
function switchPage(id: PageId) {
  currentPage = id;
  for (const p of pages) $(`#page-${p}`).classList.toggle("hidden", p !== id);
  document.querySelectorAll<HTMLButtonElement>("#sidebar button").forEach((b) =>
    b.classList.toggle("active", b.dataset.page === id),
  );
  if (id === "plot") plotPage.onShow(); // 隐藏期间量不到尺寸，显示后按真实容器重建
  // 强制重新合成一层，清掉 WebView2 页面切换后的右缘残影
  requestAnimationFrame(() => {
    const el = $("#pages") as HTMLElement;
    el.style.transform = "translateZ(0)";
    requestAnimationFrame(() => (el.style.transform = ""));
  });
}

// ── 收发页：日志控制条（ts/encoding 下拉已在顶部创建）──

// 日志控制条选项变更 → 推送到引擎日志线程
function applyLogOptions() {
  void api
    .setLogOptions({
      idle_timeout_ms: Number(($("#idle-timeout") as HTMLInputElement).value) || 10,
      timestamp_mode: tsModeDd.value,
      encoding: encodingDd.value,
    })
    .catch(() => {});
}
$("#idle-timeout").addEventListener("change", applyLogOptions);
$<HTMLInputElement>("#hex-display").addEventListener("change", (e) => {
  logViewRef?.setHexDisplay((e.target as HTMLInputElement).checked);
});

$("#clear-log").addEventListener("click", () => {
  logViewPage.clear();
  void api.clearLog();
});

// 快捷过滤：仅显示匹配行（正则优先，非法回退子串；150ms 防抖，对新旧数据即时生效）
let quickFilterTimer: number | null = null;
$("#quick-filter").addEventListener("input", (e) => {
  const v = (e.target as HTMLInputElement).value;
  if (quickFilterTimer !== null) window.clearTimeout(quickFilterTimer);
  quickFilterTimer = window.setTimeout(() => logViewPage.setQuickFilter(v), 150);
});

// 多字符串面板开合（☰ 按钮与面板内 ✕ 均可）
$("#toggle-multistr").addEventListener("click", () => {
  $("#multistr-panel").classList.toggle("hidden");
});
$("#ms-close").addEventListener("click", () => {
  $("#multistr-panel").classList.add("hidden");
});

// 过滤/染色规则面板
new RulesPanel().init();

// 侧栏（多字符串/规则）左缘拖拽调宽，记忆到 localStorage
function makePanelResizable(panel: HTMLElement) {
  const h = document.createElement("div");
  h.className = "panel-resizer";
  h.title = "拖拽调整宽度";
  panel.prepend(h);
  const saved = Number(localStorage.getItem(`maxcom.panelw.${panel.id}`));
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
      localStorage.setItem(`maxcom.panelw.${panel.id}`, String(parseInt(panel.style.width)));
      h.removeEventListener("pointermove", move);
      h.removeEventListener("pointerup", up);
    };
    h.addEventListener("pointermove", move);
    h.addEventListener("pointerup", up);
  });
}
makePanelResizable($("#multistr-panel"));
makePanelResizable($("#rules-panel"));

// ── 发送区 ──
const sendInput = $<HTMLTextAreaElement>("#send-input");
const sendBtn = $("#send-btn");
const sendHint = $("#send-hint");
const newlineDd = createDropdown({
  items: [
    { value: "none", label: "无换行" },
    { value: "\\n", label: "\\n" },
    { value: "\\r", label: "\\r" },
    { value: "\\r\\n", label: "\\r\\n" },
  ],
  value: "none",
});
$("#send-newline-dd").replaceWith(newlineDd.el);
const sendModeDd = createDropdown({
  items: [
    { value: "text", label: "文本" },
    { value: "hex", label: "HEX" },
  ],
  value: "text",
});
$("#send-mode-dd").replaceWith(sendModeDd.el);

function realNewline(): string {
  return newlineDd.value.replace(/\\r/g, "\r").replace(/\\n/g, "\n");
}

async function doSend(textOverride?: string) {
  const content = textOverride ?? sendInput.value;
  if (!content) return;
  const payload =
    sendModeDd.value === "hex"
      ? { hex: content.trim(), newline: realNewline() }
      : { text: content, newline: realNewline() };
  try {
    await api.send(payload);
    if (!textOverride) {
      pushHistory(content);
      historyIdx = -1;
    }
  } catch (e) {
    sendHint.textContent = `发送失败: ${e}`;
    setTimeout(() => (sendHint.textContent = ""), 3000);
  }
}
sendBtn.addEventListener("click", () => void doSend());

// Ctrl+Enter 发送；↑↓ 历史（光标在首行末/尾行首时接管）
const history: string[] = JSON.parse(localStorage.getItem("maxcom.sendhist") ?? "[]");
let historyIdx = -1;
function pushHistory(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const i = history.indexOf(trimmed);
  if (i >= 0) history.splice(i, 1);
  history.unshift(trimmed);
  if (history.length > 50) history.pop();
  localStorage.setItem("maxcom.sendhist", JSON.stringify(history));
}
sendInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void doSend();
    return;
  }
  if (!history.length) return;
  // 单行内容（无换行符）时 ↑↓ 直接翻历史，不经历“先移到行首/行尾”的中间步；
  // 多行编辑时退回边界规则：光标在首列才上翻、末列才下翻
  const singleLine = !sendInput.value.includes("\n");
  const col0 = sendInput.selectionStart === 0 && sendInput.selectionEnd === 0;
  const colEnd =
    sendInput.selectionStart === sendInput.value.length && sendInput.selectionEnd === sendInput.value.length;
  if (e.key === "ArrowUp" && (singleLine || col0)) {
    e.preventDefault();
    historyIdx = Math.min(historyIdx + 1, history.length - 1);
    sendInput.value = history[historyIdx];
    sendInput.selectionStart = sendInput.selectionEnd = sendInput.value.length;
  } else if (e.key === "ArrowDown" && (singleLine || colEnd)) {
    e.preventDefault();
    historyIdx = Math.max(historyIdx - 1, -1);
    sendInput.value = historyIdx >= 0 ? history[historyIdx] : "";
    sendInput.selectionStart = sendInput.selectionEnd = sendInput.value.length;
  }
});

// 定时发送
let timerHandle: number | null = null;
$("#timer-send").addEventListener("change", (e) => {
  const on = (e.target as HTMLInputElement).checked;
  if (timerHandle !== null) {
    window.clearInterval(timerHandle);
    timerHandle = null;
  }
  if (on) {
    const ms = Math.max(10, Number($<HTMLInputElement>("#timer-ms").value) || 1000);
    timerHandle = window.setInterval(() => void doSend(), ms);
  }
});

// 文件发送：读原始字节 → HEX 分块
$("#file-btn").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const fileBtn = $<HTMLButtonElement>("#file-btn");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK = 512;
  // 令牌桶按线速放行（每字节约 10bit @8N1）：超过波特率吞吐会撑爆
  // 驱动 FIFO —— 部分 USB 虚拟串口满载时直接丢数据
  const baud = Math.max(1, Number(baudDd.value) || 115200);
  const t0 = performance.now();
  let sentBytes = 0;
  const totalChunks = Math.ceil(bytes.length / CHUNK);
  fileBtn.disabled = true;
  try {
    for (let i = 0; i < totalChunks; i++) {
      const chunk = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
      const hex = [...chunk].map((b) => b.toString(16).padStart(2, "0")).join("");
      await api.send({ hex, newline: "none" });
      sentBytes += chunk.length;
      fileBtn.textContent = `发文件 ${Math.min(99, Math.round((sentBytes / bytes.length) * 100))}%`;
      // 追平计划节拍：领先于线速进度才等待
      const dueMs = ((sentBytes * 10) / baud) * 1000;
      const wait = dueMs - (performance.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, Math.ceil(wait)));
    }
    sendHint.textContent = `文件已发送: ${file.name} (${bytes.length} B)`;
    setTimeout(() => (sendHint.textContent = ""), 3000);
  } catch (err) {
    setHint(`发文件失败: ${err}`);
  } finally {
    fileBtn.textContent = "发文件";
    fileBtn.disabled = false;
    input.value = "";
  }
});

// 接收捕获
const captureBtn = $("#capture-btn");
captureBtn.addEventListener("click", async () => {
  const [capturing] = await api.captureState();
  if (!capturing) {
    await api.startCapture();
    captureBtn.textContent = "■ 停止并保存";
    captureBtn.classList.add("recording");
  } else {
    const path = await pickSavePath("maxcom_capture.bin");
    if (!path) {
      // 浏览器演示模式：mock 直接触发下载
      const n = await api.saveCapture("maxcom_capture.bin");
      sendHint.textContent = `已保存捕获 ${n} B`;
    } else {
      const n = await api.saveCapture(path as string);
      sendHint.textContent = `已保存捕获 ${n} B → ${path}`;
    }
    captureBtn.textContent = "● 捕获";
    captureBtn.classList.remove("recording");
    setTimeout(() => (sendHint.textContent = ""), 4000);
  }
});

// ── 多字符串面板 ──
interface MsRow {
  enabled: boolean;
  content: string;
  hex: boolean;
  delayMs: number;
}
const msRows: MsRow[] = JSON.parse(localStorage.getItem("maxcom.multistr") ?? "[]");
if (!msRows.length) {
  msRows.push(
    { enabled: true, content: "13 00 FF 88", hex: true, delayMs: 1000 },
    { enabled: true, content: "output string", hex: false, delayMs: 1000 },
  );
}
let msLoopTimer: number | null = null;

function persistMs() {
  localStorage.setItem("maxcom.multistr", JSON.stringify(msRows));
}

function renderMsRows() {
  const holder = $("#ms-rows");
  holder.replaceChildren(
    ...msRows.map((row, idx) => {
      const div = document.createElement("div");
      div.className = "ms-row";
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = row.enabled;
      chk.addEventListener("change", () => {
        row.enabled = chk.checked;
        persistMs();
      });
      const input = document.createElement("input");
      input.className = "ms-content";
      input.value = row.content;
      input.placeholder = row.hex ? "HEX 字节，如 13 00 FF" : "字符串内容";
      input.addEventListener("change", () => {
        row.content = input.value;
        persistMs();
      });
      const typeBtn = document.createElement("button");
      typeBtn.className = "ms-type";
      typeBtn.textContent = row.hex ? "HEX" : "TXT";
      typeBtn.addEventListener("click", () => {
        row.hex = !row.hex;
        persistMs();
        renderMsRows();
      });
      const delay = document.createElement("input");
      delay.type = "number";
      delay.className = "ms-delay";
      delay.value = String(row.delayMs);
      delay.min = "10";
      delay.title = "循环发送时本行之后的延时(ms)";
      delay.addEventListener("change", () => {
        row.delayMs = Number(delay.value) || 0;
        persistMs();
      });
      const sendOne = document.createElement("button");
      sendOne.textContent = "发送";
      sendOne.addEventListener("click", () => void sendMsRow(row));
      const del = document.createElement("button");
      del.textContent = "✕";
      del.title = "删除本行";
      del.addEventListener("click", () => {
        msRows.splice(idx, 1);
        persistMs();
        renderMsRows();
      });
      div.append(chk, input, typeBtn, delay, sendOne, del);
      return div;
    }),
  );
}

async function sendMsRow(row: MsRow) {
  if (row.hex) {
    await api.send({ hex: row.content, newline: "none" });
  } else {
    await api.send({ text: row.content, newline: realNewline() });
  }
}

$("#ms-add").addEventListener("click", () => {
  msRows.push({ enabled: true, content: "", hex: false, delayMs: 1000 });
  persistMs();
  renderMsRows();
});
$("#ms-clear").addEventListener("click", () => {
  msRows.length = 0;
  persistMs();
  renderMsRows();
});
$("#ms-loop").addEventListener("change", async (e) => {
  const on = (e.target as HTMLInputElement).checked;
  if (msLoopTimer !== null) {
    window.clearTimeout(msLoopTimer);
    msLoopTimer = null;
  }
  if (on) {
    const loopOnce = async () => {
      for (const row of msRows.filter((r) => r.enabled && r.content)) {
        if (!($("#ms-loop") as HTMLInputElement).checked) return;
        await sendMsRow(row);
        $("#ms-status").textContent = `已发送: ${row.content.slice(0, 24)}`;
        await new Promise((r) => setTimeout(r, Math.max(10, row.delayMs)));
      }
      if (($("#ms-loop") as HTMLInputElement).checked) msLoopTimer = window.setTimeout(loopOnce, 50);
    };
    void loopOnce();
  } else {
    $("#ms-status").textContent = "";
  }
});
renderMsRows();

// ── 绘图页配置 ──
const plotFmtDd = createDropdown({
  items: [
    { value: "ascii_delimited", label: "ASCII 分隔" },
    { value: "simple_binary", label: "Simple Binary" },
    { value: "custom_frame", label: "自定义帧" },
  ],
  value: "ascii_delimited",
  onChange: () => applyPlotFmtControls(),
});
$("#plot-fmt-dd").replaceWith(plotFmtDd.el);
const plotDtypeDd = makeInline("plot-dtype", ["uint8", "int8", "uint16", "int16", "uint32", "int32", "float32", "float64"], "int16");
const plotEndianDd = createDropdown({
  items: [
    { value: "little", label: "小端" },
    { value: "big", label: "大端" },
  ],
  value: "little",
});
$("#plot-endian-dd").replaceWith(plotEndianDd.el);
const plotASplitDd = createDropdown({
  items: [
    { value: "channel", label: "分通道" },
    { value: "package", label: "分包·整行覆盖" },
  ],
  value: "channel",
});
$("#plot-asplit-dd").replaceWith(plotASplitDd.el);
const plotFrameLenDd = createDropdown({
  items: [
    { value: "fixed", label: "定长字节" },
    { value: "payload", label: "首字节=长度" },
  ],
  value: "fixed",
  onChange: () => {
    $("#plot-framelen-fixed").classList.toggle("hidden", plotFrameLenDd.value !== "fixed");
  },
});
$("#plot-framelen-dd").replaceWith(plotFrameLenDd.el);

// 格式联动：二进制/自定义帧显示 通道/类型/端序，自定义帧另有帧头/帧长/校验，ASCII 显示分隔符
function applyPlotFmtControls() {
  const fmt = plotFmtDd.value;
  const binLike = fmt === "simple_binary" || fmt === "custom_frame";
  $("#plot-ch-ctl").classList.toggle("hidden", !binLike);
  $("#plot-ascii-ctl").classList.toggle("hidden", fmt !== "ascii_delimited");
  $("#plot-custom-ctl").classList.toggle("hidden", fmt !== "custom_frame");
}
applyPlotFmtControls();

// 显示模式：波形 / 垂直柱状 / 同屏
const plotViewDd = createDropdown({
  items: [
    { value: "waveform", label: "波形图" },
    { value: "bars", label: "垂直柱状" },
    { value: "both", label: "同屏显示" },
  ],
  value: "waveform",
  onChange: (v) => plotPage.setViewMode(v as ViewMode),
});
$("#plot-view-dd").replaceWith(plotViewDd.el);

// 布局：分开子图 / 单图叠加（多色图例）
const plotLayoutDd = createDropdown({
  items: [
    { value: "subplots", label: "分开子图" },
    { value: "overlay", label: "单图叠加" },
  ],
  value: "subplots",
  onChange: (v) => plotPage.setLayout(v as PlotLayout),
});
$("#plot-layout-dd").replaceWith(plotLayoutDd.el);

// Y 轴范围：自动缩放 / 位宽预设 / 常用固定范围
const plotYRangeDd = createDropdown({
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
  onChange: (v) => applyYRangeSelection(v),
});
$("#plot-yrange-dd").replaceWith(plotYRangeDd.el);

function applyYRangeSelection(v: string) {
  const customCtl = $("#plot-ycustom-ctl");
  if (v === "custom") {
    customCtl.classList.remove("hidden");
    applyCustomYRange();
  } else {
    customCtl.classList.add("hidden");
    if (Y_PRESETS[v] !== undefined) plotPage.setYRange(v);
  }
}
function applyCustomYRange() {
  const lo = Number(($("#plot-ymin") as HTMLInputElement).value);
  const hi = Number(($("#plot-ymax") as HTMLInputElement).value);
  if (Number.isFinite(lo) && Number.isFinite(hi)) plotPage.setYRangeCustom(lo, hi);
}
$("#plot-ymin").addEventListener("change", applyCustomYRange);
$("#plot-ymax").addEventListener("change", applyCustomYRange);

$("#plot-buffer").addEventListener("change", (e) => {
  const cap = Number((e.target as HTMLInputElement).value) || 10000;
  void api.setPlotBuffer(cap);
});

/** 从绘图控件读取当前格式配置（应用按钮 / 连接时自动下发共用） */
function buildPlotFormat(): DataFormat {
  const channels = Math.max(1, Number(($("#plot-channels") as HTMLInputElement).value) || 1);
  if (plotFmtDd.value === "simple_binary") {
    return {
      type: "simple_binary",
      channel_count: channels,
      dtype: plotDtypeDd.value as DType,
      byte_order: plotEndianDd.value as "little" | "big",
    };
  }
  if (plotFmtDd.value === "custom_frame") {
    return {
      type: "custom_frame",
      frame_header: ($("#plot-frame-header") as HTMLInputElement).value.trim(),
      frame_length:
        plotFrameLenDd.value === "fixed"
          ? Math.max(1, Number(($("#plot-frame-size") as HTMLInputElement).value) || 1)
          : null,
      dtype: plotDtypeDd.value as DType,
      byte_order: plotEndianDd.value as "little" | "big",
      checksum: ($("#plot-checksum") as HTMLInputElement).checked ? "checksum" : "none",
      channel_count: channels,
    };
  }
  // ASCII：channel_count 传 0 → 引擎按首行数据自动探测列数
  return {
    type: "ascii_delimited",
    delimiter: ($("#plot-delimiter") as HTMLInputElement).value || ",",
    split: plotASplitDd.value as "channel" | "package",
    channel_count: 0,
  };
}
$("#plot-apply").addEventListener("click", () => {
  void api.setPlotFormat(buildPlotFormat());
});

// ── 事件与轮询 ──
void on.entries((batch) => logViewPage.append(batch));

const sbRx = $("#sb-rx");
const sbTx = $("#sb-tx");
const sbRate = $("#sb-rate");
function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
setInterval(() => {
  api.getStats()
    .then((st) => {
      statsPage.updateConn(st);
      sbRx.textContent = `RX ${fmtBytes(st.rx_bytes)}`;
      sbTx.textContent = `TX ${fmtBytes(st.tx_bytes)}`;
      sbRate.textContent = `↓ ${st.rx_rate_kbs.toFixed(2)} KB/s ↑ ${st.tx_rate_kbs.toFixed(2)} KB/s`;
    })
    .catch(() => {});
}, 500);

setInterval(() => {
  // 捕获状态徽标
  api.captureState().then(([capturing, size]) => {
    if (capturing) captureBtn.textContent = `■ 停止并保存 (${(size / 1024).toFixed(1)} KB)`;
  }).catch(() => {});
}, 500);

async function pollPlot() {
  try {
    const snap = await api.plotSnapshot(2000);
    if (currentPage === "plot") plotPage.update(snap);
    if (currentPage === "stats") statsPage.updateChannels(snap);
  } catch {
    /* 未连接等 */
  }
}
setInterval(() => void pollPlot(), 50);

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

// 自定义右键菜单替代原生（刷新入口被移除）；Shift+右键保留原生菜单用于调试。
// F5/Ctrl+R 仍拦截：误触整页重载会丢连接状态与全部缓冲（生产构建）。
window.addEventListener("contextmenu", (e) => {
  const me = e as MouseEvent;
  if (me.shiftKey) return;
  me.preventDefault();
  const t = me.target as HTMLElement;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) t.focus();
  const items: CtxItem[] = [];
  // 绘图页扩展项：图表 PNG / CSV
  if (currentPage === "plot") {
    const cell = t.closest?.(".plot-cell") as HTMLElement | null;
    if (cell) {
      const chAttr = cell.dataset.ch;
      items.push({
        label: "📋 复制图表为 PNG",
        hint: "写入剪贴板；失败时转为下载",
        action: () => plotPage.copyChartPng(chAttr === undefined ? null : Number(chAttr)),
      });
      items.push({
        label: "📄 导出 CSV",
        hint: chAttr === undefined ? "全部通道缓冲数据" : `CH${Number(chAttr) + 1} 缓冲数据`,
        action: () => plotPage.exportCsv(chAttr === undefined ? null : Number(chAttr)),
      });
      items.push({ sep: true });
    } else if (t.closest?.("#plot-bars") || t.closest?.("#plot-holder")) {
      items.push({
        label: "📄 导出 CSV",
        hint: "全部通道缓冲数据",
        action: () => plotPage.exportCsv(null),
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

// ── 设置页：字体/字号，即时生效 + localStorage 持久化 ──
interface AppSettings {
  logSize: number;
  logFamily: string;
  termSize: number;
}
const DEFAULT_SETTINGS: AppSettings = { logSize: 12.5, logFamily: 'Consolas, "Cascadia Mono", monospace', termSize: 14 };
const SETTINGS_KEY = "maxcom.settings";

function loadSettings(): AppSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<AppSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let currentSettings = loadSettings();

function applySettings(st: AppSettings) {
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--log-size", `${st.logSize}px`);
  rootStyle.setProperty("--log-family", st.logFamily);
  terminalPage.setFontSize(st.termSize);
}

const logSizeInput = $<HTMLInputElement>("#set-log-size");
const logFamilySel = $<HTMLSelectElement>("#set-log-family");
const termSizeInput = $<HTMLInputElement>("#set-term-size");

function saveSettings(st: AppSettings) {
  currentSettings = st;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(st));
  applySettings(st);
}

logSizeInput.value = String(currentSettings.logSize);
logFamilySel.value = currentSettings.logFamily;
termSizeInput.value = String(currentSettings.termSize);

logSizeInput.addEventListener("change", () =>
  saveSettings({ ...currentSettings, logSize: Number(logSizeInput.value) || 12.5 }),
);
logFamilySel.addEventListener("change", () => saveSettings({ ...currentSettings, logFamily: logFamilySel.value }));
termSizeInput.addEventListener("change", () =>
  saveSettings({ ...currentSettings, termSize: Number(termSizeInput.value) || 14 }),
);
$("#set-reset").addEventListener("click", () => {
  saveSettings({ ...DEFAULT_SETTINGS });
  logSizeInput.value = String(DEFAULT_SETTINGS.logSize);
  logFamilySel.value = DEFAULT_SETTINGS.logFamily;
  termSizeInput.value = String(DEFAULT_SETTINGS.termSize);
});
applySettings(currentSettings);
