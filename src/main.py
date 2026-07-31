"""MAXCOM 入口。

启动 DPG 主窗口（T0-T07）。M1：附加演示数据源（验收/调试用，真实串口在 M3）。
"""

from __future__ import annotations

from app.app_context import AppContext
from app.config import ConfigManager, default_config_dir
from app.demo_source import MockSource
from ui.main_window import MainWindow


def main() -> None:
    app_context = AppContext()
    app_context.config = ConfigManager(default_config_dir() / "config.toml")
    # M1 演示数据源：向总线发布模拟板卡输出（终端彩色 + 日志行）。M3 transport 接入后移除。
    demo = MockSource(app_context.event_bus)
    demo.start()
    try:
        MainWindow(app_context).run()
    finally:
        demo.stop()


if __name__ == "__main__":
    main()
