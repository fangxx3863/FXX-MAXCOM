# TP-T03: 端口别名 / 黑名单 / 记忆

> 模块：transport ｜ 依赖：TP-T02, T0-T06

## 目标
实现端口别名、黑名单（屏蔽蓝牙串口）、记忆每个端口上次配置（波特率等），存于全局配置。

## IMPL `[骨架]`

### 签名
```python
class PortRegistry:
    def __init__(self, cfg: ConfigManager): ...
    def set_alias(self, port: str, alias: str) -> None: ...
    def get_alias(self, port: str) -> str: ...
    def blacklist_add(self, port: str) -> None: ...
    def is_blacklisted(self, port: str) -> bool: ...
    def remember_config(self, port: str, cfg: TransportConfig) -> None: ...
    def recall_config(self, port: str) -> TransportConfig | None: ...
    def visible_ports(self) -> list[PortInfo]: ...
        # 枚举结果过滤黑名单 + 套别名
```

### 完成标准（DoD）
- [ ] 别名设置/读取持久化
- [ ] 黑名单过滤枚举
- [ ] 端口配置记忆/恢复（再次打开自动恢复波特率）

## 禁止事项
- 不把端口数据存进项目配置（属全局用户偏好）
