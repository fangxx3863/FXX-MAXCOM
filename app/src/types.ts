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
  | { type: "rtt"; probe_selector: string; chip: string; up_channel: number; down_channel: number; rtt_address?: number | null };

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

export interface ProbeInfo {
  selector: string;
  identifier: string;
  vendor_id: string;
  product_id: string;
  serial: string;
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
