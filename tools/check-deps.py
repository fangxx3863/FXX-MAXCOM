"""依赖白名单检查器（R7 的牙齿）。

扫 target 目录下所有 import，白名单外 = exit 非 0。
白名单见 documents/05-quality/tech-stack-lock.md（与 pyproject.toml dependencies 对应）。

用法：python tools/check-deps.py <dir...>
"""

from __future__ import annotations

import ast
import io
import sys
from pathlib import Path

# Windows 控制台默认 GBK，统一 UTF-8 输出避免编码错误。
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# 允许的第三方顶层模块名。标准库由 sys.stdlib_module_names 覆盖。
ALLOWED_THIRD_PARTY = {
    "dearpygui",
    "serial",
    "pydantic",
    "numpy",
    "scipy",
    "tomli_w",
    "pywinusb",
    "hid",  # hidapi 包的 import 名
    # 开发/测试依赖
    "pytest",
    "pytest_benchmark",
    "mypy",
    "nuitka",
    "ruff",
}

# 项目自身顶层包（first-party）
FIRST_PARTY = {"app", "core", "ui"}


def collect_imports(path: Path) -> set[str]:
    imports: set[str] = set()
    for py in path.rglob("*.py"):
        try:
            tree = ast.parse(py.read_text(encoding="utf-8"), filename=str(py))
        except (OSError, SyntaxError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imports.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.add(node.module.split(".")[0])
    return imports


def main(argv: list[str]) -> int:
    targets = [Path(a) for a in argv] or [Path("src")]
    banned: list[tuple[str, str]] = []
    for target in targets:
        if not target.exists():
            print(f"error: {target} does not exist")
            return 1
        for name in sorted(collect_imports(target)):
            if name in FIRST_PARTY:
                continue
            if name in sys.stdlib_module_names:
                continue
            if name in ALLOWED_THIRD_PARTY:
                continue
            banned.append((str(target), name))

    if banned:
        for origin, name in banned:
            print(f"BANNED IMPORT: {name} (from {origin})")
        print(
            "FAIL: dependency not in tech-stack whitelist (R7). Need new dep -> write ADR proposal."
        )
        return 1
    print("OK: all imports within whitelist")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
