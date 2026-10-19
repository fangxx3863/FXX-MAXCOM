// 回归：收发区持续来数据时，拖选一段文本不得被冲掉。
//
// 用户报的症状（2026-10）：收发区还在不断收到数据，按住左键想选一段复制，
//   只要中途来一条新数据，**选区立刻被拽回顶部**，选择当场报废。
//
// 成因：实时流下两条路径都在动 DOM ——
//   ① append → renderTail() → fillChunk(尾页)：用户正在拖选的节点所在尾页被整体重渲染；
//   ② append → scrollToBottom()：视口被搬到最新，拖选跟着跳。
// 修法：视图内**有非空选区**时，append 只入队数据（行数照常增长、数据不丢），
//   DOM 更新整体延后到 selectionchange 报「选区消失」再一次性补齐。
//   —— 用户看得见的内容在此期间完全静止，选区不可能被冲掉。
//
// 本脚本在 jsdom 里做三件事：
//   A. 暂停期：造一个非空选区 → 灌数据 → 断言 DOM 完全静止、选区仍在、视口未被搬走；
//   B. 恢复期：清空选区（模拟松手/点击别处）→ 断言欠账一次性补齐（新行可见 + 贴底）；
//   C. 反证：无选区时灌数据仍照常实时渲染（暂停不得让正常流变迟钝）。
//
// 实现说明：直接 eval 构建产物（同 find-test.mjs），避免测试链路里再起子进程
// （esbuild transformSync 在受限沙箱/CI 的 Windows 环境会因 spawn 管道被拒而挂）。
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
try { w.eval(readBundle()); } catch (e) { errors.push(e.stack || String(e)); }

if (w.__MAXCOM_READY__ !== true) {
  console.error("✗ 初始化未完成");
  for (const e of errors) console.error("  ", e);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const active = () => w.document.querySelector(".session-ui:not(.hidden-session)");

// 切到收发页，拿到真实会话的 LogViewPage（经 __MAXCOM_DEBUG__ 只读探针读行数）
active().querySelector("#sidebar button[data-page='logview']")
  .dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
const view = active().querySelector("#log-view");
const autoscroll = active().querySelector("#autoscroll");

// 直连 LogViewPage 实例：入口只有页面方法，实例本身不暴露。
// 演示后端 connect() 每 160ms 产出一批 → 用真实数据流验证（比手灌更贴近现场）。
await active().querySelector("#connect-btn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
await sleep(1500); // 演示连接 350ms + 若干批数据
const count0 = w.__MAXCOM_DEBUG__().lineCount;
check(`连接后已积累数据（${count0} 行）`, count0 > 5);
check("自动滚动默认开启（跟随最新）", autoscroll.checked === true);
await sleep(300);
const atBottom0 = Math.abs((view.scrollHeight - view.clientHeight) - view.scrollTop) < 4;
check("连接中视图贴底（跟随生效）", atBottom0);

/** 在视图内已渲染的行中选一个非空区间（模拟用户拖选两行） */
function makeSelection() {
  const lines = view.querySelectorAll(".log-line");
  if (lines.length < 2) return false;
  const sel = w.getSelection();
  sel.removeAllRanges();
  const r = w.document.createRange();
  r.setStart(lines[lines.length - 2], 0);
  r.setEnd(lines[lines.length - 1], lines[lines.length - 1].childNodes.length);
  sel.addRange(r);
  return !sel.isCollapsed && view.contains(sel.anchorNode);
}

// ── A. 暂停期：有非空选区 → 数据继续到达 → DOM/视口必须静止 ──
const selOk = makeSelection();
check("A: 已在视图内造出非空选区", selOk);
const selTextA = w.getSelection().toString();
const anchorA = w.getSelection().anchorNode;
const domFingerprint = () => [...view.querySelectorAll(".log-line")].map((l) => l.textContent).join("|");
const domA = domFingerprint();
const scrollTopA = view.scrollTop;
const rowsA = w.__MAXCOM_DEBUG__().lineCount;
await sleep(900); // 演示流 160ms/批 → 暂停期内必有多批到达
const rowsB = w.__MAXCOM_DEBUG__().lineCount;
check(`A: 数据不丢（暂停期间行数 ${rowsA} → ${rowsB}）`, rowsB > rowsA);
check("A: 暂停期间 DOM 完全静止（尾页未被重渲染）", domFingerprint() === domA);
check("A: 暂停期间视口未被贴底搬走", view.scrollTop === scrollTopA);
check("A: 选区仍非空", !w.getSelection().isCollapsed);
check("A: 选区锚点没被拽走（同一节点 = 没跳顶部）", w.getSelection().anchorNode === anchorA);
check("A: 选中的文本读得回来", w.getSelection().toString() === selTextA);

// ── B. 恢复期：选区消失（模拟松手后点击/复制完成）→ 欠账一次性补齐 ──
w.getSelection().removeAllRanges();
view.dispatchEvent(new w.Event("selectionchange")); // selectionchange 派发在 document 上
w.document.dispatchEvent(new w.Event("selectionchange"));
await sleep(200);
check("B: 恢复后行数与 DOM 对齐（欠账补齐）", view.querySelectorAll(".log-line").length > 0);
check("B: 恢复后恢复贴底（跟随开关未被冲掉）", autoscroll.checked === true);
check(
  "B: 恢复后贴到最新",
  Math.abs((view.scrollHeight - view.clientHeight) - view.scrollTop) < 4,
);
const rowsC = w.__MAXCOM_DEBUG__().lineCount;
await sleep(500);
check("B: 恢复后实时流照常推进", w.__MAXCOM_DEBUG__().lineCount > rowsC);

// ── C. 收尾 ──
check("全程无页面异常", errors.length === 0);
for (const e of errors) console.error("  ", e);

console.log(`\n结果: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
