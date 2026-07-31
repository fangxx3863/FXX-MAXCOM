# ADR-0006: 语言 — 纯 Python 3.13

状态: accepted | 日期: 2026-07-31

## 背景
快速开发、生态丰富、AI 协作效率高；但实时数据处理（ANSI 解析、绘图）对性能敏感。

## 决策
**纯 Python 3.13**（标准构建，带 GIL）。用 `uv` 管理依赖和虚拟环境，`uv.lock` 保证 CI 与开发者一致。3.13 带来显著解释器性能提升（更快字节码、字符串/列表优化），对 ANSI 解析、行缓冲这类 CPU 密集路径帮助明显。

**不使用** 3.13 的 free-threading（`--disable-gil`）——DPG 这类 C 扩展对无 GIL 兼容性风险大，收益不确定。

## 理由
- 快速开发 + AI 协作（TS/Go 边界产出质量与调试效率的考量同 NexSim，但本单机工具以 Python 最简）。
- 关键路径有 C 生态兜底。

## 后果
- 关键路径优化：ANSI 解析纯 Python 状态机；FFT 用 numpy/scipy；串口 I/O 用 pyserial，必要时 ctypes 调 Win32；绘图渲染 DPG 本身 C++。
- 若高速串口（12Mbps）暴露瓶颈，再按需把热点解析移到 C 扩展。
