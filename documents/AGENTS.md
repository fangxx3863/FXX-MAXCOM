# AGENTS.md — MAXCOM AI 开发团队工作守则

> **分支说明（rust-tauri）**：本分支桌面端已按 [ADR-0018](01-decisions/0018-rust-tauri-rewrite.md)
> 改用 Rust + Tauri 重写，Python 实现与管理文件已移除（main 分支保留）。铁律 R1/R2/R3/R4/R6-R9
> 继续生效；R7 技术栈锁在本分支以 ADR-0018 的 Rust/npm 清单为准；实现代码在 `crates/` 与 `app/`。

**任何 AI agent 在动手前必须先读本文件。** 本仓库是 MAXCOM 的单一事实源：设计、决策、契约、任务卡。实现代码在 `src/`，工具在 `tools/`。

---

## 1. 这是什么

MAXCOM = 一站式串口/网络调试与数据可视化平台。核心能力：
- **双模式显示**：交互式终端（完整 ANSI 解析）+ 传统收发分离（时间戳/自动染色/过滤）
- **各引擎独立解析原始流**：终端/日志/绘图/文件各自订阅同一份原始字节流，后台独立解析，互不耦合、互不修改原始流
- **数据可视化**：波形/柱状/FFT/统计（借鉴 SerialPlot）
- **Project 系统**：`.maxcomprj` 一键保存/恢复完整调试环境

完整愿景见 `00-overview/product-vision.md`。

## 2. 仓库地图（找东西看这里）

```
documents/
├── 00-overview/      愿景全景 + 术语表 + 原始需求存档  ← 先读 product-vision.md
├── 01-decisions/     ADR（已拍板，不可翻案）  ← 动手前查相关 ADR
├── 02-contracts/     数据契约（可校验）       ← 数据结构以此为准，勿臆造
├── 03-modules/       每个模块：SPEC + tasks   ← 你的工作在这里
├── 04-milestones/    端到端里程碑与验收
└── 05-quality/       测试策略 / DoD / 编码规范 / 技术栈锁
src/                  实现代码（Python 3.13）
tools/                小工具（脚本、脚手架、测试辅助）
（原始需求已移入 documents/00-overview/：初步设想.md / 初步设想V2.md，标记为最原始需求存档）
```

## 3. 必读顺序（首次进入）

1. 本文件（AGENTS.md）
2. `00-overview/product-vision.md` —— 愿景与能力全景
3. `00-overview/glossary.md` —— 术语，命名以此为准
4. `03-modules/README.md` —— 模块清单与依赖 DAG
5. 你被分配模块的 `03-modules/<module>/SPEC.md`
6. 你被分配的任务卡 `03-modules/<module>/tasks/<TID>.md`
7. 该任务涉及的 `01-decisions/` ADR 与 `02-contracts/` 契约

执行具体任务时只需重读 5–7 与任务卡链接的契约。

## 4. 铁律（违反任一 = 任务失败）

- **R1 契约不可私改**：`02-contracts/` 是冻结的。实现中发现契约缺陷，停手，写一份 ADR 草案放 `01-decisions/`（状态 `proposed`）并报告，等裁决。
- **R2 任务卡即边界**：只做任务卡「目标/产出」列出的事；「禁止事项」即使顺手也不做。
- **R3 完成标准机器可验**：DoD 全部经测试/lint 验证，不存在"我觉得完成了"。
- **R4 决策只增不改**：ADR 编号递增、旧的不改，只能被新 ADR 标 superseded。
- **R5 依赖先行**：任务卡 `依赖` 未全部完成不得开始。
- **R0 地基先行**：`03-modules/_foundation`（T0）是项目第 0 步——它把 05-quality 的强制（lint/CI/test/技术栈锁）落地成真实配置。**T0 全绿前，任何业务模块零开工。**
- **R6 数据结构以 02-contracts 为准**：写实现时以契约文件为准，禁止手写重复定义或臆造字段。
- **R7 技术栈锁定**：只用 `05-quality/tech-stack-lock.md` 指定的库。需要新库 → 写 ADR 提案等批准，**禁止自己 `pip install` 清单外的库**。
- **R8 风格机器可验**：遵守 `05-quality/coding-standards.md`；提交前 ruff/ruff format/mypy 必须本地过（CI 也会卡）。
- **R9 数据流纪律**：遵守 V2 决策 #15（单一原始流 + 各引擎独立解析）。**任何引擎不得修改共享原始流**，也不得依赖其他引擎的解析结果。
- **R10 重大改动先存档**：任何**重大、破坏性、大范围**的修改（重构、删改接口/契约/架构、批量迁移、跨模块改动）开始之前，必须先 `git commit -a`（或 `git stash`）把当前工作区存一份档，确保有可回退的干净基线。若工作区有未提交的他人/历史改动，先确认归属再动。

## 5. 关键决策速查（详见 01-decisions/）

- **GUI 框架**（ADR-0005）：DearPyGui，自定义 draw_text 渲染控件。开工前必须先做终端渲染 spike（ADR-0017，O3）。
- **语言**（ADR-0006）：纯 Python 3.13（标准构建，带 GIL），`uv` 管理依赖，关键路径按需 C 扩展。
- **数据流**（ADR-0015）：单一原始流扇出 + 各引擎独立后台解析。
- **多连接**（ADR-0016）：单连接，多实例启动满足多端口需求。
- **配置文件**（ADR-0003）：TOML。**Project 文件**（ADR-0004）：ZIP。
- **ANSI 覆盖度**（ADR-0001）：核心子集（SGR + 光标 + 滚动 + 清屏）。

## 6. 命名与约定

- 实现语言：Python 3.13（strict mypy）。
- 标识符：代码英文 snake_case；文档可中文，术语首次附英文（以 glossary 为准）。
- 提交：`<module>: <TID> <概要>`，如 `ansi: ANS-T01 SGR 状态机`。
- 一卡一 PR；PR 描述含 DoD 逐项证据。

## 7. 任务卡命名空间（避免混淆）

| 前缀 | 模块 |
|---|---|
| T0 | foundation（地基：骨架/CI/技术栈锁） |
| ANS | ansi（ANSI 解析引擎） |
| TERM | terminal（交互式终端） |
| LOG | logview（传统收发/日志） |
| COLOR | colorize（自动染色） |
| PLT | plot（绘图引擎） |
| TP | transport（传输层） |
| PRJ | project（Project 系统） |
| CMD | command（命令系统） |

## 8. 任务卡的实现骨架（IMPL block）

任务卡在「目标/产出/DoD」之外，附一个 **IMPL block** —— 实现骨架，约束 agent 的实现方向，防止跑歪。IMPL 是**指引不是镣铐**：签名与算法步骤须遵循，具体实现由 agent 填充。统一含以下小节（按需，不强制全有）：

- **文件结构**：本任务产出哪些文件、各自职责（agent 不得擅自改变文件划分）。
- **签名**：关键函数/类型的精确签名（参数、返回、抛错）。这是模块间契约，**不可改**。
- **伪代码**：核心算法的分步逻辑。
- **易错点**：本任务最容易写错/遗漏的地方（off-by-one、状态泄漏、边界等）。
- **不变量**：实现结束必须成立的断言。

**分级**：标 `[详细]` 的 IMPL 已给接近可直译的伪码，照着写即可；标 `[骨架]` 的给方向与签名，留实现空间。两者的「签名」小节都不可改（跨任务契约）。

agent 实现时：先读任务卡 IMPL → 对照 SPEC 对应章节 → 对照 02-contracts 契约 → 写实现 + 测试。IMPL 与 SPEC/契约冲突时，以 **契约 > SPEC > IMPL** 为序。
