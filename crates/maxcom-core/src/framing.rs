//! 智能分包 + 时间戳（LOG-T01，移植自 `logview/framing.py`，ADR-0008）。
//!
//! 按空闲超时切分数据帧，每帧一个时间戳。时钟用单调钟（不受系统时间调整影响）。
//! 独立开关（`enabled=false`）→ 透传不封包。
//! 时间戳三种格式：绝对 `HH:MM:SS.ms` / 相对 `+ms` / 差值 `Δms`。
//! 分包是日志路径本地行为，不改原始流（ADR-0015）。

use std::time::Instant;

/// 一帧数据 + 帧开始时间戳（毫秒，monotonic 基准）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimedFrame {
    pub timestamp_ms: u64,
    pub data: Vec<u8>,
}

/// 时间戳显示模式（契约：global-config / logview）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TimestampMode {
    /// 绝对 `HH:MM:SS.ms`
    #[default]
    Absolute,
    /// 相对 `+ms`
    Relative,
    /// 差值 `Δms`
    Delta,
}

impl TimestampMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "absolute" => Some(Self::Absolute),
            "relative" => Some(Self::Relative),
            "delta" => Some(Self::Delta),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Absolute => "absolute",
            Self::Relative => "relative",
            Self::Delta => "delta",
        }
    }
}

/// 空闲超时封包器。`feed` 追加到当前帧；空闲超时/中途空闲切分新帧。
///
/// 时间源：内部单调钟（构造时刻为零点）；测试用 `*_at` 变体注入时间。
#[derive(Debug)]
pub struct TimestampManager {
    timeout_ms: u64,
    pub enabled: bool,
    buf: Vec<u8>,
    frame_start_ms: u64,
    last_activity_ms: u64,
    epoch: Instant,
}

impl TimestampManager {
    pub fn new(idle_timeout_ms: u64, enabled: bool) -> Self {
        Self {
            timeout_ms: idle_timeout_ms.max(1),
            enabled,
            buf: Vec::new(),
            frame_start_ms: 0,
            last_activity_ms: 0,
            epoch: Instant::now(),
        }
    }

    /// 内部单调钟当前毫秒（构造时刻为 0，等价 Python `time.monotonic()*1000` 的任意基准）。
    pub fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    pub fn set_idle_timeout_ms(&mut self, ms: u64) {
        self.timeout_ms = ms.max(1);
    }

    pub fn idle_timeout_ms(&self) -> u64 {
        self.timeout_ms
    }

    pub fn pending_bytes(&self) -> usize {
        self.buf.len()
    }

    /// 追加数据，返回已封好的帧（新到数据通常留在当前帧待空闲）。
    pub fn feed(&mut self, data: &[u8]) -> Vec<TimedFrame> {
        self.feed_at(data, self.now_ms())
    }

    /// `feed` 的可注入时间版本（测试用）。
    pub fn feed_at(&mut self, data: &[u8], now_ms: u64) -> Vec<TimedFrame> {
        if !self.enabled {
            return Vec::new(); // 开关关闭：不封包、不加时间戳，由调用方决定透传方式
        }
        let mut frames = Vec::new();
        // 距上次活动已超时且当前帧非空 → 先把旧帧封掉，再开新帧
        if !self.buf.is_empty() && now_ms.saturating_sub(self.last_activity_ms) >= self.timeout_ms {
            frames.push(self.seal());
        }
        if self.buf.is_empty() {
            self.frame_start_ms = now_ms;
        }
        self.buf.extend_from_slice(data);
        self.last_activity_ms = now_ms;
        frames
    }

    /// 仅更新活动时间戳（不缓存数据）。
    ///
    /// 供即时拆行的引擎使用：数据直接进下游（splitter），分包只维护空闲锚点，
    /// 不重复缓存字节（LOG-T02：分行不依赖分包）。
    pub fn touch_at(&mut self, now_ms: u64) {
        if self.buf.is_empty() {
            self.frame_start_ms = now_ms;
        }
        self.last_activity_ms = now_ms;
    }

    /// 空闲超时判定路径（数据流空闲时由定时器调用）。
    pub fn poll_at(&mut self, now_ms: u64) -> Option<TimedFrame> {
        if !self.enabled || self.buf.is_empty() {
            return None;
        }
        if now_ms.saturating_sub(self.last_activity_ms) >= self.timeout_ms {
            Some(self.seal())
        } else {
            None
        }
    }

    /// 强制封当前帧（连接关闭/清空时）。无缓冲返回 None。
    pub fn flush(&mut self) -> Option<TimedFrame> {
        if !self.enabled || self.buf.is_empty() {
            return None;
        }
        Some(self.seal())
    }

    fn seal(&mut self) -> TimedFrame {
        TimedFrame {
            timestamp_ms: self.frame_start_ms,
            data: std::mem::take(&mut self.buf),
        }
    }
}

/// 按模式格式化时间戳：absolute / relative / delta（与 Python `format_timestamp` 对齐）。
///
/// - `epoch_ms`：绝对时间基准（如程序启动时的 Unix 毫秒）；缺失按 0。
/// - `base_ms`：差值基准（前一帧时间戳）；relative 用 base 或 epoch 计算偏移。
pub fn format_timestamp(
    timestamp_ms: i64,
    mode: TimestampMode,
    epoch_ms: Option<i64>,
    base_ms: Option<i64>,
) -> String {
    match mode {
        TimestampMode::Delta => match base_ms {
            None => "+0ms".to_string(),
            Some(base) => {
                let d = timestamp_ms - base;
                if d >= 0 {
                    format!("Δ+{d}ms")
                } else {
                    format!("Δ{d}ms")
                }
            }
        },
        TimestampMode::Relative => {
            let base = base_ms.unwrap_or_else(|| epoch_ms.unwrap_or(0));
            format!("+{}ms", timestamp_ms - base)
        }
        TimestampMode::Absolute => {
            let total_ms = epoch_ms.unwrap_or(0) + timestamp_ms;
            let ms = total_ms.rem_euclid(1000);
            let total_s = total_ms.div_euclid(1000);
            let h = total_s.div_euclid(3600).rem_euclid(24);
            let m = total_s.div_euclid(60).rem_euclid(60);
            let s = total_s.rem_euclid(60);
            format!("{h:02}:{m:02}:{s:02}.{ms:03}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_split_on_idle_timeout() {
        let mut ts = TimestampManager::new(100, true);
        assert!(ts.feed_at(b"ab", 0).is_empty());
        // 未超时：继续追加，不出帧
        assert!(ts.feed_at(b"cd", 50).is_empty());
        assert_eq!(ts.pending_bytes(), 4);
        // 超时后再来数据：旧帧先封出（帧起始时间戳=旧帧开头）
        let frames = ts.feed_at(b"ef", 200);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].timestamp_ms, 0);
        assert_eq!(frames[0].data, b"abcd");
        assert_eq!(ts.pending_bytes(), 2);
        // 空闲后 poll 封帧
        let f = ts.poll_at(400).unwrap();
        assert_eq!(f.timestamp_ms, 200);
        assert_eq!(f.data, b"ef");
        assert_eq!(ts.pending_bytes(), 0);
        assert!(ts.poll_at(1000).is_none());
    }

    #[test]
    fn disabled_means_passthrough() {
        let mut ts = TimestampManager::new(10, false);
        assert!(ts.feed_at(b"abc", 0).is_empty());
        assert_eq!(ts.pending_bytes(), 0);
        assert!(ts.poll_at(999).is_none());
        assert!(ts.flush().is_none());
    }

    #[test]
    fn touch_does_not_buffer() {
        let mut ts = TimestampManager::new(10, true);
        ts.touch_at(5);
        ts.touch_at(50);
        assert_eq!(ts.pending_bytes(), 0);
        assert!(ts.poll_at(100).is_none());
        assert!(ts.flush().is_none());
    }

    #[test]
    fn timeout_floor_is_one_ms() {
        let mut ts = TimestampManager::new(0, true);
        assert_eq!(ts.idle_timeout_ms(), 1);
        ts.set_idle_timeout_ms(0);
        assert_eq!(ts.idle_timeout_ms(), 1);
    }

    #[test]
    fn timestamp_formats() {
        use TimestampMode::*;
        // absolute：epoch + monotonic 偏移
        assert_eq!(format_timestamp(0, Absolute, Some(0), None), "00:00:00.000");
        assert_eq!(
            format_timestamp(1500, Absolute, Some(3661000), None),
            "01:01:02.500"
        );
        // relative
        assert_eq!(format_timestamp(1500, Relative, None, Some(1000)), "+500ms");
        assert_eq!(format_timestamp(1500, Relative, Some(1000), None), "+500ms");
        // delta：正数带 +，负数直接符号
        assert_eq!(format_timestamp(1500, Delta, None, Some(1000)), "Δ+500ms");
        assert_eq!(format_timestamp(900, Delta, None, Some(1000)), "Δ-100ms");
        assert_eq!(format_timestamp(900, Delta, None, None), "+0ms");
    }
}
