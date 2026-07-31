"""MAXCOM 入口。

启动 DPG 主窗口（T0-T07）。
"""

from __future__ import annotations

from app.app_context import AppContext
from app.config import ConfigManager, default_config_dir
from ui.main_window import MainWindow


def main() -> None:
    app_context = AppContext()
    app_context.config = ConfigManager(default_config_dir() / "config.toml")
    MainWindow(app_context).run()


if __name__ == "__main__":
    main()
