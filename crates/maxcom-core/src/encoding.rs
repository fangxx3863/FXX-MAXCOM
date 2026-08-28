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
        match enc {
            "utf-8" => String::from_utf8_lossy(data).into_owned(),
            "gbk" | "gb2312" => decode_with(GBK, data),
            _ => data.iter().map(|&b| b as char).collect(), // latin-1 / auto 兜底
        }
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
