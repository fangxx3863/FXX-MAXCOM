# FXX-MAXCOM

一站式串口/网络调试与数据可视化平台。设计文档在 [`documents/`](documents/README.md)。

## 当前分支 `rust-tauri`（ADR-0018）

桌面端以 **Rust + Tauri 2** 重写（supersedes ADR-0005/0006/0017）。原 Python 实现已从本分支移除，
需要参照时 `git checkout main` 查看。

```
crates/
  maxcom-core/      纯逻辑引擎（编码/分包/分行/过滤/染色/统计/绘图解析），全量单测
  maxcom-engine/    传输层（串口/TCP/UDP）+ 会话线程编排
app/
  src/              前端 TypeScript（Vite；终端用 xterm.js，波形用 uPlot）
  src-tauri/        Tauri 薄胶水（commands/events）
documents/          设计与决策单一事实源（契约/ADR/SPEC 不变）
```

## 开发

```bash
cargo test --workspace            # 核心引擎测试（无系统依赖）
cd app && npm install && npm run dev   # 前端
cargo tauri dev                   # 桌面外壳（Windows/macOS 或装了 webkit2gtk 的 Linux）
```

技术栈与分层规则见 [ADR-0018](documents/01-decisions/0018-rust-tauri-rewrite.md)。
