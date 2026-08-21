// 绘图页：uPlot 流式波形（每通道一个图），数据来自 Rust 引擎快照轮询
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { api } from "../api";
import type { DataFormat, DType, PlotSnapshotDto } from "../types";

const CH_COLORS = ["#4da3ff", "#33cc70", "#ffb340", "#ff5544", "#c792ea", "#33d1d1", "#f7a8b8", "#a3e635"];

export class PlotPage {
  private holder: HTMLElement;
  private info: HTMLElement;
  private plots: uPlot[] = [];
  private lastTotal = -1;

  constructor(holder: HTMLElement, controls: HTMLElement) {
    this.holder = holder;
    this.info = controls.querySelector<HTMLElement>("#plot-info")!;
    controls.querySelector("#plot-apply")!.addEventListener("click", () => this.applyFormat());
    // 窗口/容器尺寸变化 → 重建图（防抖 150ms）
    let t: number | null = null;
    const ro = new ResizeObserver(() => {
      if (t !== null) window.clearTimeout(t);
      t = window.setTimeout(() => {
        t = null;
        if (this.plots.length) this.rebuild(this.lastSnap!);
      }, 150);
    });
    ro.observe(holder);
  }

  private lastSnap: PlotSnapshotDto | null = null;

  /** 切到绘图页时调用：页面隐藏期间 holder 无尺寸，显示后按真实容器重建 */
  onShow() {
    requestAnimationFrame(() => {
      if (this.lastSnap && this.plots.length) this.rebuild(this.lastSnap);
    });
  }

  /** 每 ~50ms 由 main 轮询调用 */
  update(snap: PlotSnapshotDto) {
    this.lastSnap = snap;
    // 尺寸漂移兜底：图宽与格子实测宽差 >3px 时就地 setSize（容器变化而 RO 未触发的场景）
    for (let i = 0; i < this.plots.length; i++) {
      const cell = this.plots[i].root.parentElement as HTMLElement | null;
      if (!cell || !cell.clientWidth) continue;
      const target = Math.max(220, cell.clientWidth - 10); // 减 cell 左右 padding+border
      if (Math.abs(this.plots[i].width - target) > 3) {
        this.plots[i].setSize({ width: target, height: this.plots[i].height });
      }
    }
    if (snap.series.length !== this.plots.length || snap.total_points < this.lastTotal) {
      this.rebuild(snap);
      this.lastTotal = snap.total_points;
      return;
    }
    this.lastTotal = snap.total_points;
    for (let ch = 0; ch < snap.series.length; ch++) {
      const data = snap.series[ch];
      const n = data.length;
      // x 轴用样本序号（环形缓冲起点未知，以最新点为 n-1）
      const xs = new Float64Array(n);
      for (let i = 0; i < n; i++) xs[i] = i;
      this.plots[ch].setData([xs, Float64Array.from(data)]);
    }
    this.info.textContent = `总点数 ${snap.total_points}`;
  }

  private rebuild(snap: PlotSnapshotDto) {
    for (const p of this.plots) p.destroy();
    this.plots = [];
    this.holder.replaceChildren();
    const n = Math.max(1, snap.channel_count);
    const rows = n <= 1 ? 1 : Math.ceil(n / 2); // 每行最多两个（grid auto-fit 实际排布）
    // 行高按 holder 可视高度均分；holder 隐藏时 clientHeight 为 0 → 落到最小值，onShow 会重建
    const h = Math.max(150, Math.floor((this.holder.clientHeight - 16 - (rows - 1) * 8) / rows) - 10);
    // 先建格子并入文档，布局稳定后按格子实测宽度建图 —— 杜绝量到过期/为零的宽度导致溢出
    const cells: HTMLElement[] = [];
    for (let ch = 0; ch < n; ch++) {
      const cell = document.createElement("div");
      cell.className = "plot-cell";
      this.holder.appendChild(cell);
      cells.push(cell);
    }
    for (let ch = 0; ch < n; ch++) {
      const w = Math.max(220, cells[ch].clientWidth - 10); // 减 cell 左右 padding+border
      const plot = new uPlot(this.buildOpts(ch, w, h), undefined, cells[ch]);
      this.plots.push(plot);
    }
    // 立即灌一次数据
    this.update(snap);
  }

  private buildOpts(ch: number, w: number, h: number): uPlot.Options {
    return {
      width: w,
      height: h,
      title: `CH${ch + 1}`,
      // x 是样本序号，不是 unix 时间戳（不关的话 0..n 会被当成 epoch 秒渲染成钟点）
      scales: { x: { time: false } },
      padding: [18, 14, 8, 10],
      series: [{}, {
        label: `CH${ch + 1}`,
        stroke: CH_COLORS[ch % CH_COLORS.length],
        width: 1.4,
        points: { show: false },
      }],
      axes: [
        { stroke: "#8b919c", grid: { stroke: "#23272f" }, space: 60, label: "样本序号" },
        { stroke: "#8b919c", grid: { stroke: "#23272f" }, space: 24 },
      ],
      legend: { show: false },
    };
  }

  private applyFormat() {
    const channels = Number(this.holder.closest("#page-plot")?.querySelector<HTMLInputElement>("#plot-channels")?.value ?? 1);
    const fmtSel = this.holder.closest("#page-plot")?.querySelector<HTMLSelectElement>("#plot-fmt")!;
    const dtype = this.holder.closest("#page-plot")?.querySelector<HTMLSelectElement>("#plot-dtype")!.value as DType;
    const endian = this.holder.closest("#page-plot")?.querySelector<HTMLSelectElement>("#plot-endian")!.value as "little" | "big";
    const delim = this.holder.closest("#page-plot")?.querySelector<HTMLInputElement>("#plot-delimiter")!.value || ",";
    let fmt: DataFormat;
    if (fmtSel.value === "simple_binary") {
      fmt = { type: "simple_binary", channel_count: channels, dtype, byte_order: endian };
    } else {
      fmt = { type: "ascii_delimited", delimiter: delim, channel_count: channels };
    }
    void api.setPlotFormat(fmt);
  }
}
