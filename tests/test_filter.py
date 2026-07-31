"""过滤引擎模块测试（FLT-T01/T02 DoD 全覆盖）。

引擎/加载器纯逻辑 headless 可测。FLT-T03（落盘策略）待 O2 定案，未实现。
"""

from __future__ import annotations

from pathlib import Path

from app.models.filter_rule import FilterRule
from core.filter.engine import FilterEngine
from core.filter.loader import load_rules


def _hide(name: str, pattern: str, enabled: bool = True) -> FilterRule:
    return FilterRule(name=name, pattern=pattern, action="hide", enabled=enabled)


def _show(name: str, pattern: str, enabled: bool = True) -> FilterRule:
    return FilterRule(name=name, pattern=pattern, action="show", enabled=enabled)


# ---------- FLT-T01: 过滤引擎 ----------


def test_hide_rule_hides_matching() -> None:
    eng = FilterEngine()
    eng.add_rule(_hide("debug", r"DEBUG"))
    assert not eng.should_show("[DEBUG] noise")
    assert eng.should_show("[INFO] hello")  # 不匹配，显示


def test_show_whitelist_priority() -> None:
    eng = FilterEngine()
    eng.add_rule(_show("keep", r"important"))  # show 放前 = 白名单优先
    eng.add_rule(_hide("spam", r"spam"))
    assert eng.should_show("important spam")  # show 白名单优先显示
    assert not eng.should_show("spam message")  # 非白名单 → hide 隐藏


def test_first_rule_wins() -> None:
    eng = FilterEngine()
    eng.add_rule(_hide("a", r"xyz"))
    eng.add_rule(_show("b", r"xyz"))
    assert not eng.should_show("xyz")  # 首个 hide 生效


def test_default_show_when_no_match() -> None:
    eng = FilterEngine()
    eng.add_rule(_hide("debug", r"DEBUG"))
    assert eng.should_show("hello world")


def test_empty_engine_shows_all() -> None:
    eng = FilterEngine()
    assert eng.should_show("anything")


def test_disabled_rule_skipped() -> None:
    eng = FilterEngine()
    eng.add_rule(_hide("debug", r"DEBUG", enabled=False))
    assert eng.should_show("[DEBUG] ok")  # 禁用的 hide 不生效


def test_compiled_regex() -> None:
    eng = FilterEngine()
    eng.add_rule(_hide("temp", r"temp=\d+"))
    assert not eng.should_show("temp=42")
    assert eng.should_show("temp=abc")  # 正则不匹配


def test_reset_clears_rules() -> None:
    eng = FilterEngine()
    eng.add_rule(_hide("debug", r"DEBUG"))
    eng.reset()
    assert eng.should_show("[DEBUG] x")


def test_invalid_pattern_never_matches() -> None:
    eng = FilterEngine()
    eng.add_rule(_hide("bad", r"("))  # 非法正则
    assert eng.should_show("any line")  # 不崩溃，永不匹配


def test_same_name_rule_replaces() -> None:
    eng = FilterEngine()
    eng.add_rule(_hide("x", r"alpha"))
    assert not eng.should_show("alpha")
    eng.add_rule(_show("x", r"alpha"))  # 同名覆盖为 show
    assert eng.should_show("alpha")


# ---------- FLT-T02: 规则加载 + 独立开关 ----------


def test_load_rules_valid(tmp_path: Path) -> None:
    f = tmp_path / "filters.toml"
    f.write_text(
        '[[rules]]\nname = "debug"\npattern = "DEBUG"\naction = "hide"\nenabled = true\n',
        encoding="utf-8",
    )
    rules = load_rules(f)
    assert len(rules) == 1
    assert rules[0].name == "debug"
    assert rules[0].action == "hide"
    assert rules[0].enabled


def test_load_rules_invalid_skipped(tmp_path: Path) -> None:
    f = tmp_path / "filters.toml"
    f.write_text(
        "[[rules]]\n"
        'name = "bad"\n'
        'pattern = "x"\n'
        'action = "nope"\n'  # action 非法 → 校验失败
        "enabled = true\n",
        encoding="utf-8",
    )
    assert load_rules(f) == []


def test_load_rules_missing_file(tmp_path: Path) -> None:
    assert load_rules(tmp_path / "nope.toml") == []


def test_load_rules_bad_toml(tmp_path: Path) -> None:
    f = tmp_path / "bad.toml"
    f.write_text("[[rules\n", encoding="utf-8")
    assert load_rules(f) == []


def test_loaded_rules_applied_and_toggle(tmp_path: Path) -> None:
    f = tmp_path / "filters.toml"
    f.write_text(
        '[[rules]]\nname = "debug"\npattern = "DEBUG"\naction = "hide"\nenabled = true\n',
        encoding="utf-8",
    )
    eng = FilterEngine()
    for rule in load_rules(f):
        eng.add_rule(rule)
    assert not eng.should_show("[DEBUG] x")
    eng.set_enabled("debug", False)  # 独立开关
    assert eng.should_show("[DEBUG] x")


def test_rules_changes_take_effect_immediately(tmp_path: Path) -> None:
    f = tmp_path / "filters.toml"
    f.write_text(
        '[[rules]]\nname = "debug"\npattern = "DEBUG"\naction = "hide"\nenabled = true\n',
        encoding="utf-8",
    )
    eng = FilterEngine()
    for rule in load_rules(f):
        eng.add_rule(rule)
    # 重新加载（文件内容变化）后同名覆盖 → 实时生效，不重启
    f.write_text(
        '[[rules]]\nname = "debug"\npattern = "DEBUG"\naction = "show"\nenabled = true\n',
        encoding="utf-8",
    )
    for rule in load_rules(f):
        eng.add_rule(rule)
    assert eng.should_show("[DEBUG] x")  # 已改为 show
