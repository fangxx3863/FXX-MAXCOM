// 参考换算器实测基线回归：用 jsdom 真实构建各工具，填入在线参考换算器的实测输入，
// 断言输出等于其返回的数值（2026-08-24 实测，见各断言注释里的来源）。数值与公式均为事实，
// 仅作为正确性基线，防后续改动把已验证的正确结果改坏。
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
const { buildSync } = await import("esbuild");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:1420/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
try { Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true }); } catch {}
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.Select = dom.window.HTMLSelectElement;
globalThis.Node = dom.window.Node;

const out = join(tmpdir(), `tools-baseline-test-${process.pid}.mjs`);
buildSync({
  entryPoints: ["src/pages/tools.ts"],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  loader: { ".png": "dataurl", ".jpg": "dataurl", ".svg": "dataurl", ".css": "empty" },
});
const M = await import(`file://${out}`);

let pass = 0, fail = 0;
const fire = (el, name) => el.dispatchEvent(new dom.window.Event(name, { bubbles: true }));
const has = (s, sub) => typeof s === "string" && s.includes(sub);
function check(label, cond) { if (cond) pass++; else { fail++; console.error(`✗ ${label}`); } }
function hostOf(id) { const h = document.createElement("div"); const d = M.TOOLS.find((t) => t.id === id); if (!d) throw new Error("no tool " + id); d.build(h); return h; }
function setIn(el, val) { const p = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value") || Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value"); p.set.call(el, String(val)); fire(el, "input"); fire(el, "change"); }
function setSel(el, val) { const p = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value"); p.set.call(el, String(val)); fire(el, "change"); }
function set(id, inputs) { const h = hostOf(id); for (const [sel, v] of inputs) { const el = h.querySelector(sel); if (el) el.tagName === "SELECT" ? setSel(el, v) : setIn(el, v); } return h; }
function val(h, sel) { const el = h.querySelector(sel); return el ? (el.value !== undefined ? el.value : (el.textContent || "").trim()) : null; }

// ── 欧姆定律（V=12, I=0.5 → R=24, P=6）──
let h = set("ohm", [["#ohm-v", "12"], ["#ohm-i", "0.5"], ["#ohm-iu", "1"]]);
check("ohm R=24", val(h, "#ohm-r") === "24");
check("ohm P=6W", has(val(h, "#ohm-line"), "P = 6 W"));

// ── LED 串联电阻（Vs=5, Vf=2, If=20mA → R=150, W=0.06）──
h = set("led-resistor", [["#led-vs", "5"], ["#led-vf", "2"], ["#led-if", "20"], ["#led-ifu", "0.001"]]);
check("led R=150", val(h, "#led-r") === "150");
check("led W=0.06W", val(h, "#led-w") === "0.06");

// ── PCB 线宽（I=1A, ΔT=10°C, 1oz → 外层 11.82624098mil, 内层 30.76525445mil）─
h = set("pcb-trace-width", [["#pcb-i", "1"], ["#pcb-dt", "10"], ["#pcb-layer", "0.048"], ["#pcb-th", "1"], ["#pcb-thu", "0.035"]]);
check("pcb outer ≈11.826mil", has(val(h, "#pcb-w"), "0.300386"));
h = set("pcb-trace-width", [["#pcb-i", "1"], ["#pcb-dt", "10"], ["#pcb-layer", "0.024"], ["#pcb-th", "1"], ["#pcb-thu", "0.035"]]);
check("pcb inner ≈30.765mil", has(val(h, "#pcb-w"), "0.781437"));
// 2oz 外层应≈外层 1oz 的一半宽度（铜厚翻倍）
h = set("pcb-trace-width", [["#pcb-i", "1"], ["#pcb-dt", "10"], ["#pcb-layer", "0.048"], ["#pcb-th", "1"], ["#pcb-thu", "0.07"]]);
check("pcb 2oz half width", has(val(h, "#pcb-w"), "0.150193"));

// ── 衰减器四型（20dB/50Ω：Pi=61.1111/247.50000, 桥T=450.0000/5.55556, 反射=61.1111/40.90910, T=40.9091/10.10101）─
for (const [ty, r1, r2] of [["pi", "61.111111", "247.5"], ["bridgeT", "450", "5.555556"], ["T", "40.909091", "10.10101"]]) {
  h = hostOf("attenuator"); setIn(h.querySelector("#att-db"), "20"); setIn(h.querySelector("#att-z"), "50");
  h.querySelector(`[data-type="${ty}"]`).click();
  check(`att ${ty} R1`, val(h, "#att-r1").startsWith(r1));
  check(`att ${ty} R2`, val(h, "#att-r2").startsWith(r2));
}
h = hostOf("attenuator"); setIn(h.querySelector("#att-db"), "20"); setIn(h.querySelector("#att-z"), "50");
h.querySelector('[data-type="reflective"]').click();
check("att reflective R1=rHi/rLo", has(val(h, "#att-r1"), "61.111111 / 40.909091"));

// ── 电池续航（1000mAh/100mA → 10 Hours ─ 时/天/年切换单位 + 单位不内嵌输出值）─
h = set("battery-life", [["#bt-cap", "1000"], ["#bt-capu", "1"], ["#bt-cur", "100"], ["#bt-curu", "1"]]);
check("battery 10", has(val(h, "#bt-out"), "10"));
// 天/年：value 须为可解析数字（曾用 "1/24"、"1/8760" → Number 得 NaN 使天/年失效），且单位不重复进输出值
h = set("battery-life", [["#bt-cap", "1000"], ["#bt-capu", "1"], ["#bt-cur", "100"], ["#bt-curu", "1"], ["#bt-outu", "24"]]);
check("battery days=10/24", val(h, "#bt-out") === "0.416667");
h = set("battery-life", [["#bt-cap", "1000"], ["#bt-capu", "1"], ["#bt-cur", "100"], ["#bt-curu", "1"], ["#bt-outu", "8760"]]);
check("battery years=10/8760", val(h, "#bt-out") === "0.001142");
// 单位只由右侧 #bt-outu 显示，输出值文本不应再含“小时/天/年”
h = set("battery-life", [["#bt-cap", "1000"], ["#bt-capu", "1"], ["#bt-cur", "100"], ["#bt-curu", "1"]]);
check("battery 输出不含单位文字", !has(val(h, "#bt-out"), "小时") && h.querySelector("#bt-outu").selectedOptions[0].textContent === "小时");

// ── 电容器安全放电（100µF/100V→1V/100kΩ → τ=10s, 峰值功率0.1W, 能量0.5J）─
h = set("capacitor-safe-discharge", [["#capd-c", "0.0001"], ["#capd-cu", "1"], ["#capd-v0", "100"], ["#capd-vs", "1"], ["#capd-r", "100000"], ["#capd-ru", "1"]]);
check("capD tau=10", has(val(h, "#capd-tau"), "10"));
check("capD t≈46.05", has(val(h, "#capd-t"), "46.05"));
check("capD power=0.1", has(val(h, "#capd-p"), "0.1"));
check("capD energy=0.5", has(val(h, "#capd-e"), "0.5"));

// ── 分压器（V=10, R1=R2=1000 → Vout=5）─
h = set("voltage-divider", [["#vd-vin", "10"], ["#vd-r1", "1000"], ["#vd-r1u", "1"], ["#vd-r2", "1000"], ["#vd-r2u", "1"]]);
check("vdiv vout=5", val(h, "#vd-vout") === "5");

// ── 时间常数（1kΩ/100µF/10V → τ=0.1s, 能量0.005J）─
h = set("time-constant", [["#tc-r", "1000"], ["#tc-ru", "1"], ["#tc-c", "100"], ["#tc-cu", "1e-6"], ["#tc-v", "10"]]);
check("tc τ=0.1s", val(h, "#tc-out") === "0.1");
check("tc E=0.005J", val(h, "#tc-e") === "0.005");

// ── 三相（400V/10A → S=√3·V·I=6928.2VA；pf 由用户输入）─
h = set("three-phase", [["#tp-v", "400"], ["#tp-i", "10"], ["#tp-pf", "1"]]);
check("3phase S=6.928kVA", val(h, "#tp-s") === "6.928203");
check("3phase P=S*pf", val(h, "#tp-p") === "6.928203");
check("3phase Q=0@pf1", val(h, "#tp-q") === "0");

// ── 频率波长（300MHz → 0.9993m，采用精确光速 299792458）─
h = set("frequency-wavelength", [["#fw-f", "300"], ["#fw-fu", "1e6"]]);
check("fw 0.9993m", has(val(h, "#fw-w"), "0.999308"));

// ── 分数换算（0.75 → 3/4）─
h = set("fraction", [["#frac-in", "0.75"]]);
check("fraction 0.75=3/4", has(val(h, "#frac-out"), "3/4"));

// ── 数制（255 → 377/FF/11111111）─
h = set("number-base", [["#nb-d", "255"]]);
check("nb hex FF", val(h, "#nb-h") === "FF");
check("nb oct 377", val(h, "#nb-o") === "377");
check("nb bin 11111111", val(h, "#nb-b") === "11111111");

// ── RC 截止频率（1kΩ/1µF → 159.1549Hz，低通与高通相同）─
h = set("filter", [["#flt-type", "rc"], ["#flt-band", "lp"], ["#flt-r", "1000"], ["#flt-ru", "1"], ["#flt-c", "1"], ["#flt-cu", "1e-6"]]);
check("filter lowpass rc 159.155Hz", val(h, "#flt-f").startsWith("159.154"));
check("filter lowpass label", has(val(h, "#flt-formula"), "低通"));
h = set("filter", [["#flt-type", "rc"], ["#flt-band", "hp"], ["#flt-r", "1000"], ["#flt-ru", "1"], ["#flt-c", "1"], ["#flt-cu", "1e-6"]]);
check("filter highpass rc 159.155Hz", val(h, "#flt-f").startsWith("159.154"));
check("filter highpass label", has(val(h, "#flt-formula"), "高通"));

// ── 线径（AWG24 → 0.0201in / 0.5106mm / 404cmil）─
h = set("wire-gauge", [["#wg-awg", "24"]]);
check("wg in 0.0201", has(val(h, "#wg-in"), "0.020101"));
check("wg mm 0.5106", has(val(h, "#wg-mm"), "0.510559"));
check("wg cmil 404", has(val(h, "#wg-cm"), "404"));

// ── SMD 电阻（三位：102 → 1kΩ）──
h = set("smd-resistor", [["#smdr-code", "102"]]);
check("smdr 102=1kΩ", has(val(h, ".tool-resultline"), "1 kΩ"));

// ── SMD 电容（三位：104 → 100nF）──
h = set("smd-capacitor", [["#smdc-code", "104"]]);
check("smdc 104=100nF", has(val(h, ".tool-resultline"), "100 nF"));

// ── 电抗（公式：XL=2πfL, XC=1/(2πfC)）──
h = set("reactance", [["#rx-f", "1000"], ["#rx-fu", "1"], ["#rx-l", "10"], ["#rx-lu", "1e-6"], ["#rx-c", "10"], ["#rx-cu", "1e-6"]]);
check("react XL≈0.0628", has(val(h, "#rx-xl"), "0.062832"));
check("react XC≈15.92", has(val(h, "#rx-xc"), "15.915494"));

// ── 色码（黄蓝棕绿：46×10=460Ω ±0.5%——四环规范）─
h = set("color-code", [["#cc-a", "4"], ["#cc-b", "6"], ["#cc-m", "1"], ["#cc-t", "5"]]);
check("colorcode 460Ω", has(val(h, ".tool-resultline"), "460"));

// ── 色码 5 环（黄蓝黑棕绿：460×10=4600Ω ±0.5%）──
h = set("color-code", [["#cc-band", "5"], ["#cc-a", "4"], ["#cc-b", "6"], ["#cc-d3", "0"], ["#cc-m", "1"], ["#cc-t", "5"]]);
check("colorcode 5band 4600Ω", has(val(h, ".tool-resultline"), "4600"));

// ── 色码 6 环（5 环 + 温度系数 棕=100ppm/K）──
h = set("color-code", [["#cc-band", "6"], ["#cc-a", "4"], ["#cc-b", "6"], ["#cc-d3", "0"], ["#cc-m", "1"], ["#cc-t", "5"], ["#cc-tc", "0"]]);
check("colorcode 6band 4600Ω+tol", has(val(h, ".tool-resultline"), "4600"));
check("colorcode 6band tempcoef", has(val(h, ".tool-resultline"), "100 ppm/K"));

// ── 并联/串联电容（2×10µF → 并联20µF, 串联5µF）─
h = set("parallel-series-cap", [["#cap-c1", "10"]]);
check("pcap par=20µF", val(h, "#cap-par") === "20 µF");
check("pcap ser=5µF", val(h, "#cap-ser") === "5 µF");

// ── 单位换算（标准值）：输出只写数值，单位由结果 select 显示（不再内嵌导致重复）──
function unit(id, from, to, input) {
  const h = hostOf(id); const inp = h.querySelector(".tool-input"); const outp = h.querySelector(".tool-output");
  const sels = h.querySelectorAll(".tool-sel"); setSel(sels[0], from); setSel(sels[1], to); setIn(inp, input);
  return outp.value;
}
function unitSym(id, to) {
  const h = hostOf(id); const sels = h.querySelectorAll(".tool-sel"); setSel(sels[1], to);
  return sels[1].selectedOptions[0].textContent;
}
check("temp 100C=212F", unit("temperature", "c", "f", "100") === "212" && unitSym("temperature", "f") === "°F");
check("temp 100C=373.15K", unit("temperature", "c", "k", "100") === "373.15" && unitSym("temperature", "k") === "K");
check("ind 1mH=1000µH", unit("inductance", "mh", "uh", "1") === "1000" && unitSym("inductance", "uh") === "µH");
check("press 1atm=101325Pa", unit("pressure", "atm", "pa", "1") === "101325" && unitSym("pressure", "pa") === "Pa");
check("press 1atm=14.696psi", unit("pressure", "atm", "psi", "1") === "14.695949" && unitSym("pressure", "psi") === "psi");
check("eng 1BTU=1055.06J", unit("energy", "btu", "j", "1") === "1055.055853" && unitSym("energy", "j") === "J");
check("len 1m=39.37in", unit("length", "m", "in", "1") === "39.370079" && unitSym("length", "in") === "in");
check("len 1mm=39.37mil", unit("length", "mm", "mil", "1") === "39.370079" && unitSym("length", "mil") === "mil");
check("len 默认 mm→mil", (() => { const h = hostOf("length"); const s = h.querySelectorAll(".tool-sel"); return s[0].value === "mm" && s[1].value === "mil"; })());
check("wt 1kg=2.2046lb", unit("weight", "kg", "lb", "1") === "2.204623" && unitSym("weight", "lb") === "lb");
check("vol 1L=0.2642gal", unit("volume", "l", "gal", "1") === "0.264172" && unitSym("volume", "gal") === "gal (US)");
check("force 1N=0.2248lbf", unit("force", "n", "lbf", "1") === "0.224809" && unitSym("force", "lbf") === "lbf");
check("pwr 1hp=745.7W", unit("power", "hp", "w", "1") === "745.699872" && unitSym("power", "w") === "W");

// ── 电容换算（单位自选 + 三位代码联动：改输入/单位会同步更新代码）──
h = set("capacitance-conversion", [["#cap-in", "1000"], ["#cap-inu", "pf"]]);
check("capConv 1000pF 输出=1000", val(h, "#cap-out") === "1000");
check("capConv 1000pF 代码=102", val(h, "#cap-code") === "102");
h = set("capacitance-conversion", [["#cap-in", "4.7"], ["#cap-inu", "uf"]]);
check("capConv 4.7µF 输出=4700000", val(h, "#cap-out") === "4700000");
check("capConv 4.7µF 代码=475", val(h, "#cap-code") === "475");
check("capConv 4.7µF 结果含 nF", has(val(h, "#cap-result"), "4700 nF"));
check("capConv 4.7µF 输出不含单位", !has(val(h, "#cap-out"), "pF"));
// 代码驱动：输入 475 → 4.7µF，输入/输出联动
h = set("capacitance-conversion", [["#cap-inu", "uf"], ["#cap-code", "475"]]);
check("capConv 代码475→输入4.7µF", val(h, "#cap-in") === "4.7");
check("capConv 代码475→输出4700000", val(h, "#cap-out") === "4700000");

// ── dB ↔ 线性（参考 1V/1W，电压 20log、功率 10log）──
h = set("db-linear", [["#dbl-qty", "v"], ["#dbl-dir", "db2lin"], ["#dbl-ref", "1"], ["#dbl-in", "0"]]);
check("dbl 0dB电压=1V", val(h, "#dbl-out") === "1");
h = set("db-linear", [["#dbl-qty", "v"], ["#dbl-dir", "db2lin"], ["#dbl-ref", "1"], ["#dbl-in", "20"]]);
check("dbl 20dB电压=10V", val(h, "#dbl-out") === "10");
h = set("db-linear", [["#dbl-qty", "p"], ["#dbl-dir", "db2lin"], ["#dbl-ref", "1"], ["#dbl-in", "10"]]);
check("dbl 10dB功率=10W", val(h, "#dbl-out") === "10");
h = set("db-linear", [["#dbl-qty", "v"], ["#dbl-dir", "lin2db"], ["#dbl-ref", "1"], ["#dbl-in", "10"]]);
check("dbl 10V=20dB", val(h, "#dbl-out") === "20");

// ── 带宽 ↔ 上升时间（BW≈0.35/tr）──
h = set("bandwidth", [["#bw-dir", "tr"], ["#bw-in", "1"], ["#bw-inu", "1e-9"]]);
check("bw 1ns=350MHz", val(h, "#bw-out").trim() === "350 MHz");
h = set("bandwidth", [["#bw-dir", "tr"], ["#bw-in", "10"], ["#bw-inu", "1e-9"]]);
check("bw 10ns=35MHz", val(h, "#bw-out").trim() === "35 MHz");
h = set("bandwidth", [["#bw-dir", "bw"], ["#bw-in", "1"], ["#bw-inu", "1e9"]]);
check("bw 1GHz=350ps", val(h, "#bw-out").trim().startsWith("350 ps"));

// ── 电平 dBm/dBu/dBV/Vp/Vpp/功率（参考：analog dbconvert 实测 Z₀=50 正弦 Vpeak=1→Vrms=0.7071/Power=10mW/dBm=10/dBu=-0.7918/dBV=-3.01）──
h = set("audio-db", [["#adb-z", "50"], ["#adb-vpk", "1"]]);
check("adbd sine 1Vpk→0.7071Vrms", Math.abs(Number(val(h, "#adb-vrms")) - 0.707106781) < 0.001);
check("adbd sine 1Vpk→2Vpp", val(h, "#adb-vpp") === "2");
check("adbd 50Ω 1Vpk→10mW", val(h, "#adb-pm") === "10");
check("adbd 50Ω 1Vpk→10dBm", val(h, "#adb-dbm") === "10");
check("adbd 50Ω 1Vpk→-3.01dBV", val(h, "#adb-dbv").startsWith("-3.0103"));
check("adbd 50Ω 1Vpk→-0.7918dBu", val(h, "#adb-dbu").startsWith("-0.7918"));
h = set("audio-db", [["#adb-z", "600"], ["#adb-vpk", "1"]]);
check("adbd 600Ω Vpk1→dBm=dBu", Math.abs(Number(val(h, "#adb-dbm")) - Number(val(h, "#adb-dbu"))) < 0.001);
h = set("audio-db", [["#adb-wave", "square"], ["#adb-z", "50"], ["#adb-vpk", "1"]]);
check("adbd 方波 1Vpk→1Vrms", val(h, "#adb-vrms") === "1");
check("adbd 方波 1Vpk→0dBV", val(h, "#adb-dbv") === "0");
h = set("audio-db", [["#adb-dbu", "0"]]);
check("adbd 0dBu→0.7746Vrms", Math.abs(Number(val(h, "#adb-vrms")) - 0.77459667) < 0.001);
// ── 电压增益 V/V ↔ dB ↔ Np（analog：10V/V=20dB=2.303Np）──
h = set("audio-db", [["#adb-gain", "10"]]);
check("adbd 增益10→20dB", val(h, "#adb-gaindb") === "20");
check("adbd 增益10→2.3026Np", val(h, "#adb-gainnp").startsWith("2.302585"));
// ── 声学 dB SPL（基准 20µPa；声阻抗 Z0=400＝ρc；SIL≡SPL）──
h = set("audio-db", [["#adb-pa", "1"]]);
check("adbd 1Pa→93.98dBSPL", val(h, "#adb-spl").startsWith("93.9794"));
check("adbd 1Pa→0.0025W/m²", val(h, "#adb-i").startsWith("0.0025"));
check("adbd SPL=SIL(Z0=400)", Math.abs(Number(val(h, "#adb-spl")) - Number(val(h, "#adb-sil"))) < 0.001);
// ── 声源功率级→距离链（sengpielaudio conv1/conv2 实测值）──
h = set("audio-db", [["#adb-lw", "120"], ["#adb-q", "1"], ["#adb-r", "1"]]);
check("adbd Lw120 Q1 r1→109.01dBSPL", val(h, "#adb-spl").startsWith("109.0079"));
check("adbd Lw120 Q1 r1→0.07958W/m²", val(h, "#adb-i").startsWith("0.079577"));
check("adbd Lw120 Q1 r1→Pac=1W", val(h, "#adb-pac").startsWith("1"));
h = set("audio-db", [["#adb-lw", "120"], ["#adb-q", "1"], ["#adb-r", "2"]]);
check("adbd r=2→-6dB 102.99", val(h, "#adb-spl").startsWith("102.9873"));
h = set("audio-db", [["#adb-lw", "100"], ["#adb-q", "4"], ["#adb-r", "1"]]);
check("adbd Q4→-5dB 95.03", val(h, "#adb-spl").startsWith("95.0285"));
h = set("audio-db", [["#adb-q", "1"], ["#adb-r", "1"], ["#adb-spl", "92"]]);
check("adbd 反向92→Lw 102.99", val(h, "#adb-lw").startsWith("102.992"));

console.log(`\n参考基线: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
