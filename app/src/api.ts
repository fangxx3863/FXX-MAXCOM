// Tauri command/event 封装；浏览器演示模式下自动切换到 mock（src/mock.ts）。
// 命令名与 src-tauri 的 #[tauri::command] 一一对应。
// 多会话：每个标签页持有独立 SessionApi（命令携带 session 参数）；
// 事件全局订阅一次，负载带 session 标签，由 main.ts 路由到对应标签页。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ChipFamilyInfo, ConnConfig, ConnState, DataFormat, EntriesBatch, FlashConfig, FlashProgressDto,
  HidDeviceInfo, ModemProtocol, PlotSnapshotDto, PortInfo, ProbeInfo, SendPayload, StatsSnapshot,
  UsbDeviceInfo,
} from "./types";
import { getMock, mockOnRaw, mockOnEntries, mockOnState, DEMO_USB_DEVICES, DEMO_HID_DEVICES } from "./mock";
import { t } from "./i18n";

export const EV_RAW = "conn://raw";
export const EV_ENTRIES = "conn://entries";
export const EV_STATE = "conn://state";
export const EV_FLASH = "flash://progress";

/** 是否运行在 Tauri WebView 内（v2 注入 __TAURI_INTERNALS__） */
export const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 是否运行在手机/平板（Android/iOS）浏览器或 Tauri 移动端 WebView。
 *  桌面 UA 永不匹配，故仅移动端为 true —— 用于把手机专属布局门控在此处，
 *  避免误伤桌面端（桌面窗口即使缩窄也不触发）。 */
export const IS_MOBILE =
  typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

export interface LogOptionsDto {
  idle_timeout_ms: number;
  timestamp_mode: string;
  encoding: string;
  split_mode: string;
}

/** 单会话 API：每个标签页一个实例，全部命令自动携带 session 参数 */
export interface SessionApi {
  listPorts(): Promise<PortInfo[]>;
  connect(config: ConnConfig): Promise<void>;
  disconnect(): Promise<void>;
  /** 主动查询当前连接状态（连接/断开前同步，避免"仅允许单连接"误报） */
  connState(): Promise<ConnState>;
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
  /** 在**当前会话连接**上做 X/Y/ZMODEM 文件传输（烧录页 BL 交互，复用顶栏连接） */
  modemTransfer(protocol: ModemProtocol, path: string): Promise<void>;
  /** 强制停止当前会话的 modem 传输（对端无响应时不用干等超时） */
  cancelModemTransfer(): Promise<void>;
}

function realApi(session: string): SessionApi {
  return {
    listPorts: () => invoke<PortInfo[]>("list_ports"),
    connect: (config) => invoke<void>("connect", { session, config }),
    disconnect: () => invoke<void>("disconnect", { session }),
    connState: () => invoke<ConnState>("conn_state", { session }),
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
    modemTransfer: (protocol, path) => invoke<void>("modem_transfer", { session, protocol, path }),
    cancelModemTransfer: () => invoke<void>("cancel_modem_transfer", { session }),
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

/** 浏览器演示模式的芯片候选（Tauri 下由 probe-rs 提供全量列表） */
const DEMO_CHIP_FAMILIES: ChipFamilyInfo[] = [
  { family: "nRF52840", variants: ["nrf52832", "nrf52833", "nrf52840", "nrf5340"] },
  { family: "RP2040", variants: ["rp2040"] },
  { family: "ESP32", variants: ["esp32", "esp32c3", "esp32s3", "esp32c6"] },
  { family: "STM32F1", variants: ["stm32f103c8", "stm32f103cbt6", "stm32f103vet6"] },
  { family: "STM32F4", variants: ["stm32f407vet6", "stm32f411ceu6"] },
  { family: "CH32", variants: ["ch32v003", "ch32v103", "ch32v203", "ch32v307", "ch582"] },
  { family: "ATmega", variants: ["atmega328p"] },
  { family: "GD32", variants: ["gd32f103"] },
];

/** 列出 probe-rs 内置支持的目标芯片（家族 → 变体）。浏览器演示模式返回少量候选。 */
export async function listChips(): Promise<ChipFamilyInfo[]> {
  if (!IS_TAURI) return DEMO_CHIP_FAMILIES;
  return await invoke<ChipFamilyInfo[]>("list_chips");
}

/** 枚举 USB 设备（winusb 传输的设备下拉）。浏览器演示模式返回模拟设备。 */
export async function listUsbDevices(): Promise<UsbDeviceInfo[]> {
  if (!IS_TAURI) return DEMO_USB_DEVICES;
  return await invoke<UsbDeviceInfo[]>("list_usb_devices");
}

/** 枚举 HID 设备（hid 传输的设备下拉）。浏览器演示模式返回模拟设备。 */
export async function listHidDevices(): Promise<HidDeviceInfo[]> {
  if (!IS_TAURI) return DEMO_HID_DEVICES;
  return await invoke<HidDeviceInfo[]>("list_hid_devices");
}

/** 烧录固件（会话无关；浏览器演示模式返回模拟成功） */
export async function flashFirmware(config: FlashConfig): Promise<string> {
  if (!IS_TAURI) {
    await new Promise((r) => setTimeout(r, 400));
    if (!config.path.trim()) throw t("flash.noFile");
    return t("flash.demoDone", { chip: config.chip });
  }
  return await invoke<string>("flash_firmware", { config });
}

/** 选择固件文件：Tauri 走系统文件对话框；浏览器返回 null（由调用方用 file input 降级） */
export async function pickFirmwarePath(): Promise<string | null> {
  if (!IS_TAURI) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [
      { name: t("flash.filterFirmware"), extensions: ["elf", "hex", "ihx", "bin", "uf2", "out", "axf"] },
      { name: t("flash.filterAll"), extensions: ["*"] },
    ],
  });
  return typeof picked === "string" ? picked : null;
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

export interface FlashProgressEvt {
  progress: FlashProgressDto;
}

/** 烧录进度事件（全局，负载无 session 标签；各 FlashPage 监听，仅当前烧录中的页面响应） */
export function onFlashProgress(fn: (e: FlashProgressEvt) => void): void {
  if (!IS_TAURI) return; // 演示模式 mock 直接返回成功，无进度流
  void listen<FlashProgressEvt>(EV_FLASH, (e) => fn(e.payload));
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
