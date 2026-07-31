"""全局配置管理测试（T0-T06 DoD）。"""

import tomllib
from pathlib import Path

from app.config import ConfigManager
from app.models.global_config import GlobalConfig


def test_missing_file_returns_defaults(tmp_path: Path) -> None:
    cfg = ConfigManager(tmp_path / "config.toml").load()
    assert cfg.theme == "dark"
    assert cfg.language == "zh_CN"


def test_save_creates_file(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    mgr = ConfigManager(path)
    cfg = GlobalConfig(theme="light", recent_projects=["C:/a.maxcomprj"])
    mgr.save(cfg)

    assert path.exists()
    raw = tomllib.loads(path.read_text(encoding="utf-8"))
    assert raw["theme"] == "light"
    assert raw["recent_projects"] == ["C:/a.maxcomprj"]


def test_roundtrip_preserves_values(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    mgr = ConfigManager(path)
    mgr.save(GlobalConfig(theme="light", default_encoding="gbk", port_alias={"COM3": "主板"}))

    loaded = ConfigManager(path).load()
    assert loaded.theme == "light"
    assert loaded.default_encoding == "gbk"
    assert loaded.port_alias == {"COM3": "主板"}


def test_corrupted_file_falls_back_to_defaults(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text("not valid toml [[[", encoding="utf-8")

    cfg = ConfigManager(path).load()
    assert cfg.theme == "dark"


def test_invalid_values_fall_back_to_defaults(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text('theme = "neon"\n', encoding="utf-8")  # 非合法枚举

    cfg = ConfigManager(path).load()
    assert cfg.theme == "dark"


def test_atomic_write_no_tmp_leftover(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    mgr = ConfigManager(path)
    mgr.save(GlobalConfig())

    # 写完后无 .tmp 残留
    assert not list(tmp_path.glob("*.tmp"))
    assert path.exists()


def test_save_overwrites_previous(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    mgr = ConfigManager(path)
    mgr.save(GlobalConfig(theme="dark"))
    mgr.save(GlobalConfig(theme="light"))

    assert ConfigManager(path).load().theme == "light"


def test_creates_parent_dirs(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "dir" / "config.toml"
    ConfigManager(path).save(GlobalConfig())
    assert path.exists()


def test_path_property(tmp_path: Path) -> None:
    mgr = ConfigManager(tmp_path / "c.toml")
    assert mgr.path == tmp_path / "c.toml"


def test_default_config_dir_uses_appdata(monkeypatch, tmp_path: Path) -> None:
    from app.config import default_config_dir

    monkeypatch.setenv("APPDATA", str(tmp_path))
    assert default_config_dir() == tmp_path / "MAXCOM"
