// 回归：收发区「时间戳后方向标记」（← 接收 / → 发送）。
//
// 语义背景：本地回显把本机发送的字节按「到达」投进**同一条**日志管线（引擎侧见
// crates/maxcom-engine/src/session.rs 的 publish_to("log", .., IoDir::Tx)），所以收发区里
// 接收行与发送行长得一样，唯一的区分依据是 LogEntryDto.dir。本脚本覆盖前端这一侧：
//   1) 默认不标（开关由 main 按「设置 ∧ 本地回显」下发，未下发时不得自说自话地渲染）；
//   2) 开启后每行都在时间戳**之后**标出 ←/→，方向取自 dir（缺省 = 接收）；
//   3) 关掉后标记消失、数据一行不少（标记是纯渲染层，不得影响 rows）；
//   4) 开关切换对新到的行同样生效（不是只重刷历史）；
//   5) 「保存历史」与窗口所见一致（有标记时导出也带标记）；
//   6) 时间戳模式 = 无 时标记照旧输出（方向是行的事实，与是否显示时间戳无关）。
//
// 验证思路：转译 src/pages/logview.ts 后直接驱动（同 logview-tsmode-test.mjs 的桩），
// 全部断言落在 DOM 文本/顺序上 —— 不依赖 jsdom 不做布局这一点。
import { JSDOM } from "jsdom";
import { transformSync } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (name, cond) => {
  console.log((cond ? "✓ " : "✗ ") + name);
  cond ? pass++ : fail++;
};

const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
const w = dom.window;
globalThis.window = w;
globalThis.document = w.document;
globalThis.HTMLElement = w.HTMLElement;
globalThis.HTMLInputElement = w.HTMLInputElement;
globalThis.Text = w.Text;
globalThis.Event = w.Event;

const src = readFileSync(join(process.cwd(), "src", "pages", "logview.ts"), "utf8")
  .replace('import { t } from "../i18n";', "const { t } = globalThis.__i18n;");
const out = transformSync(src, { loader: "ts", format: "cjs", target: "es2020" }).code;
globalThis.__i18n = { t: (k) => k };
const dir = mkdtempSync(join(process.cwd(), "scripts", ".lv-dir-"));
writeFileSync(join(dir, "b.cjs"), out);
const mod = await import("file://" + join(dir, "b.cjs").replace(/\\/g, "/"));
const LogViewPage = mod.default?.LogViewPage ?? mod.LogViewPage;
if (typeof LogViewPage !== "function") {
  console.error("✗ 无法从转译产物拿到 LogViewPage");
  process.exit(1);
}

const ROW_H = 24, CLIENT_H = 600;
const view = document.createElement("div");
view.style.fontSize = "16px";
view.style.lineHeight = "1.5";
document.body.appendChild(view);
Object.defineProperty(view, "clientHeight", { get: () => CLIENT_H, configurable: true });
Object.defineProperty(view, "scrollHeight", {
  get() {
    let h = 0;
    for (const c of view.children) {
      if (c.dataset.chunk === undefined) continue;
      h += c.childElementCount > 0 ? c.childElementCount * ROW_H : parseFloat(c.style.minHeight) || 0;
    }
    return h;
  },
  configurable: true,
});

const autoscroll = document.createElement("input");
autoscroll.type = "checkbox";
autoscroll.checked = true;

let mode = "relative";
const lv = new LogViewPage(view, { autoscroll, getTsMode: () => mode });

const marks = () => [...document.querySelectorAll(".log-line .log-dir")];
const markTexts = () => marks().map((e) => e.textContent);
const markDirs = () => marks().map((e) => e.dataset.dir);
const lineOf = (text) =>
  [...document.querySelectorAll(".log-line")].find((l) => l.textContent.includes(text));

/** 一批三行：接收 / 发送（本地回显）/ 方向缺省（老后端或非回显路径）。
    注意 segments 必须给（渲染面是染色段而非 text；text 只用于过滤/导出）。 */
const seg = (s) => [{ text: s }];
const feed = () =>
  lv.append({
    epoch_anchor_ms: 0,
    items: [
      { ts_ms: 100, text: "A-rx", segments: seg("A-rx"), raw_hex: "aa", dir: "rx" },
      { ts_ms: 150, text: "B-tx", segments: seg("B-tx"), raw_hex: "bb", dir: "tx" },
      { ts_ms: 130, text: "C-unknown", segments: seg("C-unknown"), raw_hex: "cc" }, // 无 dir → 按接收
    ],
  });
feed();

// ── 1. 未开启：一行标记都不许有（main 未下发时的静止态）──
check("默认不标方向", marks().length === 0);
check("默认状态位为关", lv.dirMarkEnabled === false);

// ── 2. 开启：每行都标，且方向取自 dir ──
lv.setDirMark(true);
check("开启后每行一个标记", marks().length === 3);
check("字形 ←/→ 对应用收发", JSON.stringify(markTexts()) === JSON.stringify(["←", "→", "←"]));
check("data-dir 与来源一致", JSON.stringify(markDirs()) === JSON.stringify(["rx", "tx", "rx"]));
check("缺省 dir 按接收处理", markDirs().filter((d) => d === "rx").length === 2);
check("rx/tx 各带样式类区分", !!lineOf("A-rx")?.querySelector(".log-dir.dir-rx") && !!lineOf("B-tx")?.querySelector(".log-dir.dir-tx"));

// 位置契约：标记必须在时间戳**之后**、正文之前（需求原话「时间戳之后加入」）
{
  const line = lineOf("B-tx");
  const kinds = [...(line?.children ?? [])].map((c) => (c.classList.contains("log-ts") ? "ts" : c.classList.contains("log-dir") ? "dir" : "content"));
  check("标记紧跟在时间戳之后", JSON.stringify(kinds) === JSON.stringify(["ts", "dir", "content"]));
}

// ── 3. 关闭：标记消失，数据一行不少 ──
lv.setDirMark(false);
check("关闭后无标记", marks().length === 0);
check("关闭不丢行", lv.lineCount === 3);

// ── 4. 切换对新来的行同样生效 ──
lv.setDirMark(true);
lv.append({
  epoch_anchor_ms: 0,
  items: [
    { ts_ms: 200, text: "D-tx-new", segments: seg("D-tx-new"), raw_hex: "dd", dir: "tx" },
    { ts_ms: 210, text: "E-rx-new", segments: seg("E-rx-new"), raw_hex: "ee", dir: "rx" },
  ],
});
check("开启后新行也带标记", JSON.stringify(markTexts().slice(-2)) === JSON.stringify(["→", "←"]));
lv.setDirMark(false);
lv.append({
  epoch_anchor_ms: 0,
  items: [{ ts_ms: 220, text: "F-off", segments: seg("F-off"), raw_hex: "ff", dir: "tx" }],
});
check("关闭后新行不带标记", marks().length === 0);

// ── 5. 保存历史与窗口所见一致 ──
{
  const plain = lv.historyText();
  check("关闭时导出无箭头", !plain.includes("←") && !plain.includes("→"));
  lv.setDirMark(true);
  const marked = lv.historyText();
  check("开启时导出带箭头", /\+150ms\s+→ B-tx/.test(marked) && /\+100ms\s+← A-rx/.test(marked));
  check("导出含全部行（含开关期间新到的）", marked.trim().split("\n").length === 6);
  check("导出仍用时间戳模式当前格式", marked.includes("+100ms") && !marked.includes("Δ"));
}

// ── 6. 时间戳模式 = 无：标记照旧输出（方向与"显不显示时间戳"无关）──
mode = "none";
lv.setTsMode();
check("无时间戳模式下不再有时间戳列", document.querySelectorAll(".log-line .log-ts").length === 0);
check("无时间戳模式下标记仍在", marks().length === 6);
check("无时间戳模式下导出仍带标记", lv.historyText().includes("← A-rx"));
mode = "relative";
lv.setTsMode();

// ── 7. HEX 显示不吞掉方向（两种渲染面互不干扰）──
lv.setHexDisplay(true);
check("HEX 模式下标记仍在", marks().length === 6);
check("HEX 模式正文为 raw_hex", [...document.querySelectorAll(".log-line .log-hex")].some((e) => e.textContent === "aa"));
lv.setHexDisplay(false);

rmSync(dir, { recursive: true, force: true });
console.log(`\n结果: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
