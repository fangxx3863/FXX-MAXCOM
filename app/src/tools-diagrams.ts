// 工具页原理图：
//  - 可从 DigiKey 在线计算器页抓到的示意图直接复用本地产物（assets/tools/*）。
//  - JS 内联 SVG 渲染、无法抓取（Cloudflare 拦截）的工具，绘制等价的干净示意 SVG。
//  - 部分工具（555、衰减器）的图随选中模式/类型变化，通过 toolDiagramVariant 切换。
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

// 这些工具的图随模式/类型变化，由构建器渲染在面板内。
const DYNAMIC = new Set(["555", "attenuator"]);

// ── 基础绘图原语（深色线、白底卡片）──
const STROKE = "#2f343b";
const LBL = "#575e66";
const WIRE = { stroke: STROKE, "stroke-width": 1.7, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" } as const;
const FONT = "font-family: system-ui, sans-serif";

const attr = (o: Record<string, string | number>): string =>
  Object.entries(o).map(([k, v]) => `${k}="${v}"`).join(" ");
const wire = (d: string): string => `<path d="${d}" ${attr(WIRE)}/>`;
const dot = (x: number, y: number): string =>
  `<circle cx="${x}" cy="${y}" r="2.4" fill="${STROKE}"/>`;
const lbl = (x: number, y: number, txt: string, size = 11, anchor = "start"): string =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${LBL}" text-anchor="${anchor}" style="${FONT}">${txt}</text>`;
// 端子（开口圆）
const term = (x: number, y: number): string =>
  `<circle cx="${x}" cy="${y}" r="3" fill="#fff" stroke="${STROKE}" stroke-width="1.6"/>`;
const svgHead = (w: number, h: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%">` +
  `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" fill="#fff" stroke="#e2e5e9"/>`;

// 水平锯齿电阻：起点 (x,y)，向右共长 len（锯齿在 y-8..y 之间）
const resH = (x: number, y: number, len: number): string => {
  const seg = len / 12;
  let d = `M ${x} ${y}`;
  for (let i = 1; i < 12; i++) d += ` L ${x + i * seg} ${i % 2 === 0 ? y : y - 7}`;
  d += ` L ${x + len} ${y}`;
  return `<path d="${d}" ${attr(WIRE)}/>`;
};
// 垂直锯齿电阻：起点 (x,y)，向下共长 len（锯齿在 x-7..x 之间）
const resV = (x: number, y: number, len: number): string => {
  const seg = len / 12;
  let d = `M ${x} ${y}`;
  for (let i = 1; i < 12; i++) d += ` L ${i % 2 === 0 ? x : x - 7} ${y + i * seg}`;
  d += ` L ${x} ${y + len}`;
  return `<path d="${d}" ${attr(WIRE)}/>`;
};
// 垂直电容（两块水平板），中心 (x,y)
const capV = (x: number, y: number): string =>
  `<path d="M ${x - 9} ${y - 3.5} H ${x + 9}" stroke="${STROKE}" stroke-width="2.4" fill="none"/>` +
  `<path d="M ${x - 9} ${y + 3.5} H ${x + 9}" stroke="${STROKE}" stroke-width="2.4" fill="none"/>`;
// 接地
const gnd = (x: number, y: number): string =>
  wire(`M ${x - 9} ${y} H ${x + 9} M ${x - 5} ${y + 5} H ${x + 5} M ${x - 1} ${y + 10} H ${x + 1}`);
// 电源符号（向上的 vcc 短线 + 横线）
const vcc = (x: number, y: number): string =>
  wire(`M ${x} ${y} V ${y - 8} M ${x - 5} ${y - 8} H ${x + 5}`);
// 开关：常开触点（左边触点 + 斜杠开关）
const sw = (x: number, y: number): string =>
  wire(`M ${x - 7} ${y} H ${x + 7}`) + wire(`M ${x - 7} ${y} L ${x + 7} ${y - 12}`);

// ── 555 IC 框（8 脚，框体 x∈[250,400] y∈[56,250]）──
function ic555(): string {
  const x = 250, y = 56, w = 150, h = 194;
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#fff" stroke="${STROKE}" stroke-width="2"/>`;
  s += lbl(x + 8, y + 22, "555", 13, "start");
  const lp: [number, string, string][] = [[90, "7", "DISCHARGE"], [120, "6", "THRESHOLD"], [150, "2", "TRIGGER"], [180, "5", "CTRL V"]];
  for (const [py, num, name] of lp) {
    s += wire(`M ${x} ${py} H ${x - 60}`) + lbl(x - 66, py + 4, num, 10, "end") + lbl(x + 8, py + 4, name, 8.5, "start");
  }
  // 右上：8 VCC、4 RESET
  s += wire(`M ${x + 40} ${y} V ${y - 22}`) + lbl(x + 44, y - 27, "8", 9, "start") + lbl(x + 44, y - 15, "VCC", 8.5, "start");
  s += wire(`M ${x + 95} ${y} V ${y - 22}`) + lbl(x + 99, y - 27, "4", 9, "start") + lbl(x + 99, y - 15, "RESET", 8.5, "start");
  // 右中：3 OUT
  s += wire(`M ${x + w} 132 H ${x + w + 30}`) + lbl(x + w + 24, 135, "3", 10, "end") + lbl(x + w + 34, 135, "OUT", 9, "start");
  // 底：1 GND
  s += wire(`M ${x + 70} ${y + h} V ${y + h + 22}`) + lbl(x + 74, y + h + 34, "1", 9, "start") + lbl(x + 74, y + h + 20, "GND", 8.5, "start");
  return s;
}

// ── 555 单稳态 ──
function svg555Mono(): string {
  const w = 470, h = 320;
  let s = svgHead(w, h);
  const vtop = 34;
  s += wire(`M 70 ${vtop} H 345`) + vcc(345, vtop) + lbl(340, vtop - 20, "Vcc", 12, "end");
  // R1 定时：Vcc → 节点(170,90)
  s += wire(`M 170 ${vtop} V 48`) + resV(170, 48, 42) + lbl(156, 78, "R1", 11, "end");
  s += dot(170, 90);
  s += wire(`M 170 90 H 190`) + dot(170, 120) + wire(`M 170 120 H 190`); // → 引脚7/引脚6
  s += wire(`M 170 90 V 168`) + capV(170, 168) + wire(`M 170 172 V 196`) + gnd(170, 196) + lbl(156, 190, "C1", 11, "end");
  // R2 触发：Vcc → 引脚2(110,150)
  s += wire(`M 110 ${vtop} V 48`) + resV(110, 48, 44) + lbl(96, 78, "R2", 11, "end");
  s += wire(`M 110 92 V 150`) + dot(110, 150) + wire(`M 110 150 H 190`);
  // S1 开关：引脚2 节点 → 地
  s += wire(`M 110 150 V 168`) + sw(110, 172) + wire(`M 110 176 V 200`) + gnd(110, 200) + lbl(126, 170, "S1", 11, "start");
  // C2：引脚5 CTRL V → 地
  s += wire(`M 190 180 H 60`) + dot(60, 180) + wire(`M 60 180 V 200`) + capV(60, 200) + wire(`M 60 204 V 228`) + gnd(60, 228) + lbl(44, 200, "C2", 11, "end");
  // 引脚8 / 4 → Vcc 轨
  s += wire(`M 290 56 V ${vtop}`) + dot(290, vtop);
  s += wire(`M 345 56 V ${vtop}`) + dot(345, vtop);
  // 引脚1 → 地
  s += wire(`M 320 250 V 272`) + gnd(320, 272) + lbl(320, 294, "GND", 9.5, "middle");
  // OUT
  s += wire(`M 400 132 H 420`) + term(438, 132) + lbl(432, 124, "OUT", 11, "end");
  s += ic555();
  s += `</svg>`;
  return s;
}

// ── 555 非稳态 ──
function svg555Astable(): string {
  const w = 545, h = 320;
  let s = svgHead(w, h);
  const vtop = 34;
  s += wire(`M 70 ${vtop} H 345`) + vcc(345, vtop) + lbl(340, vtop - 20, "Vcc", 12, "end");
  // R1：Vcc → nodeA(170,90) = R1/R2 交点
  s += wire(`M 170 ${vtop} V 48`) + resV(170, 48, 42) + lbl(156, 78, "R1", 11, "end");
  s += dot(170, 90) + wire(`M 170 90 H 190`); // → 引脚7 DISCHARGE
  // R2：nodeA → R2 底(170,116)；R2 底到 C1 之间是纯导线 nodeB
  s += resV(170, 90, 26) + lbl(156, 108, "R2", 11, "end");
  s += wire(`M 170 116 V 168`);
  // 引脚6 / 引脚2 都在 nodeB 这段纯导线上（不在电阻体内）
  s += dot(170, 120) + wire(`M 170 120 H 190`); // → 引脚6 THRESHOLD
  s += dot(170, 150) + wire(`M 170 150 H 190`); // → 引脚2 TRIGGER
  // C1：nodeB → 地
  s += capV(170, 172) + wire(`M 170 176 V 196`) + gnd(170, 196) + lbl(156, 190, "C1", 11, "end");
  // C2：引脚5 CTRL V → 地
  s += wire(`M 190 180 H 60`) + dot(60, 180) + wire(`M 60 180 V 200`) + capV(60, 200) + wire(`M 60 204 V 228`) + gnd(60, 228) + lbl(44, 200, "C2", 11, "end");
  // 引脚8 / 4 → Vcc
  s += wire(`M 290 56 V ${vtop}`) + dot(290, vtop);
  s += wire(`M 345 56 V ${vtop}`) + dot(345, vtop);
  // 引脚1 → 地
  s += wire(`M 320 250 V 272`) + gnd(320, 272) + lbl(320, 294, "GND", 9.5, "middle");
  // OUT → 方波示意（t_H 高电平 / t_L 低电平）
  s += wire(`M 400 132 H 415`) + term(430, 132);
  s += `<path d="M 440 132 V 116 H 458 V 148 H 476 V 116 H 494 V 148 H 512 V 132" fill="none" stroke="#c62828" stroke-width="2"/>`;
  s += lbl(447, 108, "t_H", 10, "start") + lbl(447, 164, "t_L", 10, "start");
  s += ic555();
  s += `</svg>`;
  return s;
}

// ── 衰减器（Pi / 桥T / 反射式 / T）──
function attenuatorSvg(type: string): string {
  const w = 380, h = 170, mid = 70;
  let s = svgHead(w, h);
  if (type === "pi") {
    s += term(20, mid) + wire(`M 23 ${mid} H 70`) + dot(70, mid);
    s += wire(`M 70 ${mid} V 92`) + resV(70, 92, 30) + wire(`M 70 122 V 132`) + gnd(70, 132) + lbl(56, 110, "R1", 11, "end");
    s += wire(`M 70 ${mid} H 140`) + resH(140, mid, 44) + lbl(152, mid - 12, "R2", 11, "middle");
    s += wire(`M 184 ${mid} H 320`) + dot(184, mid);
    s += wire(`M 184 ${mid} V 92`) + resV(184, 92, 30) + wire(`M 184 122 V 132`) + gnd(184, 132) + lbl(170, 110, "R1", 11, "end");
    s += term(320, mid) + lbl(10, mid - 10, "IN", 11, "end") + lbl(330, mid + 6, "OUT", 11, "start");
  } else if (type === "T") {
    s += term(20, mid) + wire(`M 23 ${mid} H 92`) + resH(92, mid, 44) + lbl(104, mid - 12, "R1", 11, "middle");
    s += wire(`M 136 ${mid} H 200`) + dot(168, mid);
    s += wire(`M 168 ${mid} V 96`) + resV(168, 96, 26) + wire(`M 168 122 V 132`) + gnd(168, 132) + lbl(154, 112, "R2", 11, "end");
    s += wire(`M 200 ${mid} H 268`) + resH(268, mid, 44) + lbl(280, mid - 12, "R1", 11, "middle");
    s += wire(`M 312 ${mid} H 340`) + term(340, mid);
    s += lbl(10, mid - 10, "IN", 11, "end") + lbl(350, mid + 6, "OUT", 11, "start");
  } else if (type === "bridgeT") {
    s += term(20, mid) + wire(`M 23 ${mid} H 80`) + resH(80, mid, 40) + lbl(90, mid - 12, "R1", 11, "middle");
    s += wire(`M 120 ${mid} H 260`) + dot(150, mid) + dot(248, mid);
    s += wire(`M 150 ${mid} V 96`) + resV(150, 96, 26) + wire(`M 150 122 V 132`) + gnd(150, 132) + lbl(136, 112, "R2", 11, "end");
    // 桥接电阻 R3：跨接输入节点与输出节点
    s += wire(`M 120 ${mid} V 26`) + resH(120, 26, 128) + lbl(174, 18, "R3", 11, "middle") + wire(`M 248 ${mid} V 26`);
    s += resH(248, mid, 40) + lbl(258, mid - 12, "R1", 11, "middle");
    s += wire(`M 288 ${mid} H 340`) + term(340, mid);
    s += lbl(10, mid - 10, "IN", 11, "end") + lbl(350, mid + 6, "OUT", 11, "start");
  } else { // reflective
    s += term(20, mid) + wire(`M 23 ${mid} H 100`) + resH(100, mid, 48) + lbl(112, mid - 12, "Rhi", 11, "middle");
    s += wire(`M 148 ${mid} H 300`) + dot(148, mid);
    s += wire(`M 148 ${mid} V 96`) + resV(148, 96, 26) + wire(`M 148 122 V 132`) + gnd(148, 132) + lbl(134, 112, "Rlo", 11, "end");
    s += term(300, mid) + lbl(10, mid - 10, "IN", 11, "end") + lbl(310, mid + 6, "OUT", 11, "start");
  }
  s += `</svg>`;
  return s;
}

// ── 电池续航：Vbat — R_load — 闭合回路 ──
function svgBatteryLife(): string {
  const w = 380, h = 170, top = 48, bot = 126, bx = 70;
  let s = svgHead(w, h);
  // 电池符号
  s += wire(`M ${bx} ${top} V ${top + 4}`);
  s += `<path d="M ${bx - 13} ${top + 4} H ${bx + 13}" stroke="${STROKE}" stroke-width="2.6" fill="none"/>`; // 长板 (+)
  s += `<path d="M ${bx - 6} ${top + 18} H ${bx + 6}" stroke="${STROKE}" stroke-width="3.2" fill="none"/>`;  // 短板 (−)
  s += wire(`M ${bx} ${top + 18} V ${bot}`);
  s += lbl(38, top + 16, "Vbat", 11, "end");
  // 回路上沿 + R_load
  s += wire(`M ${bx} ${top + 4} H 150`) + resH(150, top + 4, 64) + lbl(180, top - 10, "R_load", 11, "middle");
  s += wire(`M 214 ${top + 4} H 300`) + wire(`M 300 ${top + 4} V ${bot}`) + wire(`M 300 ${bot} H ${bx}`);
  // 电流方向箭头 + I(mA)
  s += `<path d="M 258 ${top + 4} h 20 M 272 ${top - 2} l 9 6 l -9 6" fill="none" stroke="${STROKE}" stroke-width="1.5"/>`;
  s += lbl(274, top - 8, "I(mA)", 11, "middle");
  s += `</svg>`;
  return s;
}

function svgFilter(): string {
  const w = 340, h = 150;
  let s = svgHead(w, h);
  const mid = 60;
  s += term(20, mid) + wire(`M 23 ${mid} H 110`);
  s += resH(110, mid, 50) + lbl(120, mid - 12, "R", 11, "middle");
  s += wire(`M 160 ${mid} H 300`) + dot(160, mid) + term(300, mid);
  s += wire(`M 160 ${mid} V 90`) + capV(160, 90) + wire(`M 160 96 V 108`) + gnd(160, 108) + lbl(154, 126, "C", 11, "end");
  s += lbl(10, 52, "IN", 11, "end") + lbl(310, 52, "OUT", 11, "start");
  s += `</svg>`;
  return s;
}

function svgThreePhase(): string {
  const w = 300, h = 160;
  let s = svgHead(w, h);
  const cx = 130, cy = 90, r = 40;
  s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" stroke="${STROKE}" stroke-width="1.8"/>`;
  s += lbl(cx - 8, cy + 4, "Y", 12, "middle");
  s += wire(`M ${cx} ${cy - r} L ${cx} ${cy - r - 32}`) + term(cx, cy - r - 32) + lbl(cx, cy - r - 44, "A", 11, "middle");
  const bx = cx + r * Math.cos(Math.PI / 6), by = cy + r * Math.sin(Math.PI / 6);
  const bxx = cx + (r + 32) * Math.cos(Math.PI / 6), byy = cy + (r + 32) * Math.sin(Math.PI / 6);
  s += wire(`M ${bx} ${by} L ${bxx} ${byy}`) + term(bxx, byy) + lbl(bxx + 8, byy + 6, "B", 11, "start");
  const cxx = cx - (r + 32) * Math.cos(Math.PI / 6), cyy = cy + (r + 32) * Math.sin(Math.PI / 6);
  s += wire(`M ${cx - r * Math.cos(Math.PI / 6)} ${cy + r * Math.sin(Math.PI / 6)} L ${cxx} ${cyy}`) + term(cxx, cyy) + lbl(cxx - 14, cyy + 6, "C", 11, "start");
  s += `</svg>`;
  return s;
}

function svgThermistor(): string {
  const w = 320, h = 130;
  let s = svgHead(w, h);
  const mid = 62;
  s += term(24, mid) + wire(`M 27 ${mid} H 110`);
  s += `<rect x="110" y="${mid - 20}" width="44" height="40" rx="8" fill="none" stroke="${STROKE}" stroke-width="1.8"/>`;
  s += `<path d="M 118 ${mid - 12} L 118 ${mid + 12} M 126 ${mid - 8} L 126 ${mid + 8} M 134 ${mid - 12} L 134 ${mid + 12}" stroke="${STROKE}" stroke-width="1.6"/>` + lbl(122, mid + 26, "NTC", 10, "middle");
  s += wire(`M 154 ${mid} H 260`) + term(280, mid);
  s += lbl(20, mid - 10, "T", 11, "end") + lbl(268, mid - 10, "R(T)", 11, "start");
  s += `</svg>`;
  return s;
}

const INLINE: Record<string, () => string> = {
  "battery-life": svgBatteryLife,
  filter: svgFilter,
  "three-phase": svgThreePhase,
  thermistor: svgThermistor,
};
const VARIANTS: Record<string, Record<string, () => string>> = {
  "555": { mono: svg555Mono, astable: svg555Astable },
  attenuator: {
    pi: () => attenuatorSvg("pi"),
    bridgeT: () => attenuatorSvg("bridgeT"),
    reflective: () => attenuatorSvg("reflective"),
    T: () => attenuatorSvg("T"),
  },
};

// 返回可直接作为 <img src> 的字符串；无图返回 ""。
export function toolDiagram(id: string): string {
  if (ASSETS[id]) return ASSETS[id];
  if (DYNAMIC.has(id)) return ""; // 动态工具：图由构建器按模式/类型渲染
  const fn = INLINE[id];
  if (!fn) return "";
  return "data:image/svg+xml;utf8," + encodeURIComponent(fn());
}

// 变体图（555 模式 / 衰减器类型）。未知变体回退到第一个/默认。
export function toolDiagramVariant(id: string, variant: string): string {
  const map = VARIANTS[id];
  if (!map) return toolDiagram(id);
  const fn = map[variant] ?? map[Object.keys(map)[0]];
  return "data:image/svg+xml;utf8," + encodeURIComponent(fn());
}
