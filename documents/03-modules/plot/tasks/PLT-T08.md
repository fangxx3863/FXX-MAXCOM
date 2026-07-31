# PLT-T08: 统计仪表盘

> 模块：plot ｜ 依赖：PLT-T01

## 目标
实现统计计算（均值/标准差/方差/峰峰值/RMS/PPM/最大最小）+ 自定义公式，以仪表盘展示。

## IMPL `[详细]`

### 签名
```python
class StatisticsProcessor:
    def __init__(self, window: int): ...
    def feed(self, samples: list[float]) -> StatsResult: ...
        # 滑动窗口统计
    @dataclass
    class StatsResult:
        mean: float; stddev: float; variance: float
        peak_to_peak: float; rms: float; ppm: float
        min_val: float; max_val: float

def custom_formula(expr: str, samples: list[float]) -> float:
    # 用户自定义计算表达式（安全 eval 白名单）
```

### 易错点
- **PPM** 依赖时间参考：此处用采样率推算（频率/时间精度评估），精度取决于时间戳（分包）精度，文档需注明。
- 滑动窗口用增量/在线算法（避免每步全量重算 O(n²)）。
- 自定义公式只允许白名单函数（安全），禁任意执行。

### 完成标准（DoD）
- [ ] 各统计量计算正确（对已知数据断言）
- [ ] 滑动窗口在线更新
- [ ] 自定义公式白名单求值 + 非法拒绝

## 禁止事项
- 统计计算放 Compute Pool，不阻塞 GUI
