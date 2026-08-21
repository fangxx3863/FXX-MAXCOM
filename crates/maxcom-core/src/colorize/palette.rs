//! 颜色调色板（COLOR-T07）。命名色 / `#RRGGBB` → RGB，暗/亮主题适配。
//! 纯数据；渲染层（前端）负责转 CSS。数据表与 Python 版 sgr.BASIC_COLORS 一致。

/// ANSI 16 色 RGB 表
pub const BASIC_COLORS: [(u8, u8, u8); 16] = [
    (0x00, 0x00, 0x00), // black
    (0xCC, 0x00, 0x00), // red
    (0x00, 0xCC, 0x00), // green
    (0xCC, 0xCC, 0x00), // yellow
    (0x00, 0x00, 0xCC), // blue
    (0xCC, 0x00, 0xCC), // magenta
    (0x00, 0xCC, 0xCC), // cyan
    (0xCC, 0xCC, 0xCC), // white
    (0x66, 0x66, 0x66), // gray
    (0xFF, 0x33, 0x33), // bright_red
    (0x33, 0xFF, 0x33), // bright_green
    (0xFF, 0xFF, 0x33), // bright_yellow
    (0x33, 0x33, 0xFF), // bright_blue
    (0xFF, 0x33, 0xFF), // bright_magenta
    (0x33, 0xFF, 0xFF), // bright_cyan
    (0xFF, 0xFF, 0xFF), // bright_white
];

/// colorize 层使用的命名色 → BASIC_COLORS 索引
pub const NAMED: [(&str, usize); 16] = [
    ("black", 0),
    ("red", 1),
    ("green", 2),
    ("yellow", 3),
    ("blue", 4),
    ("magenta", 5),
    ("cyan", 6),
    ("white", 7),
    ("gray", 8),
    ("bright_red", 9),
    ("bright_green", 10),
    ("bright_yellow", 11),
    ("bright_blue", 12),
    ("bright_magenta", 13),
    ("bright_cyan", 14),
    ("bright_white", 15),
];

/// 主题（暗底亮字 / 亮底深字）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Theme {
    #[default]
    Dark,
    Light,
}

#[derive(Debug, Clone, Copy)]
pub struct Palette {
    pub theme: Theme,
}

impl Default for Palette {
    fn default() -> Self {
        Self { theme: Theme::Dark }
    }
}

impl Palette {
    /// `#RRGGBB` / 命名色 → RGB；None 或未知 → 主题默认前景。
    pub fn resolve(&self, color: Option<&str>) -> (u8, u8, u8) {
        let Some(c) = color else {
            return self.default_fg();
        };
        if let Some(rgb) = parse_hex(c) {
            return rgb;
        }
        if let Some((_, idx)) = NAMED.iter().find(|(n, _)| *n == c) {
            return BASIC_COLORS[*idx];
        }
        self.default_fg()
    }

    /// 等级色：暗底亮字、亮底深字。未知等级回退默认前景。
    pub fn level_color(&self, level: &str) -> (u8, u8, u8) {
        match level.to_ascii_uppercase().as_str() {
            "E" | "ERROR" | "ERR" | "F" | "FATAL" | "CRITICAL" => {
                if self.theme == Theme::Dark {
                    BASIC_COLORS[9]
                } else {
                    BASIC_COLORS[1]
                }
            }
            "W" | "WARN" | "WARNING" => {
                if self.theme == Theme::Dark {
                    BASIC_COLORS[11]
                } else {
                    BASIC_COLORS[3]
                }
            }
            "D" | "DEBUG" => BASIC_COLORS[8],
            _ => self.default_fg(),
        }
    }

    pub fn default_fg(&self) -> (u8, u8, u8) {
        if self.theme == Theme::Dark {
            (220, 220, 224)
        } else {
            (32, 32, 32)
        }
    }
}

/// `#RRGGBB` / `RRGGBB` → RGB；非法返回 None。
pub fn parse_hex(color: &str) -> Option<(u8, u8, u8)> {
    let h = color.strip_prefix('#').unwrap_or(color);
    if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let r = u8::from_str_radix(&h[0..2], 16).ok()?;
    let g = u8::from_str_radix(&h[2..4], 16).ok()?;
    let b = u8::from_str_radix(&h[4..6], 16).ok()?;
    Some((r, g, b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_and_named_and_fallback() {
        let p = Palette { theme: Theme::Dark };
        assert_eq!(p.resolve(Some("#FF9500")), (0xFF, 0x95, 0x00));
        assert_eq!(p.resolve(Some("FF9500")), (0xFF, 0x95, 0x00));
        assert_eq!(p.resolve(Some("cyan")), (0x00, 0xCC, 0xCC));
        assert_eq!(p.resolve(Some("unknown-name")), p.default_fg());
        assert_eq!(p.resolve(None), p.default_fg());
        assert_eq!(parse_hex("#12345"), None);
        assert_eq!(parse_hex("#GGHHII"), None);
    }

    #[test]
    fn level_colors_by_theme() {
        let dark = Palette { theme: Theme::Dark };
        let light = Palette {
            theme: Theme::Light,
        };
        assert_eq!(dark.level_color("E"), BASIC_COLORS[9]);
        assert_eq!(light.level_color("E"), BASIC_COLORS[1]);
        assert_eq!(dark.level_color("I"), dark.default_fg());
    }
}
