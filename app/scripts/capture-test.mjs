// 回归：捕获重构 —— 日志捕获格式（绝对/相对/差值/跟随/partial 续行）、二进制捕获文件名、自动滚动勾选立即滚底。
// - 部分A：esbuild 打包 src/capture.ts，直接断言纯函数（resolveLogFmt / formatFullTs / formatTsPrefix / captureLine / LogCapture / captureStem）。
// - 部分B：jsdom + 打包 src/pages/logview.ts，构造 LogViewPage 断言「非自动→自动勾选即滚到底」。
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";

let pass = 0, fail = 0;
const check = (name, cond) => {
  console.log((cond ? "✓ " : "✗ ") + name);
  cond ? pass++ : fail++;
};

async function bundle(entrySrc, name) {
  const dir = mkdtempSync(join(tmpdir(), `capture-test-${name}-`));
  writeFileSync(join(dir, "entry.ts"), entrySrc);
  const { buildSync } = await import("esbuild");
  buildSync({ entryPoints: [join(dir, "entry.ts")], bundle: true, format: "cjs", platform: "node", outfile: join(dir, "b.cjs"), logLevel: "silent" });
  const mod = await import("file://" + join(dir, "b.cjs"));
  return mod.default ?? mod;
}

const pad = (n, w = 2) => String(n).padStart(w, "0");
const localTs = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};
const timeOnly = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

// ───────────────────────── 部分A：capture.ts 纯函数 ─────────────────────────
async function partA() {
  const c = await bundle(
    `import { resolveLogFmt, formatFullTs, formatTimeOnly, formatTsPrefix, captureLine, LogCapture, captureStem } from "${join(process.cwd(), "src/capture.ts").replace(/\\/g, "/")}";
globalThis.__C = { resolveLogFmt, formatFullTs, formatTimeOnly, formatTsPrefix, captureLine, LogCapture, captureStem };
`,
    "pure",
  );
  const C = globalThis.__C;

  // 1) resolveLogFmt
  check("resolveLogFmt absolute → date", C.resolveLogFmt("absolute", "absolute") === "date");
  check("resolveLogFmt relative → relative", C.resolveLogFmt("relative", "absolute") === "relative");
  check("resolveLogFmt delta → delta", C.resolveLogFmt("delta", "absolute") === "delta");
  check("resolveLogFmt follow+absolute → time", C.resolveLogFmt("follow", "absolute") === "time");
  check("resolveLogFmt follow+relative → relative", C.resolveLogFmt("follow", "relative") === "relative");
  check("resolveLogFmt follow+delta → delta", C.resolveLogFmt("follow", "delta") === "delta");
  check("resolveLogFmt follow+none → none", C.resolveLogFmt("follow", "none") === "none");

  // 2) formatFullTs / formatTimeOnly（本地时区无关，用同构 getters 求期望）
  const ms = new Date(2026, 7, 27, 12, 34, 56, 789).getTime();
  check("formatFullTs 年月日时分秒.毫秒", C.formatFullTs(ms) === localTs(ms));
  check("formatTimeOnly 时分秒.毫秒", C.formatTimeOnly(ms) === timeOnly(ms));

  // 3) formatTsPrefix 各风格
  check("relative +123ms ", C.formatTsPrefix("relative", 123, 0, null) === "+123ms ");
  check("delta 首条 Δ+0ms ", C.formatTsPrefix("delta", 50, 0, null) === "Δ+0ms ");
  check("delta 递增 Δ+7ms ", C.formatTsPrefix("delta", 57, 0, 50) === "Δ+7ms ");
  check("delta 递减 Δ-3ms ", C.formatTsPrefix("delta", 54, 0, 57) === "Δ-3ms ");
  check("none 空串", C.formatTsPrefix("none", 5, 0, null) === "");
  check("date 前缀含空格", C.formatTsPrefix("date", 200, 1000, null) === localTs(1200) + " ");

  // 4) captureLine：date 模式把 anchor+ts 拼成 wall（时间戳后带分隔空格）
  check("captureLine date", C.captureLine("date", 200, "hi", 1000, null) === localTs(1200) + " hi");
  // relative/delta 前缀可变长 → padEnd 到列 12，负载对齐
  check("captureLine relative 负载列12", C.captureLine("relative", 200, "hi", 0, null).indexOf("hi") === 12);
  // 变宽差值前缀仍对齐到列 12
  const alA = C.captureLine("delta", 100, "Aa", 0, null);
  const alB = C.captureLine("delta", 162, "Bb", 0, 100);
  const alC = C.captureLine("delta", 289, "Cc", 0, 162);
  check("delta 变宽前缀负载同列12", alA.indexOf("Aa") === 12 && alB.indexOf("Bb") === 12 && alC.indexOf("Cc") === 12);
  check("delta 无时间戳 none 顶到列0", C.captureLine("none", 5, "txt", 0, null) === "txt");

  // 5) LogCapture partial 续行：同一行只带首段时间戳
  const lc = new C.LogCapture("time", new Date(2026, 7, 27, 0, 0, 0).getTime());
  lc.feed({
    epoch_anchor_ms: 0,
    items: [
      { ts_ms: 100, text: "he", partial: true },
      { ts_ms: 110, text: "ll", partial: true },
      { ts_ms: 120, text: "o", partial: false },
    ],
  });
  check("partial 续行合并为一行", lc.count === 1);
  const expLcLine = timeOnly(100) + " hello";
  check("partial 行用首段时间戳+合并文本", lc.content() === expLcLine + "\n");

  // 6) LogCapture 多行 + 差值前缀
  const lc2 = new C.LogCapture("delta");
  lc2.feed({ epoch_anchor_ms: 0, items: [{ ts_ms: 1000, text: "A" }] });
  lc2.feed({ epoch_anchor_ms: 0, items: [{ ts_ms: 1010, text: "B" }] });
  check("delta 两条行", lc2.count === 2);
  check("delta 首行 前缀对齐列12", lc2.content().split("\n")[0].indexOf("A") === 12);
  check("delta 二行 前缀对齐列12", lc2.content().split("\n")[1].indexOf("B") === 12);

  // 6b) LogCapture HEX 模式：写 raw_hex（大写空格分隔）而非解码文本；partial 续行空格分隔字节
  const lch = new C.LogCapture("none");
  lch.hex = true;
  lch.feed({
    epoch_anchor_ms: 0,
    items: [
      { ts_ms: 100, text: "He", raw_hex: "48 65", partial: true },
      { ts_ms: 110, text: "l", raw_hex: "6C", partial: true },
      { ts_ms: 120, text: "lo", raw_hex: "6C 6F", partial: false },
    ],
  });
  check("HEX 捕获写 raw_hex", lch.count === 1);
  check("HEX partial 续行空格分隔字节", lch.content() === "48 65 6C 6C 6F\n");
  // 非 HEX 模式（默认 hex=false）仍写解码文本
  const lcTxt = new C.LogCapture("none");
  lcTxt.feed({ epoch_anchor_ms: 0, items: [{ ts_ms: 1, text: "hi", raw_hex: "68 69" }] });
  check("非HEX 捕获仍写 text", lcTxt.content() === "hi\n");

  // 7) captureStem：名称(customName/制造商) + COM号 + 开始时间(ms)，中文/空格保留
  const st = new Date(2026, 7, 27, 12, 34, 56, 789).getTime();
  // 自定义标签页名 + COM号（保留 COM 前缀，不剥成裸号）
  check("captureStem 自定义名+COM号", C.captureStem("我的台架", "COM14", st).startsWith("CAP_我的台架_COM14_"));
  // 制造商名 + COM号（空格 → 下划线）
  check("captureStem 制造商名+COM号", C.captureStem("USB-SERIAL CH340", "COM14", st).startsWith("CAP_USB-SERIAL_CH340_COM14_"));
  // 时间到ms
  check("captureStem 时间到ms", C.captureStem("x", "COM3", st).includes(`${new Date(st).getFullYear()}-${pad(new Date(st).getMonth() + 1)}-${pad(new Date(st).getDate())}_${pad(new Date(st).getHours())}-${pad(new Date(st).getMinutes())}-${pad(new Date(st).getSeconds())}_${pad(new Date(st).getMilliseconds(), 3)}`));
  // Unix：保留 tty 前缀
  check("captureStem unix ttyUSB 保留前缀", C.captureStem("测试", "/dev/ttyUSB4", st).startsWith("CAP_测试_ttyUSB4_"));
  check("captureStem unix tty4 保留前缀", C.captureStem("测试", "/dev/tty4", st).startsWith("CAP_测试_tty4_"));
  // 设备路径转义，不含 `/`
  const viaDev = C.captureStem("/dev/ttyUSB0", "/dev/ttyUSB0", st);
  check("captureStem 路径转义且不含 /", viaDev.startsWith("CAP_dev_ttyUSB0_ttyUSB0_") && !viaDev.includes("/"));
  // 空名称回退到设备名
  check("captureStem 空名回退设备", C.captureStem("", "my device", st).startsWith("CAP_my_device_"));
}

// ───────────────────────── 部分B：自动滚动勾选立即滚底 ─────────────────────────
async function partB() {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  const w = dom.window;
  globalThis.window = w;
  globalThis.document = w.document;
  globalThis.HTMLElement = w.HTMLElement;
  globalThis.HTMLInputElement = w.HTMLInputElement;
  globalThis.Event = w.Event;

  const L = await bundle(
    `import { LogViewPage } from "${join(process.cwd(), "src/pages/logview.ts").replace(/\\/g, "/")}";
globalThis.__LogViewPage = LogViewPage;
`,
    "logview",
  );
  const LogViewPage = globalThis.__LogViewPage;

  const view = document.createElement("div");
  Object.defineProperty(view, "scrollHeight", { value: 300, configurable: true });
  Object.defineProperty(view, "clientHeight", { value: 100, configurable: true });
  view.scrollTop = 0;
  const autoscroll = document.createElement("input");
  autoscroll.type = "checkbox";
  autoscroll.checked = false;
  new LogViewPage(view, { autoscroll, getTsMode: () => "absolute" });

  autoscroll.dispatchEvent(new w.Event("change", { bubbles: true }));
  check("未勾选时 change 不滚动", view.scrollTop === 0);

  autoscroll.checked = true;
  autoscroll.dispatchEvent(new w.Event("change", { bubbles: true }));
  check("勾选自动滚动→立即滚到底", view.scrollTop === 200);
}

await partA();
await partB();
console.log(`\n结果: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
