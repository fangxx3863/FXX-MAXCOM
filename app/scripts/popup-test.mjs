// 回归：置顶弹出接收窗口（popup.html 独立入口）。
//  - logview 型：渲染 #log-view 接收区 + 工具条。
//  - terminal 型：渲染 .term-host 终端面板。
// 验证思路：eval 构建出的 popup bundle（jsdom，url 带 ?session=&type=）。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

let pass = 0, fail = 0;
const check = (name, cond) => {
  console.log((cond ? "✓ " : "✗ ") + name);
  cond ? pass++ : fail++;
};

const readPopupHtml = () => readFileSync("dist/popup.html", "utf8").replace(/<script[^>]*><\/script>/g, "");
const findPopupBundle = () => readdirSync("dist/assets").find((f) => f.startsWith("popup-") && f.endsWith(".js"));
const readPopupBundle = () => {
  const asset = findPopupBundle();
  if (!asset) return "";
  return readFileSync(`dist/assets/${asset}`, "utf8")
    .replaceAll("import.meta", "({ url: 'http://localhost/', env: {} })")
    .replace(/export\s*\{[^}]*\}\s*;?/g, "");
};

function boot(query) {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", (e) => errors.push(e.detail?.stack || e.message || String(e)));
  vc.on("error", (...a) => errors.push(a.join(" ")));
  const dom = new JSDOM(readPopupHtml(), {
    url: `http://localhost:1420/popup.html${query}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const w = dom.window;
  w.ResizeObserver = class { constructor() {} observe() {} unobserve() {} disconnect() {} };
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  const noop = () => {};
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "canvas" ? { width: 300, height: 150 } : noop) });
  w.navigator.wrappedJSObject = undefined;
  try { w.eval(readPopupBundle()); } catch (e) { errors.push(e.stack || String(e)); }
  return { w, errors };
}

// ── logview 型 popup ──
{
  const { w, errors } = boot("?session=test1&type=logview");
  check("popup logview 初始化完成", w.__MAXCOM_POPUP_READY__ === true);
  check("logview 渲染 #log-view 接收区", !!w.document.getElementById("log-view"));
  check("logview 渲染工具条 .popup-bar", !!w.document.querySelector(".popup-bar"));
  check("logview 自动滚动开关存在", !!w.document.querySelector(".popup-bar input[type=checkbox]"));
  for (const e of errors) console.error("  jsdom error:", e);
}

// ── terminal 型 popup ──
{
  const { w, errors } = boot("?session=test1&type=terminal");
  check("popup terminal 初始化完成", w.__MAXCOM_POPUP_READY__ === true);
  check("terminal 渲染 .term-host", !!w.document.querySelector(".term-host"));
  check("terminal 渲染 .term-bar 工具条", !!w.document.querySelector(".term-bar"));
  for (const e of errors) console.error("  jsdom error:", e);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
