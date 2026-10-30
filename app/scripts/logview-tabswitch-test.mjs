// 回归（真实浏览器）：切标签页 / 切页面回来，收发区必须回到「该在的位置」。
//
// 缺陷回顾（2026-10，用户现场）：开着「自动滚动」切到别的标签页（或别的页），回来时停在半路，
// 既不贴底也看不到最新数据。根因是 display:none 期间 clientHeight 为 0 —— 贴底只能算出 0，
// 懒加载窗口也空转；隐藏期写入的 scrollTop 不生效，隐藏前的旧值又已不代表新内容。
// 修复后：视图重新可见时重测高度并贴底（勾着跟随）或还原阅读位置（手动滚动态）。
//
// 关键：每个场景都在「切回来之前把数据停掉」。数据还在流时，普通 append 的贴底会把缺陷盖住
// （新行一到就又贴上了），用户现场正是"数据一停、视图就露馅"——那才是必须断言的状态。
//
// 为什么必须真实浏览器：jsdom 不做布局、也没有 display:none 的滚动几何语义，桩不出来。
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright-core";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "✓ " : "✗ ") + name + (extra ? `  ${extra}` : ""));
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

let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
} catch {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    console.warn("⚠ 未找到可用浏览器，跳过切标签页回归：" + (e?.message || e));
    server.close();
    process.exit(0);
  }
}

const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
await page.waitForFunction(() => window.__MAXCOM_READY__ === true, null, { timeout: 20000 });

const SEL = ".session-ui:not(.hidden-session) #log-view";
const measure = () =>
  page.evaluate((sel) => {
    const view = document.querySelector(sel);
    if (!view) return null;
    const vr = view.getBoundingClientRect();
    const lines = [...view.querySelectorAll(".log-line")];
    const visible = lines.filter((l) => {
      const r = l.getBoundingClientRect();
      return r.bottom > vr.top + 1 && r.top < vr.bottom - 1;
    }).length;
    return {
      st: Math.round(view.scrollTop),
      max: Math.round(view.scrollHeight - view.clientHeight),
      ch: view.clientHeight,
      visible,
      lines: window.__MAXCOM_DEBUG__().lineCount,
      lastBottom: (() => {
        const last = lines[lines.length - 1];
        if (!last) return null;
        return Math.round(last.getBoundingClientRect().bottom - vr.top);
      })(),
    };
  }, SEL);
const atBottom = (m) => Math.abs(m.st - m.max) <= 1;
const lastLineVisible = (m) => m.lastBottom !== null && m.lastBottom <= m.ch + 1 && m.lastBottom > 0;
const clickPage = (id) =>
  page.evaluate((id) => {
    document
      .querySelector(`.session-ui:not(.hidden-session) #sidebar button[data-page='${id}']`)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, id);
const setSticky = (on) =>
  page.evaluate((on) => {
    const el = document.querySelector(".session-ui:not(.hidden-session) #autoscroll");
    el.checked = on;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, on);
/** 停掉数据：点掉所有「已连接」会话（含隐藏会话）的断开按钮 —— 演示后端随即停止 pump。
 *  `.danger` 是 renderConnUI 给「已连接」按钮打的类，不会误点成"连接"。 */
const stopData = () =>
  page.evaluate(() => {
    document.querySelectorAll(".session-ui #connect-btn.danger").forEach((b) =>
      b.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
  });
const clickTab = (idx) =>
  page.evaluate((idx) => {
    const tabs = document.querySelectorAll(".tab[data-session-id]");
    tabs[idx].dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, idx);
const closeLastTab = () =>
  page.evaluate(() => {
    const tabs = document.querySelectorAll(".tab[data-session-id]");
    tabs[tabs.length - 1].querySelector(".tab-close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

// ── 准备：收发页 + 连接（演示后端约 160ms 一行）──
await clickPage("logview");
await page.click("#connect-btn");
// 攒够「内容高于视口」的行数，贴底断言才有意义
await page.waitForTimeout(5200);
let m = await measure();
check(`已积累日志（${m.lines} 行，内容高于视口）`, m.lines > 20 && m.max > 0);
check("连接后自动滚动贴底", atBottom(m), `scrollTop=${m.st} max=${m.max}`);
check("贴底时末行可见", lastLineVisible(m), `lastBottom=${m.lastBottom} ch=${m.ch}`);

// ── A. 切到别的页面（隐藏）→ 数据继续到达 → 停数据 → 切回来必须贴底 ──
const beforeHide = (await measure()).lines;
await clickPage("terminal");
await page.waitForTimeout(2600);
await stopData();
await page.waitForTimeout(400);
await clickPage("logview");
await page.waitForTimeout(450);
m = await measure();
check(`切页面回来贴底（隐藏期新增 ${m.lines - beforeHide} 行）`, atBottom(m), `scrollTop=${m.st} max=${m.max}`);
check("切页面回来末行可见", lastLineVisible(m), `lastBottom=${m.lastBottom} ch=${m.ch}`);

// ── B. 切到别的标签页（另一会话，原会话整块 display:none）→ 同上 ──
await page.click("#connect-btn"); // 重新连上，继续攒数据
await page.waitForTimeout(4200);
await page.click("#tab-new"); // 新标签页接管前台，原会话隐藏但仍在收数据
await page.waitForTimeout(2600);
await stopData();
await page.waitForTimeout(400);
await clickTab(0);
await page.waitForTimeout(450);
m = await measure();
check("切标签页回来贴底", atBottom(m), `scrollTop=${m.st} max=${m.max}`);
check("切标签页回来末行可见", lastLineVisible(m), `lastBottom=${m.lastBottom} ch=${m.ch}`);
await closeLastTab();
await page.waitForTimeout(300);

// ── C. 关掉自动滚动：切页面/切标签页都必须守住阅读位置（不跳底、也不跳顶）──
await setSticky(false);
await page.evaluate((sel) => {
  const v = document.querySelector(sel);
  v.scrollTop = Math.round((v.scrollHeight - v.clientHeight) * 0.35);
}, SEL);
await page.waitForTimeout(200);
const kept = (await measure()).st;
await clickPage("terminal");
await page.waitForTimeout(900);
await clickPage("logview");
await page.waitForTimeout(450);
m = await measure();
check(
  "手动滚动态切页面回来，阅读位置不被拽走",
  Math.abs(m.st - kept) <= 3 && !atBottom(m),
  `before=${kept} after=${m.st} max=${m.max}`,
);

await page.click("#connect-btn"); // 再连一次：隐藏期会有新数据到达，位置仍须守住
await page.waitForTimeout(2600);
await page.click("#tab-new");
await page.waitForTimeout(2600);
await stopData();
await page.waitForTimeout(400);
await clickTab(0);
await page.waitForTimeout(450);
m = await measure();
check(
  "手动滚动态切标签页回来，阅读位置不被拽走",
  Math.abs(m.st - kept) <= 3 && !atBottom(m),
  `before=${kept} after=${m.st} max=${m.max}`,
);
await closeLastTab();
await page.waitForTimeout(300);

// ── D. 重新勾上自动滚动 → 立刻回到底部（并保持住）──
await setSticky(true);
await page.waitForTimeout(600);
m = await measure();
check("重新勾选后贴底", atBottom(m), `scrollTop=${m.st} max=${m.max}`);
await page.click("#connect-btn");
await page.waitForTimeout(1200);
m = await measure();
check("持续数据下仍贴底", atBottom(m), `scrollTop=${m.st} max=${m.max}`);

check("全程无页面异常", pageErrors.length === 0);
for (const e of pageErrors) console.error("  pageerror:", e);

await browser.close();
server.close();
console.log(`\n结果: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
