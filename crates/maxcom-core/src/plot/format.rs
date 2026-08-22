//! 数据格式配置 DTO —— 契约 `plot-config.schema.json`（R6：字段以此为准）。
//!
//! `data_format` 的 oneOf 三形态用 serde 内部 tag 建模；字段名与 JSON 契约逐一对齐。

use serde::{Deserialize, Serialize};

/// 数据类型（契约枚举）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DType {
    #[serde(rename = "int8")]
    I8,
    #[serde(rename = "uint8")]
    U8,
    #[serde(rename = "int16")]
    I16,
    #[serde(rename = "uint16")]
    U16,
    #[serde(rename = "int32")]
    I32,
    #[serde(rename = "uint32")]
    U32,
    #[serde(rename = "int64")]
    I64,
    #[serde(rename = "uint64")]
    U64,
    #[serde(rename = "float32")]
    F32,
    #[serde(rename = "float64")]
    F64,
}

impl DType {
    pub fn size(&self) -> usize {
        match self {
            DType::I8 | DType::U8 => 1,
            DType::I16 | DType::U16 => 2,
            DType::I32 | DType::U32 | DType::F32 => 4,
            DType::I64 | DType::U64 | DType::F64 => 8,
        }
    }
}

/// 端序（契约枚举）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum ByteOrder {
    #[default]
    #[serde(rename = "little")]
    Little,
    #[serde(rename = "big")]
    Big,
}

/// 校验方式（自定义帧，M3 接入）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Checksum {
    #[default]
    #[serde(rename = "none")]
    None,
    #[serde(rename = "checksum")]
    Sum,
    #[serde(rename = "crc16")]
    Crc16,
}

/// ASCII 行内拆分用途
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum AsciiSplit {
    /// 分通道（默认）：一行内第 i 列 = 第 i 通道一个点
    #[default]
    #[serde(rename = "channel")]
    Channel,
    /// 分包：整行 = 单通道的完整样本序列（如 FFT for 循环打印数组），新行覆盖旧缓冲
    #[serde(rename = "package")]
    Package,
}

/// 数据格式（契约 oneOf 三形态，内部 tag = "type"）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DataFormat {
    /// Simple Binary：channel_count + dtype + byte_order，无帧头，定长帧
    SimpleBinary {
        channel_count: u32,
        dtype: DType,
        byte_order: ByteOrder,
    },
    /// ASCII 分隔：delimiter + filter_prefix（可选）+ 拆分模式 + channel_count
    AsciiDelimited {
        delimiter: String,
        #[serde(default)]
        filter_prefix: Option<String>,
        #[serde(default)]
        split: AsciiSplit,
        channel_count: u32,
    },
    /// 自定义帧：帧头/帧尾/帧长 + dtype + 端序 + 校验（M3 接入解析）
    CustomFrame {
        frame_header: String,
        #[serde(default)]
        frame_tail: Option<String>,
        #[serde(default)]
        frame_length: Option<u32>,
        dtype: DType,
        byte_order: ByteOrder,
        #[serde(default)]
        checksum: Checksum,
        channel_count: u32,
    },
}

impl DataFormat {
    pub fn channel_count(&self) -> u32 {
        match self {
            DataFormat::SimpleBinary { channel_count, .. }
            | DataFormat::AsciiDelimited { channel_count, .. }
            | DataFormat::CustomFrame { channel_count, .. } => *channel_count,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_contract_shapes() {
        // 契约 JSON 形态
        let sb: DataFormat = serde_json::from_str(
            r#"{"type":"simple_binary","channel_count":3,"dtype":"float32","byte_order":"little"}"#,
        )
        .unwrap();
        assert_eq!(sb.channel_count(), 3);
        let ad: DataFormat = serde_json::from_str(
            r#"{"type":"ascii_delimited","delimiter":",","filter_prefix":"DATA:","channel_count":2}"#,
        )
        .unwrap();
        assert_eq!(ad.channel_count(), 2);
        let cf: DataFormat = serde_json::from_str(
            r#"{"type":"custom_frame","frame_header":"AA55","dtype":"uint16","byte_order":"big","checksum":"crc16","channel_count":4}"#,
        )
        .unwrap();
        assert_eq!(cf.channel_count(), 4);
    }

    #[test]
    fn dtype_sizes() {
        assert_eq!(DType::U8.size(), 1);
        assert_eq!(DType::F32.size(), 4);
        assert_eq!(DType::F64.size(), 8);
    }
}
