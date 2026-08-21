//! 分行 + LogEntry（LOG-T02，移植自 `logview/splitter.py`，ADR-0014）。
//!
//! 按 CRLF / LF / CR 拆行，跨片段拼行：splitter 持有未完成行（有状态）。
//! CRLF 视为单个换行符；单独 CR、LF 也是换行。空行保留。
//! `flush` 返回未尾随换行的残余行。

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
}

impl LineSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn pending_bytes(&self) -> usize {
        self.pending.len()
    }

    /// 追加数据，按换行拆行。行尾 \r 视为终结（\r 后跟 \n 合并，避免空行）。
    pub fn feed(&mut self, data: &[u8]) -> Vec<Vec<u8>> {
        self.pending.extend_from_slice(data);
        let mut lines = Vec::new();
        let buf = &self.pending;
        let mut start = 0usize;
        let mut i = 0usize;
        while i < buf.len() {
            match buf[i] {
                0x0A => {
                    // \n：终结符
                    lines.push(buf[start..i].to_vec());
                    i += 1;
                    start = i;
                }
                0x0D => {
                    // \r：终结符（其后跟 \n 时吞掉，避免空行）
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
        // 保留未完成行
        if start > 0 {
            self.pending.drain(..start);
        }
        lines
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
    fn crlf_across_chunk_boundary() {
        let mut sp = LineSplitter::new();
        let l1 = sp.feed(b"a\r");
        assert_eq!(l1, vec![b"a".to_vec()]);
        assert_eq!(sp.pending_bytes(), 0);
        // 语义对齐 Python 版：CRLF 的吞并只在同一片段内生效；
        // \r 已终结行后，下一片段开头的孤立 \n 视为新行终结 → 产出空行（保留空行语义）
        let l2 = sp.feed(b"\nb");
        assert_eq!(l2, vec![Vec::<u8>::new()]);
        assert_eq!(sp.pending_bytes(), 1);
    }
}
