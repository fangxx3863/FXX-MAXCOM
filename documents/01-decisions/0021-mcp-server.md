# ADR-0021: MCP 服务端 —— 内嵌 Streamable HTTP + 全量工具

- 状态：**accepted**
- 日期：2026-10-09
- 裁决人：项目负责人（口头指令："增加 MCP 功能，能够使 AI 连接 MCP 获得列出串口、获取串口信息等等的功能"；
  并就形态/范围/实现三项明确选择：**内嵌 HTTP** / **全量（含烧录）** / **官方 rmcp SDK**）
- Supersedes：无
- 涉及契约：无新增契约文件；工具入参直接复用 `transport.schema.json` 对应的 Rust DTO
  （`ConnConfig` / `FlashConfig` / `ModemProtocol`）

## 背景

MAXCOM 已是完整的串口/网络调试台，但所有能力都只能由人在界面上操作。要让 AI 助手参与调试
（"帮我看看这个板子在发什么"、"试几个波特率"、"把这版固件烧进去"），需要一个标准化的、
可被任意 MCP 客户端接入的接口。

需求边界（本轮明确）：

1. 列出串口并给出**足够选设备的信息**（原生 `PortInfo` 此前只有 `device` + `description`，
   到了多设备/多 USB 转串口场景就分不清哪个是哪个）；
2. 不只是枚举，还要能**操作真正的会话** —— 打开端口、发命令、读回响应、看统计、烧录。

## 决策

### 部署形态：内嵌 Streamable HTTP

在运行中的 MAXCOM 进程内起一个 MCP 服务（`axum` + rmcp 的 `StreamableHttpService`），
AI 客户端通过 URL 接入。

| 方案 | 取舍 |
|---|---|
| **内嵌 HTTP（选定）** | AI 操作的是**用户眼前那个会话**：已打开的串口、正在刷的日志、当前统计。单一事实源，不存在"GUI 占着串口、MCP 打不开"的双开冲突。代价：应用必须在运行；需要一个本地监听端口。 |
| 独立 stdio 二进制 | 不依赖 GUI 在跑、无监听端口，但看不到也动不了 GUI 的会话；且它自己 `open()` 同一个串口会因被占用而失败（`serialport` 单开）。 |
| 混合（stdio 桥接 HTTP） | 兼容性最好，但要多维护一条 stdio↔HTTP 转发链路。本轮不做。 |

### 安全边界：硬约束只绑回环

这个服务能开串口、发任意字节、把固件烧进芯片。因此 `serve_http` **拒绝**任何非回环绑定地址
（`io::ErrorKind::InvalidInput`），而不是"警告后继续"—— 一旦监听 `0.0.0.0`，同网段任何人
都能远程刷写你的设备，且没有任何鉴权层能挡住（MCP 客户端普遍不带凭据）。

关闭与改端口走环境变量：`MAXCOM_MCP=off`、`MAXCOM_MCP_PORT=<port>`（默认 8765）。
环境变量是**硬开关**，优先级高于设置页的界面开关 —— 否则用户设了 `off` 却被界面重新打开，
「我明明关了」会变成安全错觉；界面尝试打开时会显式报出「已被环境变量强制关闭」。

### 实现：官方 rmcp SDK

`rmcp = "3.5"`（`default-features = false`，features：`server` + `macros` + `transport-streamable-http-server`）。

选官方 SDK 而非手写 JSON-RPC：MCP 规范仍在演进（transport 语义、capability 协商、
会话管理都在动），手写实现会持续产生"规范已改但我们对不上"的维护成本。
代价是引入较重的依赖树（tokio / axum / hyper / tower / schemars / sse-stream）。

### 工具范围：全量（含烧录）

| 分组 | 工具 |
|---|---|
| 发现（只读） | `list_serial_ports`、`list_usb_devices`、`list_hid_devices`、`list_probes`、`list_chips`、`list_sessions`、`server_info` |
| 会话状态（只读） | `get_session_status`、`get_stats`、`read_io`、`get_plot_snapshot`、`get_capture_state` |
| 会话控制 | `connect`、`cancel_connect`、`disconnect`、`close_session`、`send`、`set_dtr`、`set_rts`、`set_auto_reconnect`、`set_log_options`、`clear_log` |
| 捕获 | `start_capture`、`save_capture`、`cancel_capture` |
| 烧录 / 文件传输 | `flash_firmware`、`modem_transfer`、`cancel_modem_transfer` |

**不纳入**：纯 UI 妆点（自动染色规则、行过滤规则、主题、绘图配色）。它们只影响界面观感，
不改变数据或设备状态；放进工具面只会增加 LLM 的选择负担。

### 架构落位：新增 `crates/maxcom-mcp`

```
maxcom-core          纯逻辑
  └ maxcom-engine    传输 + 会话编排
      └ maxcom-mcp   ← 新增：MCP 协议与工具契约（不依赖 Tauri）
          └ app/src-tauri   只实现 Backend（会话寻址）+ 启动 HTTP 服务
```

分层不破（core ↛ engine ↛ tauri 原样保持）。`maxcom-mcp` 对上层只要求一件事 ——
`Backend` trait（`list_sessions` / `session` / `session_or_create` / `close_session`）；
其余工具全部直接调用 engine 的自由函数（`discover_serial_ports`、`discover_probes`、
`chip_list`、`flashing::flash`…），因此这个 trait 只有 4 个方法，Tauri 侧实现约 20 行。

### 入参契约：复用引擎 DTO，不镜像

MCP 工具需要 JSON Schema，而 `ConnConfig`/`FlashConfig` 此前只派生 `Serialize`/`Deserialize`。
本 ADR 选择**给 engine 加一个可选 feature `schema`**（`dep:schemars`，纯编译期派生），
而不是在 MCP 侧镜像一份 DTO —— 镜像会产生"契约文档 / 引擎 / AI 工具"三份定义，
是这类项目最典型的长期腐化源。

工具**输出**刻意用 JSON 文本而非 rmcp 的结构化输出（`Json<T>`）：后者要求返回类型派生
`JsonSchema`，会把 schemars 一路传染到 `maxcom-core`（`StatsSnapshot`/`ChannelMetrics`…）。
入参 schema 才决定 LLM 调用准确率，出参用 JSON 文本信息量不减。

### 引擎侧新增：会话级 I/O 环形缓冲

`read_io` 需要"最近发生了什么"，但后端此前**没有任何可查询的历史**（日志只经回调流向
前端 `LogViewPage.rows`，后端不留存）。因此在 `SessionManager` 加一个固定上限（512 KiB、
丢最旧）的环形缓冲：读线程记 RX、`send()` 记 TX，每块带单调递增 `seq` 与墙钟 `ts_ms`。
语义贴着 ADR-0015 的"单一原始流"—— 存原始字节，不做染色/过滤，AI 看到的是事实而非渲染结果。

跨重连保留（挂在 `SessionManager` 而非 `Active` 上）。`clear_log` 会同时清缓冲，
但**不与前端的 `Cmd::ClearLog` 合并**：前端清屏不该抹掉 AI 正在读的历史。

### feature 门控

`maxcom-mcp` 的实现整体位于其 `server` feature（默认关）。这样工作区 CI 的轻量路径
`cargo clippy/test --workspace --no-default-features` 不会被 rmcp/axum/probe-rs 拖慢；
由 `app/src-tauri` 的 `desktop` feature 打开（`maxcom-mcp/server`），移动端不编译。
CI 另加专门步骤覆盖 `--features server` 的 clippy 与 test。

R7 技术栈锁以本 ADR 追加 `rmcp` / `axum` / `schemars` 三枚 crate 入锁（`tokio`、`tokio-util`
engine 已在用）。

### 设置页接线（前端）

设置页新增「AI 接入（MCP）」卡片：开关、只读端点输入框 + 复制按钮、三态状态行。

- **开关持久化沿用项目既有模式**：与窗口尺寸记忆一致（前端 `localStorage` 持久化 +
  启动时同步给后端），而不是在 Rust 侧另建一套配置存储。代价是启动时有约一秒服务处于
  「默认开启」而用户上次选择是关闭的窗口；要保证全程关闭请用 `MAXCOM_MCP=off`。
- **状态是全局的，但设置页 DOM 是每标签页克隆一份**（`PRISTINE` → `SessionApp.el`），
  因此状态变更要广播到所有标签页；并缓存最近一次状态，供新建标签页立即渲染，
  不必每个标签页都打一次 IPC。
- **三态渲染把「启动失败」排在「实际运行」之前**：开关是开的但没在跑，若被渲染成
  「运行中」，用户据此去配客户端只会连不上。
- **端点始终显示**（未运行时给出「若开启会是这个地址」），用户随时能复制，
  不必先成功启动一次。
- **「恢复默认」保留开关**：它是功能性设置，不在「恢复外观默认」的语义范围内。

### 默认作用会话 = 用户当前页面（同日修订）

**起因（用户实测）**：MCP 默认在自己另开的隐藏会话上操作，于是打开某个串口后，
用户在主界面再点「连接」同一端口必然失败 —— 而他还看不到 AI 那边在干什么。

两个问题其实是同一个根因的两面：

1. **串口是独占资源。** 两条 `SessionManager` 就是两个设备句柄，第二条 `open()` 必然失败。
2. **隐藏会话没有界面出口。** 它挂的是丢弃式事件出口，AI 的连接/收发在界面上完全不可见。

**决策**：工具省略 `session` 参数时，目标改为**用户在界面上正在查看的那个会话**
（前端在 `activate()` 时通过 `set_active_session` 同步给后端）。

这样拿到的是**同一个 `SessionManager` 本体**，两个问题同时消失：不存在第二个设备句柄，
而且事件本来就按 session 标签路由（`onState` → `sessions.get(e.session)`），
界面的连接指示灯、收发区、终端、绘图、统计全部自动跟上，无需任何额外同步机制。

配套约定：

- `list_sessions` / `get_session_status` 增加 `active` 字段标明哪个是用户当前页面。
- `connect` 在目标会话已连接时**提前**返回可操作的错误（先 `disconnect`，或显式换一个
  `session id`），而不是把引擎的「已有活动连接（单连接设计，先断开再连）」原样抛给 LLM 去猜。
- 显式传入一个**不存在**的 `session id` 仍会新建无界面的独立会话 —— 保留「AI 要一条
  不打扰用户的链路」这个能力，但必须显式要求，不再是默认行为。
- 前端 `onLinkUp` 的 DTR/RTS 补发改为**无条件**下发（原先按本地 `connKind === "serial"` 门控）。
  连接可能是 MCP 侧发起的，此时顶栏下拉的选择未必等于真实链路，按 `connKind` 门控会漏掉
  这次补发；非串口传输的 `setDtr/setRts` 是 no-op，多发无副作用。

**残留限制**：前端顶部「连接类型」下拉仍只反映用户自己的选择，不由链路状态回填 ——
若 AI 连的是串口而用户下拉停在 TCP，下拉显示会与真实链路不符（连接标签、指示灯、
收发区都是准的，取自引擎）。真要修需要给 `ConnState` 加 `kind` 字段，本轮未做。

## 后果

- 正面：
  - AI 可端到端参与调试：选设备 → 连接 → 发命令 → 读回字节 → 看统计/波形 → 烧录。
  - `PortInfo` 富化（`port_type`/`vid`/`pid`/`serial_number`/`manufacturer`）同时让界面端口下拉
    具备区分多设备的能力；新增字段全部 `Option` + 缺省不序列化，前端契约向后兼容。
  - 工具入参与引擎 DTO 单一事实源，规范或字段变更只需改一处。
- 负面 / 风险：
  - 依赖树显著变重（rmcp + axum + hyper + tower）。仅在 `desktop` feature 下编译，
    但桌面构建时间与产物体积都会增加。
  - MCP 客户端普遍在"用户已授权其访问本机"的前提下工作；服务本身不再是第二道防线 ——
    只绑回环 + 用户自控开关是仅有的边界，这一点已写进 `server_info` 的 `safety` 字段。
  - 环形缓冲的 512 KiB 是固定值：高频大流量（如 1 Mbps 串口）下只够几秒历史。
    需要更长历史用 `start_capture`/`save_capture`（落盘），或后续按需把上限做成可配。
  - `set_log_options` 未提供的字段取引擎默认值，会覆盖界面上的既有设置（已在工具描述中注明）。

## 未纳入本轮

- 未做资源（resources）/提示（prompts）/采样（sampling）能力，只暴露 tools。
- 未做鉴权（token）层：服务只绑回环，且远程客户端无法访问。
