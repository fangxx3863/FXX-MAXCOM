//! probe-rs 固件烧录（Flash 编程）。
//!
//! 与 RTT 共用同一个探针附着逻辑（`rtt::attach_session`），通过 probe-rs 的
//! built-in formats 支持 ELF / Intel HEX / BIN / UF2 固件文件。
//!
//! 烧录成功后可选复位目标芯片；"一键运行"由前端在同一会话里继续走 RTT 连接。

use super::rtt::attach_session;
use probe_rs::flashing::{
    download_file_with_options, BinLoader, BinOptions, DownloadOptions, ElfLoader, HexLoader,
    Uf2Loader,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// 前端烧录请求 DTO（与 app/src/types.ts 的 FlashConfig 对齐）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FlashConfig {
    /// 探针选择器（"VID:PID" 或 "VID:PID:serial"，空 = 第一个探针）
    #[serde(default)]
    pub probe_selector: String,
    /// 目标芯片名，如 "nrf52840"、"rp2040"、"stm32f103ct6"
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

/// 执行一次烧录，成功返回人类可读的完成信息。
pub fn flash(config: &FlashConfig) -> Result<String, String> {
    if config.chip.trim().is_empty() {
        return Err("目标芯片为空".into());
    }
    if config.path.trim().is_empty() {
        return Err("请选择固件文件".into());
    }
    let path = Path::new(&config.path);
    if !path.is_file() {
        return Err(format!("固件文件不存在: {}", config.path));
    }

    let mut session =
        attach_session(&config.probe_selector, &config.chip).map_err(|e| e.to_string())?;

    let format = if config.format == "auto" || config.format.is_empty() {
        infer_format(path)
            .ok_or_else(|| format!("无法自动识别固件格式，请手动选择: {}", config.path))?
    } else {
        config.format.as_str()
    };

    fn opts(verify: bool) -> DownloadOptions<'static> {
        let mut o = DownloadOptions::new();
        o.verify = verify;
        o.do_chip_erase = true;
        o
    }

    let result = match format {
        "elf" => download_file_with_options(
            &mut session,
            path,
            ElfLoader(Default::default()),
            opts(config.verify),
        ),
        "hex" | "ihex" | "intelhex" => {
            download_file_with_options(&mut session, path, HexLoader, opts(config.verify))
        }
        "bin" | "binary" => download_file_with_options(
            &mut session,
            path,
            BinLoader(BinOptions {
                base_address: config.bin_base_address,
                skip: 0,
            }),
            opts(config.verify),
        ),
        "uf2" => download_file_with_options(&mut session, path, Uf2Loader, opts(config.verify)),
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
