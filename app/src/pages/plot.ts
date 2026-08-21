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
  }

  /** 每 ~50ms 由 main 轮询调用 */
  update(snap: PlotSnapshotDto) {
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
    const w = Math.max(420, Math.floor((this.holder.clientWidth - 24) / Math.min(2, Math.max(1, snap.channel_count))) - 12);
    const h = Math.max(160, Math.floor((this.holder.clientHeight - 24) / Math.ceil(Math.max(1, snap.channel_count) / 2)) - 12);
    for (let ch = 0; ch < snap.channel_count; ch++) {
      const cell = document.createElement("div");
      cell.className = "plot-cell";
      this.holder.appendChild(cell);
      const opts: uPlot.Options = {
        width: w,
        height: h,
        title: `CH${ch + 1}`,
        series: [{}, {
          label: `CH${ch + 1}`,
          stroke: CH_COLORS[ch % CH_COLORS.length],
          width: 1.4,
          points: { show: false },
        }],
        axes: [
          { stroke: "#8b919c", grid: { stroke: "#23272f" } },
          { stroke: "#8b919c", grid: { stroke: "#23272f" } },
        ],
        legend: { show: false },
      };
      const plot = new uPlot(opts, undefined, cell);
      this.plots.push(plot);
    }
    // 立即灌一次数据
    this.update(snap);
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
