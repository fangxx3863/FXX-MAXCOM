// 回归：收发模式的「本地回显」开关（终端已有同名开关，这里补齐收发模式）。
// 引擎侧行为见 crates/maxcom-engine/tests/session_loopback.rs 的
// local_echo_shows_sent_text_when_device_silent / log_entry_direction_distinguishes_rx_from_local_echo；
// 本脚本覆盖前端接线：
//   1) 发送控制条存在 #local-echo，默认关闭，标签已本地化；
//   2) 勾选后随标签快照落盘（maxcom.tabs.v2），重开可恢复；
//   3) 设置页「收发方向标记」开关默认开，且可见性 = 设置开关 ∧ 本地回显：
//      回显关闭时一行标记都没有（日志里全是接收行，标了也没信息量），
//      回显打开后接收行标 ←、本机发送行标 →（端到端：走真实发送路径）。
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

  // ── 设置页：方向标记开关（默认开）──
  const ui = () => w.document.querySelector(".session-ui:not(.hidden-session)");
  const dirMark = () => w.document.querySelector(".session-ui #set-log-dir-mark");
  check("设置页存在方向标记开关 #set-log-dir-mark", !!dirMark());
  check("方向标记默认开启", dirMark()?.checked === true);
  const dmLabel = dirMark()?.closest(".set-field")?.textContent?.trim() ?? "";
  check("方向标记标签已本地化", dmLabel.length > 0 && !dmLabel.includes("settings.logDirMark"));

  // ── 端到端：标记可见性 = 设置开关 ∧ 本地回显 ──
  const marks = () => [...(ui()?.querySelectorAll("#log-view .log-dir") ?? [])];
  const lines = () => [...(ui()?.querySelectorAll("#log-view .log-line") ?? [])];
  const rowWith = (s) => lines().find((l) => l.textContent.includes(s));
  const waitFor = async (cond, ms = 2500) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (cond()) return true;
      await sleep(50);
    }
    return cond();
  };
  const send = async (value) => {
    const input = ui()?.querySelector("#send-input");
    input.value = value;
    ui()?.querySelector("#send-btn").click();
    await sleep(120);
  };

  // 连上演示后端（握手约 350ms），pump 每 160ms 追加接收行
  ui()?.querySelector("#connect-btn").click();
  check("演示后端已连上且收到接收行", await waitFor(() => lines().length > 0, 4000));
  check("回显关闭时不标方向（无 ←/→）", marks().length === 0 && !ui()?.querySelector(".log-dir"));

  // 回显关闭时发送：设备回读才算接收行，本机不回显 → 不该多出 tx 行
  await send("TX-OFF-PROBE");
  check("回显关闭时发送不产生发送行", !rowWith("TX-OFF-PROBE"));

  // 打开本地回显 → 标记出现（pump 的接收行标 ←）
  echo.checked = true;
  echo.dispatchEvent(new w.Event("change", { bubbles: true }));
  check("回显打开后接收行标 ←", await waitFor(() => marks().some((m) => m.dataset.dir === "rx" && m.textContent === "←")));

  // 回显打开时发送：走真实发送路径（#send-btn → api.send(echo) → 条目 dir=tx）
  await send("TX-MARK-PROBE");
  check(
    "回显打开后发送行标 →（内容与方向都对）",
    await waitFor(() => {
      const row = rowWith("TX-MARK-PROBE");
      return !!row && row.querySelector(".log-dir")?.dataset.dir === "tx";
    }),
  );

  // 设置开关关掉 → 标记立即全消失；再打开 → 回来（同一份数据，纯渲染层）
  dirMark().checked = false;
  dirMark().dispatchEvent(new w.Event("change", { bubbles: true }));
  await sleep(60);
  check("设置开关关闭后标记消失", marks().length === 0 && lines().length > 0);
  check("设置开关关闭不影响已收到的行数", !!rowWith("TX-MARK-PROBE"));
  dirMark().checked = true;
  dirMark().dispatchEvent(new w.Event("change", { bubbles: true }));
  await sleep(60);
  check("设置开关重新打开后标记回来", marks().length > 0);

  // 标签快照轮询周期 1200ms，多等一拍确保落盘
  await sleep(1600);
  const store = JSON.parse(w.localStorage.getItem(TABS_KEY) ?? "null");
  const snap = store?.tabs?.[0]?.snap ?? {};
  check("勾选后随标签快照落盘(localecho=1)", snap.localecho === "1");
}

for (const e of errors) console.error("  jsdom error:", e);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);