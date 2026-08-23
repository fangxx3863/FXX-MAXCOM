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

console.log(`\n结果: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
