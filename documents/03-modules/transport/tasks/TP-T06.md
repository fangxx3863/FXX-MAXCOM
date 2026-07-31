# TP-T06: TCP client/server 实现

> 模块：transport ｜ 依赖：TP-T01

## 目标
实现 TCP 客户端与服务器传输（长连接、自动重连）。对应 V2 §1.1 网络调试。

## IMPL `[骨架]`

### 签名
```python
class TcpClientTransport(TransportBase):
    def open(self, config): ...   # 连接 host:port，读线程
    def write(self, data) -> int: ...
class TcpServerTransport(TransportBase):
    def open(self, config): ...   # listen port_no，接受客户端
```

### 完成标准（DoD）
- [ ] 客户端连接/收发/断开
- [ ] 服务器 listen/接受/收发
- [ ] 断开触发 on_disconnect（客户端可重连）

## 禁止事项
- 不做 HTTP 等上层协议（裸 socket）
