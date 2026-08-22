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
    Unsupported(String),
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
    /// ASCII 表头智能识别出的通道名（无则空）
    fn channel_names(&self) -> Vec<String> {
        Vec::new()
    }
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
            split,
            channel_count,
        } => {
            // channel_count == 0 表示自动：首条有效行锁定列数；
            // 其后列数变更经去抖换锁（连续 ASCII_RELOCK_STREAK 条同宽行），固定列数模式则始终按坏行跳过
            if delimiter.is_empty() {
                return Err(ParseError::Unsupported(
                    "ascii_delimited: empty delimiter".into(),
                ));
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
                split: *split,
                names: Vec::new(),
                names_locked: false,
            }))
        }
        DataFormat::CustomFrame {
            frame_header,
            frame_tail: _, // 帧尾暂不参与解析（SerialPlot 风格仅帧头+长度+校验）
            frame_length,
            dtype,
            byte_order,
            checksum,
            channel_count,
        } => {
            if *channel_count == 0 {
                return Err(ParseError::BadChannelCount);
            }
            let header = parse_hex(frame_header).map_err(ParseError::Unsupported)?;
            if header.is_empty() {
                return Err(ParseError::Unsupported(
                    "custom_frame: empty frame_header".into(),
                ));
            }
            if let Some(n) = frame_length {
                if *n == 0 {
                    return Err(ParseError::Unsupported(
                        "custom_frame: zero frame_length".into(),
                    ));
                }
            }
            if matches!(checksum, crate::plot::format::Checksum::Crc16) {
                return Err(ParseError::Unsupported("custom_frame: crc16 (M3+)".into()));
            }
            Ok(Box::new(CustomFrameParser {
                header,
                fixed_payload: frame_length.map(|n| n as usize),
                dtype: *dtype,
                big_endian: *byte_order == ByteOrder::Big,
                checksum_enabled: matches!(checksum, crate::plot::format::Checksum::Sum),
                channel_count: *channel_count as usize,
                buf: Vec::new(),
                errors: 0,
            }))
        }
    }
}

/// 解析十六进制帧头字符串（容忍空格，如 "AA BB" / "AABB"）
fn parse_hex(s: &str) -> Result<Vec<u8>, String> {
    let hex: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    if !hex.len().is_multiple_of(2) {
        return Err(format!("custom_frame: odd-length hex header: {s:?}"));
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&hex[i..i + 2], 16)
                .map_err(|e| format!("custom_frame: bad hex header: {e}"))
        })
        .collect()
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
    match dtype {
        DType::I8 => bytes[0] as i8 as f64,
        DType::U8 => bytes[0] as f64,
        DType::I16 if big_endian => i16::from_be_bytes([bytes[0], bytes[1]]) as f64,
        DType::I16 => i16::from_le_bytes([bytes[0], bytes[1]]) as f64,
        DType::U16 if big_endian => u16::from_be_bytes([bytes[0], bytes[1]]) as f64,
        DType::U16 => u16::from_le_bytes([bytes[0], bytes[1]]) as f64,
        DType::I32 if big_endian => i32::from_be_bytes(bytes[..4].try_into().unwrap()) as f64,
        DType::I32 => i32::from_le_bytes(bytes[..4].try_into().unwrap()) as f64,
        DType::U32 if big_endian => u32::from_be_bytes(bytes[..4].try_into().unwrap()) as f64,
        DType::U32 => u32::from_le_bytes(bytes[..4].try_into().unwrap()) as f64,
        DType::I64 if big_endian => i64::from_be_bytes(bytes.try_into().unwrap()) as f64,
        DType::I64 => i64::from_le_bytes(bytes.try_into().unwrap()) as f64,
        DType::U64 if big_endian => u64::from_be_bytes(bytes.try_into().unwrap()) as f64,
        DType::U64 => u64::from_le_bytes(bytes.try_into().unwrap()) as f64,
        DType::F32 if big_endian => f32::from_be_bytes(bytes[..4].try_into().unwrap()) as f64,
        DType::F32 => f32::from_le_bytes(bytes[..4].try_into().unwrap()) as f64,
        DType::F64 if big_endian => f64::from_be_bytes(bytes.try_into().unwrap()),
        DType::F64 => f64::from_le_bytes(bytes.try_into().unwrap()),
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
    /// 行内拆分用途（分通道 / 分包）
    split: crate::plot::format::AsciiSplit,
    /// 表头智能识别的通道名（首条含字母的非数字行，剔除数字/标点）
    names: Vec<String>,
    names_locked: bool,
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
        let segs: Vec<&str> = body.split(self.delimiter.as_str()).collect();
        // 纯表头行识别：自动模式、尚未出数据、未锁定；所有段均无数字且含字母
        // （"vol,tmp" → 名字 [vol,tmp]；带数字的行不走这里，走下方标签值提取）
        if self.auto && self.channel_count == 0 && !self.names_locked {
            let has_letter = segs.iter().any(|sg| sg.chars().any(|c| c.is_alphabetic()));
            let no_number = segs.iter().all(|sg| extract_number(sg).is_none());
            let header_shape =
                matches!(self.split, crate::plot::format::AsciiSplit::Channel) || segs.len() == 1;
            if header_shape && has_letter && no_number {
                self.names = segs.iter().map(|sg| clean_name(sg)).collect();
                self.names_locked = true;
                return; // 表头行不出帧、不计错误
            }
        }
        // 数值提取：分通道模式容忍"标签+数值"混写（vol: 123 → 123，字母部分作通道名）；
        // 分包模式严格要求数字（整行是样本数组）
        let (vals, seg_names): (Vec<f64>, Vec<String>) =
            if matches!(self.split, crate::plot::format::AsciiSplit::Channel) {
                let mut vals: Vec<f64> = Vec::new();
                let mut names: Vec<String> = Vec::new();
                for sg in &segs {
                    let t = sg.trim();
                    if t.is_empty() {
                        continue; // 行尾多余分隔符等空段
                    }
                    match extract_number(t) {
                        Some(v) => {
                            vals.push(v);
                            names.push(clean_name(sg));
                        }
                        None => {
                            self.errors += 1; // 有内容但无数值 → 坏行
                            return;
                        }
                    }
                }
                (vals, names)
            } else {
                (
                    segs.iter()
                        .filter_map(|sg| sg.trim().parse::<f64>().ok())
                        .collect(),
                    Vec::new(),
                )
            };
        if vals.is_empty() {
            self.errors += 1;
            return;
        }
        // 名字学习：先按本次列数对齐长度（无标签列留空占位，前端回退 CHn），
        // 再把带字母标签的列写入对应下标
        if seg_names.len() > self.names.len() {
            self.names.resize(seg_names.len(), String::new());
        }
        for (i, n) in seg_names.iter().enumerate() {
            if n.is_empty() {
                continue;
            }
            self.names[i] = n.clone();
        }
        if !self.auto {
            if vals.len() != self.channel_count {
                self.errors += 1; // 坏行：列数不齐，跳过
                return;
            }
            out(vals);
            return;
        }
        // 自动模式
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
    fn channel_names(&self) -> Vec<String> {
        self.names.clone()
    }

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

/// 自定义帧（对齐 SerialPlot FramedDecoder 语义）：
/// `[帧头][载荷][校验?]`；载荷 = 行数×通道数 个样本交织；
/// 帧长两种模式：定长字节 / 载荷首字节为长度；校验 = 载荷逐字节累加和（低 8 位）。
/// 失步/坏帧按 INV-2 从缓冲首字节跳过重同步。
pub struct CustomFrameParser {
    header: Vec<u8>,
    /// Some(n)=定长载荷 n 字节；None=载荷首字节为长度
    fixed_payload: Option<usize>,
    dtype: DType,
    big_endian: bool,
    checksum_enabled: bool,
    channel_count: usize,
    buf: Vec<u8>,
    errors: u64,
}

impl CustomFrameParser {
    fn sample_size(&self) -> usize {
        self.dtype.size()
    }

    fn checksum_len(&self) -> usize {
        if self.checksum_enabled {
            1
        } else {
            0
        }
    }

    /// 尝试从缓冲提取帧（一帧载荷可含多行样本）。空 Vec=数据不足等待；
    /// Err(())=坏帧已计错误并消费若干字节，外层循环继续。
    fn try_extract(&mut self) -> Result<Vec<Frame>, ()> {
        // 1. 定位帧头：非零前缀直接丢弃；无完整帧头时保留可能是半截头的尾部
        let pos = find(&self.buf, &self.header);
        match pos {
            Some(0) => {}
            Some(p) => {
                self.buf.drain(..p);
            }
            None => {
                let keep = self.header.len().saturating_sub(1);
                if self.buf.len() > keep {
                    self.buf.drain(..self.buf.len() - keep);
                }
                return Ok(Vec::new());
            }
        }
        // 2. 载荷长度与载荷起点（首字节模式：长度字节本身不计入载荷）
        let body_start = self.header.len();
        let unit = self.channel_count * self.sample_size();
        let (payload_start, payload_len) = match self.fixed_payload {
            Some(n) => (body_start, n),
            None => {
                if self.buf.len() <= body_start {
                    return Ok(Vec::new()); // 长度字节未到
                }
                let n = self.buf[body_start] as usize;
                if n == 0 || !n.is_multiple_of(unit) {
                    self.errors += 1;
                    self.buf.drain(..body_start); // 连同帧头丢弃，重新同步
                    return Err(());
                }
                (body_start + 1, n)
            }
        };
        if payload_len % unit != 0 {
            self.errors += 1;
            self.buf.drain(..body_start);
            return Err(());
        }
        // 3. 凑齐整帧（含可选校验字节）
        let total = payload_start + payload_len + self.checksum_len();
        if self.buf.len() < total {
            return Ok(Vec::new());
        }
        let payload = self.buf[payload_start..payload_start + payload_len].to_vec();
        if self.checksum_enabled {
            let calc = payload.iter().fold(0u8, |a, b| a.wrapping_add(*b));
            if calc != self.buf[payload_start + payload_len] {
                self.errors += 1;
                self.buf.drain(..1); // 仅跳 1 字节：帧头可能出现在数据中，保守重找
                return Err(());
            }
        }
        self.buf.drain(..total);
        // 4. 解码交织样本 → 每行一个 Frame（通道数宽）
        let sz = self.sample_size();
        let rows = payload_len / (self.channel_count * sz);
        let mut frames = Vec::with_capacity(rows);
        for r in 0..rows {
            let mut frame = Vec::with_capacity(self.channel_count);
            for c in 0..self.channel_count {
                let off = (r * self.channel_count + c) * sz;
                frame.push(read_scalar(
                    &payload[off..off + sz],
                    self.dtype,
                    self.big_endian,
                ));
            }
            frames.push(frame);
        }
        Ok(frames)
    }
}

/// 从段中提取首个数值（容忍标签/单位混写）："vol: 123"→123、"tmp456"→456、
/// "bar-123"→-123、"2.4A"→2.4、"1e-3"→0.001、".5"→0.5；无数字返回 None
fn extract_number(seg: &str) -> Option<f64> {
    let chars: Vec<char> = seg.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let mut j = i;
        if chars[j] == '+' || chars[j] == '-' {
            j += 1;
        }
        let mantissa = j;
        while j < chars.len() && chars[j].is_ascii_digit() {
            j += 1;
        }
        if j < chars.len() && chars[j] == '.' {
            j += 1;
            while j < chars.len() && chars[j].is_ascii_digit() {
                j += 1;
            }
        }
        if j == mantissa {
            i += 1; // 当前字符不是数字起点
            continue;
        }
        // 指数部分（e/E ± 数字齐全才纳入）
        if j < chars.len() && (chars[j] == 'e' || chars[j] == 'E') {
            let mut k = j + 1;
            if k < chars.len() && (chars[k] == '+' || chars[k] == '-') {
                k += 1;
            }
            let exp_digits = k;
            while k < chars.len() && chars[k].is_ascii_digit() {
                k += 1;
            }
            if k > exp_digits {
                j = k;
            }
        }
        let text: String = chars[i..j].iter().collect();
        return text.parse::<f64>().ok();
    }
    None
}

/// 表头名清洗：只保留字母/空格/下划线，压缩空白（剔除数字与标点）
fn clean_name(s: &str) -> String {
    let filtered: String = s
        .chars()
        .filter(|c| c.is_alphabetic() || c.is_whitespace() || *c == '_')
        .collect();
    filtered.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 在 hay 中查找 needle 首次出现位置
fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

impl FrameParser for CustomFrameParser {
    fn feed(&mut self, data: &[u8], out: &mut dyn FnMut(Frame)) {
        self.buf.extend_from_slice(data);
        loop {
            match self.try_extract() {
                Ok(frames) if frames.is_empty() => break, // 数据不足，等待更多字节
                Ok(frames) => {
                    for f in frames {
                        out(f);
                    }
                }
                Err(()) => continue, // 坏帧已消费，继续找下一帧
            }
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
            split: Default::default(),
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
            split: Default::default(),
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
            split: Default::default(),
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
            split: Default::default(),
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
    fn ascii_header_line_extracts_names() {
        let mut p = make_parser(&DataFormat::AsciiDelimited {
            delimiter: ",".into(),
            filter_prefix: None,
            split: Default::default(),
            channel_count: 0,
        })
        .unwrap();
        // 带标签的行：数值提取为数据帧，字母部分成为通道名
        let frames = collect(p.as_mut(), b"Voltage 123V, Amp 2.4A\n");
        assert_eq!(frames, vec![vec![123.0, 2.4]]);
        assert_eq!(p.error_count(), 0);
        assert_eq!(
            p.channel_names(),
            vec!["Voltage V".to_string(), "Amp A".to_string()]
        );
        // 后续纯数字行正常出帧（列数已锁定）
        let frames = collect(p.as_mut(), b"12.5, 3.3\n");
        assert_eq!(frames, vec![vec![12.5, 3.3]]);
    }

    #[test]
    fn ascii_header_baseline_raw() {
        let mut p = make_parser(&DataFormat::AsciiDelimited {
            delimiter: ",".into(),
            filter_prefix: None,
            split: Default::default(),
            channel_count: 0,
        })
        .unwrap();
        let frames = collect(p.as_mut(), b"baseline: 1234, raw: 4567\n");
        assert_eq!(frames, vec![vec![1234.0, 4567.0]]);
        assert_eq!(
            p.channel_names(),
            vec!["baseline".to_string(), "raw".to_string()]
        );
    }

    #[test]
    fn ascii_pure_header_line_then_data() {
        let mut p = make_parser(&DataFormat::AsciiDelimited {
            delimiter: ",".into(),
            filter_prefix: None,
            split: Default::default(),
            channel_count: 0,
        })
        .unwrap();
        // 纯表头（整行无任何数字）：只记名字不出帧、不计错误
        assert!(collect(p.as_mut(), b"vol,tmp\n").is_empty());
        assert_eq!(p.error_count(), 0);
        assert_eq!(
            p.channel_names(),
            vec!["vol".to_string(), "tmp".to_string()]
        );
        assert_eq!(collect(p.as_mut(), b"1,2\n"), vec![vec![1.0, 2.0]]);
    }

    #[test]
    fn ascii_mixed_labels_signs_and_bare_numbers() {
        let mut p = make_parser(&DataFormat::AsciiDelimited {
            delimiter: ",".into(),
            filter_prefix: None,
            split: Default::default(),
            channel_count: 0,
        })
        .unwrap();
        // 混合边界：冒号标签 / 紧贴标签 / 空格标签 / 负号归属 / 无标签裸数 / CRLF
        let frames = collect(p.as_mut(), b"vol: 123, tmp456, foo 789, bar-123, 567\r\n");
        assert_eq!(frames, vec![vec![123.0, 456.0, 789.0, -123.0, 567.0]]);
        assert_eq!(
            p.channel_names(),
            vec![
                "vol".to_string(),
                "tmp".to_string(),
                "foo".to_string(),
                "bar".to_string(),
                String::new(), // 无标签列 → 前端回退 CH5
            ]
        );
        assert_eq!(p.error_count(), 0);
    }

    #[test]
    fn ascii_number_extraction_edges_and_bad_lines() {
        let mut p = make_parser(&DataFormat::AsciiDelimited {
            delimiter: ",".into(),
            filter_prefix: None,
            split: Default::default(),
            channel_count: 0,
        })
        .unwrap();
        // 数值扫描边界：指数、前导点、显式正负号；"0x1F" 只取到十进制前缀 0（不支持十六进制）
        let frames = collect(p.as_mut(), b"a 1e-3, b +.5, c -2., d 0x1F\n");
        assert_eq!(frames, vec![vec![0.001, 0.5, -2.0, 0.0]]);
        // 有内容但无数值的段 → 坏行计错误
        assert!(collect(p.as_mut(), b"1,abc\n").is_empty());
        assert_eq!(p.error_count(), 1);
        // 行尾多余分隔符：空段跳过不出错（新实例：上方 parser 的 auto 已锁 4 通道）
        let mut p2 = make_parser(&DataFormat::AsciiDelimited {
            delimiter: ",".into(),
            filter_prefix: None,
            split: Default::default(),
            channel_count: 0,
        })
        .unwrap();
        let frames = collect(p2.as_mut(), b"7,8,\n");
        assert_eq!(frames, vec![vec![7.0, 8.0]]);
        assert_eq!(p2.error_count(), 0);
    }

    #[test]
    fn ascii_auto_reset_restores_detection() {
        let mut p = make_parser(&DataFormat::AsciiDelimited {
            delimiter: ",".into(),
            filter_prefix: None,
            split: Default::default(),
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
            split: Default::default(),
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
            split: Default::default(),
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
        assert!(make_parser(&DataFormat::CustomFrame {
            frame_header: "AA55".into(),
            frame_tail: None,
            frame_length: None,
            dtype: DType::U16,
            byte_order: ByteOrder::Big,
            checksum: Default::default(),
            channel_count: 1,
        })
        .is_ok());
        // 空白帧头 → 非法
        assert!(matches!(
            make_parser(&DataFormat::CustomFrame {
                frame_header: "  ".into(),
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

    #[test]
    fn custom_frame_fixed_u8_resync_and_split() {
        let mut p = make_parser(&DataFormat::CustomFrame {
            frame_header: "AA BB".into(),
            frame_tail: None,
            frame_length: Some(1),
            dtype: DType::U8,
            byte_order: ByteOrder::Little,
            checksum: crate::plot::format::Checksum::None,
            channel_count: 1,
        })
        .unwrap();
        // 帧头前噪声 + 两帧完整 + 半截帧头（跨片段）
        let frames = collect(
            p.as_mut(),
            &[0x00, 0xAA, 0xBB, 0x2A, 0xAA, 0xBB, 0xFF, 0xAA],
        );
        assert_eq!(frames, vec![vec![42.0], vec![255.0]]);
        let mut got = Vec::new();
        p.feed(&[0xBB, 0x07], &mut |f| got.push(f));
        assert_eq!(got, vec![vec![7.0]], "半截帧头应在下一片段补齐后出帧");
    }

    #[test]
    fn custom_frame_first_byte_len_two_channels_checksum() {
        let mut p = make_parser(&DataFormat::CustomFrame {
            frame_header: "AABB".into(),
            frame_tail: None,
            frame_length: None, // 载荷首字节 = 长度
            dtype: DType::U16,
            byte_order: ByteOrder::Little,
            checksum: crate::plot::format::Checksum::Sum,
            channel_count: 2,
        })
        .unwrap();
        // len=4；v0=LE(01 00)=1，v1=LE(02 00)=2；sum=01+00+02+00=3
        let frames = collect(
            p.as_mut(),
            &[0xAA, 0xBB, 0x04, 0x01, 0x00, 0x02, 0x00, 0x03],
        );
        assert_eq!(frames, vec![vec![1.0, 2.0]]);
        // 校验错坏帧跳过重同步；随后好帧照常
        let bad_then_good: [u8; 16] = [
            0xAA, 0xBB, 0x04, 0x01, 0x00, 0x02, 0x00, 0xFF, //
            0xAA, 0xBB, 0x04, 0x03, 0x00, 0x04, 0x00, 0x07,
        ];
        let frames = collect(p.as_mut(), &bad_then_good);
        assert_eq!(p.error_count(), 1);
        assert_eq!(frames, vec![vec![3.0, 4.0]]);
    }
}
