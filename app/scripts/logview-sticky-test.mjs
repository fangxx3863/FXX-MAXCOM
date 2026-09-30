// 回归：日志视图「自动滚动」开关不能被突发数据冲掉。
// 场景：数据成批涌入，每批插入 DOM 后 scrollHeight 立即变大，而重新贴底发生在稍后；
//       这中间浏览器会派发 scroll 事件（位置尚未到底）。
// 曾引入的 bug：onScroll 无条件用 isAtBottom() 回写复选框 → 上述瞬间被误判为「用户离开底部」，
//       开关自己掉下来；之后 append 的两条贴底路径（checked / wasBottom）同时失效，滚动停住。
// 现约定：开关是唯一权威状态，只在用户主动表态时改写——
//       滚轮/触屏向上、↑、PageUp、Home → 解锁；滚轮/触屏向下且已在底部 → 恢复跟随；
//       拖动滚动条期间跟手；手动勾选/取消即时生效。程序性滚动与数据增长不改开关。
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

// 用 transformSync 做纯字符串转译，不向上遍历文件系统（在受限沙箱/CI 都稳定）。
const src = readFileSync(join(process.cwd(), "src", "pages", "logview.ts"), "utf8")
  .replace('import { t } from "../i18n";', "const { t } = globalThis.__i18n;");
const out = transformSync(src, { loader: "ts", format: "cjs", target: "es2020" }).code;
globalThis.__i18n = { t: (k) => k };
const dir = mkdtempSync(join(process.cwd(), "scripts", ".lv-sticky-"));
writeFileSync(join(dir, "b.cjs"), out);
const mod = await import("file://" + join(dir, "b.cjs").replace(/\\/g, "/"));
const LogViewPage = mod.default?.LogViewPage ?? mod.LogViewPage;
if (typeof LogViewPage !== "function") {
  console.error("✗ 无法从转译产物拿到 LogViewPage");
  process.exit(1);
}

const ROW_H = 24, CLIENT_H = 600;
const view = document.createElement("div");
view.style.fontSize = "16px";
view.style.lineHeight = "1.5";
document.body.appendChild(view);
Object.defineProperty(view, "clientHeight", { get: () => CLIENT_H, configurable: true });
// 虚拟滚动高度：内容一插入 DOM 就变高（贴近真实布局时序：renderTail 先于 scrollToBottom）
let virtualH = 0;
Object.defineProperty(view, "scrollHeight", { get: () => virtualH, configurable: true });

const autoscroll = document.createElement("input");
autoscroll.type = "checkbox";
autoscroll.checked = true;

const lv = new LogViewPage(view, { autoscroll, getTsMode: () => "none" });
const maxScroll = () => Math.max(0, virtualH - CLIENT_H);
const fireScroll = () => view.dispatchEvent(new w.Event("scroll"));
/** 合成滚轮事件（不依赖 jsdom 是否实现 WheelEvent） */
function fireWheel(deltaY) {
  const ev = new w.Event("wheel");
  Object.defineProperty(ev, "deltaX", { value: 0 });
  Object.defineProperty(ev, "deltaY", { value: deltaY });
  view.dispatchEvent(ev);
}
/** 合成「按住右缘滚动条」的 pointerdown（jsdom 的 rect 全零，故用大 x 落到滚动条槽） */
function startScrollbarDrag() {
  const ev = new w.Event("pointerdown");
  Object.defineProperty(ev, "clientX", { value: CLIENT_H + 999 });
  Object.defineProperty(ev, "clientY", { value: 10 });
  view.dispatchEvent(ev);
}
const endScrollbarDrag = () => w.dispatchEvent(new w.Event("pointerup"));

/**
 * 灌入 rows 行。staleScroll=true 时，在「内容已变高、尚未贴底」的那一帧补一个 scroll 事件，
 * 复现突发数据下最容易冲掉开关的时刻。
 */
function feed(rows, staleScroll = false) {
  const items = [];
  for (let i = 0; i < rows; i++) items.push({ ts_ms: 1, text: "line", segments: [], raw_hex: "" });
  virtualH += rows * ROW_H;
  if (staleScroll) fireScroll();
  lv.append({ epoch_anchor_ms: 0, items });
}

// ── A. 突发数据不得改动开关 ──
for (let b = 0; b < 8; b++) feed(600, true);
check("突发 8 批数据后开关仍为「跟随」", autoscroll.checked === true);
check("突发结束后贴底在最新一行", view.scrollTop === maxScroll());

// ── B. 滚轮向上 → 解锁 ──
fireWheel(-120);
check("滚轮向上立即解锁", autoscroll.checked === false);
view.scrollTop = Math.max(0, view.scrollTop - 2000); // 视口真的上移了
fireScroll();
check("上滚后仍为手动滚动态", autoscroll.checked === false);

const posAfterUnlock = view.scrollTop;
feed(600, true);
check("解锁后新数据不再把视图拽到底部", view.scrollTop === posAfterUnlock && view.scrollTop !== maxScroll());
view.scrollTop = maxScroll();
fireScroll();
check("非用户产生的 scroll 即便停在底部也不会勾回开关", autoscroll.checked === false);

// ── C. 滚轮向下停在底部 → 恢复跟随 ──
fireWheel(120);
check("滚轮向下且已在底部 → 恢复跟随", autoscroll.checked === true);
feed(600, true);
check("恢复跟随后新数据继续贴底", view.scrollTop === maxScroll());

// ── D. 拖滚动条期间跟手（向上解锁 / 回到底部恢复） ──
startScrollbarDrag();
view.scrollTop = Math.max(0, view.scrollTop - 3000);
fireScroll();
check("拖动滚动条向上 → 解锁", autoscroll.checked === false);
view.scrollTop = maxScroll();
fireScroll();
check("继续拖到底部 → 恢复跟随", autoscroll.checked === true);
endScrollbarDrag();
view.scrollTop = Math.max(0, view.scrollTop - 3000);
fireScroll();
check("松手后的残留 scroll 不再改判开关", autoscroll.checked === true);

// ── E. 手动取消勾选 = 手动滚动，原地空滚轮也不许偷偷勾回 ──
view.scrollTop = maxScroll();
autoscroll.checked = false;
autoscroll.dispatchEvent(new w.Event("change", { bubbles: true }));
fireWheel(120);
fireWheel(120);
check("手动取消后，原地空滚轮不会把开关勾回来", autoscroll.checked === false);
const beforeManual = view.scrollTop;
feed(600, true);
check("手动取消后新数据不拽走视图", view.scrollTop === beforeManual);

// ── F. 手动勾选 = 立即贴底 ──
autoscroll.checked = true;
autoscroll.dispatchEvent(new w.Event("change", { bubbles: true }));
check("手动勾选后立即贴底", view.scrollTop === maxScroll());

rmSync(dir, { recursive: true, force: true });
console.log(`\n结果: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
