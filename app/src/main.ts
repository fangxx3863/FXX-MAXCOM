// MAXCOM 前端外壳：连接管理 + 页面切换 + 轮询循环
import "./styles.css";
import { api, on } from "./api";
import type { ConnState } from "./types";
import { TerminalPage } from "./pages/terminal";
import { LogViewPage } from "./pages/logview";
import { PlotPage } from "./pages/plot";
import { StatsPage } from "./pages/stats";

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

const connType = $<HTMLSelectElement>("#conn-type");
const serialPort = $<HTMLSelectElement>("#serial-port");
const refreshBtn = $("#refresh-ports");
const tcpHost = $<HTMLInputElement>("#tcp-host");
const tcpPort = $<HTMLInputElement>("#tcp-port");
const baud = $<HTMLSelectElement>("#baud");
const connectBtn = $("#connect-btn");
const connDot = $("#conn-state");
const connLabel = $("#conn-label");
const sbState = $("#sb-state");

let connected = false;

// ── 串口枚举 ──
async function refreshPorts() {
  try {
    const ports = await api.listPorts();
    serialPort.replaceChildren(
      ...ports.map((p) => {
        const opt = document.createElement("option");
        opt.value = p.device;
        opt.textContent = p.description ? `${p.device} | ${p.description}` : p.device;
        return opt;
      }),
    );
  } catch {
    /* 非 Tauri 环境（浏览器调试）忽略 */
  }
}
refreshBtn.addEventListener("click", () => void refreshPorts());
void refreshPorts();

// ── 连接类型切换 ──
function syncConnTypeUI() {
  const isSerial = connType.value === "serial";
  serialPort.classList.toggle("hidden", !isSerial);
  refreshBtn.classList.toggle("hidden", !isSerial);
  baud.classList.toggle("hidden", !isSerial);
  tcpHost.classList.toggle("hidden", isSerial);
  tcpPort.classList.toggle("hidden", isSerial);
}
connType.addEventListener("change", syncConnTypeUI);
syncConnTypeUI();

// ── 连接/断开 ──
connectBtn.addEventListener("click", () => {
  if (connected) {
    void api.disconnect();
    return;
  }
  let cfg;
  if (connType.value === "serial") {
    cfg = {
      type: "serial" as const,
      port: serialPort.value,
      baud: Number(baud.value) || 115200,
      data_bits: 8,
      parity: "none" as const,
      stop_bits: "1" as const,
      flow_control: "none" as const,
    };
  } else {
    cfg = {
      type: connType.value === "tcp_client" ? ("tcp_client" as const) : ("udp_client" as const),
      host: tcpHost.value,
      port: Number(tcpPort.value) || 8888,
    };
  }
  api.connect(cfg).catch((e) => alert(`连接失败: ${e}`));
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
const pages = ["terminal", "logview", "plot", "stats"] as const;
type PageId = (typeof pages)[number];
const terminalPage = new TerminalPage($("#page-terminal"));
const logViewPage = new LogViewPage($("#log-view"), $("#log-controls"));
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

// ── 收发页发送面板 ──
const sendInput = $<HTMLInputElement>("#send-input");
const sendMode = $<HTMLSelectElement>("#send-mode");
const sendNewline = $<HTMLSelectElement>("#send-newline");
function doSend() {
  const payload =
    sendMode.value === "hex"
      ? { hex: sendInput.value.trim(), newline: sendNewline.value.replace(/\\r/g, "\r").replace(/\\n/g, "\n") }
      : { text: sendInput.value, newline: sendNewline.value.replace(/\\r/g, "\r").replace(/\\n/g, "\n") };
  api.send(payload).catch((e) => alert(`发送失败: ${e}`));
}
$("#send-btn").addEventListener("click", doSend);
sendInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) doSend();
});

// ── 事件接线 ──
void on.entries((batch) => logViewPage.append(batch));

// ── 轮询：统计 500ms；绘图快照 50ms（仅绘图/统计页可见时）──
setInterval(() => {
  api.getStats().then(statsPage.updateConn.bind(statsPage)).catch(() => {});
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
