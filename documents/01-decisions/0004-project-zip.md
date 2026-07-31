# ADR-0004: Project 文件 — ZIP（.maxcomprj）

状态: accepted | 日期: 2026-07-31

## 背景
Project = 完整调试工作环境快照（连接/命令/过滤/绘图/布局），需一键保存恢复，跨设备分享，版本控制友好。

## 决策
`.maxcomprj` 本质是一个 **ZIP 压缩包**，内含结构化文件（TOML/JSON），并提供"导出文件夹"功能用于 Git。

## 理由
- 单文件便于分享/分发；ZIP 内文件用既有格式（TOML/JSON）便于单文件查看与手改。
- "导出文件夹"满足部分用户偏好明文目录版本控制。

## 后果
- 内部结构：`project.toml` / `transport.toml` / `commands.json` / `filters.toml` / `plots/` / `view_state.toml` / `history/`。
- 保存用临时文件 + rename 保证原子性，避免写坏（见 O 待确认项，纳入 DoD）。
