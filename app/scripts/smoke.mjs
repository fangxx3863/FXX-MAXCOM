// 冒烟测试：在 jsdom 中执行构建产物，断言前端模块初始化走到最后一行。
// 任何未捕获异常（如 null.addEventListener）都会让初始化中断 → __MAXCOM_READY__ 缺失 → fail。
import { readFileSync, readdirSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";

const html = readFileSync("dist/index.html", "utf8")
  .replace(/<script[^>]*><\/script>/g, ""); // 去掉 module 引用，手动 eval

const vc = new VirtualConsole();
const errors = [];
vc.on("jsdomError", (e) => errors.push(e.detail?.stack || e.message || String(e)));
vc.on("error", (...a) => errors.push(a.join(" ")));

const dom = new JSDOM(html, {
  url: "http://localhost:1420/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const w = dom.window;

// ── 环境桩（jsdom 缺失的浏览器 API；只为让初始化走通，不验证渲染）──
w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
const noop = () => {};
w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "canvas" ? { width: 300, height: 150 } : noop) });
w.navigator.wrappedJSObject = undefined;

const asset = readdirSync("dist/assets").find((f) => f.startsWith("index-") && f.endsWith(".js"));
const bundle = readFileSync(`dist/assets/${asset}`, "utf8")
  // ESM 语法在 eval 中不可用：import.meta 换成桩（冒烟只验证初始化逻辑，不验证打包特性）
  .replaceAll("import.meta", "({ url: 'http://localhost/', env: {} })")
  .replace(/export\s*\{[^}]*\}\s*;?/g, ""); // 剥离 ESM 导出

try {
  w.eval(bundle);
} catch (e) {
  errors.push(e.stack || String(e));
}

const ready = w.__MAXCOM_READY__ === true;
for (const e of errors) console.error("── 运行时错误 ──\n" + e);
if (!ready) {
  console.error("✗ 前端初始化未完成（__MAXCOM_READY__ 缺失）——见上方错误");
  process.exit(1);
}
console.log("✓ 前端初始化冒烟通过：模块完整执行，无未捕获异常");
process.exit(0); // 应用轮询定时器会挂住事件循环，显式退出
