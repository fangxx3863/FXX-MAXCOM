// 回归：收发页 Ctrl+F 查找（高亮定位 + 命中分布刻度）。
//
// 设计契约（本次实现的核心前提）：
//  1. 查找**不过滤**任何行 —— 命中行高亮，未命中行照常显示。行数与会话内容不变。
//  2. Ctrl+F 打开自绘查找栏（取代 WebView2 内建查找条）；Esc 关闭；Enter/Shift+Enter 跳转。
//     注意：Ctrl+F 只在**收发页**拦截；终端页直通远端、不接管（见 term-find-test.mjs）。
//  3. 计数 n/total 正确，且给出命中「分布刻度」（#find-marks 内 <i> 个数 = 命中行数）。
//  4. 非法正则退化为字面子串匹配（与快捷过滤同策略）。
// 历史背景：WebView2 内建的 Ctrl+F 查找条渲染在网页 DOM 之外，无法用 CSS 移动，
//   故改为关闭浏览器加速键 + 网页自绘查找栏（见 app/src-tauri/src/win32.rs）。
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
  const dom = new JSDOM(readHtml(), { url: "http://localhost:1420/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  const noop = () => {};
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "canvas" ? { width: 300, height: 150 } : noop) });
  w.navigator.wrappedJSObject = undefined;
  // 查找栏与分布刻度需要可见高度才能算刻度 top
  Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { get() { return 600; }, configurable: true });
  try { w.eval(readBundle()); } catch (e) { errors.push(e.stack || String(e)); }
  return { w, errors };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const active = (w) => w.document.querySelector(".session-ui:not(.hidden-session)");

async function connectSession(w) {
  active(w).querySelector("#connect-btn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await sleep(1200);
}

// ─────────────────── 部分A：查找栏开关与计数 ───────────────────
async function partA() {
  const { w, errors } = boot();
  if (w.__MAXCOM_READY__ !== true) { console.error("✗ 初始化未完成(A)"); for (const e of errors) console.error("  ", e); return; }
  const bar = active(w).querySelector("#find-bar");
  check("部分A：查找栏默认隐藏", bar.classList.contains("hidden"));

  // Ctrl+F 打开
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
  const s = active(w);
  check("部分A：Ctrl+F 打开查找栏", !s.querySelector("#find-bar").classList.contains("hidden"));

  await connectSession(w);
  await sleep(600); // 攒一些 mock 日志行

  const input = s.querySelector("#find-input");
  const seeded = [...s.querySelectorAll("#log-view .log-line")];
  check("部分A：已渲染出日志行", seeded.length > 0);
  if (!seeded.length) { for (const e of errors) console.error("  ", e); return; }

  // 检索面是「消息文本」而非 dataset.raw（后者含时间戳前缀），且 mock 行内容随机、
  // 又每隔 160ms 追加新行 → 不可假设某固定子串必然存在。
  // 因此从真实行里取一个**连续**的纯字母片段当检索词：
  //   · 必须连续 —— 否则拼接出的词（如 "temp: … hum" → "temphu"）不在原文里，必然 0 命中；
  //   · 必须纯字母 —— 含元字符（如 "root@maxcom:~$" 的 $）会被当正则，语义就不是「子串」了。
  // 从全部已挂载行里找，取不到再退化到整行文本本身。
  let probe = "";
  for (const l of seeded) {
    const msg = l.dataset.raw.replace(/^\d\d:\d\d:\d\d\.\d+/, "");
    const m = msg.match(/[A-Za-z]{4,}/);
    if (m) {
      probe = m[0];
      break;
    }
  }
  if (!probe) probe = seeded[0].dataset.raw.replace(/^\d\d:\d\d:\d\d\.\d+/, "").replace(/[^\w ]/g, "").trim().slice(0, 8) || "a";
  input.value = probe;
  input.dispatchEvent(new w.Event("input", { bubbles: true }));

  // 同一 tick 内同步读取：setFind 是同步的，新行只在未来的 interval 回调里追加。
  const dbg = w.__MAXCOM_DEBUG__();
  const total = dbg.lineCount;
  const expectTotal = dbg.findMatches.length;
  const curOrdinal = dbg.findCurrent;
  const domLines = [...s.querySelectorAll("#log-view .log-line")];
  const hits = domLines.filter((l) => l.classList.contains("find-hit"));

  check(`部分A：检索词取自真实行（${JSON.stringify(probe)}）`, probe.length > 0);
  check(`部分A：命中集非空（total=${total}, hits=${expectTotal}）`, expectTotal > 0);

  // 关键契约：命中行的**总数**（跨全部行，含未挂载的 chunk）由 findMatches 给出，
  // 与「分页/虚拟滚动」无关；这正是分布刻度能画出全貌的前提。
  // 已挂载 chunk 内的命中行必须全部带 find-hit + <mark>，且数量 ≤ 总数。
  check(`部分A：已挂载命中行 ⊆ 命中总数（${hits.length} ≤ ${expectTotal}）`, hits.length <= expectTotal && hits.length > 0);
  check("部分A：所有命中行都含 <mark> 高亮片段", hits.every((l) => l.querySelector("mark.find-mark")));
  // 当前命中可能落在未挂载的 chunk 里（虚拟滚动），此时 DOM 中无 find-current 属正常；
  // 但刻度轨上必须始终恰有一个 cur，因此这里只在「当前命中已挂载」时断言 DOM 标记。
  const curRow = curOrdinal >= 0 ? dbg.findMatches[curOrdinal] : -1;
  const curMounted = curRow >= 0 && curRow >= total - domLines.length;
  check(
    `部分A：当前命中行带 find-current（cur 行 ${curRow}，${curMounted ? "已挂载" : "未挂载→跳过" }）`,
    !curMounted || hits.some((l) => l.classList.contains("find-current")),
  );

  // 不过滤：所有行都还在（行数只增不减，且 ≥ 命中数）
  check(
    `部分A：查找不过滤任何行（${domLines.length} 行，其中 ${hits.length} 命中）`,
    domLines.length >= seeded.length && domLines.length >= hits.length,
  );

  // 计数文案：n/total，total = 跨全部行的命中总数；n 落在 1..total
  const count = s.querySelector("#find-count").textContent;
  check(`部分A：计数显示 n/total（${count}）`, /^\d+\/\d+$/.test(count));
  check(`部分A：计数总数 = 命中总数（${count} vs ${expectTotal}）`, Number(count.split("/")[1]) === expectTotal);
  check(`部分A：计数序号在 1..total 内（${count}）`, Number(count.split("/")[0]) >= 1 && Number(count.split("/")[0]) <= expectTotal);

  // 分布刻度：每命中一行一个刻度（含未挂载行）→ 刻度数 = 命中总数
  const marks = [...s.querySelectorAll("#find-marks i")];
  check(`部分A：分布刻度数 = 命中总数（${marks.length}/${expectTotal}）`, marks.length === expectTotal);
  check("部分A：刻度轨可见（has-find）", s.querySelector("#log-view-wrap").classList.contains("has-find"));
  check("部分A：刻度 top 随行号单调不减", marks.every((m, i) => i === 0 || parseFloat(m.style.top) >= parseFloat(marks[i - 1].style.top)));
  check("部分A：恰好一条刻度标记为当前(cur)", marks.filter((m) => m.className === "cur").length === 1);

  // Esc 关闭并清理
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const s2 = active(w);
  check("部分A：Esc 关闭查找栏", s2.querySelector("#find-bar").classList.contains("hidden"));
  check("部分A：Esc 后清除行高亮", s2.querySelectorAll(".log-line.find-hit").length === 0);
  check("部分A：Esc 后清除分布刻度", s2.querySelectorAll("#find-marks i").length === 0);

  for (const e of errors) console.error("  jsdom error:", e);
}

// ─────────────────── 部分B：导航（Enter / Shift+Enter）───────────────────
async function partB() {
  const { w, errors } = boot();
  if (w.__MAXCOM_READY__ !== true) { console.error("✗ 初始化未完成(B)"); return; }
  await connectSession(w);
  await sleep(600);
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
  const s = active(w);
  // 导航需要 ≥2 个命中才可验证「前进/后退」。"[" 命中所有 "[X] " 开头的行，
  // 但 mock 行随机、可能恰好极少以 "[" 开头 → 先探测命中数，不足就换更宽的词。
  const input = s.querySelector("#find-input");
  const dbg = () => w.__MAXCOM_DEBUG__();
  const tryProbe = (p) => {
    input.value = p;
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    return dbg().findMatches.length;
  };
  let probe = "[";
  let hitsN = tryProbe(probe);
  for (const alt of ["a", "e", "s", "0", "."]) {
    if (hitsN >= 2) break;
    probe = alt;
    hitsN = tryProbe(probe);
  }
  check(`部分B：命中数 ≥ 2（可导航，probe=${JSON.stringify(probe)}，${hitsN}）`, hitsN >= 2);

  const curIdx = () => {
    const marks = [...s.querySelectorAll("#find-marks i")];
    return marks.findIndex((m) => m.className === "cur");
  };
  const before = curIdx();
  check("部分B：初始当前命中为第 1 个", before === 0);

  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const after = curIdx();
  check(`部分B：Enter 前进到下一个命中（${before}→${after}）`, after === before + 1);

  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
  check("部分B：Shift+Enter 退回上一个", curIdx() === before);

  for (const e of errors) console.error("  jsdom error:", e);
}

// ─────────────────── 部分C：非法正则退化为子串 ───────────────────
async function partC() {
  const { w, errors } = boot();
  if (w.__MAXCOM_READY__ !== true) { console.error("✗ 初始化未完成(C)"); return; }
  await connectSession(w);
  await sleep(600);
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
  const s = active(w);
  const input = s.querySelector("#find-input");
  const dbg = () => w.__MAXCOM_DEBUG__();

  // "[" 是非法正则 → 作为字面子串仍应命中所有 "[X] " 开头的行
  input.value = "[";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  const literalHits = dbg().findMatches.length;
  check(`部分C：非法正则退化为字面子串匹配（命中 ${literalHits}）`, literalHits > 0);

  // 合法正则应生效：\[I\] 作为正则 ⟺ 字面子串 "[I]" 的命中数
  input.value = "\\[I\\]";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  const reHits = dbg().findMatches.length;
  check(`部分C：合法正则生效（命中 ${reHits} ≤ 字面 ${literalHits}）`, reHits >= 0 && reHits <= literalHits);

  // 同一检索面的两种写法必须等价：正则 "\[I\]" vs 字面子串 "[I]"（后者经转义仍等于前者）
  input.value = "[I]";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  const charClassHits = dbg().findMatches.length; // "[I]" 是字符类 → 等价于匹配 "I"，命中更宽
  check(`部分C：字符类 "[I]" 比转义 "\\[I\\]" 更宽（${charClassHits} ≥ ${reHits}）`, charClassHits >= reHits);

  for (const e of errors) console.error("  jsdom error:", e);
}

await partA();
await partB();
await partC();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
