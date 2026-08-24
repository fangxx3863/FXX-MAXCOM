// 与 Rust 侧 DTO 逐字段对齐（serde 序列化形态），改 Rust 必须同步这里

export type Parity = "none" | "even" | "odd";
export type StopBits = "1" | "2";
export type FlowControl = "none" | "software" | "hardware";

export type ConnConfig =
  | { type: "serial"; port: string; baud: number; data_bits: number; parity: Parity; stop_bits: StopBits; flow_control: FlowControl }
  | { type: "tcp_client"; host: string; port: number }
  | { type: "udp_client"; host: string; port: number }
  | { type: "ssh"; host: string; port: number; username: string; password?: string }
  | { type: "telnet"; host: string; port: number }
  | { type: "rtt"; probe_selector: string; chip: string; up_channel: number; down_channel: number; rtt_address?: number | null }
  // WinUSB/libusb 类原始 USB：interface=null 自动挑接口；out_ep/in_ep 0=自动
  | { type: "winusb"; vid: number; pid: number; interface?: number | null; out_ep?: number; in_ep?: number }
  // HID：serial 非空按序列号精确匹配；strip_report_id 默认剥 Report ID
  | { type: "hid"; vid: number; pid: number; serial?: string | null; report_id?: number; strip_report_id?: boolean };

/** 枚举到的 USB 接口（winusb 设备下拉：选设备后选接口） */
export interface UsbInterfaceInfo {
  number: number;
  class: number;
  subclass: number;
  protocol: number;
}

/** 枚举到的 USB 设备（winusb 设备下拉） */
export interface UsbDeviceInfo {
  vid: number;
  pid: number;
  manufacturer: string;
  product: string;
  serial: string;
  interfaces: UsbInterfaceInfo[];
}

/** 枚举到的 HID 设备（hid 设备下拉） */
export interface HidDeviceInfo {
  vid: number;
  pid: number;
  manufacturer: string;
  product: string;
  serial: string;
  usage_page: number;
  usage: number;
  interface_number: number;
}

export interface FlashConfig {
  probe_selector: string;
  chip: string;
  path: string;
  /** "auto" 或 "elf" / "hex" / "bin" / "uf2" */
  format?: string;
  /** BIN 基址（仅 format=bin 时有效） */
  bin_base_address?: number | null;
  verify?: boolean;
  reset?: boolean;
}

/** 串口文件传输协议（烧录页 BL 交互，复用当前会话连接） */
export type ModemProtocol = "xmodem" | "ymodem" | "zmodem";

/** 烧录进度事件（后端 flashing::FlashProgressDto → flash://progress 事件负载） */
export interface FlashProgressDto {
  /** 事件类型：layout | add | started | progress | finished | failed | message */
  kind: string;
  /** 操作阶段：erase | fill | program | verify | ""（未知） */
  operation: string;
  /** progress 时已处理字节；finished 时为该阶段总字节 */
  size: number;
  /** 操作总量（未知为 0，前端据此显示不确定进度） */
  total: number;
  /** 附加消息（DiagnosticMessage / failed 详情） */
  message: string;
}

export interface ProbeInfo {
  selector: string;
  identifier: string;
  vendor_id: string;
  product_id: string;
  serial: string;
}

/** probe-rs 内置芯片家族（家族 → 目标芯片变体），对应 `list_chips` */
export interface ChipFamilyInfo {
  family: string;
  variants: string[];
}

export interface PortInfo {
  device: string;
  description: string;
}

export interface SendPayload {
  text?: string;
  hex?: string;
  newline: string;
}

export interface ColoredSegment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

export interface LogEntryDto {
  ts_ms: number;
  text: string;
  segments: ColoredSegment[];
  raw_hex: string;
  /** 未换行结束的部分行（line 分包空闲封行刷出）：应续接到当前行，而非断行 */
  partial?: boolean;
}

export interface EntriesBatch {
  epoch_anchor_ms: number; // absolute 模式：wall = anchor + ts_ms
  items: LogEntryDto[];
}

export interface ConnState {
  connected: boolean;
  label: string;
  error?: string;
}

export interface StatsSnapshot {
  rx_bytes: number;
  tx_bytes: number;
  rx_rate_kbs: number;
  tx_rate_kbs: number;
  crc_errors: number;
  frame_errors: number;
}

export type DType = "int8" | "uint8" | "int16" | "uint16" | "int32" | "uint32" | "int64" | "uint64" | "float32" | "float64";

export type DataFormat =
  | { type: "simple_binary"; channel_count: number; dtype: DType; byte_order: "little" | "big" }
  | {
      type: "ascii_delimited";
      delimiter: string;
      filter_prefix?: string;
      /** 行内拆分：channel=第i列→第i通道（默认）；package=整行→单通道样本序列，新行覆盖 */
      split?: "channel" | "package";
      channel_count: number;
    }
  | {
      type: "custom_frame";
      frame_header: string;
      /** 定长载荷字节数；null/省略 = 载荷首字节为长度 */
      frame_length?: number | null;
      dtype: DType;
      byte_order: "little" | "big";
      checksum?: "none" | "checksum" | "crc16";
      channel_count: number;
    };

export interface ChannelMetrics {
  count: number;
  /** 当前值（缓冲内最新样本） */
  last: number;
  mean: number;
  std: number;
  variance: number;
  min: number;
  max: number;
  peak_to_peak: number;
  rms: number;
}

export interface PlotSnapshotDto {
  channel_count: number;
  total_points: number;
  series: number[][];
  metrics: (ChannelMetrics | null)[];
  /** ASCII 表头智能识别的通道名（无表头为空，回退 CHn） */
  channel_names?: string[];
}
