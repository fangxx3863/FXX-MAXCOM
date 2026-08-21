//! 绘图引擎（PLT，ADR-0015：订阅原始流，不经分包）。
//!
//! - [`format`]：数据格式配置 DTO（契约 plot-config.schema.json，R6）
//! - [`parser`]：Simple Binary / ASCII 分隔解析器 + 数据错位跳过（INV-2 本地游标）
//! - 环形缓冲用 `ringbuffer` crate；FFT（rustfft）按里程碑 M2 接入

pub mod format;
pub mod parser;

use ringbuffer::RingBuffer;

/// 单帧采样结果：各通道一个值
pub type Frame = Vec<f64>;

/// 通道环形缓冲 + 快照下采样。
#[derive(Debug)]
pub struct ChannelStore {
    channels: Vec<ringbuffer::AllocRingBuffer<f64>>,
    capacity: usize,
}

impl ChannelStore {
    pub fn new(channel_count: usize, capacity: usize) -> Self {
        Self {
            channels: (0..channel_count).map(|_| ringbuffer::AllocRingBuffer::new(capacity)).collect(),
            capacity,
        }
    }

    pub fn channel_count(&self) -> usize {
        self.channels.len()
    }

    pub fn push_frame(&mut self, frame: &[f64]) {
        for (buf, v) in self.channels.iter_mut().zip(frame) {
            buf.push(*v);
        }
    }

    /// 通道内最近样本数（各通道同步增长）
    pub fn len(&self) -> usize {
        self.channels.first().map(ringbuffer::RingBuffer::len).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// 取某通道全部样本（旧→新）。
    pub fn series(&self, ch: usize) -> Vec<f64> {
        self.channels[ch].to_vec()
    }

    /// 下采样到最多 `max_points` 点（等距抽稀），供前端渲染（50ms 轮询一次，天然背压为零）。
    pub fn downsampled(&self, ch: usize, max_points: usize) -> Vec<f64> {
        let data = self.series(ch);
        if data.len() <= max_points || max_points == 0 {
            return data;
        }
        let step = data.len() as f64 / max_points as f64;
        (0..max_points)
            .map(|i| data[(i as f64 * step) as usize])
            .collect()
    }

    /// 通道实时统计指标（统计仪表盘 P4/PLT-T08）。
    pub fn metrics(&self, ch: usize) -> Option<ChannelMetrics> {
        let data = self.series(ch);
        if data.is_empty() {
            return None;
        }
        let n = data.len() as f64;
        let mean = data.iter().sum::<f64>() / n;
        let variance = data.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n;
        let min = data.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = data.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let rms = (data.iter().map(|v| v * v).sum::<f64>() / n).sqrt();
        Some(ChannelMetrics {
            count: data.len(),
            mean,
            std: variance.sqrt(),
            variance,
            min,
            max,
            peak_to_peak: max - min,
            rms,
        })
    }

    pub fn clear(&mut self) {
        for c in &mut self.channels {
            c.clear();
        }
    }
}

/// 单通道统计
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChannelMetrics {
    pub count: usize,
    pub mean: f64,
    pub std: f64,
    pub variance: f64,
    pub min: f64,
    pub max: f64,
    pub peak_to_peak: f64,
    pub rms: f64,
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_store_ring_and_metrics() {
        let mut store = ChannelStore::new(2, 4); // 容量 4：只留最近 4 帧
        for i in 0..6u32 {
            let i = f64::from(i);
            store.push_frame(&[i, i * 10.0]);
        }
        assert_eq!(store.len(), 4);
        assert_eq!(store.series(0), vec![2.0, 3.0, 4.0, 5.0]);
        let m = store.metrics(0).unwrap();
        assert!((m.mean - 3.5).abs() < 1e-9);
        assert!((m.peak_to_peak - 3.0).abs() < 1e-9);
        let ms: f64 = (4.0 + 9.0 + 16.0 + 25.0) / 4.0;
        assert!((m.rms - ms.sqrt()).abs() < 1e-9);
        assert!(store.metrics(0).is_some());
    }

    #[test]
    fn downsample_keeps_shape() {
        let mut store = ChannelStore::new(1, 100);
        for i in 0..100u32 {
            store.push_frame(&[f64::from(i)]);
        }
        let ds = store.downsampled(0, 10);
        assert_eq!(ds.len(), 10);
        assert_eq!(ds[0], 0.0);
        assert_eq!(*ds.last().unwrap(), 90.0); // 等距抽稀：0,10,...,90
        // 少于上限 → 原样
        assert_eq!(store.downsampled(0, 200).len(), 100);
    }

    #[test]
    fn clear_empties_store() {
        let mut store = ChannelStore::new(1, 8);
        store.push_frame(&[1.0]);
        store.clear();
        assert!(store.is_empty());
    }
}
