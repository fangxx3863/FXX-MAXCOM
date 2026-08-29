// 回归：日志视图懒加载窗口向上翻页不能出现空白。
// 场景：日志累计成多个 chunk 后先贴底（此时首部 chunk 被卸载成空占位），
//       再向上滚回到 top：窗口内的 chunk 必须重新挂载出内容。
// 曾引入的 bug：unmountChunk 只清空内容保留占位容器，chunks[i] 仍非 null，
//       ensureWindow 误判为“已挂载”，导致向上翻到的页一直空白。
// 回归：日志视图懒加载窗口向上翻页不能出现空白。
// 场景：日志累计成多个 chunk 后先贴底（此时首部 chunk 被卸载成空占位），
//       再向上滚回到 top：窗口内的 chunk 必须重新挂载出内容。
// 曾引入的 bug：unmountChunk 只清空内容保留占位容器，chunks[i] 仍非 null，
//       ensureWindow 误判为“已挂载”，导致向上翻到的页一直空白。
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
const dir = mkdtempSync(join(process.cwd(), "scripts", ".lv-lazy-"));
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

const view = makeView();
const lv = new LogViewPage(view, { autoscroll, getTsMode: () => "none" });
const mk = (t) => ({ ts_ms: 1, text: t, segments: [], raw_hex: "" });
const mountedIdx = () =>
  Array.from(view.children)
    .filter((c) => c.dataset.chunk !== undefined && c.childElementCount > 0)
    .map((c) => Number(c.dataset.chunk));
const chunkEl = (i) => [...view.children].find((c) => c.dataset.chunk === String(i));

// 300 × 10 = 3000 行 → 6 个 chunk（rowsPerPage=500）。
for (let b = 0; b < 10; b++) {
  const items = [];
  for (let i = 0; i < 300; i++) items.push(mk("s" + b + "-" + i));
  lv.append({ epoch_anchor_ms: 0, items });
}

// 贴底收敛窗口：0/1/2 被卸载成空占位。
view.dispatchEvent(new w.Event("scroll"));
check("贴底后 chunk 0/1/2 已被卸载为空占位", [0, 1, 2].every((i) => chunkEl(i)?.childElementCount === 0));

// 回到顶部：窗口 [0..2] 必须重新挂载出内容。
view.scrollTop = 0;
view.dispatchEvent(new w.Event("scroll"));
check("回到顶部后窗口重新挂载 chunk 0", chunkEl(0)?.childElementCount > 0);
check("回到顶部后窗口重新挂载 chunk 1", chunkEl(1)?.childElementCount > 0);
check("回到顶部后窗口重新挂载 chunk 2", chunkEl(2)?.childElementCount > 0);

// 任意滚动方向都应有内容：滚到底、再滚到中部。
lv.scrollToBottom();
view.dispatchEvent(new w.Event("scroll"));
check("回到底部后首部 0/1/2 被卸载", [0, 1, 2].every((i) => chunkEl(i)?.childElementCount === 0));
view.scrollTop = Math.floor((view.scrollHeight - CLIENT_H) / 3);
view.dispatchEvent(new w.Event("scroll"));
const midMounted = mountedIdx();
check("滚动到中部后窗口包含当前页且非空白", midMounted.length > 0);

rmSync(dir, { recursive: true, force: true });
console.log(`\n结果: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
