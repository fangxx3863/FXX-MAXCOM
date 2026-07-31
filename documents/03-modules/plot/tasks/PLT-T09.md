# PLT-T09: 绘图配置加载 + 绘图 Viewport

> 模块：plot ｜ 依赖：PLT-T06, T0-T03

## 目标
从 `02-contracts/plot-config.schema.json` 加载绘图配置（数据格式/通道/显示），实现绘图 Viewport 组装。

## IMPL `[骨架]`

### 签名
```python
def load_plot_config(path: Path) -> PlotConfig: ...
    # 读取 plots/*.toml，pydantic 校验（PlotConfig 模型来自 contracts）
class PlotViewport:
    def __init__(self, cfg: PlotConfig): ...
    def render(self) -> None: ...
        # 按 display 组合波形/柱状/FFT/统计
```

### 完成标准（DoD）
- [ ] 配置加载 + 校验（Simple Binary/ASCII/自定义帧 oneOf 分派）
- [ ] 多绘图（多个 plots/*.toml）支持
- [ ] Viewport 组装正确

## 禁止事项
- 配置格式与契约一致；变更走 ADR
