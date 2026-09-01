// 回归：
//  - 部分A（爆炸设置持久化）：#set-explode-type / #set-explode-layout change → localStorage maxcom.settings。
//  - 部分B（顶栏右键入口）：顶栏空白区右键 → 菜单含「爆炸视图」；点击 → 打开覆盖层（叠盖屏蔽 UI）并隐藏标题栏/主会话区。
//  - 部分C（覆盖层交互）：点击 ✕ → 恢复标题栏/主会话区。
//  - 部分D（窗口控制搬移）：爆炸视图打开时 #win-controls 搬进 #explode-topbar（最小化/最大化/关闭仍可用），关闭后送回 #titlebar。
// 验证思路：eval 构建产物（同 ui-scale-test.mjs 的 boot 桩）。
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

// ───────────────────────── 部分A：爆炸设置持久化 ─────────────────────────
function partA() {
  const { w, errors } = boot();
  if (w.__MAXCOM_READY__ !== true) { console.error("✗ 前端初始化未完成(部分A)"); for (const e of errors) console.error("  ", e); return; }
  const typeSel = w.document.querySelector(".session-ui #set-explode-type");
  const layoutSel = w.document.querySelector(".session-ui #set-explode-layout");
  check("设置页存在 #set-explode-type / #set-explode-layout", !!typeSel && !!layoutSel);
  if (!typeSel || !layoutSel) return;

  typeSel.value = "terminal";
  typeSel.dispatchEvent(new w.Event("change", { bubbles: true }));
  layoutSel.value = "dwindle";
  layoutSel.dispatchEvent(new w.Event("change", { bubbles: true }));
  const saved = JSON.parse(w.localStorage.getItem(SETTINGS_KEY) ?? "{}");
  check("枚举类型持久化 explodeType=terminal", saved.explodeType === "terminal");
  check("布局持久化 explodeLayout=dwindle", saved.explodeLayout === "dwindle");
  for (const e of errors) console.error("  jsdom error:", e);
}

// ───────────────────────── 部分B：顶栏右键入口 ─────────────────────────
function partB() {
  const { w, errors } = boot();
  if (w.__MAXCOM_READY__ !== true) { console.error("✗ 前端初始化未完成(部分B)"); for (const e of errors) console.error("  ", e); return; }
  const tb = w.document.getElementById("titlebar");
  if (!tb) { console.error("✗ 未找到 #titlebar(部分B)"); return; }
  // 在空白区触发右键（非按钮/标签）——用 brand 区做目标
  const brand = w.document.getElementById("brand");
  brand.dispatchEvent(new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 20 }));
  const menu = w.document.querySelector(".ctx-menu");
  check("右键弹出上下文菜单", !!menu);
  if (menu) {
    const items = [...menu.querySelectorAll(".ctx-item")].map((n) => n.textContent);
    check("菜单含「爆炸视图」", items.some((x) => x && x.includes("爆炸视图") || x && x.includes("Explode")));
    // 点击打开
    const target = [...menu.querySelectorAll(".ctx-item")].find((n) => n.textContent.includes("爆炸") || n.textContent.includes("Explode"));
    if (target) {
      target.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      const overlay = w.document.getElementById("explode-overlay");
      check("点击后打开覆盖层(去掉 hidden)", overlay && !overlay.classList.contains("hidden"));
      check("标题栏被屏蔽(hidden)", w.document.getElementById("titlebar").classList.contains("hidden"));
      check("主会话区被屏蔽(hidden)", w.document.getElementById("session-root").classList.contains("hidden"));
    } else {
      check("点击后打开覆盖层(去掉 hidden)", false);
    }
  }
  for (const e of errors) console.error("  jsdom error:", e);
}

// ───────────────────────── 部分C：覆盖层关闭 ─────────────────────────
function partC() {
  const { w, errors } = boot();
  if (w.__MAXCOM_READY__ !== true) { console.error("✗ 前端初始化未完成(部分C)"); for (const e of errors) console.error("  ", e); return; }
  const brand = w.document.getElementById("brand");
  brand.dispatchEvent(new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 20 }));
  const target = [...w.document.querySelectorAll(".ctx-item")].find((n) => n.textContent.includes("爆炸") || n.textContent.includes("Explode"));
  if (!target) { console.error("✗ 未找到爆炸视图菜单项(部分C)"); return; }
  target.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const overlay = w.document.getElementById("explode-overlay");
  check("覆盖层已打开(partC)", overlay && !overlay.classList.contains("hidden"));

  const closeBtn = w.document.getElementById("explode-close");
  if (closeBtn) {
    closeBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    check("点 ✕ 关闭覆盖层(加回 hidden)", overlay.classList.contains("hidden"));
    check("恢复标题栏", !w.document.getElementById("titlebar").classList.contains("hidden"));
    check("恢复主会话区", !w.document.getElementById("session-root").classList.contains("hidden"));
  } else {
    check("点 ✕ 关闭覆盖层(加回 hidden)", false);
  }
  for (const e of errors) console.error("  jsdom error:", e);
}

// ───────────────────────── 部分D：爆炸视图内窗口控制搬移 ─────────────────────────
function partD() {
  const { w, errors } = boot();
  if (w.__MAXCOM_READY__ !== true) { console.error("✗ 前端初始化未完成(部分D)"); for (const e of errors) console.error("  ", e); return; }
  const brand = w.document.getElementById("brand");
  brand.dispatchEvent(new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 20 }));
  const target = [...w.document.querySelectorAll(".ctx-item")].find((n) => n.textContent.includes("爆炸") || n.textContent.includes("Explode"));
  if (!target) { console.error("✗ 未找到爆炸视图菜单项(部分D)"); return; }
  target.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

  const overlay = w.document.getElementById("explode-overlay");
  const topbar = w.document.getElementById("explode-topbar");
  const titlebar = w.document.getElementById("titlebar");
  const winCtl = w.document.getElementById("win-controls");
  const hasWinCtl = (parent) => !!parent && !!winCtl && parent.contains(winCtl);
  check("爆炸视图打开时窗口控制搬进顶栏", overlay && !overlay.classList.contains("hidden") && hasWinCtl(topbar));
  check("窗口控制已移出标题栏", titlebar && !titlebar.contains(winCtl));

  const closeBtn = w.document.getElementById("explode-close");
  if (closeBtn) {
    closeBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    check("关闭后窗口控制送回标题栏", hasWinCtl(titlebar) && !topbar.contains(winCtl));
  } else {
    check("关闭后窗口控制送回标题栏", false);
  }
  for (const e of errors) console.error("  jsdom error:", e);
}

partA();
partB();
partC();
partD();
console.log(`\n${pass} passed, ${fail} failed`);
// 强制退出：mock 启动的定时器会让 jsdom 环境一直保持 event loop，进程自然结束会挂住
process.exit(fail > 0 ? 1 : 0);
