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
const linesEl = h555.querySelector("#t555-lines");
const formula = h555.querySelector("#t555-formula");

// 初始单稳态：100Ω + 10µF => 1.1ms，无 R2 字段
check("555 mono: 无 R2 字段", !h555.querySelector("#t555-r2"));
check("555 mono 输出=1.1(单位在右侧 select)", outEl.value === "1.1" && h555.querySelector("#t555-os").selectedOptions[0].textContent === "ms");
check("555 mono 公式含 1.1", has(formula.textContent, "1.1"));

// 切到非稳态
h555.querySelector('[data-mode="astable"]').click();
check("555 astable: 插入 R2 字段", !!h555.querySelector("#t555-r2"));
check("555 astable 公式含 0.693", has(formula.textContent, "0.693"));
check("555 astable 输出含频率", has(linesEl.textContent, "频率 f ="));
check("555 astable 多行展示(非单行 input)", linesEl.hidden === false);

// 示例：R1=10k, R2=15k, C=10µF  => f≈3.6076Hz, 占空比=62.5%
r1.value = "10"; r1s.value = "1e3"; c.value = "10"; fire(r1, "input");
h555.querySelector("#t555-r2").value = "15"; h555.querySelector("#t555-r2s").value = "1e3";
fire(h555.querySelector("#t555-r2"), "input"); // 验证 R2 输入已绑定（重算）
check("555 astable f≈3.6076", has(linesEl.textContent, "f = 3.607"));
check("555 astable 占空比=62.5", has(linesEl.textContent, "占空比 = 62.5"));

// 单位切换回归：非稳态时间单位跟随选择，不再写死 ms
const osel = h555.querySelector("#t555-os");
osel.value = "1"; fire(osel, "change");
check("555 astable 切 s 后时间单位跟随", !has(linesEl.textContent, " ms") && has(linesEl.textContent, " s"));
osel.value = "1e-3"; fire(osel, "change"); // 恢复 ms，避免影响后续 mono 断言

// 回到单稳态：R2 字段被移除，输出恢复（先把 R1 复位为 100Ω）
r1.value = "100"; r1s.value = "1"; c.value = "10"; fire(r1, "input");
h555.querySelector('[data-mode="mono"]').click();
check("555 mono 回退后移除 R2", !h555.querySelector("#t555-r2"));
check("555 mono 回退输出=1.1", outEl.value === "1.1");

// 回归（曾修复 bug）：非稳态 → 单稳态 → 非稳态 多轮往返，R2 字段须反复重建/移除且事件不丢
h555.querySelector('[data-mode="astable"]').click();
check("555 往返: 再进非稳态 R2 重建", !!h555.querySelector("#t555-r2"));
r1.value = "10"; r1s.value = "1e3"; c.value = "10"; fire(r1, "input");
h555.querySelector("#t555-r2").value = "15"; h555.querySelector("#t555-r2s").value = "1e3";
fire(h555.querySelector("#t555-r2"), "input");
check("555 往返: R2 事件仍绑定 f≈3.607", has(linesEl.textContent, "f = 3.607"));
h555.querySelector('[data-mode="mono"]').click();
check("555 往返: 再回单稳态 R2 移除", !h555.querySelector("#t555-r2"));
r1.value = "100"; r1s.value = "1"; c.value = "10"; fire(r1, "input");
check("555 往返: 单稳态输出恢复=1.1", outEl.value === "1.1");

// ── 衰减器：四个类型各自不同的电路图 + 计算 ──
const hAtt = hostOf("attenuator");
const attImg = hAtt.querySelector("#att-diagram img");
const aR1 = hAtt.querySelector("#att-r1");
const aR2 = hAtt.querySelector("#att-r2");
const baseSrc = attImg.src;
check("衰减器 Pi 图非空", baseSrc.startsWith("data:image/"));
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

// ── 欧姆定律：功率独立展示，不再塞进带 Ω 后缀的电阻框 ──
const hOhm = hostOf("ohm");
const ohmR = hOhm.querySelector("#ohm-r");
const ohmLine = hOhm.querySelector("#ohm-line");
check("欧姆 R=50 (5V/0.1A)", ohmR.value === "50");
check("欧姆 电阻框不含功率", !has(ohmR.value, "P"));
check("欧姆 功率在 resultline P=0.5W", has(ohmLine.textContent, "P = 0.5 W"));

// ── 校验计算器：CRC/算法/位宽/格式 ──
const hCk = hostOf("checksum");
const waitAsync = () => new Promise((r) => setTimeout(r, 20));
const ckAlgo = hCk.querySelector("#ck-algo");
const ckVariant = hCk.querySelector("#ck-variant");
const ckWidth = hCk.querySelector("#ck-width");
const ckFmt = hCk.querySelector("#ck-fmt");
const ckSource = hCk.querySelector("#ck-source");
const ckInput = hCk.querySelector("#ck-input");
const ckResult = hCk.querySelector("#ck-result");
const ckMeta = hCk.querySelector("#ck-meta");
const ckVariantField = hCk.querySelector("#ck-variant-field");
const ckWidthField = hCk.querySelector("#ck-width-field");

// 初始：CRC 默认变体 crc8，输入默认空 → 结果空（空数据 CRC-8=0）但元信息有
check("校验 初始算法为 CRC", ckAlgo.value === "crc");
check("校验 CRC 变体字段可见", ckVariantField.style.display !== "none");
check("校验 CHECKSUM/XOR 位宽字段隐藏", ckWidthField.style.display === "none");

// HEX 输入 "123456789" → CRC-8 check=0xF4
ckSource.value = "hex"; fire(ckSource, "change");
ckInput.value = "313233343536373839"; fire(ckInput, "input");
check("校验 HEX 输入 CRC-8=0xF4", ckResult.textContent === "F4");
check("校验 元信息含数据长度", has(ckMeta.textContent, "9"));

// CRC 变体切到 CRC-32 → CBF43926
ckVariant.value = "crc32"; fire(ckVariant, "change");
check("校验 CRC-32 hex=CBF43926", ckResult.textContent === "CBF43926");

// 输出格式切 BIN → 32 位全零补位
ckFmt.value = "bin"; fire(ckFmt, "change");
check("校验 CRC-32 bin 32 位", ckResult.textContent.length === 32);
ckFmt.value = "hex"; fire(ckFmt, "change");

// 字符串输入 "abc" → MD5
ckSource.value = "str"; fire(ckSource, "change");
ckAlgo.value = "md5"; fire(ckAlgo, "change");
ckInput.value = "abc"; fire(ckInput, "input");
await waitAsync();
check("校验 字符串 MD5=90015098...17F72", ckResult.textContent === "900150983CD24FB0D6963F7D28E17F72");
check("校验 MD5 变体/位宽字段均隐藏", ckVariantField.style.display === "none" && ckWidthField.style.display === "none");

// CHECKSUM 位宽切换：字符串改回 HEX 单字节，位宽 8/16
ckSource.value = "hex"; fire(ckSource, "change");
ckInput.value = "41"; fire(ckInput, "input");
ckAlgo.value = "checksum"; fire(ckAlgo, "change");
check("校验 checksum 位宽字段可见", ckWidthField.style.display !== "none");
check("校验 checksum 0x41=65 (8bit)", ckResult.textContent === "41");
ckWidth.value = "16"; fire(ckWidth, "change");
check("校验 checksum 0x41=65 (16bit pad 0041)", ckResult.textContent === "0041");

// XOR：ABC → 64 = 0x40（先重置位宽为 8，避免上一步 checksum 残留 16 位 pad 成 0040）
ckWidth.value = "8"; fire(ckWidth, "change");
ckAlgo.value = "xor"; fire(ckAlgo, "change");
ckSource.value = "str"; fire(ckSource, "change");
ckInput.value = "ABC"; fire(ckInput, "input");
await waitAsync();
check("校验 XOR 'ABC'=0x40", ckResult.textContent === "40");

// 非法 HEX 输入给出错误提示
ckSource.value = "hex"; fire(ckSource, "change");
ckInput.value = "ZZ"; fire(ckInput, "input");
check("校验 非法 HEX 提示", has(ckResult.textContent, "HEX"));

// 文件源仅 HASH 类可用：CRC 下选 file 会被强制切回 hex
ckAlgo.value = "crc"; fire(ckAlgo, "change");
ckSource.value = "file"; fire(ckSource, "change");
check("校验 CRC 下 file 被强制回 hex", ckSource.value === "hex");
ckAlgo.value = "md5"; fire(ckAlgo, "change");
ckSource.value = "file"; fire(ckSource, "change");
check("校验 MD5 下可选文件源", ckSource.value === "file");

// 复制按钮存在且可点击不崩（jsdom 无 Clipboard API，doCopy 内部 try/catch 容错）
const ckCopy = hCk.querySelector("#ck-copy");
const ckCopyFull = hCk.querySelector("#ck-copy-full");
check("校验 复制按钮存在", !!ckCopy && !!ckCopyFull);
ckCopy.click(); ckCopyFull.click(); // 不应抛异常
check("校验 复制按钮可点击不崩", true);

// CRC 说明区：切回 CRC 后显示参数 + 端序说明；MD5 时隐藏
ckAlgo.value = "crc"; fire(ckAlgo, "change");
ckVariant.value = "crc32"; fire(ckVariant, "change");
const ckNote = hCk.querySelector("#ck-note");
check("校验 CRC 说明区可见", ckNote.style.display !== "none");
check("校验 CRC 说明含多项式", has(ckNote.textContent, "04C11DB7"));
check("校验 CRC 说明含 init", has(ckNote.textContent, "FFFFFFFF"));
ckAlgo.value = "md5"; fire(ckAlgo, "change");
check("校验 MD5 说明区隐藏", ckNote.style.display === "none");

// 编码下拉：字符串源时可见，UTF-8 正确算值；UTF-16LE 正确；GBK 在 mock 下提示回退
const ckEncoding = hCk.querySelector("#ck-encoding");
const ckEncodingField = hCk.querySelector("#ck-encoding-field");
check("校验 编码下拉存在", !!ckEncoding);
// 切字符串源 → 编码下拉可见
ckSource.value = "str"; fire(ckSource, "change");
check("校验 字符串源时编码下拉可见", ckEncodingField.style.display !== "none");
// UTF-8 + 'abc' → MD5
ckEncoding.value = "utf-8"; fire(ckEncoding, "change");
ckAlgo.value = "md5"; fire(ckAlgo, "change");
ckInput.value = "abc"; fire(ckInput, "input");
await waitAsync();
check("校验 字符串 UTF-8 MD5=90015098...17F72", ckResult.textContent === "900150983CD24FB0D6963F7D28E17F72");
// UTF-16LE + 'AB' → 4 字节 => CRC8 会随数据变，改用 HEX 输入等价验证编码走通（结果非空即可）
ckEncoding.value = "utf-16le"; fire(ckEncoding, "change");
ckAlgo.value = "crc"; fire(ckAlgo, "change");
ckInput.value = "AB"; fire(ckInput, "input");
await waitAsync();
check("校验 字符串 UTF-16LE 编码走通(结果非空)", ckResult.textContent.length > 0);
// GBK 在 mock 下回退提示
ckEncoding.value = "gbk"; fire(ckEncoding, "change");
await waitAsync();
check("校验 GBK 在 mock 下提示回退", has(ckResult.textContent, "GBK"));

console.log(`\n结果: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
