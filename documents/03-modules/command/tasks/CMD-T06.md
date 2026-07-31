# CMD-T06: 响应等待（极简版，O7 待确认）

> 模块：command ｜ 依赖：CMD-T02 ｜ 状态：待确认（O7）

## 目标
发送命令后等待特定响应，自动判断结果。（O7：冻结为"发送后读一次匹配"极简版，避免退化为自动化/回归测试框架。）

## 待确认内容
- 范围是否仅为：发送 → 读一次接收流 → 匹配 expect → 显示 OK/超时。
- 是否支持条件重发/脚本化（倾向：**不支持**，V1）。

## IMPL（极简版定案后）`[骨架]`

### 签名
```python
def send_and_expect(self, cmd: Command) -> ExpectResult:
    # 发送 → 等待匹配 expect（timeout_ms）→ 返回 matched/timeout
```

### 完成标准（DoD）
- [ ] 发送后匹配 expect 判定
- [ ] 超时处理
