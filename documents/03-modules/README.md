# 模块清单与依赖 DAG

MAXCOM 各业务模块。**R0：`_foundation`（T0）必须先完成**，否则任何业务模块零开工。

## 模块与命名空间

| 目录 | 命名空间 | 模块 | 对应 V2 |
|---|---|---|---|
| `_foundation/` | T0 | 地基：骨架 / CI / 技术栈锁 / 共享工具 | Phase 0 |
| `ansi/` | ANS | ANSI 解析引擎（状态机 + 屏幕缓冲 + SGR） | §1.3 §4.1 |
| `terminal/` | TERM | 交互式终端（屏幕网格渲染 + 击键直传 + 本地回显） | §1.2 模式A |
| `logview/` | LOG | 传统收发（日志缓冲 + 智能分包 + 时间戳 + 分行） | §1.2 模式B |
| `colorize/` | COLOR | 自动染色（规则链 + ANSI 让位 + 用户规则） | §1.4 |
| `filter/` | FLT | 过滤引擎 | §1.2 §1.4 |
| `plot/` | PLT | 绘图引擎（帧解析 + 波形/FFT/统计） | §1.7 §4.3 |
| `transport/` | TP | 传输层（串口/TCP/UDP + 发现/重连） | §1.1 §4.4 |
| `project/` | PRJ | Project 系统（.maxcomprj 读写 + 生命周期） | §6 |
| `command/` | CMD | 命令系统 | §1.6 |

> 注：filter 与 colorize 在 V2 中属于日志路径的一部分；此处独立成模块便于单独测试，由 logview 组装。

## 依赖 DAG

```
                     _foundation (T0)   ← 必须先完成
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
    ansi (ANS)      transport (TP)      plot (PLT)
        │                 │                  │
        ▼                 │                  │
   terminal (TERM)        │                  │
        └──┬──────────────┼──────────────────┘
           ▼              ▼
      colorize (COLOR)  logview (LOG)
           │              │
           └──────┬───────┘
                  ▼
             filter (FLT)
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
   command (CMD)      project (PRJ)
```

依赖规则：模块只允许依赖 DAG 中其上游模块；`_foundation` 是全部模块的公共依赖。
