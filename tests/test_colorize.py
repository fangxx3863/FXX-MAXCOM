"""自动染色模块测试（COLOR-T01..T07 DoD 全覆盖）。

引擎/builtin/palette 纯逻辑 headless 可测；loader 用临时 TOML 文件。
"""

from __future__ import annotations

from pathlib import Path

from app.models.color_rule import ColorRule
from core.colorize.builtin_rules import (
    bracket_rule,
    keyword_rule,
    kv_rule,
    number_rule,
)
from core.colorize.engine import ColoredSegment, ColorizeEngine, contains_ansi
from core.colorize.loader import load_rules, register_user_rule
from core.colorize.palette import Palette


def _assert_segments(
    segs: list[ColoredSegment], expect: list[tuple[str, str | None, bool]]
) -> None:
    """断言分段 (text, fg, bold) 序列完全一致。"""
    got = [(s.text, s.fg, s.bold) for s in segs]
    assert got == expect, f"got {got!r} want {expect!r}"


# ---------- COLOR-T02: 等级括号 ----------


def test_bracket_each_level() -> None:
    cases = {
        "[D] booting": ("gray", False),
        "[I] ready": (None, False),
        "[W] voltage low": ("yellow", False),
        "[E] timeout": ("red", False),
        "[F] fatal crash": ("red", True),
        "[DEBUG] x": ("gray", False),
        "[INFO] x": (None, False),
        "[WARN] x": ("yellow", False),
        "[WARNING] x": ("yellow", False),
        "[ERROR] x": ("red", False),
        "[ERR] x": ("red", False),
        "[FATAL] x": ("red", True),
        "[CRITICAL] x": ("red", True),
    }
    for line, (color, bold) in cases.items():
        seg = bracket_rule(line)
        assert seg is not None, line
        assert seg.text == line
        assert seg.fg == color, line
        assert seg.bold is bold, line


def test_bracket_whitespace_and_case() -> None:
    assert bracket_rule("   [w] hi").fg == "yellow"  # 行首空白 + 小写
    assert bracket_rule("   [info] x").fg is None  # 小写 INFO
    assert bracket_rule("[D] x") is not None
    assert bracket_rule("[DX] x") is None  # 非等级
    assert bracket_rule("no bracket") is None
    assert bracket_rule("[x] no") is None


def test_bracket_not_mid_line() -> None:
    assert bracket_rule("prefix [W] x") is None  # 仅行首锚定


# ---------- COLOR-T03: 等级关键词 ----------


def test_keyword_each_level() -> None:
    cases = {
        "DEBUG: detail": ("gray", False),
        "INFO: start": (None, False),
        "WARN: voltage": ("yellow", False),
        "WARNING: overheat": ("yellow", False),
        "ERROR: lost": ("red", False),
        "ERR: bad": ("red", False),
        "FATAL: die": ("red", True),
        "CRITICAL: melt": ("red", True),
    }
    for line, (color, _bold) in cases.items():
        seg = keyword_rule(line)
        assert seg is not None, line
        assert seg.fg == color, line


def test_keyword_angle_and_single() -> None:
    assert keyword_rule("<E> exception").fg == "red"
    assert keyword_rule("E: temp high").fg == "red"  # 单字母 + 冒号
    assert keyword_rule("W: warn").fg == "yellow"
    assert keyword_rule(" D  boot") is not None  # 空白分隔
    assert keyword_rule("I: idle").fg is None


def test_keyword_no_midword_false_positive() -> None:
    assert keyword_rule("handler error found") is None  # 非行首等级前缀
    assert keyword_rule("loading module") is None
    assert keyword_rule("normal text here") is None
    # 单字母等级 D/I 不得误匹配普通单词（D 后须有分隔符）
    assert keyword_rule("Device ready") is None
    assert keyword_rule("Data received") is None
    assert keyword_rule("Iron 42") is None


# ---------- COLOR-T04: 键值对 + 数值 ----------


def test_kv_single_pair() -> None:
    assert kv_rule("temp=45") is None  # 无冒号，不匹配
    segs = kv_rule("temp: 45")
    _assert_segments(segs, [("temp", None, False), ("45", "cyan", False)])


def test_kv_multi_pair() -> None:
    segs = kv_rule("voltage: 3.3 current: 0.5")
    _assert_segments(
        segs,
        [
            ("voltage", None, False),
            ("3.3", "cyan", False),
            (" ", None, False),
            ("current", None, False),
            ("0.5", "cyan", False),
        ],
    )


def test_kv_hex_value() -> None:
    segs = kv_rule("status: 0x1F")
    assert segs[1].fg == "cyan"
    assert segs[1].text == "0x1F"


def test_kv_no_match() -> None:
    assert kv_rule("just plain words") is None
    assert kv_rule("no-colon here") is None


def test_number_highlight() -> None:
    segs = number_rule("count=42 ratio=0.5 hex=0x1F")
    colored = [(s.text, s.fg) for s in segs if s.fg is not None]
    assert colored == [("42", "magenta"), ("0.5", "magenta"), ("0x1F", "magenta")]


def test_number_hex_float_int() -> None:
    assert number_rule("0x1F")[0].text == "0x1F"
    assert number_rule("3.14")[0].text == "3.14"
    assert number_rule("42")[0].text == "42"


def test_number_no_match() -> None:
    assert number_rule("abc") is None
    assert number_rule("") is None


# ---------- COLOR-T01: 规则链引擎 ----------


def test_priority_first_match() -> None:
    eng = ColorizeEngine()
    segs = eng.process_line("[W] voltage: 3.3")
    # 等级括号(1) 先命中 → 整行黄，kv/number 不覆盖
    assert segs == [ColoredSegment("[W] voltage: 3.3", "yellow", None, False)]


def test_engine_falls_through_to_kv() -> None:
    eng = ColorizeEngine()
    segs = eng.process_line("voltage: 3.3")
    assert any(s.fg == "cyan" for s in segs)  # kv=3 命中


def test_engine_falls_through_to_number() -> None:
    eng = ColorizeEngine()
    segs = eng.process_line("count=42")
    assert any(s.fg == "magenta" for s in segs)  # number=4 命中


def test_no_match_default_color() -> None:
    eng = ColorizeEngine()
    assert eng.process_line("plain text here") == [ColoredSegment("plain text here", None)]


def test_target_match_partial_colors() -> None:
    eng = ColorizeEngine(with_builtins=False)
    eng.register(ColorRule(name="usb", pattern=r"\bUSB\b", target="match", color="#FF9500"))
    segs = eng.process_line("device USB plugged")
    _assert_segments(
        segs,
        [("device ", None, False), ("USB", "#FF9500", False), (" plugged", None, False)],
    )


def test_target_line_whole_colors() -> None:
    eng = ColorizeEngine(with_builtins=False)
    eng.register(ColorRule(name="boot", pattern=r"^boot", target="line", color="green"))
    segs = eng.process_line("booting system")
    assert segs == [ColoredSegment("booting system", "green", None, False)]


def test_reset_clears_rules() -> None:
    eng = ColorizeEngine()
    eng.reset()
    assert eng.process_line("[W] x") == [ColoredSegment("[W] x", None)]


def test_user_priority_before_number() -> None:
    eng = ColorizeEngine()
    eng.register(ColorRule(name="custom", pattern=r"\b\d+\s*ms\b", target="match", color="#FF9500"))
    segs = eng.process_line("elapsed 42 ms")
    # 用户规则 priority 缺省 3.5 < number(4)：42 ms 整体橙色，而非只染 42
    _assert_segments(segs, [("elapsed ", None, False), ("42 ms", "#FF9500", False)])


# ---------- COLOR-T05: 用户规则加载 ----------


def test_load_rules_valid(tmp_path: Path) -> None:
    f = tmp_path / "color_rules.toml"
    f.write_text(
        "[[rules]]\n"
        'name = "usb"\n'
        'pattern = "\\\\bUSB\\\\b"\n'
        'target = "match"\n'
        'color = "#FF9500"\n'
        "bold = true\n"
        "priority = 0\n",
        encoding="utf-8",
    )
    rules = load_rules(f)
    assert len(rules) == 1
    assert rules[0].name == "usb"
    assert rules[0].priority == 0
    assert rules[0].bold


def test_load_rules_invalid_skipped(tmp_path: Path) -> None:
    f = tmp_path / "color_rules.toml"
    f.write_text(
        "[[rules]]\n"
        'name = "bad"\n'
        'pattern = "x"\n'
        'target = "nope"\n'  # target 非法 → 校验失败
        'color = "red"\n',
        encoding="utf-8",
    )
    assert load_rules(f) == []


def test_load_rules_missing_file(tmp_path: Path) -> None:
    assert load_rules(tmp_path / "nope.toml") == []


def test_load_rules_bad_toml(tmp_path: Path) -> None:
    f = tmp_path / "bad.toml"
    f.write_text("[[rules\n", encoding="utf-8")
    assert load_rules(f) == []


def test_register_user_rule_and_toggle(tmp_path: Path) -> None:
    f = tmp_path / "color_rules.toml"
    f.write_text(
        '[[rules]]\nname = "usb"\npattern = "USB"\ntarget = "match"\ncolor = "yellow"\n',
        encoding="utf-8",
    )
    eng = ColorizeEngine(with_builtins=False)
    for rule in load_rules(f):
        register_user_rule(eng, rule)
    assert any(s.fg == "yellow" for s in eng.process_line("device USB"))
    eng.enable_rule("usb", False)  # 独立开关
    assert eng.process_line("device USB") == [ColoredSegment("device USB", None)]


def test_user_priority_inserts_before_builtin() -> None:
    eng = ColorizeEngine()
    eng.register(
        ColorRule(name="hot", pattern=r"temperature", target="line", color="red", priority=0)
    )
    segs = eng.process_line("temperature 42")
    assert segs[0].fg == "red"  # priority=0 < level=1，抢在等级规则前


# ---------- COLOR-T06: ANSI 让位 + 总开关 ----------


def test_contains_ansi() -> None:
    assert contains_ansi("\x1b[31mred")
    assert not contains_ansi("plain text")


def test_ansi_yield() -> None:
    eng = ColorizeEngine()
    segs = eng.process_line("\x1b[31m[W] colored\x1b[0m")
    # 含 ANSI → 让位，默认色，不染色
    assert segs == [ColoredSegment("\x1b[31m[W] colored\x1b[0m", None)]


def test_ansi_yield_disabled() -> None:
    eng = ColorizeEngine()
    eng.ansi_yield = False
    # ESC 前缀行让位关闭后强制应用规则：括号/关键词锚定行首不命中，落到数值规则染色
    segs = eng.process_line("\x1b[31m[W] x\x1b[0m")
    assert any(s.fg == "magenta" for s in segs)  # 数字 31/0 被染色
    assert not (len(segs) == 1 and segs[0].fg is None)  # 不是全默认色


def test_master_switch_off() -> None:
    eng = ColorizeEngine()
    eng.master_enabled = False
    segs = eng.process_line("[W] x")
    assert segs == [ColoredSegment("[W] x", None)]


def test_master_switch_overrides_ansi_yield() -> None:
    eng = ColorizeEngine()
    eng.master_enabled = False
    eng.ansi_yield = False
    segs = eng.process_line("\x1b[31m[E] x\x1b[0m")
    assert segs == [ColoredSegment("\x1b[31m[E] x\x1b[0m", None)]


# ---------- COLOR-T07: 调色板 ----------


def test_palette_named_and_hex() -> None:
    p = Palette("dark")
    assert p.resolve("red") == (0xCC, 0x00, 0x00)
    assert p.resolve("#FF9500") == (0xFF, 0x95, 0x00)
    assert p.resolve("ff9500") == (0xFF, 0x95, 0x00)  # 无 # 前缀
    assert p.resolve(None) == p.default_fg()


def test_palette_unknown_fallback() -> None:
    p = Palette("dark")
    assert p.resolve("nonsense") == p.default_fg()
    assert p.resolve("not-a-color") == p.default_fg()


def test_palette_level_dark() -> None:
    p = Palette("dark")
    assert p.level_color("E") == (0xFF, 0x33, 0x33)
    assert p.level_color("W") == (0xFF, 0xFF, 0x33)
    assert p.level_color("D") == (0x66, 0x66, 0x66)
    assert p.level_color("I") == p.default_fg()
    assert p.level_color("F") == (0xFF, 0x33, 0x33)


def test_palette_level_light() -> None:
    p = Palette("light")
    assert p.level_color("ERROR") == (0xCC, 0x00, 0x00)  # 亮底深字
    assert p.level_color("WARN") == (0xCC, 0xCC, 0x00)
    assert p.level_color("D") == (0x66, 0x66, 0x66)
    assert p.level_color("INFO") == p.default_fg()


def test_palette_unknown_level() -> None:
    p = Palette("dark")
    assert p.level_color("?") == p.default_fg()
