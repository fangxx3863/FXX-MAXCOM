# PRJ-T03: 会话恢复

> 模块：project ｜ 依赖：PRJ-T02, TP-T02

## 目标
打开项目 → 恢复所有配置 → 自动连接串口。

## IMPL `[骨架]`

### 签名
```python
class SessionManager:
    def restore(self, bundle: ProjectBundle) -> None:
        # 应用传输/命令/过滤/绘图配置，连接传输
    def save_session(self) -> ProjectBundle:
        # 收集当前运行状态打包
```

### 完成标准（DoD）
- [ ] 打开项目自动连接
- [ ] 命令/过滤/绘图配置恢复
- [ ] 连接失败提示不崩溃

## 禁止事项
- 恢复顺序：先配置后连接（依赖 TransportConfig）
