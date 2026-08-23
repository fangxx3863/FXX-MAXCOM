// 工具页原理图：
//  - 可从在线计算器页抓到的示意图直接复用本地产物（assets/tools/*）。
//  - 部分工具（555、衰减器、滤波、三相）的图随选中模式/类型/接法变化，
//    通过 toolDiagramVariant 切换。
import capTable from "./assets/tools/capacitance-table.png";
import discharge from "./assets/tools/discharge-graph.png";
import currentDivider from "./assets/tools/current-divider.png";
import led from "./assets/tools/led-series.png";
import ohms from "./assets/tools/ohms-chart.png";
import resPar from "./assets/tools/res-parallell.png";
import traceW from "./assets/tools/trace-width.png";
import reactance from "./assets/tools/reactance-inductive.png";
import colorCode from "./assets/tools/color-code.png";
import capSeries from "./assets/tools/cap-series.png";
import timeConst from "./assets/tools/time-constant.svg";
import voltageDivider from "./assets/tools/voltage-divider.png";
import mono555 from "./assets/tools/555-mono.png";
import astable555 from "./assets/tools/555-astable.png";
import attPi from "./assets/tools/att-pi.png";
import attBridgeT from "./assets/tools/att-bridgeT.png";
import attReflective from "./assets/tools/att-reflective.png";
import attT from "./assets/tools/att-t.png";
import batteryLife from "./assets/tools/battery-life.png";
import rcLpf from "./assets/tools/rc_lpf.png";
import rcHpf from "./assets/tools/rc_hpf.png";
import rlLpf from "./assets/tools/rl_lpf.png";
import rlHpf from "./assets/tools/rl_hpf.png";
import lcLpf from "./assets/tools/lc_lpf.png";
import lcHpf from "./assets/tools/lc_hpf.png";
import yConn from "./assets/tools/Y-CONN.png";
import deltaConn from "./assets/tools/ANGLE-CONN.png";
import ms from "./assets/tools/ms.png";
import msEmbedded from "./assets/tools/ms-embedded.png";
import msEdgeCoupl from "./assets/tools/ms-edge-coupl.png";
import str from "./assets/tools/str.png";
import strAsym from "./assets/tools/str-asym.png";
import strBroadside from "./assets/tools/str-broadside.png";
import strEdgeCoupl from "./assets/tools/str-edge-coupl.png";

const ASSETS: Record<string, string> = {
  "capacitance-conversion": capTable,
  "capacitor-safe-discharge": discharge,
  "current-divider": currentDivider,
  "led-resistor": led,
  ohm: ohms,
  "parallel-series-res": resPar,
  "pcb-trace-width": traceW,
  reactance: reactance,
  "color-code": colorCode,
  "parallel-series-cap": capSeries,
  "time-constant": timeConst,
  "voltage-divider": voltageDivider,
  "battery-life": batteryLife,
};

// 这些工具的图随模式/类型/接法变化，由构建器渲染在面板内。
const DYNAMIC = new Set(["555", "attenuator", "filter", "three-phase", "trace-impedance"]);

const VARIANTS: Record<string, Record<string, () => string>> = {
  "555": { mono: () => mono555, astable: () => astable555 },
  attenuator: {
    pi: () => attPi,
    bridgeT: () => attBridgeT,
    reflective: () => attReflective,
    T: () => attT,
  },
  filter: {
    rc_lp: () => rcLpf,
    rc_hp: () => rcHpf,
    rl_lp: () => rlLpf,
    rl_hp: () => rlHpf,
    lc_lp: () => lcLpf,
    lc_hp: () => lcHpf,
  },
  "three-phase": {
    y: () => yConn,
    delta: () => deltaConn,
  },
  "trace-impedance": {
    m: () => ms,
    "m-embedded": () => msEmbedded,
    "m-edge": () => msEdgeCoupl,
    s: () => str,
    "s-asym": () => strAsym,
    "s-broadside": () => strBroadside,
    "s-edge": () => strEdgeCoupl,
  },
};

// 返回可直接作为 <img src> 的字符串；无图返回 ""。
export function toolDiagram(id: string): string {
  if (ASSETS[id]) return ASSETS[id];
  if (DYNAMIC.has(id)) return ""; // 动态工具：图由构建器按模式/类型/接法渲染
  return "";
}

// 变体图（555 模式 / 衰减器类型 / 滤波组合 / 三相接法）。未知变体回退到第一个/默认。
export function toolDiagramVariant(id: string, variant: string): string {
  const map = VARIANTS[id];
  if (!map) return toolDiagram(id);
  const fn = map[variant] ?? map[Object.keys(map)[0]];
  const r = fn();
  // 内联 SVG（以 <svg 开头）才包成 SVG data URI；Vite 资产路径（/assets/*.png）或
  // data:image 数据 URI 时原样返回，交给 <img> 直接加载。
  if (r.startsWith("<svg")) return "data:image/svg+xml;utf8," + encodeURIComponent(r);
  return r;
}
