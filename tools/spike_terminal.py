"""DPG 终端渲染 spike（T0-T08 / ADR-0017 开工前置验证）。

用 DPG 验证能否当好"终端渲染器"：
  1. 性能：逐行 draw_text 渲染 50x100 彩色终端，headless 模式测帧率
  2. CJK 对齐：中文半宽/全宽混排的列对齐
  3. 框线覆盖：更纱黑体/微软雅黑框线字符 + 终端符号
  4. 结论写入 ADR-0017

用法：
  python tools/spike_terminal.py --bench     # headless 渲染 N 帧测帧率
  python tools/spike_terminal.py --align     # 验证 CJK 列对齐
  python tools/spike_terminal.py --gui       # 打开真实窗口（需显示环境）
"""

from __future__ import annotations

import argparse
import io
import sys
import time
from pathlib import Path

# Windows 控制台默认 GBK，统一 UTF-8 输出避免编码错误。
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import dearpygui.dearpygui as dpg  # noqa: E402

ROWS = 50
COLS = 100
FONT_SIZE = 16

# 等宽 + CJK：Consolas 做等宽主体，微软雅黑覆盖 CJK/框线/终端符号
MONO_FONT = "C:/Windows/Fonts/consola.ttf"
CJK_FONT = "C:/Windows/Fonts/msyh.ttc"

# 终端常用框线 + 符号（检测缺字）
BOX_CHARS = "─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬"
TERM_SYMBOLS = "⌘⌥⏎▲▼▶◀●○■□◆◇☰☱☲☳☴☵☶☷"

# ANSI 16 色
PALETTE = [
    (0x00, 0x00, 0x00),
    (0xCC, 0x00, 0x00),
    (0x00, 0xCC, 0x00),
    (0xCC, 0xCC, 0x00),
    (0x00, 0x00, 0xCC),
    (0xCC, 0x00, 0xCC),
    (0x00, 0xCC, 0xCC),
    (0xCC, 0xCC, 0xCC),
    (0x66, 0x66, 0x66),
    (0xFF, 0x33, 0x33),
    (0x33, 0xFF, 0x33),
    (0xFF, 0xFF, 0x33),
    (0x33, 0x33, 0xFF),
    (0xFF, 0x33, 0xFF),
    (0x33, 0xFF, 0xFF),
    (0xFF, 0xFF, 0xFF),
]


def build_fonts() -> None:
    with dpg.font_registry():
        with dpg.font(MONO_FONT, FONT_SIZE) as mono_font:
            dpg.bind_font(mono_font)
        # CJK/框线字体单独加载供范围覆盖检查（更纱黑体缺则微软雅黑）
        with dpg.font(CJK_FONT, FONT_SIZE):
            pass


def display_width(ch: str) -> int:
    """终端列宽：全宽字符（CJK/框线/全角符号）占 2 列。"""
    cp = ord(ch)
    if cp >= 0x2500 and cp <= 0x27FF:  # 框线 + 终端符号
        return 2
    if 0x2E80 <= cp <= 0x9FFF:  # CJK 统一表意 + 部首
        return 2
    if 0x3000 <= cp <= 0x303F:  # CJK 标点
        return 2
    if 0xFF00 <= cp <= 0xFFEF:  # 全角形式
        return 2
    if 0x20000 <= cp <= 0x2FFFF:  # CJK 扩展
        return 2
    return 1


def align_row(text: str) -> int:
    """把字符串规整到 100 列（按终端列宽）。"""
    return sum(display_width(ch) for ch in text)


def render_colored_grid(draw_node: int | str, origin: tuple[float, float]) -> None:
    """50 行彩色网格（性能基准）。"""
    line_h = FONT_SIZE + 2
    x0, y0 = origin
    for r in range(ROWS):
        y = y0 + r * line_h
        fg = PALETTE[(r * 7) % 16]
        # 每行生成一个 100 列的内容串，用单次 draw_text 渲染整行
        text = f"[{r:04d}] " + "".join(chr(0x30 + ((r + c) % 10)) for c in range(COLS - 6))
        dpg.draw_text((x0, y), text, color=fg, parent=draw_node, size=FONT_SIZE)


def benchmark() -> None:
    """headless 渲染 N 帧，统计 FPS。"""
    dpg.create_context()
    build_fonts()

    with dpg.window(tag="bench_win", width=1280, height=800):
        node = dpg.add_drawlist(width=1280, height=800, tag="term_draw")
        # 预生成 50 行彩色文本
        render_colored_grid(node, (20, 20))

    dpg.create_viewport(title="spike-bench", width=1280, height=800)
    dpg.setup_dearpygui()
    dpg.show_viewport()

    frames = 300
    t0 = time.perf_counter()
    for _ in range(frames):
        dpg.render_dearpygui_frame()
    elapsed = time.perf_counter() - t0
    fps = frames / elapsed

    print(f"[spike] {frames} frames in {elapsed:.2f}s -> {fps:.1f} FPS")
    print(f"[spike] grid: {ROWS} rows x {COLS} cols colored draw_text ({ROWS} draw calls/frame)")
    verdict = "PASS >=30fps" if fps >= 30 else "FAIL <30fps"
    print(f"[spike] performance verdict: {verdict}")
    dpg.destroy_context()


def align_check() -> None:
    """CJK 混排列对齐验证。"""
    dpg.create_context()
    build_fonts()

    lines = [
        "Hello, 世界！这是一行中文测试",
        "A─B│C┌D┐ 框线字符占宽检查",
        "终端符号: ▲ ▼ ▶ ◀ ● ○ ■ □",
        "123456789012345678901234567890",
    ]
    with dpg.window(tag="align_win", width=900, height=400):
        node = dpg.add_drawlist(width=900, height=400, tag="align_draw")
        for i, line in enumerate(lines):
            dpg.draw_text((20, 30 + i * 40), line, parent=node, size=FONT_SIZE)

    dpg.create_viewport(title="spike-align", width=900, height=400)
    dpg.setup_dearpygui()
    dpg.show_viewport()
    dpg.render_dearpygui_frame()

    # 计算每行终端列宽，报告对齐情况
    print("[spike] CJK 对齐验证（列宽）:")
    for line in lines:
        w = align_row(line)
        print(f"  {line!r}: {w} columns")
    print("[spike] 说明: 全宽字符（CJK/框线）计 2 列。请目视窗口确认无错位。")
    dpg.destroy_context()


def gui_mode() -> None:
    """真实窗口模式：循环渲染，人工目测。"""
    dpg.create_context()
    build_fonts()

    with dpg.window(tag="main", width=1280, height=800):
        node = dpg.add_drawlist(width=1280, height=800, tag="term_draw")
        render_colored_grid(node, (20, 20))
        for i, line in enumerate(["CJK: 你好世界 ABC123", "框线: ─│┌┐└┘├┤", "终端: ▲▼▶◀●○■□"]):
            dpg.draw_text((20, 820 - (3 - i) * 30), line, parent=node, size=FONT_SIZE)

    dpg.create_viewport(title="MAXCOM DPG Terminal Spike", width=1280, height=800)
    dpg.setup_dearpygui()
    dpg.show_viewport()
    while dpg.is_dearpygui_running():
        dpg.render_dearpygui_frame()
    dpg.destroy_context()


def main() -> None:
    parser = argparse.ArgumentParser(description="DPG 终端渲染 spike")
    parser.add_argument("--bench", action="store_true", help="headless 帧率基准")
    parser.add_argument("--align", action="store_true", help="CJK 列对齐验证")
    parser.add_argument("--gui", action="store_true", help="打开真实窗口目测")
    args = parser.parse_args()

    if args.bench:
        benchmark()
    elif args.align:
        align_check()
    else:
        gui_mode()


if __name__ == "__main__":
    main()
