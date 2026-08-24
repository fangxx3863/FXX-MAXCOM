//! WinUSB/libusb 类原始 USB 传输。
//!
//! 基于 `nusb`（纯 Rust USB 库）：Windows 走 WinUSB API、Linux 走 usbfs、
//! macOS 走 IOKit —— 与 libusb 语义等价但无需额外安装 libusb 运行时
//! （Windows 侧设备需装 WinUSB/libusb 驱动，可用 Zadig 替换）。
//!
//! 在选定接口的 bulk / interrupt 端点上做原始字节流读写：
//! - 读端：`nusb::io::EndpointRead`（std::io::Read），50ms 读超时 → `Ok(0)` 空闲节拍。
//! - 写端：`nusb::io::EndpointWrite`（std::io::Write），`write_all` 后 `flush` 提交。
//! - 端点选择：`out_ep`/`in_ep` 为 0 时自动挑「优先 bulk、回退 interrupt」；
//!   显式给地址则按给定端点（地址/方向/类型须与接口描述符一致，否则报错）。

use super::{ConnPair, TransportRead, TransportWrite, UsbDeviceInfo, UsbInterfaceInfo};
use nusb::descriptors::TransferType;
use nusb::transfer::{Bulk, Direction, In, Interrupt, Out};
use nusb::MaybeFuture;
use std::io::{self, Read, Write};
use std::time::Duration;

const READ_TIMEOUT: Duration = Duration::from_millis(50);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const TRANSFER_SIZE: usize = 4096;

/// 枚举所有可见 USB 设备。任何错误 → 空列表，绝不抛异常。
pub fn discover() -> Vec<UsbDeviceInfo> {
    let Ok(devs) = nusb::list_devices().wait() else {
        return Vec::new();
    };
    devs.map(|d| UsbDeviceInfo {
        vid: d.vendor_id(),
        pid: d.product_id(),
        manufacturer: d.manufacturer_string().unwrap_or_default().to_string(),
        product: d.product_string().unwrap_or_default().to_string(),
        serial: d.serial_number().unwrap_or_default().to_string(),
        interfaces: d
            .interfaces()
            .map(|i| UsbInterfaceInfo {
                number: i.interface_number(),
                class: i.class(),
                subclass: i.subclass(),
                protocol: i.protocol(),
            })
            .collect(),
    })
    .collect()
}

/// 打开 USB 设备（bulk/interrupt 原始流）。
///
/// - `interface`：`Some(n)` 指定接口号；`None` 自动挑选第一个同时含 IN/OUT
///   数据端点（bulk 或 interrupt）的接口。
/// - `out_ep` / `in_ep`：0 = 自动（优先 bulk，回退 interrupt）；否则按给定地址。
pub fn open(
    vid: u16,
    pid: u16,
    interface: Option<u8>,
    out_ep: u8,
    in_ep: u8,
) -> io::Result<ConnPair> {
    let devs = nusb::list_devices()
        .wait()
        .map_err(|e| io::Error::other(format!("USB 枚举失败: {e}")))?;
    let info = devs
        .into_iter()
        .find(|d| d.vendor_id() == vid && d.product_id() == pid)
        .ok_or_else(|| {
            io::Error::other(format!(
            "未找到设备 {vid:04X}:{pid:04X}（请检查连接；WinUSB 类设备需装 WinUSB/libusb 驱动）"
        ))
        })?;
    let product = info.product_string().unwrap_or_default().to_string();
    let device = info
        .open()
        .wait()
        .map_err(|e| io::Error::other(format!("打开设备失败: {e}")))?;

    // ── 选接口并 claim ──
    let iface = match interface {
        Some(n) => device
            .detach_and_claim_interface(n)
            .wait()
            .map_err(|e| io::Error::other(format!("claim 接口 {n} 失败: {e}")))?,
        None => {
            // 自动：逐个尝试 claim，取第一个含可用 IN/OUT 数据端点的接口
            let nums: Vec<u8> = info.interfaces().map(|i| i.interface_number()).collect();
            let mut last_err: Option<nusb::Error> = None;
            let mut chosen = None;
            for n in nums {
                match device.detach_and_claim_interface(n).wait() {
                    Ok(i) => {
                        let usable = i.descriptor().is_some_and(|d| {
                            has_data_ep(&d, Direction::In) && has_data_ep(&d, Direction::Out)
                        });
                        if usable {
                            chosen = Some(i);
                            break;
                        }
                        drop(i); // 无数据端点 → 释放继续试下一个
                    }
                    Err(e) => last_err = Some(e),
                }
            }
            chosen.ok_or_else(|| {
                io::Error::other(
                    last_err
                        .map(|e| format!("无可用接口（均 claim 失败: {e}）"))
                        .unwrap_or_else(|| "设备接口均无可用数据端点（bulk/interrupt）".into()),
                )
            })?
        }
    };

    // ── 选端点（显式地址或自动挑 bulk 优先 / interrupt 回退）──
    let desc = iface
        .descriptor()
        .ok_or_else(|| io::Error::other("读取接口描述符失败"))?;
    let out_addr = resolve_ep(&desc, Direction::Out, out_ep)?;
    let in_addr = resolve_ep(&desc, Direction::In, in_ep)?;

    let out_ty = ep_type_at(&desc, out_addr, Direction::Out)?;
    let in_ty = ep_type_at(&desc, in_addr, Direction::In)?;

    let read: Box<dyn TransportRead> = match in_ty {
        TransferType::Bulk => Box::new(UsbRead::Bulk(
            iface
                .endpoint::<Bulk, In>(in_addr)
                .map_err(|e| io::Error::other(format!("打开 IN 端点 {in_addr:02X}: {e}")))?
                .reader(TRANSFER_SIZE)
                .with_num_transfers(4)
                .with_read_timeout(READ_TIMEOUT),
        )),
        TransferType::Interrupt => Box::new(UsbRead::Interrupt(
            iface
                .endpoint::<Interrupt, In>(in_addr)
                .map_err(|e| io::Error::other(format!("打开 IN 端点 {in_addr:02X}: {e}")))?
                .reader(TRANSFER_SIZE)
                .with_num_transfers(4)
                .with_read_timeout(READ_TIMEOUT),
        )),
        _ => {
            return Err(io::Error::other(format!(
                "IN 端点 {in_addr:02X} 不是 bulk/interrupt"
            )))
        }
    };

    let write: Box<dyn TransportWrite> = match out_ty {
        TransferType::Bulk => Box::new(UsbWrite::Bulk(
            iface
                .endpoint::<Bulk, Out>(out_addr)
                .map_err(|e| io::Error::other(format!("打开 OUT 端点 {out_addr:02X}: {e}")))?
                .writer(TRANSFER_SIZE)
                .with_num_transfers(4)
                .with_write_timeout(WRITE_TIMEOUT),
        )),
        TransferType::Interrupt => Box::new(UsbWrite::Interrupt(
            iface
                .endpoint::<Interrupt, Out>(out_addr)
                .map_err(|e| io::Error::other(format!("打开 OUT 端点 {out_addr:02X}: {e}")))?
                .writer(TRANSFER_SIZE)
                .with_num_transfers(4)
                .with_write_timeout(WRITE_TIMEOUT),
        )),
        _ => {
            return Err(io::Error::other(format!(
                "OUT 端点 {out_addr:02X} 不是 bulk/interrupt"
            )))
        }
    };

    let label = if product.is_empty() {
        format!("USB {vid:04X}:{pid:04X} iface{}", iface.interface_number())
    } else {
        format!("USB {product} ({vid:04X}:{pid:04X})")
    };
    Ok(ConnPair { read, write, label })
}

/// 方向 + 传输类型是否可作数据端点（bulk 或 interrupt）
fn is_data_ep(ep: &nusb::descriptors::EndpointDescriptor) -> bool {
    matches!(
        ep.transfer_type(),
        TransferType::Bulk | TransferType::Interrupt
    )
}

fn has_data_ep(desc: &nusb::descriptors::InterfaceDescriptor, dir: Direction) -> bool {
    desc.endpoints()
        .any(|e| e.direction() == dir && is_data_ep(&e))
}

/// 解析端点地址：显式非 0 用之；0 则自动挑「优先 bulk、回退 interrupt」。
fn resolve_ep(
    desc: &nusb::descriptors::InterfaceDescriptor,
    dir: Direction,
    explicit: u8,
) -> io::Result<u8> {
    if explicit != 0 {
        return Ok(explicit);
    }
    let eps: Vec<nusb::descriptors::EndpointDescriptor> =
        desc.endpoints().filter(|e| e.direction() == dir).collect();
    let bulk = eps
        .iter()
        .find(|e| e.transfer_type() == TransferType::Bulk)
        .map(|e| e.address());
    let addr = bulk.or_else(|| {
        eps.iter()
            .find(|e| e.transfer_type() == TransferType::Interrupt)
            .map(|e| e.address())
    });
    addr.ok_or_else(|| {
        let d = if dir == Direction::In { "IN" } else { "OUT" };
        io::Error::other(format!("接口内无可用 {d} 数据端点（bulk/interrupt）"))
    })
}

/// 取指定地址端点的传输类型（校验方向）。
fn ep_type_at(
    desc: &nusb::descriptors::InterfaceDescriptor,
    addr: u8,
    dir: Direction,
) -> io::Result<TransferType> {
    desc.endpoints()
        .find(|e| e.address() == addr && e.direction() == dir)
        .map(|e| e.transfer_type())
        .ok_or_else(|| {
            let d = if dir == Direction::In { "IN" } else { "OUT" };
            io::Error::other(format!("端点 {addr:02X} 不存在或方向不是 {d}"))
        })
}

enum UsbRead {
    Bulk(nusb::io::EndpointRead<Bulk>),
    Interrupt(nusb::io::EndpointRead<Interrupt>),
}

impl TransportRead for UsbRead {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let r = match self {
            UsbRead::Bulk(r) => r.read(buf),
            UsbRead::Interrupt(r) => r.read(buf),
        };
        match r {
            // 读超时 = 本节拍无数据（对齐其它传输的 Ok(0) 空闲节拍语义）
            Err(e)
                if e.kind() == io::ErrorKind::TimedOut || e.kind() == io::ErrorKind::WouldBlock =>
            {
                Ok(0)
            }
            other => other,
        }
    }
}

enum UsbWrite {
    Bulk(nusb::io::EndpointWrite<Bulk>),
    Interrupt(nusb::io::EndpointWrite<Interrupt>),
}

impl TransportWrite for UsbWrite {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        // EndpointWrite 是缓冲写：数据可能停留在内部缓冲，flush 才提交给端点
        match self {
            UsbWrite::Bulk(w) => {
                w.write_all(data)?;
                w.flush()
            }
            UsbWrite::Interrupt(w) => {
                w.write_all(data)?;
                w.flush()
            }
        }
    }
}
