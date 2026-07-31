# 测试策略

| 层 | 范围 | 工具 | 目标覆盖率 |
|---|---|---|---|
| 单元 | 核心模块（ANSI parser / ScreenBuffer / Filter / Colorize / Plot parsers / Checksum / Timestamp / ProjectFile） | pytest | ≥80% |
| 集成 | 串口收发回路（虚拟串口对 com0com）、TCP loopback | pytest | 关键路径 |
| GUI/VM | ViewModel 层逻辑（不测 DPG 渲染） | pytest | ≥60% |
| 性能 | ANSI 解析吞吐、绘图帧率 | pytest-benchmark | 无回归 |
| 契约 | pydantic 模型 vs 02-contracts schema | 漂移脚本 | 字段集一致 |

## 虚拟串口测试（Windows）
- 用 `com0com` 创建虚拟串口对（如 COM10 ↔ COM11）。
- 一端写一端读，验证收发一致性。
- CI 中用 PowerShell 脚本自动安装 com0com。

## 原则
- 核心解析（ANSI/Plot parsers）是纯函数式，可无 GUI 单测。
- 性能测试用固定基准机基线比对，禁止 sleep/轮询式断言。
- 数据流测试断言"原始流未被修改"（R9，ADR-0015）。
