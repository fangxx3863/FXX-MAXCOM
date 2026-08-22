//! 帧解析器（PLT-T02/T03/T05）：Simple Binary + ASCII 分隔。
//!
//! INV-2：数据错位跳过只推进解析器本地游标（`skip_one`），不写回原始流。
//! 解析为纯函数式推进（bytes → 采样帧），跨片段状态仅在缓冲区。

use super::format::{ByteOrder, DType, DataFormat};
use super::Frame;
use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum ParseError {
    #[error("unsupported data format: {0}")]
    Unsupported(&'static str),
    #[error("channel_count must be >= 1")]
    BadChannelCount,
}

/// 流式解析器：feed 原始字节，产出完整帧。
pub trait FrameParser: Send {
    fn feed(&mut self, data: &[u8], out: &mut dyn FnMut(Frame));
    /// 数据错位跳过：本地游标跳过 1 字节重新对齐（INV-2）。
    fn skip_one(&mut self);
    fn reset(&mut self);
    /// 累计解析错误（坏行/无法解析），供统计页展示
    fn error_count(&self) -> u64;
}

/// 按配置构造解析器。CustomFrame 校验解析在 M3 接入（契约字段已建模）。
pub fn make_parser(fmt: &DataFormat) -> Result<Box<dyn FrameParser>, ParseError> {
    match fmt {
        DataFormat::SimpleBinary {
            channel_count,
            dtype,
            byte_order,
        } => {
            if *channel_count == 0 {
                return Err(ParseError::BadChannelCount);
            }
            Ok(Box::new(SimpleBinaryParser {
                frame_size: *channel_count as usize * dtype.size(),
                dtype: *dtype,
                big_endian: *byte_order == ByteOrder::Big,
                buf: Vec::new(),
                errors: 0,
            }))
        }
        DataFormat::AsciiDelimited {
            delimiter,
            filter_prefix,
            channel_count,
        } => {
            // channel_count == 0 表示自动：首条有效行锁定列数；
            // 其后列数变更经去抖换锁（连续 ASCII_RELOCK_STREAK 条同宽行），固定列数模式则始终按坏行跳过
            if delimiter.is_empty() {
                return Err(ParseError::Unsupported("ascii_delimited: empty delimiter"));
            }
            Ok(Box::new(AsciiDelimitedParser {
                delimiter: delimiter.clone(),
                prefix: filter_prefix.clone(),
                channel_count: *channel_count as usize,
                auto: *channel_count == 0,
                relock_width: 0,
                relock_streak: 0,
                pending: String::new(),
                errors: 0,
            }))
        }
        DataFormat::CustomFrame { .. } => Err(ParseError::Unsupported("custom_frame (M3)")),
    }
}

/// Simple Binary：无帧头定长帧（channel_count × dtype.size），跨片段缓冲 + 本地游标。
pub struct SimpleBinaryParser {
    frame_size: usize,
    dtype: DType,
    big_endian: bool,
    buf: Vec<u8>,
    errors: u64,
}

impl SimpleBinaryParser {
    fn decode_frame(&self, bytes: &[u8]) -> Frame {
        let n = self.frame_size / self.dtype.size();
        let mut frame = Vec::with_capacity(n);
        for i in 0..n {
            let b = &bytes[i * self.dtype.size()..(i + 1) * self.dtype.size()];
            let v = read_scalar(b, self.dtype, self.big_endian);
            frame.push(v);
        }
        frame
    }
}

impl FrameParser for SimpleBinaryParser {
    fn feed(&mut self, data: &[u8], out: &mut dyn FnMut(Frame)) {
        self.buf.extend_from_slice(data);
        while self.buf.len() >= self.frame_size {
            let frame: Vec<u8> = self.buf.drain(..self.frame_size).collect();
            out(self.decode_frame(&frame));
        }
    }

    fn skip_one(&mut self) {
        if !self.buf.is_empty() {
            self.buf.remove(0);
        }
    }

    fn reset(&mut self) {
        self.buf.clear();
    }

    fn error_count(&self) -> u64 {
        self.errors
    }
}

fn read_scalar(bytes: &[u8], dtype: DType, big_endian: bool) -> f64 {
    let n = dtype.size();
    let mut t = [0u8; 8];
    if big_endian {
        // 高位对齐到尾部，保持字节序：t[8-n..] 即该宽度的完整值
        t[8 - n..].copy_from_slice(&bytes[..n]);
    } else {
        t[..n].copy_from_slice(bytes);
    }
    // 各宽度取值切片：大端取尾部 n 字节（MSB→LSB），小端取头部 n 字节（LSB→MSB）
    let (w16, w32): (&[u8], &[u8]) = if big_endian {
        (&t[6..8], &t[4..8])
    } else {
        (&t[0..2], &t[0..4])
    };
    match dtype {
        DType::I8 => i8::from_be_bytes([t[7]]) as f64,
        DType::U8 => t[7] as f64,
        DType::I16 if big_endian => i16::from_be_bytes(w16.try_into().unwrap()) as f64,
        DType::I16 => i16::from_le_bytes(w16.try_into().unwrap()) as f64,
        DType::U16 if big_endian => u16::from_be_bytes(w16.try_into().unwrap()) as f64,
        DType::U16 => u16::from_le_bytes(w16.try_into().unwrap()) as f64,
        DType::I32 if big_endian => i32::from_be_bytes(w32.try_into().unwrap()) as f64,
        DType::I32 => i32::from_le_bytes(w32.try_into().unwrap()) as f64,
        DType::U32 if big_endian => u32::from_be_bytes(w32.try_into().unwrap()) as f64,
        DType::U32 => u32::from_le_bytes(w32.try_into().unwrap()) as f64,
        DType::I64 if big_endian => i64::from_be_bytes(t) as f64,
        DType::I64 => i64::from_le_bytes(t) as f64,
        DType::U64 if big_endian => u64::from_be_bytes(t) as f64,
        DType::U64 => u64::from_le_bytes(t) as f64,
        DType::F32 if big_endian => f32::from_be_bytes(w32.try_into().unwrap()) as f64,
        DType::F32 => f32::from_le_bytes(w32.try_into().unwrap()) as f64,
        DType::F64 if big_endian => f64::from_be_bytes(t),
        DType::F64 => f64::from_le_bytes(t),
    }
}

/// ASCII 分隔：按行解析，行内按分隔符拆列；可选过滤前缀；坏行跳过计数。
pub struct AsciiDelimitedParser {
    delimiter: String,
    prefix: Option<String>,
    /// 当前锁定列数（自动模式下随数据变更经去抖换锁更新）
    channel_count: usize,
    /// 是否自动列数模式（构造时 channel_count == 0）
    auto: bool,
    /// 自动模式换锁去抖：候选列宽与已连续命中条数
    relock_width: usize,
    relock_streak: u32,
    pending: String,
    errors: u64,
}

/// 自动模式列数变更去抖阈值：连续 N 条同宽有效行才换锁
/// （单条/偶发噪声不清空缓冲；设备中途改输出协议几条内跟上）
const ASCII_RELOCK_STREAK: u32 = 5;

impl AsciiDelimitedParser {
    fn parse_line(&mut self, line: &str, out: &mut dyn FnMut(Frame)) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        if let Some(p) = &self.prefix {
            let Some(rest) = line.strip_prefix(p.as_str()) else {
                return;
            };
            let rest = rest.trim_start();
            self.emit(rest, out);
        } else {
            self.emit(line, out);
        }
    }

    fn emit(&mut self, body: &str, out: &mut dyn FnMut(Frame)) {
        let vals: Vec<f64> = body
            .split(self.delimiter.as_str())
            .filter_map(|s| s.trim().parse::<f64>().ok())
            .collect();
        if !self.auto {
            if vals.len() != self.channel_count {
                self.errors += 1; // 坏行：列数不齐（含混入文本），跳过
                return;
            }
            out(vals);
            return;
        }
        // 自动模式
        if vals.is_empty() {
            self.errors += 1;
            return;
        }
        let w = vals.len();
        if self.channel_count == 0 {
            // 首条有效行：立即锁定列数（避免上电初期的行被当噪声）
            self.channel_count = w;
            self.relock_width = 0;
            self.relock_streak = 0;
            out(vals);
            return;
        }
        if w == self.channel_count {
            self.relock_streak = 0; // 回到当前列数，去抖计数清零
            out(vals);
            return;
        }
        // 列数变化：连续 ASCII_RELOCK_STREAK 条同宽有效行才换锁，期间按坏行跳过
        if w == self.relock_width {
            self.relock_streak += 1;
        } else {
            self.relock_width = w;
            self.relock_streak = 1;
        }
        if self.relock_streak < ASCII_RELOCK_STREAK {
            self.errors += 1;
            return;
        }
        self.channel_count = w; // 换锁；本条即以新列宽出帧
        self.relock_width = 0;
        self.relock_streak = 0;
        out(vals);
    }
}

impl FrameParser for AsciiDelimitedParser {
    fn feed(&mut self, data: &[u8], out: &mut dyn FnMut(Frame)) {
        // 逐字节安全追加（串口可能切断多字节边界；ASCII 场景按 lossy 处理）
        self.pending.push_str(&String::from_utf8_lossy(data));
        while let Some(pos) = self.pending.find(['\n', '\r']) {
            let line: String = self.pending.drain(..=pos).collect();
            let line = line.trim_end_matches(['\n', '\r']);
            self.parse_line(line, out);
        }
    }

    fn skip_one(&mut self) {
        // ASCII 无对齐概念：丢弃缓冲首字符
        self.pending.remove(0);
    }

    fn reset(&mut self) {
        self.pending.clear();
        // 自动模式连锁定状态一起复位：reset 语义 = 回到首帧重新探测
        if self.auto {
            self.channel_count = 0;
            self.relock_width = 0;
            self.relock_streak = 0;
        }
    }

    fn error_count(&self) -> u64 {
        self.errors
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(p: &mut dyn FrameParser, data: &[u8]) -> Vec<Frame> {
        let mut frames = Vec::new();
        p.feed(data, &mut |f| frames.push(f));
        frames
    }

    fn sb_parser(ch: u32, dtype: DType, bo: ByteOrder) -> Box<dyn FrameParser> {
        make_parser(&DataFormat::SimpleBinary {
            channel_count: ch,
            dtype,
            byte_order: bo,
        })
        .unwrap()
    }

    #[test]
    fn simple_binary_le_float32() {
        let mut p = sb_parser(2, DType::F32, ByteOrder::Little);
        // 两帧数据一次喂入：帧1 = [1.0, -2.0]，帧2 = [3.5, 0.25]
        let mut bytes = Vec::new();
        for v in [1.0f32, -2.0, 3.5, 0.25] {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        let frames = collect(p.as_mut(), &bytes);
        assert_eq!(frames, vec![vec![1.0, -2.0], vec![3.5, 0.25]]);
    }

    #[test]
    fn simple_binary_big_endian_int16_split_across_chunks() {
        let mut p = sb_parser(2, DType::I16, ByteOrder::Big);
        let frames = collect(p.as_mut(), &[0x00, 0x01]); // 半帧
        assert!(frames.is_empty());
        let frames = collect(p.as_mut(), &[0x00, 0x02, 0xFF, 0xFE]); // 补齐 + 下一帧前半
        assert_eq!(frames, vec![vec![1.0, 2.0]]);
        let frames = collect(p.as_mut(), &[0x00, 0x03]); // -2 = 0xFFFE
        assert_eq!(frames, vec![vec![-2.0, 3.0]]);
    }

    #[test]
    fn skip_one_realigns_local_cursor() {
        // 1 通道 I16：帧长 2 字节。线上流：EE | 01 00 | 02 00，EE 为混入垃圾
        let mut p = sb_parser(1, DType::I16, ByteOrder::Little);
        // 错位：把 (EE 01) 当作一帧读出垃圾值 0x01EE
        let frames = collect(p.as_mut(), &[0xEE, 0x01, 0x00]);
        assert_eq!(frames, vec![vec![494.0]]);
        // 缓冲残留 1 字节（0x00）→ INV-2：本地游标跳过 1 字节重新对齐
        p.skip_one();
        let frames = collect(p.as_mut(), &[0x02, 0x00]);
        assert_eq!(frames, vec![vec![2.0]]);
    }

    #[test]
    fn ascii_delimited_with_prefix() {
        let mut p = make_parser(&DataFormat::AsciiDelimited {
            delimiter: ",".into(),
            filter_prefix: Some("DATA:".into()),
            channel_count: 2,
        })
        .unwrap();
        // 无前缀行被静默过滤（非错误）；有前缀但列数不齐才计错误
        let frames = collect(
            p.as_mut(),
            b"DATA: 1.5, 2.5\r\nnoise line here\nDATA: oops\nDATA: 3,4\n",
        );
        assert_eq!(frames, vec![vec![1.5, 2.5], vec![3.0, 4.0]]);
        assert_eq!(p.error_count(), 1);
    }

    #[test]
    fn ascii_split_across_chunks() {
        let mut p = make_parser(&DataFormat::AsciiDelimited {
            delimiter: " ".into(),
            filter_prefix: None,
            channel_count: 3,
        })
        .unwrap();
        assert!(collect(p.as_mut(), b"1 2 ").is_empty());
        let frames = collect(p.as_mut(), b"3\r");
        assert_eq!(frames, vec![vec![1.0, 2.0, 3.0]]);
    }

    #[test]
    fn ascii_auto_relocks_after_consecutive_new_width() {
        let mut p = make_parser(&DataFormat::AsciiDelimited {
            delimiter: ",".into(),
            filter_prefix: None,
            channel_count: 0,
        })
        .unwrap();
        // 首行锁定 2 列
        assert_eq!(
            collect(p.as_mut(), b"123,456\r\n"),
            vec![vec![123.0, 456.0]]
        );
        // 换 3 列：前 ASCII_RELOCK_STREAK-1 条按坏行丢弃
        let n = collect(p.as_mut(), b"1,2,3\n1,2,3\n1,2,3\n1,2,3\n").len();
        assert_eq!((n, p.error_count()), (0, 4));
        // 第 5 条同宽 → 换锁并以新列宽出帧；会话层据此重建 store（自动扩图）
        assert_eq!(collect(p.as_mut(), b"7,8,9\n"), vec![vec![7.0, 8.0, 9.0]]);
        // 换锁后旧宽度又成坏行
        assert!(collect(p.as_mut(), b"9,9\n").is_empty());
        assert_eq!(p.error_count(), 5);
    }

    #[test]
    fn ascii_auto_alternating_widths_never_relock() {
        let mut p = make_parser(&DataFormat::AsciiDelimited {
            delimiter: ",".into(),
            filter_prefix: None,
            channel_count: 0,
        })
        .unwrap();
        assert_eq!(collect(p.as_mut(), b"1,2\n"), vec![vec![1.0, 2.0]]);
        // 3/4 列交替抖动：宽度不连续命中，永不换锁，全部按坏行丢弃
        let frames = collect(p.as_mut(), b"1,2,3\n1,2,3,4\n1,2,3\n1,2,3,4\n1,2,3\n");
        assert!(frames.is_empty());
        assert_eq!(p.error_count(), 5);
        // 正常行继续出帧
        assert_eq!(collect(p.as_mut(), b"5,6\n"), vec![vec![5.0, 6.0]]);
    }

    #[test]
    fn ascii_auto_reset_restores_detection() {
        let mut p = make_parser(&DataFormat::AsciiDelimited {
            delimiter: ",".into(),
            filter_prefix: None,
            channel_count: 0,
        })
        .unwrap();
        assert_eq!(collect(p.as_mut(), b"1,2\n"), vec![vec![1.0, 2.0]]);
        p.reset();
        // reset 后回到未锁定状态，首行重新探测列数
        assert_eq!(collect(p.as_mut(), b"7,8,9\n"), vec![vec![7.0, 8.0, 9.0]]);
    }

    #[test]
    fn ascii_auto_locks_channel_count_on_first_line() {
        let mut p = make_parser(&DataFormat::AsciiDelimited {
            delimiter: ",".into(),
            filter_prefix: None,
            channel_count: 0, // 自动
        })
        .unwrap();
        let frames = collect(p.as_mut(), b"1,2,3\n");
        assert_eq!(frames, vec![vec![1.0, 2.0, 3.0]]);
        // 锁定为 3 列后，同宽行正常、异宽行计为坏行
        let frames = collect(p.as_mut(), b"4,5,6\n7,8\n8,9,10\n");
        assert_eq!(frames, vec![vec![4.0, 5.0, 6.0], vec![8.0, 9.0, 10.0]]);
        assert_eq!(p.error_count(), 1);
    }

    #[test]
    fn ascii_auto_with_prefix_and_crlf() {
        let mut p = make_parser(&DataFormat::AsciiDelimited {
            delimiter: " ".into(),
            filter_prefix: Some("DATA:".into()),
            channel_count: 0,
        })
        .unwrap();
        let frames = collect(p.as_mut(), b"DATA: 1.5 2.5\r\nnoise line\nDATA: 3 4\r\n");
        // "noise line" 无前缀 → 静默过滤；锁定 2 列后正常出帧
        assert_eq!(frames, vec![vec![1.5, 2.5], vec![3.0, 4.0]]);
        assert_eq!(p.error_count(), 0);
    }

    #[test]
    fn rejects_bad_configs() {
        assert!(matches!(
            make_parser(&DataFormat::SimpleBinary {
                channel_count: 0,
                dtype: DType::U8,
                byte_order: ByteOrder::Little
            }),
            Err(ParseError::BadChannelCount)
        ));
        assert!(matches!(
            make_parser(&DataFormat::CustomFrame {
                frame_header: "AA55".into(),
                frame_tail: None,
                frame_length: None,
                dtype: DType::U16,
                byte_order: ByteOrder::Big,
                checksum: Default::default(),
                channel_count: 1,
            }),
            Err(ParseError::Unsupported(_))
        ));
    }
}
