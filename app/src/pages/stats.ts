// 统计页：连接统计卡片 + 每通道指标表
import type { ChannelMetrics, PlotSnapshotDto, StatsSnapshot } from "../types";

const CH_COLORS = ["#4da3ff", "#33cc70", "#ffb340", "#ff5544", "#c792ea", "#33d1d1", "#f7a8b8", "#a3e635"];

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${n} B`;
}

export class StatsPage {
  private cards: HTMLElement;
  private tableHead: HTMLElement;
  private tableBody: HTMLElement;

  constructor(root: HTMLElement) {
    this.cards = root.querySelector("#stat-cards")!;
    this.tableHead = root.querySelector("#ch-metrics thead tr")!;
    this.tableBody = root.querySelector("#ch-metrics tbody")!;
  }

  updateConn(s: StatsSnapshot) {
    const items: [string, string][] = [
      ["RX 字节", fmtBytes(s.rx_bytes)],
      ["TX 字节", fmtBytes(s.tx_bytes)],
      ["RX 速率", `${s.rx_rate_kbs.toFixed(2)} KB/s`],
      ["TX 速率", `${s.tx_rate_kbs.toFixed(2)} KB/s`],
      ["CRC 错误", String(s.crc_errors)],
      ["帧错误", String(s.frame_errors)],
    ];
    this.cards.replaceChildren(
      ...items.map(([k, v]) => {
        const c = document.createElement("div");
        c.className = "card";
        const kk = document.createElement("div");
        kk.className = "k";
        kk.textContent = k;
        const vv = document.createElement("div");
        vv.className = "v";
        vv.textContent = v;
        c.append(kk, vv);
        return c;
      }),
    );
  }

  updateChannels(snap: PlotSnapshotDto) {
    const cols = ["通道", "样本数", "均值", "标准差", "方差", "最小", "最大", "峰峰值", "RMS"];
    this.tableHead.replaceChildren(...cols.map((c) => th(c)));
    this.tableBody.replaceChildren();
    snap.metrics.forEach((m: ChannelMetrics | null, i: number) => {
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      const swatch = document.createElement("span");
      swatch.className = "ch-swatch";
      swatch.style.background = CH_COLORS[i % CH_COLORS.length];
      nameTd.append(swatch, document.createTextNode(`CH${i + 1}`));
      tr.appendChild(nameTd);
      const vals = m
        ? [String(m.count), m.mean.toPrecision(6), m.std.toPrecision(6), m.variance.toPrecision(6),
           m.min.toPrecision(6), m.max.toPrecision(6), m.peak_to_peak.toPrecision(6), m.rms.toPrecision(6)]
        : Array(8).fill("—");
      for (const v of vals) tr.appendChild(td(v));
      this.tableBody.appendChild(tr);
    });
  }
}

function th(text: string): HTMLElement {
  const el = document.createElement("th");
  el.textContent = text;
  return el;
}
function td(text: string): HTMLElement {
  const el = document.createElement("td");
  el.textContent = text;
  return el;
}
