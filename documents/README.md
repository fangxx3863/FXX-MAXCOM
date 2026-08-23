# MAXCOM 设计文档

一站式串口/网络调试与数据可视化平台，解决现有调试工具（VOFA+、SuperCom、SSCOM、SerialPlot、SecureCRT）的几乎所有痛点。

本仓库是 **设计与决策的单一事实源**。设计文档在 `documents/`。
>
> `rust-tauri` 分支：实现代码在 `crates/`（Rust 引擎）与 `app/`（Tauri 外壳+前端），见 ADR-0018。

## 入口
- **AI agent**：先读 [`AGENTS.md`](AGENTS.md)
- **人类**：本文件 → [`00-overview/product-vision.md`](00-overview/product-vision.md)（愿景全景）
- **原始需求（最原始存档）**：移入 [`00-overview/`](00-overview/)，见 [`初步设想.md`](00-overview/初步设想.md) 与 [`初步设想V2.md`](00-overview/初步设想V2.md)（V2，含完整需求与架构演进，已标记为项目最原始的需求来源；仅供追溯，不再更新）

## 目录
| 目录 | 内容 |
|---|---|
| `00-overview/` | 产品愿景全景 + 术语表 + 原始需求存档 |
| `01-decisions/` | 架构决策记录 ADR（已拍板，编号 0001-0016） |
| `02-contracts/` | 数据契约（命令条目、Project 文件、过滤规则等，CI 可校验） |
| `03-modules/` | 各模块：SPEC + 任务卡（含 IMPL 实现骨架） |
| `04-milestones/` | 端到端里程碑与验收（M0-M5） |
| `05-quality/` | 测试策略 / DoD / 编码规范 / 技术栈锁 |

## 阅读路线
- 决策者：`00-overview/product-vision.md` → `01-decisions/README.md`
- AI 团队：`AGENTS.md` → 愿景 → 你的模块 SPEC → 任务卡 → 相关 ADR
- 新贡献者：愿景 → 你关心的模块 SPEC
