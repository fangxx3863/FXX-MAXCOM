# ADR-0003: 配置文件 — TOML

状态: accepted | 日期: 2026-07-31

## 背景
需要全局配置（主题/语言/字体/端口黑名单）+ 项目配置（连接/命令/过滤/绘图），结构嵌套、需注释、需版本控制友好。

## 决策
配置文件用 **TOML**：读取用 `tomllib`（Python 3.11+ 内置），写入用 `tomli-w`。结构校验用 `pydantic` v2。

## 理由
- TOML 支持嵌套、注释、跨平台；内置 `tomllib` 免额外读取依赖。
- 比 JSON 可读性好（用户会手改），比 YAML 歧义少。

## 后果
- 全局配置：`%APPDATA%/MAXCOM/config.toml`。
- 项目内配置（transport/filters/plots）也用 TOML，命令用 JSON（见 ADR-0004）。
