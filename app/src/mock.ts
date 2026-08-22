// 演示模式：非 Tauri 环境（纯浏览器 npm run dev）下的模拟后端。
// 目的：前端样式/交互调试不需要真实设备与桌面外壳——F12 即完整 DevTools。
// 数据形态与真实链路一致（同一套 DTO），切回 Tauri 零改动。
// 多会话：每个标签页一个独立 MockBackend 实例（按 session id 惰性创建），
// 事件经全局 hub 分发并携带 session 标签，与真实后端的事件路由形态一致。

import type {
  ChannelMetrics, ConnConfig, ConnState, DataFormat, EntriesBatch,
  PlotSnapshotDto, PortInfo, SendPayload, StatsSnapshot,
} from "./types";
import type { ColoredSegment } from "./types";

type Listener<T> = (payload: T) => void;

/** 会话级 API（浏览器演示版）：与真实 SessionApi 同形 */
export interface MockApi {
  listPorts(): Promise<PortInfo[]>;
  connect(config: ConnConfig): Promise<void>;
  disconnect(): Promise<void>;
  send(payload: SendPayload): Promise<number>;
  setLogOptions(o: { idle_timeout_ms: number; timestamp_mode: string; encoding: string }): Promise<void>;
  setFilters(rules: unknown[]): Promise<void>;
  setColorRules(master: boolean, ansiYield: boolean, rules: unknown[]): Promise<void>;
  clearLog(): Promise<void>;
  getStats(): Promise<StatsSnapshot>;
  setPlotFormat(fmt: DataFormat): Promise<void>;
  setPlotBuffer(capacity: number): Promise<void>;
  plotSnapshot(maxPoints: number): Promise<PlotSnapshotDto>;
  setDtr(on: boolean): Promise<void>;
  setRts(on: boolean): Promise<void>;
  setAutoReconnect(on: boolean): Promise<void>;
  startCapture(): Promise<void>;
  saveCapture(path: string): Promise<number>;
  captureState(): Promise<[boolean, number, number]>;
}

const DEMO_PORTS: PortInfo[] = [
  { device: "COM3", description: "USB-SERIAL CH340 (demo)" },
  { device: "COM7", description: "Standard Serial over Bluetooth (demo)" },
  { device: "COM11", description: "STMicroelectronics ST-LINK VCP (demo)" },
];

const LINES: Array<{ segs: ColoredSegment[] }> = [
  { segs: [{ text: "[D] gc pass 3 freed 2048", fg: "gray" }] },
  { segs: [{ text: "[I] service netd started pid=421", fg: undefined }] },
  { segs: [{ text: "[W] cpu load high", fg: "yellow" }] },
  { segs: [{ text: "[E] sensor i2c timeout addr=0x2F retry=3", fg: "red" }] },
  { segs: [{ text: "[F] watchdog reset imminent!", fg: "red", bold: true }] },
  {
    // 键值对 + 数值高亮形态
    segs: [
      { text: "temp", fg: undefined }, { text: ":", fg: undefined },
      { text: " ", fg: undefined }, { text: "78.5", fg: "cyan" },
      { text: " hum ", fg: undefined }, { text: "45", fg: "cyan" },
      { text: " crc ", fg: undefined }, { text: "0x1F3A", fg: "magenta" },
    ],
  },
  { segs: [{ text: "samples 3.14 -2.5e3 0xFF 42 done", fg: undefined }] },
  {
    // 模拟"ANSI 让位"后的日志形态：提示符绿色段 + 普通文本段
    segs: [
      { text: "root@maxcom:~$", fg: "green" },
      { text: " tail -f /var/log/syslog" },
    ],
  },
];

class MockBackend implements MockApi {
  private connected = false;
  private label = "";
  private timers: number[] = [];
  private ts = 0;
  private startWall = Date.now(); // 固定墙钟锚点：wall = startWall + ts_ms（随时间前进）
  private rxTotal = 0;
  private txTotal = 0;
  private rxWindow: Array<[number, number]> = [];
  private txWindow: Array<[number, number]> = [];
  private errors = 0;

  private channels = 1;
  private points = 0;
  private captureBuf: number[] = [];
  private filters: Array<{ pattern: string; action: string; enabled: boolean }> = [];

  constructor(private session: string) {}

  async listPorts() {
    return DEMO_PORTS;
  }

  async connect(config: ConnConfig) {
    if (this.connected) throw "已有活动连接（先断开再连）";
    this.connected = true;
    this.label =
      config.type === "serial"
        ? `串口 ${config.port} @ ${config.baud}`
        : `${config.type === "tcp_client" ? "TCP" : "UDP"} ${config.host}:${config.port}`;
    this.emitState();
    const tick = window.setInterval(() => this.pump(), 160);
    this.timers.push(tick);
  }

  async disconnect() {
    this.connected = false;
    this.timers.forEach((t) => window.clearInterval(t));
    this.timers = [];
    this.emitState();
  }

  async send(payload: SendPayload) {
    if (!this.connected) throw "未连接";
    let bytes: Uint8Array;
    if (payload.hex) {
      const clean = payload.hex.replace(/\s+/g, "");
      bytes = new Uint8Array((clean.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)));
    } else {
      bytes = new TextEncoder().encode(payload.text ?? "");
    }
    if (payload.newline === "\n") bytes = concat(bytes, 10);
    else if (payload.newline === "\r") bytes = concat(bytes, 13);
    else if (payload.newline === "\r\n") bytes = concat(bytes, 13, 10);
    this.txTotal += bytes.length;
    this.txWindow.push([performance.now(), bytes.length]);
    // 回显到终端原始流
    emitRaw(this.session, bytes);
    return bytes.length;
  }

  async setLogOptions(_o: { idle_timeout_ms: number; timestamp_mode: string; encoding: string }) {}
  async clearLog() {}
  async setDtr(_on: boolean) {}
  async setRts(_on: boolean) {}
  async setAutoReconnect(_on: boolean) {}

  private capturing = false;

  async startCapture() {
    this.capturing = true;
    this.captureBuf = [];
  }

  async saveCapture(path: string): Promise<number> {
    const data = this.captureBuf;
    this.capturing = false;
    // 浏览器演示模式：触发下载（path 仅作文件名提示）
    const name = (path.split(/[\\/]/).pop() ?? "maxcom_capture.bin").trim() || "maxcom_capture.bin";
    const blob = new Blob([new Uint8Array(data)], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    return data.length;
  }

  async captureState(): Promise<[boolean, number, number]> {
    return [this.capturing, this.captureBuf.length, 0];
  }

  async setFilters(rules: unknown[]) {
    this.filters = rules as never[];
  }

  async setColorRules(_master: boolean, _ansiYield: boolean, _rules: unknown[]) {}

  async setPlotBuffer(_capacity: number) {
    // mock 数据生成与缓冲容量无关，忽略
  }

  async setPlotFormat(fmt: DataFormat) {
    this.channels = Math.max(1, fmt.channel_count);
    this.points = 0;
  }

  async getStats(): Promise<StatsSnapshot> {
    const now = performance.now();
    this.rxWindow = this.rxWindow.filter(([t]) => now - t < 2000);
    this.txWindow = this.txWindow.filter(([t]) => now - t < 2000);
    const sum = (w: Array<[number, number]>) => w.reduce((a, [, n]) => a + n, 0);
    const span = (w: Array<[number, number]>) => (w.length ? Math.max(now - w[0][0], 1) : 1);
    return {
      rx_bytes: this.rxTotal,
      tx_bytes: this.txTotal,
      rx_rate_kbs: sum(this.rxWindow) / span(this.rxWindow) / 1.024,
      tx_rate_kbs: sum(this.txWindow) / span(this.txWindow) / 1.024,
      crc_errors: this.errors,
      frame_errors: 0,
    };
  }

  async plotSnapshot(maxPoints: number): Promise<PlotSnapshotDto> {
    this.points = Math.min(this.points + 6, 10000);
    const n = Math.min(this.points, maxPoints);
    const series: number[][] = [];
    const metrics: (ChannelMetrics | null)[] = [];
    for (let ch = 0; ch < this.channels; ch++) {
      const arr: number[] = [];
      for (let i = 0; i < n; i++) {
        const t = (this.points - n + i) / 20;
        arr.push(
          Math.sin(t + ch * 1.3) * 50 +
            Math.sin(t * 3.7 + ch) * 12 +
            (Math.random() - 0.5) * 4,
        );
      }
      series.push(arr);
      metrics.push(arr.length ? metricsOf(arr) : null);
    }
    return { channel_count: this.channels, total_points: this.points, series, metrics };
  }

  // ── 内部：周期性产出日志行 + 原始字节 ──
  private pump() {
    // 终端原始流：一段带 ANSI 的伪 shell 输出
    const rawText = "\x1b[36m[maxcom-demo]\x1b[0m heartbeat ok \r\n";
    emitRaw(this.session, new TextEncoder().encode(rawText));

    // 日志行（应用过滤规则，语义与 FilterEngine 一致：首个生效规则决定）
    const pick = LINES[Math.floor(Math.random() * LINES.length)];
    const text = pick.segs.map((s) => s.text.replace(/\x1b\[[0-9;]*m/g, "")).join("");
    let show = true;
    for (const r of this.filters) {
      if (!r.enabled) continue;
      if (new RegExp(r.pattern).test(text)) {
        show = r.action === "show";
        break;
      }
    }
    if (show) {
      this.ts += 40 + Math.floor(Math.random() * 120);
      const rawBytes = new TextEncoder().encode(text);
      const rawHex = [...rawBytes].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
      const batch: EntriesBatch = {
        epoch_anchor_ms: this.startWall,
        items: [{ ts_ms: this.ts, text, segments: pick.segs, raw_hex: rawHex }],
      };
      emitEntries(this.session, batch);
    }

    // RX 统计随数据增长
    const n = rawText.length + text.length;
    if (this.capturing) this.captureBuf.push(...new TextEncoder().encode(rawText + text + "\n"));
    this.rxTotal += n;
    this.rxWindow.push([performance.now(), n]);
    if (Math.random() < 0.02) this.errors++; // 偶发 CRC 错误演示

    void this.connected;
  }

  private emitState() {
    emitState(this.session, {
      connected: this.connected,
      label: this.label,
      error: undefined,
    } as ConnState);
  }
}

function metricsOf(data: number[]): ChannelMetrics {
  const n = data.length || 1;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const mean = data.reduce((a, b) => a + b, 0) / n;
  const rms = Math.sqrt(data.reduce((a, b) => a + b * b, 0) / n);
  const variance = rms * rms - mean * mean;
  let std = 0;
  for (const v of data) std += (v - mean) ** 2;
  std = Math.sqrt(std / n);
  return {
    count: data.length,
    last: data.length ? data[data.length - 1] : 0,
    mean,
    std,
    variance: Math.max(0, variance),
    min,
    max,
    peak_to_peak: max - min,
    rms,
  };
}

function concat(a: Uint8Array, ...rest: number[]): Uint8Array {
  const out = new Uint8Array(a.length + rest.length);
  out.set(a);
  out.set(rest, a.length);
  return out;
}

// ── 多实例注册表 + 全局事件 hub（负载带 session 标签，形态与真实后端一致）──

const instances = new Map<string, MockBackend>();

export function getMock(session: string): MockBackend {
  let m = instances.get(session);
  if (!m) {
    m = new MockBackend(session);
    instances.set(session, m);
  }
  return m;
}

type RawEvt = { session: string; bytes: Uint8Array };
type EntriesEvt = { session: string; batch: EntriesBatch };
type StateEvt = { session: string; state: ConnState };

const rawHub = new Set<Listener<RawEvt>>();
const entriesHub = new Set<Listener<EntriesEvt>>();
const stateHub = new Set<Listener<StateEvt>>();

function emitRaw(session: string, bytes: Uint8Array) {
  rawHub.forEach((f) => f({ session, bytes }));
}
function emitEntries(session: string, batch: EntriesBatch) {
  entriesHub.forEach((f) => f({ session, batch }));
}
function emitState(session: string, state: ConnState) {
  stateHub.forEach((f) => f({ session, state }));
}

export function mockOnRaw(fn: Listener<RawEvt>) {
  rawHub.add(fn);
}
export function mockOnEntries(fn: Listener<EntriesEvt>) {
  entriesHub.add(fn);
}
export function mockOnState(fn: Listener<StateEvt>) {
  stateHub.add(fn);
}

// 旧的全局单例出口（部分工具脚本引用）；指向 "*" 会话
export const mock = getMock("*");
