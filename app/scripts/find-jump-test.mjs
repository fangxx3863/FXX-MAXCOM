// 回归（真实浏览器）：收发页查找「向前/向后跳转」必须把当前命中行滚进视口。
//
// 为什么必须用真实浏览器而不是 jsdom：
//   本测试针对的是一个**布局几何**缺陷 —— 目标位置由 DOM 的 offset/rect 算出，
//   而 jsdom 不做布局（offsetTop/offsetHeight/scrollHeight 全是 0 或需自行桩），
//   桩出来的理想等高几何会让「chunk.offsetTop + line.offsetTop 重复累加」这个
//   错误恰好抵消，从而假绿。实测：同一份代码在 jsdom 探针下 10/10 通过，
//   在真实浏览器下只有 13/25 通过。因此这里起静态服务 + chromium 真跑。
//
// 缺陷回顾（2026-10）：`.log-chunk` 是 position:static，`.log-line` 的 offsetTop
//   并不相对 chunk；旧代码 `chunkTop + line.offsetTop` 把偏移算了两遍。chunk 0 时
//   chunkTop≈0 看不出问题，跨到后面的 chunk 就翻倍偏下，命中行被丢在视口上方 ——
//   正是「从后往前跳转时定位不到行」。
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

// 浏览器缺失时**跳过**而非失败：本机有 Chrome/内置 chromium 就跑真实验证；
// CI（尤其是 ubuntu-latest 且未装浏览器）没有可用二进制时不要让整条 build 链失败。
// 跳过会明确打印告警，避免「静默失效」被误当成通过。
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
} catch {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    console.warn("⚠ 未找到可用浏览器，跳过真实浏览器跳转回归：" + (e?.message || e));
    console.warn("  （该用例专门覆盖布局几何缺陷，jsdom 无法替代；请在装有 Chrome/Chromium 的环境跑）");
    server.close();
    process.exit(0);
  }
}
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
await page.waitForFunction(() => window.__MAXCOM_READY__ === true, null, { timeout: 20000 });

// 压小「每页行数」→ 用少量行就能造出多个 chunk，真正启用懒加载窗口
await page.evaluate(() => {
  const el = document.querySelector("#set-log-page-rows");
  el.value = "20";
  el.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.evaluate(() => {
  document
    .querySelector(".session-ui:not(.hidden-session) #sidebar button[data-page='logview']")
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
});

// 连接攒日志 → 断开，避免 pump 继续追加干扰断言
await page.click("#connect-btn");
await page.waitForTimeout(26000);
await page.click("#connect-btn");
await page.waitForTimeout(400);

const setup = await page.evaluate(() => {
  const view = document.querySelector(".session-ui:not(.hidden-session) #log-view");
  const chunks = [...view.children].filter((c) => c.dataset.chunk !== undefined);
  let word = null;
  for (const r of view.querySelectorAll(".log-line")) {
    const m = (r.dataset.raw || r.textContent || "").match(/[A-Za-z]{4,}/);
    if (m) { word = m[0]; break; }
  }
  return { lines: window.__MAXCOM_DEBUG__().lineCount, chunks: chunks.length, word };
});
check(`真实浏览器：日志已积累（${setup.lines} 行 / ${setup.chunks} chunk）`, setup.lines > 60);
check(`真实浏览器：懒加载已启用（≥3 chunk，每页 20 行）`, setup.chunks >= 3);
check("真实浏览器：找到可用检索词", !!setup.word);

// 走真实入口：Ctrl+F 打开查找栏（否则 refreshFindUi 因 findOpen=false 不渲染刻度），
// 再在输入框里敲词
await page.evaluate(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(80);
const opened = await page.evaluate(() => window.__MAXCOM_DEBUG__().findOpen);
check("真实浏览器：Ctrl+F 打开查找栏", opened === true);

await page.evaluate((w) => {
  const input = document.querySelector("#find-input");
  input.value = w;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}, setup.word);
await page.waitForTimeout(150);

const found = await page.evaluate(() => {
  const d = window.__MAXCOM_DEBUG__();
  return { hits: d.findMatches.length, marks: document.querySelectorAll("#find-marks i").length };
});
check(`真实浏览器：检索命中（${found.hits} 处）`, found.hits >= 2);
check(`真实浏览器：分布刻度已渲染（${found.marks} 个）`, found.marks === found.hits);

// 核心断言：反复向前跳，每一步当前命中行都必须在视口内
const probe = async (dir) => {
  return page.evaluate((d) => {
    const sel = d > 0 ? "#find-next" : "#find-prev";
    document.querySelector(sel).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const info = window.__MAXCOM_DEBUG__();
    const view = document.querySelector(".session-ui:not(.hidden-session) #log-view");
    const cur = document.querySelector("#log-view .log-line.find-current");
    if (!cur) return { ok: false, reason: "当前命中行不在 DOM", cur: info.findCurrent };
    const cr = cur.getBoundingClientRect();
    const vr = view.getBoundingClientRect();
    const visible = cr.bottom > vr.top && cr.top < vr.bottom;
    return {
      ok: visible, cur: info.findCurrent,
      reason: visible ? "可见" : cr.top < vr.top ? "在视口上方" : "在视口下方",
    };
  }, dir);
};

const back = [];
for (let i = 0; i < 20; i++) back.push(await probe(-1));
const backBad = back.filter((r) => !r.ok);
check(`真实浏览器：连续向后跳 20 次，当前行始终可见（失败 ${backBad.length} 次）`, backBad.length === 0);
if (backBad.length) console.log("   失败样本:", JSON.stringify(backBad.slice(0, 5)));

const fwd = [];
for (let i = 0; i < 20; i++) fwd.push(await probe(1));
const fwdBad = fwd.filter((r) => !r.ok);
check(`真实浏览器：连续向前跳 20 次，当前行始终可见（失败 ${fwdBad.length} 次）`, fwdBad.length === 0);
if (fwdBad.length) console.log("   失败样本:", JSON.stringify(fwdBad.slice(0, 5)));

check("真实浏览器：跳转过程无页面异常", pageErrors.length === 0);
for (const e of pageErrors) console.error("  pageerror:", e);

await browser.close();
server.close();
check(`${pass}/${pass + fail} 断言通过`, fail === 0);
process.exit(fail ? 1 : 0);
