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

/// 缓冲区是否「除末尾可能的不完整序列外」是合法 UTF-8。
///
/// 这就是「UTF-8 自证」判据：**合法 UTF-8 不可能含有半个字符**，所以整段能按 UTF-8
/// 解释就是它自己给出的证据，不该被别的编码猜测定性推翻。
///
/// 末尾残缺序列单独处理：读块边界切在汉字中间时，末尾那 1~3 字节是**边界产物**
/// （不是编码证据），去掉它之后整段仍合法 → 依然算 UTF-8。
pub fn utf8_self_proves(data: &[u8]) -> bool {
    if std::str::from_utf8(data).is_ok() {
        return true;
    }
    let keep = utf8_incomplete_tail(data);
    keep > 0 && std::str::from_utf8(&data[..data.len() - keep]).is_ok()
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

    /// 把一段原始字节压入窗口，并用新窗口重新判定编码。
    ///
    /// 整行「合法 UTF-8」（含纯 ASCII）直接用 UTF-8，不进窗口（避免 ASCII 稀释多语种信号）；
    /// 其余（含 GBK/EUC-KR 等非 UTF-8 字节）整段压栈，交由窗口截断。
    ///
    /// ── 调用方契约：喂进来的必须是「完整字符」组成的字节 ──
    /// 流式解码器（[`StreamDecoder::feed`]）保证这一点：它只把**完整区**喂给窗口，
    /// 末尾的半个字符留在解码器内部，绝不进来。
    ///
    /// 为什么这条契约很重要：半个字符进窗口 → chardetng 会把它猜成 GBK
    /// （实测：UTF-8 + 残尾 → 猜 GBK）→ 整条会话锁死 GBK →
    /// 之后**每一行**合法 UTF-8 都被误解码（「待机上报」→「寰呮満涓婃姤」）。
    /// 既然流式解码器从结构上杜绝了这件事，窗口就不必再自己猜「末尾像不像残尾」——
    /// 那种猜法在 GBK 数据上必然出错（GBK 尾字节与 UTF-8 首字节区间重叠）。
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

/// 会话级**有状态流式解码器**。
///
/// ── 设计：解码器持有「半个字符」 ──
/// 串口/USB 的读取边界任意，一个多字节字符（UTF-8 2~4 字节、GBK 2 字节）会被拆到
/// 相邻两次 `read`。流式的正确做法是：**让解码器自己持有那个没读完的字符**，
/// 调用方只管把字节喂进去、只拿回**完整字符**。
///
/// 于是流式解码就是：
/// ```text
/// pending += 新字节
/// 切出「完整字符区」→ 解码产出
/// 末尾不完整序列留回 pending → 等下一批补齐
/// ```
/// 关键：**切点**与**解码**必须用**同一个编码**（同一次判定），
/// 否则就会出现「字符解对了、切点却算错」的错位（这正是 d6fea44 的 bug）。
///
/// ── 为什么不用 encoding_rs 的流式 `Decoder` ──
/// `decode_to_string(.., last=false)` 确实会把末尾不完整序列留在内部，但它返回的
/// `read` 是「**喂给解码器的字节数**」——末尾不完整序列**也算在内**
/// （实测 `"cmd=40(待" + e7 8a` → `read=12`＝全长，但输出只有 `"cmd=40(待"`）。
/// 所以 `read` **不是**「完整字符占用的字节数」，拿它当切点等于没有保护。
/// 本实现改为**自己算切点**（[`StreamDecoder::tail_len`]），并保证它与解码
/// 用的是同一个编码。
///
/// ── 编码决策 ──
/// `auto` 时由 [`EncodingHistory`] 滑动窗口判定并**粘住**；未锁定时按 UTF-8 起手。
/// 切换只改变对**尚未输出**字节的解释，不影响已输出的文本，故中途切换是安全的。
///
/// ── 硬边界 vs 软边界 ──
/// - **硬边界**（一条完整行的末尾 / 会话结束）：半个字符不可能再补齐 →
///   [`StreamDecoder::close_boundary`] 把它按 U+FFFD 冲掉，绝不带进下一行。
/// - **软边界**（空闲封行 / 时间块 / 强制截断）：半个字符很可能下一批就到齐 →
///   绝不能冲掉，留在解码器内部自动接上。
///
/// 流式解码的一次产出（[`StreamDecoder::feed`] / [`StreamDecoder::close_boundary`]）。
#[derive(Debug, Default, Clone, PartialEq)]
pub struct DecodedChunk {
    /// 解出的文本：**只含完整字符**（不含留在解码器内部的半个字符）。
    pub text: String,
    /// 与 `text` 一一对应的原始字节（供 `raw_hex` 用）。
    ///
    /// **不含**留在解码器内部的半个字符 —— 那几个字节会在下一批补齐后
    /// 随那次产出一起出现，于是整条流的字节序列**不重不漏、顺序不变**。
    pub raw: Vec<u8>,
    /// 本批中「构成完整字符」的字节数（不含上一批遗留的半个字符）。
    pub consumed: usize,
    /// 末尾是否还有半个字符（已留在解码器内部，等下一批补齐）。
    pub has_tail: bool,
}

pub struct StreamDecoder {
    /// 会话编码判定(滑动窗口)。`auto` 时由它给出实际编码。
    history: EncodingHistory,
    /// 会话配置的编码名("auto"/"utf-8"/"gbk"/"gb2312"/"latin-1")
    configured: String,
    /// 最近一次判定的**具体**编码(不会是 auto;便于遥测与测试)。
    active: &'static str,
    /// **流式状态**：尚未构成完整字符的字节（半个字符）。
    ///
    /// 这是整个流式方案的核心：它把「切点在哪」的问题从调用方彻底消除 ——
    /// 调用方永远只看到完整字符，边界由解码器自己负责：
    /// 上一行末尾的半个汉字会被**留在这里**，等下一行到齐后自动接上还原。
    pending: Vec<u8>,
    /// `pending` 所属的编码 —— 跨批次补全时必须用**同一个**编码解释，
    /// 否则会出现「按 A 解、按 B 补」的错位。
    pending_enc: &'static str,
}

impl StreamDecoder {
    pub fn new(encoding: &str) -> Self {
        let mut s = Self {
            history: EncodingHistory::default(),
            configured: encoding.to_string(),
            active: "utf-8",
            pending: Vec::new(),
            pending_enc: "utf-8",
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
        // pending 里是按旧编码解释的半个字符,换编码后已无意义 → 丢弃
        // (换编码是用户的显式决定,丢弃半个字符可接受;自动锁定不经过这里)
        self.pending.clear();
        self.pending_enc = self.active;
        self.rebind();
    }

    /// 清空会话状态(清空日志时调用)。
    pub fn reset(&mut self) {
        self.history.reset();
        self.pending.clear();
        self.pending_enc = self.active;
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

    /// 把一段「确定由完整字符组成」的字节喂给编码检测窗口。
    ///
    /// ── 调用方契约 ──
    /// 喂进来的必须是**完整字符**(见 [`Self::safe_len`])。半个字符一旦进窗口,
    /// chardetng 就会把它猜成 GBK(实测:UTF-8 + 残尾 → 猜 GBK),
    /// 于是整条会话锁死 GBK,之后**每一行**合法 UTF-8 都被误解码
    /// (「待机上报」→「寰呮満涓婃姤」)。流式解码从结构上杜绝了这件事。
    ///
    /// 只在 auto 模式生效:用户显式选了 gbk/utf-8 时必须照办,不被自动判定推翻。
    fn observe(&mut self, complete: &[u8]) {
        if self.configured != AUTO {
            return;
        }
        self.history.push(complete);
        if self.history.held_encoding() != self.active {
            self.rebind();
        }
    }

    /// 「安全区」长度:**在 UTF-8 与 GBK 两种判据下都算完整**的前缀字节数。
    ///
    /// 取两种残尾长度的**较大值** ⇒ 切得更多、更保守 ⇒ 送进检测窗口的字节
    /// 在任何一种编码下都不是半个字符。
    ///
    /// 代价:末尾几个字节暂时不作为检测证据。但窗口有几千字节,完全够 chardetng 判定;
    /// 而这几个字节会在下一批到齐、被判为完整字符后补进窗口(不重不漏)。
    fn safe_len(buf: &[u8]) -> usize {
        buf.len() - utf8_incomplete_tail(buf).max(gbk_incomplete_tail(buf))
    }

    /// 本段字节应按哪个编码解释(**决策的唯一来源**)。
    ///
    /// - **显式编码**:用户的决定,照办(自动判定不得推翻)。
    /// - **auto + UTF-8 自证**:整段能按 UTF-8 解释 → 就是 UTF-8。
    ///   混合流里 UTF-8 行与 GBK 行交错,这一步保证 UTF-8 行不会被窗口锁定值带偏
    ///   (用户症状:「待机上报」→「寰呮満涓婃姤」)。
    /// - **auto + 窗口已锁 GBK**:按 GBK 解。
    /// - **auto + 其余**:按 latin-1 逐字节兜底:保字节不丢
    ///   (按 GBK 硬解错会产生 U+FFFD,字节就真丢了;不假设语系更保险)。
    fn enc_for(&self, data: &[u8]) -> &'static str {
        if self.configured != AUTO {
            return self.active;
        }
        if utf8_self_proves(data) {
            return "utf-8";
        }
        match self.history.held_encoding() {
            "gbk" => "gbk",
            _ => "latin-1",
        }
    }

    /// 该编码下 `buf` 末尾残缺字符序列的字节数(单字节编码恒为 0)。
    fn tail_len(&self, buf: &[u8], enc: &str) -> usize {
        match enc {
            "gbk" => gbk_incomplete_tail(buf),
            // 单字节编码不存在跨包截断
            "latin-1" => 0,
            _ => utf8_incomplete_tail(buf),
        }
    }

    // ── 流式主入口 ──

    /// **流式喂入**:把这批字节接在未读完的半个字符之后,解出**尽可能多的完整字符**。
    ///
    /// 返回 [`DecodedChunk`]:
    /// - `text` 只含**完整字符**(不含留在解码器内部的半个字符,也不含 U+FFFD 残留)
    /// - `raw` 是与 `text` 对应的原始字节(供 `raw_hex` 用):**不包含**留在内部的
    ///   半个字符 —— 那几个字节会在下一批补齐后随那次产出一起出现,
    ///   于是整条流的字节序列**不重不漏、顺序不变**
    /// - `has_tail` 为 true ⇒ 末尾还有半个字符(已留在解码器内部,等下一批补齐)
    ///
    /// 这是流式方案的**唯一**字节入口:切点问题由解码器内部消化,
    /// 调用方再也不用自己算「末尾几个字节是半个字符」。
    ///
    /// 非法字节按 U+FFFD 替换(等价 errors="replace"),绝不失败。
    pub fn feed(&mut self, data: &[u8]) -> DecodedChunk {
        let mut chunk = DecodedChunk::default();

        // 1) 合并上一批留下的「半个字符」(尚未产出、也尚未进检测窗口)
        let mut buf: Vec<u8> = Vec::with_capacity(self.pending.len() + data.len());
        buf.extend_from_slice(&self.pending);
        buf.extend_from_slice(data);
        let carried = self.pending.len();
        self.pending.clear();

        // 2) 检测窗口**只吃安全区**(两种编码下都算完整的字节)
        //    → 半个字符绝不进窗口 → 残尾毒化检测从结构上被消除。
        //    (用户症状的根因:残尾被 chardetng 猜成 GBK → 之后每一行都被误解码)
        //    顺序很重要:**先喂窗口、再定编码** —— 否则本批的第一条 GBK 证据来不及生效。
        self.observe(&buf[..Self::safe_len(&buf)]);

        // 3) 定编码 → 4) 用**同一个**编码划切点(「解码」与「切点」必须一致,
        //    否则「按 A 解、按 B 切」→ 错位:这正是历史乱码的根因)
        let enc = self.enc_for(&buf);
        let mut complete = buf.len() - self.tail_len(&buf, enc);

        // 5) pending 的编码与本段不一致 → 上批的半个字符补不上了(编码已变),
        //    按旧编码单独冲掉,绝不让它污染本段(否则「按 A 解、按 B 补」→ 错位)。
        if carried > 0 && enc != self.pending_enc {
            let stale = buf[..carried].to_vec();
            chunk
                .text
                .push_str(&self.decode_bytes_with(&stale, self.pending_enc));
            chunk.raw.extend_from_slice(&stale);
            buf.drain(..carried);
            complete = buf.len() - self.tail_len(&buf, enc);
        }

        // 6) 解码完整区;末尾残缺序列留回 pending,等下一批补齐后自动接上还原
        chunk
            .text
            .push_str(&self.decode_bytes_with(&buf[..complete], enc));
        chunk.raw.extend_from_slice(&buf[..complete]);

        self.pending = buf[complete..].to_vec();
        self.pending_enc = enc;
        chunk.has_tail = !self.pending.is_empty();
        // 本批中「构成完整字符」的字节数(扣掉上一批遗留的 pending)
        chunk.consumed = complete.saturating_sub(carried);
        chunk
    }

    /// **硬边界收尾**:在「此处确实结束」的地方(一条完整行的末尾 / 会话结束)
    /// 把残留的半个字符按 U+FFFD 冲掉。
    ///
    /// 为什么需要:半个字符跨过**换行符**后不可能再补齐(换行字节不属于任何多字节
    /// 字符),留着它只会污染下一行。
    ///
    /// 但**软边界**(空闲封行 / 时间块 / 强制截断)**不能**调用本方法 ——
    /// 那里半个字符很可能下一批就到齐了,流式解码器会自己把它接上。
    pub fn close_boundary(&mut self) -> DecodedChunk {
        let mut chunk = DecodedChunk::default();
        if self.pending.is_empty() {
            return chunk;
        }
        let stale = std::mem::take(&mut self.pending);
        // 残缺字节按产生它时的编码解释:解不出来就是替换字符(不可能再补齐了)
        chunk.text = self.decode_bytes_with(&stale, self.pending_enc);
        chunk.raw = stale;
        chunk
    }

    /// 按指定编码解码一段**自包含**的字节(调用方保证不含半个字符)。
    fn decode_bytes_with(&self, data: &[u8], enc: &str) -> String {
        if data.is_empty() {
            return String::new();
        }
        match enc {
            "gbk" => decode_with(GBK, data),
            "latin-1" => data.iter().map(|&b| b as char).collect(),
            _ => String::from_utf8_lossy(data).into_owned(),
        }
    }

    /// 当前是否有未读完的半个字符(硬边界收尾时需冲刷)。
    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// 精确计算:`data` 里构成**完整字符**的前缀字节数(0..=len)。
    ///
    /// 用于把「强制封行 / 截断 / 空闲封行」的切点钉在字符边界上:末尾不完整序列
    /// **不计入**,调用方据此把它留回缓冲,等下一批字节到齐再一起解。
    ///
    /// 判据与 [`Self::feed`] 完全一致(同一套编码决策 + 同一套残尾判据),
    /// 保证「解出来的」与「切出来的」永远对齐。
    ///
    /// 注意这**不是** encoding_rs 的 `read` 读数:它把末尾不完整序列也算已消费
    /// → 恒等于全长 → 切点保护形同虚设(这正是 d6fea44 的 bug)。
    pub fn complete_len(&mut self, data: &[u8]) -> usize {
        let enc = self.enc_for(data);
        data.len() - self.tail_len(data, enc)
    }

    /// 解出 `data` 的完整字符前缀,返回 (文本, 已消费字节数)。
    /// `consumed < data.len()` ⇒ 尾部有半个字符,调用方应留回缓冲等下一批。
    ///
    /// 与 [`Self::feed`] 等价的一次性版本:流式方案的主路径用 `feed`,
    /// 本方法保留给「一次性解码一段自包含字节」的调用方。
    pub fn decode_prefix(&mut self, data: &[u8]) -> (String, usize) {
        self.observe(&data[..Self::safe_len(data)]);
        let enc = self.enc_for(data);
        let consumed = data.len() - self.tail_len(data, enc);
        (self.decode_bytes_with(&data[..consumed], enc), consumed)
    }

    /// 整段解码(用于已确认不含半个字符的整行/整块)。非法序列按 U+FFFD 替换,绝不失败。
    ///
    /// 判据与 [`Self::feed`] 一致。
    pub fn decode(&mut self, data: &[u8]) -> String {
        self.observe(&data[..Self::safe_len(data)]);
        let enc = self.enc_for(data);
        self.decode_bytes_with(data, enc)
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

    // ── 混合流：UTF-8 自证优先（用户实测「中英混合又出问题了」）──

    /// 回归：**流式解码器**保证半个字符绝不进编码检测窗口。
    ///
    /// 缺陷现象：设备用 UTF-8 输出中文，日志中出现
    /// `cmd=40(待机上报)` → `cmd=40(寰呮満涓婃姤)`（整行被按 GBK 解）。
    /// 机理：残缺尾字节被喂给 chardetng → 猜成 GBK → 窗口锁死 GBK →
    /// 之后**每一行**合法 UTF-8 都被按 GBK 解码。
    ///
    /// 修复方式（流式方案）：窗口的输入契约是「只含完整字符」，
    /// 由 [`StreamDecoder::feed`] 从结构上保证 —— 末尾半个字符留在解码器内部。
    #[test]
    fn truncated_utf8_tail_never_reaches_detection_window() {
        let mut d = StreamDecoder::new(AUTO);
        let line = "cmd=40(待机上报) len=11 ret=0 host=55DF4EAB ch=3";
        // 末尾切在「状」字中间：只剩 UTF-8 的前 2 字节
        let mut raw = line.as_bytes().to_vec();
        raw.extend_from_slice(&[0xe7, 0x8a]);

        // 流式喂入：半个字符被留在解码器内部
        let chunk = d.feed(&raw);
        assert!(chunk.has_tail, "末尾的半个字符应被留回解码器内部");
        assert_eq!(
            d.held_encoding(),
            AUTO,
            "半个字符不得进检测窗口 → 窗口不得锁定 GBK"
        );
        // 文本本身也必须完好（不含替换字符）
        assert!(
            !chunk.text.contains('\u{FFFD}'),
            "半个字符不得解出替换字符: {:?}",
            chunk.text
        );
    }

    /// 回归：同一段残缺尾用 chardetng 直接猜会得到 GBK —— 锁定这条判据的必要性。
    #[test]
    fn truncated_utf8_tail_is_misjudged_gbk_by_raw_detector() {
        let line = "cmd=40(待机上报) len=11 ret=0 host=55DF4EAB ch=3";
        let mut raw = line.as_bytes().to_vec();
        raw.extend_from_slice(&[0xe7, 0x8a]);

        let mut det = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
        det.feed(&raw, true);
        let enc = det.guess(None, chardetng::Utf8Detection::Deny);
        assert!(
            std::ptr::eq(enc, GBK),
            "本回归的前提：原始检测器确实会把「UTF-8 + 残尾」猜成 GBK"
        );
        // 但「去掉残尾后整段合法 UTF-8」这一自证判据能正确识别它
        assert!(utf8_self_proves(&raw), "应识别为 UTF-8 + 边界残尾");
    }

    /// 回归（用户症状主路径）：窗口一旦被毒化锁到 GBK，
    /// 后续**合法 UTF-8** 的整行仍必须原样显示，不被按 GBK 误解码。
    #[test]
    fn valid_utf8_line_survives_gbk_window_lock() {
        let mut d = StreamDecoder::new(AUTO);
        let line = "cmd=40(待机上报) len=11 ret=0 host=55DF4EAB ch=3";

        // 先用**真正的 GBK** 证据把窗口锁到 GBK（模拟混合流里的 GBK 行）
        let (gbk_bytes, _) = encode("状态=0 已录=100/100 间隔=1s", "gbk");
        let _ = d.decode(&gbk_bytes);
        assert_eq!(d.held_encoding(), "gbk", "窗口应已锁定 GBK");

        // 随后这行合法 UTF-8 必须原样显示 —— 不能被 active=gbk 带偏
        let out = d.decode(line.as_bytes());
        assert_eq!(
            out, line,
            "合法 UTF-8 行不应被窗口锁定值误解码（用户症状：待机上报→寰呮満涓婃�）"
        );
    }

    /// 回归：auto 模式下 UTF-8 行与 GBK 行**交错**时，各自按自己的编码正确解码。
    #[test]
    fn mixed_utf8_and_gbk_lines_each_decode_correctly() {
        let mut d = StreamDecoder::new(AUTO);
        let utf8_line = "cmd=40(待机上报) len=11 ret=0 host=55DF4EAB ch=3";
        let gbk_line = "状态=0 已录=100/100 间隔=1s";

        let (gbk_bytes, _) = encode(gbk_line, "gbk");

        // UTF-8 → GBK → UTF-8 交错
        assert_eq!(d.decode(utf8_line.as_bytes()), utf8_line);
        assert_eq!(d.decode(&gbk_bytes), gbk_line);
        assert_eq!(d.decode(utf8_line.as_bytes()), utf8_line);
    }

    /// 回归：纯 GBK 设备不受影响 —— 显式 gbk 与 auto 锁定 gbk 都要正确。
    #[test]
    fn pure_gbk_device_unaffected() {
        for configured in ["gbk", AUTO] {
            let mut d = StreamDecoder::new(configured);
            for l in [
                "状态=0 已录=100/100 间隔=1s",
                "cmd=40(待机上报) len=11 ret=0 host=55DF4EAB ch=3",
                "运行态上报",
            ] {
                let (bytes, _) = encode(l, "gbk");
                assert_eq!(d.decode(&bytes), l, "encoding={configured} 时 GBK 行应正确");
            }
        }
    }

    /// 回归：显式选定的编码是**用户的决定**，自动判定不得推翻它。
    #[test]
    fn explicit_encoding_is_never_overridden_by_detection() {
        let mut d = StreamDecoder::new("gbk");
        let (bytes, _) = encode("待机上报", "gbk");
        assert_eq!(d.decode(&bytes), "待机上报", "显式 gbk 必须照办");

        let mut d2 = StreamDecoder::new("utf-8");
        assert_eq!(
            d2.decode("待机上报".as_bytes()),
            "待机上报",
            "显式 utf-8 必须照办"
        );
    }

    /// 回归：切点计算在「窗口锁定 GBK、当前段却是 UTF-8」时仍按 UTF-8 对齐，
    /// 否则会把汉字劈成两半（`complete_len` 少算字节 → 后续行整体错位）。
    #[test]
    fn complete_len_aligns_to_utf8_even_when_window_locked_gbk() {
        let mut d = StreamDecoder::new(AUTO);
        // 用 GBK 证据锁窗口
        let (gbk_bytes, _) = encode("状态=0 已录=100/100 间隔=1s", "gbk");
        let _ = d.decode(&gbk_bytes);
        assert_eq!(d.held_encoding(), "gbk");

        // UTF-8 行末尾带残缺尾：切点必须落在残尾之前（不劈开汉字）
        let line = "cmd=40(待机上报)";
        let mut raw = line.as_bytes().to_vec();
        raw.extend_from_slice(&[0xe7, 0x8a]);
        let complete = d.complete_len(&raw);
        assert_eq!(complete, line.len(), "切点应落在残缺尾之前（汉字不被劈开）");
    }

    /// 回归：空闲封行时，末尾不完整序列必须被**留回缓冲**（`complete_len` 扣掉它），
    /// 封行片段才不含 U+FFFD —— 这正是修「参?」的那个保护。
    ///
    /// 注意：旧实现用 encoding_rs 的 `read` 读数求切点，而 `read` **把残尾也算已消费**
    /// → 切点永远等于全长 → 保护形同虚设。改用 `complete_len` 后才真正留得住。
    #[test]
    fn complete_len_holds_incomplete_utf8_tail() {
        let mut d = StreamDecoder::new(AUTO);
        let line = "更新 AP0 参数 显示: 1";
        let mut raw = line.as_bytes().to_vec();
        raw.push(0xe5); // 「数」的首字节，缺后 2 字节

        let complete = d.complete_len(&raw);
        assert_eq!(complete, line.len(), "残缺尾的 1 字节应被扣在切点之外");
        assert_eq!(raw.len() - complete, 1, "应留回 1 字节");

        // 封行片段（切点之前）必须完整、无替换字符
        let emitted = d.decode(&raw[..complete]);
        assert_eq!(emitted, line, "封行片段应还原整行");
        assert!(!emitted.contains('\u{FFFD}'), "封行片段不应含替换字符");
    }

    /// 回归（边界）：GBK 汉字的**尾字节**落在 UTF-8 首字节区间（0xC2..0xF4）时，
    /// 该 GBK 行不得被「UTF-8 自证」误判成 UTF-8。
    ///
    /// 「伮」的 GBK 字节 = 81 C2，尾字节 0xC2 正是 UTF-8 两字节序列的首字节区间 ——
    /// 这是两个编码区间重叠的典型样本，自证判据必须对它免疫。
    #[test]
    fn gbk_line_with_utf8_range_trail_byte_is_not_self_proved() {
        let mut line = b"state=1 ".to_vec();
        line.extend_from_slice(&[0x81, 0xC2]); // GBK「伮」
        assert!(
            !utf8_self_proves(&line),
            "GBK 行不得被判成 UTF-8（尾字节落在 0xC2..0xF4）"
        );

        // 窗口锁定 GBK 后，这行必须按 GBK 解、不得含替换字符
        let mut d = StreamDecoder::new(AUTO);
        let (lock, _) = encode("状态=0 已录=100/100 间隔=1s", "gbk");
        let _ = d.decode(&lock);
        assert_eq!(d.held_encoding(), "gbk");
        let out = d.decode(&line);
        assert!(!out.contains('\u{FFFD}'), "GBK 行不得含替换字符: {out:?}");
    }

    /// 回归（边界）：GBK 行末尾的**孤立首字节**（汉字被切断）必须被留回缓冲，
    /// 且封行片段不得含替换字符。
    #[test]
    fn gbk_isolated_lead_byte_is_held_back() {
        let mut d = StreamDecoder::new(AUTO);
        // 先锁 GBK
        let (lock, _) = encode("状态=0 已录=100/100 间隔=1s", "gbk");
        let _ = d.decode(&lock);
        assert_eq!(d.held_encoding(), "gbk");

        let (base, _) = encode("状态=0 已录=100/100", "gbk");
        let mut raw = base;
        raw.push(0xB0); // 孤立首字节（汉字被切断）

        let complete = d.complete_len(&raw);
        assert_eq!(complete, raw.len() - 1, "GBK 孤立首字节应留回");
        let out = d.decode(&raw[..complete]);
        assert!(
            !out.contains('\u{FFFD}'),
            "GBK 封行片段不应含替换字符: {out:?}"
        );
    }
    // ── 流式解码：解码器持有「半个字符」，调用方不再算切点 ──

    /// 找一个「切在多字节字符中间」的字节位置（UTF-8 3 字节字符的中途）。
    fn mid_utf8_cut(bytes: &[u8]) -> usize {
        let mut i = 0;
        while i + 3 <= bytes.len() {
            if bytes[i] >= 0xE0 && bytes[i] <= 0xEF && bytes[i + 1] >= 0x80 {
                return i + 1; // 3 字节字符的第 1 字节之后
            }
            i += 1;
        }
        panic!("no 3-byte utf8 char found");
    }

    /// 找一个「切在 GBK 双字节字符中间」的字节位置。
    fn mid_gbk_cut(bytes: &[u8]) -> usize {
        // GBK 必须**成对扫描**：尾字节区间 0x40..=0xFE 与首字节区间 0x81..=0xFE 重叠，
        // 不能只看单个字节的位置。
        let mut i = 0;
        while i < bytes.len() {
            let b = bytes[i];
            if (0x81..=0xFE).contains(&b) {
                // 这是首字节 → 下一个字节是尾字节 → 切在这里 = 半个字符
                return i + 1;
            }
            i += 1;
        }
        panic!("no gbk double byte char found");
    }

    /// 回归（流式核心）：一个 UTF-8 汉字被拆到两次 `feed` 里，
    /// 解码器必须**跨批次持有**那半个字符，等补齐后还原成完整汉字。
    #[test]
    fn stream_holds_partial_character_across_feeds() {
        let line = "cmd=40(待机上报) len=11";
        let bytes = line.as_bytes();
        let cut = mid_utf8_cut(bytes);
        let mut d = StreamDecoder::new("utf-8");

        let c1 = d.feed(&bytes[..cut]);
        assert!(c1.has_tail, "partial char must stay inside decoder");
        assert!(
            line.starts_with(&c1.text),
            "batch 1 must be a clean prefix: {:?}",
            c1.text
        );
        assert!(
            !c1.text.contains('\u{FFFD}'),
            "partial char must not decode to U+FFFD: {:?}",
            c1.text
        );

        let c2 = d.feed(&bytes[cut..]);
        assert!(!c2.has_tail);
        assert_eq!(
            format!("{}{}", c1.text, c2.text),
            line,
            "two batches must rebuild the whole line"
        );
    }

    /// 回归（流式核心）：**逐字节**喂入也必须还原原文 ——
    /// 这证明字符边界完全由解码器负责，与喂入粒度无关。
    #[test]
    fn stream_byte_by_byte_reproduces_text() {
        for enc in ["utf-8", "gbk"] {
            let line = "cmd=40(待机上报) len=11";
            let (bytes, _) = encode(line, enc);
            let mut d = StreamDecoder::new(enc);
            let mut text = String::new();
            let mut raw = Vec::new();
            for b in &bytes {
                let c = d.feed(&[*b]);
                text.push_str(&c.text);
                raw.extend_from_slice(&c.raw);
            }
            assert_eq!(text, line, "encoding={enc}: byte-by-byte must rebuild");
            assert_eq!(raw, bytes, "encoding={enc}: raw bytes must be lossless");
        }
    }

    /// 回归（流式核心）：GBK 汉字被拆到两次 `feed` 里也必须正确还原
    /// （GBK 是双字节，切点落在中间的概率与 UTF-8 一样高）。
    #[test]
    fn stream_holds_partial_gbk_character_across_feeds() {
        let line = "状态=0 已录=100/100";
        let (bytes, _) = encode(line, "gbk");
        let cut = mid_gbk_cut(&bytes);
        let mut d = StreamDecoder::new("gbk");

        let c1 = d.feed(&bytes[..cut]);
        assert!(c1.has_tail, "gbk partial char must stay inside decoder");
        assert!(
            !c1.text.contains('\u{FFFD}'),
            "gbk partial char must not decode to U+FFFD: {:?}",
            c1.text
        );

        let c2 = d.feed(&bytes[cut..]);
        assert_eq!(
            format!("{}{}", c1.text, c2.text),
            line,
            "two batches must rebuild the whole line"
        );
    }

    /// 回归（流式核心）：混合流里 UTF-8 行与 GBK 行交错时，
    /// **即使读块边界切在汉字中间**，两行也各自正确解码。
    ///
    /// 这是用户实测症状（「中英混合又出问题了」）的完整场景：
    /// 窗口锁定 GBK 之后，后到的 UTF-8 行**不得**被带偏成
    /// 「寰呮満涓婃姤」。
    #[test]
    fn stream_mixed_utf8_and_gbk_survives_mid_character_cut() {
        let utf8_line = "cmd=40(待机上报) len=11";
        let gbk_line = "状态=0 已录=100/100";
        let (gbk_bytes, _) = encode(gbk_line, "gbk");

        let mut d = StreamDecoder::new(AUTO);
        let mut out = String::new();

        // 先喂几行 GBK，让检测窗口锁定 GBK（真实设备也是这样积累证据的）
        for _ in 0..3 {
            out.push_str(&d.feed(&gbk_bytes).text);
        }
        assert_eq!(d.held_encoding(), "gbk", "window must lock gbk");

        // UTF-8 行，中间切一刀 → 必须按 UTF-8 解，不能被窗口锁定值带偏
        let u = utf8_line.as_bytes();
        let ucut = mid_utf8_cut(u);
        out.push_str(&d.feed(&u[..ucut]).text);
        out.push_str(&d.feed(&u[ucut..]).text);

        assert!(
            out.contains("待机上报"),
            "utf8 line must render as-is, got: {out:?}"
        );
        assert!(
            !out.contains("寰呮満涓婃姤"),
            "utf8 line must not be mojibake, got: {out:?}"
        );
        assert!(
            out.contains("状态=0"),
            "gbk line must render as-is, got: {out:?}"
        );
    }

    /// 回归（流式核心）：**硬边界**收尾时，残留的半个字符必须被冲掉
    /// （半个字符跨过换行后不可能再补齐），且不能污染下一行。
    #[test]
    fn stream_hard_boundary_flushes_partial_without_polluting_next_line() {
        let mut d = StreamDecoder::new("utf-8");
        // 一行末尾切在汉字中间 → 半个字符被持有
        let line1 = "cmd=40(待机上报)";
        let b1 = line1.as_bytes();
        let c1 = d.feed(&b1[..mid_utf8_cut(b1)]);
        assert!(c1.has_tail, "partial char must be held");

        // 硬边界：换行 → 半个字符冲掉
        let tail = d.close_boundary();
        assert!(!tail.text.is_empty(), "leftover partial must be flushed");
        assert!(
            !d.has_pending(),
            "no partial may remain after hard boundary"
        );

        // 下一行必须完好，不受上一行残尾影响
        let line2 = "cmd=40(运行态上报)";
        let c2 = d.feed(line2.as_bytes());
        assert_eq!(c2.text, line2, "next line must not be polluted");
    }

    /// 回归（流式核心）：`consumed` 报的是「本批中构成完整字符的字节数」，
    /// 调用方据此知道「这一批没吃完」—— 这是流式契约的一部分。
    #[test]
    fn stream_consumed_reports_complete_character_bytes() {
        let line = "cmd=40(待机上报)";
        let b = line.as_bytes();
        let cut = mid_utf8_cut(b);
        let mut d = StreamDecoder::new("utf-8");

        let c1 = d.feed(&b[..cut]);
        assert!(c1.has_tail);
        assert_eq!(c1.consumed, cut - 1, "partial char bytes are not consumed");

        let c2 = d.feed(&b[cut..]);
        // consumed 报的是「**本次喂入的字节**里构成完整字符的字节数」：
        // 上一批遗留的半个字符不归本次计数（它是在本次被补齐的）。
        assert_eq!(c2.consumed, b.len() - cut, "completed bytes now consumed");
        assert!(!c2.has_tail);
    }
}
