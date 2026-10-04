// 回归：终端页「常驻查找条」与 Ctrl+F 直通远端。
//
// 设计契约（本次实现的核心前提）：
//  1. 终端是**直通远端**的：Ctrl+F 必须原样发给远端 shell（readline 的 forward-char、
//     vim 翻页等都要用），网页侧**不得**拦它。因此终端页查找条不做快捷键触发。
//  2. 查找条**常驻**在终端工具条右端（「本地回显/清屏」之后），无需任何操作即可见。
//  3. 收发页的 Ctrl+F 行为不变（拦下 WebView2 内建查找 + 开自绘查找栏）。
//
// 历史背景：早先实现曾用 xterm 的 attachCustomKeyEventHandler 抢占 Ctrl+F 并隐藏查找条，
//   这会吃掉远端按键且不符合「常驻可见」的要求，已改掉（见 terminal.ts 构造器注释）。
import { readFileSync, readdirSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";

let pass = 0, fail = 0;
const check = (name, cond) => {
  console.log((cond ? "✓ " : "✗ ") + name);
  cond ? pass++ : fail++;
};

const readHtml = () => readFileSync("dist/index.html", "utf8").replace(/<script[^>]*><\/script>/g, "");
const readBundle = () => {
  const asset = readdirSync("dist/assets").find((f) => f.startsWith("index-") && f.endsWith(".js"));
  return readFileSync(`dist/assets/${asset}`, "utf8")
    .replaceAll("import.meta", "({ url: 'http://localhost/', env: {} })")
    .replace(/export\s*\{[^}]*\}\s*;?/g, "");
};

function boot() {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", (e) => errors.push(e.detail?.stack || e.message || String(e)));
  vc.on("error", (...a) => errors.push(a.join(" ")));
  const dom = new JSDOM(readHtml(), {
    url: "http://localhost:1420/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const w = dom.window;
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  const noop = () => {};
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "canvas" ? { width: 300, height: 150 } : noop) });
  w.navigator.wrappedJSObject = undefined;
  Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { get() { return 600; }, configurable: true });
  try { w.eval(readBundle()); } catch (e) { errors.push(e.stack || String(e)); }
  return { w, errors };
}

const active = (w) => w.document.querySelector(".session-ui:not(.hidden-session)");
const switchTo = (w, page) => {
  active(w).querySelector(`#sidebar button[data-page="${page}"]`)?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
};

// ─────────────────── 常驻查找条存在且可见 ───────────────────
{
  const { w, errors } = boot();
  check("终端：初始化完成", w.__MAXCOM_READY__ === true);
  const s = active(w);

  const bar = s.querySelector(".term-bar");
  check("终端：工具条 .term-bar 存在", !!bar);

  const find = s.querySelector("#term-find");
  check("终端：查找条 #term-find 存在", !!find);
  check("终端：查找条**常驻可见**（无 hidden 类）", !!find && !find.classList.contains("hidden"));
  check("终端：查找输入框存在", !!s.querySelector("#term-find-input"));
  check("终端：计数节点存在且初始为无命中", (s.querySelector("#term-find-count")?.textContent || "").length > 0);

  // 查找条必须是工具条的直接子节点，且排在「本地回显 / 清屏」之后（即右端）
  const kids = [...(bar?.children || [])];
  check("终端：查找条在工具条内、位于最后（右端）", kids[kids.length - 1]?.id === "term-find");
  check("终端：工具条仍保留本地回显与清屏（查找条不挤掉它们）", kids.length >= 3);

  // 查找条不应依赖任何快捷键才出现
  check("终端：加载即渲染查找条，无需 Ctrl+F", !!find && !find.classList.contains("hidden"));

  for (const e of errors) console.error("  jsdom error:", e);
}

// ─────────────────── Ctrl+F 在终端页放行、在收发页拦截 ───────────────────
{
  const { w, errors } = boot();
  const s = active(w);
  switchTo(w, "terminal");
  check("Ctrl+F：已切到终端页", w.__MAXCOM_DEBUG__().page === "terminal");

  // 终端页：不得 preventDefault（否则等于吃掉远端的 ^F）
  const evT = new w.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
  w.document.dispatchEvent(evT);
  check("Ctrl+F：终端页**不拦截**（放行给远端）", evT.defaultPrevented === false);
  check("Ctrl+F：终端页不打开收发页查找栏", s.querySelector("#find-bar")?.classList.contains("hidden") === true);

  // 回收发页：应拦截并打开自绘查找栏
  switchTo(w, "logview");
  check("Ctrl+F：已切回收发页", w.__MAXCOM_DEBUG__().page === "logview");
  const evL = new w.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
  w.document.dispatchEvent(evL);
  check("Ctrl+F：收发页**拦截**（拦下 WebView2 内建查找条）", evL.defaultPrevented === true);
  check("Ctrl+F：收发页打开自绘查找栏", s.querySelector("#find-bar")?.classList.contains("hidden") === false);

  for (const e of errors) console.error("  jsdom error:", e);
}

// ─────────────────── 输入框内按键不穿透（但不影响终端直通）───────────────────
{
  const { w, errors } = boot();
  const s = active(w);
  const input = s.querySelector("#term-find-input");

  // 在查找框里敲字：应触发检索管线而不抛错（xterm 在 jsdom 下无真实渲染，只验不崩）
  input.value = "root";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  check("终端查找：输入检索词不抛错", true);

  // Enter / Shift+Enter / ✕ 按钮都应可点且不抛错
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
  s.querySelector("#term-find-next")?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  s.querySelector("#term-find-prev")?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  s.querySelector("#term-find-clear")?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  check("终端查找：Enter/Shift+Enter/↑↓/✕ 交互不抛错", true);
  check("终端查找：✕ 清空输入框", input.value === "");

  // Esc 在查找框内只清空、不隐藏查找条（常驻）
  input.value = "abc";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check("终端查找：Esc 清空输入框", input.value === "");
  check("终端查找：Esc 后查找条仍常驻可见", !s.querySelector("#term-find").classList.contains("hidden"));

  for (const e of errors) console.error("  jsdom error:", e);
}

// ───────────── 终端查找**真的能命中**（回归 2026-10 的「终端搜不到」bug）─────────────
// 背景：SearchAddon 的 decorations 走 terminal.registerDecoration()，属 xterm 的
// proposed API。Terminal 未开 allowProposedApi 时，findNext 会在
// _highlightAllMatches → createHighlightDecorations 抛异常，异常位置在
// updateResults 之后、fireResults 之前，导致 onDidChangeResults 永不触发 →
// 计数永远停在「无命中」。jsdom 里 mock 不产生终端字节，所以必须用探针造数据。
await (async () => {
  const { w, errors } = boot();
  const s = active(w);
  switchTo(w, "terminal");
  check("终端查找(真实)：已切到终端页", w.__MAXCOM_DEBUG__().page === "terminal");

  const probe = w.__MAXCOM_TERM_PROBE__;
  check("终端查找(真实)：探针可用", typeof probe === "function");

  // 造一段含 ANSI 的伪 shell 输出，内容与 mock 的终端流同构。
  // 注意：xterm 的 write() 是**异步解析**，写入后必须让出一拍再读缓冲。
  probe("write", "root@host:~$ echo hello\r\nhello world\r\nroot@host:~$ \r\n");
  await new Promise((r) => setTimeout(r, 80));
  const st0 = probe("state");
  check("终端查找(真实)：终端缓冲已写入内容", st0.bufferLength > 1 && st0.bufferLine0.includes("root"));

  // 关键断言：搜 root 必须命中 2 处（第 0 行 + 第 2 行），且计数刷成 x/2
  s.querySelector("#term-find-input").value = "root";
  s.querySelector("#term-find-input").dispatchEvent(new w.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));
  const st1 = probe("state");
  check("终端查找(真实)：搜索 root 命中（计数非「无命中」）", st1.count.includes("/"));
  check("终端查找(真实)：命中总数为 2", /\/2$/.test(st1.count.trim()));

  // 换词再验一次，确保不是偶然
  s.querySelector("#term-find-input").value = "hello";
  s.querySelector("#term-find-input").dispatchEvent(new w.Event("input", { bubbles: true }));
  check("终端查找(真实)：换词 hello 命中 2 处", /\/2$/.test(probe("state").count.trim()));

  // 无命中词应回落为「无命中」
  s.querySelector("#term-find-input").value = "zzz-not-there";
  s.querySelector("#term-find-input").dispatchEvent(new w.Event("input", { bubbles: true }));
  check("终端查找(真实)：不存在的词回落为无命中", !probe("state").count.includes("/"));

  for (const e of errors) console.error("  jsdom error:", e);
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
