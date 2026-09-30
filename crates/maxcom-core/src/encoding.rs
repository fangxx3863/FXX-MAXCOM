//! 编码检测与转换（V2 §1.10）。库优先：检测用 `chardetng`（Firefox 同款），
//! 解码用 `encoding_rs`（替换式，非法字节 → U+FFFD，绝不失败）。
//! Latin-1 手工逐字节映射（encoding_rs 的 windows-1252 在 0x80-0x9F 段与 ISO-8859-1 不同）。

use encoding_rs::{Decoder, Encoding, GBK, UTF_8};

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

/// UTF-8：末尾截断序列的字节数（0..=3）。完整序列或非法首字节返回 0。
fn utf8_incomplete_tail(data: &[u8]) -> usize {
    let max = data.len().min(4);
    for back in 1..=max {
        let b = data[data.len() - back];
        if b & 0xC0 == 0x80 {
            continue; // 续字节：继续往前找首字节
        }
        let need = match b {
            0xC2..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF4 => 4,
            _ => return 0, // ASCII 或非法首字节
        };
        return if back < need { back } else { 0 };
    }
    0
}

/// GBK/GB2312：末尾孤立的双字节首字节（无尾字节配对）返回 1，否则 0。
/// 从头按「首字节 + 尾字节」成对扫描，避免奇偶误判。
fn gbk_incomplete_tail(data: &[u8]) -> usize {
    let mut i = 0usize;
    while i < data.len() {
        if (0x81..=0xFE).contains(&data[i]) {
            if i + 1 >= data.len() {
                return 1; // 首字节后没有尾字节
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    0
}

/// 末尾「不完整字符序列」的字节数（0..=3）。
///
/// 用途：换行分包下，设备把一行拆成多次到达时，空闲封行会把未完成行提前吐出
/// （partial 续行）；若切点正好落在多字节字符中间，该字符会被解成两个 U+FFFD。
/// 封行前用本函数把不完整序列留回 pending，等下一批字节补齐即可还原。
///
/// `encoding` 传会话当前编码；`auto` 时按 UTF-8 / GBK 两种最常见情形保守取大。
pub fn incomplete_char_tail(data: &[u8], encoding: &str) -> usize {
    // 合法 UTF-8 是完整性的自证,不可能含半个字符:必须先短路,否则下面的
    // auto 分支按 UTF-8/GBK 判据取 max,会把完整 UTF-8 行的末字节误判成
    // GBK 孤立首字节(0x81..=0xFE 重叠),切掉后整行变非法 UTF-8 → 整行乱码。
    if std::str::from_utf8(data).is_ok() {
        return 0;
    }
    match encoding {
        "utf-8" => utf8_incomplete_tail(data),
        "gbk" | "gb2312" => gbk_incomplete_tail(data),
        // 单字节编码不存在跨包截断
        "latin-1" => 0,
        // auto / 未知：按 UTF-8 与 GBK 两种最常见情形保守取大
        _ => utf8_incomplete_tail(data).max(gbk_incomplete_tail(data)),
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
/// 会话级**有状态解码上下文**(ADR-0020):把"用哪个编码、字节到哪算一个完整字符"
/// 这两件事收敛到一处,并提供**精确**的字符边界换算(基于 encoding_rs 的权威读数,
/// 而不是手写启发式)。
///
/// ── 为什么需要它 ──
/// 串口/USB 的读取边界任意,一个多字节字符(UTF-8 2~4 字节、GBK 2 字节、
/// GB18030 最多 4 字节)会被拆到相邻两次 `read`。旧实现对每块字节独立解码,再靠
/// "猜末尾几个字节是半个字符"拼回去;两种编码的字节区间重叠(合法 UTF-8 汉字的末字节
/// 同样落在 GBK 首字节区间 0x81..=0xFE),取 max 必然误伤——这正是历次乱码的根源。
///
/// 这里改用 encoding_rs 的流式语义:`last=false` 调用时它把**尾部不完整的字节序列
/// 留在内部状态**,返回的 `read` 精确等于"构成完整字符的前缀长度"。用它做切点对齐,
/// 不再有任何猜测;GB18030 等更宽的编码也自动正确。
///
/// ── 两个原语 ──
/// - [`decode_prefix`](Self::decode_prefix):解出**完整字符前缀**,返回 (文本, 已消费
///   字节数)。`consumed < len` ⇒ 尾部有半个字符,调用方把剩余字节留回缓冲即可。
/// - [`decode`](Self::decode):整段解码(用于已确认无半个字符的整行),末尾非法序列按
///   U+FFFD 处理,绝不失败。
///
/// 编码决策:`auto` 时由 [`EncodingHistory`] 滑动窗口判定并**粘住**;未锁定时按 UTF-8
/// 起手(合法 UTF-8/ASCII 走该路径,无需猜测),窗口给出确定编码后即切换。切换只改变
/// 对**尚未输出**字节的解释,不影响已输出的文本,故中途切换是安全的。
pub struct StreamDecoder {
    /// 会话编码判定(滑动窗口)。`auto` 时由它给出实际编码。
    history: EncodingHistory,
    /// 会话配置的编码名("auto"/"utf-8"/"gbk"/"gb2312"/"latin-1")
    configured: String,
    /// 当前实际生效的**具体**编码(不会是 auto)
    active: &'static str,
}

impl StreamDecoder {
    pub fn new(encoding: &str) -> Self {
        let mut s = Self {
            history: EncodingHistory::default(),
            configured: encoding.to_string(),
            active: "utf-8",
        };
        s.rebind();
        s
    }

    /// 会话编码变更(前端切换编码下拉)。只影响后续对未输出字节的解释。
    pub fn set_encoding(&mut self, encoding: &str) {
        if self.configured == encoding {
            return;
        }
        self.configured = encoding.to_string();
        // 显式切换编码:旧会话的判定证据不再适用
        self.history.reset();
        self.rebind();
    }

    /// 清空会话状态(清空日志时调用)。
    pub fn reset(&mut self) {
        self.history.reset();
        self.rebind();
    }

    /// 由 `configured`(必要时结合滑动窗口)确立 `active` 具体编码。
    fn rebind(&mut self) {
        self.active = if self.configured == AUTO {
            // auto:窗口已锁定就用锁定值,否则按 utf-8 起手
            match self.history.held_encoding() {
                AUTO => "utf-8",
                held => held,
            }
        } else {
            match self.configured.as_str() {
                "utf-8" => "utf-8",
                "gbk" | "gb2312" => "gbk",
                "latin-1" => "latin-1",
                // 未知编码名:退回 utf-8 语义(不 panic,保显示)
                _ => "utf-8",
            }
        };
    }

    /// auto 模式下让滑动窗口看这批字节;窗口给出确定编码且与当前不同时切换。
    /// 仅在 auto 生效;显式编码完全绕过窗口。
    fn settle_auto(&mut self, data: &[u8]) {
        if self.configured != AUTO {
            return;
        }
        self.history.push(data);
        if self.history.held_encoding() != self.active {
            self.rebind();
        }
    }

    /// 精确计算:`data` 里构成**完整字符**的前缀字节数(0..=len)。
    ///
    /// 这是权威答案而非估计——直接取 encoding_rs 流式解码的 `read` 读数。
    /// 用于把"强制封行 / 截断 / 空闲封行"的切点钉在字符边界上。
    pub fn complete_len(&mut self, data: &[u8]) -> usize {
        self.settle_auto(data);
        match self.active {
            // 单字节编码:每个字节都是一个完整字符
            "latin-1" => data.len(),
            "gbk" => prefix_scan(GBK.new_decoder(), data),
            _ => prefix_scan(UTF_8.new_decoder_without_bom_handling(), data),
        }
    }

    /// 解出 `data` 的完整字符前缀,返回 (文本, 已消费字节数)。
    /// `consumed < data.len()` ⇒ 尾部有半个字符,调用方应留回缓冲等下一批。
    pub fn decode_prefix(&mut self, data: &[u8]) -> (String, usize) {
        self.settle_auto(data);
        match self.active {
            "latin-1" => (data.iter().map(|&b| b as char).collect(), data.len()),
            "gbk" => span_decode(GBK.new_decoder(), data),
            _ => span_decode(UTF_8.new_decoder_without_bom_handling(), data),
        }
    }

    /// 整段解码(用于已确认不含半个字符的整行/整块)。非法序列按 U+FFFD 替换,绝不失败。
    pub fn decode(&mut self, data: &[u8]) -> String {
        self.settle_auto(data);
        match self.active {
            "gbk" => decode_with(GBK, data),
            "latin-1" => data.iter().map(|&b| b as char).collect(),
            _ => String::from_utf8_lossy(data).into_owned(),
        }
    }

    /// 当前实际生效的编码(具体名;便于遥测与测试)。
    pub fn active_encoding(&self) -> &'static str {
        self.active
    }

    /// 滑动窗口已锁定的编码(auto 模式下有意义;未锁定为 auto)。
    pub fn held_encoding(&self) -> &'static str {
        self.history.held_encoding()
    }
}

/// 用一次性 decoder 求"完整字符前缀长度"(`last=false` 的 read 读数)。
fn prefix_scan(mut dec: Decoder, src: &[u8]) -> usize {
    if src.is_empty() {
        return 0;
    }
    // 输出缓冲只为让解码推进;内容丢弃,只关心 read
    let mut out = String::with_capacity(src.len() * 2 + 8);
    let (_res, read, _had_err) = dec.decode_to_string(src, &mut out, false);
    read.min(src.len())
}

/// 用一次性 decoder 解一段自包含字节,返回 (文本, 已消费字节数)。
fn span_decode(mut dec: Decoder, src: &[u8]) -> (String, usize) {
    let mut out = String::with_capacity(src.len() * 2 + 8);
    let (_res, read, _had_err) = dec.decode_to_string(src, &mut out, false);
    (out, read.min(src.len()))
}

/// 替换式解码(非法序列 → U+FFFD),等价 Python errors="replace"。
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

    // ── 空闲封行的多字节保护：切点落在汉字中间时不能产出 U+FFFD ──
    #[test]
    fn incomplete_tail_detects_utf8() {
        assert_eq!(incomplete_char_tail(b"abc", "utf-8"), 0);
        assert_eq!(incomplete_char_tail("中".as_bytes(), "utf-8"), 0); // E4 B8 AD 完整
        assert_eq!(incomplete_char_tail(&[0xE4, 0xB8], "utf-8"), 2); // 缺 1 字节
        assert_eq!(incomplete_char_tail(&[0xE4], "utf-8"), 1);
        assert_eq!(incomplete_char_tail(&[0xF0, 0x9F, 0x98], "utf-8"), 3); // 4 字节缺 1
        assert_eq!(incomplete_char_tail(&[0xFF], "utf-8"), 0); // 非法首字节不算截断
    }

    #[test]
    fn incomplete_tail_detects_gbk() {
        let (bytes, _) = encode("更新 AP0 参数 显示: 1", "gbk");
        assert_eq!(incomplete_char_tail(&bytes, "gbk"), 0); // 完整行
        let cut = bytes
            .windows(2)
            .position(|w| w.len() == 2 && w[0] == 0xCA && w[1] == 0xFD)
            .expect("CA FD 应存在");
        assert_eq!(incomplete_char_tail(&bytes[..cut + 1], "gbk"), 1); // 砍在「数」中间
        assert_eq!(incomplete_char_tail(&bytes[..cut + 2], "gbk"), 0); // 砍在「数」之后

        // 纯 ASCII 收尾不算截断
        let (ascii, _) = encode("GATEWAY STAT On", "gbk");
        assert_eq!(incomplete_char_tail(&ascii, "gbk"), 0);
        // 单字节编码永不截断
        assert_eq!(incomplete_char_tail(&[0xB2], "latin-1"), 0);
    }

    /// 复现缺陷：一行被拆成两批、中间触发空闲封行 → 汉字被劈成两个 U+FFFD。
    /// 用 incomplete_char_tail 把不完整首字节留回 pending 后，两批拼起来应还原完整文本。
    #[test]
    fn idle_flush_holds_incomplete_gbk_tail() {
        let line = "更新 AP0 参数 显示: 1";
        let (bytes, _) = encode(line, "gbk");
        // 切在「数」(CA FD) 的第一个字节之后
        let cut = bytes
            .windows(2)
            .position(|w| w.len() == 2 && w[0] == 0xCA && w[1] == 0xFD)
            .expect("CA FD 应存在")
            + 1;
        let (head, rest) = bytes.split_at(cut);

        let mut h = EncodingHistory::new(1024);
        let keep = incomplete_char_tail(head, "gbk");
        assert_eq!(keep, 1, "末尾孤立首字节应被保留");
        let emitted = h.decode_line(&head[..head.len() - keep], "gbk");
        assert!(!emitted.contains('\u{FFFD}'), "封行片段不应含替换字符");

        // 下一批到齐：保留字节 + 剩余字节 → 完整
        let mut joined = head[head.len() - keep..].to_vec();
        joined.extend_from_slice(rest);
        let tail_text = h.decode_line(&joined, "gbk");
        assert_eq!(tail_text, "数 显示: 1");
        // 两段拼起来正好还原整行
        assert_eq!(format!("{emitted}{tail_text}"), line);
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
