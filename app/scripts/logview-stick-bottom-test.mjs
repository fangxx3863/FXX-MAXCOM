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
/**
 * 等浏览器真的跑完两帧（带兜底超时）。
 *
 * ResizeObserver 的回调在「更新渲染」阶段派发：主线程若一直被占着（大批量重渲染，CI 慢机器
 * 上很容易），隐藏态那一帧根本不会发生 → 「隐藏 0×0」与「恢复」被合并成一次净变化为零的
 * 观测，**一次回调都不派发**。所以可见性切换之后显式等帧，让「隐藏」这个状态真被看见一次
 * （这也是真实用户路径的时序：人不可能在一帧里切走又切回）。
 * 超时兜底：某些无头环境窗口不可见时整段不跑帧，不能把用例挂死。
 */
const frames = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve(null);
        };
        requestAnimationFrame(() => requestAnimationFrame(finish));
        setTimeout(finish, 200);
      }),
  );
const hide = async () => {
  await page.evaluate(() => window.__setHostDisplay("none"));
  await frames();
};
/** resync=true 时按 main.ts 的真实入口补一次（切标签页 / 切页面都这么调） */
const show = async (resync = false) => {
  await page.evaluate((resync) => {
    window.__setHostDisplay("");
    if (resync) window.__lv.resync();
  }, resync);
  await frames();
  await settle(80);
};
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

// ── C. 切标签页：隐藏期间到达数据，切回来必须贴在最新（产品路径 = main.ts 的 resync）──
await hide();
for (let i = 0; i < 10; i++) await feed(30, "arrived while hidden");
await show(true);
g = await geom();
check("隐藏期间来数据，切回来贴底（resync）", atBottom(g), `scrollTop=${g.st} max=${g.max}`);
check("切回来时末行完整可见", lastLineVisible(g), JSON.stringify(g.lastBottom));

// ── C2. 纯 RO 兜底：不调 resync，只靠观察器自己发现「尺寸从 0 变回来」──
// 这条只在隐藏态真的被观察者看见时才有意义（lastW/lastH 归零 = RO 派发过 0×0）。
// 无头环境窗口不可见时浏览器可能整段不跑帧、RO 一次都不派发 —— 那时这条兜底路径压根不存在
// （产品行为由 resync 覆盖），记为跳过而非失败，免得把环境差异当成缺陷。
await hide();
for (let i = 0; i < 6; i++) await feed(30, "arrived while hidden (RO)");
const roSawHidden = await page.evaluate(() => window.__lv.lastW === 0 && window.__lv.lastH === 0);
await show(false);
g = await geom();
if (roSawHidden) {
  check("隐藏期间来数据，切回来贴底（纯 RO 兜底）", atBottom(g), `scrollTop=${g.st} max=${g.max}`);
} else {
  console.log("⚠ 跳过「纯 RO 兜底」：本环境未派发 display:none 的尺寸观测（产品路径由 resync 覆盖）");
  await page.evaluate(() => window.__lv.resync());
}

// ── D. 切标签页：隐藏期间没有新数据，切回来也得仍在底部 ──
await hide();
await show(true);
g = await geom();
check("隐藏期间无数据，切回来仍贴底", atBottom(g), `scrollTop=${g.st} max=${g.max}`);

// ── E. 隐藏期间长行继续变长（切回来也要到底）──
await hide();
for (let i = 0; i < 16; i++) await feedPartial("hidden-growing-line ");
await show(true);
g = await geom();
check("隐藏期间单行变长，切回来贴底", atBottom(g), `scrollTop=${g.st} max=${g.max}`);

// ── E2. 隐藏与恢复落在同一帧（RO 一次都不派发）→ 只能靠 resync() ──
// 真实场景：切走 → 后台数据一直涌 → 切回，主线程被重渲染占满时 RO 观测会被合并掉。
// 这条不依赖 RO 是否派发，钉住「可见性是调用方断言的事实，不是几何推断出来的」。
const beforeCoalesce = (await geom()).max;
await page.evaluate(() => {
  const host = document.querySelector("#host");
  host.style.display = "none";
  window.__feed(120, "same-frame hidden"); // 隐藏与恢复之间不给浏览器跑帧的机会
  host.style.display = "";
});
await frames();
g = await geom();
check("同一帧内隐藏+恢复（RO 被合并）时仍停在旧位置", g.max > beforeCoalesce, `max ${beforeCoalesce} → ${g.max}`);
await page.evaluate(() => window.__lv.resync());
await frames();
g = await geom();
check("RO 被合并时 resync() 仍能贴底", atBottom(g), `scrollTop=${g.st} max=${g.max}`);
check("resync 后末行完整可见", lastLineVisible(g), JSON.stringify(g.lastBottom));

// ── F. 关掉自动滚动：切标签页不得把阅读位置拽到底部 ──
await page.evaluate(() => window.__setSticky(false));
await page.evaluate(() => {
  const v = document.querySelector("#log-view");
  v.scrollTop = Math.round((v.scrollHeight - v.clientHeight) * 0.4);
});
await settle(80);
const keptBefore = (await geom()).st;
await hide();
await show(true); // 手动态走 resync：还原阅读位置
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
