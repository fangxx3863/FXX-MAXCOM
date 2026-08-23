// 烧录页：probe-rs 固件烧录 + 一键“烧录并打开 RTT”。
// 探针/芯片/格式使用与顶栏一致的自绘下拉；浏览器演示模式可正常点击（模拟成功）。
// 芯片候选来自 probe-rs 内置 target 列表（list_chips），并支持“自动检测”由探针识别目标。

import { createDropdown, type DropdownHandle } from "../dropdown";
import { IS_TAURI, flashFirmware, listChips, listProbes, pickFirmwarePath } from "../api";
import { flattenChips, withAuto } from "../chips";
import type { FlashConfig } from "../types";

export interface RttDefaults {
  up_channel: number;
  down_channel: number;
  rtt_address: number | null;
}

export interface FlashRunConfig {
  probe_selector: string;
  chip: string;
  up_channel: number;
  down_channel: number;
  rtt_address: number | null;
}

export class FlashPage {
  private root: HTMLElement;
  private onRun: (cfg: FlashRunConfig) => void;
  private getRttDefaults: () => RttDefaults;

  private probeDd!: DropdownHandle;
  private chipDd!: DropdownHandle;
  private formatDd!: DropdownHandle;
  private filePathEl!: HTMLInputElement;
  private fileInput!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private doBtn!: HTMLButtonElement;
  private doRunBtn!: HTMLButtonElement;
  private busy = false;

  constructor(
    root: HTMLElement,
    onRun: (cfg: FlashRunConfig) => void,
    getRttDefaults: () => RttDefaults,
  ) {
    this.root = root;
    this.onRun = onRun;
    this.getRttDefaults = getRttDefaults;

    const probeDd = createDropdown({ items: [], placeholder: "选择探针…", width: 220 });
    this.probeDd = probeDd;
    this.q<HTMLElement>("#flash-probe-dd").replaceWith(probeDd.el);

    const chipDd = createDropdown({
      items: withAuto([]),
      value: "auto",
      editable: true,
      placeholder: "芯片",
      width: 220,
    });
    this.chipDd = chipDd;
    this.q<HTMLElement>("#flash-chip-dd").replaceWith(chipDd.el);
    // 默认即“自动检测”；用 setValue 让输入框显示“自动检测”标签而非原始值 "auto"
    chipDd.setValue("auto");
    void this.loadChips();

    const formatDd = createDropdown({
      items: [
        { value: "auto", label: "自动" },
        { value: "elf", label: "ELF" },
        { value: "hex", label: "Intel HEX" },
        { value: "bin", label: "BIN" },
        { value: "uf2", label: "UF2" },
      ],
      value: "auto",
      width: 120,
    });
    this.formatDd = formatDd;
    this.q<HTMLElement>("#flash-format-dd").replaceWith(formatDd.el);

    this.filePathEl = this.q("#flash-file-path");
    this.fileInput = this.q("#flash-file-input");
    this.statusEl = this.q("#flash-status");
    this.doBtn = this.q("#flash-do");
    this.doRunBtn = this.q("#flash-do-run");

    this.q("#flash-refresh-probes").addEventListener("click", () => void this.refreshProbes());
    this.q("#flash-browse").addEventListener("click", () => void this.browse());
    this.fileInput.addEventListener("change", () => {
      const f = this.fileInput.files?.[0];
      if (f) this.filePathEl.value = IS_TAURI ? f.name : f.name;
    });
    this.doBtn.addEventListener("click", () => void this.flash(false));
    this.doRunBtn.addEventListener("click", () => void this.flash(true));
  }

  private q<T extends HTMLElement>(sel: string): T {
    return this.root.querySelector<T>(sel)!;
  }

  /** 从 probe-rs 拉取内置目标芯片候选（浏览器演示模式用少量内置列表）。 */
  private async loadChips() {
    try {
      const items = withAuto(flattenChips(await listChips()));
      const cur = this.chipDd.value;
      this.chipDd.setItems(items);
      // setItems 在“当前值不在候选”时会重置为第一项（auto）；这里回填保持用户手输芯片不被清空
      if (cur) this.chipDd.setValue(cur);
    } catch {
      /* 拉取失败时保留“自动检测”候选，仍可手动输入芯片名 */
    }
  }

  async refreshProbes() {
    try {
      const probes = await listProbes();
      this.probeDd.setItems(probes.map((p) => ({
        value: p.selector,
        label: `${p.identifier} [${p.selector}]`,
      })));
    } catch (e) {
      this.status(`探针枚举失败: ${e}`, true);
    }
  }

  private async browse() {
    const path = await pickFirmwarePath();
    if (path) {
      this.filePathEl.value = path;
      return;
    }
    // 浏览器演示/降级：用 file input 拿文件名。
    this.fileInput.click();
  }

  private config(): FlashConfig {
    const binRaw = this.q<HTMLInputElement>("#flash-bin-base").value.trim();
    const n = Number(binRaw);
    return {
      probe_selector: this.probeDd.value,
      chip: this.chipDd.value.trim(),
      path: this.filePathEl.value.trim(),
      format: this.formatDd.value,
      bin_base_address: binRaw ? (Number.isFinite(n) ? n : null) : null,
      verify: this.q<HTMLInputElement>("#flash-verify").checked,
      reset: this.q<HTMLInputElement>("#flash-reset").checked,
    };
  }

  private status(text: string, err = false) {
    this.statusEl.textContent = text;
    this.statusEl.style.color = err ? "var(--err)" : "var(--ok)";
  }

  private setBusy(b: boolean) {
    this.busy = b;
    this.doBtn.disabled = b;
    this.doRunBtn.disabled = b;
  }

  async flash(runAfter: boolean) {
    if (this.busy) return;
    const cfg = this.config();
    if (!cfg.path) return this.status("请先选择固件文件", true);

    this.setBusy(true);
    this.status(`正在烧录 ${cfg.path} …`);
    try {
      const msg = await flashFirmware(cfg);
      this.status(runAfter ? `${msg}，正在连接 RTT…` : msg);
      if (runAfter) {
        const d = this.getRttDefaults();
        this.onRun({
          probe_selector: cfg.probe_selector,
          chip: cfg.chip,
          up_channel: d.up_channel,
          down_channel: d.down_channel,
          rtt_address: d.rtt_address,
        });
      }
    } catch (e) {
      this.status(`烧录失败: ${e}`, true);
    } finally {
      this.setBusy(false);
    }
  }
}
