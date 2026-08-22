// Tauri command/event 封装；浏览器演示模式下自动切换到 mock（src/mock.ts）。
// 命令名与 src-tauri 的 #[tauri::command] 一一对应。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ConnConfig, ConnState, DataFormat, EntriesBatch, PlotSnapshotDto,
  PortInfo, SendPayload, StatsSnapshot,
} from "./types";
import { mock } from "./mock";

export const EV_RAW = "conn://raw";
export const EV_ENTRIES = "conn://entries";
export const EV_STATE = "conn://state";

/** 是否运行在 Tauri WebView 内（v2 注入 __TAURI_INTERNALS__） */
const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const realApi = {
  listPorts: () => invoke<PortInfo[]>("list_ports"),
  connect: (config: ConnConfig) => invoke<void>("connect", { config }),
  disconnect: () => invoke<void>("disconnect"),
  send: (payload: SendPayload) => invoke<number>("send", { payload }),
  setLogOptions: (o: { idle_timeout_ms: number; timestamp_mode: string; encoding: string }) =>
    invoke<void>("set_log_options", { o }),
  setFilters: (rules: unknown[]) => invoke<void>("set_filters", { rules }),
  setColorRules: (master: boolean, ansi_yield: boolean, rules: unknown[]) =>
    invoke<void>("set_color_rules", { master, ansiYield: ansi_yield, rules }),
  clearLog: () => invoke<void>("clear_log"),
  getStats: () => invoke<StatsSnapshot>("get_stats"),
  setPlotFormat: (fmt: DataFormat) => invoke<void>("set_plot_format", { fmt }),
  setPlotBuffer: (capacity: number) => invoke<void>("set_plot_buffer", { capacity }),
  plotSnapshot: (maxPoints: number) => invoke<PlotSnapshotDto>("plot_snapshot", { maxPoints }),
  setDtr: (on: boolean) => invoke<void>("set_dtr", { on }),
  setRts: (on: boolean) => invoke<void>("set_rts", { on }),
  setAutoReconnect: (on: boolean) => invoke<void>("set_auto_reconnect", { on }),
  startCapture: () => invoke<void>("start_capture"),
  saveCapture: (path: string) => invoke<number>("save_capture", { path }),
  captureState: () => invoke<[boolean, number, number]>("capture_state"),
};

/** 取保存路径：Tauri 走 dialog 插件；浏览器返回 null（由调用方降级为下载） */
export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (!IS_TAURI) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return await save({ defaultPath: defaultName });
}

export const api = IS_TAURI ? realApi : mock;

export const on = IS_TAURI
  ? {
      raw: (fn: (data: Uint8Array) => void) =>
        listen<{ b64: string }>(EV_RAW, (e) => fn(b64ToBytes(e.payload.b64))),
      entries: (fn: (batch: EntriesBatch) => void) => listen<EntriesBatch>(EV_ENTRIES, (e) => fn(e.payload)),
      state: (fn: (s: ConnState) => void) => listen<ConnState>(EV_STATE, (e) => fn(e.payload)),
    }
  : {
      raw: (fn: (data: Uint8Array) => void) => Promise.resolve(mock.onRaw(fn)),
      entries: (fn: (batch: EntriesBatch) => void) => Promise.resolve(mock.onEntries(fn)),
      state: (fn: (s: ConnState) => void) => Promise.resolve(mock.onState(fn)),
    };

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
