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
            out.push_str(&text[e.start()..e.end()]);
        }
    }
    out
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
}
