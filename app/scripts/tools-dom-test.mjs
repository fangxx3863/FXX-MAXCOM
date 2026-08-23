// 工具页 DOM 级回归：真实驱动各工具构建器（TOOLS[id].build），验证交互/公式/位切换/分型图切换。
// 与 tools-test.mjs（纯数学）互补；任何断言失败即非零退出，接入 npm run build。
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
const { buildSync } = await import("esbuild");

// jsdom 全局（Node 里 window/document 需手动挂载；navigator 为 getter-only 用 defineProperty）
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:1420/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
try {
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
} catch {}
// Element 基类等挂到全局，方便 isInstance / closest 语义一致
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.Select = dom.window.HTMLSelectElement;
globalThis.Node = dom.window.Node;

const out = join(tmpdir(), `tools-dom-test-${process.pid}.mjs`);
buildSync({
  entryPoints: ["src/pages/tools.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  logLevel: "silent",
  loader: { ".png": "dataurl", ".jpg": "dataurl", ".svg": "dataurl", ".css": "empty" },
});
const M = await import(`file://${out}`);

let pass = 0;
let fail = 0;
const ok = (c) => c === true;
function check(label, cond) {
  if (ok(cond)) pass++;
  else {
    fail++;
    console.error(`✗ ${label}`);
  }
}
const has = (s, sub) => typeof s === "string" && s.includes(sub);
const hostOf = (id) => {
  const host = document.createElement("div");
  const def = M.TOOLS.find((t) => t.id === id);
  if (!def) throw new Error(`no tool ${id}`);
  def.build(host);
  return host;
};
const fire = (el, name) => el.dispatchEvent(new dom.window.Event(name, { bubbles: true }));

// ── 555：单稳态 → 非稳态 切换 ──
const h555 = hostOf("555");
const r1 = h555.querySelector("#t555-r1");
const r1s = h555.querySelector("#t555-r1s");
const c = h555.querySelector("#t555-c");
const outEl = h555.querySelector("#t555-out");
const formula = h555.querySelector("#t555-formula");

// 初始单稳态：100Ω + 10µF => 1.1ms，无 R2 字段
check("555 mono: 无 R2 字段", !h555.querySelector("#t555-r2"));
check("555 mono 输出=1.1ms", outEl.value === "1.1 ms");
check("555 mono 公式含 1.1", has(formula.textContent, "1.1"));

// 切到非稳态
h555.querySelector('[data-mode="astable"]').click();
check("555 astable: 插入 R2 字段", !!h555.querySelector("#t555-r2"));
check("555 astable 公式含 0.693", has(formula.textContent, "0.693"));
check("555 astable 输出含 f=", has(outEl.value, "f="));

// DigiKey 示例：R1=10k, R2=15k, C=10µF  => f=1/(tH+tL)≈3.6076Hz, 占空比=62.5%
r1.value = "10"; r1s.value = "1e3"; c.value = "10"; fire(r1, "input");
h555.querySelector("#t555-r2").value = "15"; h555.querySelector("#t555-r2s").value = "1e3";
fire(h555.querySelector("#t555-r2"), "input"); // 验证 R2 输入已绑定（重算）
check("555 astable f≈3.6076", has(outEl.value, "f=3.607"));
check("555 astable 占空比=62.5", has(outEl.value, "占空比=62.5"));

// 回到单稳态：R2 字段被移除，输出恢复（先把 R1 复位为 100Ω）
r1.value = "100"; r1s.value = "1"; c.value = "10"; fire(r1, "input");
h555.querySelector('[data-mode="mono"]').click();
check("555 mono 回退后移除 R2", !h555.querySelector("#t555-r2"));
check("555 mono 回退输出=1.1ms", outEl.value === "1.1 ms");

// 回归（曾修复 bug）：非稳态 → 单稳态 → 非稳态 多轮往返，R2 字段须反复重建/移除且事件不丢
h555.querySelector('[data-mode="astable"]').click();
check("555 往返: 再进非稳态 R2 重建", !!h555.querySelector("#t555-r2"));
r1.value = "10"; r1s.value = "1e3"; c.value = "10"; fire(r1, "input");
h555.querySelector("#t555-r2").value = "15"; h555.querySelector("#t555-r2s").value = "1e3";
fire(h555.querySelector("#t555-r2"), "input");
check("555 往返: R2 事件仍绑定 f≈3.607", has(outEl.value, "f=3.607"));
h555.querySelector('[data-mode="mono"]').click();
check("555 往返: 再回单稳态 R2 移除", !h555.querySelector("#t555-r2"));
r1.value = "100"; r1s.value = "1"; c.value = "10"; fire(r1, "input");
check("555 往返: 单稳态输出恢复=1.1ms", outEl.value === "1.1 ms");

// ── 衰减器：四个类型各自不同的电路图 + 计算 ──
const hAtt = hostOf("attenuator");
const attImg = hAtt.querySelector("#att-diagram img");
const aR1 = hAtt.querySelector("#att-r1");
const aR2 = hAtt.querySelector("#att-r2");
const baseSrc = attImg.src;
check("衰减器 Pi 图非空", baseSrc.startsWith("data:image/svg"));
check("衰减器 Pi: R1≈61.1 (20dB,50Ω)", has(aR1.value, "61.1"));
check("衰减器 Pi: R2≈247.5", has(aR2.value, "247.5"));
const attTypes = ["bridgeT", "reflective", "T"];
let distinct = new Set([baseSrc]);
for (const ty of attTypes) {
  hAtt.querySelector(`[data-type="${ty}"]`).click();
  distinct.add(attImg.src);
}
check("衰减器 四型图各不相同", distinct.size === 4);
check("衰减器 桥T 公式含 K-1", has(hAtt.querySelector("#att-formula").textContent, "K-1"));
hAtt.querySelector('[data-type="reflective"]').click();
check("衰减器 反射式 R1=Rhi/Rlo", has(aR1.value, "/"));

// ── 数制转换：二进制码盘 ──
const hNb = hostOf("number-base");
const grid = hNb.querySelector("#nb-bitgrid");
const dec = hNb.querySelector("#nb-d");
const hex = hNb.querySelector("#nb-h");
const oct = hNb.querySelector("#nb-o");
const bin = hNb.querySelector("#nb-b");
const bitOn = (b) => (grid.querySelector(`.nb-bit[data-bit="${b}"]`).className || "").includes("on");
check("码盘 WORD 初始 16 格", grid.querySelectorAll(".nb-bit").length === 16);
check("码盘 42 的 bit5=1", bitOn(5));
check("码盘 42 的 bit3=1", bitOn(3));
check("码盘 42 的 bit1=1", bitOn(1));
check("码盘 42 的 bit0=0", !bitOn(0));
// 点击 bit0 → 值变为 43
grid.querySelector('.nb-bit[data-bit="0"]').click();
check("码盘 点击 bit0 → 42 变 43", dec.value === "43");
check("码盘 43 的 hex=2B", hex.value === "2B");
check("码盘 43 的 bit0=1", bitOn(0));
// 改位宽到 DWORD(32)
const ws = hNb.querySelector("#nb-wordsize");
ws.value = "32"; fire(ws, "change");
check("码盘 DWORD 32 格", grid.querySelectorAll(".nb-bit").length === 32);
// 十进制填 255
dec.value = "255"; fire(dec, "input");
check("码盘 255 hex=FF", hex.value === "FF");
check("码盘 255 oct=377", oct.value === "377");
check("码盘 255 bin=11111111", bin.value === "11111111");
check("码盘 255 bit7=1", bitOn(7));

console.log(`\n结果: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
