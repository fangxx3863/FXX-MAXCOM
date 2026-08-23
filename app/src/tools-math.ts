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
