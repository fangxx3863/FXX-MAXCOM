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
    let mut segs = Vec::new();
    let mut pos = 0;
    for m in KV.captures_iter(line) {
        let whole = m.get(0)?;
        if whole.start() > pos {
            segs.push(ColoredSegment::plain(&line[pos..whole.start()]));
        }
        segs.push(ColoredSegment::plain(m.get(1)?.as_str())); // KEY 默认色
        segs.push(ColoredSegment::colored(
            m.get(2)?.as_str(),
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
