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

/// 服务句柄：用于取端点地址与优雅停机
#[derive(Debug)]
pub struct HttpHandle {
    /// 实际绑定地址（传端口 0 时即为内核分配的端口，测试用）
    pub local_addr: SocketAddr,
    /// 路由前缀
    pub path: String,
    shutdown: CancellationToken,
}

impl HttpHandle {
    /// MCP 端点 URL（客户端配置里填这个）
    pub fn endpoint(&self) -> String {
        format!("http://{}{}", self.local_addr, self.path)
    }

    /// 优雅停机（不阻塞调用方）
    pub fn shutdown(&self) {
        self.shutdown.cancel();
    }
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
    let listener = tokio::net::TcpListener::bind(opts.bind).await?;
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
}
