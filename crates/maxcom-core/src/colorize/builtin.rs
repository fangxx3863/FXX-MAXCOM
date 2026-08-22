//! 自动染色内置规则（COLOR-T02/T03/T04）。四条规则按优先级组成规则链：
//! bracket=1 → keyword=2 → kv=3 → number=4。颜色映射：D=灰 I=默认 W=黄 E=红 F=红+粗体。
//! 每条规则独立开关（engine.enable_rule）。不改原文，只分段附色。

use super::ColoredSegment;

/// 等级括号：`[D] [I] [W] [E] [F] [DEBUG]...`（行首，忽略大小写）→ 整行染色
static LEVEL_BRACKET: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"(?i)^\s*\[([DIFWE]|DEBUG|INFO|WARN(?:ING)?|ERROR|ERR|FATAL|CRITICAL)\]")
        .unwrap()
});

/// 等级关键词：关键词后必须跟 `:`/`>`/空白 分隔符，避免 "error handler" 正文误匹配（DoD③）
static LEVEL_KEYWORD: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)(?:^\s*|^<)(DEBUG|INFO|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|D|I|W|E|F)[:>\s]+",
    )
    .unwrap()
});

/// 键值对 `KEY: VALUE`
static KV: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"([A-Za-z_][A-Za-z0-9_]*):\s*([^,\s]+)").unwrap()
});

/// 数值：`0x..` / 浮点 / 整数
static NUM: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"(0x[0-9A-Fa-f]+|\d+\.\d+|\d+)").unwrap());

/// 键值对 VALUE 强调色（暗底适配，COLOR-T07 Palette）
pub const KV_COLOR: &str = "cyan";
/// 数值强调色
pub const NUM_COLOR: &str = "magenta";

/// 等级 → (颜色名, 粗体)。I/INFO 默认色返回 (None, false)。
fn level_style(level: &str) -> (Option<&'static str>, bool) {
    match level.to_ascii_uppercase().as_str() {
        "D" | "DEBUG" => (Some("gray"), false),
        "W" | "WARN" | "WARNING" => (Some("yellow"), false),
        "E" | "ERROR" | "ERR" | "F" | "FATAL" | "CRITICAL" => (
            Some("red"),
            level.eq_ignore_ascii_case("F")
                || level.eq_ignore_ascii_case("FATAL")
                || level.eq_ignore_ascii_case("CRITICAL"),
        ),
        _ => (None, false),
    }
}

/// 等级括号规则（COLOR-T02）：`[W] ...` 整行染色。
fn bracket_rule(line: &str) -> Option<Vec<ColoredSegment>> {
    let m = LEVEL_BRACKET.captures(line)?;
    let (color, bold) = level_style(m.get(1)?.as_str());
    Some(vec![ColoredSegment::colored(
        line,
        color.map(str::to_string),
        None,
        bold,
    )])
}

/// 等级关键词规则（COLOR-T03）：`WARN: ...` / `<E> ...` 整行染色。
fn keyword_rule(line: &str) -> Option<Vec<ColoredSegment>> {
    let m = LEVEL_KEYWORD.captures(line)?;
    let (color, bold) = level_style(m.get(1)?.as_str());
    Some(vec![ColoredSegment::colored(
        line,
        color.map(str::to_string),
        None,
        bold,
    )])
}

/// 键值对规则（COLOR-T04）：`KEY: VALUE` 的 VALUE 用强调色，KEY 默认色。
fn kv_rule(line: &str) -> Option<Vec<ColoredSegment>> {
    // 不变量（INV-COLOR）：输出各段拼接 === 原行 —— 匹配区间内每个字符
    // （含 KEY 与 VALUE 之间的 ": " 分隔符）都必须出现在输出里。
    let mut segs = Vec::new();
    let mut pos = 0;
    for m in KV.captures_iter(line) {
        let whole = m.get(0)?;
        let key = m.get(1)?;
        let val = m.get(2)?;
        if whole.start() > pos {
            segs.push(ColoredSegment::plain(&line[pos..whole.start()]));
        }
        segs.push(ColoredSegment::plain(key.as_str())); // KEY 默认色
                                                        // 关键：KEY 与 VALUE 之间的分隔符（如 ": "）原样保留，绝不吞字符
        segs.push(ColoredSegment::plain(&line[key.end()..val.start()]));
        segs.push(ColoredSegment::colored(
            val.as_str(),
            Some(KV_COLOR.to_string()),
            None,
            false,
        ));
        pos = whole.end();
    }
    if segs.is_empty() {
        return None;
    }
    if pos < line.len() {
        segs.push(ColoredSegment::plain(&line[pos..]));
    }
    Some(segs)
}

/// 数值规则（COLOR-T04）：`0x..` / 浮点 / 整数用强调色。
fn number_rule(line: &str) -> Option<Vec<ColoredSegment>> {
    let mut segs = Vec::new();
    let mut pos = 0;
    for m in NUM.find_iter(line) {
        if m.start() > pos {
            segs.push(ColoredSegment::plain(&line[pos..m.start()]));
        }
        segs.push(ColoredSegment::colored(
            m.as_str(),
            Some(NUM_COLOR.to_string()),
            None,
            false,
        ));
        pos = m.end();
    }
    if segs.is_empty() {
        return None;
    }
    if pos < line.len() {
        segs.push(ColoredSegment::plain(&line[pos..]));
    }
    Some(segs)
}

/// 内置规则清单：(名称, 优先级, 处理函数)。
pub type BuiltinFunc = fn(&str) -> Option<Vec<ColoredSegment>>;

pub const BUILTIN_RULES: [(&str, f64, BuiltinFunc); 4] = [
    ("bracket", 1.0, bracket_rule),
    ("keyword", 2.0, keyword_rule),
    ("kv", 3.0, kv_rule),
    ("number", 4.0, number_rule),
];

#[cfg(test)]
mod tests {
    use super::super::ColorizeEngine;
    use super::*;

    /// INV-COLOR：任何规则产出的段拼接必须逐字等于原行（染色只附色，不改内容）
    #[test]
    fn segments_concatenate_to_original_line() {
        let lines = [
            "vol: 123, tmp 456",
            "vol:123,tmp:456",
            "baseline: 1234, raw: 4567",
            "Voltage 123V, Amp 2.4A",
            "a: 1, b: 2, c: 3",
            "[W] temp=36.6, status OK",
            "[E] boom",
            "<E> code=0xFF count:-42",
            "ERROR: disk full",
            "I: started",
            "F: critical failure",
            "offset -3.14e+2 at 0x1A2B",
            "key:",    // 有键无值 → kv 不匹配
            "key:   ", // 值全空白 → kv 不匹配
            ": 123",   // 冒号开头
            "a:b:c:d", // 连续冒号
            "no matches here",
            "",
            " ",
            "中文键: 值123", // CJK：键非 ASCII 不匹配 kv，数字仍染色
            "temp: 36C.",    // 值带单位与标点
            "x 1 y 2 z 3",
        ];
        for line in lines {
            for (name, _, rule) in BUILTIN_RULES {
                let segs = rule(line).unwrap_or_else(|| vec![ColoredSegment::plain(line)]);
                let joined: String = segs.iter().map(|s| s.text.as_str()).collect();
                assert_eq!(joined, line, "规则 {name} 改写了内容");
            }
        }
    }

    /// 引擎全链路（含用户规则位）同样满足 INV-COLOR；ANSI 让位路径对剥离后文本成立
    #[test]
    fn engine_chain_preserves_content() {
        let e = ColorizeEngine::new(true);
        for line in [
            "vol: 123, tmp 456",
            "[W] battery 3.7V, chg 0x2A",
            "plain text",
            "\tTabbed: 1\tvalue 2",
        ] {
            let joined: String = e
                .process_line(line)
                .iter()
                .map(|s| s.text.as_str())
                .collect();
            assert_eq!(joined, line);
        }
        // ANSI 让位：剥离控制码后内容保留（日志路径约定）
        let joined: String = e
            .process_line("\u{1b}[31mred\u{1b}[0m 42")
            .iter()
            .map(|s| s.text.as_str())
            .collect();
        assert_eq!(joined, "red 42");
    }
}
