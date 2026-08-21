# ADR-0018: 桌面端改用 Rust + Tauri 重写

- 状态：**accepted**
- 日期：2025-08-21
- 裁决人：项目负责人（口头指令："开个分支，使用 Rust + Tauri 重来"）
- Supersedes：[ADR-0005](0005-gui-dearpygui.md)（DearPyGui）、[ADR-0006](0006-language-python313.md)（Python 3.13）、[ADR-0017](0017-dpg-spike.md)（DPG spike）
- 载体：分支 `rust-tauri`（main 的 Python 实现保持不动，作为行为参照与回归对照）

## 背景

Python 3.13 + DearPyGui 的实现已完成 M0/M1 主体（终端/日志/染色/过滤/统计）。实践中暴露：

1. **性能天花板**：GIL 限制下多引擎并行解析吃满单核；DPG 渲染路径在大量文本刷新时掉帧。
2. **分发困难**：Nuitka 打包体积大、启动慢、杀软误报率高。
3. **DPG 生态风险**：维护状态不明（ADR-0017 已预警），自绘控件成本高。
4. **团队意愿**：转向 Rust + Web 前端技术栈，获得内存安全、原生线程并行与成熟的 WebView 生态。

## 决策

### 语言与框架

| 项 | 选择 | 说明 |
|---|---|---|
| 核心语言 | **Rust**（edition 2021，stable） | 全部业务逻辑、引擎、传输层 |
| 桌面外壳 | **Tauri 2** | 系统 WebView，产物小、启动快 |
| 前端语言 | **TypeScript**（strict） | 无重框架，Vite 构建 |
| 终端渲染 | **@xterm/xterm** | 模式 A（交互式终端）的 ANSI 解析与渲染委托给它 |
| 绘图渲染 | Canvas 2D 自绘 | 波形/柱状，数据由 Rust 下采样后推送 |

### 工作区布局

```
Cargo.toml               # workspace：crates/*
crates/
  maxcom-core/           # 纯逻辑引擎（无 IO/Tauri 依赖，全量单测）
  maxcom-engine/         # 传输层 + 会话编排（线程模型，可注入传输做集成测试）
app/
  src/                   # 前端 TS（Vite）
  src-tauri/             # Tauri 薄胶水：commands/events 映射到 maxcom-engine
```

分层铁律：**core 不依赖 engine，engine 不依赖 tauri**。src-tauri 只做参数搬运与事件发射，
保证核心全部机器可验（本机无 webkit2gtk 也能 `cargo test` 全绿）。

### 模块映射（Python → Rust）

| Python 模块 | Rust 落点 | 备注 |
|---|---|---|
| `pipeline/event_bus` | `maxcom-core::bus` | 多消费者队列扇出 |
| `pipeline/encoding` | `maxcom-core::encoding` | UTF-8/GBK 启发式不变；Latin-1 手工逐字节映射 |
| `logview/framing` | `maxcom-core::framing` | TimestampManager + 三种时间戳格式，语义逐行对齐 |
| `logview/splitter` | `maxcom-core::splitter` | CRLF/LF/CR 拆行语义不变 |
| `filter/engine` | `maxcom-core::filter` | show/hide 规则链，首个生效 |
| `colorize/*` | `maxcom-core::colorize` | 四条内置规则 + 用户规则 + ANSI 让位 + Palette |
| `ansi/strip` | `maxcom-core::ansistrip` | 仅保留 strip/detect（渲染让位给 xterm.js） |
| `stats/tracker` | `maxcom-core::stats` | 累计字节 + 滑动窗口速率 |
| `transport/*` | `maxcom-engine::transport` | serialport crate（feature 门控）/ TCP / UDP |
| `LogEngine` 组装 | `maxcom-engine::session` | 读线程 → 总线 → 各引擎线程，批量回调 |

### 与原架构的刻意差异

1. **ANSI 解析引擎不再自研**：模式 A 由 xterm.js 承担（业界标准实现，覆盖完整 CSI/OSC）；
   模式 B 日志路径仍需 `contains_ansi` 做让位检测，保留于 core。
2. **GUI 主循环**：WebView 渲染 + Rust 推送。引擎线程通过回调批量上报（~30ms 合批），
   避免 Tauri event 高频风暴；绘图数据改为前端轮询快照（50ms），天然背压为零。
3. **技术栈锁定方式变更**：Python 的「精确版本号 + check-deps」换成 **Cargo.lock / package-lock.json
   提交即锁**；新增依赖仍需 ADR 提案（R7 精神不变）。
4. **平台**：目标平台仍是 Windows（ADR-0007 不变）；Linux CI 只跑 core/engine 测试与前端构建，
   外壳编译验证交给带 webkit2gtk 的 CI job。

## 技术栈锁（本分支生效，替代 05-quality/tech-stack-lock.md 的运行时部分）

**原则：库优先，不重复造轮子**——凡是 crates.io / npm 上有维护良好的成熟实现，一律调库；
自研代码只保留 MAXCOM 特有的业务规则（分包策略、染色规则链、统计口径等）。

| crate | 用途 | 替代的自研轮子 |
|---|---|---|
| `serde` + `serde_json` | DTO 序列化（契约 JSON 字段名不变） | — |
| `chardetng` + `encoding_rs` | 字符集自动检测（Firefox 同款）+ GBK 等解码 | Python 版手写启发式检测 |
| `ansitok` | ANSI 转义序列 tokenize（让位检测/剥离） | Python 版手写 strip_ansi 状态机 |
| `regex` | 过滤/染色规则 | — |
| `toml` | 规则文件/配置读写 | — |
| `thiserror` | 错误类型 | — |
| `crossbeam-channel` | 引擎线程间队列/扇出 | 手写 EventBus（保留薄封装对齐语义） |
| `serialport`（可选 feature `serial`） | 串口枚举与读写 | — |
| `ringbuffer` | 绘图环形缓冲 | 手写环形缓冲 |
| `rustfft` + `apodize`（M2） | FFT 频谱与窗函数 | numpy/scipy |
| `crc`（M3 自定义帧） | 帧校验 | — |
| `tauri` 2 / `tauri-build` 2 | 外壳（仅 src-tauri） | — |

前端 npm：`vite`、`typescript`、`@xterm/xterm` + `@xterm/addon-fit`（终端模拟器，替代自研
ANSI 引擎 + 终端 viewport）、`uplot`（流式波形，替代自研绘图渲染）。

## 后果

- 正面：并行引擎真正多核；分发为单个小体积安装包；前端生态直接可用。
- 负面/风险：双语言栈认知成本；WebView 平台差异需在 M4 验证；
  Project 系统（ZIP）、命令系统、热插拔等 M3 能力在本分支延后重建（见 `app/README.md` 路线图）。
