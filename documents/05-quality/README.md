# 质量（05-quality）

MAXCOM 的质量基线：测试策略 / DoD / 编码规范 / 技术栈锁。

| 文档 | 内容 |
|---|---|
| `testing-strategy.md` | 测试分层、覆盖率目标、虚拟串口方案 |
| `definition-of-done.md` | 任务完成的机器可验标准 |
| `coding-standards.md` | 风格、数据流纪律、错误处理、性能纪律 |
| `tech-stack-lock.md` | 唯一依赖白名单 + 明确不使用项 |

## 核心约束
- **R7 技术栈锁**：只用 tech-stack-lock 列出的库。
- **R8 风格机器可验**：ruff + mypy strict。
- **R9 数据流纪律**：各引擎独立解析，不改共享原始流。
