// MAXCOM 前端外壳：连接管理（含串口参数/DTR/RTS/自动重连）+ 页面切换 + 轮询循环
import "./styles.css";
import { api, on, pickSavePath } from "./api";
import type { ConnState } from "./types";
import { createDropdown, type DropdownHandle } from "./dropdown";
import { TerminalPage } from "./pages/terminal";
import { LogViewPage } from "./pages/logview";
import { PlotPage } from "./pages/plot";
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

const baudPresets = ["9600", "19200", "38400", "57600", "115200", "230400", "460800", "921600", "1000000", "2000000"];
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

// ── 串口回环自检：发送标记字节，分层定位 断在 OS 写入 / 设备回环 / 前端事件 ──
$("#selftest-btn").addEventListener("click", () => {
  void (async () => {
    const marker = new TextEncoder().encode(`MAXCOM-SELFTEST-${Date.now() % 100000}`);
    const hex = [...marker].map((b) => b.toString(16).padStart(2, "0")).join("");
    // 累积整个窗口内的原始字节再搜标记（串口常把回环拆成多个 chunk，单 chunk 前缀匹配会误报）
    let acc = new Uint8Array(0);
    let chunks = 0;
    const unlisten = await on.raw((bytes) => {
      chunks++;
      const merged = new Uint8Array(acc.length + bytes.length);
      merged.set(acc);
      merged.set(bytes, acc.length);
      acc = merged;
      if (acc.length > 65536) acc = acc.slice(-4096); // 防爆内存
    });
    try {
      const st0 = await api.getStats();
      const n = await api.send({ hex, newline: "none" });
      await new Promise((r) => setTimeout(r, 1200));
      const st1 = await api.getStats();
      const txDelta = st1.tx_bytes - st0.tx_bytes;
      const rxDelta = st1.rx_bytes - st0.rx_bytes;
      const needle = [...marker].map((b) => b.toString(16).padStart(2, "0")).join("");
      const accHex = [...acc.slice(-256)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const sawMarker = accHex.includes(needle);
      if (txDelta < n) {
        setHint(`自检：OS 层写入异常（TX 仅 +${txDelta}/${n}B）`);
      } else if (rxDelta === 0 && chunks === 0) {
        setHint(`自检：写入 ${n}B ✓，但 1.2s 内零回环字节、零事件 → 查 TX/RX/GND 接线、波特率两端一致、驱动`);
      } else if (!sawMarker) {
        setHint(`自检：RX+${rxDelta}B/${chunks}个chunk 但未含标记 → 若终端页有乱码请截图；否则发我这段`);
      } else {
        setHint(`自检通过：写入→回环→前端事件 全链路 OK（${chunks} 个chunk）`, false);
      }
    } catch (e) {
      setHint(`自检：发送失败 → ${e}`);
    } finally {
      unlisten();
    }
  })();
});

// ── 页面 ──
const pages = ["terminal", "logview", "plot", "stats"] as const;
type PageId = (typeof pages)[number];
const terminalPage = new TerminalPage($("#page-terminal"), (msg) => setHint(msg));
const logViewPage = new LogViewPage($("#log-view"), {
  autoscroll: $<HTMLInputElement>("#autoscroll"),
  getTsMode: () => tsModeDd.value,
});
logViewRef = logViewPage;
const plotPage = new PlotPage($("#plot-holder"), $("#plot-controls"));
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
}

// ── 收发页：日志控制条（ts/encoding 下拉已在顶部创建）──

// 日志控制条选项变更 → 推送到引擎日志线程
function applyLogOptions() {
  void api
    .setLogOptions({
      idle_timeout_ms: Number(($("#idle-timeout") as HTMLInputElement).value) || 100,
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

// 多字符串面板开合
$("#toggle-multistr").addEventListener("click", () => {
  $("#multistr-panel").classList.toggle("hidden");
});

// 过滤/染色规则面板
new RulesPanel().init();

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
  if (e.key === "ArrowUp" && sendInput.selectionStart === 0 && history.length) {
    e.preventDefault();
    historyIdx = Math.min(historyIdx + 1, history.length - 1);
    sendInput.value = history[historyIdx];
    sendInput.selectionStart = sendInput.selectionEnd = sendInput.value.length;
  } else if (e.key === "ArrowDown" && sendInput.selectionStart === sendInput.value.length && history.length) {
    e.preventDefault();
    historyIdx = Math.max(historyIdx - 1, -1);
    sendInput.value = historyIdx >= 0 ? history[historyIdx] : "";
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
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK = 2048;
  const total = Math.ceil(bytes.length / CHUNK);
  for (let i = 0; i < total; i++) {
    const chunk = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, "0")).join("");
    await api.send({ hex, newline: "none" });
    sendBtn.textContent = `发送中 ${i + 1}/${total}`;
  }
  sendBtn.textContent = "发送 Ctrl+↵";
  sendHint.textContent = `文件已发送: ${file.name} (${bytes.length} B)`;
  setTimeout(() => (sendHint.textContent = ""), 3000);
  (e.target as HTMLInputElement).value = "";
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
    { value: "simple_binary", label: "Simple Binary" },
    { value: "ascii_delimited", label: "ASCII 分隔" },
  ],
  value: "simple_binary",
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

$("#plot-apply").addEventListener("click", () => {
  const channels = Math.max(1, Number(($("#plot-channels") as HTMLInputElement).value) || 1);
  let fmt;
  if (plotFmtDd.value === "simple_binary") {
    fmt = {
      type: "simple_binary" as const,
      channel_count: channels,
      dtype: plotDtypeDd.value as never,
      byte_order: plotEndianDd.value as "little" | "big",
    };
  } else {
    fmt = {
      type: "ascii_delimited" as const,
      delimiter: ($("#plot-delimiter") as HTMLInputElement).value || ",",
      channel_count: channels,
    };
  }
  void api.setPlotFormat(fmt);
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
