"""演示/验收用数据源（M1）。

定时向 EventBus publish_raw 模拟板卡输出：终端模式 ANSI 彩色文本 + 传统模式日志。
真实串口/TCP 连接由 M3 transport 模块实现（TP-T01..08）。连接切换时连接不断（ADR-0016）。
"""

from __future__ import annotations

import threading
import time

from core.pipeline.event_bus import EventBus

# ANSI 彩色演示文本（板卡模拟器输出）
DEMO_TERM_LINES = [
    b"\x1b[32mWelcome to MAXCOM Demo Board\x1b[0m\r\n",
    b"\x1b[36mroot@board:~$ \x1b[0m",
    b"ls\r\n\x1b[35mbin\x1b[0m  \x1b[34mdev\x1b[0m  \x1b[34mproc\x1b[0m  \x1b[34mvar\x1b[0m\r\n",
    b"\x1b[36mroot@board:~$ \x1b[0m",
    b"\x1b[33m[W]\x1b[0m temperature high\r\n",
    b"\x1b[31m[E]\x1b[0m timeout waiting ack\r\n",
]

# 传统日志演示（无 ANSI，自动染色规则接管）
DEMO_LOG_LINES = [
    b"[I] system boot ok\r\n",
    b"[D] init uart0 done\r\n",
    b"[W] voltage low: 3.1\r\n",
    b"[E] crc error at addr=0x1F\r\n",
    b"[I] heartbeart cnt=42\r\n",
    b"temp: 85.3 status: ok\r\n",
]


class MockSource:
    """演示数据源：后台线程定时向总线发布模拟数据。"""

    def __init__(self, bus: EventBus, interval_s: float = 0.8) -> None:
        self._bus = bus
        self._interval = interval_s
        self._running = False
        self._thread: threading.Thread | None = None
        self._term_i = 0
        self._log_i = 0

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True, name="mock-source")
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        if self._thread is not None:
            self._thread.join(timeout=1)
            self._thread = None

    def _run(self) -> None:
        while self._running:
            # 交替发终端彩色文本与日志行
            if self._term_i < len(DEMO_TERM_LINES):
                self._bus.publish_raw(DEMO_TERM_LINES[self._term_i])
                self._term_i += 1
            elif self._log_i < len(DEMO_LOG_LINES):
                self._bus.publish_raw(DEMO_LOG_LINES[self._log_i])
                self._log_i += 1
            else:
                # 循环
                self._term_i = 0
                self._log_i = 0
            time.sleep(self._interval)
