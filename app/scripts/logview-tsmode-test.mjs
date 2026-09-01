// 回归：切换时间戳显示格式对历史数据也生效（setTsMode 全量重算 + 重渲染）。
// 场景：日志若干行后切换 相对/差值/绝对/无 四种模式，已入队的历史行时间戳串必须按新模式重算，
//      而非仅影响新到的行；差值模式还应按行到达顺序重算差值链，新行继续接在链尾。
// 曾引入的 bug：tsText 只在入队时算一次并随行存储，改格式只影响后续新行，历史行不变。
import { JSDOM } from "jsdom";
import { transformSync } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (name, cond) => {
  console.log((cond ? "✓ " : "✗ ") + name);
  cond ? pass++ : fail++;
};

const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
const w = dom.window;
globalThis.window = w;
globalThis.document = w.document;
globalThis.HTMLElement = w.HTMLElement;
globalThis.HTMLInputElement = w.HTMLInputElement;
globalThis.Text = w.Text;
globalThis.Event = w.Event;

// 同 logview-lazy-test：纯字符串转译，不上溯文件系统（沙箱/CI 稳定）。
const src = readFileSync(join(process.cwd(), "src", "pages", "logview.ts"), "utf8")
  .replace('import { t } from "../i18n";', "const { t } = globalThis.__i18n;");
const out = transformSync(src, { loader: "ts", format: "cjs", target: "es2020" }).code;
globalThis.__i18n = { t: (k) => k };
const dir = mkdtempSync(join(process.cwd(), "scripts", ".lv-tsmode-"));
writeFileSync(join(dir, "b.cjs"), out);
const mod = await import("file://" + join(dir, "b.cjs").replace(/\\/g, "/"));
const LogViewPage = mod.default?.LogViewPage ?? mod.LogViewPage;
if (typeof LogViewPage !== "function") {
  console.error("✗ 无法从转译产物拿到 LogViewPage");
  process.exit(1);
}

const ROW_H = 24, CLIENT_H = 600;
function makeView() {
  const view = document.createElement("div");
  view.style.fontSize = "16px";
  view.style.lineHeight = "1.5";
  document.body.appendChild(view);
  Object.defineProperty(view, "clientHeight", { get: () => CLIENT_H, configurable: true });
  Object.defineProperty(view, "scrollHeight", {
    get() {
      let h = 0;
      for (const c of view.children) {
        if (c.dataset.chunk === undefined) continue;
        h += c.childElementCount > 0 ? c.childElementCount * ROW_H : parseFloat(c.style.minHeight) || 0;
      }
      return h;
    },
    configurable: true,
  });
  return view;
}

const autoscroll = document.createElement("input");
autoscroll.type = "checkbox";
autoscroll.checked = true;

let mode = "relative";
const lv = new LogViewPage(makeView(), { autoscroll, getTsMode: () => mode });
const tsSpanTexts = () =>
  [...document.querySelectorAll(".log-line .log-ts")].map((e) => e.textContent);

// 锚点 0，ts = 100 / 150 / 130（涵盖递增与递减，验证差值链）。
lv.append({
  epoch_anchor_ms: 0,
  items: [
    { ts_ms: 100, text: "A", segments: [], raw_hex: "aa" },
    { ts_ms: 150, text: "B", segments: [], raw_hex: "bb" },
    { ts_ms: 130, text: "C", segments: [], raw_hex: "cc" },
  ],
});

check("relative 初始历史行时间戳", JSON.stringify(tsSpanTexts()) === JSON.stringify(["+100ms", "+150ms", "+130ms"]));

// 切到差值：历史行重算差值链（Δ+0 / Δ+50 / Δ-20）
mode = "delta";
lv.setTsMode();
check("delta 重算历史行", JSON.stringify(tsSpanTexts()) === JSON.stringify(["Δ+0ms", "Δ+50ms", "Δ-20ms"]));

// 切到无：时间戳空 → 不再输出 .log-ts
mode = "none";
lv.setTsMode();
check("none 无时间戳 span", tsSpanTexts().length === 0);

// 切回相对：历史行恢复
mode = "relative";
lv.setTsMode();
check("relative 再次重算历史行", JSON.stringify(tsSpanTexts()) === JSON.stringify(["+100ms", "+150ms", "+130ms"]));

// 绝对模式：按本地时区与业务一致的 Date 逻辑重算
mode = "absolute";
lv.setTsMode();
const p = (n, w = 2) => String(n).padStart(w, "0");
const absExpected = [100, 150, 130].map((ts) => {
  const d = new Date(0 + ts);
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
});
check("absolute 重算历史行", JSON.stringify(tsSpanTexts()) === JSON.stringify(absExpected));

// 差值链尾保留：新来的行接在链尾（前一行 C ts=130）
mode = "delta";
lv.setTsMode();
lv.append({
  epoch_anchor_ms: 0,
  items: [{ ts_ms: 160, text: "D", segments: [], raw_hex: "dd" }],
});
const ts = tsSpanTexts();
check("delta 新行接在链尾（Δ+30ms）", ts[ts.length - 1] === "Δ+30ms");

rmSync(dir, { recursive: true, force: true });
console.log(`\n结果: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
