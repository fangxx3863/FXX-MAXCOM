// 工具页计算器纯逻辑回归：esbuild 打包 src/tools-math.ts 后在 Node 里跑断言。
// 覆盖：555 单稳态/非稳态、衰减器四型、电容三位代码、电池续航、欧姆定律、电抗、
// RC 时间常数、LED 串联电阻、滤波器截止频率、dBm、电容器安全放电、串/并联电阻电容。
// 机器可验：任何断言失败即打印 ✗ 并以非零退出，接入 npm run build。
import { tmpdir } from "node:os";
import { join } from "node:path";
const { buildSync } = await import("esbuild");
const out = join(tmpdir(), `tools-test-${process.pid}.mjs`);
buildSync({
  entryPoints: ["src/tools-math.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});
const M = await import(`file://${out}`);

let pass = 0;
let fail = 0;
function check(label, got, want) {
  const eq = (a, b) => (Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b);
  const ok = typeof want === "function" ? want(got) : eq(got, want);
  if (ok) pass++;
  else {
    fail++;
    console.error(`✗ ${label}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
  }
}
const near = (want, tol = 1e-6) => (got) => typeof got === "number" && Math.abs(got - want) <= tol * Math.max(1, Math.abs(want));

// ── 555 定时器 ──
check("mono555 10kΩ+1000µF => 11s", M.mono555(10000, 0.001), near(11));
check("mono555 100Ω+10µF => 1.1ms", M.mono555(100, 10e-6), near(0.0011));
// 示例：R1=10k, R2=15k, C=10µF（非稳态）
const a = M.astable555(10000, 15000, 10e-6);
check("astable tHigh 0.693*(10k+15k)*10µF", a.tHigh, near(0.17325));
check("astable tLow 0.693*15k*10µF", a.tLow, near(0.10395));
check("astable freq 1/(tH+tL)", a.freq, near(1 / 0.2772));
check("astable duty (R1+R2)/(R1+2R2)", a.duty, near(25000 / 40000));

// ── 衰减器（K=10^(20/20)=10, Z0=50）──
check("att pi K=10 R1", M.attenuator("pi", 20, 50).r1, near(50 * 11 / 9));
check("att pi R2", M.attenuator("pi", 20, 50).r2, near(25 * 99 / 10));
check("att bridgeT R1", M.attenuator("bridgeT", 20, 50).r1, near(450));
check("att bridgeT R2", M.attenuator("bridgeT", 20, 50).r2, near(50 / 9));
const rf = M.attenuator("reflective", 20, 50);
check("att reflective rHi", rf.rHi, near(50 * 11 / 9));
check("att reflective rLo", rf.rLo, near(50 * 9 / 11));
check("att T R1", M.attenuator("T", 20, 50).r1, near(50 * 9 / 11));
check("att T R2", M.attenuator("T", 20, 50).r2, near(1000 / 99));

// ── 电容三位代码 ──
check("cap code 104", M.capCode3("104"), 100000);
check("cap code 472", M.capCode3("472"), 4700);
check("cap code 100", M.capCode3("100"), 10);
check("cap code 1xx invalid", M.capCode3("1x"), null);

// ── 电池续航 ──
check("battery 1000mAh/100mA", M.batteryLifeHours(1000, 100), 10);
check("battery 2000mAh/500mA", M.batteryLifeHours(2000, 500), 4);
check("battery zero current NaN", (() => { const r = M.batteryLifeHours(1000, 0); return Number.isNaN(r); })(), true);

// ── 欧姆定律 ──
const o = M.ohmLaw(5, 0.1);
check("ohm R=V/I", o.r, 50);
check("ohm P=V*I", o.p, near(0.5));

// ── 电抗 ──
const rc = M.reactance(1000, 10e-6, 10e-6);
check("reactance XL", rc.xl, near(2 * Math.PI * 1000 * 10e-6));
check("reactance XC", rc.xc, near(1 / (2 * Math.PI * 1000 * 10e-6)));

// ── RC 时间常数 ──
check("rcTau 1kΩ*10µF", M.rcTau(1000, 10e-6), near(0.01));

// ── LED 串联电阻 ──
check("led (5-2)/0.02", M.ledResistor(5, 2, 0.02), 150);

// ── 滤波器截止频率 ──
check("filter rc", M.filterFc("rc", 1000, 1e-6, null), near(1 / (2 * Math.PI * 1000 * 1e-6)));
check("filter rl", M.filterFc("rl", 1000, null, 1e-3), near(1000 / (2 * Math.PI * 1e-3)));
check("filter lc", M.filterFc("lc", null, 1e-6, 1e-3), near(1 / (2 * Math.PI * Math.sqrt(1e-9))));
check("filter rc zero -> null", M.filterFc("rc", 0, 1e-6, null), null);

// ── dBm / 瓦特 ──
check("dbm 0 -> 1mW", M.dbmToMwt(0), 1);
check("dbm 10 -> 10mW", M.dbmToMwt(10), 10);
check("dbm -30 -> 0.001mW", M.dbmToMwt(-30), near(0.001));

// ── 电容器安全放电 ──
const cd = M.capDischarge(1e-4, 100, 1, 1e5);
check("capdischarge tau", cd.tau, 10);
check("capdischarge time", cd.time, near(10 * Math.log(100)));
check("capdischarge power", cd.power, near(0.1));
check("capdischarge energy", cd.energy, near(0.5));

// ── 串联/并联电阻 ──
check("seriesRes 3x100", M.seriesRes([100, 100, 100]), 300);
check("parallelRes 3x100", M.parallelRes([100, 100, 100]), near(100 / 3));
check("parallelRes null -> null", M.parallelRes([100, null, 100]), null);
check("seriesRes empty -> null", M.seriesRes([]), null);

// ── 串联/并联电容 ──
check("parallelCap 2x10µF", M.parallelCap([10e-6, 10e-6]), near(20e-6));
check("seriesCap 2x10µF", M.seriesCap([10e-6, 10e-6]), near(5e-6));

// ── SMD 电阻三位代码 ──
check("smd3 102 -> 1kΩ", M.smdResistor3("102"), 1000);
check("smd3 471 -> 470Ω", M.smdResistor3("471"), 470);

// ── PCB 走线阻抗（mil 制，t=1.4/εr=4.5，参考值）──
// 参考：W=10 H=10 T=1.4 εr=4.5 → 微带线 66.2166Ω。
check("trace microstrip W=10,H=10", M.traceImpedance("m", "im", { w: 10, t: 1.4, h: 10, er: 4.5 }).z, near(66.2166, 1e-3));
check("trace embedded W=10,H=10,HP=5", M.traceImpedance("m-embedded", "im", { w: 10, t: 1.4, h: 10, hp: 5, er: 4.5 }).z, near(33.4922, 1e-3));
check("trace edge-microstrip W=10,S=10", M.traceImpedance("m-edge", "im", { w: 10, t: 1.4, h: 10, s: 10, er: 4.5 }).z, near(108.0934, 1e-3));
check("trace stripline W=10,H=10", M.traceImpedance("s", "im", { w: 10, t: 1.4, h: 10, er: 4.5 }).z, near(41.4233, 1e-3));
check("trace asym W=10,HA=10,HB=20", M.traceImpedance("s-asym", "im", { w: 10, t: 1.4, ha: 10, hb: 20, er: 4.5 }).z, near(48.3272, 1e-3));
check("trace broadside W=10,HP=10,HT=10", M.traceImpedance("s-broadside", "im", { w: 10, t: 1.4, hp: 10, ht: 10, er: 4.5 }).z, near(48.7788, 1e-3));
check("trace edge-stripline W=10,S=10", M.traceImpedance("s-edge", "im", { w: 10, t: 1.4, h: 10, s: 10, er: 4.5 }).z, near(75.4322, 1e-3));
// 反算：给定 Z0=66.216575 求线宽，应回到 W=10 mil（往返一致）
check("trace microstrip width-inverse W≈10", M.traceImpedance("m", "w", { z: 66.216575, t: 1.4, h: 10, er: 4.5 }).w, near(10, 1e-2));
// 宽线/高比越界警示（w/h=5 超出 0.1–2.0，附警示但仍给值）
const wide = M.traceImpedance("m", "im", { w: 50, t: 1.4, h: 10, er: 4.5 });
check("trace wide-ratio warn set", typeof wide.warn, "string");
check("trace wide-ratio value finite", Number.isFinite(wide.z), true);
// 嵌入式：hp 必须小于 h（h/hp>1.2），否则警示
check("trace embedded hp>=h warn", M.traceImpedance("m-embedded", "im", { w: 10, t: 1.4, h: 10, hp: 10, er: 4.5 }).warn !== undefined, true);

// ── 格式化 ──
check("fmt trim zeros", M.fmt(100.00000001, 3), "100");
check("fmtOhm 1000000", M.fmtOhm(1e6), "1 MΩ");
check("fmtCap 0.1µF", M.fmtCap(1e5), "100 nF");
check("fmtCap 1µF", M.fmtCap(1e6), "1 µF");

// ── dB ↔ 线性（电压 20log，功率 10log）──
check("db2lin 0dB 电压=1", M.dbToLinear(0, false), 1);
check("db2lin 20dB 电压=10", M.dbToLinear(20, false), 10);
check("db2lin -20dB 电压=0.1", M.dbToLinear(-20, false), near(0.1));
check("db2lin 3dB 电压=1.4125", M.dbToLinear(3, false), near(1.41254, 1e-4));
check("db2lin 10dB 功率=10", M.dbToLinear(10, true), 10);
check("db2lin 3dB 功率=2", M.dbToLinear(3, true), near(1.99526, 1e-4));
check("lin2db 电压 10x=20dB", M.linearToDb(10, false), near(20));
check("lin2db 功率 2x=3.0103dB", M.linearToDb(2, true), near(3.0103, 1e-3));

// ── 带宽 ↔ 上升时间（BW ≈ 0.35/tr）──
check("bw 1ns→350MHz", M.bandwidthFromRiseTime(1e-9), near(3.5e8));
check("bw 10ns→35MHz", M.bandwidthFromRiseTime(10e-9), near(3.5e7));
check("bw 1ms→350Hz", M.bandwidthFromRiseTime(1e-3), near(350));
check("bw 350MHz→1ns", M.riseTimeFromBandwidth(3.5e8), near(1e-9));
check("bw reverse 35MHz→10ns", M.riseTimeFromBandwidth(3.5e7), near(10e-9));

// ── VRMS / dBm / dBu / dBV（sengpielaudio 参考电平）──
check("dbv 1V=0dBV", M.vToDbv(1), near(0));
check("dbu 1V=2.2185dBu", M.vToDbu(1), near(2.218487, 1e-3));
check("dbu 0.77459667V=0dBu", M.vToDbu(0.7745966692414834), near(0, 1e-6));
check("dbm@600 1V=2.2185", M.vToDbm(1, 600), near(2.218487, 1e-3));
check("dbm@600 0.77459667V=0", M.vToDbm(0.7745966692414834, 600), near(0, 1e-4));
check("dbvToV 0dB=1V", M.dbvToV(0), 1);
check("dbuToV 0dBu=0.7746V", M.dbuToV(0), near(0.77459667, 1e-6));
check("dbmToV 0dBm@600=0.7746V", M.dbmToV(0, 600), near(0.77459667, 1e-6));
check("dbmToV z<=0 → NaN", Number.isNaN(M.dbmToV(0, 0)), true);
check("600Ω 时 dBm=dBu 恒等", M.vToDbu(1) === M.vToDbm(1, 600) || Math.abs(M.vToDbu(1) - M.vToDbm(1, 600)) < 1e-12, true);

// ── 波形峰值因数与峰峰值（sengpielaudio：正弦 Vpp=2.828·Vrms）──
check("sine crest=√2", M.crest("sine"), near(Math.SQRT2));
check("square crest=1", M.crest("square"), 1);
check("triangle crest=√3", M.crest("triangle"), near(Math.sqrt(3)));
check("sine Vrms=Vp/√2", M.vrmsFromVpeak(1, "sine"), near(0.7071067811865476));
check("sine Vp=Vrms·√2", M.vpeakFromVrms(0.7071067811865476, "sine"), near(1));
check("triangle Vrms=Vp/√3", M.vrmsFromVpeak(1, "triangle"), near(1 / Math.sqrt(3)));
check("50Ω 1mW→0.22361V（sengpielaudio 0.224V）", M.voltageFromPowerMw(1, 50), near(0.2236067977));

// ── 电压增益 V/V ↔ dB ↔ Np（analog dbconvert：10V/V=20dB=2.303Np）──
check("gain 10→20dB", M.gainToDb(10), near(20));
check("gain 10→2.3026Np", M.gainToNp(10), near(2.302585093, 1e-6));
check("dB 20→gain10", M.dbToGain(20), near(10));
check("Np 2.3026→gain10", M.npToGain(2.302585093), near(10));

// ── 声学 dB SPL（基准 20µPa；声强 I=p²/Z0，Z0=400=ρc；SIL≡SPL）──
check("SPL_REF=20µPa", M.SPL_REF, 2e-5);
check("AIR_Z0=400", M.AIR_Z0, 400);
check("0dBSPL→20µPa", M.splToPa(0), 2e-5);
check("1Pa→93.98dBSPL", M.paToSpl(1), near(93.9794, 1e-3));
check("20Pa→120dBSPL", M.paToSpl(20), near(120));
check("1µPa→-26.02dBSPL", M.paToSpl(1e-6), near(-26.02, 1e-2));
check("1Pa→I=0.0025W/m²", M.soundIntensity(1, 400), near(0.0025));
check("I 0.0025→p=1Pa", M.paFromIntensity(0.0025, 400), near(1));
check("1Pa→SIL=93.98（Z0=400 时 SIL≡SPL）", M.intensityToSil(0.0025), near(93.9794, 1e-3));

// ── 声源声功率级 Lw/Pac ↔ 距离 r 处 SPL（sengpielaudio conv1/conv2 实测值）──
check("SOUND_PWR_REF=1pW", M.SOUND_PWR_REF, 1e-12);
check("pacToLw(1W)=120dB", M.pacToLw(1), near(120));
check("lwToPac(120dB)=1W", M.lwToPac(120), near(1));
check("pointArea(1,1)=4π", M.pointArea(1, 1), near(4 * Math.PI));
check("Lw120 Q1 r1→SPL 109.008（实测）", M.splFromSource(120, 1, 1), near(109.00790136128558, 1e-6));
check("Lw120 Q1 r0.2821→SPL 120（等声级点）", M.splFromSource(120, 1, 0.2821), near(119.99983963817824, 1e-3));
check("Lw120 Q1 r2→SPL 102.987（每翻倍-6dB）", M.splFromSource(120, 1, 2), near(102.98730144800595, 1e-4));
check("Lw100 Q2 r1→SPL 92.018（半球 8dB）", M.splFromSource(100, 2, 1), near(92.01820131792539, 1e-4));
check("Lw100 Q4 r1→SPL 95.029（1/4球 5dB）", M.splFromSource(100, 4, 1), near(95.0285012745652, 1e-4));
check("Lw100 Q8 r1→SPL 98.039（1/8球 2dB）", M.splFromSource(100, 8, 1), near(98.038801231205, 1e-4));
check("反向 SPL92 Q1 r1→Lw 103（conv2）", M.sourceFromSpl(92, 1, 1), near(102.99209863871442, 1e-3));
check("intensityFromSource 1W Q1 r1→0.07958 W/m²", M.intensityFromSource(120, 1, 1), near(0.07957747154594767, 1e-6));

console.log(`\n结果: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
