// 统计页：连接统计卡片 + 每通道指标表
import type { ChannelMetrics, PlotSnapshotDto, StatsSnapshot } from "../types";
import { t } from "../i18n";

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
      [t("stats.rxBytes"), fmtBytes(s.rx_bytes)],
      [t("stats.txBytes"), fmtBytes(s.tx_bytes)],
      [t("stats.rxRate"), `${s.rx_rate_kbs.toFixed(2)} KB/s`],
      [t("stats.txRate"), `${s.tx_rate_kbs.toFixed(2)} KB/s`],
      [t("stats.crcErrors"), String(s.crc_errors)],
      [t("stats.frameErrors"), String(s.frame_errors)],
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
    const cols = [
      t("stats.ch"), t("stats.current"), t("stats.count"), t("stats.mean"), t("stats.std"),
      t("stats.variance"), t("stats.min"), t("stats.max"), t("stats.peakToPeak"), t("stats.rms"),
    ];
    this.tableHead.replaceChildren(...cols.map((c) => th(c)));
    this.tableBody.replaceChildren();
    snap.metrics.forEach((m: ChannelMetrics | null, i: number) => {
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      const swatch = document.createElement("span");
      swatch.className = "ch-swatch";
      swatch.style.background = CH_COLORS[i % CH_COLORS.length];
      nameTd.append(swatch, document.createTextNode(snap.channel_names?.[i] || `CH${i + 1}`));
      tr.appendChild(nameTd);
      const vals = m
        ? [fmtStat(m.last), String(m.count), fmtStat(m.mean), fmtStat(m.std),
           fmtStat(m.variance), fmtStat(m.min), fmtStat(m.max),
           fmtStat(m.peak_to_peak), fmtStat(m.rms)]
        : Array(9).fill("—");
      for (const v of vals) tr.appendChild(td(v));
      this.tableBody.appendChild(tr);
    });
  }
}

// 统计表数值显示：固定 4 位小数，量级过大/过小时改用科学计数法。
// 用 toFixed(4) 而不是 toPrecision(6)：后者是「6 位有效数字」，小数位数会随量级变化
// （149.976 只有 3 位小数、4.5e6 干脆变成 0 位小数），同一列无法对齐。
// 但纯 toFixed(4) 对大值会造出 4506140.0000 这种假精度，对 6.6e-9 会显示成 0.0000
// 把方差信息全部丢掉，所以超出 [1e-3, 1e6) 时退回科学计数法（尾数 4 位小数）。
function fmtStat(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(4);
  return v.toFixed(4);
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
