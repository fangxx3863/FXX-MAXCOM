// 工具页原理图：优先使用从 DigiKey 在线计算器页下载到的示意图（本地产物，已放入 assets/tools），
// 对页面以 JS 内联 SVG 渲染、无法抓取的（Cloudflare 拦截无头浏览器）工具，绘制等价的简洁示意 SVG。
// 返回统一字符串：URL 或 data:image/svg+xml;utf8 URI，可直接用于 <img src>。
import capTable from "./assets/tools/capacitance-table.png";
import discharge from "./assets/tools/discharge-graph.png";
import currentDivider from "./assets/tools/current-divider.png";
import led from "./assets/tools/led-series.png";
import ohms from "./assets/tools/ohms-chart.png";
import resPar from "./assets/tools/res-parallell.png";
import traceImp from "./assets/tools/trace-impedance.jpg";
import traceW from "./assets/tools/trace-width.png";
import reactance from "./assets/tools/reactance-inductive.png";
import colorCode from "./assets/tools/color-code.png";
import capSeries from "./assets/tools/cap-series.png";
import timeConst from "./assets/tools/time-constant.svg";
import voltageDivider from "./assets/tools/voltage-divider.png";

const ASSETS: Record<string, string> = {
  "capacitance-conversion": capTable,
  "capacitor-safe-discharge": discharge,
  "current-divider": currentDivider,
  "led-resistor": led,
  ohm: ohms,
  "parallel-series-res": resPar,
  "trace-impedance": traceImp,
  "pcb-trace-width": traceW,
  reactance: reactance,
  "color-code": colorCode,
  "parallel-series-cap": capSeries,
  "time-constant": timeConst,
  "voltage-divider": voltageDivider,
};

// ── 手绘等价示意 SVG（深色线条，白底卡片）──
const STROKE = "#33383f";
const WIRE = { stroke: STROKE, "stroke-width": 1.6, fill: "none", "stroke-linecap": "round" } as const;
const FONT = `font-family: system-ui, sans-serif`;
const t = (x: number, y: number, txt: string, size = 11): string =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${STROKE}" style="${FONT}">${txt}</text>`;

// 电阻：水平锯齿，起点 (x,y)，长度 len
const resistor = (x: number, y: number, len: number): string => {
  const seg = len / 8;
  let d = `M ${x} ${y}`;
  for (let i = 1; i < 8; i++) d += ` L ${x + i * seg} ${i % 2 === 0 ? y : y - 7}`;
  d += ` L ${x + len} ${y}`;
  return `<path d="${d}" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`;
};
// 电容：两块平行板
const cap = (x: number, y: number): string =>
  `<path d="M ${x} ${y - 8} L ${x + 12} ${y - 8}" stroke="${STROKE}" stroke-width="2" fill="none"/>
   <path d="M ${x} ${y + 8} L ${x + 12} ${y + 8}" stroke="${STROKE}" stroke-width="2" fill="none"/>`;
// 接地
const gnd = (x: number, y: number): string =>
  `<path d="M ${x - 9} ${y} L ${x + 9} ${y} M ${x - 5} ${y + 5} L ${x + 5} ${y + 5} M ${x - 1} ${y + 10} L ${x + 1} ${y + 10}" stroke="${STROKE}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`;
// 电池（长/短两线）
const battery = (x: number, y: number): string =>
  `<path d="M ${x} ${y - 7} L ${x} ${y + 7}" stroke="${STROKE}" stroke-width="1.6"/><path d="M ${x - 5} ${y - 7} L ${x + 5} ${y - 7}" stroke="${STROKE}" stroke-width="3"/><path d="M ${x + 2} ${y + 7} L ${x + 6} ${y + 7}" stroke="${STROKE}" stroke-width="3"/>`;
// 电感：圆弧

function inline(id: string): string {
  const open = (w: number, h: number): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%">`;
  switch (id) {
    case "555":
      return (
        open(340, 150) +
        `<rect x="150" y="30" width="90" height="86" rx="6" fill="none" stroke="${STROKE}" stroke-width="1.8"/>` +
        t(163, 55, "555", 12) +
        `<path d="M 30 46 H 150" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        `<path d="M 30 46 V 140" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        resistor(92, 30, 40) +
        `<path d="M 92 30 V 30" stroke="${STROKE}" stroke-width="1.6"/>` +
        t(78, 22, "R1") +
        `<path d="M 112 30 H 150" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        `<path d="M 32 118 V 140" stroke="${STROKE}" stroke-width="1.6"/>` +
        cap(78, 118) +
        t(74, 112, "C1") +
        `<path d="M 138 82 H 150" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        `<path d="M 30 46 V 140" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        gnd(35, 140) +
        t(30, 158, "GND") +
        `<path d="M 240 73 H 300" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        t(300, 60, "OUT") +
        `</svg>`
      );
    case "attenuator":
      return (
        open(340, 130) +
        `<path d="M 20 65 H 90" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        `<path d="M 90 65 V 30" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        resistor(90, 30, 54) +
        `<path d="M 144 30 V 65" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        t(100, 22, "R1") +
        `<path d="M 144 65 V 100" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        resistor(144, 100, 54) +
        `<path d="M 144 100 H 90" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        t(100, 120, "R2") +
        `<path d="M 200 65 H 300" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        `<path d="M 200 65 V 30 H 198" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        `<path d="M 198 65 V 100 H 198" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        resistor(198, 30, 50) +
        t(205, 22, "R3") +
        t(20, 55, "IN") +
        t(300, 55, "OUT") +
        `</svg>`
      );
    case "battery-life":
      return (
        open(320, 120) +
        battery(40, 60) +
        t(28, 90, "Vbat") +
        `<path d="M 55 60 H 210" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        resistor(170, 60, 60) +
        t(178, 52, "R_load") +
        `<path d="M 230 60 V 90" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        gnd(225, 90) +
        t(232, 112, "GND") +
        `<path d="M 55 60 H 40" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        t(250, 55, "I(mA)") +
        `</svg>`
      );
    case "filter":
      return (
        open(340, 130) +
        `<path d="M 20 60 H 130" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        resistor(120, 60, 60) +
        t(128, 52, "R") +
        `<path d="M 180 60 H 300" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        `<path d="M 180 60 V 90" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        cap(174, 90) +
        `<path d="M 186 98 H 180" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        gnd(177, 112) +
        t(174, 132, "C") +
        t(20, 50, "IN") +
        t(302, 50, "OUT") +
        `</svg>`
      );
    case "three-phase":
      return (
        open(300, 150) +
        `<circle cx="150" cy="80" r="26" fill="none" stroke="${STROKE}" stroke-width="1.6"/>` +
        t(140, 84, "Y") +
        `<path d="M 150 54 L 150 22" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        `<path d="M 172 93 L 195 112" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        `<path d="M 128 93 L 105 112" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        t(146, 12, "A") +
        t(198, 124, "B") +
        t(88, 124, "C") +
        `</svg>`
      );
    case "thermistor":
      return (
        open(300, 120) +
        `<path d="M 30 60 H 110" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        `<rect x="110" y="40" width="44" height="40" rx="8" fill="none" stroke="${STROKE}" stroke-width="1.8"/>` +
        t(118, 64, "NTC") +
        `<path d="M 154 60 H 260" ${Object.entries(WIRE).map(([k, v]) => `${k}="${v}"`).join(" ")}/>` +
        t(30, 50, "T") +
        t(266, 50, "R(T)") +
        `</svg>`
      );
    default:
      return "";
  }
}

// 返回可直接作为 <img src> 的字符串；无图时返回 ""。
export function toolDiagram(id: string): string {
  if (ASSETS[id]) return ASSETS[id];
  const s = inline(id);
  return s ? "data:image/svg+xml;utf8," + encodeURIComponent(s) : "";
}
