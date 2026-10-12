//! Streamable HTTP 传输：把 [`MaxcomMcp`](crate::MaxcomMcp) 挂到 axum 上，仅监听回环地址。

use crate::server::MaxcomMcp;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use std::io;
use std::net::SocketAddr;
use tokio_util::sync::CancellationToken;

/// 默认监听端口（本机回环）
pub const DEFAULT_PORT: u16 = 8765;
/// 默认路由前缀
pub const DEFAULT_ROUTE: &str = "/mcp";

/// HTTP 服务配置
#[derive(Debug, Clone)]
pub struct HttpOptions {
    /// 监听地址。**只接受回环地址**（127.0.0.1 / ::1）——见 [`serve_http`]。
    pub bind: SocketAddr,
    /// 路由前缀，客户端 MCP 端点即 `http://<bind><path>`
    pub path: String,
}

impl Default for HttpOptions {
    fn default() -> Self {
        Self {
            bind: SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT)),
            path: DEFAULT_ROUTE.to_string(),
        }
    }
}

impl HttpOptions {
    /// 指定端口（仍为本机回环）
    pub fn with_port(port: u16) -> Self {
        Self {
            bind: SocketAddr::from(([127, 0, 0, 1], port)),
            ..Default::default()
        }
    }
}

/// 端口冲突时的自增重试上限。
///
/// 取 32：足以绕开「另一个 MAXCOM 实例 / 上一次退出后监听未及时释放」这类占住一小段
/// 端口的情形，又不会在端口被大量占用时长时间扫描、或在防火墙弹窗里刷出一长串请求。
pub const MAX_PORT_PROBES: u16 = 32;

/// 服务句柄：用于取端点地址与优雅停机
#[derive(Debug)]
pub struct HttpHandle {
    /// 实际绑定地址。**端口冲突时会被自动 +1**，所以它未必等于请求端口 ——
    /// 调用方一律以这个字段为准（见 [`HttpHandle::requested_port`]）。
    pub local_addr: SocketAddr,
    /// 请求的端口（`opts.bind.port()`）。与 `local_addr.port()` 不同即说明发生过自增。
    pub requested_port: u16,
    /// 路由前缀
    pub path: String,
    shutdown: CancellationToken,
}

impl HttpHandle {
    /// MCP 端点 URL（客户端配置里填这个）
    pub fn endpoint(&self) -> String {
        format!("http://{}{}", self.local_addr, self.path)
    }

    /// 是否因端口被占用而自增过（界面据此提示"请按实际端口配客户端"）。
    /// 请求端口为 0（交给内核分配）时不算自增 —— 那是"随便给一个"的语义。
    pub fn port_was_bumped(&self) -> bool {
        self.requested_port != 0 && self.local_addr.port() != self.requested_port
    }

    /// 优雅停机（不阻塞调用方）
    pub fn shutdown(&self) {
        self.shutdown.cancel();
    }
}

/// 绑定监听；端口被占用时**自动 +1 重试**（[`MAX_PORT_PROBES`] 次内）。
///
/// 为什么需要它：MCP 端点要填进客户端配置，而端口被占（常见于开了第二个 MAXCOM 实例，
/// 或上次退出后监听未及时释放）会让服务直接起不来 —— 用户看到的只是"启动失败"，
/// 排查成本远高于自动让一格。
///
/// 代价是**实际端口可能不等于请求端口**，因此调用方必须把实际端口回传出去
/// （[`HttpHandle::local_addr`] / [`HttpHandle::port_was_bumped`]），不能假定相等。
async fn bind_scanned(addr: SocketAddr) -> io::Result<tokio::net::TcpListener> {
    let requested = addr.port();
    // 端口 0 = 交给内核分配，本身就是"随便给一个"，不参与自增
    if requested == 0 {
        return tokio::net::TcpListener::bind(addr).await;
    }
    let mut last_in_use = None;
    for offset in 0..MAX_PORT_PROBES {
        let Some(port) = requested.checked_add(offset) else {
            break; // 已越过 65535
        };
        match tokio::net::TcpListener::bind(SocketAddr::new(addr.ip(), port)).await {
            Ok(listener) => {
                if offset > 0 {
                    eprintln!("MAXCOM MCP：端口 {requested} 被占用，已自动改用 {port}");
                }
                return Ok(listener);
            }
            // 只对"被占用"让格：权限不足（<1024）等其它错误让格也没用，直接上报
            Err(e) if e.kind() == io::ErrorKind::AddrInUse => last_in_use = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last_in_use.unwrap_or_else(|| {
        io::Error::new(
            io::ErrorKind::AddrInUse,
            format!("端口 {requested} 起连续 {MAX_PORT_PROBES} 个端口均不可用"),
        )
    }))
}

/// 启动 Streamable HTTP MCP 服务。
///
/// **安全边界（刻意做成硬约束）**：只允许绑定回环地址。这个服务能打开串口、
/// 收发任意字节、并把固件烧进目标芯片 —— 一旦监听 0.0.0.0，同网段任何人都能
/// 远程刷写你的设备。因此非回环地址直接拒绝，而不是"警告后继续"。
///
/// `factory` 每次会话调用一次（MCP 会话彼此隔离，但都共享同一个 `Backend`）。
/// 绑定成功后立即返回，服务在后台任务里跑；用 [`HttpHandle::shutdown`] 停止。
pub async fn serve_http<F>(factory: F, opts: HttpOptions) -> io::Result<HttpHandle>
where
    F: Fn() -> MaxcomMcp + Send + Sync + 'static,
{
    if !opts.bind.ip().is_loopback() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "MCP 服务仅允许绑定回环地址（当前 {}）：它可读写串口并烧录固件，绝不能暴露到网络",
                opts.bind
            ),
        ));
    }

    let shutdown = CancellationToken::new();
    let service = StreamableHttpService::new(
        move || Ok(factory()),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default().with_cancellation_token(shutdown.child_token()),
    );

    let router = axum::Router::new().nest_service(opts.path.as_str(), service);
    // 端口被占用时自动让格（见 bind_scanned）：实际端口以 local_addr 为准
    let requested_port = opts.bind.port();
    let listener = bind_scanned(opts.bind).await?;
    let local_addr = listener.local_addr()?;

    let stop = shutdown.clone();
    tokio::spawn(async move {
        let served = axum::serve(listener, router)
            .with_graceful_shutdown(async move { stop.cancelled().await })
            .await;
        if let Err(e) = served {
            eprintln!("MAXCOM MCP 服务退出: {e}");
        }
    });

    Ok(HttpHandle {
        local_addr,
        requested_port,
        path: opts.path,
        shutdown,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{Backend, TestBackend};
    use crate::server::MaxcomMcp;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn factory() -> impl Fn() -> MaxcomMcp + Send + Sync + 'static {
        let backend: Arc<dyn Backend> = Arc::new(TestBackend::new().with_session("mcp"));
        move || MaxcomMcp::new(backend.clone())
    }

    /// 非回环地址必须被**硬拒绝**（而不是警告后继续）：这个服务能开串口、发任意字节、
    /// 把固件烧进芯片，监听 `0.0.0.0` 等于把「远程刷写设备」开放给整个网段。
    #[tokio::test]
    async fn non_loopback_bind_is_refused() {
        for bad in ["0.0.0.0:0", "192.0.2.7:0"] {
            let opts = HttpOptions {
                bind: bad.parse().unwrap(),
                path: DEFAULT_ROUTE.into(),
            };
            let err = serve_http(factory(), opts)
                .await
                .expect_err("非回环地址必须被拒绝");
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
            assert!(err.to_string().contains("回环"), "{err}");
        }
    }

    #[tokio::test]
    async fn endpoint_reports_bound_port_and_default_path() {
        let handle = serve_http(factory(), HttpOptions::with_port(0))
            .await
            .expect("启动服务");
        assert!(handle.local_addr.ip().is_loopback());
        assert!(
            handle.local_addr.port() > 0,
            "端口 0 应被内核分配成真实端口"
        );
        assert_eq!(
            handle.endpoint(),
            format!("http://{}{}", handle.local_addr, DEFAULT_ROUTE)
        );
        handle.shutdown();
    }

    /// 走真实 HTTP 一次 `initialize`：证明 `nest_service` 的路由前缀、Streamable HTTP
    /// 传输与 MCP 处理链真的接通（工具层另有独立测试）。
    ///
    /// 为什么值得写：路由前缀写错（例如漏了 `/mcp`）在工具层测试里完全看不出来，
    /// 而它恰好是用户接入时的第一道关口 —— 端点填错就是连不上。
    #[tokio::test]
    async fn initialize_round_trips_over_http() {
        let handle = serve_http(factory(), HttpOptions::with_port(0))
            .await
            .expect("启动服务");
        let body = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"{}","capabilities":{{}},"clientInfo":{{"name":"maxcom-test","version":"1.0"}}}}}}"#,
            rmcp::model::ProtocolVersion::LATEST.as_str()
        );
        let req = format!(
            "POST {path} HTTP/1.1\r\nHost: {addr}\r\n\
             Content-Type: application/json\r\n\
             Accept: application/json, text/event-stream\r\n\
             Content-Length: {len}\r\nConnection: close\r\n\r\n{body}",
            path = DEFAULT_ROUTE,
            addr = handle.local_addr,
            len = body.len(),
        );

        let mut stream = tokio::net::TcpStream::connect(handle.local_addr)
            .await
            .expect("连接失败");
        stream.write_all(req.as_bytes()).await.expect("写请求失败");
        let mut resp = Vec::new();
        stream.read_to_end(&mut resp).await.expect("读响应失败");
        let text = String::from_utf8_lossy(&resp);

        let status = text.lines().next().unwrap_or_default().to_string();
        assert!(
            status.contains(" 200 "),
            "期望 HTTP 200，实际: {status}\n{text}"
        );
        // 应答必须携带 initialize 结果（协议版本 + 服务端标识）
        assert!(
            text.contains("protocolVersion"),
            "未看到 initialize 应答: {text}"
        );
        assert!(text.contains("serverInfo"), "未看到 serverInfo: {text}");

        handle.shutdown();
    }

    /// 端口被占用时**自动 +1 重试**，并且如实上报实际端口。
    ///
    /// 为什么值得测：请求端口与实际端口不一致是个容易被忽略的隐形前提 ——
    /// 只要有人（包括未来的我自己）在别处假定 `local_addr.port() == 请求端口`，
    /// 用户拿到的端点就会指向一个没人监听的端口，而现象只是客户端连不上。
    #[tokio::test]
    async fn port_conflict_auto_increments() {
        // 先找一段「base 与 base+1 可被占、base+2 空闲」的连续端口，
        // 这样断言才能精确到"+2"。不能写死具体端口号或直接用临时端口 ——
        // 端口是否空闲取决于运行环境，写死会变成环境相关的偶发失败。
        // 20000~20050 在 Windows(49152 起) 与 Linux(32768 起) 的临时端口段之外，通常整段空闲。
        let mut picked = None;
        for base in 20000u16..20050 {
            let Ok(hold1) = std::net::TcpListener::bind(("127.0.0.1", base)) else {
                continue;
            };
            let Ok(hold2) = std::net::TcpListener::bind(("127.0.0.1", base + 1)) else {
                continue;
            };
            // 只确认 base+2 当前空闲；临时监听在本语句结束即释放，交给 serve_http 去抢
            if std::net::TcpListener::bind(("127.0.0.1", base + 2)).is_err() {
                continue;
            }
            picked = Some((base, hold1, hold2));
            break;
        }
        // hold1/hold2 必须一直占着，否则自增会停在 base 或 base+1 上
        let Some((base, hold1, hold2)) = picked else {
            panic!("未找到连续 3 个空闲端口用于本测试");
        };

        let handle = serve_http(factory(), HttpOptions::with_port(base))
            .await
            .expect("应能在自增后的端口启动");
        assert_eq!(handle.requested_port, base, "请求端口应如实记录");
        assert_eq!(
            handle.local_addr.port(),
            base + 2,
            "应连续跳过两个被占端口，落到第一个空闲端口"
        );
        assert!(handle.port_was_bumped(), "应标记出发生过自增");
        assert_eq!(
            handle.endpoint(),
            format!("http://127.0.0.1:{}{}", base + 2, DEFAULT_ROUTE)
        );

        // 端点确实可达（不只是"绑定成功"）
        let stream = tokio::net::TcpStream::connect(handle.local_addr).await;
        assert!(stream.is_ok(), "自增后的端口应真的在监听");
        drop(stream);
        handle.shutdown();
        drop((hold1, hold2));
    }

    /// 端口 0（交给内核分配）不参与自增 —— 它是"随便给一个"的语义，不该被 +1 破坏。
    #[tokio::test]
    async fn ephemeral_port_is_not_bumped() {
        let handle = serve_http(factory(), HttpOptions::with_port(0))
            .await
            .expect("启动服务");
        assert_eq!(handle.requested_port, 0);
        assert!(handle.local_addr.port() > 0, "内核应分配真实端口");
        assert!(!handle.port_was_bumped(), "端口 0 语义下不应报自增");
        handle.shutdown();
    }
}
