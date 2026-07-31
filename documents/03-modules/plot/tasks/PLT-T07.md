# PLT-T07: FFT + 频谱显示

> 模块：plot ｜ 依赖：PLT-T01

## 目标
实现 FFT 频谱显示：窗口（Hann/Hamming/Blackman/None）+ numpy.fft.rfft → 幅度谱(dB) + 相位谱（Bode 图）。

## IMPL `[详细]`

### 签名
```python
class FFTProcessor:
    def __init__(self, points: int, window: str, sample_rate: float): ...
    def process(self, samples: list[float]) -> FFTResult:
        # points=1024~65536；window=hanning/hamming/blackman/rectangular
    @dataclass
    class FFTResult:
        freqs: list[float]
        magnitude_db: list[float]
        phase: list[float]
```

### 易错点
- 加窗后幅度需归一化（除以窗口系数），否则 dB 偏小。
- 单侧频谱（rfft）只取前 N/2+1 点。
- 采样率换算频率轴：freq[i] = i * fs / N。

### 完成标准（DoD）
- [ ] 不同窗口/点数 FFT 正确（对已知正弦断言峰位置/幅度）
- [ ] 幅度谱 dB + 相位谱
- [ ] 性能：65536 点 < 可接受延迟（numpy/scipy）

## 禁止事项
- FFT 计算放 Compute Pool，不阻塞 GUI/绘图线程
