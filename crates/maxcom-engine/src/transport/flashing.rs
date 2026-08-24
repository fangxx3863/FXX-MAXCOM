//! probe-rs 固件烧录（Flash 编程）。
//!
//! 与 RTT 共用同一个探针附着逻辑（`rtt::attach_session`），通过 probe-rs 的
//! built-in formats 支持 ELF / Intel HEX / BIN / UF2 固件文件。
//!
//! 烧录成功后可选复位目标芯片；"一键运行"由前端在同一会话里继续走 RTT 连接。

use super::rtt::attach_session;
use probe_rs::flashing::{
    download_file_with_options, BinLoader, BinOptions, DownloadOptions, ElfLoader, FlashProgress,
    HexLoader, ProgressEvent, ProgressOperation, Uf2Loader,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// 前端烧录请求 DTO（与 app/src/types.ts 的 FlashConfig 对齐）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FlashConfig {
    /// 探针选择器（"VID:PID" 或 "VID:PID:serial"，空 = 第一个探针）
    #[serde(default)]
    pub probe_selector: String,
    /// 目标芯片名，如 "nrf52840"、"rp2040"、"stm32f103ct6"；空或 "auto" → probe-rs 自动识别
    pub chip: String,
    /// 固件文件绝对路径
    pub path: String,
    /// 固件格式："auto" 或 "elf" / "hex" / "bin" / "uf2"
    #[serde(default = "default_format")]
    pub format: String,
    /// BIN 文件烧录基址（仅 format=bin 有效；空 = 使用目标默认起始地址）
    #[serde(default)]
    pub bin_base_address: Option<u64>,
    /// 烧录后回读校验
    #[serde(default = "default_true")]
    pub verify: bool,
    /// 烧录完成后复位芯片
    #[serde(default = "default_true")]
    pub reset: bool,
}

fn default_format() -> String {
    "auto".into()
}

fn default_true() -> bool {
    true
}

fn infer_format(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "elf" | "out" | "axf" => Some("elf"),
        "hex" | "ihex" | "ihx" => Some("hex"),
        "bin" | "binary" => Some("bin"),
        "uf2" => Some("uf2"),
        _ => None,
    }
}

/// 烧录进度事件 DTO（前端进度条/阶段文本渲染）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlashProgressDto {
    /// 事件类型：layout | add | started | progress | finished | failed | message
    pub kind: String,
    /// 操作阶段：erase | fill | program | verify | ""（未知）
    pub operation: String,
    /// progress 时已处理字节；finished 时为该阶段总字节
    pub size: u64,
    /// 操作总量（未知为 0，前端据此显示不确定进度）
    pub total: u64,
    /// 附加消息（DiagnosticMessage / failed 详情）
    pub message: String,
}

fn op_str(op: ProgressOperation) -> String {
    match op {
        ProgressOperation::Erase => "erase".into(),
        ProgressOperation::Fill => "fill".into(),
        ProgressOperation::Program => "program".into(),
        ProgressOperation::Verify => "verify".into(),
    }
}

fn dto_of(ev: ProgressEvent) -> FlashProgressDto {
    use ProgressEvent::*;
    match ev {
        FlashLayoutReady { .. } => FlashProgressDto {
            kind: "layout".into(),
            operation: String::new(),
            size: 0,
            total: 0,
            message: String::new(),
        },
        AddProgressBar { operation, total } => FlashProgressDto {
            kind: "add".into(),
            operation: op_str(operation),
            size: 0,
            total: total.unwrap_or(0),
            message: String::new(),
        },
        Started(operation) => FlashProgressDto {
            kind: "started".into(),
            operation: op_str(operation),
            size: 0,
            total: 0,
            message: String::new(),
        },
        Progress {
            operation, size, ..
        } => FlashProgressDto {
            kind: "progress".into(),
            operation: op_str(operation),
            size,
            total: 0,
            message: String::new(),
        },
        Failed(operation) => FlashProgressDto {
            kind: "failed".into(),
            operation: op_str(operation),
            size: 0,
            total: 0,
            message: String::new(),
        },
        Finished(operation) => FlashProgressDto {
            kind: "finished".into(),
            operation: op_str(operation),
            size: 0,
            total: 0,
            message: String::new(),
        },
        DiagnosticMessage { message } => FlashProgressDto {
            kind: "message".into(),
            operation: String::new(),
            size: 0,
            total: 0,
            message,
        },
    }
}

/// 执行一次烧录，成功返回人类可读的完成信息。`on_progress` 在烧录过程中被同步回调（阶段事件）。
pub fn flash(
    config: &FlashConfig,
    mut on_progress: impl FnMut(FlashProgressDto) + Send + 'static,
) -> Result<String, String> {
    if config.path.trim().is_empty() {
        return Err("请选择固件文件".into());
    }
    let path = Path::new(&config.path);
    if !path.is_file() {
        return Err(format!("固件文件不存在: {}", config.path));
    }

    // 空芯片名 / "auto" → 让 probe-rs 自动识别目标芯片
    let chip = if config.chip.trim().is_empty() || config.chip.trim().eq_ignore_ascii_case("auto") {
        ""
    } else {
        config.chip.trim()
    };
    let mut session = attach_session(&config.probe_selector, chip).map_err(|e| e.to_string())?;

    let format = if config.format == "auto" || config.format.is_empty() {
        infer_format(path)
            .ok_or_else(|| format!("无法自动识别固件格式，请手动选择: {}", config.path))?
    } else {
        config.format.as_str()
    };

    let progress = FlashProgress::new(move |ev| on_progress(dto_of(ev)));

    fn build_opts(verify: bool, progress: FlashProgress<'static>) -> DownloadOptions<'static> {
        let mut o = DownloadOptions::new();
        o.verify = verify;
        o.do_chip_erase = true;
        o.progress = progress;
        o
    }

    let result = match format {
        "elf" => download_file_with_options(
            &mut session,
            path,
            ElfLoader(Default::default()),
            build_opts(config.verify, progress),
        ),
        "hex" | "ihex" | "intelhex" => download_file_with_options(
            &mut session,
            path,
            HexLoader,
            build_opts(config.verify, progress),
        ),
        "bin" | "binary" => download_file_with_options(
            &mut session,
            path,
            BinLoader(BinOptions {
                base_address: config.bin_base_address,
                skip: 0,
            }),
            build_opts(config.verify, progress),
        ),
        "uf2" => download_file_with_options(
            &mut session,
            path,
            Uf2Loader,
            build_opts(config.verify, progress),
        ),
        other => {
            return Err(format!("不支持的固件格式: {other}（支持 elf/hex/bin/uf2）"));
        }
    };

    result.map_err(|e| format!("烧录失败: {e}"))?;

    if config.reset {
        let mut core = session
            .core(0)
            .map_err(|e| format!("烧录后复位失败: {e}"))?;
        core.reset().map_err(|e| format!("烧录后复位失败: {e}"))?;
    }

    Ok(format!("烧录完成: {}", config.path))
}
