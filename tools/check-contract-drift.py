"""契约漂移校验（R6 的牙齿）。

对比 documents/02-contracts/*.schema.json 顶层 properties 与 pydantic 模型字段（序列化名）。
字段集不一致 = exit 非 0。

用法：python tools/check-contract-drift.py
"""

from __future__ import annotations

import importlib
import io
import json
import sys
from pathlib import Path

from pydantic import BaseModel

# Windows 控制台默认 GBK，统一 UTF-8 输出避免编码错误。
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

REPO_ROOT = Path(__file__).resolve().parent.parent
CONTRACTS = REPO_ROOT / "documents" / "02-contracts"

# schema 文件名 -> pydantic 模型模块/类名（无 _data_format 段，顶层即对比 properties）
MODEL_MAP: dict[str, tuple[str, str]] = {
    "command.schema.json": ("app.models.command", "Command"),
    "filter-rule.schema.json": ("app.models.filter_rule", "FilterRule"),
    "color-rule.schema.json": ("app.models.color_rule", "ColorRule"),
    "plot-config.schema.json": ("app.models.plot_config", "PlotConfig"),
    "transport.schema.json": ("app.models.transport", "TransportConfig"),
    "project-file.schema.json": ("app.models.project", "ProjectFile"),
    "global-config.schema.json": ("app.models.global_config", "GlobalConfig"),
}


def schema_top_keys(schema: dict[str, object]) -> set[str]:
    props = schema.get("properties")
    if isinstance(props, dict):
        return set(props.keys())
    return set()


def model_serialize_names(model_cls: type[BaseModel]) -> set[str]:
    names: set[str] = set()
    for name, field in model_cls.model_fields.items():
        serialized = field.alias or name
        names.add(serialized)
    return names


def main() -> int:
    if not CONTRACTS.exists():
        print(f"error: {CONTRACTS} not found (run from repo root)")
        return 1
    sys.path.insert(0, str(REPO_ROOT / "src"))

    failures: list[str] = []
    for filename, (module_name, class_name) in sorted(MODEL_MAP.items()):
        schema_path = CONTRACTS / filename
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        module = importlib.import_module(module_name)
        model_cls = getattr(module, class_name)

        schema_keys = schema_top_keys(schema)
        model_keys = model_serialize_names(model_cls)

        missing = schema_keys - model_keys  # schema 有、模型无
        extra = model_keys - schema_keys  # 模型有、schema 无
        if missing or extra:
            failures.append(
                f"{filename} <-> {module_name}.{class_name}:\n"
                f"  in schema but missing in model: {sorted(missing) or '{}'}\n"
                f"  in model but missing in schema: {sorted(extra) or '{}'}"
            )
        else:
            print(f"OK: {filename} <-> {class_name} fields consistent")

    if failures:
        print("\n".join(failures))
        print("FAIL: contract drift. 02-contracts is frozen (R1); models must match schema.")
        return 1
    print("ALL OK: contract models match schema")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
