# TERM-T02: 击键直传 + 控制字符

> 模块：terminal ｜ 依赖：TERM-T01

## 目标
实现键盘事件 → 串口发送：击键直传 + 控制字符 + 方向键（转义序列）+ Tab。

## IMPL `[详细]`

### 签名
```python
def on_key(self, key: int, modifiers: int) -> None: ...
    # key 为 ASCII/Unicode；modifiers 含 ctrl/alt/shift
def _send(self, data: bytes) -> None: ...
    # 走统一发送路径（transport 的 write）
```

### 映射表
| 输入 | 发送 |
|---|---|
| 可打印字符 | 该字符（按当前编码） |
| Ctrl+C / D / Z | 0x03 / 0x04 / 0x1A |
| 上/下/左/右 | ESC[A ESC[B ESC[D ESC[C |
| Tab | 0x09 |
| Enter | 由配置决定：0x0D / 0x0A / \r\n |
| Backspace | 0x7F 或 0x08（可配） |

### 易错点
- 方向键需 DPG 键盘回调拿到 key code 与字符，映射成 ESC 序列。
- Ctrl 组合需先于可打印字符判断。
- Enter 发送的换行形式与发送面板配置一致（ADR-0014）。

### 完成标准（DoD）
- [ ] 每种键映射测试（模拟键盘事件 → 断言发送字节）
- [ ] Ctrl 组合优先于字符
- [ ] 发送走统一路径（可 mock transport 断言）

## 禁止事项
- 不回显（本地回显属 TERM-T03）
