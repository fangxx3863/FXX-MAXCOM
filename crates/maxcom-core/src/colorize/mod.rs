//! 自动染色规则链执行引擎（COLOR-T01/T06）。
//!
//! 对一行日志**首次匹配生效**，产出带颜色标签的段（不改日志原文，只附加颜色）：
//! - 总开关 `master_enabled` 关闭 → 全部默认色（INV-2）
//! - ANSI 让位 `ansi_yield`：数据含 ANSI 序列时不插手（INV-1），交 xterm.js 渲染；
//!   日志路径剥离控制码，避免 `[31m` 泄露
//! - 优先级稳定排序：越小越先；同优先级按注册顺序（内置 bracket=1 keyword=2 kv=3 number=4，
//!   用户规则缺省 3.5 —— 排在 kv 之后、number 之前）

pub mod builtin;
pub mod palette;

use crate::ansistrip::{contains_ansi, strip_ansi};
use serde::{Deserialize, Serialize};

/// 染色段：文本 + 颜色标签（颜色名为字符串或 `#RRGGBB`，前端经 Palette/CSS 解析）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColoredSegment {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
}

impl ColoredSegment {
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            fg: None,
            bg: None,
            bold: None,
        }
    }

    pub fn colored(
        text: impl Into<String>,
        fg: Option<String>,
        bg: Option<String>,
        bold: bool,
    ) -> Self {
        Self {
            text: text.into(),
            fg,
            bg,
            bold: Some(bold),
        }
    }
}

/// 用户自定义染色规则 DTO —— 契约 `color-rule.schema.json`。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ColorRule {
    pub name: String,
    pub pattern: String,
    /// "line"（整行染色）| "match"（仅匹配部分）
    pub target: String,
    pub color: String,
    #[serde(default)]
    pub bg_color: Option<String>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 契约为整数；缺省时引擎内部取 3.5（kv=3 与 number=4 之间）
    #[serde(default)]
    pub priority: Option<f64>,
}

fn default_true() -> bool {
    true
}

/// 用户规则缺省优先级
pub const DEFAULT_USER_PRIORITY: f64 = 3.5;

enum RuleKind {
    Builtin {
        func: fn(&str) -> Option<Vec<ColoredSegment>>,
    },
    User(Box<ColorRule>, Option<regex::Regex>),
}

struct Rule {
    name: String,
    priority: f64,
    enabled: bool,
    kind: RuleKind,
}

impl Rule {
    fn process(&self, line: &str) -> Option<Vec<ColoredSegment>> {
        match &self.kind {
            RuleKind::Builtin { func } => func(line),
            RuleKind::User(rule, re) => {
                let re = re.as_ref()?;
                if rule.target == "line" {
                    re.is_match(line).then(|| {
                        vec![ColoredSegment::colored(
                            line,
                            Some(rule.color.clone()),
                            rule.bg_color.clone(),
                            rule.bold,
                        )]
                    })
                } else {
                    // match：仅匹配部分染色，其余默认色
                    let mut segs = Vec::new();
                    let mut pos = 0;
                    for m in re.find_iter(line) {
                        if m.start() > pos {
                            segs.push(ColoredSegment::plain(&line[pos..m.start()]));
                        }
                        segs.push(ColoredSegment::colored(
                            m.as_str(),
                            Some(rule.color.clone()),
                            rule.bg_color.clone(),
                            rule.bold,
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
            }
        }
    }
}

/// 规则链执行引擎。
#[derive(Default)]
pub struct ColorizeEngine {
    pub master_enabled: bool,
    pub ansi_yield: bool,
    rules: Vec<Rule>,
}

impl ColorizeEngine {
    pub fn new(with_builtins: bool) -> Self {
        let mut e = Self {
            master_enabled: true,
            ansi_yield: true,
            rules: Vec::new(),
        };
        if with_builtins {
            for (name, priority, func) in builtin::BUILTIN_RULES {
                e.rules.push(Rule {
                    name: name.to_string(),
                    priority,
                    enabled: true,
                    kind: RuleKind::Builtin { func },
                });
            }
        }
        e
    }

    /// 注册用户规则（重复同名覆盖）。
    pub fn register(&mut self, rule: ColorRule) {
        let re = regex::Regex::new(&rule.pattern).ok();
        let priority = rule.priority.unwrap_or(DEFAULT_USER_PRIORITY);
        let name = rule.name.clone();
        let enabled = rule.enabled;
        if let Some(i) = self.rules.iter().position(|r| r.name == name) {
            self.rules[i] = Rule {
                name,
                priority,
                enabled,
                kind: RuleKind::User(Box::new(rule), re),
            };
        } else {
            self.rules.push(Rule {
                name,
                priority,
                enabled,
                kind: RuleKind::User(Box::new(rule), re),
            });
        }
    }

    /// 按规则名独立开关（INV-2）。
    pub fn enable_rule(&mut self, name: &str, enabled: bool) {
        for r in &mut self.rules {
            if r.name == name {
                r.enabled = enabled;
            }
        }
    }

    pub fn reset(&mut self) {
        self.rules.clear();
    }

    /// 对一行应用规则链，返回染色段。
    pub fn process_line(&self, line: &str) -> Vec<ColoredSegment> {
        if !self.master_enabled {
            return vec![ColoredSegment::plain(line)];
        }
        if self.ansi_yield && contains_ansi(line) {
            // ANSI 让位（INV-1）：日志路径剥离控制码，交终端渲染
            return vec![ColoredSegment::plain(strip_ansi(line))];
        }
        // 稳定排序：priority 升序，同优先级按注册顺序
        let mut order: Vec<usize> = (0..self.rules.len()).collect();
        order.sort_by(|&a, &b| {
            self.rules[a]
                .priority
                .total_cmp(&self.rules[b].priority)
                .then(a.cmp(&b))
        });
        for i in order {
            let rule = &self.rules[i];
            if !rule.enabled {
                continue;
            }
            if let Some(segs) = rule.process(line) {
                return segs;
            }
        }
        vec![ColoredSegment::plain(line)]
    }
}

/// 从 TOML 加载用户染色规则（顶层 `[[rules]]`，契约 color-rule.schema.json）。
/// 文件不存在/解析失败/非法条目 → 跳过，绝不崩溃（COLOR-T05）。
pub fn load_rules(path: &std::path::Path) -> Vec<ColorRule> {
    let Ok(raw) = std::fs::read(path) else {
        return Vec::new();
    };
    let Ok(text) = std::str::from_utf8(&raw) else {
        return Vec::new();
    };
    #[derive(Deserialize)]
    struct File {
        #[serde(default)]
        rules: Vec<ColorRule>,
    }
    toml::from_str::<File>(text)
        .map(|f| f.rules)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(name: &str, pat: &str, target: &str, color: &str, priority: Option<f64>) -> ColorRule {
        ColorRule {
            name: name.into(),
            pattern: pat.into(),
            target: target.into(),
            color: color.into(),
            bg_color: None,
            bold: false,
            enabled: true,
            priority,
        }
    }

    #[test]
    fn master_off_means_default_color() {
        let mut e = ColorizeEngine::new(true);
        e.master_enabled = false;
        let segs = e.process_line("[E] boom");
        assert_eq!(segs, vec![ColoredSegment::plain("[E] boom")]);
    }

    #[test]
    fn ansi_yield_strips_and_skips_rules() {
        let e = ColorizeEngine::new(true);
        let segs = e.process_line("\x1b[31m[ERROR] red already\x1b[0m");
        // 让位：不套用染色规则，只剥离控制码
        assert_eq!(segs, vec![ColoredSegment::plain("[ERROR] red already")]);
    }

    #[test]
    fn builtin_bracket_levels() {
        let e = ColorizeEngine::new(true);
        let segs = e.process_line("[W] careful");
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].fg.as_deref(), Some("yellow"));
        let segs = e.process_line("[F] fatal");
        assert_eq!(segs[0].fg.as_deref(), Some("red"));
        assert_eq!(segs[0].bold, Some(true));
        // [I] 命中 bracket 规则但等级色为默认（fg=None），规则链到此为止
        let segs = e.process_line("[I] ok");
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, "[I] ok");
        assert_eq!(segs[0].fg, None);
        // 真正无任何规则命中的行才是整行 plain
        let segs = e.process_line("nothing special");
        assert_eq!(segs, vec![ColoredSegment::plain("nothing special")]);
    }

    #[test]
    fn builtin_kv_and_number() {
        let e = ColorizeEngine::new(true);
        let segs = e.process_line("temp: 42");
        // kv 命中：KEY（不含冒号）默认色，VALUE cyan
        assert_eq!(segs[0].text, "temp");
        assert_eq!(segs[0].fg, None);
        assert_eq!(segs[1].text, "42");
        assert_eq!(segs[1].fg.as_deref(), Some("cyan"));
        // 纯数值行：kv 不命中（无 KEY: 形态）→ number 命中
        let segs = e.process_line("3.14");
        assert_eq!(segs[0].fg.as_deref(), Some("magenta"));
    }

    #[test]
    fn user_rule_priority_insertion() {
        let mut e = ColorizeEngine::new(true);
        // 缺省 3.5：kv(3) 之后、number(4) 之前
        e.register(user("u1", "42", "match", "#FF9500", None));
        // "value 42" 无冒号 → kv 不命中；用带冒号行验证 kv 先于用户规则(3.5)
        let segs = e.process_line("temp: 42");
        assert_eq!(
            segs.iter().find(|s| s.text == "42").unwrap().fg.as_deref(),
            Some("cyan")
        );
        // priority=0 抢在 bracket 前
        e.register(user("u0", r"^\[W\]", "line", "#00FF00", Some(0.0)));
        let segs = e.process_line("[W] careful");
        assert_eq!(segs[0].fg.as_deref(), Some("#00FF00"));
    }

    #[test]
    fn user_match_target_partial_coloring() {
        let mut e = ColorizeEngine::new(true);
        e.register(user("m", r"\d+", "match", "red", Some(0.5)));
        let segs = e.process_line("abc 12 def 34");
        assert_eq!(segs.len(), 4);
        assert_eq!(segs[0].text, "abc ");
        assert_eq!(segs[1].text, "12");
        assert_eq!(segs[1].fg.as_deref(), Some("red"));
        assert_eq!(segs[2].text, " def ");
        assert_eq!(segs[3].text, "34");
        assert_eq!(segs[3].fg.as_deref(), Some("red"));
    }

    #[test]
    fn per_rule_toggle() {
        let mut e = ColorizeEngine::new(true);
        e.enable_rule("kv", false);
        let segs = e.process_line("temp: 42");
        // kv 关闭 → 落到 number：只有数值段被染 magenta，前缀默认色
        assert_eq!(segs[0].text, "temp: ");
        assert_eq!(segs[0].fg, None);
        assert_eq!(segs[1].text, "42");
        assert_eq!(segs[1].fg.as_deref(), Some("magenta"));
    }
}
