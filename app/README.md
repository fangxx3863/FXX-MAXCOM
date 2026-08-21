# MAXCOM 桌面应用（Rust + Tauri 2，ADR-0018）

```
app/
├── src/          前端 TypeScript（Vite）
│   ├── pages/terminal.ts   交互式终端（xterm.js 承担 ANSI 解析渲染，击键直传）
│   ├── pages/logview.ts    传统收发（时间戳/染色/过滤 + 发送面板）
│   ├── pages/plot.ts       波形（uPlot，数据来自 Rust 快照轮询）
│   └── pages/stats.ts      统计仪表盘
└── src-tauri/    Tauri 薄胶水：commands ↔ maxcom-engine，SessionEvents → emit
```

分层铁律：**core 不依赖 engine，engine 不依赖 tauri**。业务逻辑全部在
`crates/maxcom-core`（纯逻辑，全量单测）与 `crates/maxcom-engine`（传输+线程编排，
TCP 回环集成测试）；本目录的 Rust 代码只做参数搬运。

## 开发

```bash
# 后端测试（无系统依赖）
cargo test --workspace

# 前端
cd app && npm install
npm run dev            # 浏览器演示模式：自动注入模拟后端（假串口数据/统计/波形），
                       # 打开 http://localhost:1420 即可完整调试 UI 样式（F12 = DevTools）


# 桌面（Windows：推荐目标平台 / Linux 需 webkit2gtk-4.1 开发包）
npm run tauri dev
npm run tauri build    # NSIS 安装包
```

## 与 main 分支（Python 版）的功能对照

| 能力 | 状态 |
|---|---|
| 双模式显示（终端 / 收发，切换不断连） | ✅ |
| 击键直传 + 原始流渲染 | ✅ |
| 智能分包时间戳（空闲超时可配，三格式） | ✅ |
| 自动染色（内置四规则 + ANSI 让位） | ✅（用户自定义规则 UI 待接） |
| 过滤引擎（show/hide 规则链热更新） | ✅（规则编辑 UI 待接） |
| 绘图 Simple Binary / ASCII 解析 + 波形 | ✅ |
| 统计仪表盘（RX/TX/速率 + 通道指标） | ✅ |
| 串口 / TCP 客户端 / UDP 客户端 | ✅ |
| FFT/Bode、柱状、散点 | ⏳ M2（rustfft 已列入技术栈锁） |
| 自定义帧解析（帧头/CRC16） | ⏳ M3（契约已建模） |
| Project 系统 .maxcomprj / 命令系统 / XYZmodem | ⏳ M3 |
| 端口别名记忆/黑名单/热插拔/自动重连 | ⏳ M3-M4 |
| WINUSB/HID、插件系统 | ⏳ M4 |

> 契约（documents/02-contracts）不变；DTO 字段与 JSON Schema 逐一对齐。
