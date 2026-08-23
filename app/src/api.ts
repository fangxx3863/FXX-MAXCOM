// Tauri command/event 封装；浏览器演示模式下自动切换到 mock（src/mock.ts）。
// 命令名与 src-tauri 的 #[tauri::command] 一一对应。
// 多会话：每个标签页持有独立 SessionApi（命令携带 session 参数）；
// 事件全局订阅一次，负载带 session 标签，由 main.ts 路由到对应标签页。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ConnConfig, ConnState, DataFormat, EntriesBatch, PlotSnapshotDto,
  PortInfo, ProbeInfo, SendPayload, StatsSnapshot,
} from "./types";
import { getMock, mockOnRaw, mockOnEntries, mockOnState } from "./mock";

export const EV_RAW = "conn://raw";
export const EV_ENTRIES = "conn://entries";
export const EV_STATE = "conn://state";

/** 是否运行在 Tauri WebView 内（v2 注入 __TAURI_INTERNALS__） */
export const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface LogOptionsDto {
  idle_timeout_ms: number;
  timestamp_mode: string;
  encoding: string;
}

/** 单会话 API：每个标签页一个实例，全部命令自动携带 session 参数 */
export interface SessionApi {
  listPorts(): Promise<PortInfo[]>;
  connect(config: ConnConfig): Promise<void>;
  disconnect(): Promise<void>;
  send(payload: SendPayload): Promise<number>;
  setLogOptions(o: LogOptionsDto): Promise<void>;
  setFilters(rules: unknown[]): Promise<void>;
  setColorRules(master: boolean, ansi_yield: boolean, rules: unknown[]): Promise<void>;
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

function realApi(session: string): SessionApi {
  return {
    listPorts: () => invoke<PortInfo[]>("list_ports"),
    connect: (config) => invoke<void>("connect", { session, config }),
    disconnect: () => invoke<void>("disconnect", { session }),
    send: (payload) => invoke<number>("send", { session, payload }),
    setLogOptions: (o) => invoke<void>("set_log_options", { session, o }),
    setFilters: (rules) => invoke<void>("set_filters", { session, rules }),
    setColorRules: (master, ansi_yield, rules) =>
      invoke<void>("set_color_rules", { session, master, ansiYield: ansi_yield, rules }),
    clearLog: () => invoke<void>("clear_log", { session }),
    getStats: () => invoke<StatsSnapshot>("get_stats", { session }),
    setPlotFormat: (fmt) => invoke<void>("set_plot_format", { session, fmt }),
    setPlotBuffer: (capacity) => invoke<void>("set_plot_buffer", { session, capacity }),
    plotSnapshot: (maxPoints) => invoke<PlotSnapshotDto>("plot_snapshot", { session, maxPoints }),
    setDtr: (on) => invoke<void>("set_dtr", { session, on }),
    setRts: (on) => invoke<void>("set_rts", { session, on }),
    setAutoReconnect: (on) => invoke<void>("set_auto_reconnect", { session, on }),
    startCapture: () => invoke<void>("start_capture", { session }),
    saveCapture: (path) => invoke<number>("save_capture", { session, path }),
    captureState: () => invoke<[boolean, number, number]>("capture_state", { session }),
  };
}

/** 每个标签页一个 API 实例（演示模式下按 session 隔离 mock 后端） */
export function makeApi(session: string): SessionApi {
  return IS_TAURI ? realApi(session) : getMock(session);
}

/** 标签页关闭时销毁后端会话（断开连接、回收线程）；演示模式为 no-op */
export function closeSession(session: string): void {
  if (!IS_TAURI) return;
  void invoke("close_session", { session }).catch(() => {});
}

/** 取保存路径：Tauri 走 dialog 插件；浏览器返回 null（由调用方降级为下载） */
export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (!IS_TAURI) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return await save({ defaultPath: defaultName });
}

/** 会话无关：保存任意文本文件（CSV 导出等），返回写入字节数 */
export async function saveTextFile(path: string, contents: string): Promise<number> {
  if (!IS_TAURI) return contents.length;
  return await invoke<number>("save_text_file", { path, contents });
}

/** 枚举当前可用的调试探针（RTT）。无探针/浏览器模式 → 空数组 */
export async function listProbes(): Promise<ProbeInfo[]> {
  if (!IS_TAURI) return [];
  return await invoke<ProbeInfo[]>("list_probes");
}

// ── 全局事件（负载带 session 标签；每类事件只订阅一次，main.ts 按标签路由）──

export interface RawEvt {
  session: string;
  bytes: Uint8Array;
}
export interface EntriesEvt {
  session: string;
  batch: EntriesBatch;
}
export interface StateEvt {
  session: string;
  state: ConnState;
}

export function onRaw(fn: (e: RawEvt) => void): void {
  if (!IS_TAURI) {
    mockOnRaw(fn);
    return;
  }
  void listen<{ session: string; b64: string }>(EV_RAW, (e) =>
    fn({ session: e.payload.session, bytes: b64ToBytes(e.payload.b64) }),
  );
}

export function onEntries(fn: (e: EntriesEvt) => void): void {
  if (!IS_TAURI) {
    mockOnEntries(fn);
    return;
  }
  void listen<{ session: string; epoch_anchor_ms: number; items: EntriesBatch["items"] }>(
    EV_ENTRIES,
    (e) =>
      fn({
        session: e.payload.session,
        batch: { epoch_anchor_ms: e.payload.epoch_anchor_ms, items: e.payload.items },
      }),
  );
}

export function onState(fn: (e: StateEvt) => void): void {
  if (!IS_TAURI) {
    mockOnState(fn);
    return;
  }
  void listen<StateEvt>(EV_STATE, (e) => fn(e.payload));
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
