// 烧录页：probe-rs 固件烧录 + 一键“烧录并打开 RTT”。
// 探针/芯片/格式使用与顶栏一致的自绘下拉；浏览器演示模式可正常点击（模拟成功）。
// 芯片候选来自 probe-rs 内置 target 列表（list_chips），并支持“自动检测”由探针识别目标。

import { createDropdown, type DropdownHandle } from "../dropdown";
import { IS_TAURI, flashFirmware, listChips, listProbes, onFlashProgress, pickFirmwarePath } from "../api";
import { flattenChips, withAuto } from "../chips";
import type { FlashConfig, FlashProgressDto } from "../types";
import { t } from "../i18n";

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
  private progressWrapEl!: HTMLElement;
  private progressBarEl!: HTMLElement;
  private progressLabelEl!: HTMLElement;
  private progressTimer: number | null = null;
  private busy = false;

  constructor(
    root: HTMLElement,
    onRun: (cfg: FlashRunConfig) => void,
    getRttDefaults: () => RttDefaults,
  ) {
    this.root = root;
    this.onRun = onRun;
    this.getRttDefaults = getRttDefaults;

    const probeDd = createDropdown({ items: [], placeholder: t("conn.probe.placeholder"), width: 220 });
    this.probeDd = probeDd;
    this.q<HTMLElement>("#flash-probe-dd").replaceWith(probeDd.el);

    const chipDd = createDropdown({
      items: withAuto([]),
      value: "auto",
      editable: true,
      placeholder: t("conn.chip.placeholder"),
      width: 220,
    });
    this.chipDd = chipDd;
    this.q<HTMLElement>("#flash-chip-dd").replaceWith(chipDd.el);
    // 默认即“自动检测”；用 setValue 让输入框显示“自动检测”标签而非原始值 "auto"
    chipDd.setValue("auto");
    void this.loadChips();

    const formatDd = createDropdown({
      items: [
        { value: "auto", label: t("format.auto") },
        { value: "elf", label: "ELF" },
        { value: "hex", label: t("format.hex") },
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
    this.progressWrapEl = this.q("#flash-progress");
    this.progressBarEl = this.q("#flash-progress-bar");
    this.progressLabelEl = this.q("#flash-progress-label");
    onFlashProgress((e) => this.handleProgress(e.progress));

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
      this.status(t("probe.enumerate.error", { e }), true);
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

  /** 操作阶段 → 本地化文案（未知阶段回退到 flash.stage.prepare） */
  private opLabel(op: string): string {
    if (!op) return t("flash.stage.prepare");
    const key = `flash.stage.${op}`;
    const val = t(key);
    return val && val !== key ? val : t("flash.stage.prepare");
  }

  /** 显示/隐藏进度条；indeterminate = 总量未知（擦除/连接阶段） */
  private showProgress(show: boolean, indeterminate = false) {
    this.progressWrapEl.classList.toggle("hidden", !show);
    if (!show) {
      this.progressBarEl.style.width = "0%";
      this.progressBarEl.classList.remove("indeterminate");
      this.progressLabelEl.textContent = "";
      return;
    }
    this.progressBarEl.classList.toggle("indeterminate", indeterminate);
    if (!indeterminate) this.progressBarEl.style.width = "0%";
  }

  /** 后端 flash://progress 事件 → 更新进度条与阶段文案（仅当前烧录中的页面响应） */
  private handleProgress(p: FlashProgressDto) {
    if (!this.busy) return;
    const op = this.opLabel(p.operation);
    if (p.kind === "add") {
      this.showProgress(true, p.total <= 0);
      this.progressLabelEl.textContent = op;
      this.status(op);
    } else if (p.kind === "started" || p.kind === "progress") {
      if (p.kind === "started") this.showProgress(true, p.total <= 0);
      if (p.total > 0) {
        const pct = Math.min(100, Math.round((p.size / p.total) * 100));
        this.progressBarEl.classList.remove("indeterminate");
        this.progressBarEl.style.width = pct + "%";
        this.progressLabelEl.textContent = `${op} ${pct}%`;
        this.status(`${op} ${pct}%`);
      } else {
        this.progressBarEl.classList.add("indeterminate");
        this.progressLabelEl.textContent = op;
        this.status(op);
      }
    } else if (p.kind === "message") {
      this.progressLabelEl.textContent = p.message || op;
    } else if (p.kind === "finished") {
      this.progressBarEl.classList.remove("indeterminate");
      this.progressBarEl.style.width = "100%";
      this.progressLabelEl.textContent = t("flash.stage.done");
      if (this.progressTimer !== null) window.clearTimeout(this.progressTimer);
      this.progressTimer = window.setTimeout(() => this.showProgress(false), 1200);
    } else if (p.kind === "failed") {
      this.progressBarEl.classList.remove("indeterminate");
      this.progressBarEl.style.width = "100%";
      this.progressBarEl.style.background = "var(--err)";
      this.progressLabelEl.textContent = t("flash.stage.failed", { op });
      this.status(t("flash.stage.failed", { op }), true);
      if (this.progressTimer !== null) window.clearTimeout(this.progressTimer);
      this.progressTimer = window.setTimeout(() => {
        this.showProgress(false);
        this.progressBarEl.style.background = "";
      }, 2000);
    }
  }

  async flash(runAfter: boolean) {
    if (this.busy) return;
    const cfg = this.config();
    if (!cfg.path) return this.status(t("flash.noFile"), true);

    this.setBusy(true);
    this.progressBarEl.style.background = "";
    this.showProgress(true, true); // 先不确定进度（连接探针/擦除阶段）
    this.status(t("flash.flashing", { path: cfg.path }));
    try {
      const msg = await flashFirmware(cfg);
      this.showProgress(false);
      this.status(runAfter ? t("flash.connectingRtt", { msg }) : msg);
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
      this.showProgress(false);
      this.progressBarEl.style.background = "";
      this.status(t("flash.error", { e }), true);
    } finally {
      this.setBusy(false);
    }
  }
}
