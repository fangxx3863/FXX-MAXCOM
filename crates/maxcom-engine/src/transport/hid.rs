//! HID 传输。
//!
//! 注意：`nusb` 不提供 HID 支持（HID 设备由操作系统 HID 驱动栈管理，不在
//! WinUSB/libusb 层），因此这里用 `hidapi` 跨平台接入 —— 与 probe-rs 驱动
//! CMSIS-DAP v1 探针同一库，Windows 走纯 Rust 原生后端，无需额外驱动。
//!
//! 语义（HID 报告传输）：
//! - 读：每个输入报告一次返回（非阻塞模式，无数据 → `Ok(0)` 空闲节拍）；
//!   默认剥掉首字节 Report ID（`strip_report_id`），单报告设备该字节恒为 0x00。
//! - 写：自动在负载前补 Report ID 字节（`report_id`，单报告设备填 0x00）。
//!   负载长度不得超过设备报告长度，否则设备侧会拒绝。

use super::{ConnPair, HidDeviceInfo, TransportRead, TransportWrite};
use hidapi::{HidApi, HidDevice};
use std::io::{self, ErrorKind};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const IDLE_SLEEP: Duration = Duration::from_millis(5);
/// 读缓冲：须不小于最大输入报告长度（HID 报告上限 64B 数据 + 1B Report ID）
const READ_BUF: usize = 4096;

/// 枚举所有 HID 设备。任何错误 → 空列表，绝不抛异常。
pub fn discover() -> Vec<HidDeviceInfo> {
    let Ok(api) = HidApi::new() else {
        return Vec::new();
    };
    api.device_list()
        .map(|d| HidDeviceInfo {
            vid: d.vendor_id(),
            pid: d.product_id(),
            manufacturer: d.manufacturer_string().unwrap_or_default().to_string(),
            product: d.product_string().unwrap_or_default().to_string(),
            serial: d.serial_number().unwrap_or_default().to_string(),
            usage_page: d.usage_page(),
            usage: d.usage(),
            interface_number: d.interface_number(),
        })
        .collect()
}

/// 打开 HID 设备。`serial` 非空时按序列号精确匹配（同 VID:PID 多设备场景），
/// 否则取第一个匹配 VID:PID 的设备。
pub fn open(
    vid: u16,
    pid: u16,
    serial: Option<&str>,
    report_id: u8,
    strip_report_id: bool,
) -> io::Result<ConnPair> {
    let api = HidApi::new().map_err(|e| io::Error::other(format!("HID 初始化失败: {e}")))?;
    let dev = match serial.map(str::trim).filter(|s| !s.is_empty()) {
        Some(sn) => api.open_serial(vid, pid, sn).map_err(|e| {
            io::Error::other(format!(
                "打开 HID 设备 {vid:04X}:{pid:04X} (SN {sn}) 失败: {e}"
            ))
        })?,
        None => api.open(vid, pid).map_err(|e| {
            io::Error::other(format!("打开 HID 设备 {vid:04X}:{pid:04X} 失败: {e}"))
        })?,
    };
    // 非阻塞：无数据立即返回 Ok(0)（跨平台确定性；不依赖 read_timeout 的平台差异实现）
    dev.set_blocking_mode(false)
        .map_err(|e| io::Error::other(format!("设置非阻塞失败: {e}")))?;

    // HidDevice 不可 Clone，读写两端共享同一句柄（HID 带宽低，互斥开销可忽略）
    let shared = Arc::new(Mutex::new(dev));
    Ok(ConnPair {
        read: Box::new(HidRead {
            dev: shared.clone(),
            strip_report_id,
        }),
        write: Box::new(HidWrite {
            dev: shared,
            report_id,
        }),
        label: format!("HID {vid:04X}:{pid:04X}"),
    })
}

struct HidRead {
    dev: Arc<Mutex<HidDevice>>,
    strip_report_id: bool,
}

impl TransportRead for HidRead {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let dev = self
            .dev
            .lock()
            .map_err(|_| io::Error::other("HID 句柄锁已污染"))?;
        let mut report = [0u8; READ_BUF];
        let n = match dev.read(&mut report) {
            Ok(0) => {
                // 非阻塞无数据：短睡一个节拍避免读循环空转
                std::thread::sleep(IDLE_SLEEP);
                return Ok(0);
            }
            Ok(n) => n,
            Err(e) => {
                return Err(io::Error::other(format!("HID 读取失败: {e}")));
            }
        };
        // 剥 Report ID：单报告设备首字节恒为 0x00，剥掉后用户看到纯净负载
        let payload = if self.strip_report_id && n > 1 {
            &report[1..n]
        } else {
            &report[..n]
        };
        let m = payload.len().min(buf.len());
        buf[..m].copy_from_slice(&payload[..m]);
        Ok(m)
    }
}

struct HidWrite {
    dev: Arc<Mutex<HidDevice>>,
    report_id: u8,
}

impl TransportWrite for HidWrite {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        // HID 写必须以 Report ID 开头（单报告设备 = 0x00）
        let mut framed = Vec::with_capacity(data.len() + 1);
        framed.push(self.report_id);
        framed.extend_from_slice(data);
        let dev = self
            .dev
            .lock()
            .map_err(|_| io::Error::other("HID 句柄锁已污染"))?;
        let mut rest = framed.as_slice();
        let mut stalled_ms = 0u32;
        while !rest.is_empty() {
            let n = match dev.write(rest) {
                Ok(0) => None,
                Ok(n) => Some(n),
                Err(e) => {
                    return Err(io::Error::new(
                        ErrorKind::Other,
                        format!(
                            "HID 写入失败: {e}（负载可能超过设备报告长度；单报告设备 Report ID 应为 0x00）"
                        ),
                    ));
                }
            };
            match n {
                Some(n) => {
                    rest = &rest[n..];
                    stalled_ms = 0;
                }
                None => {
                    std::thread::sleep(Duration::from_millis(1));
                    stalled_ms += 1;
                    if stalled_ms > 5000 {
                        return Err(io::Error::new(ErrorKind::WriteZero, "HID 写持续无进展"));
                    }
                }
            }
        }
        Ok(())
    }
}
