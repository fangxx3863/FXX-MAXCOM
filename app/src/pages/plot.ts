// 绘图页：uPlot 波形（分开子图 / 单图叠加多色图例）+ 垂直柱状表（Bar Process）。
// 显示模式（波形/柱状/同屏）与布局可切换；Y 轴支持自动缩放与位宽预设；
// 每通道可调 颜色 / 显隐 / 增益 / 偏移。数据来自 Rust 引擎快照轮询。
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { PlotSnapshotDto } from "../types";
import { pickSavePath, saveTextFile } from "../api";
import { t } from "../i18n";

export const CH_COLORS = ["#4da3ff", "#33cc70", "#ffb340", "#ff5544", "#c792ea", "#33d1d1", "#f7a8b8", "#a3e635"];

export type ViewMode = "waveform" | "bars" | "both";
export type PlotLayout = "subplots" | "overlay";

/** Y 轴范围预设（key 与 main.ts 下拉 value 一致；null = 自动缩放） */
export const Y_PRESETS: Record<string, [number, number] | null> = {
  auto: null,
  s8: [-128, 127],
  u8: [0, 255],
  s16: [-32768, 32767],
  u16: [0, 65535],
  s32: [-2147483648, 2147483647],
  u32: [0, 4294967295],
  pm1: [-1, 1],
  pm100: [-100, 100],
  pm1000: [-1000, 1000],
};

interface ChState {
  visible: boolean;
  gain: number;
  offset: number;
  color: string;
}

interface Meter {
  root: HTMLElement;
  swatch: HTMLElement;
  fill: HTMLElement;
  val: HTMLElement;
  loEl: HTMLElement;
  hiEl: HTMLElement;
  lo: number;
  hi: number;
  init: boolean;
}

function cssVar(name: string): string {
  // plot-test 在纯 Node 环境运行，没有 getComputedStyle；此时回退默认暗色。
  if (typeof getComputedStyle !== "function") return "";
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "";
  } catch {
    return "";
  }
}

/** 绘图坐标轴/网格颜色跟随当前主题（浅色下网格必须浅，不能沿用深色 #23272f） */
function plotAxes(): uPlot.Axis[] {
  const grid = cssVar("--border") || "#2c313a";
  const stroke = cssVar("--fg-dim") || "#8b919c";
  return [
    { stroke, grid: { stroke: grid }, space: 60 },
    { stroke, grid: { stroke: grid }, space: 24 },
  ];
}

/** 子图最小列宽（与 styles.css 中 grid 回退值保持一致） */
const PLOT_MIN_COL = 340;
/** uPlot 标题(.u-title)实测高度：title 渲染在 canvas 之外，不占 opts.height */
const U_TITLE_H = 28;
/** uPlot 图例(.legend)估算高度：同样在画布之外（叠加布局用，实际以溢出实测闭环为准） */
const U_LEGEND_H = 26;
/** 多通道上下滚动时每个波形的最小高度，避免行高被压没导致显示异常 */
const MIN_PLOT_H = 180;

function fmtNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export class PlotPage {
  private holder: HTMLElement;
  private barsEl: HTMLElement;
  private chbar: HTMLElement;
  private info: HTMLElement;

  private plots: uPlot[] = [];
  private cells: HTMLElement[] = [];
  private overlay: uPlot | null = null;
  private meters: Meter[] = [];
  private sideBars = false;
  private chState: ChState[] = [];
  /** ASCII 表头智能识别的通道名（空 → 回退 CHn） */
  private names: string[] = [];

  private yRange: [number, number] | null = null;
  private viewMode: ViewMode = "waveform";
  private layout: PlotLayout = "subplots";

  private lastTotal = -1;
  private lastSnap: PlotSnapshotDto | null = null;

  constructor(holder: HTMLElement, controls: HTMLElement, chbar: HTMLElement) {
    this.holder = holder;
    // 多标签页下 #plot-bars 每个会话一份，必须从当前 holder 的父节作用域内取，
    // 不能全局 querySelector（否则第一张/未挂载时会拿到 null 或别人的 bars）。
    this.barsEl = holder.parentElement!.querySelector<HTMLElement>("#plot-bars")!;
    this.chbar = chbar;
    this.info = controls.querySelector<HTMLElement>("#plot-info")!;

    // 窗口/容器尺寸变化 → 重建图（防抖 150ms）
    let t: number | null = null;
    const ro = new ResizeObserver(() => {
      if (t !== null) window.clearTimeout(t);
      t = window.setTimeout(() => {
        t = null;
        if (this.viewMode !== "bars" && (this.plots.length || this.overlay)) this.rebuildAll(this.lastSnap!);
      }, 150);
    });
    ro.observe(holder);

    // 通道条事件委托（input: 颜色/增益/偏移实时；change: 显隐）
    this.chbar.addEventListener("input", (e) => this.onChInput(e));
    this.chbar.addEventListener("change", (e) => this.onChInput(e));
  }

  // ── 外部配置入口（main.ts 下拉调用）──

  setViewMode(m: ViewMode) {
    this.viewMode = m;
    this.rebuildAll(this.lastSnap);
  }

  setLayout(l: PlotLayout) {
    this.layout = l;
    this.rebuildAll(this.lastSnap);
  }

  setYRange(key: string) {
    this.yRange = Y_PRESETS[key] ?? null;
    this.rebuildAll(this.lastSnap);
  }

  /** 切到绘图页时调用：页面隐藏期间 holder 无尺寸，显示后按真实容器重建 */
  onShow() {
    requestAnimationFrame(() => {
      if (this.lastSnap) this.rebuildAll(this.lastSnap);
    });
  }

  // ── 快照轮询（main.ts 每 ~50ms 调用）──

  private labelFor(ch: number): string {
    return this.names[ch] || `CH${ch + 1}`;
  }

  update(snap: PlotSnapshotDto) {
    this.lastSnap = snap;
    const n = Math.max(1, snap.channel_count);
    this.ensureChStates(n);
    // 表头名变化（首条表头行被识别）→ 重建图与通道条
    const namesChanged =
      (snap.channel_names ?? []).join("\u{1}") !== this.names.join("\u{1}");
    this.names = snap.channel_names ?? [];
    const needWave = this.viewMode !== "bars";
    const needBars = this.viewMode !== "waveform";
    const waveOk =
      !needWave ||
      (this.layout === "overlay"
        ? !!this.overlay && this.overlay.series.length - 1 === n
        : this.plots.length === n && this.plots.length > 0);
    const barsOk = !needBars || this.meters.length === n;
    if (!waveOk || !barsOk || namesChanged || snap.total_points < this.lastTotal) {
      this.lastTotal = snap.total_points;
      this.rebuildAll(snap);
      return;
    }
    this.lastTotal = snap.total_points;
    this.syncSizes();
    if (needWave) this.updateWave(snap);
    if (needBars) this.updateBars(snap);
    this.info.textContent = t("plot.totalPoints", { n: snap.total_points });
  }

  // ── 重建 ──

  private rebuildAll(snap: PlotSnapshotDto | null) {
    if (!snap) return;
    for (const p of this.plots) p.destroy();
    this.plots = [];
    this.cells = [];
    if (this.overlay) {
      this.overlay.destroy();
      this.overlay = null;
    }
    this.meters = [];
    this.holder.replaceChildren();
    this.barsEl.replaceChildren();
    this.chbar.replaceChildren();
    const n = Math.max(1, snap.channel_count);
    this.ensureChStates(n);
    this.buildChBar();
    // 同屏 + 子图 + 通道数不多时，柱状表直接放到对应波形右侧；
    // 超多通道仍走顶部独立条，避免挤在一起。
    this.sideBars = this.viewMode === "both" && this.layout === "subplots" && n >= 1 && n <= 6;
    this.syncVisibility();
    // 先建波形（拿到格子），再把柱状嵌到右侧；顶部独立条用于纯柱状/多通道。
    if (this.viewMode !== "waveform" && !this.sideBars) this.buildBars(n);
    if (this.viewMode !== "bars") this.buildWave(n);
    if (this.sideBars) this.buildSideBars(n);
    this.update(snap); // 立即灌一次数据
  }

  private syncVisibility() {
    this.barsEl.classList.toggle("hidden", this.viewMode === "waveform" || this.sideBars);
    this.holder.classList.toggle("hidden", this.viewMode === "bars");
    // 纯柱状模式：柱状区撑满剩余空间（同屏模式下保持固定行高）
    this.barsEl.classList.toggle("full", this.viewMode === "bars" && !this.sideBars);
  }

  private buildWave(n: number) {
    void this.holder.offsetHeight; // 强制同步布局：柱状区先占位，网格再分配
    const overlay = this.layout === "overlay";
    let cols = 1, rows = 1;
    if (!overlay) {
      // 列数显式计算并与 grid 定义严格一致；平衡启发式：减列不增行则减列（4 通道 → 2×2）
      const availW = this.holder.clientWidth - 16;
      cols = Math.max(1, Math.min(n, Math.floor((availW + 8) / (PLOT_MIN_COL + 8))));
      while (cols > 1 && Math.ceil(n / (cols - 1)) <= Math.ceil(n / cols)) cols--;
      rows = Math.ceil(n / cols);
    }
    // minmax(0,1fr)：轨道可压缩到内容以下，杜绝“内容撑大行 → 反馈溢出”的死循环
    this.holder.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    // 行高使用最小高度 + auto：通道多时容器可纵向滚动，但每个波形不会压扁
    this.holder.style.gridTemplateRows = `repeat(${rows}, minmax(${MIN_PLOT_H}px, auto))`;

    const mk = (ch: number): uPlot.Series => ({
      label: this.labelFor(ch),
      stroke: this.chState[ch]?.color ?? CH_COLORS[ch % CH_COLORS.length],
      width: 1.4,
      show: this.chState[ch]?.visible ?? true,
      points: { show: false },
    });
    const scales = { x: { time: false }, ...(this.yRange ? { y: { range: this.yRange } } : {}) };

    if (overlay) {
      // 单图叠加：一个 uPlot 承载全部通道（series 数量在构造时固定），多色曲线 + 图例
      const cell = document.createElement("div");
      cell.className = "plot-cell";
      cell.dataset.overlay = "1"; // 右键菜单识别：叠加图导出全通道
      const body = document.createElement("div");
      body.className = "plot-body";
      cell.appendChild(body);
      this.holder.appendChild(cell);
      this.cells.push(cell);
      const w = Math.max(220, cell.clientWidth - 10);
      const h = Math.max(120, Math.floor(this.holder.clientHeight - 16) - 10 - U_LEGEND_H);
      const series: uPlot.Series[] = [{}, ...Array.from({ length: n }, (_, ch) => mk(ch))];
      this.overlay = new uPlot(
        {
          width: w,
          height: h,
          scales,
          padding: [18, 14, 24, 10],
          series,
          axes: plotAxes(),
          legend: { show: true },
        },
        undefined,
        body,
      );
    } else {
      // 分开子图：每通道一个 uPlot（带标题，图例隐藏）
      const estH = Math.max(
        MIN_PLOT_H,
        Math.floor((this.holder.clientHeight - 16 - (rows - 1) * 8) / rows) - 10 - U_TITLE_H,
      );
      for (let ch = 0; ch < n; ch++) {
        const cell = document.createElement("div");
        cell.className = "plot-cell sub";
        cell.classList.toggle("hidden", !(this.chState[ch]?.visible ?? true));
        cell.dataset.ch = String(ch); // 右键菜单识别：子图导出单通道
        const body = document.createElement("div");
        body.className = "plot-body";
        cell.appendChild(body);
        this.holder.appendChild(cell);
        this.cells.push(cell);
        const w = Math.max(220, cell.clientWidth - 10);
        this.plots.push(
          new uPlot(
            {
              width: w,
              height: estH,
              title: this.labelFor(ch),
              scales,
              padding: [18, 14, 24, 10],
              series: [{}, mk(ch)],
              axes: plotAxes(),
              legend: { show: false },
            },
            undefined,
            body,
          ),
        );
      }
    }
    // 布局稳定后差值精修：目标 = 格子内容高；实际 = uPlot 根高（含标题/图例）；差多少补多少
    requestAnimationFrame(() => this.fitPlots());
  }

  /** 自定义 Y 轴范围 */
  setYRangeCustom(lo: number, hi: number) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return;
    this.yRange = [lo, hi];
    this.rebuildAll(this.lastSnap);
  }

  /** 按格子实测尺寸精修所有图（宽对齐 + 高度差值补偿，标题/图例真实高度无需常数） */
  private fitPlots() {
    const all = this.overlay ? [...this.plots, this.overlay] : [...this.plots];
    for (const p of all) {
      const host = p.root.parentElement as HTMLElement | null;
      const cell = host?.closest(".plot-cell") as HTMLElement | null;
      if (!cell || !cell.clientHeight) continue;
      let targetW = Math.max(220, cell.clientWidth - 10);
      const side = host?.querySelector<HTMLElement>(".bar-side");
      if (side) {
        // 右侧柱状表占用宽度后，波形区域要相应扣除
        targetW = Math.max(220, cell.clientWidth - side.clientWidth - 6 - 10);
      }
      const inner = cell.clientHeight - 10; // 减 cell 上下 padding+border
      const delta = inner - p.root.offsetHeight; // 正=画布偏小，负=偏大
      const nextH = Math.max(80, p.height + delta);
      if (Math.abs(delta) > 2 || Math.abs(p.width - targetW) > 3) {
        p.setSize({ width: targetW, height: nextH });
      }
    }
  }

  /** 右键菜单：把子图（ch）或叠加图（null）合成为 PNG 写剪贴板，失败转下载 */
  copyChartPng(ch: number | null) {
    const cell =
      ch === null
        ? (this.cells.find((c) => c.dataset.overlay !== undefined) ?? null)
        : (this.cells.find((c) => c.dataset.ch === String(ch)) ?? null);
    if (!cell || !cell.clientWidth) return;
    const shown =
      ch === null
        ? this.chState.filter((s) => s.visible).map((s, i) => ({ label: this.labelFor(i), color: s.color }))
        : [{ label: this.labelFor(ch), color: this.chState[ch]?.color ?? CH_COLORS[0] }];
    void composePng(cell, shown).then(async (blob) => {
      if (!blob) return;
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      } catch {
        downloadBlob(blob, `maxcom_chart_${Date.now()}.png`); // WebView 不允许写图像 → 落盘兜底
      }
    });
  }

  /** 右键菜单：导出 CSV。ch=null/undefined → 全部通道；数字 → 单通道 */
  async exportCsv(ch?: number | null) {
    const snap = this.lastSnap;
    if (!snap || !snap.series.length) return;
    const idx = ch === null || ch === undefined ? snap.series.map((_, i) => i) : [ch];
    const cols = idx
      .filter((i) => i < snap.series.length)
      .map((i) => ({ name: this.labelFor(i), data: snap.series[i] }));
    const csv = makeCsv(cols);
    const name = `maxcom_plot_${Date.now()}.csv`;
    try {
      const path = await pickSavePath(name);
      if (path) {
        await saveTextFile(path, csv);
        return;
      }
    } catch {
      /* 对话框失败 → 转下载 */
    }
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), name);
  }

  private makeMeter(st: { visible: boolean; color: string }, ch: number): HTMLElement {
    const root = document.createElement("div");
    root.className = "bar-meter";
    root.classList.toggle("hidden", !(st?.visible ?? true));
    root.innerHTML =
      `<div class="bar-head"><i class="bar-swatch" style="background:${st.color}"></i>${this.labelFor(ch)}</div>` +
      `<div class="bar-track"><div class="bar-fill" style="background:${st.color}"></div><span class="bar-val">--</span></div>` +
      `<div class="bar-range"><span class="lo">--</span><span class="hi">--</span></div>`;
    this.meters.push({
      root,
      swatch: root.querySelector<HTMLElement>(".bar-swatch")!,
      fill: root.querySelector<HTMLElement>(".bar-fill")!,
      val: root.querySelector<HTMLElement>(".bar-val")!,
      loEl: root.querySelector<HTMLElement>(".lo")!,
      hiEl: root.querySelector<HTMLElement>(".hi")!,
      lo: 0,
      hi: 1,
      init: false,
    });
    return root;
  }

  private buildBars(n: number) {
    for (let ch = 0; ch < n; ch++) {
      this.barsEl.appendChild(this.makeMeter(this.chState[ch], ch));
    }
  }

  /** 同屏 + 子图：把每通道柱状表放到对应波形格子右侧 */
  private buildSideBars(n: number) {
    for (let ch = 0; ch < n; ch++) {
      const cell = this.cells[ch];
      if (!cell) continue;
      cell.classList.add("side-bars");
      const body = cell.querySelector<HTMLElement>(".plot-body");
      if (!body) continue;
      const side = document.createElement("div");
      side.className = "bar-side";
      side.appendChild(this.makeMeter(this.chState[ch], ch));
      body.appendChild(side);
    }
  }

  // ── 数据更新 ──

  /** 增益/偏移变换：v' = v*gain + offset（默认恒等时走零变换路径） */
  private transform(data: number[], ch: number): Float64Array {
    const st = this.chState[ch];
    const gain = st?.gain ?? 1;
    const off = st?.offset ?? 0;
    const arr = new Float64Array(data.length);
    if (gain === 1 && off === 0) {
      for (let i = 0; i < data.length; i++) arr[i] = data[i];
    } else {
      for (let i = 0; i < data.length; i++) arr[i] = data[i] * gain + off;
    }
    return arr;
  }

  private updateWave(snap: PlotSnapshotDto) {
    if (this.layout === "overlay" && this.overlay) {
      const series = snap.series.map((d, ch) => this.transform(d, ch));
      const L = series.length ? Math.min(...series.map((s) => s.length)) : 0;
      const xs = new Float64Array(L);
      for (let i = 0; i < L; i++) xs[i] = i;
      this.overlay.setData([xs, ...series.map((s) => s.subarray(0, L))]);
    } else {
      for (let ch = 0; ch < this.plots.length && ch < snap.series.length; ch++) {
        const d = this.transform(snap.series[ch], ch);
        const xs = new Float64Array(d.length);
        for (let i = 0; i < d.length; i++) xs[i] = i;
        this.plots[ch].setData([xs, d]);
      }
    }
  }

  private updateBars(snap: PlotSnapshotDto) {
    for (let ch = 0; ch < this.meters.length && ch < snap.series.length; ch++) {
      const data = snap.series[ch];
      if (!data.length) continue;
      const m = this.meters[ch];
      let mn = Infinity;
      let mx = -Infinity;
      for (const v of data) {
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      let pad = (mx - mn) * 0.08;
      if (!(pad > 0)) pad = Math.max(Math.abs(mx) * 0.08, 1);
      const tLo = mn - pad;
      const tHi = mx + pad;
      if (!m.init) {
        m.lo = tLo;
        m.hi = tHi;
        m.init = true;
      } else {
        // 平滑跟随，避免量程抖动
        m.lo += (tLo - m.lo) * 0.25;
        m.hi += (tHi - m.hi) * 0.25;
      }
      const latest = data[data.length - 1];
      const pct = Math.max(0, Math.min(1, (latest - m.lo) / (m.hi - m.lo || 1))) * 100;
      m.fill.style.height = pct.toFixed(1) + "%";
      m.val.textContent = fmtNum(latest);
      m.loEl.textContent = fmtNum(m.lo);
      m.hiEl.textContent = fmtNum(m.hi);
    }
  }

  /** 容器尺寸漂移兜底：与格子实测差超阈值时 setSize（宽对齐 + 高差值补偿） */
  private syncSizes() {
    this.fitPlots();
  }

  // ── 通道状态与通道条 ──

  private ensureChStates(n: number) {
    while (this.chState.length < n) {
      this.chState.push({
        visible: true,
        gain: 1,
        offset: 0,
        color: CH_COLORS[this.chState.length % CH_COLORS.length],
      });
    }
    if (this.chState.length > n) this.chState.length = n;
  }

  private buildChBar() {
    if (this.chbar.childElementCount === this.chState.length && this.chState.length > 0) return;
    const frag = document.createDocumentFragment();
    this.chState.forEach((st, i) => {
      const chip = document.createElement("div");
      chip.className = "ch-chip";
      chip.dataset.ch = String(i);
      chip.innerHTML =
        `<input type="color" class="ch-color" value="${st.color}" title="${t("plot.chColor")}" />` +
        `<span class="ch-name">${this.labelFor(i)}</span>` +
        `<label class="chk" title="${t("plot.chShow")}"><input type="checkbox" class="ch-vis" ${st.visible ? "checked" : ""} /></label>` +
        `<span class="ch-io" title="${t("plot.chGain")}">×<input type="number" class="ch-gain" value="${st.gain}" step="0.1" /></span>` +
        `<span class="ch-io" title="${t("plot.chOffset")}">+<input type="number" class="ch-off" value="${st.offset}" step="1" /></span>`;
      frag.appendChild(chip);
    });
    this.chbar.replaceChildren(frag);
    this.chbar.classList.toggle("hidden", this.chState.length === 0);
  }

  private onChInput(e: Event) {
    const target = e.target as HTMLElement;
    const chip = target.closest<HTMLElement>(".ch-chip");
    if (!chip) return;
    const i = Number(chip.dataset.ch);
    const st = this.chState[i];
    if (!st) return;
    const el = e.target as HTMLInputElement;
    if (el.classList.contains("ch-color")) {
      st.color = el.value;
      this.applyChLive(i);
    } else if (el.classList.contains("ch-vis")) {
      st.visible = el.checked;
      this.applyChLive(i);
    } else if (el.classList.contains("ch-gain")) {
      const v = Number(el.value);
      st.gain = Number.isFinite(v) && v !== 0 ? v : 1;
    } else if (el.classList.contains("ch-off")) {
      const v = Number(el.value);
      st.offset = Number.isFinite(v) ? v : 0;
    }
  }

  /** 颜色/显隐变更即时生效（不重建） */
  private applyChLive(i: number) {
    const st = this.chState[i];
    if (!st) return;
    if (this.layout === "overlay" && this.overlay) {
      const s = this.overlay.series[i + 1];
      if (s) {
        s.stroke = st.color;
        s.show = st.visible;
      }
      this.overlay.redraw();
    } else {
      const p = this.plots[i];
      if (p) {
        p.series[1].stroke = st.color;
        p.redraw();
      }
      this.cells[i]?.classList.toggle("hidden", !st.visible);
    }
    const m = this.meters[i];
    if (m) {
      m.swatch.style.background = st.color;
      m.fill.style.background = st.color;
      m.root.classList.toggle("hidden", !st.visible);
    }
  }
}

/** 把图表格子（标题 + 画布 + 图例标签）合成为一张 PNG */
async function composePng(
  cell: HTMLElement,
  series: { label: string; color: string }[],
): Promise<Blob | null> {
  const rect = cell.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const cv = document.createElement("canvas");
  cv.width = Math.round(rect.width);
  cv.height = Math.round(rect.height);
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#14161a"; // 与主题底色一致
  ctx.fillRect(0, 0, cv.width, cv.height);
  // 标题（uPlot 标题是 DOM，画布外 → 手动画）
  const title = cell.querySelector<HTMLElement>(".u-title")?.textContent ?? "";
  if (title) {
    ctx.fillStyle = "#dce0e8";
    ctx.font = '700 13px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(title, cv.width / 2, 6);
    ctx.textAlign = "left";
  }
  // 画布逐个按位置贴上
  cell.querySelectorAll("canvas").forEach((c) => {
    const r = c.getBoundingClientRect();
    ctx.drawImage(c, r.left - rect.left, r.top - rect.top, r.width, r.height);
  });
  // 图例：叠加模式的 DOM 表格不进画布，手动画色标+标签在顶部一行
  ctx.textBaseline = "middle";
  let lx = 12;
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(lx, 14);
    ctx.lineTo(lx + 16, 14);
    ctx.stroke();
    ctx.fillStyle = "#8b919c";
    ctx.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(s.label, lx + 21, 14.5);
    lx += 21 + ctx.measureText(s.label).width + 18;
    if (lx > cv.width - 60) break; // 放不下就截断
  }
  return await new Promise<Blob | null>((res) => cv.toBlob(res, "image/png"));
}

/** 列集 → CSV 文本（带 BOM 方便 Excel 识别 UTF-8） */
function makeCsv(cols: { name: string; data: number[] }[]): string {
  const rows = Math.max(0, ...cols.map((c) => c.data.length));
  const lines = [ ["idx", ...cols.map((c) => c.name)].join(",") ];
  for (let i = 0; i < rows; i++) {
    lines.push([i, ...cols.map((c) => c.data[i] ?? "")].join(","));
  }
  return "\ufeff" + lines.join("\r\n");
}

function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
