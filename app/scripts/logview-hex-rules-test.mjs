// 回归：HEX 显示强制「超时分包」并锁死分包下拉（关闭恢复）+ 染色规则字符串模式转义。
// - 部分A（HEX/分包）：eval 构建产物（同 smoke.mjs 桩），驱动真实 #hex-display / 分包下拉。
// - 部分B（染色字符串模式）：esbuild 打包 src/pages/rules.ts，jsdom 直接实例化 RulesPanel，
//   用记录载荷的 stub api 断言 string 模式把 [D] 转义成 \[D\]、剥掉 mode 字段。
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

let pass = 0, fail = 0;
const check = (name, cond) => {
  console.log((cond ? "✓ " : "✗ ") + name);
  cond ? pass++ : fail++;
};

// ───────────────────────── 部分A：HEX → 超时分包锁 ─────────────────────────
function partA() {
  const html = readFileSync("dist/index.html", "utf8").replace(/<script[^>]*><\/script>/g, "");
  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", (e) => errors.push(e.detail?.stack || e.message || String(e)));
  vc.on("error", (...a) => errors.push(a.join(" ")));
  const dom = new JSDOM(html, { url: "http://localhost:1420/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  const noop = () => {};
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "canvas" ? { width: 300, height: 150 } : noop) });
  w.navigator.wrappedJSObject = undefined;
  const asset = readdirSync("dist/assets").find((f) => f.startsWith("index-") && f.endsWith(".js"));
  const bundle = readFileSync(`dist/assets/${asset}`, "utf8")
    .replaceAll("import.meta", "({ url: 'http://localhost/', env: {} })")
    .replace(/export\s*\{[^}]*\}\s*;?/g, "");
  try { w.eval(bundle); } catch (e) { errors.push(e.stack || String(e)); }
  if (w.__MAXCOM_READY__ !== true) {
    console.error("✗ 前端初始化未完成(部分A)");
    return;
  }
  const hex = w.document.querySelector(".session-ui #hex-display");
  const idleCtl = w.document.querySelector(".session-ui #idle-timeout-ctl");
  const splitCtl = idleCtl?.previousElementSibling;
  const dd = splitCtl?.querySelector(".dd");
  if (!dd || !hex || !idleCtl) { console.error("✗ 控件未渲染(部分A)"); return; }
  const label = () => (dd.querySelector(".dd-label") || {}).textContent;
  const face = dd.querySelector("button");
  const L0 = label();
  check("默认「换行分包」且下拉未禁用、超时框隐藏", !!L0 && face.disabled !== true && idleCtl.classList.contains("hidden"));
  hex.checked = true;
  hex.dispatchEvent(new w.Event("change", { bubbles: true }));
  check("开 HEX → 分包切「超时分包」+下拉锁死+超时框显示", label() !== L0 && face.disabled === true && !idleCtl.classList.contains("hidden"));
  hex.checked = false;
  hex.dispatchEvent(new w.Event("change", { bubbles: true }));
  check("关 HEX → 恢复原「换行分包」+下拉解锁+超时框隐藏", label() === L0 && face.disabled !== true && idleCtl.classList.contains("hidden"));
  for (const e of errors) console.error("  jsdom error:", e);
}

// ───────────────────────── 部分B：染色规则字符串模式 ─────────────────────────
async function partB() {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  const w = dom.window;
  globalThis.window = w;
  globalThis.document = w.document;
  globalThis.HTMLElement = w.HTMLElement;
  globalThis.HTMLInputElement = w.HTMLInputElement;
  globalThis.HTMLButtonElement = w.HTMLButtonElement;
  globalThis.HTMLDivElement = w.HTMLDivElement;
  globalThis.HTMLSpanElement = w.HTMLSpanElement;
  globalThis.Event = w.Event;
  globalThis.Text = w.Text;

  const dir = mkdtempSync(join(tmpdir(), "rules-test-"));
  writeFileSync(join(dir, "entry.ts"),
    `import { RulesPanel } from "${join(process.cwd(), "src/pages/rules.ts").replace(/\\/g, "/")}";\n` +
    `globalThis.__RulesPanel = RulesPanel;\n`);
  const { buildSync } = await import("esbuild");
  buildSync({ entryPoints: [join(dir, "entry.ts")], bundle: true, format: "cjs", platform: "node", outfile: join(dir, "b.cjs"), logLevel: "silent" });
  const req = await import("file://" + join(dir, "b.cjs"));
  const RulesPanel = globalThis.__RulesPanel;

  const sentColors = [];
  const api = {
    setFilters: () => Promise.resolve(),
    setColorRules: (m, ay, rules) => { sentColors.push({ m, ay, rules }); return Promise.resolve(); },
  };
  const root = document.createElement("div");
  root.innerHTML = `
    <button id="toggle-rules"></button><aside id="rules-panel" class="hidden"></aside>
    <button id="rules-close"></button><button id="flt-add"></button><button id="flt-clear"></button>
    <button id="color-add"></button><button id="color-clear"></button>
    <div id="flt-rows"></div><div id="color-rows"></div>
    <label class="chk"><input id="color-master" type="checkbox" checked /></label>
    <label class="chk"><input id="color-yield" type="checkbox" checked /></label>`;
  document.body.appendChild(root);
  const q = (s) => root.querySelector(s);
  new RulesPanel(root, api, {}, () => {});

  q("#color-add").dispatchEvent(new w.Event("click", { bubbles: true }));
  const row = root.querySelector(".color-row");
  check("染色规则渲染出「正则/字符串」模式下拉", !!row && row.querySelectorAll(".dd").length === 2);
  const modeDd = row.querySelectorAll(".dd")[0];
  modeDd.querySelector(".dd-face").dispatchEvent(new w.Event("click", { bubbles: true }));
  const t = [...modeDd.querySelectorAll(".dd-item")];
  const strItem = t.find((i) => i.textContent === "字符串");
  strItem.dispatchEvent(new w.Event("click", { bubbles: true }));
  const input = row.querySelector("input.ms-content");
  input.value = "[D]";
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  const payload = sentColors[sentColors.length - 1].rules.find((r) => r.name === "u0");
  check("字符串模式：pattern=[D] 被转义为 \\[D\\]", payload && payload.pattern === "\\[D\\]");
  check("字符串模式：载荷剥离 mode 字段(契约字段)", payload && !("mode" in payload));
  // 折回正则
  modeDd.querySelector(".dd-face").dispatchEvent(new w.Event("click", { bubbles: true }));
  (t.find((i) => i.textContent === "正则")).dispatchEvent(new w.Event("click", { bubbles: true }));
  const payload2 = sentColors[sentColors.length - 1].rules.find((r) => r.name === "u0");
  check("正则模式：pattern 原样不动", payload2.pattern === "[D]");
}

partA();
await partB();
console.log(`\n结果: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
