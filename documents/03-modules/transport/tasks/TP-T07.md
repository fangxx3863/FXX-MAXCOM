# TP-T07: UDP client/server 实现

> 模块：transport ｜ 依赖：TP-T01

## 目标
实现 UDP 客户端与服务器传输（支持广播、组播）。

## IMPL `[骨架]`

### 签名
```python
class UdpClientTransport(TransportBase):
    def open(self, config): ...
    def write(self, data) -> int: ...
class UdpServerTransport(TransportBase):
    def open(self, config): ...
```

### 完成标准（DoD）
- [ ] 客户端发送/接收
- [ ] 广播（255.255.255.255）/组播地址支持
- [ ] UDP 无连接语义下收发正确

## 禁止事项
- UDP 不做重连（无连接）；收包边界天然分帧
