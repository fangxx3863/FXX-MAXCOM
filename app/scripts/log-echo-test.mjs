// 回归：收发模式的「本地回显」开关（终端已有同名开关，这里补齐收发模式）。
// 引擎侧行为见 crates/maxcom-engine/tests/session_loopback.rs 的
// local_echo_shows_sent_text_when_device_silent；本脚本只覆盖前端接线：
//   1) 发送控制条存在 #local-echo，默认关闭，标签已本地化；
//   2) 勾选后随标签快照落盘（maxcom.tabs.v2），重开可恢复。
// 验证思路：eval 构建产物（同 explode-test.mjs 的 boot 桩）。
import { readFileSync, readdirSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";

let pass = 0, fail = 0;
const check = (name, cond) => {
  console.log((cond ? "✓ " : "✗ ") + name);
  cond ? pass++ : fail++;
};

const TABS_KEY = "maxcom.tabs.v2";
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
  const dom = new JSDOM(readHtml(), { url: "http://localhost:1420/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  const noop = () => {};
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "canvas" ? { width: 300, height: 150 } : noop) });
  w.navigator.wrappedJSObject = undefined;
  try { w.eval(readBundle()); } catch (e) { errors.push(e.stack || String(e)); }
  return { w, errors };
}

const { w, errors } = boot();
if (w.__MAXCOM_READY__ !== true) {
  console.error("✗ 前端初始化未完成");
  for (const e of errors) console.error("  ", e);
  process.exit(1);
}

const echo = w.document.querySelector(".session-ui #local-echo");
check("发送控制条存在 #local-echo", !!echo);

if (echo) {
  check("默认关闭", echo.checked === false);
  const text = echo.closest("label")?.textContent?.trim() ?? "";
  check("标签已本地化（非原始 i18n key）", text.length > 0 && !text.includes("log.localEcho"));

  echo.checked = true;
  echo.dispatchEvent(new w.Event("change", { bubbles: true }));

  // 标签快照轮询周期 1200ms，多等一拍确保落盘
  await sleep(1600);
  const store = JSON.parse(w.localStorage.getItem(TABS_KEY) ?? "null");
  const snap = store?.tabs?.[0]?.snap ?? {};
  check("勾选后随标签快照落盘(localecho=1)", snap.localecho === "1");
}

for (const e of errors) console.error("  jsdom error:", e);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);