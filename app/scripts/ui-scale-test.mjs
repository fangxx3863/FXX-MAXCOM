// 回归：
//  - 部分A（界面缩放 DPI）：设置页 #set-ui-scale 改动 → <html> zoom 即时生效并持久化；重载后按持久化值缩放。
//  - 部分B（布局门控静态守卫）：构建出的 CSS 必须以 :root[data-platform=mobile] 门控 #titlebar 隐藏，
//    桌面 UA（不设 data-platform=mobile）永不触发，窗口拉小/DPI 缩放都不会吃掉顶部标题栏；基础 #topbar 可换行。
//  - 部分C（关于页外链）：document 级委托点击拦截 https 链接（preventDefault），非 Tauri 下走 window.open。
// 验证思路：eval 构建产物（同 logview-hex-rules-test.mjs 部分A 的桩）；CSS/门控是对构建产物做静态断言。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

let pass = 0, fail = 0;
const check = (name, cond) => {
  console.log((cond ? "✓ " : "✗ ") + name);
  cond ? pass++ : fail++;
};

const SETTINGS_KEY = "maxcom.settings";
const readHtml = () => readFileSync("dist/index.html", "utf8").replace(/<script[^>]*><\/script>/g, "");
const findBundle = () => readdirSync("dist/assets").find((f) => f.startsWith("index-") && f.endsWith(".js"));
const readBundle = () => {
  const asset = findBundle();
  return readFileSync(`dist/assets/${asset}`, "utf8")
    .replaceAll("import.meta", "({ url: 'http://localhost/', env: {} })")
    .replace(/export\s*\{[^}]*\}\s*;?/g, "");
};

function boot(seedSettings) {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", (e) => errors.push(e.detail?.stack || e.message || String(e)));
  vc.on("error", (...a) => errors.push(a.join(" ")));
  const dom = new JSDOM(readHtml(), { url: "http://localhost:1420/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  const noop = () => {};
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "canvas" ? { width: 300, height: 150 } : noop) });
  w.navigator.wrappedJSObject = undefined;
  if (seedSettings) w.localStorage.setItem(SETTINGS_KEY, JSON.stringify(seedSettings));
  try { w.eval(readBundle()); } catch (e) { errors.push(e.stack || String(e)); }
  return { w, errors };
}

const zoomOf = (w) => (w.document.documentElement.style.getPropertyValue("zoom") || "1").trim();

// ───────────────────────── 部分A：界面缩放（DPI）─────────────────────────
function partA() {
  const { w, errors } = boot();
  if (w.__MAXCOM_READY__ !== true) { console.error("✗ 前端初始化未完成(部分A)"); for (const e of errors) console.error("  ", e); return; }
  check("默认 100% → html zoom=1", zoomOf(w) === "1");

  const sel = w.document.querySelector(".session-ui #set-ui-scale");
  if (!sel) { console.error("✗ 未找到 #set-ui-scale(部分A)"); return; }
  sel.value = "125";
  sel.dispatchEvent(new w.Event("change", { bubbles: true }));
  check("改 125% → html zoom=1.25", zoomOf(w) === "1.25");
  const saved = JSON.parse(w.localStorage.getItem(SETTINGS_KEY) ?? "{}");
  check("缩放持久化到 localStorage(uiScale=125)", saved.uiScale === 125);

  sel.value = "80";
  sel.dispatchEvent(new w.Event("change", { bubbles: true }));
  check("改 80% → html zoom=0.8", zoomOf(w) === "0.8");

  // 模拟重载：预置 uiScale=125，启动即缩放
  const w2 = boot({ uiScale: 125 });
  if (w2.w.__MAXCOM_READY__ === true) {
    check("重载后按持久化 125% 缩放", zoomOf(w2.w) === "1.25");
  } else {
    check("重载后按持久化 125% 缩放", false);
  }
  for (const e of errors) console.error("  jsdom error:", e);
}

// ───────────────────────── 部分B：布局门控（静态守卫）─────────────────────────
function ruleBlocks(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) out.push({ sel: m[1], body: m[2] });
  return out;
}
function partB() {
  const cssFile = join("dist/assets", readdirSync("dist/assets").find((f) => f.endsWith(".css")));
  const css = readFileSync(cssFile, "utf8");
  const rules = ruleBlocks(css);

  const findDisplayNone = (targetSel) => rules.filter(
    (r) => new RegExp(`#${targetSel}\\b`).test(r.sel) && /display\s*:\s*none/.test(r.body),
  );
  const titlebarHide = findDisplayNone("titlebar");
  const ungatedTitlebar = titlebarHide.filter((r) => !/data-platform=mobile/.test(r.sel));
  check("移动端门控隐藏标题栏（:root[data-platform=mobile] #titlebar display:none）",
    titlebarHide.length > 0 && ungatedTitlebar.length === 0);

  const layoutCol = rules.filter((r) => /#layout\b/.test(r.sel) && /flex-direction\s*:\s*column/.test(r.body));
  const ungatedLayout = layoutCol.filter((r) => !/data-platform=mobile/.test(r.sel));
  check("桌面布局不因窄视口改列（#layout flex-direction:column 仅移动端门控）",
    ungatedLayout.length === 0);

  check("基础 #topbar 可换行(flex-wrap:wrap)", /#topbar\s*\{[^}]*flex-wrap\s*:\s*wrap/.test(css));
}

// ───────────────────────── 部分C：关于页外链 ─────────────────────────
function partC() {
  const { w, errors } = boot();
  if (w.__MAXCOM_READY__ !== true) { console.error("✗ 前端初始化未完成(部分C)"); return; }
  const opened = [];
  w.open = (url, target, features) => { opened.push({ url, target, features }); return null; };
  const link = w.document.querySelector(".session-ui a.set-about-link");
  if (!link) { console.error("✗ 未找到关于页外链(部分C)"); return; }
  link.dispatchEvent(new w.Event("click", { bubbles: true, cancelable: true }));
  check("点击 GitHub 链接 → 走 window.open(非 Tauri 路径)", opened.length === 1 && opened[0].url === link.href);
  check("链接未默认导航（preventDefault）", link.getAttribute("href") === "https://github.com/fangxx3863/FXX-MAXCOM");
  for (const e of errors) console.error("  jsdom error:", e);
}

partA();
partB();
partC();
console.log(`\n结果: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
