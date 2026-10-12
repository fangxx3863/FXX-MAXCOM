// 回归：设置页「AI 接入（MCP）」卡片接线。
//
// 覆盖：
//  - 部分A 默认态：卡片可见、端点填入、开关勾选、状态行三态类名正确
//  - 部分B 开关联动：改开关 → 持久化到 settings + 状态行/端点即时更新
//  - 部分C 复制：点「复制」把端点写进剪贴板，按钮短暂变「已复制」
//  - 部分D 多标签页广播：新建标签页卡片立即就绪；在任一页改动都同步到所有页
//  - 部分E 恢复默认：MCP 开关属功能设置，不被「恢复外观默认」重置
//
// 为什么用浏览器演示模式（与其它回归一致）：它走 api.ts 的 DEMO_MCP_STATUS 分支，
// 足以验证「DOM 接线 + 状态渲染」，而不必桩一整套 Tauri IPC。
// 真机路径（invoke mcp_status / mcp_set_enabled）由 src-tauri 编译检查 + MCP 侧
// 的 HTTP initialize 往返测试覆盖。
import { readFileSync, readdirSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";

let pass = 0, fail = 0;
const check = (name, cond) => {
  console.log((cond ? "✓ " : "✗ ") + name);
  cond ? pass++ : fail++;
};

const SETTINGS_KEY = "maxcom.settings";
const DEMO_ENDPOINT = "http://127.0.0.1:8765/mcp";

const readHtml = () => readFileSync("dist/index.html", "utf8").replace(/<script[^>]*><\/script>/g, "");
const readBundle = () => {
  const asset = readdirSync("dist/assets").find((f) => f.startsWith("index-") && f.endsWith(".js"));
  return readFileSync(`dist/assets/${asset}`, "utf8")
    .replaceAll("import.meta", "({ url: 'http://localhost/', env: {} })")
    .replace(/export\s*\{[^}]*\}\s*;?/g, "");
};

function boot(seedSettings) {
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
  if (seedSettings) w.localStorage.setItem(SETTINGS_KEY, JSON.stringify(seedSettings));
  try { w.eval(readBundle()); } catch (e) { errors.push(e.stack || String(e)); }
  return { w, errors };
}

/** 让启动期挂起的 microtask（MCP 状态同步）落地 */
const settle = (w, ms = 15) => new Promise((r) => w.setTimeout(r, ms));

/** 取所有标签页里的同一元素（每个标签页各克隆一份设置页 DOM） */
const all = (w, sel) => [...w.document.querySelectorAll(sel)];

function click(w, el) {
  el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
}

function setChecked(w, input, on) {
  input.checked = on;
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
}

async function main() {
  // ───────────────────────── 部分A：默认态 ─────────────────────────
  const { w, errors } = boot();
  if (w.__MAXCOM_READY__ !== true) {
    console.error("✗ 前端初始化未完成");
    for (const e of errors) console.error("  ", e);
    fail++;
    return;
  }
  await settle(w);

  const cards = all(w, "#set-mcp-card");
  check("设置页存在 MCP 卡片", cards.length === 1);
  check("卡片默认可见（平台支持时不加 hidden）", cards.length === 1 && !cards[0].classList.contains("hidden"));

  const enabled = all(w, "#set-mcp-enabled")[0];
  const endpoint = all(w, "#set-mcp-endpoint")[0];
  const status = all(w, "#set-mcp-status")[0];
  const copyBtn = all(w, "#set-mcp-copy")[0];
  check("端点输入框填入端点", endpoint?.value === DEMO_ENDPOINT);
  check("端点输入框只读（避免用户误改后复制到错的地址）", endpoint?.readOnly === true);
  check("开关默认勾选", enabled?.checked === true);
  check("状态行显示运行中态", status?.classList.contains("mcp-status-running") === true);
  check("状态行有文案", (status?.textContent ?? "").length > 0);
  check("状态行只带一个状态类", ["mcp-status-running", "mcp-status-off", "mcp-status-error"].filter((c) => status?.classList.contains(c)).length === 1);

  // ───────────────────────── 部分B：开关联动 ─────────────────────────
  setChecked(w, enabled, false);
  await settle(w);
  let saved = JSON.parse(w.localStorage.getItem(SETTINGS_KEY) ?? "{}");
  check("关闭开关持久化到 settings(mcpEnabled=false)", saved.mcpEnabled === false);
  check("关闭后状态行切到已关闭态", status.classList.contains("mcp-status-off"));
  check("关闭后仍显示端点（用户仍能据此配置/确认地址）", endpoint.value === DEMO_ENDPOINT);

  setChecked(w, enabled, true);
  await settle(w);
  saved = JSON.parse(w.localStorage.getItem(SETTINGS_KEY) ?? "{}");
  check("重新开启持久化(mcpEnabled=true)", saved.mcpEnabled === true);
  check("重新开启后状态行回到运行中态", status.classList.contains("mcp-status-running"));

  // ───────────────────────── 部分C：复制端点 ─────────────────────────
  let copied = null;
  Object.defineProperty(w.navigator, "clipboard", {
    configurable: true,
    value: { writeText: (v) => { copied = v; return Promise.resolve(); } },
  });
  click(w, copyBtn);
  await settle(w);
  check("点复制写入剪贴板的是端点", copied === DEMO_ENDPOINT);
  check("复制成功后按钮短暂变「已复制」", copyBtn.textContent.trim().length > 0 && copyBtn.textContent.trim() !== "复制");

  // ───────────────────────── 部分D：多标签页广播 ─────────────────────────
  click(w, w.document.querySelector("#tab-new"));
  await settle(w);
  const cards2 = all(w, "#set-mcp-card");
  check("新建标签页后每个标签页各有一张卡片", cards2.length === 2);
  const enabled2 = all(w, "#set-mcp-enabled");
  const status2 = all(w, "#set-mcp-status");
  check("新建标签页的卡片立即就绪（不必再打一次 IPC）", enabled2[1]?.checked === true && status2[1]?.classList.contains("mcp-status-running"));

  // 在第二个标签页关掉：第一个标签页必须同步
  setChecked(w, enabled2[1], false);
  await settle(w);
  check("任一标签页改动 → 所有标签页状态同步（第 1 页）", status2[0].classList.contains("mcp-status-off"));
  check("任一标签页改动 → 所有标签页状态同步（第 2 页）", status2[1].classList.contains("mcp-status-off"));
  check("任一标签页改动 → 所有标签页开关同步", enabled2[0].checked === false && enabled2[1].checked === false);

  // ───────────────────────── 部分E：恢复默认不重置 MCP 开关 ─────────────────────────
  click(w, all(w, "#set-reset")[0]);
  await settle(w);
  saved = JSON.parse(w.localStorage.getItem(SETTINGS_KEY) ?? "{}");
  check("「恢复默认」保留 MCP 开关（仍是关闭）", saved.mcpEnabled === false);
  check("「恢复默认」确实复位了外观项（logPageRows 回默认）", saved.logPageRows === 500);

  // ───────────────────────── 部分F：端口可改 + 冲突自增提示 ─────────────────────────
  const portInput = () => all(w, "#set-mcp-port")[0];
  const statusEl = () => all(w, "#set-mcp-status")[0];
  const endpointEl = () => all(w, "#set-mcp-endpoint")[0];

  check("存在监听端口输入框", !!portInput());
  check("端口栏显示请求端口", portInput()?.value === "8765");
  check("默认未被环境变量锁定（可编辑）", portInput()?.disabled === false);

  setChecked(w, enabled, true); // 先恢复开启态
  await settle(w);
  portInput().value = "9001";
  portInput().dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(w);
  saved = JSON.parse(w.localStorage.getItem(SETTINGS_KEY) ?? "{}");
  check("改端口持久化到 settings(mcpPort=9001)", saved.mcpPort === 9001);
  check("改端口后端点跟着走", endpointEl()?.value.includes(":9001") === true);

  // 非法端口不落库：先把脏值挡在持久化之外，否则下次启动会拿它去监听
  portInput().value = "0";
  portInput().dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(w);
  saved = JSON.parse(w.localStorage.getItem(SETTINGS_KEY) ?? "{}");
  check("非法端口(0)不写进设置", saved.mcpPort === 9001);
  check("非法输入被退回原值", portInput()?.value === "9001");

  // 端口被占用 → 后端自动 +1：卡片必须提示按**实际**端口配客户端，
  // 否则用户照请求端口填进客户端只会连不上（这正是自增功能的代价所在）
  w.__MAXCOM_MCP_STATUS__({
    enabled: true,
    running: true,
    endpoint: "http://127.0.0.1:9002/mcp",
    port: 9002,
    requested_port: 9001,
    port_locked_by_env: false,
    error: null,
    bind_scope: "仅本机回环",
  });
  await settle(w);
  check("自增后状态行切到 warn 态", statusEl()?.classList.contains("mcp-status-warn") === true);
  check(
    "自增提示同时给出请求端口与实际端口",
    (statusEl()?.textContent ?? "").includes("9001") && (statusEl()?.textContent ?? "").includes("9002"),
  );
  check("自增后端点为实际端口", endpointEl()?.value.includes(":9002") === true);
  check("自增后端口栏仍显示请求端口（区分「意图」与「实际」）", portInput()?.value === "9001");
  check("自增不算错误态（服务确实在跑）", statusEl()?.classList.contains("mcp-status-error") !== true);

  // 端口被环境变量锁定 → 输入框禁用并说明原因
  w.__MAXCOM_MCP_STATUS__({
    enabled: true,
    running: true,
    endpoint: "http://127.0.0.1:9500/mcp",
    port: 9500,
    requested_port: 9500,
    port_locked_by_env: true,
    error: null,
    bind_scope: "仅本机回环",
  });
  await settle(w);
  check("环境变量锁定时端口栏禁用", portInput()?.disabled === true);
  check("锁定状态行说明原因", (statusEl()?.textContent ?? "").includes("MAXCOM_MCP_PORT"));
  check("锁定后状态行仍是运行中态", statusEl()?.classList.contains("mcp-status-running") === true);

  // 全流程（含切标签页触发的「同步活动会话给后端」调用）不得抛出未捕获异常：
  // 该同步是 fire-and-forget 的一行 IPC，一旦同步抛错会直接打断 activate()，
  // 表现为「点标签页没反应」——比 MCP 本身坏掉更难查。
  check("全流程无未捕获异常", errors.length === 0);
  if (errors.length) for (const e of errors.slice(0, 3)) console.error("  ", e);

  console.log(`\n${fail === 0 ? "✓" : "✗"} mcp 设置页接线：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
