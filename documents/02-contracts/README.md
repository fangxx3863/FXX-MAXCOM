# 数据契约（02-contracts）

数据结构以本目录为唯一事实源（AGENTS.md 铁律 R6）。用 pydantic 校验实现时，以此为准，禁止手写重复定义或臆造字段。

## 契约清单

| 契约 | 文件 | 说明 |
|---|---|---|
| 命令条目 | `command.schema.json` | 自定义命令的结构（分组/快捷键/变量/校验） |
| 过滤规则 | `filter-rule.schema.json` | 日志过滤规则（正则） |
| 颜色规则 | `color-rule.schema.json` | 自动染色用户自定义规则 |
| 绘图配置 | `plot-config.schema.json` | 绘图配置（数据格式/通道/显示） |
| Project 文件 | `project-file.schema.json` | `.maxcomprj` 整体结构（ZIP 内各文件） |
| 传输配置 | `transport.schema.json` | 传输/连接配置 |
| 全局配置 | `global-config.schema.json` | 用户级全局配置 |

## 使用约定

- 所有配置结构定义在对应 SPEC（03-modules）引用，本目录提供 schema 语义。
- 实现用 pydantic v2 定义同构模型，字段名与 schema 完全一致。
- 变更契约 → 提 ADR（R1），不得私改。
