//! 编码检测与转换（V2 §1.10）。库优先：检测用 `chardetng`（Firefox 同款），
//! 解码用 `encoding_rs`（替换式，非法字节 → U+FFFD，绝不失败）。
//! Latin-1 手工逐字节映射（encoding_rs 的 windows-1252 在 0x80-0x9F 段与 ISO-8859-1 不同）。

use encoding_rs::{Encoding, GBK};

pub const UTF8_BOM: &[u8] = b"\xef\xbb\xbf";

/// 所有合法编码名（对应 global-config default_encoding 枚举 + "auto"）
pub const SUPPORTED_ENCODINGS: [&str; 4] = ["utf-8", "gbk", "gb2312", "latin-1"];

/// 自动检测标记
pub const AUTO: &str = "auto";

/// 编码检测器。`detect` 无状态可复用；整体语义对齐 Python 版：
/// BOM → utf-8；合法 UTF-8 → utf-8；否则 chardetng 猜 GBK 家族 → gbk；
/// 判不了 → "auto"（调用方 decode 时退化为 latin-1 保显示）。
#[derive(Debug, Default, Clone, Copy)]
pub struct EncodingDetector;

impl EncodingDetector {
    pub fn detect(&self, data: &[u8]) -> &'static str {
        if data.starts_with(UTF8_BOM) {
            return "utf-8";
        }
        if data.is_empty() {
            return AUTO;
        }
        if std::str::from_utf8(data).is_ok() {
            return "utf-8";
        }
        let mut det = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
        det.feed(data, true);
        let enc = det.guess(None, chardetng::Utf8Detection::Deny);
        if std::ptr::eq(enc, GBK) {
            "gbk"
        } else {
            AUTO
        }
    }

    /// 按指定编码解码；"auto" 先检测，仍判不出按 latin-1。绝不失败。
    pub fn decode(&self, data: &[u8], encoding: &str) -> String {
        let enc = if encoding == AUTO {
            self.detect(data)
        } else {
            encoding
        };
        decode_as(data, enc)
    }
}

/// 按已定编码名解码（enc 为 "utf-8"/"gbk"/"gb2312"，其余按 latin-1 逐字节兜底）。绝不失败。
fn decode_as(data: &[u8], enc: &str) -> String {
    match enc {
        "utf-8" => String::from_utf8_lossy(data).into_owned(),
        "gbk" | "gb2312" => decode_with(GBK, data),
        _ => data.iter().map(|&b| b as char).collect(), // latin-1 / auto 兜底
    }
}

/// 滑动窗口自动编码检测（有状态，按方括号内思路实现）。
///
/// 背景：`EncodingDetector::detect` 对**单条**短行不可靠——`chardetng` 样本太少会把
/// GBK 字节流猜成 EUC-KR（实测 `画面切换` 仅 8 字节被判为 EUC-KR），落到 auto→latin-1 → 乱码。
/// 而把**一段会话历史字节**整体喂给 `chardetng` 后，它对几大语系（GBK/EUC-KR/Big5/Shift_JIS/EUC-JP）
/// 的区分是可靠的——不假设"中文"，喂够数据即可判对。
///
/// 策略（保守、不逐行乱跳）：
/// - 只把「非 UTF-8 字节」压入滑动窗口（环形缓冲，字节上限 `cap`），避免 ASCII 稀释多语种信号；
/// - 每行用**窗口整体**判定一次，得到确定的 gbk 家族就记为 `held`；
/// - `held` 一旦确定就对后续行持续生效，直到窗口证据改用其它编码；
/// - 未判定的行沿用上一个 `held`（默认 latin-1 兜底保显示），绝不因为单行样本差异来回切换。
///
/// 仅 `encoding == "auto"` 时走窗口；显式编码（gbk/gb2312/utf-8/latin-1）完全绕过，行为不变。
#[derive(Debug, Clone)]
pub struct EncodingHistory {
    window: std::collections::VecDeque<u8>,
    cap: usize,
    held: &'static str,
}

impl Default for EncodingHistory {
    fn default() -> Self {
        Self::new(DEFAULT_HISTORY_CAP)
    }
}

/// 默认滑动窗口字节上限（约合数十行中文日志的字节量，既够 `chardetng` 判据、又不无限膨胀）。
pub const DEFAULT_HISTORY_CAP: usize = 4 * 1024;

impl EncodingHistory {
    pub fn new(cap: usize) -> Self {
        Self {
            window: std::collections::VecDeque::with_capacity(cap.min(64)),
            cap: cap.max(64),
            held: AUTO,
        }
    }

    /// 重置窗口与已定编码（清空日志时调用）。
    pub fn reset(&mut self) {
        self.window.clear();
        self.held = AUTO;
    }

    /// 把一行原始字节压入窗口，并用新窗口重新判定编码。
    /// 整行「合法 UTF-8」（含纯 ASCII）直接用 UTF-8，不进窗口（避免 ASCII 稀释多语种信号）；
    /// 其余（含 GBK/EUC-KR 等非 UTF-8 字节）整段压栈，交由窗口截断。
    pub fn push(&mut self, data: &[u8]) {
        if std::str::from_utf8(data).is_ok() {
            return;
        }
        self.window.extend(data);
        // 环形截断到 cap
        while self.window.len() > self.cap {
            self.window.pop_front();
        }
        self.refresh_held();
    }

    /// 用窗口整体判定一次，若得到确定的编码则更新 `held`（仅 gbk 家族；其余维持现状）。
    fn refresh_held(&mut self) {
        if self.window.is_empty() {
            return;
        }
        // VecDeque 是分段的环形缓冲，把两段分别 feed，语义等同喂整段（last=true 表示结束）。
        let (a, b) = self.window.as_slices();
        let mut det = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
        det.feed(a, b.is_empty());
        if !b.is_empty() {
            det.feed(b, true);
        }
        let enc = det.guess(None, chardetng::Utf8Detection::Deny);
        // 只采纳能确定解码的 GBK 家族；EUC-KR/Big5/Shift_JIS 等我们不假设语系，维持现状。
        if std::ptr::eq(enc, GBK) {
            self.held = "gbk";
        }
    }

    /// 当前已定编码（未定时为 AUTO）。
    pub fn held_encoding(&self) -> &'static str {
        self.held
    }

    /// 解码一行。`encoding == "auto"` 时先压窗、按窗口判定编码；否则按显式编码直接解码。
    /// 合法 UTF-8 / 带 BOM 的行走快速路径（直接用 UTF-8 解，不进窗口）。
    pub fn decode_line(&mut self, data: &[u8], encoding: &str) -> String {
        if encoding != AUTO {
            return decode_as(data, encoding);
        }
        // 快速路径：合法 UTF-8（含纯 ASCII）或 BOM 直接用 UTF-8，避免把纯文本误判进窗口。
        if data.starts_with(UTF8_BOM) || std::str::from_utf8(data).is_ok() {
            return String::from_utf8_lossy(data).into_owned();
        }
        // 非 UTF-8：压窗判定后按 held 解码（held 未定时为 AUTO → latin-1 兜底）
        self.push(data);
        decode_as(data, self.held)
    }
}

/// 替换式解码（非法序列 → U+FFFD），等价 Python errors="replace"。
fn decode_with(enc: &'static Encoding, data: &[u8]) -> String {
    let mut decoder = enc.new_decoder();
    let mut out = String::with_capacity(
        (decoder.max_utf8_buffer_length(data.len())).unwrap_or(data.len() * 2),
    );
    let (_res, _read, _had_errors) = decoder.decode_to_string(data, &mut out, true);
    out
}

/// 按指定编码把字符串编码为字节。返回值：(字节, 是否含无法编码的字符)。
/// `enc` 必须在 SUPPORTED_ENCODINGS 内（不含 auto，auto 无编码方向语义）。
/// - utf-8：原生 UTF-8 字节；
/// - gbk / gb2312：encoding_rs GBK 编码器（替换式，无法编码字符 → U+FFFD，不失败）；
/// - latin-1：逐字符取低 8 位，超出 0xFF 的字符按 \\u{FFFD} 替换。
pub fn encode(text: &str, enc: &str) -> (Vec<u8>, bool) {
    match enc {
        "utf-8" => (text.as_bytes().to_vec(), false),
        "gbk" | "gb2312" => encode_with(GBK, text),
        _ => {
            // latin-1：每字符一个字节；> 0xFF 无法编码 → 替换，标记 had_errors
            let mut out = Vec::with_capacity(text.len());
            let mut had_errors = false;
            for ch in text.chars() {
                if (ch as u32) <= 0xFF {
                    out.push(ch as u8);
                } else {
                    out.push(0xFF); // U+FFFD 的 latin-1 表示（逐字节映射惯例）
                    had_errors = true;
                }
            }
            (out, had_errors)
        }
    }
}

/// 用 encoding_rs 编码器编码（替换式：无法编码字符 → U+FFFD 字节，绝不失败）。
fn encode_with(enc: &'static Encoding, text: &str) -> (Vec<u8>, bool) {
    let (bytes, _, had_errors) = enc.encode(text);
    (bytes.into_owned(), had_errors)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_utf8() {
        let d = EncodingDetector;
        assert_eq!(d.detect("hello 世界".as_bytes()), "utf-8");
        assert_eq!(d.detect(b"\xef\xbb\xbfok"), "utf-8");
        assert_eq!(d.detect(b""), AUTO);
    }

    #[test]
    fn detects_gbk() {
        let d = EncodingDetector;
        // "中文测试数据" 的 GBK 字节流（足够长让 chardetng 有把握）
        let gbk_bytes = [0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4];
        assert_eq!(d.decode(&gbk_bytes, AUTO), "中文测试");
    }

    #[test]
    fn decode_never_fails() {
        let d = EncodingDetector;
        // 截断的多字节序列 → U+FFFD
        assert_eq!(d.decode(&[0xE4, 0xB8], "utf-8"), "\u{FFFD}");
        // latin-1 逐字节映射
        assert_eq!(d.decode(&[0x41, 0xFF], "latin-1"), "A\u{FF}");
    }

    // ── EncodingHistory：滑动窗口自动检测 ──
    // 复现缺陷：单条短 GBK 行被判成 EUC-KR → 乱码；窗口累计后应锁定 GBK 并正确解码。
    #[test]
    fn history_window_locks_gbk_after_variety() {
        let mut h = EncodingHistory::new(1024);
        // 真实设备 GBK 日志（含 ASCII 尾巴），模拟逐行进入
        let lines = [
            "画面切换 Screen_ID = 1, Control_Address = 0",
            "画面切换 Screen_ID = 2, Control_Address = 0",
            "CRC校验 成功",
            "系统启动 正常",
            "画面切换 Screen_ID = 2, Control_Address = 0",
        ];
        for l in &lines {
            let (b, _) = encode(l, "gbk");
            let dec = h.decode_line(&b, AUTO);
            // 窗口尚未锁定前（前几条）可能还是 latin-1，但锁定后必须还原中文
            if h.held_encoding() == "gbk" {
                assert_eq!(dec, *l, "held=gbk 时应正确解码该行");
            }
        }
        assert_eq!(h.held_encoding(), "gbk");
    }

    #[test]
    fn history_short_single_line_is_conservative() {
        // 只有一条短 GBK 行时 chardetng 判 EUC-KR（非 gbk 家族）→ held 维持 AUTO，
        // decode_line 走 latin-1 兜底（不假定中文、不报错）。
        let mut h = EncodingHistory::new(1024);
        let (b, _) = encode("画面切换", "gbk");
        assert_eq!(b.len(), 8);
        assert_eq!(h.held_encoding(), AUTO);
        let dec = h.decode_line(&b, AUTO);
        // 兜底不应包含原中文字符（说明没误判成 gbk）
        assert!(!dec.contains('画'));
        assert_eq!(h.held_encoding(), AUTO);
    }

    #[test]
    fn history_utf8_fastpath_untouched() {
        let mut h = EncodingHistory::new(1024);
        // 纯 UTF-8 / ASCII 行走快速路径，不进窗口、直接 UTF-8
        assert_eq!(h.decode_line("hello 世界".as_bytes(), AUTO), "hello 世界");
        assert_eq!(h.decode_line(b"GATEWAY STAT On", AUTO), "GATEWAY STAT On");
        assert_eq!(h.decode_line(b"\xef\xbb\xbfok", AUTO), "\u{feff}ok");
        assert_eq!(h.held_encoding(), AUTO);
    }

    #[test]
    fn history_explicit_encoding_bypasses_window() {
        let mut h = EncodingHistory::new(1024);
        let (b, _) = encode("中文", "gbk");
        // 显式 gbk：即使窗口没数据也精确解码
        assert_eq!(h.decode_line(&b, "gbk"), "中文");
        assert_eq!(h.held_encoding(), AUTO); // 窗口未被污染
    }

    #[test]
    fn history_reset_clears() {
        let mut h = EncodingHistory::new(1024);
        let (b, _) = encode("中文测试数据", "gbk");
        h.decode_line(&b, AUTO);
        assert_eq!(h.held_encoding(), "gbk");
        h.reset();
        assert_eq!(h.held_encoding(), AUTO);
    }

    #[test]
    fn explicit_gbk_decode() {
        let d = EncodingDetector;
        assert_eq!(d.decode(&[0xD6, 0xD0, 0xCE, 0xC4], "gbk"), "中文");
        assert_eq!(d.decode(&[0xD6, 0xD0, 0xCE, 0xC4], "gb2312"), "中文");
    }

    #[test]
    fn encode_utf8_roundtrip() {
        let (bytes, had_err) = encode("hello 世界", "utf-8");
        assert_eq!(bytes, "hello 世界".as_bytes());
        assert!(!had_err);
    }

    #[test]
    fn encode_gbk_chinese() {
        // "中文" 的 GBK 编码 = 0xD6 0xD0 0xCE 0xC4
        let (bytes, had_err) = encode("中文", "gbk");
        assert_eq!(bytes, vec![0xD6, 0xD0, 0xCE, 0xC4]);
        assert!(!had_err);
        // gb2312 对齐 GBK（GB2312 是 GBK 子集）
        let (bytes2, _) = encode("中文", "gb2312");
        assert_eq!(bytes2, vec![0xD6, 0xD0, 0xCE, 0xC4]);
    }

    #[test]
    fn encode_gbk_decode_roundtrip() {
        let d = EncodingDetector;
        let (bytes, _) = encode("中文测试数据", "gbk");
        assert_eq!(d.decode(&bytes, "gbk"), "中文测试数据");
    }

    #[test]
    fn encode_latin1_basic() {
        let (bytes, had_err) = encode("A\u{FF}B", "latin-1");
        assert_eq!(bytes, vec![0x41, 0xFF, 0x42]);
        assert!(!had_err);
        // > 0xFF 字符 → 替换为 0xFF 并标记
        let (bytes2, had_err2) = encode("中", "latin-1");
        assert_eq!(bytes2, vec![0xFF]);
        assert!(had_err2);
    }
}
