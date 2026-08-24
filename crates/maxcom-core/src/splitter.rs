//! 分行 + LogEntry（LOG-T02，移植自 `logview/splitter.py`，ADR-0014）。
//!
//! 按 CRLF / LF / CR 拆行，跨片段拼行：splitter 持有未完成行（有状态）。
//! CRLF 视为单个换行符；单独 CR、LF 也是换行。空行保留。
//! `flush` 返回未尾随换行的残余行。
//!
//! 跨片段 CRLF 合并（LOG-T02）：真机串口/USB 读取边界任意切分，CR 与 LF
//! 常落入不同 feed → 旧行为把 CRLF 拆成「一行 + 空行」。这里记住上片以 CR
//! 终结（LineSplitter::feed 末尾检测）并吞并下一片开头的孤立 LF，避免产出空行。

use crate::colorize::ColoredSegment;

/// 一行日志：时间戳 + 文本 + 原始字节 + 颜色段（染色后填充）。
#[derive(Debug, Clone, PartialEq)]
pub struct LogEntry {
    pub timestamp_ms: u64,
    pub text: String,
    pub raw: Vec<u8>,
    pub segments: Option<Vec<ColoredSegment>>,
}

/// 字节流 → 行（bytes）。有状态：跨片段保留未完成行。
#[derive(Debug, Default)]
pub struct LineSplitter {
    pending: Vec<u8>,
    /// 上一片末尾是否为裸 CR（已终结行、其后无 LF）。为真时吞并下一片开头的孤立 LF，
    /// 把跨片段的 CRLF 合并为单一换行，避免拆出空行。
    last_cr: bool,
}

impl LineSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn pending_bytes(&self) -> usize {
        self.pending.len()
    }

    /// 追加数据，按换行拆行。行尾 CR 视为终结（CR 后跟 LF 合并，避免空行）。
    pub fn feed(&mut self, data: &[u8]) -> Vec<Vec<u8>> {
        self.pending.extend_from_slice(data);
        let mut lines = Vec::new();
        let buf = &self.pending;
        let mut start = 0usize;
        let mut i = 0usize;
        // 跨片段 CRLF 合并：上一片以裸 CR 终结、本片以孤立 LF 开头 → 吞掉 LF，不产空行
        if self.last_cr && !buf.is_empty() && buf[0] == 0x0A {
            start = 1;
            i = 1;
        }
        self.last_cr = false;
        while i < buf.len() {
            match buf[i] {
                0x0A => {
                    // LF：终结符
                    lines.push(buf[start..i].to_vec());
                    i += 1;
                    start = i;
                }
                0x0D => {
                    // CR：终结符（其后跟 LF 时吞掉，避免空行）
                    lines.push(buf[start..i].to_vec());
                    i += 1;
                    if i < buf.len() && buf[i] == 0x0A {
                        i += 1;
                    }
                    start = i;
                }
                _ => i += 1,
            }
        }
        // 记录本片是否以裸 CR 结尾（供下一片吞并孤立 LF）
        self.last_cr = buf.last() == Some(&0x0D);
        // 保留未完成行
        if start > 0 {
            self.pending.drain(..start);
        }
        lines
    }

    /// 取走未完成行（若有），用于空闲超时封行。
    pub fn flush_pending_line(&mut self) -> Vec<u8> {
        if self.pending.is_empty() {
            Vec::new()
        } else {
            std::mem::take(&mut self.pending)
        }
    }

    /// 返回未尾随换行的残余行，并清空缓冲。
    pub fn flush(&mut self) -> Vec<Vec<u8>> {
        if self.pending.is_empty() {
            return Vec::new();
        }
        vec![std::mem::take(&mut self.pending)]
    }

    pub fn clear(&mut self) {
        self.pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_lf_cr_crlf() {
        let mut sp = LineSplitter::new();
        // CRLF 视为单个换行；单独 CR、LF 也是换行
        let lines = sp.feed(b"a\r\nb\nc\rd");
        assert_eq!(lines, vec![b"a".to_vec(), b"b".to_vec(), b"c".to_vec()]);
        assert_eq!(sp.pending_bytes(), 1); // "d" 未完成
        assert_eq!(sp.flush(), vec![b"d".to_vec()]);
    }

    #[test]
    fn joins_lines_across_chunks() {
        let mut sp = LineSplitter::new();
        assert!(sp.feed(b"he").is_empty());
        assert!(sp.feed(b"ll").is_empty());
        let lines = sp.feed(b"o\nwor");
        assert_eq!(lines, vec![b"hello".to_vec()]);
        assert_eq!(sp.flush(), vec![b"wor".to_vec()]);
    }

    #[test]
    fn keeps_empty_lines() {
        let mut sp = LineSplitter::new();
        let lines = sp.feed(b"\n\n");
        assert_eq!(lines, vec![Vec::<u8>::new(), Vec::new()]);
    }

    #[test]
    fn crlf_across_chunk_boundary_merged() {
        // CR 与 LF 分处两个 feed：视为同一 CRLF，不产空行
        let mut sp = LineSplitter::new();
        let l1 = sp.feed(b"a\r");
        assert_eq!(l1, vec![b"a".to_vec()]);
        assert_eq!(sp.pending_bytes(), 0);
        let l2 = sp.feed(b"\nb");
        assert_eq!(l2, Vec::<Vec<u8>>::new());
        assert_eq!(sp.pending_bytes(), 1);
        assert_eq!(sp.flush(), vec![b"b".to_vec()]);
    }

    #[test]
    fn crlf_split_across_feeds_stays_one_line() {
        // 真实设备：CR 与 LF 分到两个 feed/分包 → 合并为单个 CRLF，不产空行
        let mut sp = LineSplitter::new();
        // 内容 + 裸 CR（尚未见 LF）
        assert_eq!(sp.feed(b"log here\r"), vec![b"log here".to_vec()]);
        assert_eq!(sp.pending_bytes(), 0);
        // 孤立 LF 开头：吞掉，不产空行，紧接着内容 "next" 成为残余
        assert_eq!(sp.feed(b"\nnext"), Vec::<Vec<u8>>::new());
        assert_eq!(sp.pending_bytes(), 4);
        assert_eq!(sp.flush(), vec![b"next".to_vec()]);
        // 继续：再来一个 CRLF（同 feed）正常结束
        let l = sp.feed(b"tail\r\n");
        assert_eq!(l, vec![b"tail".to_vec()]);
        assert_eq!(sp.flush(), Vec::<Vec<u8>>::new());
    }

    #[test]
    fn bare_cr_not_followed_by_lf_does_not_swallow_content() {
        // 上片以裸 CR 终结、下片以普通字符开头：不应吞字符，只吞孤立 LF
        let mut sp = LineSplitter::new();
        assert_eq!(sp.feed(b"a\r"), vec![b"a".to_vec()]);
        // 下片开头是 'x'（非 LF）→ 不合并，'x' 正常成为新行残余
        assert_eq!(sp.feed(b"xy"), Vec::<Vec<u8>>::new());
        assert_eq!(sp.flush(), vec![b"xy".to_vec()]);
    }
}
