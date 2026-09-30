// 回归：连接按钮状态机（ADR-0020）。
//
// 覆盖三处实测痛点：
//   1) 点「连接」后主界面不再卡死——按钮**立刻**变「取消 + 转圈」，再点一次即中止，
//      不必等握手超时（引擎侧非阻塞语义见 crates/maxcom-engine/tests/session_loopback.rs
//      的 begin_connect_returns_immediately_and_broadcasts_connecting_first /
//      cancel_connect_aborts_pending_attempt）；
//   2) 自动重连必须可见可取消（reconnecting 阶段 + 尝试次数）；
//   3) 顶栏指示灯与标签页圆点**永远同色**——修掉「顶栏红点、右侧灰点」的不一致。
//
// 验证思路：eval 构建产物 + 演示后端（mock 握手 350ms 便于观察中间态），
// 用 window.__maxcomMockState 注入 reconnecting / failed 状态覆盖分支。
import { readFileSync, readdirSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";

let pass = 0,
  fail = 0;
const check = (name, cond) => {
  console.log((cond ? "✓ " : "✗ ") + name);
  cond ? pass++ : fail++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readHtml = () => readFileSync("dist/index.html", "utf8").replace(/<script[^>]*><\/script>/g, "");
const findBundle = () => readdirSync("dist/assets").find((f) => f.startsWith("index-") && f.endsWith(".js"));
const readBundle = () => {
  const asset = findBundle();
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
  // alert 会阻塞 jsdom：参数非法路径（如未选串口）用它提示，这里降级为记录
  const alerts = [];
  w.alert = (m) => alerts.push(String(m));
  try {
    w.eval(readBundle());
  } catch (e) {
    errors.push(e.stack || String(e));
  }
  return { w, errors, alerts };
}

// 文案随语言切换，断言按集合匹配（jsdom 默认 en-US）
const L = {
  connect: ["连接", "Connect"],
  cancel: ["取消", "Cancel"],
  disconnect: ["断开", "Disconnect"],
};
const inSet = (txt, set) => set.includes((txt ?? "").trim());

const { w, errors, alerts } = boot();
if (w.__MAXCOM_READY__ !== true) {
  console.error("✗ 前端初始化未完成");
  for (const e of errors) console.error("  ", e);
  process.exit(1);
}

const visible = () => w.document.querySelector(".session-ui:not(.hidden-session)");
const btn = () => visible()?.querySelector("#connect-btn");
const dot = () => visible()?.querySelector("#conn-state");
const sbState = () => visible()?.querySelector("#sb-state");
const tabDot = () => w.document.querySelector("#tabstrip .tab.active .tab-dot") ?? w.document.querySelector("#tabstrip .tab .tab-dot");
const mock = w.__maxcomMockState;
const emitAll = (state) => {
  for (const sid of mock?.sessions?.() ?? []) mock.emitState(sid, state);
};

check("演示后端注入口可用", !!mock && typeof mock.emitState === "function");
check("顶栏连接按钮存在", !!btn());
check("初始按钮为「连接」", inSet(btn()?.textContent, L.connect));
check("初始指示灯未点亮", !dot()?.classList.contains("on") && !dot()?.classList.contains("busy"));

// ── 1. 点连接：立刻「取消 + 转圈」，无需等待建立过程 ──
btn().click();
await sleep(50); // 仅等一个微任务/宏任务节拍（握手 mock 350ms）
check("点击后按钮立刻变「取消」", inSet(btn()?.textContent, L.cancel));
check("按钮带 busy（转圈指示）", btn()?.classList.contains("busy"));
check("顶栏指示灯 busy（脉冲）", dot()?.classList.contains("busy"));
check("标签页圆点与顶栏一致（busy）", tabDot()?.classList.contains("busy"));

// ── 2. 再点一次 = 取消，不必等握手超时 ──
btn().click();
await sleep(60);
check("取消后按钮回到「连接」", inSet(btn()?.textContent, L.connect));
check("取消后按钮退出 busy", !btn()?.classList.contains("busy"));
check("取消后指示灯回到未连接", !dot()?.classList.contains("on") && !dot()?.classList.contains("busy"));

// 迟到的握手成功必须被丢弃（否则会出现「取消完却又连上了」）
await sleep(420);
check("取消后迟到的成功被丢弃（未连接）", inSet(btn()?.textContent, L.connect) && !dot()?.classList.contains("on"));

// ── 3. 正常连接成功 → 断开 ──
btn().click();
await sleep(520);
check("连接成功 → 按钮变「断开」", inSet(btn()?.textContent, L.disconnect));
check("连接成功 → 指示灯 on", dot()?.classList.contains("on"));
check("连接成功 → 标签页圆点同色（on）", tabDot()?.classList.contains("on"));

// ── 4. 掉线自动重连：可见（含次数）+ 可取消，圆点两处一致 ──
emitAll({ connected: false, label: "", phase: "reconnecting", attempt: 3, error: "device unplugged" });
await sleep(30);
check("重连中按钮为「取消」", inSet(btn()?.textContent, L.cancel));
check("重连中按钮带 busy", btn()?.classList.contains("busy"));
check("重连中顶栏 busy", dot()?.classList.contains("busy"));
check("重连中标签页圆点 busy（不再顶部脉冲/右侧灰点）", tabDot()?.classList.contains("busy"));
check("状态栏显示重连尝试次数", (sbState()?.textContent ?? "").includes("3"));

// 用户不希望继续重连 → 点「取消」即可中止
btn().click();
await sleep(60);
check("取消重连后按钮回到「连接」", inSet(btn()?.textContent, L.connect));
check("取消重连后指示灯不再 busy/on", !dot()?.classList.contains("busy") && !dot()?.classList.contains("on"));
await sleep(120);
check("取消重连后保持未连接（不再自动重连）", !dot()?.classList.contains("busy") && !dot()?.classList.contains("on"));

// ── 5. 连接失败：顶栏与标签页同为红点 ──
emitAll({ connected: false, label: "", phase: "failed", error: "handshake timeout" });
await sleep(30);
check("失败 → 顶栏指示灯 err", dot()?.classList.contains("err"));
check("失败 → 标签页圆点 err（与顶栏一致）", tabDot()?.classList.contains("err"));
check("失败 → 连接标签显示原因", (visible()?.querySelector("#conn-label")?.textContent ?? "").includes("handshake timeout"));
check("失败 → 按钮仍为「连接」（可直接重试）", inSet(btn()?.textContent, L.connect));

// ── 6. 失败后重新连接必须能直接成功（不再需要「点一下看报错」来复位）──
btn().click();
await sleep(520);
check("失败后可直接重连成功", dot()?.classList.contains("on") && inSet(btn()?.textContent, L.disconnect));
check("重连成功后错误文案清除", !(visible()?.querySelector("#conn-label")?.classList.contains("bad") ?? true));

if (alerts.length) console.log("  （alert 记录：", alerts.join(" | "), "）");
for (const e of errors) console.error("  jsdom error:", e);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
