//! 日志行过滤引擎（FLT-T01/T02）。
//!
//! 多规则链：默认显示；`hide` 规则匹配 → 隐藏；`show` 规则命中 → 强制显示（白名单）。
//! 按注册顺序扫描，**首个生效规则决定结果**；全部不匹配 → 显示。
//! 正则预编译（库：`regex`）；编译失败 → 该规则永不匹配并跳过。
//! 只做显示判定，不改原始流（INV-3，ADR-0015）。

use serde::{Deserialize, Serialize};

/// 过滤规则 DTO —— 契约 `filter-rule.schema.json`（R6：字段以此为准，勿臆造）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FilterRule {
    pub name: String,
    pub pattern: String,
    /// "show" | "hide"
    pub action: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone)]
struct CompiledRule {
    action: String,
    matcher: Option<regex::Regex>, // None = 正则非法，永不匹配
    enabled: bool,
}

/// 过滤规则链。规则按名覆盖更新（同名替换），支持独立开关热切换。
#[derive(Debug, Default)]
pub struct FilterEngine {
    names: Vec<String>,
    rules: Vec<CompiledRule>,
}

impl FilterEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// 添加/覆盖规则（重复同名覆盖）。
    pub fn add_rule(&mut self, rule: &FilterRule) {
        let compiled = CompiledRule {
            action: rule.action.clone(),
            matcher: regex::Regex::new(&rule.pattern).ok(),
            enabled: rule.enabled,
        };
        if let Some(i) = self.names.iter().position(|n| *n == rule.name) {
            self.rules[i] = compiled;
        } else {
            self.names.push(rule.name.clone());
            self.rules.push(compiled);
        }
    }

    pub fn set_enabled(&mut self, name: &str, enabled: bool) {
        if let Some(i) = self.names.iter().position(|n| n == name) {
            self.rules[i].enabled = enabled;
        }
    }

    /// 判定一行是否显示（首个生效规则决定；无规则/全不匹配 → true）。
    pub fn should_show(&self, line: &str) -> bool {
        for r in &self.rules {
            if !r.enabled {
                continue;
            }
            let Some(re) = &r.matcher else { continue };
            if re.is_match(line) {
                return r.action == "show";
            }
        }
        true
    }

    pub fn reset(&mut self) {
        self.names.clear();
        self.rules.clear();
    }

    pub fn len(&self) -> usize {
        self.names.len()
    }

    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }
}

/// 从 TOML 加载过滤规则（顶层 `[[rules]]`，契约 filter-rule.schema.json）。
/// 文件不存在/解析失败/非法条目 → 跳过该条，绝不崩溃（FLT-T02）。
pub fn load_rules(path: &std::path::Path) -> Vec<FilterRule> {
    let Ok(raw) = std::fs::read(path) else {
        return Vec::new();
    };
    let Ok(text) = std::str::from_utf8(&raw) else {
        return Vec::new();
    };
    #[derive(Deserialize)]
    struct File {
        #[serde(default)]
        rules: Vec<toml::Table>,
    }
    let Ok(file) = toml::from_str::<File>(text) else {
        return Vec::new();
    };
    file.rules
        .into_iter()
        .filter_map(|t| {
            // 缺必填字段/类型不对 → 跳过（对齐 Python 版"非法条目跳过并记录"）
            Some(FilterRule {
                name: t.get("name")?.as_str()?.to_string(),
                pattern: t.get("pattern")?.as_str()?.to_string(),
                action: t.get("action")?.as_str()?.to_string(),
                enabled: t
                    .get("enabled")
                    .and_then(toml::Value::as_bool)
                    .unwrap_or(true),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(name: &str, pat: &str, action: &str) -> FilterRule {
        FilterRule {
            name: name.into(),
            pattern: pat.into(),
            action: action.into(),
            enabled: true,
        }
    }

    #[test]
    fn hide_first_match_wins() {
        let mut f = FilterEngine::new();
        f.add_rule(&rule("h1", "spam", "hide"));
        f.add_rule(&rule("s1", "urgent", "show"));
        assert!(!f.should_show("this is spam"));
        // 首个生效规则决定结果：hide(h1) 注册在前且命中 → 隐藏，show 不再有机会
        assert!(!f.should_show("URGENT: spam"));
        assert!(f.should_show("hello"));
    }

    #[test]
    fn show_whitelist_semantics() {
        let mut f = FilterEngine::new();
        // 只有 show 规则时：非匹配行仍默认显示（show 仅强制，不隐藏）
        f.add_rule(&rule("s", "keep", "show"));
        assert!(f.should_show("other line"));
        assert!(f.should_show("please keep me"));
    }

    #[test]
    fn same_name_overwrites() {
        let mut f = FilterEngine::new();
        f.add_rule(&rule("a", "x", "hide"));
        f.add_rule(&rule("a", "y", "hide"));
        assert_eq!(f.len(), 1);
        assert!(!f.should_show("yyy"));
        assert!(f.should_show("xxx"));
    }

    #[test]
    fn per_rule_toggle() {
        let mut f = FilterEngine::new();
        f.add_rule(&rule("a", "noise", "hide"));
        f.set_enabled("a", false);
        assert!(f.should_show("noise here"));
        f.set_enabled("a", true);
        assert!(!f.should_show("noise here"));
    }

    #[test]
    fn invalid_regex_never_matches() {
        let mut f = FilterEngine::new();
        f.add_rule(&rule("bad", "([unclosed", "hide"));
        assert!(f.should_show("anything ([unclosed"));
    }
}

#[cfg(test)]
mod loader_tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn loads_toml_and_skips_bad_entries() {
        let mut f = std::env::temp_dir();
        f.push("maxcom_filter_test.toml");
        let mut file = std::fs::File::create(&f).unwrap();
        writeln!(
            file,
            r#"
[[rules]]
name = "hide-hb"
pattern = "HEARTBEAT"
action = "hide"

[[rules]]
name = "bad"        # 缺 pattern → 跳过
action = "show"

[[rules]]
name = "show-err"
pattern = "ERROR"
action = "show"
enabled = false
"#
        )
        .unwrap();
        let rules = load_rules(&f);
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].name, "hide-hb");
        assert!(!rules[1].enabled);
        std::fs::remove_file(&f).ok();
    }

    #[test]
    fn missing_file_is_empty() {
        assert!(load_rules(std::path::Path::new("/nonexistent/x.toml")).is_empty());
    }
}
