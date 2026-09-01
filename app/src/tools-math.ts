// 工具页计算器：纯函数数学层（无 DOM / 无 i18n 依赖）。
// tools.ts 里各 build 函数调用这里导出的函数完成计算；scripts/tools-test.mjs 用 esbuild
// 打包本文件后在 Node 里跑断言，保证公式可被独立回归测试。
// 命名约定：所有量纲输入均为标准单位（Ω、F、Hz、A、V、s），单位选择只发生在 DOM 层。

// ── 通用数值格式化 ──
export function num(v: string): number | null {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function fmt(v: number, digits = 6): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  if (Math.abs(v) >= 1e12 || (Math.abs(v) < 1e-6 && Math.abs(v) > 0)) return v.toExponential(4);
  const s = v.toFixed(digits);
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

// 电阻/电容的可读单位格式化（避免一大串 0）
export function fmtOhm(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e6) return `${fmt(v / 1e6)} MΩ`;
  if (v >= 1e3) return `${fmt(v / 1e3)} kΩ`;
  if (v >= 1) return `${fmt(v)} Ω`;
  if (v >= 1e-3) return `${fmt(v * 1e3)} mΩ`;
  if (v >= 1e-6) return `${fmt(v * 1e6)} µΩ`;
  return `${fmt(v)} Ω`;
}

export function fmtCap(pf: number): string {
  if (!Number.isFinite(pf)) return "—";
  if (pf >= 1e12) return `${fmt(pf / 1e12)} F`;
  if (pf >= 1e9) return `${fmt(pf / 1e9)} mF`;
  if (pf >= 1e6) return `${fmt(pf / 1e6)} µF`;
  if (pf >= 1e3) return `${fmt(pf / 1e3)} nF`;
  return `${fmt(pf)} pF`;
}

// ── 555 定时器 ──
// 单稳态：输出脉冲宽度 T = 1.1 × R × C（单位：秒）
export function mono555(r: number, c: number): number {
  return 1.1 * r * c;
}

export interface Astable555 {
  tHigh: number; // 高电平时间（s）
  tLow: number;  // 低电平时间（s）
  freq: number;  // 频率（Hz）
  duty: number;  // 占空比（0..1）
}
// 非稳态：充电经 R1+R2，放电经 R2。R1/R2(Ω) C(F)
export function astable555(r1: number, r2: number, c: number): Astable555 {
  const tHigh = 0.693 * (r1 + r2) * c;
  const tLow = 0.693 * r2 * c;
  const period = tHigh + tLow;
  return {
    tHigh,
    tLow,
    freq: period > 0 ? 1 / period : 0,
    duty: period > 0 ? tHigh / period : 0,
  };
}

// ── 衰减器 ──
export type AttenType = "pi" | "bridgeT" | "reflective" | "T";

export interface AttenResult {
  r1: number;          // 主串臂/并联电阻
  r2: number | null;   // 次级电阻（反射式可为 null）
  rHi?: number;        // 反射式高阻
  rLo?: number;        // 反射式低阻
}
// dB: 衰减量(dB)，z: 特性阻抗(Ω)。K = 10^(dB/20)
export function attenuator(type: AttenType, db: number, z: number): AttenResult {
  const k = 10 ** (db / 20);
  if (type === "pi") {
    return { r1: (z * (k + 1)) / (k - 1), r2: (z / 2) * ((k ** 2 - 1) / k) };
  }
  if (type === "bridgeT") {
    return { r1: z * (k - 1), r2: z / (k - 1) };
  }
  if (type === "reflective") {
    const rHi = (z * (k + 1)) / (k - 1);
    const rLo = (z * (k - 1)) / (k + 1);
    return { r1: rHi, r2: null, rHi, rLo };
  }
  // T 型
  return { r1: (z * (k - 1)) / (k + 1), r2: (2 * z * k) / (k ** 2 - 1) };
}

// ── 电容三位代码：如 "104" = 10 × 10^4 pF ──
export function capCode3(code: string): number | null {
  const m = code.trim().match(/^(\d{3})$/);
  if (!m) return null;
  return Number(m[1].slice(0, 2)) * 10 ** Number(m[1][2]);
}

// ── 电容三位编码：pF → 三位代码（capCode3 的逆运算）──
// 能写成 sig×10^mult（sig∈[10,99]，mult∈[0,9]）才可编码，否则 null。
export function capEncode3(pf: number): string | null {
  if (!Number.isFinite(pf) || pf <= 0) return null;
  for (let mult = 0; mult <= 9; mult++) {
    const base = pf / 10 ** mult;
    const sig = Math.round(base);
    if (sig >= 10 && sig <= 99 && Math.abs(base - sig) < 1e-6) {
      return `${String(sig).padStart(2, "0")}${mult}`;
    }
  }
  return null;
}

// ── 电池续航 ──
export function batteryLifeHours(capMah: number, curMa: number): number {
  if (curMa <= 0) return NaN;
  return capMah / curMa;
}

// ── 电容器安全放电 ──
export interface CapDischarge {
  time: number;  // 到达安全电压的时间（s）
  power: number; // 初始放电功率（W）
  tau: number;   // 时间常数（s）
  energy: number;// 初始储能（J）
}
export function capDischarge(c: number, v0: number, vs: number, r: number): CapDischarge {
  const tau = r * c;
  return {
    time: tau * Math.log(v0 / vs),
    power: (v0 * v0) / r,
    tau,
    energy: 0.5 * c * v0 * v0,
  };
}

// ── 欧姆定律 ──
export interface OhmRes { r: number; p: number }
export function ohmLaw(v: number, i: number): OhmRes {
  return { r: v / i, p: v * i };
}

// ── 电抗 ──
export interface Reactance { xl: number; xc: number }
export function reactance(f: number, l: number, c: number): Reactance {
  return { xl: 2 * Math.PI * f * l, xc: 1 / (2 * Math.PI * f * c) };
}

// ── RC 时间常数 ──
export function rcTau(r: number, c: number): number {
  return r * c;
}

// ── LED 串联电阻 ──
export function ledResistor(vs: number, vf: number, ifA: number): number {
  return (vs - vf) / ifA;
}
// LED 电阻功率: P = (Vs - Vf) · If
export function ledPower(vs: number, vf: number, ifA: number): number {
  return (vs - vf) * ifA;
}

// ── 滤波器截止频率 ──
export type FilterType = "rc" | "rl" | "lc";
export function filterFc(t: FilterType, r: number | null, c: number | null, l: number | null): number | null {
  if (t === "rc") {
    if (r !== null && c !== null && r * c > 0) return 1 / (2 * Math.PI * r * c);
  } else if (t === "rl") {
    if (r !== null && l !== null && r > 0 && l > 0) return r / (2 * Math.PI * l);
  } else {
    if (l !== null && c !== null && l > 0 && c > 0) return 1 / (2 * Math.PI * Math.sqrt(l * c));
  }
  return null;
}

// ── dBm / 瓦特 ──
export function dbmToMwt(dbm: number): number {
  return 10 ** (dbm / 10);
}

// ── SMD 电阻三位代码：如 "102" = 10 × 10^2 Ω ──
export function smdResistor3(code: string): number | null {
  const m = code.trim().match(/^(\d{3})$/);
  if (!m) return null;
  return Number(m[1].slice(0, 2)) * 10 ** Number(m[1][2]);
}
// EIA-96 代码：两位数字索引 + 一位字母（倍率）
export function smdResistor96(code: string): number | null {
  const m = code.trim().toUpperCase().match(/^(\d{2})([A-Z])$/);
  if (!m) return null;
  const table = [
    100,102,105,107,110,113,115,118,121,124,127,130,133,137,140,143,147,150,154,158,
    162,165,169,174,178,182,187,191,196,200,205,210,215,221,226,232,237,243,249,255,
    261,267,274,280,287,294,301,309,316,324,332,340,348,357,365,374,383,392,402,412,
    422,432,442,453,464,475,487,499,511,523,536,549,562,576,590,604,619,634,649,665,
    681,698,715,732,750,768,787,806,825,845,866,887,909,931,953,976,
  ];
  const n = Number(m[1]);
  if (n < 1 || n > 96) return null;
  const mult: Record<string, number> = { Y: -2, Z: -1, R: 0, S: 1, T: 2, U: 3, V: 4, W: 5, X: 6, A: 7, B: 8, C: 9, D: 10, E: 11, F: 12 };
  const p = mult[m[2]];
  if (p === undefined) return null;
  return table[n - 1] * 10 ** p;
}

// ── 并联/串联电阻、电容（允许出现 null，由函数统一判定无效）──
function finiteNums(values: (number | null)[]): number[] | null {
  if (values.some((v) => v === null || !Number.isFinite(v))) return null;
  return values as number[];
}
export function seriesRes(values: (number | null)[]): number | null {
  const vs = finiteNums(values);
  if (!vs || vs.length === 0) return null;
  return vs.reduce((a, b) => a + b, 0);
}
export function parallelRes(values: (number | null)[]): number | null {
  if (!values.length || values.some((v) => v === null || v <= 0)) return null;
  return 1 / (values as number[]).reduce((a, v) => a + 1 / v, 0);
}
export function seriesCap(values: (number | null)[]): number | null {
  if (!values.length || values.some((v) => v === null || v <= 0)) return null;
  return 1 / (values as number[]).reduce((a, v) => a + 1 / v, 0);
}
export function parallelCap(values: (number | null)[]): number | null {
  const vs = finiteNums(values);
  if (!vs) return null;
  return vs.reduce((a, b) => a + b, 0);
}

// ── PCB 走线阻抗（单位一律 mil 基数）──
// 各拓扑公式（mil 制）。线宽/高度比超出 0.1–2.0 时
// 87/60 近似失效，仍返回数值并附警示。
export type TraceTopo =
  | "m"          // 微带线
  | "m-embedded" // 嵌入式微带线
  | "m-edge"     // 边缘耦合微带线
  | "s"          // 带状线
  | "s-asym"     // 非对称带状线
  | "s-broadside"// 宽边耦合带状线
  | "s-edge";    // 边缘耦合带状线
export type TraceDir = "im" | "w"; // im: 按线宽算阻抗; w: 按阻抗算线宽

export interface TraceInput {
  er: number;       // 介电常数
  w?: number;       // 线宽 (mil)
  t?: number;       // 铜厚 (mil)
  h?: number;       // 高度 (mil)
  s?: number;       // 线间距 (mil)
  hp?: number;      // 覆盖层高度/到地高度 (mil)
  ht?: number;      // 两走线间距 (mil)
  ha?: number;      // 上侧高度 (mil)
  hb?: number;      // 下侧高度 (mil)
  z?: number;       // 阻抗 (Ω)
}

export interface TraceResult {
  z?: number;   // im 方向输出阻抗 (Ω)
  w?: number;   // w 方向输出线宽 (mil, 显示前由 DOM 层除以单位系数)
  warn?: string;
}

export function traceImpedance(topo: TraceTopo, dir: TraceDir, x: TraceInput): TraceResult {
  const range = (w: number, h: number): string | undefined => {
    const r = w / h;
    return r < 0.1 || r > 2.0 ? "线宽/高度比超出 0.1–2.0，结果仅供粗估" : undefined;
  };
  switch (topo) {
    case "m": {
      const t = x.t!, h = x.h!, er = x.er;
      if (dir === "w") {
        const w = (5.98 * h / Math.exp(x.z! * Math.sqrt(er + 1.41) / 87) - t) / 0.8;
        return { w, warn: range(w, h) };
      }
      const w = x.w!;
      const z = 87 / Math.sqrt(er + 1.41) * Math.log((5.98 * h) / (0.8 * w + t));
      return { z, warn: range(w, h) };
    }
    case "m-embedded": {
      const t = x.t!, h = x.h!, hp = x.hp!, w = x.w!, er = x.er;
      const erp = er * (1 - Math.exp((-1.55 * h) / hp));
      const z = (60 / Math.sqrt(erp)) * Math.log((5.98 * hp) / (0.8 * w + t));
      return { z, warn: h / hp <= 1.2 ? "覆盖层高度 hp 必须小于基板高度 h（要求 h/hp > 1.2）" : undefined };
    }
    case "m-edge": {
      const t = x.t!, h = x.h!, s = x.s!, er = x.er;
      if (dir === "w") {
        const zo = x.z! / 2 / (1 - 0.48 / Math.exp((0.96 * s) / h));
        const w = (5.98 * h / Math.exp((zo / 87) * Math.sqrt(er + 1.41)) - t) / 0.8;
        return { w, warn: range(w, h) };
      }
      const w = x.w!;
      const zo0 = 87 / Math.sqrt(er + 1.41) * Math.log((5.98 * h) / (0.8 * w + t));
      const zd = 2 * zo0 * (1 - 0.48 / Math.exp((0.96 * s) / h));
      return { z: zd, warn: range(w, h) };
    }
    case "s": {
      const t = x.t!, h = x.h!, w = x.w!, er = x.er;
      const z = (60 / Math.sqrt(er)) * Math.log((1.9 * (2 * h + t)) / (0.8 * w + t));
      return { z, warn: range(w, h) };
    }
    case "s-asym": {
      const t = x.t!, ha = x.ha!, hb = x.hb!, w = x.w!, er = x.er;
      const h = Math.min(ha, hb), h1 = Math.max(ha, hb);
      const z = (80 / Math.sqrt(er)) * Math.log((1.9 * (2 * h + t)) / (0.8 * w + t)) * (1 - h / (4 * h1));
      return { z, warn: range(w, h) };
    }
    case "s-broadside": {
      const t = x.t!, hp = x.hp!, ht = x.ht!, w = x.w!, er = x.er;
      const z = (80 / Math.sqrt(er)) * Math.log((1.9 * (2 * hp + t)) / (0.8 * w + t)) * (1 - hp / (4 * (hp + ht + t)));
      return { z, warn: range(w, hp) };
    }
    case "s-edge": {
      const t = x.t!, h = x.h!, s = x.s!, w = x.w!, er = x.er;
      const zo0 = (60 / Math.sqrt(er)) * Math.log((1.9 * (2 * h + t)) / (0.8 * w + t));
      const zd = 2 * zo0 * (1 - 0.347 / Math.exp((2.9 * s) / (2 * h + t)));
      return { z: zd, warn: range(w, h) };
    }
  }
  return { warn: "不支持的拓扑" };
}

// ── dB ↔ 线性（电压/功率）──
// 电压/电流等场量用 20log10，功率等能量量用 10log10；linear 为相对参考的无量纲比值。
export function dbToLinear(db: number, power: boolean): number {
  return 10 ** (db / (power ? 10 : 20));
}
export function linearToDb(ratio: number, power: boolean): number {
  return (power ? 10 : 20) * Math.log10(ratio);
}

// ── 带宽 ↔ 上升时间（10%–90% 阶跃上升时间，近似 BW ≈ 0.35 / tr）──
export function bandwidthFromRiseTime(tr: number): number {
  return 0.35 / tr; // tr 秒 → BW Hz
}
export function riseTimeFromBandwidth(bw: number): number {
  return 0.35 / bw; // BW Hz → tr 秒
}

// ── VRMS / dBm / dBu / dBV（音频参考电平）──
// dBu 基准电压 0.77459667V（√0.6，即 1mW/600Ω）；dBV 基准 1V；dBm 基准 1mW（转电压需阻抗）。
export const DBU_REF = 0.7745966692414834;
export function vToDbv(vrms: number): number { return 20 * Math.log10(vrms); }
export function vToDbu(vrms: number): number { return 20 * Math.log10(vrms / DBU_REF); }
export function vToDbm(vrms: number, z: number): number {
  if (z <= 0) return NaN;
  return 10 * Math.log10(((vrms * vrms) / z) * 1000);
}
export function dbvToV(dbv: number): number { return 10 ** (dbv / 20); }
export function dbuToV(dbu: number): number { return DBU_REF * 10 ** (dbu / 20); }
export function dbmToV(dbm: number, z: number): number {
  if (z <= 0) return NaN;
  return Math.sqrt((z * 10 ** (dbm / 10)) / 1000);
}

// ── 波形（峰值因数）、峰峰值/有效值、功率→电压、电压增益（Np 奈培）──
export type CrestWave = "sine" | "square" | "triangle";
export function crest(wave: CrestWave): number {
  return wave === "square" ? 1 : wave === "triangle" ? Math.sqrt(3) : Math.SQRT2;
}
export function vrmsFromVpeak(vpk: number, wave: CrestWave): number { return vpk / crest(wave); }
export function vpeakFromVrms(vrms: number, wave: CrestWave): number { return vrms * crest(wave); }
export function voltageFromPowerMw(mw: number, z: number): number { return Math.sqrt((z * mw) / 1000); }
export function gainToDb(a: number): number { return 20 * Math.log10(a); }
export function dbToGain(db: number): number { return 10 ** (db / 20); }
export function gainToNp(a: number): number { return Math.log(a); }
export function npToGain(np: number): number { return Math.exp(np); }

// ── 声学电平（dB SPL）：基准 20µPa；声强 I=p²/Z0，Z0=400(=ρc)，此时 SIL≡SPL ──
export const SPL_REF = 2e-5;   // 20 µPa 听觉阈值
export const AIR_Z0 = 400;     // 空气特性声阻抗 N·s/m³ (ρc)
export function paToSpl(p: number): number { return 20 * Math.log10(p / SPL_REF); }
export function splToPa(spl: number): number { return SPL_REF * 10 ** (spl / 20); }
export function soundIntensity(p: number, z0: number): number { return (p * p) / z0; }
export function paFromIntensity(i: number, z0: number): number { return Math.sqrt(i * z0); }
export function intensityToSil(i: number): number { return 10 * Math.log10(i / 1e-12); }

// ── 声源声功率级 Lw：基准 P_ac0 = 1pW = 1e-12 W ≡ 0 dB-SWL（与距离无关）──
export const SOUND_PWR_REF = 1e-12; // 1 pW
export function pacToLw(pac: number): number { return 10 * Math.log10(pac / SOUND_PWR_REF); }
export function lwToPac(lw: number): number { return SOUND_PWR_REF * 10 ** (lw / 10); }

// 指向性因子 Q、距离 r 下，测量点面积 A = 4π·r²/Q（球面 A=4πr²，Q=1 全球 /2 半球 /4 四分之一球 /8 八分之一球）
// 声压级(声强级) Lp = Lw − 10·log10(A)；声强 I = P_ac/A = Q·P_ac/(4πr²)
// 反向：给定测量点 Lp 与 Q、r，反推声源声功率级 Lw = Lp + 10·log10(A)
export function pointArea(q: number, r: number): number { return (4 * Math.PI * r * r) / q; }
export function splFromSource(lw: number, q: number, r: number): number { return lw - 10 * Math.log10(pointArea(q, r)); }
export function sourceFromSpl(lp: number, q: number, r: number): number { return lp + 10 * Math.log10(pointArea(q, r)); }
export function intensityFromSource(lw: number, q: number, r: number): number { return lwToPac(lw) * q / (4 * Math.PI * r * r); }
