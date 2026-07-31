# PLT-T06: 通道管理 + 波形/柱状渲染

> 模块：plot ｜ 依赖：PLT-T01

## 目标
实现通道管理系统（过滤/颜色/名称/独立设置）+ 波形图与柱状图渲染（DPG Plot API）。

## IMPL `[骨架]`

### 签名
```python
class ChannelManager:
    def set_channel(self, index, name, color, visible) -> None: ...
    def get_series(self, index) -> list[float]: ...

class WaveformRenderer:
    def update(self, channels: dict[int, list[float]]) -> None: ...
        # 降采样 → 推入 DPG plot
class BarRenderer:
    def update(self, channels) -> None: ...
```

### 完成标准（DoD）
- [ ] 通道过滤/颜色/名称
- [ ] 波形滚动显示 + 缩放拖拽
- [ ] 自动 Y 缩放 / 固定范围切换
- [ ] 波形 + 柱状可同时显示

## 禁止事项
- 渲染不做解析（只消费采样）
