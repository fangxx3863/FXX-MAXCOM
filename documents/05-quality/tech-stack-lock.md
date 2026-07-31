# 技术栈锁（Tech Stack Lock）

只用下表指定的库（R7）。需要新库 → 写 ADR 提案等批准，禁止自己 `pip install` 清单外的库。版本需锁精确（非 ^/~），保证可复现。

## 运行时依赖

| 库 | 用途 | 版本策略 |
|---|---|---|
| `dearpygui` | GUI 框架 | 锁精确（ADR-0005；注意维护状态，见 ADR-0017） |
| `pyserial` | 串口 | 锁精确 |
| `pydantic` v2 | 配置/契约校验 | 锁精确 |
| `numpy` | FFT/DSP | 锁精确 |
| `scipy` | FFT/DSP | 锁精确 |
| `tomli-w` | TOML 写入 | 锁精确（读取用内置 `tomllib`） |
| `pywinusb` | WINUSB（Phase 4） | 锁精确 |
| `hidapi` | HID（Phase 4） | 锁精确 |

## 开发/CI 依赖

| 库 | 用途 |
|---|---|
| `uv` | 依赖与虚拟环境管理（ADR-0006） |
| `ruff` | lint + format |
| `mypy` | 类型检查（strict） |
| `pytest` | 测试 |
| `pytest-benchmark` | 性能基准 |
| `nuitka` | 打包 .exe |

## 明确不使用
- **asyncio 主循环**：DPG 事件循环是 C++，与 asyncio 不整合（用多线程，ADR-0015）。
- **free-threading Python**（`--disable-gil`）：DPG 等 C 扩展兼容风险大（ADR-0006）。

## 实体化机制
- `pyproject.toml` 的 dependencies 精确版本。
- CI 跑 `check-deps`（扫 import，白名单外 = fail）。
