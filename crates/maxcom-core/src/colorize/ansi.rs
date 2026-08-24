//! ANSI SGR 解析：把设备发送的颜色/加粗转义序列转成 ColoredSegment（COLOR-T08）。
//!
//! 终端模式由 xterm.js 解析（ADR-0018）；本模块专供「收发/日志」路径使用，让设备自带
//! 的颜色在文本视图里也保留下来（用户反馈：设备有 ANSI 控制字但收发页没染色）。
//! SGR 之外的序列（光标移动 CSI / 操作系统命令 OSC / 裸 ESC）不可渲染，直接丢弃；
//! 输出段拼接 === 原始文本剥离全部控制码后的内容（不泄露 `[31m`，不改日志原文）。

use crate::ansistrip::ansi_slice;
use crate::colorize::palette::BASIC_COLORS;
use ansitok::{parse_ansi, ElementKind};

use super::ColoredSegment;

/// 当前累积的 SGR 渲染样式。
#[derive(Debug, Clone, Default)]
struct SgrStyle {
    fg: Option<String>, // 命名色（"red" / "bright_cyan"）或 `#RRGGBB`
    bg: Option<String>,
    bold: bool,
}

impl SgrStyle {
    fn segment(&self, text: String) -> ColoredSegment {
        ColoredSegment {
            text,
            fg: self.fg.clone(),
            bg: self.bg.clone(),
            bold: if self.bold { Some(true) } else { None },
        }
    }
}

/// 解析一行含 ANSI 序列的文本为颜色段。
pub fn parse_ansi_segments(text: &str) -> Vec<ColoredSegment> {
    let mut out = Vec::new();
    let mut style = SgrStyle::default();
    let mut buf = String::new();
    for e in parse_ansi(text) {
        match e.kind() {
            ElementKind::Text => buf.push_str(ansi_slice(text, e.start(), e.end())),
            ElementKind::Sgr => {
                flush(&mut buf, &style, &mut out);
                apply_sgr(ansi_slice(text, e.start(), e.end()), &mut style);
            }
            // CSI / OSC / 裸 ESC：无可渲染样式，丢弃（不清文本段，避免无谓分段）
            _ => {}
        }
    }
    flush(&mut buf, &style, &mut out);
    if out.is_empty() {
        out.push(ColoredSegment::plain(""));
    }
    out
}

fn flush(buf: &mut String, style: &SgrStyle, out: &mut Vec<ColoredSegment>) {
    if buf.is_empty() {
        return;
    }
    out.push(style.segment(std::mem::take(buf)));
}

/// 标准色（30-37 / 40-47）：black red green yellow blue magenta cyan white
const NORM: [&str; 8] = [
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
];
/// 亮色（90-97 / 100-107）：gray(bright black) bright_red ... bright_white
const BRIGHT: [&str; 8] = [
    "gray",
    "bright_red",
    "bright_green",
    "bright_yellow",
    "bright_blue",
    "bright_magenta",
    "bright_cyan",
    "bright_white",
];

fn parse_u(s: &str) -> Option<u16> {
    s.parse().ok()
}

/// 应用一条 SGR 序列（形如 `\x1b[31;1m`）到当前样式。
fn apply_sgr(seq: &str, style: &mut SgrStyle) {
    let Some(inner) = seq.strip_prefix("\u{1b}[") else {
        return;
    };
    let inner = inner.strip_suffix('m').unwrap_or(inner);
    let parts: Vec<&str> = inner.split(';').collect();
    let mut idx = 0usize;
    while idx < parts.len() {
        let Some(code) = parse_u(parts[idx]) else {
            idx += 1;
            continue;
        };
        match code {
            0 => {
                style.fg = None;
                style.bg = None;
                style.bold = false;
            }
            1 | 21 => style.bold = true,
            22 => style.bold = false,
            39 => style.fg = None, // 默认前景
            49 => style.bg = None, // 默认背景
            30..=37 => style.fg = Some(NORM[(code as usize) - 30].to_string()),
            90..=97 => style.fg = Some(BRIGHT[(code as usize) - 90].to_string()),
            40..=47 => style.bg = Some(NORM[(code as usize) - 40].to_string()),
            100..=107 => style.bg = Some(BRIGHT[(code as usize) - 100].to_string()),
            38 | 48 => {
                let is_bg = code == 48;
                match parts.get(idx + 1).and_then(|s| parse_u(s)) {
                    // 256 色：38;5;n / 48;5;n
                    Some(5) => {
                        if let Some(n) = parts.get(idx + 2).and_then(|s| parse_u(s)) {
                            let hex = xterm_hex(n);
                            if is_bg {
                                style.bg = Some(hex);
                            } else {
                                style.fg = Some(hex);
                            }
                        }
                        idx += 2;
                    }
                    // 真彩：38;2;r;g;b / 48;2;r;g;b
                    Some(2) => {
                        let r = parts.get(idx + 2).and_then(|s| parse_u(s));
                        let g = parts.get(idx + 3).and_then(|s| parse_u(s));
                        let b = parts.get(idx + 4).and_then(|s| parse_u(s));
                        if let (Some(r), Some(g), Some(b)) = (r, g, b) {
                            let hex = format!("#{0:02X}{1:02X}{2:02X}", r as u8, g as u8, b as u8);
                            if is_bg {
                                style.bg = Some(hex);
                            } else {
                                style.fg = Some(hex);
                            }
                        }
                        idx += 4;
                    }
                    _ => {}
                }
            }
            // 其余（斜体/下划线/闪烁/reverse 等）无字段可表达，忽略
            _ => {}
        }
        idx += 1;
    }
}

/// xterm 256 色 → `#RRGGBB`。
fn xterm_hex(n: u16) -> String {
    let (r, g, b) = match n {
        0..=15 => BASIC_COLORS[n as usize],
        16..=231 => {
            let x = n - 16;
            let i = x / 36;
            let j = (x % 36) / 6;
            let k = x % 6;
            let v = |m: u16| -> u8 {
                if m == 0 {
                    0
                } else {
                    55 + 40 * m as u8
                }
            };
            (v(i), v(j), v(k))
        }
        232..=255 => {
            let v = (8 + (n - 232) * 10) as u8;
            (v, v, v)
        }
        _ => (0xCC, 0xCC, 0xCC),
    };
    format!("#{0:02X}{1:02X}{2:02X}", r, g, b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ansistrip::strip_ansi;

    #[test]
    fn parses_fg_and_bold() {
        let segs = parse_ansi_segments("\u{1b}[31;1mERROR\u{1b}[0m");
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, "ERROR");
        assert_eq!(segs[0].fg.as_deref(), Some("red"));
        assert_eq!(segs[0].bold, Some(true));
    }

    #[test]
    fn reset_returns_to_default() {
        let segs = parse_ansi_segments("\u{1b}[1mbold\u{1b}[0m plain");
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].text, "bold");
        assert_eq!(segs[0].bold, Some(true));
        assert_eq!(segs[1].text, " plain");
        assert_eq!(segs[1].fg, None);
        assert_eq!(segs[1].bold, None);
    }

    #[test]
    fn truecolor_and_256() {
        let segs = parse_ansi_segments("\u{1b}[38;2;255;0;0mRED\u{1b}[0m");
        assert_eq!(segs[0].fg.as_deref(), Some("#FF0000"));
        let segs = parse_ansi_segments("\u{1b}[48;5;200mBG\u{1b}[0m");
        assert!(segs[0].bg.as_deref().unwrap().starts_with('#'));
        let segs = parse_ansi_segments("\u{1b}[95mPINK\u{1b}[0m");
        assert_eq!(segs[0].fg.as_deref(), Some("bright_magenta"));
    }

    #[test]
    fn strips_non_sgr_and_concatenates_to_clean_text() {
        let input = "\u{1b}[2J\u{1b}[31mjump\u{1b}[0m line";
        let segs = parse_ansi_segments(input);
        let joined: String = segs.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(joined, strip_ansi(input)); // 段拼接 === 剥离全部控制码
        assert!(joined.contains("jump line"));
    }

    #[test]
    fn empty_and_plain() {
        let segs = parse_ansi_segments("");
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, "");
        // 纯文本：单段，无颜色
        let segs = parse_ansi_segments("plain text");
        assert_eq!(segs[0].text, "plain text");
        assert_eq!(segs[0].fg, None);
    }

    #[test]
    fn invariant_text_join_equals_stripped() {
        for input in [
            "\u{1b}[1;32mOK\u{1b}[0m",
            "\u{1b}[38;2;10;20;30mROI\u{1b}[0m: 42",
            "a\u{1b}[33mb\u{1b}[0m c",
            "\u{1b}]0;title\u{7}me\u{1b}[93mfine",
        ] {
            let segs = parse_ansi_segments(input);
            let joined: String = segs.iter().map(|s| s.text.as_str()).collect();
            assert_eq!(
                joined,
                strip_ansi(input),
                "ANSI 段拼接应等于剥离后的干净文本"
            );
        }
    }

    #[test]
    fn multibyte_char_with_c1_continuation_byte_does_not_panic() {
        // 最小复现：ESC → 双字节字符 ¹（0xC2 0xB9）→ 双 ESC。vte Escape 态把 ¹ 的
        // 字节经 anywhere() 静默吞掉，ansitok 产出 Esc 元素 [1,2) 切进 ¹ 中间。
        // 旧代码 `&text[e.start()..e.end()]` panic（日志线程崩溃，HEX 显示同样触发——
        // 引擎始终走 colorize）。ansi_slice 收拢边界后不 panic。
        let input = "\u{1b}\u{B9}\u{1b}\u{1b}";
        let segs = parse_ansi_segments(input);
        let joined: String = segs.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(joined, "");
        // 与真实 ANSI 序列混排的二进制文本也不 panic
        let mixed = format!(
            "\u{1b}[31m{}\u{1b}[0m",
            "\u{1b}\u{B9}\u{1b}\u{1b}".repeat(20)
        );
        parse_ansi_segments(&mixed); // 仅断言不 panic
    }
}
