//! MCP 工具集：把 MAXCOM 的枚举 / 会话 / 数据 / 烧录能力暴露为 MCP tools（ADR-0021）。
//!
//! 设计取舍（为什么长这样）：
//!
//! 1. **工具输出是 JSON 文本**，不是 `Json<T>` 结构化输出。结构化输出要求返回类型
//!    派生 `JsonSchema`，那会把 schemars 一路传染到 `maxcom-core`（`StatsSnapshot`、
//!    `ChannelMetrics`…）。入参 schema 才是决定 LLM 调用准确率的部分，所以只在入参上
//!    付出这个代价；出参用 JSON 文本，信息一点不少。
//! 2. **入参直接复用引擎 DTO**（`ConnConfig` / `FlashConfig` / `ModemProtocol`，
//!    经 `maxcom-engine/schema` 派生 `JsonSchema`）。若在 MCP 侧镜像一份，就会出现
//!    「契约文档 / 引擎 / AI 工具」三份定义互相漂移 —— 这是这类项目最典型的长期腐化。
//! 3. **只读工具与写入工具走不同的会话获取路径**：只读用 `session()`（拼错就报错），
//!    写入用 `session_or_create()`（允许 AI 自建会话来开端口）。

use crate::backend::Backend;
use maxcom_core::framing::TimestampMode;
use maxcom_engine::session::{
    ConnPhase, ConnState, IoChunk, IoDir, LogOptions, SendPayload, SessionManager,
};
use maxcom_engine::transport::flashing::{self, FlashConfig, FlashProgressDto};
use maxcom_engine::transport::{self, ConnConfig, ModemProtocol};
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::{tool, tool_handler, tool_router, ServerHandler};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 未显式指定会话时使用的专用会话 id。
///
/// 刻意用一个固定名字而不是每次自动生成：AI 的多次调用之间是**无状态**的，
/// 「上次那个会话」必须靠一个可预测的名字接续，否则第二次调用就会对着空会话读。
pub const DEFAULT_SESSION: &str = "mcp";

/// `read_io` 单次返回字节数上限
const READ_IO_MAX_BYTES: u32 = 256 * 1024;
/// `read_io` 单次等待上限（毫秒）
const READ_IO_MAX_WAIT_MS: u32 = 10_000;

/// MAXCOM MCP 服务端。每个 MCP 会话克隆一份，共享同一个 [`Backend`]。
#[derive(Clone)]
pub struct MaxcomMcp {
    backend: Arc<dyn Backend>,
    endpoint: Option<String>,
    tool_router: ToolRouter<Self>,
}

// ───────────────────────── 入参 DTO ─────────────────────────

/// 只指定会话（其余参数缺省）
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct SessionRef {
    /// 会话 id；省略则作用于**用户当前正在查看的页面**（MCP 操作与界面同步）
    #[serde(default)]
    pub session: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ConnectParams {
    /// 会话 id；省略则作用于**用户当前正在查看的页面**（MCP 操作与界面同步）
    #[serde(default)]
    pub session: Option<String>,
    /// 连接配置（与 documents/02-contracts/transport.schema.json 同构）
    pub config: ConnConfig,
    /// 等待连接建立的最长毫秒数（默认 30000；SSH 握手最坏 20s，故不宜过小）
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SendParams {
    /// 会话 id；省略则作用于**用户当前正在查看的页面**（MCP 操作与界面同步）
    #[serde(default)]
    pub session: Option<String>,
    /// 文本内容（按 UTF-8 原样发送）
    #[serde(default)]
    pub text: Option<String>,
    /// HEX 内容，如 "AA 55 01"（空白可省略；长度须为偶数）
    #[serde(default)]
    pub hex: Option<String>,
    /// 追加换行："none"（默认）/ "lf" / "cr" / "crlf"
    #[serde(default)]
    pub newline: Option<String>,
    /// 是否同时写入本地收发区（默认 false，仅发送不回显）
    #[serde(default)]
    pub echo: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadIoParams {
    /// 会话 id；省略则作用于**用户当前正在查看的页面**（MCP 操作与界面同步）
    #[serde(default)]
    pub session: Option<String>,
    /// 只返回 seq 大于该值的块（0 = 取环形缓冲里的全部近况）。
    /// 续读时填上一次返回的 `max_seq`。
    #[serde(default)]
    pub since_seq: Option<u64>,
    /// 本次最多返回字节数（默认 16384，上限 262144）
    #[serde(default)]
    pub max_bytes: Option<u32>,
    /// 暂无新数据时最多等待毫秒数（默认 0 立即返回，上限 10000）。
    /// 发完命令后用 200~2000 通常足够拿到设备响应。
    #[serde(default)]
    pub wait_ms: Option<u32>,
    /// 输出形态："text"（默认，UTF-8 有损解码）/ "hex" / "both"
    #[serde(default)]
    pub format: Option<String>,
    /// 方向过滤："both"（默认）/ "rx" 只要设备发来的 / "tx" 只要本工具发出的。
    /// **发完命令等响应时用 "rx"**：否则自己刚写出的字节会立刻让本调用返回，等不到响应。
    #[serde(default)]
    pub dir: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct PlotParams {
    /// 会话 id；省略则作用于**用户当前正在查看的页面**（MCP 操作与界面同步）
    #[serde(default)]
    pub session: Option<String>,
    /// 每通道最多返回的点数（默认 1000，上限 100000）
    #[serde(default)]
    pub max_points: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListChipsParams {
    /// 可选：按家族名子串过滤（不区分大小写），减少返回体积
    #[serde(default)]
    pub family: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetPinParams {
    /// 会话 id；省略则作用于**用户当前正在查看的页面**（MCP 操作与界面同步）
    #[serde(default)]
    pub session: Option<String>,
    /// true = 置位，false = 清除
    pub on: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetAutoReconnectParams {
    /// 会话 id；省略则作用于**用户当前正在查看的页面**（MCP 操作与界面同步）
    #[serde(default)]
    pub session: Option<String>,
    pub on: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetLogOptionsParams {
    /// 会话 id；省略则作用于**用户当前正在查看的页面**（MCP 操作与界面同步）
    #[serde(default)]
    pub session: Option<String>,
    /// 空闲封行超时（毫秒）；缺省取引擎默认 10
    #[serde(default)]
    pub idle_timeout_ms: Option<u64>,
    /// 时间戳模式（缺省取引擎默认 absolute）；取值同前端时间戳设置
    #[serde(default)]
    pub timestamp_mode: Option<String>,
    /// 文本编码（缺省取引擎默认 auto）；如 utf-8 / gbk / gb2312 / latin-1
    #[serde(default)]
    pub encoding: Option<String>,
    /// 分包方式："line"（按换行，缺省）或 "timeout"（按空闲超时）
    #[serde(default)]
    pub split_mode: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ModemParams {
    /// 会话 id；省略则作用于**用户当前正在查看的页面**（MCP 操作与界面同步）
    #[serde(default)]
    pub session: Option<String>,
    /// 文件传输协议
    pub protocol: ModemProtocol,
    /// 本地文件绝对路径
    pub path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SaveCaptureParams {
    /// 会话 id；省略则作用于**用户当前正在查看的页面**（MCP 操作与界面同步）
    #[serde(default)]
    pub session: Option<String>,
    /// 目标文件绝对路径
    pub path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CloseSessionParams {
    /// 要关闭的会话 id
    pub session: String,
}

// ───────────────────────── 出参 DTO ─────────────────────────

#[derive(Debug, Serialize)]
struct SessionView {
    id: String,
    connected: bool,
    phase: ConnPhase,
    label: String,
    /// 是否是用户当前正在查看的页面（= 省略 `session` 时工具的作用对象）
    active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    attempt: u32,
}

impl SessionView {
    fn of(id: &str, st: ConnState, active: bool) -> Self {
        Self {
            id: id.to_string(),
            connected: st.connected,
            phase: st.phase,
            label: st.label,
            active,
            error: st.error,
            attempt: st.attempt,
        }
    }
}

#[derive(Debug, Serialize)]
struct IoChunkView {
    seq: u64,
    /// 墙钟毫秒
    ts_ms: u64,
    /// "rx" = 设备发来的；"tx" = 本工具发出去的
    dir: &'static str,
    len: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hex: Option<String>,
}

#[derive(Debug, Serialize)]
struct IoView {
    session: String,
    /// 本次请求的起始序号（回显入参，便于续读）
    since_seq: u64,
    /// 本次返回的最后一块的 seq：下次续读传它。无新块时等于 `since_seq`。
    max_seq: u64,
    /// 环形缓冲内最新 seq（含被 `dir` 过滤掉的方向），仅作诊断
    ring_max_seq: u64,
    /// 环形缓冲内最旧 seq
    oldest_seq: u64,
    /// true 表示 `since_seq` 与 `oldest_seq` 之间有数据已被环形缓冲覆盖（断档）
    gap: bool,
    /// 本次生效的方向过滤
    dir: String,
    bytes: usize,
    chunks: Vec<IoChunkView>,
}

// ───────────────────────── 工具实现 ─────────────────────────

#[tool_router(router = tool_router)]
impl MaxcomMcp {
    pub fn new(backend: Arc<dyn Backend>) -> Self {
        Self {
            backend,
            endpoint: None,
            tool_router: Self::tool_router(),
        }
    }

    /// 附带对外端点（`server_info` 展示用；绑定端口后才可知）
    pub fn with_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = Some(endpoint.into());
        self
    }

    /// 省略 `session` 时的目标会话：**用户在界面上正在查看的那个页面**。
    ///
    /// 这是刻意的默认值，不是图省事。MCP 若默认在自己另开的隐藏会话里操作，会出现
    /// 两个问题：① 用户在界面上什么都看不到（AI 说"已连接"而他眼前还是未连接）；
    /// ② **串口是独占资源**，AI 打开后用户再点「连接」同一端口必然失败。
    /// 把默认目标对准用户当前页面，两个问题同时消失 —— 拿到的是同一个 `SessionManager`，
    /// 事件按 session 路由，界面的指示灯 / 收发区 / 终端 / 统计全部自动跟上。
    ///
    /// 回退到 [`DEFAULT_SESSION`] 只在「前端尚未把活动会话同步过来」时发生
    /// （应用启动瞬间），那时会建一个无界面的会话 —— 与旧的单会话方案相比没有退化。
    fn default_session(&self) -> String {
        self.backend
            .active_session()
            .unwrap_or_else(|| DEFAULT_SESSION.to_string())
    }

    fn mgr(&self, session: Option<&str>) -> Arc<SessionManager> {
        let id = session
            .map(str::to_string)
            .unwrap_or_else(|| self.default_session());
        self.backend.session_or_create(&id)
    }

    /// 取已存在的会话；不存在则报错（只读工具用，避免对着空会话反复读）
    fn existing(&self, session: Option<&str>) -> Result<(String, Arc<SessionManager>), String> {
        let id = session
            .map(str::to_string)
            .unwrap_or_else(|| self.default_session());
        match self.backend.session(&id) {
            Some(m) => Ok((id, m)),
            None => Err(format!(
                "会话不存在: {id}（可用 list_sessions 查看当前会话；控制类工具会自动创建会话）"
            )),
        }
    }

    // ── 发现（无副作用，不需要会话） ──

    #[tool(
        name = "list_serial_ports",
        description = "列出本机串口，含 device（如 COM3、/dev/ttyUSB0）、描述、USB VID/PID、\
                       序列号、厂商与端口类型。连接串口前先用它确认 port 字段的确切取值。"
    )]
    pub async fn list_serial_ports(&self) -> Result<String, String> {
        json(&blocking(transport::discover_serial_ports).await?)
    }

    #[tool(
        name = "list_usb_devices",
        description = "列出 USB 设备（WinUSB/libusb 类原始传输的候选），含 VID/PID、厂商、产品、\
                       序列号与接口列表。用于连接自定义 USB 协议设备。"
    )]
    pub async fn list_usb_devices(&self) -> Result<String, String> {
        json(&blocking(transport::discover_usb_devices).await?)
    }

    #[tool(
        name = "list_hid_devices",
        description = "列出 HID 设备（HID 传输的候选），含 VID/PID、厂商、产品、序列号、\
                       usage page/usage 与接口号。"
    )]
    pub async fn list_hid_devices(&self) -> Result<String, String> {
        json(&blocking(transport::discover_hid_devices).await?)
    }

    #[tool(
        name = "list_probes",
        description = "列出已连接的调试探针（CMSIS-DAP / J-Link 等），返回可直接回填给 \
                       probe_selector 的选择器串。烧录/ RTT 前先用它确认探针。"
    )]
    pub async fn list_probes(&self) -> Result<String, String> {
        json(&blocking(transport::discover_probes).await?)
    }

    #[tool(
        name = "list_chips",
        description = "列出 probe-rs 内置支持的目标芯片（家族 → 变体）。传入 family 可按家族名\
                       子串过滤，避免返回过大的列表。烧录前用它确认 chip 字段的确切取值。"
    )]
    pub async fn list_chips(
        &self,
        Parameters(p): Parameters<ListChipsParams>,
    ) -> Result<String, String> {
        let mut chips = blocking(transport::chip_list).await?;
        if let Some(f) = p.family.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let needle = f.to_ascii_lowercase();
            chips.retain(|c| c.family.to_ascii_lowercase().contains(&needle));
        }
        json(&chips)
    }

    #[tool(
        name = "list_sessions",
        description = "列出 MAXCOM 当前的所有会话（界面标签页 + AI 自建的会话）及各自连接状态。\
                       操作某个会话前先用它确认会话 id。"
    )]
    pub async fn list_sessions(&self) -> Result<String, String> {
        // 在这里排序而不是在 Backend 实现里：工具输出必须确定。
        // 否则 HashMap（Tauri 侧）与 Vec（测试侧）会给出不同顺序，
        // 同一次提问在不同实现下返回不同结果，对 LLM 是纯粹的噪声。
        let mut ids = self.backend.list_sessions();
        ids.sort();
        let active = self.backend.active_session();
        let views: Vec<SessionView> = ids
            .into_iter()
            .filter_map(|id| {
                let st = self.backend.session(&id)?.conn_state();
                let is_active = active.as_deref() == Some(id.as_str());
                Some(SessionView::of(&id, st, is_active))
            })
            .collect();
        json(&views)
    }

    #[tool(
        name = "server_info",
        description = "返回本 MCP 服务的自描述信息：端点、版本、默认作用会话、可用传输类型与\
                       典型调用顺序。不确定从哪开始时先调它。"
    )]
    pub async fn server_info(&self) -> Result<String, String> {
        let sessions = self.backend.list_sessions();
        let active = self.backend.active_session();
        json(&serde_json::json!({
            "name": "maxcom",
            "version": self.backend.app_version(),
            "endpoint": self.endpoint,
            "default_session": self.default_session(),
            "user_page_session": active,
            "default_session_rule": "省略 session 的工具作用于 user_page_session（用户在界面上\
                                     正在查看的页面），因此 AI 的连接/收发会实时显示在他眼前；\
                                     user_page_session 为 null 时回退到专用会话 \"mcp\"。\
                                     显式传入一个不存在的 id 会新建**无界面**的独立会话。",
            "tool_count": self.tool_router.list_all().len(),
            "sessions": sessions,
            "transports": [
                "serial", "tcp_client", "udp_client", "ssh", "telnet", "rtt", "winusb", "hid"
            ],
            "suggested_flow": [
                "list_serial_ports / list_usb_devices / list_hid_devices / list_probes 挑选设备",
                "connect 建立连接（config.type 决定传输类型；省略 session 即操作用户当前页面）",
                "send 发送命令（newline 可自动补 \\r\\n）",
                "read_io 读取最近收发字节（先取 max_seq，再以此为 since_seq 续读）",
                "get_stats / get_plot_snapshot 看统计与波形；flash_firmware 烧录",
            ],
            "safety": "服务仅监听回环地址；本工具可读写串口并烧录固件，请确认目标设备无误再操作。",
        }))
    }

    // ── 会话状态（只读） ──

    #[tool(
        name = "get_session_status",
        description = "查询单个会话的连接阶段（disconnected/connecting/reconnecting/connected/\
                       failed/cancelled）、连接标签与最近一次错误。"
    )]
    pub async fn get_session_status(
        &self,
        Parameters(p): Parameters<SessionRef>,
    ) -> Result<String, String> {
        let (id, mgr) = self.existing(p.session.as_deref())?;
        let active = self.backend.active_session().as_deref() == Some(id.as_str());
        json(&SessionView::of(&id, mgr.conn_state(), active))
    }

    #[tool(
        name = "get_stats",
        description = "查询会话的收发统计：RX/TX 累计字节与速率等。用于判断链路是否真的在\
                       收数据、以及吞吐量。"
    )]
    pub async fn get_stats(&self, Parameters(p): Parameters<SessionRef>) -> Result<String, String> {
        let (_id, mgr) = self.existing(p.session.as_deref())?;
        json(&mgr.stats())
    }

    #[tool(
        name = "get_capture_state",
        description = "查询二进制接收捕获状态：(capturing 是否捕获中, bytes 已捕获字节, \
                       dropped 超限丢弃字节)。"
    )]
    pub async fn get_capture_state(
        &self,
        Parameters(p): Parameters<SessionRef>,
    ) -> Result<String, String> {
        let (id, mgr) = self.existing(p.session.as_deref())?;
        let (capturing, bytes, dropped) = mgr.capture_state();
        json(&serde_json::json!({
            "session": id, "capturing": capturing, "bytes": bytes, "dropped": dropped
        }))
    }

    #[tool(
        name = "read_io",
        description = "读取会话最近的原始收发字节（RX 设备发来的 + TX 本工具发出的），\
                       按时间顺序分块返回。发完命令后用 dir=\"rx\" + wait_ms 即可等到设备响应。\
                       续读：把上次返回的 max_seq 作为本次 since_seq。"
    )]
    pub async fn read_io(&self, Parameters(p): Parameters<ReadIoParams>) -> Result<String, String> {
        let (id, mgr) = self.existing(p.session.as_deref())?;
        let since = p.since_seq.unwrap_or(0);
        let max_bytes = p.max_bytes.unwrap_or(16 * 1024).clamp(1, READ_IO_MAX_BYTES) as usize;
        let wait_ms = p.wait_ms.unwrap_or(0).min(READ_IO_MAX_WAIT_MS) as u64;
        let format = p
            .format
            .as_deref()
            .unwrap_or("text")
            .trim()
            .to_ascii_lowercase();
        let dir = p
            .dir
            .as_deref()
            .unwrap_or("both")
            .trim()
            .to_ascii_lowercase();

        let keep = |c: &IoChunk| match dir.as_str() {
            "rx" => c.dir == IoDir::Rx,
            "tx" => c.dir == IoDir::Tx,
            _ => true,
        };
        let snapshot = |from: u64| {
            let (chunks, ring_max, oldest) = mgr.io_since(from, max_bytes);
            let picked: Vec<IoChunk> = chunks.into_iter().filter(|c| keep(c)).collect();
            (picked, ring_max, oldest)
        };

        // 有 wait_ms 时轮询等待（工具是 async 的，睡眠不占线程）。
        // 用轮询而非条件变量：环形缓冲是纯快照语义，加信号机制会把它变成事件流，
        // 反而要处理「等待期间会话被重建」这类边界。
        let mut snap = snapshot(since);
        if snap.0.is_empty() && wait_ms > 0 {
            let deadline = Instant::now() + Duration::from_millis(wait_ms);
            while Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(20)).await;
                snap = snapshot(since);
                if !snap.0.is_empty() {
                    break;
                }
            }
        }
        let (chunks, ring_max_seq, oldest_seq) = snap;

        // 续读游标取「本次实际返回的最后一块」，而不是环的最新序号：
        // 按方向过滤时两者会不同（只要 rx 而环里最后一块是 tx），
        // 用环序号会让客户端跳过尚未返回的 rx 块。
        let max_seq = chunks.last().map(|c| c.seq).unwrap_or(since);
        let bytes = chunks.iter().map(|c| c.data.len()).sum();
        json(&IoView {
            session: id,
            since_seq: since,
            max_seq,
            ring_max_seq,
            oldest_seq,
            gap: oldest_seq > since.saturating_add(1),
            dir,
            bytes,
            chunks: chunks.iter().map(|c| render_chunk(c, &format)).collect(),
        })
    }

    #[tool(
        name = "get_plot_snapshot",
        description = "读取绘图页的最新通道数据快照（各通道降采样后的点序列、点数与通道指标）。\
                       读取前需先通过前端界面或连接配置选好数据格式。"
    )]
    pub async fn get_plot_snapshot(
        &self,
        Parameters(p): Parameters<PlotParams>,
    ) -> Result<String, String> {
        let (_id, mgr) = self.existing(p.session.as_deref())?;
        let max_points = p.max_points.unwrap_or(1000).clamp(1, 100_000) as usize;
        json(&mgr.plot_snapshot(max_points))
    }

    // ── 会话控制（写入） ──

    #[tool(
        name = "connect",
        description = "建立连接。config.type 决定传输：serial / tcp_client / udp_client / ssh / \
                       telnet / rtt / winusb / hid。省略 session 时**作用于用户当前查看的页面**\
                       —— 连接状态、收发数据会实时显示在他的界面上（这是推荐用法）。调用会等待\
                       连接建立完成（最长 timeout_ms）并返回最终状态，失败原因在 error 字段。"
    )]
    pub async fn connect(
        &self,
        Parameters(p): Parameters<ConnectParams>,
    ) -> Result<String, String> {
        let id = p.session.clone().unwrap_or_else(|| self.default_session());
        let target = describe(&p.config);
        let timeout = Duration::from_millis(p.timeout_ms.unwrap_or(30_000).clamp(100, 120_000));
        let mgr = self.mgr(Some(&id));

        // 单连接设计（ADR-0016）：先给出可操作的提示，而不是把引擎的
        // 「已有活动连接（单连接设计，先断开再连）」原样抛给 LLM 让它猜。
        if mgr.is_connected() {
            return Err(format!(
                "会话 {id} 已连接（MAXCOM 每个会话只支持一条连接）。\
                 先调用 disconnect 断开，或显式指定另一个 session id 另开一条不影响界面的链路。"
            ));
        }
        mgr.begin_connect(p.config)?;

        // 只等 connecting 阶段：连上/失败/被取消都会立刻跳出，
        // 因此正常情况几乎不耗时间，只有真正握手才等到超时。
        let mut st = mgr.conn_state();
        let deadline = Instant::now() + timeout;
        while st.phase == ConnPhase::Connecting && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(25)).await;
            st = mgr.conn_state();
        }
        let timed_out = st.phase == ConnPhase::Connecting;
        let active = self.backend.active_session().as_deref() == Some(id.as_str());
        let view = SessionView::of(&id, st, active);
        json(&serde_json::json!({
            "session": view.id,
            "target": target,
            "connected": view.connected,
            "phase": view.phase,
            "label": view.label,
            "error": view.error,
            "attempt": view.attempt,
            "timed_out": timed_out,
            "on_user_page": view.active,
        }))
    }

    #[tool(
        name = "cancel_connect",
        description = "取消进行中的连接尝试（例如目标不可达时正在握手）。立即返回；\
                       迟到的握手成功结果会被丢弃。"
    )]
    pub async fn cancel_connect(
        &self,
        Parameters(p): Parameters<SessionRef>,
    ) -> Result<String, String> {
        let (id, mgr) = self.existing(p.session.as_deref())?;
        let cancelled = mgr.cancel_connect();
        json(&serde_json::json!({ "session": id, "cancelled": cancelled }))
    }

    #[tool(
        name = "disconnect",
        description = "断开当前会话（含中止自动重连与进行中的连接尝试），保留会话对象本身。"
    )]
    pub async fn disconnect(
        &self,
        Parameters(p): Parameters<SessionRef>,
    ) -> Result<String, String> {
        let (id, mgr) = self.existing(p.session.as_deref())?;
        blocking(move || mgr.disconnect()).await?;
        json(&serde_json::json!({ "session": id, "ok": true, "action": "disconnect" }))
    }

    #[tool(
        name = "close_session",
        description = "销毁会话：断开连接、回收读/日志/绘图线程与设备句柄。之后该会话 id \
                       不再出现在 list_sessions 中（再操作会重新创建）。"
    )]
    pub async fn close_session(
        &self,
        Parameters(p): Parameters<CloseSessionParams>,
    ) -> Result<String, String> {
        let id = p.session;
        let backend = self.backend.clone();
        let id2 = id.clone();
        blocking(move || backend.close_session(&id2)).await?;
        json(&serde_json::json!({ "session": id, "ok": true, "action": "close_session" }))
    }

    #[tool(
        name = "send",
        description = "向会话发送数据。text 按 UTF-8 原样发送，hex 接受 \"AA 55 01\" 形式\
                       （两者可同时给出，先 text 后 hex）。newline 可自动补行尾：none/lf/cr/crlf。"
    )]
    pub async fn send(&self, Parameters(p): Parameters<SendParams>) -> Result<String, String> {
        let (id, mgr) = self.existing(p.session.as_deref())?;
        let has_text = p.text.as_deref().is_some_and(|s| !s.is_empty());
        let has_hex = p.hex.as_deref().is_some_and(|s| !s.is_empty());
        if !has_text && !has_hex {
            return Err("text 与 hex 至少要给一个（且不能为空串）".into());
        }
        let payload = SendPayload {
            text: p.text,
            hex: p.hex,
            newline: normalize_newline(p.newline.as_deref().unwrap_or("none")),
            echo: p.echo.unwrap_or(false),
        };
        let bytes = mgr.send(&payload)?;
        json(&serde_json::json!({ "session": id, "bytes": bytes, "ok": true }))
    }

    #[tool(
        name = "set_dtr",
        description = "设置串口 DTR 引脚电平（部分开发板靠它复位/进入下载模式）。\
                       对非串口传输无效。重连后会自动重放。"
    )]
    pub async fn set_dtr(&self, Parameters(p): Parameters<SetPinParams>) -> Result<String, String> {
        let (id, mgr) = self.existing(p.session.as_deref())?;
        mgr.set_dtr(p.on)?;
        json(&serde_json::json!({ "session": id, "dtr": p.on }))
    }

    #[tool(
        name = "set_rts",
        description = "设置串口 RTS 引脚电平。对非串口传输无效。重连后会自动重放。"
    )]
    pub async fn set_rts(&self, Parameters(p): Parameters<SetPinParams>) -> Result<String, String> {
        let (id, mgr) = self.existing(p.session.as_deref())?;
        mgr.set_rts(p.on)?;
        json(&serde_json::json!({ "session": id, "rts": p.on }))
    }

    #[tool(
        name = "set_auto_reconnect",
        description = "开关掉线自动重连。关闭后掉线即终结会话（需要手动重新 connect）。"
    )]
    pub async fn set_auto_reconnect(
        &self,
        Parameters(p): Parameters<SetAutoReconnectParams>,
    ) -> Result<String, String> {
        let (id, mgr) = self.existing(p.session.as_deref())?;
        mgr.set_auto_reconnect(p.on);
        json(&serde_json::json!({ "session": id, "auto_reconnect": p.on }))
    }

    #[tool(
        name = "set_log_options",
        description = "设置日志解码/分包选项：idle_timeout_ms（空闲封行毫秒）、timestamp_mode、\
                       encoding（如 utf-8/gbk）、split_mode（line 按换行 / timeout 按空闲）。\
                       **未提供的字段会取引擎默认值**，即会覆盖界面上的既有设置。"
    )]
    pub async fn set_log_options(
        &self,
        Parameters(p): Parameters<SetLogOptionsParams>,
    ) -> Result<String, String> {
        let (id, mgr) = self.existing(p.session.as_deref())?;
        let opts = LogOptions {
            idle_timeout_ms: p.idle_timeout_ms.unwrap_or(10),
            timestamp_mode: p
                .timestamp_mode
                .as_deref()
                .and_then(TimestampMode::parse)
                .unwrap_or_default(),
            encoding: p.encoding.unwrap_or_else(|| "auto".into()),
            split_mode: if p.split_mode.as_deref() == Some("timeout") {
                "timeout".into()
            } else {
                "line".into()
            },
        };
        mgr.set_log_options(opts);
        json(&serde_json::json!({ "session": id, "ok": true }))
    }

    #[tool(
        name = "clear_log",
        description = "清空该会话的最近 I/O 环形缓冲（read_io 的历史）。不影响界面显示区，\
                       也不影响链路——继续收发会立即重新累积。"
    )]
    pub async fn clear_log(&self, Parameters(p): Parameters<SessionRef>) -> Result<String, String> {
        let (id, mgr) = self.existing(p.session.as_deref())?;
        mgr.clear_log();
        mgr.clear_io();
        json(&serde_json::json!({ "session": id, "ok": true, "action": "clear_log" }))
    }

    // ── 二进制捕获 ──

    #[tool(
        name = "start_capture",
        description = "开始把接收数据流式捕获为二进制文件（存临时目录，分块落盘，不占内存）。\
                       结束后用 save_capture 落盘、或 cancel_capture 丢弃。"
    )]
    pub async fn start_capture(
        &self,
        Parameters(p): Parameters<SessionRef>,
    ) -> Result<String, String> {
        let (id, mgr) = self.existing(p.session.as_deref())?;
        mgr.start_capture();
        let (capturing, bytes, dropped) = mgr.capture_state();
        json(&serde_json::json!({
            "session": id, "capturing": capturing, "bytes": bytes, "dropped": dropped
        }))
    }

    #[tool(
        name = "save_capture",
        description = "停止捕获并把已捕获数据写入目标绝对路径，返回写入字节数。"
    )]
    pub async fn save_capture(
        &self,
        Parameters(p): Parameters<SaveCaptureParams>,
    ) -> Result<String, String> {
        let (id, mgr) = self.existing(p.session.as_deref())?;
        let path = p.path;
        let path2 = path.clone();
        let bytes = blocking(move || mgr.save_capture(&path2)).await??;
        json(&serde_json::json!({ "session": id, "path": path, "bytes": bytes }))
    }

    #[tool(
        name = "cancel_capture",
        description = "取消捕获并丢弃临时文件（不落盘）。"
    )]
    pub async fn cancel_capture(
        &self,
        Parameters(p): Parameters<SessionRef>,
    ) -> Result<String, String> {
        let (id, mgr) = self.existing(p.session.as_deref())?;
        mgr.cancel_capture();
        json(&serde_json::json!({ "session": id, "ok": true, "action": "cancel_capture" }))
    }

    // ── 烧录与文件传输（需要探针 / 独占链路） ──

    #[tool(
        name = "flash_firmware",
        description = "用 probe-rs 通过调试探针烧录固件（.elf/.hex/.bin/.uf2）。参数同烧录页：\
                       chip 可为空或 auto（由 probe-rs 自动识别）、probe_selector 省略则取第一个探针。\
                       本调用会阻塞到烧录结束，返回结果与最后若干条进度事件。"
    )]
    pub async fn flash_firmware(
        &self,
        Parameters(cfg): Parameters<FlashConfig>,
    ) -> Result<String, String> {
        let target = format!(
            "chip={} path={} format={}",
            if cfg.chip.trim().is_empty() {
                "auto"
            } else {
                cfg.chip.trim()
            },
            cfg.path,
            if cfg.format.trim().is_empty() {
                "auto"
            } else {
                cfg.format.trim()
            }
        );
        // 烧录是长阻塞操作（擦写 + 校验可达数十秒），必须离开 async 工作线程
        let (result, events) = blocking(move || {
            let events: Arc<Mutex<Vec<FlashProgressDto>>> = Arc::new(Mutex::new(Vec::new()));
            let sink = events.clone();
            let r = flashing::flash(&cfg, move |p| {
                if let Ok(mut g) = sink.lock() {
                    g.push(p);
                }
            });
            (r, events)
        })
        .await?;

        let events = events.lock().unwrap();
        let tail_from = events.len().saturating_sub(20);
        json(&serde_json::json!({
            "target": target,
            "ok": result.is_ok(),
            "message": match result { Ok(m) => m, Err(e) => e },
            "progress_events": events.len(),
            "last_events": &events[tail_from..],
        }))
    }

    #[tool(
        name = "modem_transfer",
        description = "在当前会话链路上做 X/Y/ZMODEM 文件传输（常见于设备 Bootloader 升级）。\
                       传输期间链路被协议独占：会话会先断开、再用同一配置重开，结束后自动重连恢复。\
                       本调用会阻塞到传输结束。"
    )]
    pub async fn modem_transfer(
        &self,
        Parameters(p): Parameters<ModemParams>,
    ) -> Result<String, String> {
        let (id, mgr) = self.existing(p.session.as_deref())?;
        let protocol = p.protocol;
        let path = p.path;
        let (result, events) = blocking(move || {
            let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
            let sink = events.clone();
            let r = mgr.modem_transfer(protocol, path, move |pr| {
                if let Ok(mut g) = sink.lock() {
                    g.push(serde_json::json!({
                        "kind": pr.kind.to_string(),
                        "operation": pr.operation.clone(),
                        "size": pr.size,
                        "total": pr.total,
                        "message": pr.message.clone(),
                    }));
                }
            });
            (r, events)
        })
        .await?;

        let events = events.lock().unwrap();
        let tail_from = events.len().saturating_sub(20);
        json(&serde_json::json!({
            "session": id,
            "protocol": format!("{protocol:?}").to_ascii_lowercase(),
            "ok": result.is_ok(),
            "message": match result { Ok(()) => "传输完成".to_string(), Err(e) => e },
            "progress_events": events.len(),
            "last_events": &events[tail_from..],
        }))
    }

    #[tool(
        name = "cancel_modem_transfer",
        description = "强制停止进行中的 X/Y/ZMODEM 传输（协议层在下一轮轮询时退出）。\
                       无传输进行时调用无害。"
    )]
    pub async fn cancel_modem_transfer(
        &self,
        Parameters(p): Parameters<SessionRef>,
    ) -> Result<String, String> {
        let (id, mgr) = self.existing(p.session.as_deref())?;
        mgr.cancel_modem_transfer();
        json(&serde_json::json!({ "session": id, "ok": true, "action": "cancel_modem_transfer" }))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for MaxcomMcp {}

// ───────────────────────── 辅助 ─────────────────────────

/// 把阻塞型引擎调用丢到阻塞线程池（枚举串口/USB 可能耗时上百毫秒，烧录可达数十秒）
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("后台任务异常: {e}"))
}

fn json<T: Serialize + ?Sized>(v: &T) -> Result<String, String> {
    serde_json::to_string_pretty(v).map_err(|e| format!("序列化结果失败: {e}"))
}

fn render_chunk(c: &IoChunk, format: &str) -> IoChunkView {
    let want_text = matches!(format, "text" | "both");
    let want_hex = matches!(format, "hex" | "both");
    IoChunkView {
        seq: c.seq,
        ts_ms: c.ts_ms,
        dir: match c.dir {
            IoDir::Rx => "rx",
            IoDir::Tx => "tx",
        },
        len: c.data.len(),
        text: want_text.then(|| String::from_utf8_lossy(&c.data).into_owned()),
        hex: want_hex.then(|| hex_upper(&c.data)),
    }
}

fn hex_upper(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 3);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        s.push_str(&format!("{b:02X}"));
    }
    s
}

/// 把 LLM 爱写的几种换行写法都归一成引擎认识的值（引擎对未知值静默不追加，容易误判为"没发出去"）
fn normalize_newline(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" | "none" => "none".into(),
        "\\n" | "lf" | "n" => "\n".into(),
        "\\r" | "cr" | "r" => "\r".into(),
        "\\r\\n" | "crlf" | "rn" => "\r\n".into(),
        other => other.to_string(),
    }
}

/// 连接配置的人类可读摘要（回填给 AI 便于自检"连的是不是我以为的那个设备"）
fn describe(config: &ConnConfig) -> String {
    match config {
        ConnConfig::Serial { port, baud, .. } => format!("串口 {port} @ {baud}"),
        ConnConfig::TcpClient { host, port } => format!("TCP {host}:{port}"),
        ConnConfig::UdpClient { host, port } => format!("UDP {host}:{port}"),
        ConnConfig::Ssh {
            host,
            port,
            username,
            ..
        } => format!("SSH {username}@{host}:{port}"),
        ConnConfig::Telnet { host, port } => format!("Telnet {host}:{port}"),
        ConnConfig::Rtt { chip, .. } => format!(
            "RTT {}",
            if chip.trim().is_empty() {
                "auto"
            } else {
                chip.trim()
            }
        ),
        ConnConfig::Winusb { vid, pid, .. } => format!("WinUSB {vid:04X}:{pid:04X}"),
        ConnConfig::Hid { vid, pid, .. } => format!("HID {vid:04X}:{pid:04X}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newline_aliases_normalize_to_engine_values() {
        // 引擎只认 "none"/"\n"/"\r"/"\r\n"，其余静默不追加——这里必须把常见写法都收敛过去
        for (input, want) in [
            ("", "none"),
            ("none", "none"),
            ("NONE", "none"),
            ("lf", "\n"),
            ("\\n", "\n"),
            ("cr", "\r"),
            ("\\r", "\r"),
            ("crlf", "\r\n"),
            ("\\r\\n", "\r\n"),
            ("CRLF", "\r\n"),
        ] {
            assert_eq!(normalize_newline(input), want, "输入 {input:?}");
        }
    }

    #[test]
    fn describe_covers_every_transport() {
        // 穷举所有变体：新增传输时这里编译不过也就提醒补 describe
        let cases = [
            ConnConfig::Serial {
                port: "COM7".into(),
                baud: 115200,
                data_bits: 8,
                parity: Default::default(),
                stop_bits: Default::default(),
                flow_control: Default::default(),
            },
            ConnConfig::TcpClient {
                host: "127.0.0.1".into(),
                port: 5000,
            },
            ConnConfig::UdpClient {
                host: "127.0.0.1".into(),
                port: 5001,
            },
            ConnConfig::Ssh {
                host: "h".into(),
                port: 22,
                username: "u".into(),
                password: String::new(),
                cols: None,
                rows: None,
            },
            ConnConfig::Telnet {
                host: "h".into(),
                port: 23,
            },
            ConnConfig::Rtt {
                probe_selector: String::new(),
                chip: "rp2040".into(),
                up_channel: 0,
                down_channel: 0,
                rtt_address: None,
            },
            ConnConfig::Winusb {
                vid: 0x1234,
                pid: 0x5678,
                interface: None,
                out_ep: 0,
                in_ep: 0,
            },
            ConnConfig::Hid {
                vid: 0x1234,
                pid: 0x5678,
                serial: None,
                report_id: 0,
                strip_report_id: true,
            },
        ];
        for c in &cases {
            let s = describe(c);
            assert!(!s.is_empty(), "{c:?} 的摘要为空");
        }
        assert!(describe(&cases[0]).contains("COM7"));
        assert!(describe(&cases[5]).contains("rp2040"));
    }

    #[test]
    fn hex_upper_is_space_separated_and_padded() {
        assert_eq!(hex_upper(&[]), "");
        assert_eq!(hex_upper(&[0x0A, 0xFF, 0x01]), "0A FF 01");
    }

    #[test]
    fn render_chunk_honours_requested_format() {
        let c = IoChunk {
            seq: 3,
            ts_ms: 1_700_000_000_000,
            dir: IoDir::Rx,
            data: b"OK\r\n".to_vec(),
        };
        let text = render_chunk(&c, "text");
        assert_eq!(text.dir, "rx");
        assert_eq!(text.text.as_deref(), Some("OK\r\n"));
        assert!(text.hex.is_none());

        let hex = render_chunk(&c, "hex");
        assert!(hex.text.is_none());
        assert_eq!(hex.hex.as_deref(), Some("4F 4B 0D 0A"));

        let both = render_chunk(&c, "both");
        assert!(both.text.is_some() && both.hex.is_some());

        // 未知形态回退到都不给（而不是 panic）
        let none = render_chunk(&c, "bogus");
        assert!(none.text.is_none() && none.hex.is_none());
    }

    #[test]
    fn render_chunk_does_not_panic_on_invalid_utf8() {
        // 串口上二进制数据是常态：必须是「有损解码」而不是 unwrap 崩溃
        let c = IoChunk {
            seq: 1,
            ts_ms: 0,
            dir: IoDir::Tx,
            data: vec![0xFF, 0xFE, 0x41],
        };
        let v = render_chunk(&c, "text");
        assert!(v.text.unwrap().contains('A'));
    }

    // ── 工具层：走真实 SessionManager（TestBackend）与真实 TCP 回环 ──

    use crate::backend::TestBackend;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn server_with(backend: TestBackend) -> MaxcomMcp {
        let backend: Arc<dyn Backend> = Arc::new(backend);
        MaxcomMcp::new(backend)
    }

    /// 回显服务器：收到什么原样回什么（单连接逐批处理）
    fn spawn_echo_server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut s = stream;
                let _ = s.set_read_timeout(Some(Duration::from_millis(100)));
                loop {
                    let mut buf = [0u8; 1024];
                    match s.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if s.write_all(&buf[..n]).is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        });
        port
    }

    fn parse(s: &str) -> serde_json::Value {
        serde_json::from_str(s).expect("工具返回的不是合法 JSON")
    }

    fn sess(id: &str) -> SessionRef {
        SessionRef {
            session: Some(id.to_string()),
        }
    }

    #[tokio::test]
    async fn list_sessions_reports_every_backend_session() {
        let mcp = server_with(TestBackend::new().with_session("tab-1").with_session("mcp"));
        let v = parse(&mcp.list_sessions().await.unwrap());
        let ids: Vec<&str> = v
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["id"].as_str())
            .collect();
        assert_eq!(ids, vec!["mcp", "tab-1"]);
        assert_eq!(v[0]["connected"].as_bool(), Some(false));
        assert_eq!(v[0]["phase"].as_str(), Some("disconnected"));
    }

    #[tokio::test]
    async fn read_tools_reject_unknown_session_instead_of_inventing_one() {
        let mcp = server_with(TestBackend::new());
        let err = mcp
            .read_io(Parameters(ReadIoParams {
                session: Some("nope".into()),
                since_seq: None,
                max_bytes: None,
                wait_ms: None,
                format: None,
                dir: None,
            }))
            .await
            .expect_err("未知会话必须报错");
        assert!(err.contains("nope"), "错误信息应指出会话 id: {err}");
        // 关键：不能因为一次只读查询就凭空造出会话
        assert!(mcp.list_sessions().await.unwrap().trim() == "[]");
    }

    #[tokio::test]
    async fn server_info_is_self_describing_json() {
        let mcp = server_with(TestBackend::new().with_session("tab-9"));
        let v = parse(&mcp.server_info().await.unwrap());
        assert_eq!(v["name"].as_str(), Some("maxcom"));
        assert_eq!(v["default_session"].as_str(), Some(DEFAULT_SESSION));
        assert_eq!(v["sessions"].as_array().unwrap().len(), 1);
        // 工具总数应与实际注册数一致（写死数字会随加工具而漂移，故取运行时值比对下界）
        assert!(v["tool_count"].as_u64().unwrap() >= 25);
        assert!(v["transports"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t.as_str() == Some("serial")));
    }

    #[tokio::test]
    async fn send_requires_payload_and_a_live_link() {
        let mcp = server_with(TestBackend::new().with_session("mcp"));
        // 空载荷：参数校验先拦下
        let err = mcp
            .send(Parameters(SendParams {
                session: None,
                text: Some(String::new()),
                hex: None,
                newline: None,
                echo: None,
            }))
            .await
            .expect_err("空载荷应报错");
        assert!(err.contains("text"), "{err}");
        // 有载荷但没连接：错误必须来自链路而不是静默成功
        let err = mcp
            .send(Parameters(SendParams {
                session: None,
                text: Some("x".into()),
                hex: None,
                newline: None,
                echo: None,
            }))
            .await
            .expect_err("未连接时应报错");
        assert!(err.contains("连接"), "{err}");
    }

    #[tokio::test]
    async fn empty_session_read_io_returns_empty_view_without_waiting() {
        let mcp = server_with(TestBackend::new().with_session("mcp"));
        let t0 = Instant::now();
        let v = parse(
            &mcp.read_io(Parameters(ReadIoParams {
                session: None,
                since_seq: None,
                max_bytes: None,
                wait_ms: Some(0),
                format: None,
                dir: None,
            }))
            .await
            .unwrap(),
        );
        assert_eq!(v["chunks"].as_array().unwrap().len(), 0);
        assert_eq!(v["gap"].as_bool(), Some(false));
        assert_eq!(v["max_seq"].as_u64(), Some(0));
        assert!(
            t0.elapsed() < Duration::from_millis(500),
            "wait_ms=0 不应等待"
        );
    }

    #[tokio::test]
    async fn close_session_removes_it_from_the_backend() {
        let mcp = server_with(TestBackend::new().with_session("gone"));
        mcp.close_session(Parameters(CloseSessionParams {
            session: "gone".into(),
        }))
        .await
        .unwrap();
        assert_eq!(
            parse(&mcp.list_sessions().await.unwrap())
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    /// 端到端：MCP 工具 → 引擎会话 → 真实 TCP 回环。
    ///
    /// 这是本 crate 唯一覆盖「工具层 + 引擎接线」的测试，重点锁三件事：
    /// 1. `connect` 真的等到 connected 才返回（而不是发起后立刻报完成）；
    /// 2. `send` 的字节确实进了链路，`read_io` 能把 TX 与 RX 都读回来；
    /// 3. `read_io` 的续读游标语义正确（`max_seq` 之后无新块）。
    #[tokio::test]
    async fn end_to_end_connect_send_read_over_tcp_echo() {
        let port = spawn_echo_server();
        let mcp = server_with(TestBackend::new());
        let target = "e2e";

        let v = parse(
            &mcp.connect(Parameters(ConnectParams {
                session: Some(target.into()),
                config: ConnConfig::TcpClient {
                    host: "127.0.0.1".into(),
                    port,
                },
                timeout_ms: Some(5_000),
            }))
            .await
            .unwrap(),
        );
        assert_eq!(v["connected"].as_bool(), Some(true), "connect 未连上: {v}");
        assert_eq!(v["timed_out"].as_bool(), Some(false));
        assert_eq!(v["phase"].as_str(), Some("connected"));
        assert!(v["target"].as_str().unwrap().contains(&port.to_string()));

        // 发送：文本 + CRLF → 6 字节
        let v = parse(
            &mcp.send(Parameters(SendParams {
                session: Some(target.into()),
                text: Some("PING".into()),
                hex: None,
                newline: Some("crlf".into()),
                echo: None,
            }))
            .await
            .unwrap(),
        );
        assert_eq!(v["bytes"].as_u64(), Some(6));

        // 只要 RX：必须等到设备回显，而不是被自己刚写出的 TX 直接满足
        let v = parse(
            &mcp.read_io(Parameters(ReadIoParams {
                session: Some(target.into()),
                since_seq: None,
                max_bytes: None,
                wait_ms: Some(3_000),
                format: None,
                dir: Some("rx".into()),
            }))
            .await
            .unwrap(),
        );
        assert_eq!(v["dir"].as_str(), Some("rx"));
        let chunks = v["chunks"].as_array().unwrap();
        assert!(!chunks.is_empty(), "wait_ms 内未等到回显: {v}");
        assert!(chunks.iter().all(|c| c["dir"].as_str() == Some("rx")));
        let rx: String = chunks.iter().filter_map(|c| c["text"].as_str()).collect();
        assert_eq!(rx, "PING\r\n");
        let max_seq = v["max_seq"].as_u64().unwrap();
        assert!(max_seq > 0, "续读游标应指向实际返回的块");
        // dir=rx 时续读游标必须取「返回的最后一块」而非环最新序号
        assert!(v["ring_max_seq"].as_u64().unwrap() >= max_seq);

        // 双向都能读到（both 模式覆盖 TX）
        let v = parse(
            &mcp.read_io(Parameters(ReadIoParams {
                session: Some(target.into()),
                since_seq: None,
                max_bytes: None,
                wait_ms: None,
                format: Some("hex".into()),
                dir: Some("tx".into()),
            }))
            .await
            .unwrap(),
        );
        let tx_hex: String = v["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| c["hex"].as_str())
            .collect();
        assert_eq!(tx_hex, "50 49 4E 47 0D 0A", "TX 十六进制应为 PING\\r\\n");

        // 续读：从 max_seq 之后应无新块
        let v = parse(
            &mcp.read_io(Parameters(ReadIoParams {
                session: Some(target.into()),
                since_seq: Some(max_seq),
                max_bytes: None,
                wait_ms: None,
                format: None,
                dir: Some("rx".into()),
            }))
            .await
            .unwrap(),
        );
        assert_eq!(v["chunks"].as_array().unwrap().len(), 0);
        assert_eq!(v["max_seq"].as_u64(), Some(max_seq), "无新块时游标不动");

        // 统计与状态
        let v = parse(&mcp.get_stats(Parameters(sess(target))).await.unwrap());
        assert!(v["rx_bytes"].as_u64().unwrap() >= 6);
        assert!(v["tx_bytes"].as_u64().unwrap() >= 6);

        // 清空历史不影响链路
        mcp.clear_log(Parameters(sess(target))).await.unwrap();
        let v = parse(
            &mcp.read_io(Parameters(ReadIoParams {
                session: Some(target.into()),
                since_seq: None,
                max_bytes: None,
                wait_ms: None,
                format: None,
                dir: None,
            }))
            .await
            .unwrap(),
        );
        assert_eq!(v["chunks"].as_array().unwrap().len(), 0);

        // 断开后状态回落
        mcp.disconnect(Parameters(sess(target))).await.unwrap();
        let v = parse(
            &mcp.get_session_status(Parameters(sess(target)))
                .await
                .unwrap(),
        );
        assert_eq!(v["connected"].as_bool(), Some(false));
    }

    #[tokio::test]
    async fn connect_surfaces_invalid_config_as_error() {
        let mcp = server_with(TestBackend::new());
        let err = mcp
            .connect(Parameters(ConnectParams {
                session: Some("bad".into()),
                config: ConnConfig::TcpClient {
                    host: String::new(),
                    port: 0,
                },
                timeout_ms: Some(1_000),
            }))
            .await
            .expect_err("空主机应被校验拦下");
        assert!(err.contains("主机"), "{err}");
    }

    // ── 默认作用会话 = 用户当前页面（回归：MCP 与界面共用一条链路）──

    /// 回归（用户实测）：MCP 在自己另开的隐藏会话里打开串口，用户界面上既看不到，
    /// 又因为**串口是独占资源**而再点「连接」同一端口必然失败。
    ///
    /// 本测试锁的是核心不变量：MCP 的连接必须落在**界面那个 `SessionManager` 本体**上，
    /// 而不是另开一条链路 —— 因此断言的是「界面对象自己 `is_connected()`」，
    /// 而不是「MCP 返回了 connected」。后者在两条链路时同样会通过。
    #[tokio::test]
    async fn connect_through_mcp_lands_on_the_user_page_session() {
        let port = spawn_echo_server();
        let backend = Arc::new(TestBackend::new().with_session("ui-1").with_active("ui-1"));
        let ui = backend.session("ui-1").expect("界面会话应存在");
        let mcp = MaxcomMcp::new(backend.clone());

        let v = parse(
            &mcp.connect(Parameters(ConnectParams {
                session: None, // 省略 → 应落到用户当前页面
                config: ConnConfig::TcpClient {
                    host: "127.0.0.1".into(),
                    port,
                },
                timeout_ms: Some(5_000),
            }))
            .await
            .unwrap(),
        );
        assert_eq!(
            v["session"].as_str(),
            Some("ui-1"),
            "省略 session 应作用于用户页面"
        );
        assert_eq!(v["connected"].as_bool(), Some(true), "未连上: {v}");
        assert_eq!(v["on_user_page"].as_bool(), Some(true));
        assert!(
            ui.is_connected(),
            "MCP 的连接没有落到界面会话上——用户界面仍会显示未连接，且串口被别的链路占着"
        );

        // 反向：界面侧断开，MCP 立刻看到（同一条链路，双向透明）
        ui.disconnect();
        let v = parse(
            &mcp.get_session_status(Parameters(SessionRef { session: None }))
                .await
                .unwrap(),
        );
        assert_eq!(v["id"].as_str(), Some("ui-1"));
        assert_eq!(v["connected"].as_bool(), Some(false));
    }

    /// 省略 `session` 时：只读工具落在活动页面；控制类工具**不得**凭空多造一个会话。
    #[tokio::test]
    async fn default_session_is_the_active_page_not_a_spare_one() {
        let backend = Arc::new(
            TestBackend::new()
                .with_session("ui-1")
                .with_session("ui-2")
                .with_active("ui-2"),
        );
        let mcp = MaxcomMcp::new(backend.clone());

        // 只读：命中活动页 ui-2（而不是专用会话 mcp）
        let v = parse(
            &mcp.get_session_status(Parameters(SessionRef { session: None }))
                .await
                .unwrap(),
        );
        assert_eq!(v["id"].as_str(), Some("ui-2"));
        assert_eq!(v["active"].as_bool(), Some(true));

        // list_sessions 标出活动页，且只有一个
        let v = parse(&mcp.list_sessions().await.unwrap());
        let active: Vec<&str> = v
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["active"].as_bool() == Some(true))
            .filter_map(|s| s["id"].as_str())
            .collect();
        assert_eq!(active, vec!["ui-2"]);

        // 写入类：未连接故报错，但**不许**顺手创建一个 mcp 会话
        let _ = mcp
            .send(Parameters(SendParams {
                session: None,
                text: Some("x".into()),
                hex: None,
                newline: None,
                echo: None,
            }))
            .await
            .expect_err("未连接应报错");
        let after = parse(&mcp.list_sessions().await.unwrap());
        let ids: Vec<&str> = after
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["id"].as_str())
            .collect();
        assert_eq!(ids, vec!["ui-1", "ui-2"], "不应凭空多出会话");

        // server_info 如实报告默认目标
        let v = parse(&mcp.server_info().await.unwrap());
        assert_eq!(v["default_session"].as_str(), Some("ui-2"));
        assert_eq!(v["user_page_session"].as_str(), Some("ui-2"));
    }

    /// 无活动会话（前端尚未同步）时回退到专用会话 —— 与改动前行为一致，不制造回归。
    #[tokio::test]
    async fn falls_back_to_dedicated_session_without_a_user_page() {
        let mcp = server_with(TestBackend::new());
        let v = parse(&mcp.server_info().await.unwrap());
        assert_eq!(v["default_session"].as_str(), Some(DEFAULT_SESSION));
        assert!(v["user_page_session"].is_null());
    }

    /// 显式指定一个已存在的界面会话 id，应作用于它（AI 可精确指定"哪个标签页"）。
    #[tokio::test]
    async fn explicit_session_overrides_the_active_page() {
        let backend = Arc::new(
            TestBackend::new()
                .with_session("ui-1")
                .with_session("ui-2")
                .with_active("ui-2"),
        );
        let mcp = MaxcomMcp::new(backend);
        let v = parse(
            &mcp.get_session_status(Parameters(sess("ui-1")))
                .await
                .unwrap(),
        );
        assert_eq!(v["id"].as_str(), Some("ui-1"));
        assert_eq!(v["active"].as_bool(), Some(false), "ui-1 不是活动页");
    }

    /// 已连接的会话再 connect：错误信息必须直接告诉 LLM 怎么办，
    /// 而不是把引擎的「已有活动连接（单连接设计，先断开再连）」原样抛出让它猜。
    #[tokio::test]
    async fn connect_on_a_busy_session_explains_how_to_proceed() {
        let port = spawn_echo_server();
        let backend = Arc::new(TestBackend::new().with_session("ui-1").with_active("ui-1"));
        let mcp = MaxcomMcp::new(backend);
        let cfg = || ConnectParams {
            session: None,
            config: ConnConfig::TcpClient {
                host: "127.0.0.1".into(),
                port,
            },
            timeout_ms: Some(5_000),
        };
        parse(&mcp.connect(Parameters(cfg())).await.unwrap());

        let err = mcp
            .connect(Parameters(cfg()))
            .await
            .expect_err("单连接设计下重复连接应报错");
        assert!(err.contains("disconnect"), "应提示可先 disconnect: {err}");
        assert!(err.contains("session id"), "应提示可换会话 id: {err}");
    }
}
