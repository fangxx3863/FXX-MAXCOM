# FXX-MAXCOM

一站式串口/网络调试与数据可视化平台。设计文档在 [`documents/`](documents/README.md)。

## 当前分支 `rust-tauri`（ADR-0018）

桌面端以 **Rust + Tauri 2** 重写（supersedes ADR-0005/0006/0017）。原 Python 实现已从本分支移除，
需要参照时 `git checkout main` 查看。

```
crates/
  maxcom-core/      纯逻辑引擎（编码/分包/分行/过滤/染色/统计/绘图解析），全量单测
  maxcom-engine/    传输层（串口/TCP/UDP/SSH/Telnet/RTT/USB/HID）+ 会话线程编排
  maxcom-mcp/       MCP 服务端（AI 工具接口，feature `server`，见 ADR-0021）
app/
  src/              前端 TypeScript（Vite；终端用 xterm.js，波形用 uPlot）
  src-tauri/        Tauri 薄胶水（commands/events + MCP 服务启动）
documents/          设计与决策单一事实源（契约/ADR/SPEC 不变）
```

## MCP（AI 接入）

桌面端启动时会拉起一个**只监听回环地址**的 MCP 服务（Streamable HTTP，默认
`http://127.0.0.1:8765/mcp`），把串口/USB/HID/探针枚举、会话收发、统计、固件烧录
暴露为 MCP 工具，供任意 MCP 客户端（WorkBuddy / Claude / Cursor…）接入。

- 开关/端口：设置页 →「🤖 AI 接入（MCP）」（可停止/重开、改监听端口、复制端点）；持久化在前端设置里
- 端口冲突：绑定失败（`AddrInUse`）时**自动 +1 重试**（最多 32 次）；界面提示实际端口 ——
  任何地方都**不许假定实际端口 == 请求端口**（状态里 `port` 与 `requested_port` 是分开的）
- 作用目标：工具省略 `session` 时作用于**用户当前查看的标签页**（前端 `activate()` 时经
  `set_active_session` 同步），因此 AI 的连接/收发与界面是同一条链路、实时可见
- 环境变量（均优先于界面）：`MAXCOM_MCP=off` 强制关闭、`MAXCOM_MCP_PORT=9000` 锁定端口
- 仅桌面端编译（`desktop` feature）；工具实现见 [`crates/maxcom-mcp`](crates/maxcom-mcp)，
  设计决策见 [ADR-0021](documents/01-decisions/0021-mcp-server.md)

## 开发

```bash
cargo test --workspace            # 核心引擎测试（无系统依赖）
cd app && npm install && npm run dev   # 前端
cargo tauri dev                   # 桌面外壳（Windows/macOS 或装了 webkit2gtk 的 Linux）
```

技术栈与分层规则见 [ADR-0018](documents/01-decisions/0018-rust-tauri-rewrite.md)。
