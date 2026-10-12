//! MCP 服务接入（ADR-0021）。
//!
//! 本模块只做两件事，工具实现全部在 `maxcom-mcp` crate 内 —— 外壳继续保持「薄胶水」：
//!
//! 1. 把 [`AppState`] 的会话表适配成 [`maxcom_mcp::Backend`]（十几行）；
//! 2. 拉起/停止**只监听回环地址**的 Streamable HTTP 服务。
//!
//! # 开关的两个层次
//!
//! - **界面开关**（设置页）：运行期生效；前端持久化后启动时同步（与窗口尺寸记忆同一模式）。
//! - **环境变量**（`MAXCOM_MCP=off`）：硬开关，优先级高于界面 —— 否则用户设了 off
//!   却被界面重新打开，「我明明关了」会变成安全错觉。
//!
//! | 变量 | 作用 |
//! |---|---|
//! | `MAXCOM_MCP` | 设为 `0`/`off`/`false`/`no`/`disable`/`disabled` → 强制关闭，界面无法覆盖 |
//! | `MAXCOM_MCP_PORT` | 监听端口（默认 [`maxcom_mcp::DEFAULT_PORT`]） |

use crate::commands::AppState;
use maxcom_engine::session::SessionManager;
use maxcom_mcp::{Backend, HttpHandle, HttpOptions, MaxcomMcp};
use serde::Serialize;
use std::sync::{Arc, Mutex, OnceLock};

/// 关闭开关：`MAXCOM_MCP=0|off|false|no|disable|disabled`
const ENV_ENABLE: &str = "MAXCOM_MCP";
/// 监听端口：`MAXCOM_MCP_PORT=8765`
const ENV_PORT: &str = "MAXCOM_MCP_PORT";

/// MCP 服务状态（`mcp_status` / `mcp_set_enabled` / `mcp_set_port` 返回，供设置页渲染）
#[derive(Debug, Clone, Serialize)]
pub struct McpStatus {
    /// 用户意图（设置页开关的位置）
    pub enabled: bool,
    /// 服务是否真的在监听。与 `enabled` 分开：启动失败时意图是「开」而实际没在跑，
    /// 界面据此显示「启动失败」而不是「已关闭」。
    pub running: bool,
    /// MCP 端点 —— 始终可计算（没在跑时给出「若开启会是这个地址」），
    /// 用户随时能复制去配客户端，不必先成功启动一次。
    pub endpoint: String,
    /// **实际**监听端口。与 `requested_port` 不同即说明发生过「端口被占 → 自动 +1」，
    /// 界面必须按这个值提示用户配客户端，否则客户端会连到没人监听的端口。
    pub port: u16,
    /// 请求（期望）的端口：来自界面设置或环境变量
    pub requested_port: u16,
    /// 请求端口是否被环境变量 `MAXCOM_MCP_PORT` 锁定（锁定后界面不可改）
    pub port_locked_by_env: bool,
    /// 最近一次启动失败原因（成功为 None）
    pub error: Option<String>,
    /// 安全说明：服务只绑定回环地址
    pub bind_scope: &'static str,
}

/// Tauri managed state：持有服务句柄与开关状态
pub struct McpService {
    inner: Mutex<Inner>,
}

struct Inner {
    /// 已启动的服务句柄；None = 未在运行（丢弃句柄不会停服务，必须显式 shutdown）
    handle: Option<HttpHandle>,
    /// 用户意图
    enabled: bool,
    /// 期望端口（供运行期开关/改端口复用；启动失败也记录）
    port: u16,
    error: Option<String>,
}

impl McpService {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                handle: None,
                enabled: false,
                port: maxcom_mcp::DEFAULT_PORT,
                error: None,
            }),
        }
    }

    pub fn status(&self) -> McpStatus {
        let g = self.inner.lock().unwrap();
        let endpoint = g
            .handle
            .as_ref()
            .map(HttpHandle::endpoint)
            .unwrap_or_else(|| format!("http://127.0.0.1:{}{}", g.port, maxcom_mcp::DEFAULT_ROUTE));
        McpStatus {
            enabled: g.enabled,
            running: g.handle.is_some(),
            endpoint,
            // 未运行时给期望端口：界面据此显示"若开启会是这个地址"
            port: g.handle.as_ref().map(|h| h.local_addr.port()).unwrap_or(g.port),
            requested_port: g.port,
            port_locked_by_env: port_from_env().is_some(),
            error: g.error.clone(),
            bind_scope: "仅本机回环（127.0.0.1），不对外网开放",
        }
    }

    /// 只停监听、不动用户意图（改端口时用：停掉旧的再按新端口拉起）
    fn shutdown_listener(&self) {
        if let Some(h) = self.inner.lock().unwrap().handle.take() {
            h.shutdown();
        }
    }

    /// 优雅停机并复位意图（幂等）
    pub fn stop(&self) {
        let mut g = self.inner.lock().unwrap();
        if let Some(h) = g.handle.take() {
            h.shutdown();
        }
        g.enabled = false;
        g.error = None;
    }

    fn set_error(&self, msg: String) {
        self.inner.lock().unwrap().error = Some(msg);
    }

    fn clear_error(&self) {
        self.inner.lock().unwrap().error = None;
    }
}

impl Default for McpService {
    fn default() -> Self {
        Self::new()
    }
}

/// 环境变量是否硬关闭 MCP（优先级高于界面开关）
pub fn disabled_by_env() -> bool {
    std::env::var(ENV_ENABLE)
        .ok()
        .map(|v| v.trim().to_ascii_lowercase())
        .is_some_and(|v| {
            matches!(
                v.as_str(),
                "0" | "off" | "false" | "no" | "disable" | "disabled"
            )
        })
}

/// 环境变量指定的监听端口（`MAXCOM_MCP_PORT`）。返回 `Some` 即表示端口被环境变量锁定，
/// 界面不可改 —— 否则用户设了环境变量却被界面按自己持久化的值改掉，"我明明设了"会变成谜题。
pub fn port_from_env() -> Option<u16> {
    std::env::var(ENV_PORT)
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
}

/// 从环境变量解析启动配置；返回 `None` 表示硬关闭（不启动）。
pub fn options_from_env() -> Option<HttpOptions> {
    if disabled_by_env() {
        return None;
    }
    Some(HttpOptions::with_port(
        port_from_env().unwrap_or(maxcom_mcp::DEFAULT_PORT),
    ))
}

/// 设置期望端口（设置页）。端口没变则空转；正在运行时需要**重启监听**才能生效。
/// 环境变量锁定端口时拒绝并说明原因。
pub fn set_port(svc: &McpService, state: AppState, port: u16) -> McpStatus {
    if port_from_env().is_some() {
        svc.set_error(format!(
            "端口已被环境变量 {ENV_PORT} 指定，界面无法更改（删除该变量后即可在界面设置）"
        ));
        return svc.status();
    }
    if port == 0 {
        svc.set_error("端口需在 1~65535 之间".into());
        return svc.status();
    }

    let (was_running, unchanged) = {
        let g = svc.inner.lock().unwrap();
        (g.handle.is_some(), g.port == port)
    };
    if unchanged {
        svc.clear_error();
        return svc.status();
    }

    // 先把期望端口落盘（未运行时到此为止，下次启用即用它）
    svc.inner.lock().unwrap().port = port;
    if was_running {
        // 改端口必须重绑：先停旧的再按新端口拉起。
        // 失败（例如新端口也不可用且自增段全被占）时，状态里的 error 会说明，界面照常显示。
        svc.shutdown_listener();
        start(svc, state, HttpOptions::with_port(port));
    }
    svc.status()
}

/// 启动 MCP 服务（已在运行则只更新意图，不重复绑定）。失败只记录状态，不影响应用启动。
pub fn start(svc: &McpService, state: AppState, opts: HttpOptions) {
    let port = opts.bind.port();
    {
        let mut g = svc.inner.lock().unwrap();
        g.enabled = true;
        g.port = port;
        if g.handle.is_some() {
            return;
        }
    }

    // 端点要等绑定完成才确定（端口为 0 时尤其），但工厂闭包在绑定前就已创建，
    // 故用 OnceLock 在两者之间传递：会话都是在绑定之后才创建的，读到的一定是终值。
    let endpoint_cell: Arc<OnceLock<String>> = Arc::new(OnceLock::new());
    let backend: Arc<dyn Backend> = Arc::new(AppBackend::new(state));
    let factory = {
        let backend = backend.clone();
        let cell = endpoint_cell.clone();
        move || {
            let endpoint = cell.get().cloned().unwrap_or_default();
            MaxcomMcp::new(backend.clone()).with_endpoint(endpoint)
        }
    };

    // serve_http 内部只做「绑定 + 起后台任务」，block_on 几乎立即返回；
    // 但必须先进 Tauri 的 tokio 运行时上下文，其内部的 tokio::spawn 才有 runtime 可用。
    let started = tauri::async_runtime::block_on(maxcom_mcp::serve_http(factory, opts));
    let mut g = svc.inner.lock().unwrap();
    match started {
        Ok(handle) => {
            let endpoint = handle.endpoint();
            let _ = endpoint_cell.set(endpoint.clone());
            eprintln!("MAXCOM MCP 服务已启动: {endpoint}（仅本机可访问）");
            g.error = None;
            g.handle = Some(handle);
        }
        Err(e) => {
            let msg = format!("端口 {port}：{e}");
            eprintln!("MAXCOM MCP 服务启动失败（{msg}）");
            g.error = Some(msg);
        }
    }
}

/// 运行期开关（设置页）。
///
/// 开 = 按期望端口拉起（含失败重试）；关 = 优雅停机。
/// 环境变量硬关闭时拒绝打开并说明原因，而不是静默忽略 —— 静默会让用户以为已经开了。
pub fn set_enabled(svc: &McpService, state: AppState, on: bool) -> McpStatus {
    if on {
        if disabled_by_env() {
            svc.set_error(format!(
                "已被环境变量 {ENV_ENABLE} 强制关闭（删除该变量后可在界面开启）"
            ));
            return svc.status();
        }
        let port = svc.inner.lock().unwrap().port;
        start(svc, state, HttpOptions::with_port(port));
    } else {
        svc.stop();
    }
    svc.status()
}

/// `AppState` → MCP [`Backend`] 适配器。
pub struct AppBackend {
    state: AppState,
}

impl AppBackend {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }
}

impl Backend for AppBackend {
    fn list_sessions(&self) -> Vec<String> {
        // 不排序：工具层统一排序，顺序确定性由那一处保证
        self.state.session_ids()
    }

    fn session(&self, id: &str) -> Option<Arc<SessionManager>> {
        self.state.get_mgr(id)
    }

    fn active_session(&self) -> Option<String> {
        self.state.active_session()
    }

    fn session_or_create(&self, id: &str) -> Arc<SessionManager> {
        // 界面已存在的会话（含用户当前查看的那个）返回原对象、事件出口仍是 TauriEvents，
        // 因此 MCP 的连接/收发会自动同步到界面上；只有「显式指定一个不存在 id」才新建，
        // 那种会话没有界面标签页，挂丢弃式出口避免每字节白做一次 base64 + emit。
        self.state
            .get_or_create_with(id, Some(Arc::new(maxcom_mcp::NullEvents)))
    }

    fn close_session(&self, id: &str) {
        self.state.close(id);
    }

    fn app_version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}
