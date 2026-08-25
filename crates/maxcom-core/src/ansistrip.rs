//! ANSI 序列检测与剥离（日志路径清理）。库优先：tokenize 用 `ansitok`。
//!
//! 日志引擎收到的行可能含 ANSI 控制序列（与终端模式共享同一原始流，ADR-0015）。
//! 终端渲染已委托 xterm.js（ADR-0018），这里只剩两件事：
//! - [`contains_ansi`]：自动染色的「ANSI 让位」判定（INV-1）
//! - [`strip_ansi`]：日志路径剥离控制码，避免 `[31m 泄露到无渲染的文本视图

use ansitok::{parse_ansi, ElementKind};

/// 行内是否含 ANSI 转义序列（用于染色让位检测）。
pub fn contains_ansi(text: &str) -> bool {
    parse_ansi(text).any(|e| e.kind() != ElementKind::Text)
}

/// 剥离全部 ANSI 转义序列，仅保留文本。
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for e in parse_ansi(text) {
        if e.kind() == ElementKind::Text {
            out.push_str(ansi_slice(text, e.start(), e.end()));
        }
    }
    out
}

/// 安全截取 ansitok 元素区间。ansitok 是字节级扫描器：多字节 UTF-8 字符的续字节若落在
/// C1 控制区（0x80-0x9F，如 `Ý` = 0xC3 0x9B 的 0x9B），会被误判为控制序列起点，
/// 产出非字符边界的 start/end，直接 `&text[start..end]` 会 panic。日志路径解码任意
/// 二进制（UTF-8/GBK），含这类字符的行必然出现。start 向下、end 向上收拢到最近字符
/// 边界，保留完整字符且绝不 panic。
pub(crate) fn ansi_slice(text: &str, start: usize, end: usize) -> &str {
    let start = text.floor_char_boundary(start.min(text.len()));
    let end = text.ceil_char_boundary(end.min(text.len()));
    &text[start..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_sequences() {
        assert!(contains_ansi("\x1b[31mred\x1b[0m"));
        assert!(contains_ansi("\x1b]0;title\x07x"));
        assert!(!contains_ansi("plain text [31m not ansi"));
        assert!(!contains_ansi(""));
    }

    #[test]
    fn strips_keeping_text() {
        assert_eq!(strip_ansi("\x1b[31;1mERROR\x1b[0m"), "ERROR");
        assert_eq!(strip_ansi("a\x1b]0;title\x07b"), "ab");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn dangling_esc_is_dropped_safely() {
        // 行尾裸 ESC：不 panic，ESC 被吞掉
        let s = strip_ansi("abc\u{1b}");
        assert!(s.starts_with("abc"));
    }

    #[test]
    fn multibyte_char_with_c1_continuation_byte_does_not_panic() {
        // 最小复现：ESC（vte→Escape）→ 双字节字符 ¹（0xC2 0xB9，续字节 0xB9 被
        // vte Escape 态的 anywhere() 静默吞掉）→ 双 ESC → ansitok 产出 Esc 元素
        // [1,2)，切进 ¹ 中间（字节 1..3）。旧代码 `&text[1..2]` 直接 panic。
        let s = "\u{1b}\u{B9}\u{1b}\u{1b}";
        let stripped = strip_ansi(s);
        assert!(stripped.is_empty(), "所有非文本元素应被剥离，得到空串");
        // 长串内混入同样模式也不 panic
        let long = format!("HEAD{}TAIL\u{DD}Z", "\u{1b}\u{B9}\u{1b}\u{1b}".repeat(50));
        strip_ansi(&long); // 仅断言不 panic
    }
}
