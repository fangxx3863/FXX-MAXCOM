// PlotPage 功能回归：esbuild 打包 src/pages/plot.ts（stub uplot/css），jsdom 中驱动状态机。
// 场景：子图/叠加/柱状/同屏、通道显隐、增益偏移变换、Y 轴预设、ASCII 自动通道结构重建。
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="plot-holder"></div>
  <div id="plot-bars" class="hidden"></div>
  <div id="plot-chbar" class="hidden"></div>
  <div id="plot-controls"><span id="plot-info"></span></div>
</body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
const w = dom.window;
w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.document = w.document;
global.window = w;
global.HTMLElement = w.HTMLElement;
global.HTMLInputElement = w.HTMLInputElement;
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

// ── uPlot 桩：记录 opts/setData/setSize，可注入 clientWidth ──
const created = [];
class FakeUPlot {
  static optsLog = [];
  constructor(opts, data, target) {
    this.opts = opts;
    this.series = [{}, ...opts.series.slice(1)];
    this.width = opts.width; this.height = opts.height;
    this.root = Object.assign(document.createElement("div"), { parentElement: target });
    target.appendChild(this.root);
    this.data = null; this.setSizeCalls = [];
    created.push(this);
    FakeUPlot.optsLog.push(opts);
  }
  setData(d) { this.data = d; }
  setSize(s) { this.width = s.width; this.height = s.height; this.setSizeCalls.push(s); }
  redraw() {}
  destroy() { const i = created.indexOf(this); if (i >= 0) created.splice(i, 1); }
}

const dir = mkdtempSync(join(tmpdir(), "plot-test-"));
const stubUplot = `module.exports = class { constructor(o,d,t){ return new (require("${join(dir,"fake.mjs").replace(/\\/g,"/")}")) ;} }`;
writeFileSync(join(dir, "uplot-stub.js"), `
class FakeUPlot {
  constructor(opts, data, target) {
    opts.__target = null;
    globalThis.__lastOpts = opts;
    if (!globalThis.__plots) globalThis.__plots = [];
    globalThis.__plots.push(this);
    this.opts = opts;
    this.series = [{}, ...opts.series.slice(1)];
    this.width = opts.width; this.height = opts.height;
    this.setDataCalls = [];
    this.root = document.createElement("div");
    if (target) target.appendChild(this.root);
  }
  setData(d) { this.setDataCalls.push(d); globalThis.__lastSetData = d; }
  setSize(s) { globalThis.__lastSetSize = s; this.width = s.width; }
  redraw() { globalThis.__redraws = (globalThis.__redraws ?? 0) + 1; }
  destroy() {}
}
module.exports = FakeUPlot;
`);
writeFileSync(join(dir, "css-stub.js"), `module.exports = {};`);
writeFileSync(join(dir, "entry.ts"), `
import { PlotPage, Y_PRESETS } from "${join(process.cwd(), "src/pages/plot.ts").replace(/\\/g, "/")}";
import { LogViewPage } from "${join(process.cwd(), "src/pages/logview.ts").replace(/\\/g, "/")}";
globalThis.PlotPage = PlotPage;
globalThis.Y_PRESETS = Y_PRESETS;
globalThis.LogViewPage = LogViewPage;
`);
// esbuild JS API：跨平台（Windows 下 node_modules/.bin/esbuild 是 sh 脚本，spawnSync 会 ENOENT）
const { buildSync } = await import("esbuild");
buildSync({
  entryPoints: [join(dir, "entry.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  alias: {
    uplot: join(dir, "uplot-stub.js"),
    "uplot/dist/uPlot.min.css": join(dir, "css-stub.js"),
  },
  outfile: join(dir, "bundle.cjs"),
  logLevel: "silent",
});

await import("file://" + join(dir, "bundle.cjs"));
const { PlotPage, Y_PRESETS } = globalThis;

// ── 断言工具 ──
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("✓", name); }
  else { fail++; console.error("✗", name); }
}
const holder = document.querySelector("#plot-holder");
const barsEl = document.querySelector("#plot-bars");
const chbar = document.querySelector("#plot-chbar");
const page = new PlotPage(holder, document.querySelector("#plot-controls"), chbar);

// jsdom 无布局：给格子一个伪 clientWidth
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  get() { return this.classList?.contains("plot-cell") ? 500 : 800; },
  configurable: true,
});
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  get() {
    if (this.id === "plot-holder") {
      const bars = document.querySelector("#plot-bars");
      // 模拟真实布局：柱状区有内容时，波形可用高度被压缩（300），否则全高（600）
      return bars && !bars.classList.contains("hidden") && bars.children.length ? 300 : 600;
    }
    return 600;
  },
  configurable: true,
});
Object.defineProperty(HTMLElement.prototype, "childElementCount", {
  get() { return this.children.length; },
  configurable: false,
});

const snap3 = { channel_count: 3, total_points: 100, series: [[1,2,3],[4,5,6],[7,8,9]], metrics: [null,null,null] };

// 1) 默认：分开子图 × 波形 → 3 格、通道条 3 片、柱状隐藏
page.update(snap3);
check("子图模式建 3 格", holder.querySelectorAll(".plot-cell").length === 3);
check("通道条 3 片且可见", chbar.querySelectorAll(".ch-chip").length === 3 && !chbar.classList.contains("hidden"));
check("柱状区隐藏", barsEl.classList.contains("hidden"));
check("info 更新", document.querySelector("#plot-info").textContent.includes("100"));

// 2) 增益/偏移变换：CH1 gain=2 offset=10 → setData 值 [12,14,16]
const gainInput = chbar.querySelector('.ch-chip[data-ch="0"] .ch-gain');
gainInput.value = "2";
gainInput.dispatchEvent(new w.Event("input", { bubbles: true }));
const offInput = chbar.querySelector('.ch-chip[data-ch="0"] .ch-off');
offInput.value = "10";
offInput.dispatchEvent(new w.Event("input", { bubbles: true }));
page.update(snap3);
const d0 = globalThis.__lastSetData; // 最后一次 setData 是 CH2？→ 直接检查所有 plot 的 data
// 逐 plot 验证：桩记录了各自 setDataCalls
// （FakeUPlot 实例在 bundle 内部，通过 __plots 全局拿）
const allPlots = globalThis.__plots;
const p0 = allPlots.find(p => p.setDataCalls.length && p.setDataCalls.at(-1)[1][0] === 12);
check("增益×2+偏移10 生效", !!p0 && p0.setDataCalls.at(-1)[1].join() === "12,14,16");

// 3) 显隐：取消 CH0 → 子图 cell 隐藏
const visChk = chbar.querySelector('.ch-chip[data-ch="0"] .ch-vis');
visChk.checked = false;
visChk.dispatchEvent(new w.Event("change", { bubbles: true }));
check("隐藏后 cell.hidden", holder.querySelectorAll(".plot-cell")[0].classList.contains("hidden"));

// 4) 单图叠加：1 个 plot、series = n+1、CH0 show=false 同步
page.setLayout("overlay");
page.update(snap3);
check("叠加模式仅 1 图", holder.querySelectorAll(".plot-cell").length === 1);
const ov = globalThis.__plots.at(-1);
check("叠加 series=4(含x轴)", ov.series.length === 4);
check("叠加图例开启", ov.opts.legend.show === true);
check("叠加继承 CH0 显隐", ov.series[1].show === false);

// 5) 显示模式切换：bars → holder 隐藏；both → 都可见
page.setViewMode("bars");
check("纯柱状：holder 隐藏 + 3 表", holder.classList.contains("hidden") && barsEl.querySelectorAll(".bar-meter").length === 3);
page.setViewMode("both");
check("同屏：holder 与柱状都可见", !holder.classList.contains("hidden") && !barsEl.classList.contains("hidden"));

// 6) Y 轴预设生效（opts.scales.y.range）
page.setYRange("s16");
check("Y 预设 int16", JSON.stringify(globalThis.__plots.at(-1).opts.scales.y.range) === "[-32768,32767]");
check("Y_PRESETS.auto 为 null", Y_PRESETS.auto === null);

// 7) ASCII 自动：通道数 0→3 触发结构重建；通道条同步
const snapAuto0 = { channel_count: 0, total_points: 0, series: [], metrics: [] };
page.update(snapAuto0);
const snapAuto3 = { channel_count: 3, total_points: 9, series: [[1],[2],[3]], metrics: [null,null,null] };
page.update(snapAuto3);
check("自动通道 0→3 结构重建（叠加布局）",
  globalThis.__plots.at(-1).series.length === 4 &&
  chbar.querySelectorAll(".ch-chip").length === 3 &&
  barsEl.querySelectorAll(".bar-meter").length === 3);

// 8) 换色即时生效（overlay stroke 更新 + redraw）
const colorInput = chbar.querySelector('.ch-chip[data-ch="1"] .ch-color');
colorInput.value = "#ff0000";
colorInput.dispatchEvent(new w.Event("input", { bubbles: true }));
const ovNow = globalThis.__plots.at(-1);
check("换色写入 series.stroke", ovNow.series[2].stroke === "#ff0000");

// 9) 同屏+分开子图：单通道也把柱状表放到波形右侧，波形使用完整容器高度
page.setLayout("subplots"); // 回到子图布局（此前场景停在 overlay）
page.update({ channel_count: 1, total_points: 4, series: [[1, 2, 3, 4]], metrics: [null] });
page.setViewMode("waveform");
page.setViewMode("both");
const wavePlot = globalThis.__plots.at(-1);
check("同屏单通道柱状表在右侧", holder.querySelectorAll(".plot-cell.side-bars .bar-side .bar-meter").length === 1);
check("柱状嵌入右侧后波形高度 (h=546)", wavePlot.height === 546);

// 10) 收发页快捷过滤：命中才显示，新旧数据即时生效
// （虚拟化后行挂在 .log-chunk 分页容器里，用辅助函数按序取行 DOM）
const lvView = document.createElement("div");
const lv = new globalThis.LogViewPage(lvView, { autoscroll: { checked: false }, getTsMode: () => "none" });
const lvRows = () => Array.from(lvView.querySelectorAll(".log-line"));
const mkItem = (text) => ({ ts_ms: 1, text, segments: [], raw_hex: "" });
lv.append({ epoch_anchor_ms: 0, items: [mkItem("ERROR: boom"), mkItem("INFO: ok")] });
{
  const rows = lvRows();
  check("无过滤两行可见", rows.length === 2 && !rows[0].classList.contains("hidden"));
  lv.setQuickFilter("ERROR");
  const rowsF = lvRows(); // setQuickFilter 重渲染 chunk，重新取行引用
  check("正则过滤仅匹配行可见", !rowsF[0].classList.contains("hidden") && rowsF[1].classList.contains("hidden"));
  lv.append({ epoch_anchor_ms: 0, items: [mkItem("ERROR: again"), mkItem("WARN: x")] });
  const rows2 = lvRows();
  check("新行同样受过滤约束", rows2.length === 4 && rows2[2].classList.contains("hidden") === false && rows2[3].classList.contains("hidden"));
  lv.setQuickFilter("");
  check("清空过滤全部恢复", lvRows().every((c) => !c.classList.contains("hidden")));
  lv.setQuickFilter("["); // 非法正则 → 子串匹配
  check("非法正则回退子串", lvRows().every((c) => c.classList.contains("hidden")));
  lv.setQuickFilter("boom");
  check("子串匹配生效", lvRows()[0].classList.contains("hidden") === false);
}

// 11) 虚拟化：大数据量不丢行、窗口恒定（Bug1 治本验证）
{
  const N = 2000;
  const items = [];
  for (let i = 0; i < N; i++) items.push(mkItem("line-" + i));
  lv.append({ epoch_anchor_ms: 0, items });
  check("虚拟化: 2000 行全部保留(不丢行)", lv.lineCount === N + 4);
  const rendered = lvRows().length;
  check("虚拟化: DOM 行数远小于总行数(窗口渲染)", rendered < 1200 && rendered > 0);
  // 每页行数 setter 生效（50 下限保护）
  lv.setRowsPerPage(200);
  check("虚拟化: rowsPerPage setter 生效", lv.getRowsPerPage() === 200);
  lv.setRowsPerPage(500);
}

console.log(`\n结果: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
