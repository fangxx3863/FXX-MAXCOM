//! probe-rs RTT（Real-Time Transfer）打印传输。
//!
//! 通过调试探针（J-Link / ST-Link / CMSIS-DAP / nRF 等，依赖 probe-rs）附着到目标芯片
//! 内存，读取 RTT 控制块中的 ring buffer，实现目标 `printf`-style 日志的实时打印。
//!
//! 方向：
//! - **读**：up channel（目标 → 主机），默认 0。
//! - **写**：down channel（主机 → 目标），默认 0；目标未暴露该通道时发送会报错。
//!
//! RTT 读/写均为**非阻塞**（读到当前可用字节即返回），所以：
//! - 读到 0 字节时稍作 sleep 再返回 `Ok(0)`，避免会话读循环空转。
//! - 写端按 RTT 空闲空间循环写入直至全部写出（`write_all` 语义）。
//!
//! 依赖提示：probe-rs 使用 `nusb`（纯 Rust USB）枚举常见探针；`cmsisdap_v1`（HID）为可选。

use super::{ConnPair, TransportRead, TransportWrite};
use probe_rs::config::{Registry, TargetSelector};
use probe_rs::probe::list::Lister;
use probe_rs::rtt::Rtt;
use probe_rs::{Permissions, Session};
use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const IDLE_SLEEP: Duration = Duration::from_millis(5);

/// 探针信息（前端下拉枚举用）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProbeInfo {
    /// 可直接回填给 `probe_selector` 的选择器串（"VID:PID" 或 "VID:PID:serial"）
    pub selector: String,
    pub identifier: String,
    pub vendor_id: String,
    pub product_id: String,
    pub serial: String,
}

/// 芯片家族（对应 probe-rs 内置 target 家族；前端 chip 下拉候选用）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChipFamilyInfo {
    /// 家族名，如 "nRF52840"、"STM32F1"（对应 `probe-rs chip list` 的族标题）
    pub family: String,
    /// 该家族下可附着的目标芯片名列表（即传给 `attach` / `TargetSelector` 的 base 名）
    pub variants: Vec<String>,
}

/// 共享状态：探针会话 + RTT 接口。二者都需 `&mut`，用一把锁串行化。
struct RttState {
    session: Session,
    rtt: Rtt,
}

/// 按选择器打开调试探针并附着到目标芯片（RTT 与烧录共用）。
///
/// `chip` 为空字符串或 "auto" 时，让 probe-rs 自动识别目标芯片
/// （读取 ROM table / 目标 ID 信息，见 `TargetSelector::Auto`）。
pub(crate) fn attach_session(probe_selector: &str, chip: &str) -> io::Result<Session> {
    let use_auto = chip.trim().is_empty() || chip.trim().eq_ignore_ascii_case("auto");
    let target: TargetSelector = if use_auto {
        TargetSelector::Auto
    } else {
        TargetSelector::Unspecified(chip.trim().to_string())
    };

    let probe = if probe_selector.trim().is_empty() {
        let list = Lister::new();
        let probes = list.list_all();
        if probes.is_empty() {
            return Err(io::Error::other("未找到调试探针（请检查 USB 连接/驱动）"));
        }
        probes[0]
            .open()
            .map_err(|e| io::Error::other(format!("打开探针失败: {e}")))?
    } else {
        let selector: probe_rs::probe::DebugProbeSelector =
            probe_selector.parse().map_err(|_| {
                io::Error::other("探针选择器格式错误（应为 VID:PID 或 VID:PID:serial）")
            })?;
        Lister::new()
            .open(selector)
            .map_err(|e| io::Error::other(format!("打开探针失败: {e}")))?
    };

    probe.attach(target, Permissions::default()).map_err(|e| {
        let detail = if use_auto {
            format!("目标芯片自动识别失败: {e}")
        } else {
            format!("附着芯片 {} 失败: {e}", chip.trim())
        };
        io::Error::other(detail)
    })
}

pub fn open(
    probe_selector: &str,
    chip: &str,
    up_channel: usize,
    down_channel: usize,
    rtt_address: Option<u64>,
) -> io::Result<ConnPair> {
    // 空芯片名 / "auto" → 自动识别目标芯片（attach_session 处理）
    let mut session = attach_session(probe_selector, chip)?;

    let mut rtt = match rtt_address {
        Some(addr) => {
            let mut core = session
                .core(0)
                .map_err(|e| io::Error::other(e.to_string()))?;
            Rtt::attach_at(&mut core, addr)
        }
        None => {
            let mut core = session
                .core(0)
                .map_err(|e| io::Error::other(e.to_string()))?;
            Rtt::attach(&mut core)
        }
    }
    .map_err(|e| {
        io::Error::other(format!(
            "RTT 控制块查找失败: {e}（确认目标程序已运行 rtt_init；或指定 RTT 地址）"
        ))
    })?;

    // 校验 up 通道存在（不存在则尽早报错）
    if rtt.up_channel(up_channel).is_none() {
        return Err(io::Error::other(format!(
            "RTT up 通道 {up_channel} 不存在（可用通道请见探针信息）"
        )));
    }

    let state = Arc::new(Mutex::new(RttState { session, rtt }));

    Ok(ConnPair {
        read: Box::new(RttRead {
            state: state.clone(),
            up_channel,
        }),
        write: Box::new(RttWrite {
            state,
            down_channel,
        }),
        label: if chip.trim().is_empty() {
            format!("RTT(自动)#{up_channel}")
        } else {
            format!("RTT {chip}#{up_channel}")
        },
    })
}

/// 枚举当前可用的调试探针。任何错误 → 空列表，绝不抛异常。
pub fn discover_probes() -> Vec<ProbeInfo> {
    Lister::new()
        .list_all()
        .into_iter()
        .map(|p| ProbeInfo {
            selector: {
                let mut s = format!("{:04x}:{:04x}", p.vendor_id, p.product_id);
                if let Some(serial) = &p.serial_number {
                    s.push(':');
                    s.push_str(serial);
                }
                s
            },
            identifier: p.identifier.clone(),
            vendor_id: format!("{:04x}", p.vendor_id),
            product_id: format!("{:04x}", p.product_id),
            serial: p.serial_number.clone().unwrap_or_default(),
        })
        .collect()
}

/// 列出所有内置目标芯片（家族 → 变体），与 `probe-rs chip list` 同源。
/// 任何错误 → 空列表，绝不抛异常。
pub fn chip_list() -> Vec<ChipFamilyInfo> {
    Registry::from_builtin_families()
        .families()
        .iter()
        .map(|f| ChipFamilyInfo {
            family: f.name.clone(),
            variants: f.variants().iter().map(|c| c.name.clone()).collect(),
        })
        .collect()
}

fn probe_to_io(e: impl std::fmt::Display) -> io::Error {
    io::Error::other(e.to_string())
}

struct RttRead {
    state: Arc<Mutex<RttState>>,
    up_channel: usize,
}

impl TransportRead for RttRead {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut st = self
            .state
            .lock()
            .map_err(|_| io::Error::other("锁已污染"))?;
        let RttState { session, rtt } = &mut *st;
        let mut core = session.core(0).map_err(probe_to_io)?;
        let ch = rtt
            .up_channel(self.up_channel)
            .ok_or_else(|| io::Error::other(format!("RTT up 通道 {} 不存在", self.up_channel)))?;
        match ch.read(&mut core, buf) {
            Ok(0) => {
                std::thread::sleep(IDLE_SLEEP);
                Ok(0) // 空闲节拍
            }
            Ok(n) => Ok(n),
            Err(e) => Err(probe_to_io(e)),
        }
    }
}

struct RttWrite {
    state: Arc<Mutex<RttState>>,
    down_channel: usize,
}

impl TransportWrite for RttWrite {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        let mut st = self
            .state
            .lock()
            .map_err(|_| io::Error::other("锁已污染"))?;
        let RttState { session, rtt } = &mut *st;
        let mut core = session.core(0).map_err(probe_to_io)?;
        let ch = rtt.down_channel(self.down_channel).ok_or_else(|| {
            io::Error::other(format!("RTT down 通道 {} 不存在", self.down_channel))
        })?;
        let mut remaining = data;
        while !remaining.is_empty() {
            let n = ch.write(&mut core, remaining).map_err(probe_to_io)?;
            if n == 0 {
                return Err(io::Error::other("RTT down 通道缓冲区已满"));
            }
            remaining = &remaining[n..];
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内置 target 芯片列表应由 probe-rs 提供，且非空（不为空才能支持芯片下拉）。
    #[test]
    fn chip_list_is_populated() {
        let list = chip_list();
        assert!(!list.is_empty(), "probe-rs 内置 target 列表不应为空");
        assert!(list.iter().all(|f| !f.family.is_empty()));
        // 常见家族应存在（大小写不敏感；至少能按前缀命中变体）
        let names: Vec<String> = list
            .iter()
            .flat_map(|f| f.variants.iter().cloned())
            .map(|n| n.to_ascii_lowercase())
            .collect();
        for probe in ["nrf52840", "rp2040", "stm32f103"] {
            assert!(
                names.iter().any(|n| n.starts_with(probe)),
                "缺少常见芯片 `{probe}`"
            );
        }
    }
}
