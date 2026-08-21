// Tauri command/event 封装。命令名与 src-tauri 的 #[tauri::command] 一一对应。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ConnConfig, ConnState, DataFormat, EntriesBatch, PlotSnapshotDto,
  PortInfo, SendPayload, StatsSnapshot,
} from "./types";

export const EV_RAW = "conn://raw";
export const EV_ENTRIES = "conn://entries";
export const EV_STATE = "conn://state";

export const api = {
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
  plotSnapshot: (maxPoints: number) => invoke<PlotSnapshotDto>("plot_snapshot", { maxPoints }),
};

export const on = {
  raw: (fn: (data: Uint8Array) => void) =>
    listen<{ b64: string }>(EV_RAW, (e) => fn(b64ToBytes(e.payload.b64))),
  entries: (fn: (batch: EntriesBatch) => void) => listen<EntriesBatch>(EV_ENTRIES, (e) => fn(e.payload)),
  state: (fn: (s: ConnState) => void) => listen<ConnState>(EV_STATE, (e) => fn(e.payload)),
};

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64 编码（发送 HEX 时前端先转字节再交由后端 hex 解码；文本直接走后端） */
export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
