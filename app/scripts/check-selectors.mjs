// 静态交叉检查：TS 引用的 #id 必须存在于 index.html（或由 TS 动态创建的白名单）。
// 背景：replaceWith 消费容器后旧 id 消失，运行时 null.classList 崩掉整个模块（已踩坑）。
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

const files = ["src/main.ts", "src/pages/rules.ts", "src/pages/flash.ts"];
const refs = new Set();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  // 提取所有字符串字面量，仅校验"纯 id 选择器"（#xxx 且不含空格/后代关系）
  for (const m of src.matchAll(/"([^"]*)"/g)) {
    const sel = m[1];
    if (/^#[0-9a-fA-F]{3,8}$/.test(sel)) continue; // 十六进制颜色
    if (/^#[A-Za-z][\w-]*$/.test(sel)) refs.add(sel.slice(1));
  }
}

// 由 TS 动态创建/替换的合法缺失项（容器被 replaceWith 消费属正常）
const ALLOW_MISSING = new Set(["tcp-host-dd"]);

const missing = [...refs].filter((id) => !htmlIds.has(id) && !ALLOW_MISSING.has(id));
if (missing.length) {
  console.error("✗ 以下 #id 在 index.html 中不存在（可能已被 replaceWith 消费或拼写错误）：");
  for (const id of missing) console.error("  -", id);
  process.exit(1);
}
console.log(`✓ 选择器检查通过：${refs.size} 个 #id 引用全部可解析`);
