// 绘图页：uPlot 波形（分开子图 / 单图叠加多色图例）+ 垂直柱状表（Bar Process）。
// 显示模式（波形/柱状/同屏）与布局可切换；Y 轴支持自动缩放与位宽预设；
// 每通道可调 颜色 / 显隐 / 增益 / 偏移。数据来自 Rust 引擎快照轮询。
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { PlotSnapshotDto } from "../types";

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

const AXES: uPlot.Axis[] = [
  { stroke: "#8b919c", grid: { stroke: "#23272f" }, space: 60, label: "样本序号" },
  { stroke: "#8b919c", grid: { stroke: "#23272f" }, space: 24 },
];

/** 子图最小列宽（与 styles.css 中 grid 回退值保持一致） */
const PLOT_MIN_COL = 340;
/** uPlot 标题(.u-title)实测高度：title 渲染在 canvas 之外，不占 opts.height */
const U_TITLE_H = 28;
/** uPlot 图例(.legend)估算高度：同样在画布之外（叠加布局用，实际以溢出实测闭环为准） */
const U_LEGEND_H = 34;

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
  private chState: ChState[] = [];

  private yRange: [number, number] | null = null;
  private viewMode: ViewMode = "waveform";
  private layout: PlotLayout = "subplots";

  private lastTotal = -1;
  private lastSnap: PlotSnapshotDto | null = null;

  constructor(holder: HTMLElement, controls: HTMLElement, chbar: HTMLElement) {
    this.holder = holder;
    this.barsEl = document.querySelector<HTMLElement>("#plot-bars")!;
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

  update(snap: PlotSnapshotDto) {
    this.lastSnap = snap;
    const n = Math.max(1, snap.channel_count);
    this.ensureChStates(n);
    const needWave = this.viewMode !== "bars";
    const needBars = this.viewMode !== "waveform";
    const waveOk =
      !needWave ||
      (this.layout === "overlay"
        ? !!this.overlay && this.overlay.series.length - 1 === n
        : this.plots.length === n && this.plots.length > 0);
    const barsOk = !needBars || this.meters.length === n;
    if (!waveOk || !barsOk || snap.total_points < this.lastTotal) {
      this.lastTotal = snap.total_points;
      this.rebuildAll(snap);
      return;
    }
    this.lastTotal = snap.total_points;
    this.syncSizes();
    if (needWave) this.updateWave(snap);
    if (needBars) this.updateBars(snap);
    this.info.textContent = `总点数 ${snap.total_points}`;
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
    const n = Math.max(1, snap.channel_count);
    this.ensureChStates(n);
    this.buildChBar();
    this.syncVisibility();
    // 先建柱状（有固定高度），强制布局后再量可用高度建波形 —— 否则量到的是柱状区未占位的高度，波形必溢出
    if (this.viewMode !== "waveform") this.buildBars(n);
    if (this.viewMode !== "bars") this.buildWave(n);
    this.update(snap); // 立即灌一次数据
  }

  private syncVisibility() {
    this.barsEl.classList.toggle("hidden", this.viewMode === "waveform");
    this.holder.classList.toggle("hidden", this.viewMode === "bars");
    // 纯柱状模式：柱状区撑满剩余空间（同屏模式下保持固定行高）
    this.barsEl.classList.toggle("full", this.viewMode === "bars");
  }

  private buildWave(n: number) {
    void this.holder.offsetHeight; // 强制同步布局：确保柱状区已参与排版
    if (this.layout === "overlay") {
      // 单图叠加：全部通道进一个 uPlot，多色曲线 + 图例（无标题；图例在画布外，需扣 U_LEGEND_H）
      this.holder.style.gridTemplateColumns = "1fr";
      let h = Math.max(120, Math.floor(this.holder.clientHeight - 16) - 10 - U_LEGEND_H);
      for (let attempt = 0; ; attempt++) {
        const cell = document.createElement("div");
        cell.className = "plot-cell";
        this.holder.appendChild(cell);
        const w = Math.max(220, cell.clientWidth - 10);
        const series: uPlot.Series[] = [{}, ...this.chState.map((st, i) => (
          {
            label: `CH${i + 1}`,
            stroke: st.color,
            width: 1.4,
            show: st.visible,
            points: { show: false },
          }
        ))];
        this.overlay = new uPlot(
          {
            width: w,
            height: h,
            scales: { x: { time: false }, ...(this.yRange ? { y: { range: this.yRange } } : {}) },
            padding: [18, 14, 8, 10],
            series,
            axes: AXES,
            legend: { show: true },
          },
          undefined,
          cell,
        );
        // 实测溢出收缩闭环（与子图一致）：图例实际高度随字体/缩放浮动，以实测为准
        const over = this.holder.scrollHeight - this.holder.clientHeight;
        if (over <= 0 || attempt >= 1) break;
        h = Math.max(120, h - over - 4);
        this.overlay.destroy();
        this.overlay = null;
        this.holder.replaceChildren();
      }
    } else {
      // 分开子图：列数由容器宽显式计算（与 grid 列定义严格一致，避免 3+1 这类错排），
      // 行高均分并扣除 cell 内边距边框(10) 与 uPlot 标题高度(U_TITLE_H≈28，title 不占 opts.height!)
      const availW = this.holder.clientWidth - 16;
      let cols = Math.max(1, Math.min(n, Math.floor((availW + 8) / (PLOT_MIN_COL + 8))));
      // 平衡网格：减少列数不增加行数时就减少（4 通道 → 2×2 而非 3+1）
      while (cols > 1 && Math.ceil(n / (cols - 1)) <= Math.ceil(n / cols)) cols--;
      this.holder.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      const rows = Math.ceil(n / cols);
      let h = Math.max(
        120,
        Math.floor((this.holder.clientHeight - 16 - (rows - 1) * 8) / rows) - 10 - U_TITLE_H,
      );
      for (let attempt = 0; ; attempt++) {
        for (let ch = 0; ch < n; ch++) {
          const cell = document.createElement("div");
          cell.className = "plot-cell sub";
          cell.classList.toggle("hidden", !(this.chState[ch]?.visible ?? true));
          this.holder.appendChild(cell);
          this.cells.push(cell);
          const w = Math.max(220, cell.clientWidth - 10);
          const plot = new uPlot(
            {
              width: w,
              height: h,
              title: `CH${ch + 1}`,
              scales: { x: { time: false }, ...(this.yRange ? { y: { range: this.yRange } } : {}) },
              padding: [18, 14, 8, 10],
              series: [{}, {
                label: `CH${ch + 1}`,
                stroke: this.chState[ch]?.color ?? CH_COLORS[ch % CH_COLORS.length],
                width: 1.4,
                points: { show: false },
              }],
              axes: AXES,
              legend: { show: false },
            },
            undefined,
            cell,
          );
          this.plots.push(plot);
        }
        // 实测溢出 → 收缩行高重建（滚动条/DPI 取整兜底；杜绝“波形要滚动才能看全”）
        const over = this.holder.scrollHeight - this.holder.clientHeight;
        if (over <= 0 || attempt >= 1) break;
        h = Math.max(120, h - Math.ceil(over / rows) - 4);
        for (const p of this.plots) p.destroy();
        this.plots = [];
        this.cells = [];
        this.holder.replaceChildren();
      }
    }
  }

  /** 自定义 Y 轴范围 */
  setYRangeCustom(lo: number, hi: number) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return;
    this.yRange = [lo, hi];
    this.rebuildAll(this.lastSnap);
  }

  private buildBars(n: number) {
    for (let ch = 0; ch < n; ch++) {
      const st = this.chState[ch];
      const root = document.createElement("div");
      root.className = "bar-meter";
      root.classList.toggle("hidden", !(st?.visible ?? true));
      root.innerHTML =
        `<div class="bar-head"><i class="bar-swatch" style="background:${st.color}"></i>CH${ch + 1}</div>` +
        `<div class="bar-track"><div class="bar-fill" style="background:${st.color}"></div><span class="bar-val">--</span></div>` +
        `<div class="bar-range"><span class="lo">--</span><span class="hi">--</span></div>`;
      this.barsEl.appendChild(root);
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

  /** 容器尺寸漂移兜底：图宽与格子实测差 >3px 时就地 setSize */
  private syncSizes() {
    const all = this.overlay ? [...this.plots, this.overlay] : this.plots;
    for (const p of all) {
      const cell = p.root.parentElement as HTMLElement | null;
      if (!cell || !cell.clientWidth) continue;
      const target = Math.max(220, cell.clientWidth - 10); // 减 cell 左右 padding+border
      if (Math.abs(p.width - target) > 3) {
        p.setSize({ width: target, height: p.height });
      }
    }
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
        `<input type="color" class="ch-color" value="${st.color}" title="通道颜色" />` +
        `<span class="ch-name">CH${i + 1}</span>` +
        `<label class="chk" title="显示通道"><input type="checkbox" class="ch-vis" ${st.visible ? "checked" : ""} />显</label>` +
        `<span class="ch-io" title="增益">×<input type="number" class="ch-gain" value="${st.gain}" step="0.1" /></span>` +
        `<span class="ch-io" title="偏移">+<input type="number" class="ch-off" value="${st.offset}" step="1" /></span>`;
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
