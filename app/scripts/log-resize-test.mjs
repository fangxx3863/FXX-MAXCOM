// 回归（真实浏览器）：容器宽度变化后，收发区的高度缓存必须作废重算，不得留下一片空白。
//
// 为什么必须用真实浏览器而不是 jsdom：
//   缺陷本体是**布局几何**——chunk 的占位高度是"按当时容器宽度实测"出来的（长行折不折行
//   直接决定页高）。jsdom 不做布局（offsetHeight/scrollHeight 恒为 0），而且没有
//   ResizeObserver，桩出来的等高等宽几何会让这个缺陷根本无处附着。只能真跑。
//
// 缺陷回顾（2026-10，实测数据）：
//   ① 宽（1203px）每页 950px；② 侧栏打开 → 240px，长行折行 → 该页实测 2071px；
//   ③ 关侧栏后宽布局真实只有 950px，但占位容器的 min-height 仍是 2071px →
//      scrollHeight 虚高 1824px。此时"跟随最新"一路贴底，正好停在这段被撑出来的空隙里：
//      **视口内可见行 = 0**（修复前实测），数据仍在到达、开关也仍是勾选态。
//      ⑤⑥ 复刻用户实际动作（宽布局下翻一眼历史再回到最新）即可稳定触发。
//   根因：`chunkHeights` / `min-height` 与"测量时的容器宽度"绑定，宽度变了却没人通知它。
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright-core";

let pass = 0, fail = 0;
const check = (name, cond) => {
  console.log((cond ? "✓ " : "✗ ") + name);
  cond ? pass++ : fail++;
};

const ROOT = join(process.cwd(), "dist");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".map": "application/json",
};
const server = createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/") p = "/index.html";
  const f = join(ROOT, p);
  if (!f.startsWith(ROOT) || !existsSync(f) || !statSync(f).isFile()) {
    res.writeHead(404); return res.end("not found");
  }
  res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// 浏览器缺失时跳过而非失败（同 find-jump）：CI 无可用浏览器时不让整链失败，但要打告警
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
} catch {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    console.warn("⚠ 未找到可用浏览器，跳过尺寸变化回归：" + (e?.message || e));
    console.warn("  （该用例专门覆盖布局几何缺陷，jsdom 无法替代；请在装有 Chrome/Chromium 的环境跑）");
    server.close();
    process.exit(0);
  }
}
// 视口刻意收窄：这样"侧栏开合"带来的宽度变化足以让 mock 行折行 —— 与用户现场同构
const page = await browser.newPage({ viewport: { width: 700, height: 800 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
await page.waitForFunction(() => window.__MAXCOM_READY__ === true, null, { timeout: 20000 });

// 每页 50 行（可设最小值）→ 攒够行数才有多页，懒加载窗口才会卸载远端页
await page.evaluate(() => {
  const el = document.querySelector("#set-log-page-rows");
  el.value = "50";
  el.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.evaluate(() => {
  document
    .querySelector(".session-ui:not(.hidden-session) #sidebar button[data-page='logview']")
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
});

// 连接攒日志 → 断开（避免 pump 继续追加，把几何断言搅成全时序竞速）
await page.click("#connect-btn");
await page.waitForTimeout(52000);
await page.click("#connect-btn");
await page.waitForTimeout(400);

const SEL = ".session-ui:not(.hidden-session) #log-view";
const measure = () =>
  page.evaluate((sel) => {
    const view = document.querySelector(sel);
    const vr = view.getBoundingClientRect();
    const lines = [...view.querySelectorAll(".log-line")];
    const visible = lines.filter((l) => {
      const r = l.getBoundingClientRect();
      return r.bottom > vr.top + 1 && r.top < vr.bottom - 1;
    }).length;
    const chunks = [...view.children].filter((c) => c.dataset.chunk !== undefined);
    const mountedH = [], placeholderH = [];
    for (const c of chunks) (c.children.length ? mountedH : placeholderH).push(c.offsetHeight);
    return {
      viewW: Math.round(vr.width),
      lines: window.__MAXCOM_DEBUG__().lineCount,
      scrollTop: Math.round(view.scrollTop),
      maxScroll: Math.round(view.scrollHeight - view.clientHeight),
      visible,
      maxMountedH: Math.max(0, ...mountedH),
      maxPlaceholderH: Math.max(0, ...placeholderH),
      mounted: chunks.filter((c) => c.children.length).length,
      total: chunks.length,
    };
  }, SEL);

const scrollTo = async (where) => {
  await page.evaluate(({ sel, w }) => {
    const view = document.querySelector(sel);
    view.scrollTop = w === "bottom" ? view.scrollHeight : 0;
  }, { sel: SEL, w: where });
  await page.waitForTimeout(250);
};

// 模拟「侧栏展开 / 收起」：只是几何变化，其余一切照旧
const setNarrow = async (w) => {  await page.evaluate(({ sel, width }) => {
    const view = document.querySelector(sel);
    if (width) { view.style.flex = "none"; view.style.width = width + "px"; }
    else { view.style.flex = ""; view.style.width = ""; }
  }, { sel: SEL, width: w });
  await page.waitForTimeout(150);
};

const scrollToBottomByGear = () =>
  page.evaluate((sel) => {
    const view = document.querySelector(sel);
    view.scrollTop = view.scrollHeight;
  }, SEL);

await scrollTo("top");
const initial = await measure();
check(`真实浏览器：日志已积累（${initial.lines} 行 / ${initial.total} 页）`, initial.lines > 260 && initial.total >= 6);
check(`真实浏览器：懒加载已启用（挂载 ${initial.mounted}/${initial.total} 页）`, initial.mounted < initial.total);
check(`真实浏览器：初始（宽）日志可见（${initial.visible} 行）`, initial.visible > 0);

// ── 用户路径：打开侧栏（变窄）→ 在窄布局下产生新的实测高度 → 关闭侧栏（恢复宽）──
await setNarrow(240);
await scrollToBottomByGear();
await page.waitForTimeout(300);
const narrow = await measure();
check(`真实浏览器：窄布局下仍可见（${narrow.visible} 行）`, narrow.visible > 0);
check(`真实浏览器：窄布局确实让页变高（${narrow.maxMountedH} > ${initial.maxMountedH}）`, narrow.maxMountedH > initial.maxMountedH);

await setNarrow(0);
await page.waitForTimeout(300);
const restored = await measure();
check(`真实浏览器：宽度恢复后不做任何操作也可见（${restored.visible} 行）`, restored.visible > 0);
check(
  `真实浏览器：宽度恢复后几何回到原状（maxScroll ${restored.maxScroll} vs 初始 ${initial.maxScroll}）`,
  Math.abs(restored.maxScroll - initial.maxScroll) <= Math.max(20, initial.maxScroll * 0.05),
);

// ── 核心：宽布局下翻一眼历史再回到最新（触发"窄布局测过的页"卸载→重新挂载）──
await scrollTo("top");
const atTop = await measure();
// 滚到顶时全部页的几何都该是当前布局下的准确值 → scrollHeight 不得比初始值高
// （修复前实测 9593 vs 5717：未挂载页仍按窄布局的 2185px 撑着）
check(
  `真实浏览器：滚到顶后几何未虚高（maxScroll ${atTop.maxScroll} vs 初始 ${initial.maxScroll}）`,
  atTop.maxScroll <= initial.maxScroll * 1.05 + 20,
);
check(`真实浏览器：滚到顶后日志可见（${atTop.visible} 行）`, atTop.visible > 0);

await scrollTo("bottom");
const back = await measure();
check(`真实浏览器：回到最新后日志可见（${back.visible} 行）`, back.visible > 0);
check(
  `真实浏览器：回到最新后几何仍准确（maxScroll ${back.maxScroll} vs 初始 ${initial.maxScroll}）`,
  Math.abs(back.maxScroll - initial.maxScroll) <= Math.max(20, initial.maxScroll * 0.05),
);

// ── 用户报的原始入口：点开「规则」面板再关闭 ──
await page.evaluate(() => document.querySelector("#toggle-rules").dispatchEvent(new MouseEvent("click", { bubbles: true })));
await page.waitForTimeout(250);
const panelOpen = await measure();
check(`真实浏览器：规则面板展开时日志可见（${panelOpen.visible} 行）`, panelOpen.visible > 0);

await page.evaluate(() => document.querySelector("#toggle-rules").dispatchEvent(new MouseEvent("click", { bubbles: true })));
await page.waitForTimeout(250);
const panelClosed = await measure();
check(`真实浏览器：关闭规则面板后日志仍可见（${panelClosed.visible} 行）`, panelClosed.visible > 0);

check("真实浏览器：全程无页面异常", pageErrors.length === 0);
for (const e of pageErrors) console.error("  pageerror:", e);

await browser.close();
server.close();
check(`${pass}/${pass + fail} 断言通过`, fail === 0);
process.exit(fail ? 1 : 0);
