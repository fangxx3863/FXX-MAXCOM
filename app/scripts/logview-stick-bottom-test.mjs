// 回归（真实浏览器）：勾着「自动滚动」时，两种「高度悄悄变大」的场景必须依然贴底。
//
// 为什么必须用真实浏览器：缺陷本体是**布局与可见性**——
//   · 切标签页/切页面走的是 display:none，隐藏期间 clientHeight/scrollHeight 都是 0，
//     浏览器还会把 scrollTop 归零；jsdom 既不做布局也不做这件事，桩不出这个缺陷。
//   · 「单行多数据」是同一个 .log-line 被 partial 续行越写越长（折行成几十行），
//     高度变化只体现在真实排版里。
//
// 缺陷回顾（2026-10，用户现场）：
//   ① 开着自动滚动切到别的标签页/别的页，回来时视图停在**顶部**（scrollTop 被归零后没人再贴底）。
//      根因：append 里的 scrollToBottom 在隐藏态只能算出 0；ResizeObserver 恢复可见时
//      走的是「宽度没变 → 只 ensureWindow」分支，从不贴底。
//   ② 设备一直吐不带换行的长行（partial 续接，同一行反复变长）时视图不动，越落越远。
//      根因：append 只在「新增了行」时贴底（appendedRows > 0），纯续接批次一行都没新增 → 不贴底，
//      而这一行的折行高度却在涨。
import { build } from "esbuild";
import { join } from "node:path";
import { chromium } from "playwright-core";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "✓ " : "✗ ") + name + (extra ? `  ${extra}` : ""));
  cond ? pass++ : fail++;
};

// 只打包 logview.ts（含 i18n），不依赖 dist 产物，改动即刻可验
const res = await build({
  entryPoints: [join(process.cwd(), "src", "pages", "logview.ts")],
  bundle: true,
  format: "iife",
  globalName: "LV",
  write: false,
  target: "es2020",
  logLevel: "silent",
});
const js = res.outputFiles[0].text;

let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
} catch {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    console.warn("⚠ 未找到可用浏览器，跳过粘底回归：" + (e?.message || e));
    process.exit(0);
  }
}

const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.setContent(`<!DOCTYPE html><html><body>
  <div id="host"><div id="log-view"></div></div>
  <label><input id="autoscroll" type="checkbox" checked></label>
</body></html>`);
await page.addStyleTag({
  content: `
  body { margin: 0; background: #101418; color: #dce0e8; }
  #host { width: 640px; height: 420px; display: flex; flex-direction: column; }
  #log-view { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-anchor: none;
              font-family: Consolas, monospace; font-size: 12.5px; line-height: 1.5; padding: 4px 10px; }
  .log-line { display: flex; align-items: flex-start; min-height: var(--log-row-h, 1.5em); }
  .log-ts { flex: 0 0 auto; min-width: 12ch; text-align: right; margin-right: 8px; color: #6a7380; }
  .log-content { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; word-break: break-all; }
  `,
});
await page.addScriptTag({ content: js });

await page.evaluate(() => {
  const view = document.querySelector("#log-view");
  const autoscroll = document.querySelector("#autoscroll");
  window.__lv = new LV.LogViewPage(view, { autoscroll, getTsMode: () => "none" });
  window.__autoscroll = autoscroll;
  /** 灌入 n 条新行 */
  window.__feed = (n, text = "line") => {
    const items = [];
    for (let i = 0; i < n; i++) items.push({ ts_ms: i, text, segments: [{ text }], raw_hex: "" });
    window.__lv.append({ epoch_anchor_ms: 0, items });
  };
  /** 续接同一行（设备不发换行）：partial=true 表示这一行还没写完 */
  window.__feedPartial = (text, partial = true) => {
    window.__lv.append({
      epoch_anchor_ms: 0,
      items: [{ ts_ms: 0, text, segments: [{ text }], raw_hex: "", partial }],
    });
  };
  window.__geom = () => ({
    st: Math.round(view.scrollTop),
    max: Math.round(view.scrollHeight - view.clientHeight),
    sh: Math.round(view.scrollHeight),
    ch: view.clientHeight,
    lines: view.querySelectorAll(".log-line").length,
    lastBottom: (() => {
      const lines = view.querySelectorAll(".log-line");
      const last = lines[lines.length - 1];
      if (!last) return null;
      const vr = view.getBoundingClientRect();
      const r = last.getBoundingClientRect();
      return { top: Math.round(r.top - vr.top), bottom: Math.round(r.bottom - vr.top), h: Math.round(r.height) };
    })(),
  });
  window.__setSticky = (on) => {
    autoscroll.checked = on;
    autoscroll.dispatchEvent(new Event("change", { bubbles: true }));
  };
  window.__setHostDisplay = (v) => (document.querySelector("#host").style.display = v);
});
const geom = () => page.evaluate(() => window.__geom());
const feed = (n, text) => page.evaluate(({ n, text }) => window.__feed(n, text), { n, text });
const feedPartial = (text, partial = true) =>
  page.evaluate(({ text, partial }) => window.__feedPartial(text, partial), { text, partial });
const settle = (ms = 120) => page.waitForTimeout(ms);
/** 贴底判定：允许 1px 的取整误差 */
const atBottom = (g) => Math.abs(g.st - g.max) <= 1;
/** 末行完整可见（贴底的可视证据） */
const lastLineVisible = (g) => !!g.lastBottom && g.lastBottom.bottom <= g.ch + 1 && g.lastBottom.bottom > 0;

// ── A. 基线：新行到达时贴底（现有行为，防止改坏）──
for (let i = 0; i < 12; i++) await feed(30);
await settle();
let g = await geom();
check("新行到达后贴底", atBottom(g), `scrollTop=${g.st} max=${g.max}`);
check("贴底时末行完整可见", lastLineVisible(g), JSON.stringify(g.lastBottom));

// ── B. 单行多数据：partial 续接把同一行越写越长（不新增行）──
const beforeMerge = await geom();
for (let i = 0; i < 24; i++) await feedPartial("PT100: R_REF_P=4513394 R_REF_N=-4513572 R_A_P=4512379; ");
await settle();
g = await geom();
check(
  "单行续接确实让内容变高（用例有效）",
  g.sh > beforeMerge.sh + 200,
  `scrollHeight ${beforeMerge.sh} → ${g.sh}`,
);
check("单行多数据（续接变长）后仍贴底", atBottom(g), `scrollTop=${g.st} max=${g.max}`);
check("单行多数据后末行完整可见", lastLineVisible(g), JSON.stringify(g.lastBottom));

// 再来一轮：长行 + 新行混着来（真实设备常见：长行写完才换行）
for (let i = 0; i < 10; i++) await feedPartial("more data on the same very long line; ");
await feedPartial("", false); // 这一行收尾
for (let i = 0; i < 8; i++) await feed(5, "after long line");
await settle();
g = await geom();
check("长行收尾后继续贴底", atBottom(g), `scrollTop=${g.st} max=${g.max}`);

// ── C. 切标签页：隐藏期间到达数据，切回来必须贴在最新 ──
await page.evaluate(() => window.__setHostDisplay("none"));
await settle(60);
for (let i = 0; i < 10; i++) await feed(30, "arrived while hidden");
await page.evaluate(() => window.__setHostDisplay(""));
await settle(200);
g = await geom();
check("隐藏期间来数据，切回来贴底", atBottom(g), `scrollTop=${g.st} max=${g.max}`);
check("切回来时末行完整可见", lastLineVisible(g), JSON.stringify(g.lastBottom));

// ── D. 切标签页：隐藏期间没有新数据，切回来也得仍在底部 ──
await page.evaluate(() => window.__setHostDisplay("none"));
await settle(60);
await page.evaluate(() => window.__setHostDisplay(""));
await settle(200);
g = await geom();
check("隐藏期间无数据，切回来仍贴底", atBottom(g), `scrollTop=${g.st} max=${g.max}`);

// ── E. 隐藏期间长行继续变长（切回来也要到底）──
await page.evaluate(() => window.__setHostDisplay("none"));
await settle(60);
for (let i = 0; i < 16; i++) await feedPartial("hidden-growing-line ");
await page.evaluate(() => window.__setHostDisplay(""));
await settle(200);
g = await geom();
check("隐藏期间单行变长，切回来贴底", atBottom(g), `scrollTop=${g.st} max=${g.max}`);

// ── F. 关掉自动滚动：切标签页不得把阅读位置拽到底部 ──
await page.evaluate(() => window.__setSticky(false));
await page.evaluate(() => {
  const v = document.querySelector("#log-view");
  v.scrollTop = Math.round((v.scrollHeight - v.clientHeight) * 0.4);
});
await settle(80);
const keptBefore = (await geom()).st;
await page.evaluate(() => window.__setHostDisplay("none"));
await settle(60);
await page.evaluate(() => window.__setHostDisplay(""));
await settle(200);
g = await geom();
check(
  "关掉自动滚动后切标签页，阅读位置不被拽走",
  Math.abs(g.st - keptBefore) <= 2 && !atBottom(g),
  `before=${keptBefore} after=${g.st} max=${g.max}`,
);

// ── G. 关掉自动滚动时新数据不拽视图（现有行为，防回归）──
const keptG = await geom();
await feed(20, "while manual");
await settle();
g = await geom();
check("手动滚动态新数据不拽走视图", g.st === keptG.st, `${keptG.st} → ${g.st}`);

// ── H. 重新勾上自动滚动 → 立即回到底部 ──
await page.evaluate(() => window.__setSticky(true));
await settle();
g = await geom();
check("重新勾选后立即贴底", atBottom(g), `scrollTop=${g.st} max=${g.max}`);

check("全程无页面异常", pageErrors.length === 0);
for (const e of pageErrors) console.error("  pageerror:", e);

await browser.close();
console.log(`\n结果: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
