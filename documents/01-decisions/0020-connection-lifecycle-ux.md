# ADR-0020: 连接生命周期交互 —— 可取消的非阻塞连接 + 重连阶段上报 + 状态一致化

- 状态：**accepted**
- 日期：2026-09-30
- 裁决人：项目负责人（实测反馈："SSH 网络延迟很大时点连接会直接卡死主页面""连接点上之后马上按钮变成取消，加个转圈，不想等了也可以马上取消""串口拔了顶栏变红点但右侧还是灰点""不希望下次重连，只能再点一下连接让它弹报错"）
- Supersedes：无（细化 ADR-0016「单连接」在交互层的落地）
- 涉及契约：`documents/02-contracts/transport.schema.json`（`ConnConfig` 无字段变更）；连接状态事件 `ConnState` 的 `phase`/`attempt` 语义以本 ADR 为准（无 schema 文件，形态见 `crates/maxcom-engine/src/session.rs` 与 `app/src/types.ts`）

## 背景

实测暴露五类问题，根因集中在「连接是过程，但被当成瞬时状态处理」：

1. **界面卡死**：`connect` 原为 Tauri **同步**命令，`transport::open()`（串口 open / SSH 握手，最长 20s）
   在命令线程内完成，而同步命令跑在主线程 → 主界面无响应，且无任何中止手段。
2. **连接不可取消**：没有「连接中」这一可交互中间态，用户只能干等握手超时。
3. **重连不可见、不可拒绝**：掉线后自动重连静默退避，用户既看不到「正在重连（第几次）」，
   也没有「我不想重连」的入口——唯一途径是再点一次「连接」触发报错来复位。
4. **状态不一致**：顶栏圆点与标签页圆点判据不同（分别依据 `connected`/`error` 与 `lastError`），
   出现「顶栏红点、右侧灰点」。
5. **会话残留**：读线程掉线且关闭自动重连时，`active` 未回收 → 后续连接被「已有活动连接（单连接设计）」
   误拒，只能靠「点一次连接看报错」解锁。

## 决策

### 1. 引擎：连接改为可取消的两段式

- 新增 `SessionManager::begin_connect(config) -> Result<(), String>`：仅做参数校验 + 尝试登记
  （`ConnAttempt{ gen, cancel }`）+ 同步广播 `connecting`，随即在 `connect` 后台线程执行
  `transport::open()`，完成后回调 `finish_connect`。
- 新增 `SessionManager::cancel_connect() -> bool`：置取消位、递增代次并广播 `cancelled`；
  后台线程的迟到结果（**含迟到成功**）据此丢弃，句柄随 `Drop` 释放。
- **代次（gen）+ 取消位双保险**：新尝试会使旧代次作废，避免快速连点时旧结果覆盖新状态。
- 阻塞版 `connect()` 保留，仅供测试与引擎内部（modem 独占传输后恢复会话）使用。

### 2. 状态机：`ConnPhase` 作为唯一阶段来源

`ConnState` 新增（均 `#[serde(default)]`，向后兼容）：

| 字段 | 取值 | 含义 |
|---|---|---|
| `phase` | `disconnected` / `connecting` / `reconnecting` / `connected` / `failed` / `cancelled` | 驱动按钮与指示灯的**唯一**依据 |
| `attempt` | `u32` | 自动重连已尝试次数（`reconnecting` 时有意义，成功后归零） |

`conn_state()`（主动查询）与 `conn://state`（被动事件）同源，取自会话内 `SessionStatus`
（`alive` / `link` / `reconnecting` / `attempt` / `last_error`）。语义要点：

- `connected=false` **不等于**会话已死：`reconnecting` 退避期间会话仍在，但链路不可用。
- 会话装好时 `link` 即为 `true`（否则连接成功的瞬间 `conn_state()` 会误报未连接）。

### 3. 会话自回收（消除残留）

- 读线程退出时置 `alive=false`。
- `active` 互斥内的所有入口先 `reap_dead()`：已终结会话被回收，**单连接锁自动释放**。
- 掉线且关闭自动重连 → 会话直接终结（不再是「顶栏已断开、内部还连着」的半死状态）。

### 4. 前端：按钮三态 + 可取消重连

- 按钮文案：`连接` / `取消`（`busy`，带转圈）/ `断开`；`busy = phase ∈ {connecting, reconnecting}`。
- 连接中点击 = 取消：先乐观置 `disconnected` 给即时反馈，再 `cancelConnect()` + `disconnect()`
  （后者负责掐断自动重连循环）。
- 连接成功/失败一律走 **state 事件**，不再用模态 `alert` 打断操作；失败以顶栏红点 +
  连接标签 + 状态栏文案呈现。
- 重连中点击 = 取消重连（同一入口），无需等待、无需先触发报错。

### 5. 指示灯一致化

`connDotState(connected, phase, hasError) -> on | busy | err | off` 为**唯一**判据，
顶栏圆点与标签页圆点共用（`on`=链路可用，`busy`=连接中/重连中脉冲，`err`=异常终结，
`off`=未连接）。同一会话在两处的颜色永远一致。

### 6. Tauri：命令线程模型

`connect` / `disconnect` / `cancel_connect` 改 `async`；`list_ports` / `list_probes` /
`list_usb_devices` / `list_hid_devices` 改 `async` + `spawn_blocking`（设备枚举会枚举系统
设备树，同样不该占用主线程）。会话句柄用 `get_mgr()` 在锁外克隆，避免长任务占用全局会话锁。

## 后果

**正面**

- 连接/重连全程可见、可取消；SSH 高延迟不再卡死界面。
- 掉线与失败都有明确终态与原因，会话不再残留，重连前无需「点一下看报错」。
- 顶栏与标签页状态一致，用户看到的两处信号不再互相矛盾。

**负面 / 风险**

- 取消是「丢弃结果 + 释放句柄」，底层 `open()` 仍在后台线程跑完（SSH 最长 20s）。
  对**独占型设备**（RTT 探针、串口）在极端时序下可能短暂返回「设备被占用」，重试即可。
- `conn_state()` 具备副作用（回收死会话），调用方不得假设其为纯读操作。
- `ConnStatus` 与 `ConnState` 的双表示（内部原子量 vs 事件快照）要求新增状态时**两处同步**，
  否则会出现「查询与事件不一致」。

## 回归覆盖

- 引擎（`crates/maxcom-engine/tests/session_loopback.rs`）：
  `begin_connect_returns_immediately_and_broadcasts_connecting_first`、
  `cancel_connect_aborts_pending_attempt`、`cancel_connect_without_attempt_is_noop`、
  `reconnect_reports_phase_and_attempt`、`dropped_link_without_reconnect_reaps_session`。
- 前端（`app/scripts/connect-state-test.mjs`，已挂入 `npm run build`）：
  点连接立刻「取消 + 转圈」、再点即取消且迟到成功被丢弃、重连可见（含次数）可取消、
  失败时顶栏与标签页同为红点、失败后可直接重连。
