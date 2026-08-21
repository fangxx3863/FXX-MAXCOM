//! 编码检测与转换（V2 §1.10，移植自 `pipeline/encoding.py`）。
//!
//! UTF-8 / GBK / GB2312 / Latin-1 自动检测。`decode` 用替换式解码（非法字节 → U+FFFD），
//! 绝不失败——串口数据是脏的，显示层不能崩。检测是启发式，不保证 100%，
//! UI 需提供手动覆盖入口（编码下拉框）。

use encoding_rs::GBK;

pub const UTF8_BOM: &[u8] = b"\xef\xbb\xbf";

/// 所有合法编码名（对应 global-config default_encoding 枚举 + "auto"）
pub const SUPPORTED_ENCODINGS: [&str; 4] = ["utf-8", "gbk", "gb2312", "latin-1"];

/// 自动检测标记
pub const AUTO: &str = "auto";

/// 无状态编码检测器；每份数据独立检测，不做跨帧有状态解码。
#[derive(Debug, Default, Clone, Copy)]
pub struct EncodingDetector;

impl EncodingDetector {
    /// 返回 "utf-8" / "gbk" / "gb2312"(归一化为 gbk 处理) / "auto"（无法判定）。
    pub fn detect(&self, data: &[u8]) -> &str {
        if data.starts_with(UTF8_BOM) {
            return "utf-8";
        }
        if data.is_empty() {
            return AUTO;
        }
        if std::str::from_utf8(data).is_ok() {
            return "utf-8";
        }
        // GBK 特征：存在相邻两字节均落在 GBK 双字节首/次字节范围（0x81-0xFE）。
        if data
            .windows(2)
            .any(|w| (0x81..=0xFE).contains(&w[0]) && (0x81..=0xFE).contains(&w[1]))
        {
            return "gbk";
        }
        AUTO
    }

    /// 按指定编码解码；encoding 为 "auto" 时先自动检测。绝不失败。
    ///
    /// 无法判定时退化为 latin-1（对任意字节都可解码，保显示）——与 Python 版一致。
    pub fn decode(&self, data: &[u8], encoding: &str) -> String {
        let enc = if encoding == AUTO { self.detect(data) } else { encoding };
        match enc {
            "utf-8" => String::from_utf8_lossy(data).into_owned(),
            "gbk" | "gb2312" => decode_gbk(data),
            // latin-1：逐字节映射 U+00..U+FF（与 Python bytes.decode("latin-1") 等价；
            // 不用 encoding_rs 的 windows-1252，其 0x80-0x9F 段映射不同）
            _ => data.iter().map(|&b| b as char).collect(),
        }
    }
}

/// GBK 替换式解码：encoding_rs 默认把非法序列换成 U+FFFD，等价 Python errors="replace"。
fn decode_gbk(data: &[u8]) -> String {
    let mut decoder = GBK.new_decoder();
    let mut out = String::with_capacity(data.len() * 2);
    let (_res, _read) = decoder.decode_to_string(data, &mut out, true);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_utf8() {
        let d = EncodingDetector;
        assert_eq!(d.detect("hello 世界".as_bytes()), "utf-8");
        assert_eq!(d.detect(b"\xef\xbb\xbfok"), "utf-8"); // BOM
        assert_eq!(d.detect(b""), AUTO);
    }

    #[test]
    fn detects_gbk_by_pair_heuristic() {
        let d = EncodingDetector;
        // "中文" 的 GBK 编码：D6 D0 CE C4 —— 相邻双字节均落在 0x81-0xFE
        let gbk = [0xD6u8, 0xD0, 0xCE, 0xC4];
        assert_eq!(d.detect(&gbk), "gbk");
        // 非 UTF-8 也无 GBK 对：如 0xFF 单独出现
        assert_eq!(d.detect(&[0xFF]), AUTO);
    }

    #[test]
    fn decode_never_fails() {
        let d = EncodingDetector;
        // 非法 UTF-8 → U+FFFD 替换
        let s = d.decode(&[0xE4, 0xB8, 0xAD], "utf-8"); // 截断的三字节序列
        assert_eq!(s, "\u{FFFD}");
        // latin-1 逐字节
        assert_eq!(d.decode(&[0x41, 0xFF], "latin-1"), "A\u{FF}");
    }

    #[test]
    fn gbk_decode_roundtrip() {
        let d = EncodingDetector;
        // "中文" GBK 字节
        assert_eq!(d.decode(&[0xD6, 0xD0, 0xCE, 0xC4], "gbk"), "中文");
        // auto 路径同样能解出
        assert_eq!(d.decode(&[0xD6, 0xD0, 0xCE, 0xC4], AUTO), "中文");
    }
}
