// 校验计算器纯逻辑回归：esbuild 打包 src/tools-checksum.ts 后在 Node 里跑断言。
// 两层信任来源：
//  1. CRC：用公认 "123456789" check 向量（reveng/catalog 权威值）逐变体断言。
//  2. MD5/SHA-1/SHA-256：用 Node 内建 node:crypto 作权威基准，交叉对照多长度
//     （空串/单字符/多字节/跨 56 字节 pad 边界/跨块），确保前后端一致、无pad和块计错误。
// 另覆盖 HEX/字符串输入解析、HEX/DEC/BIN 格式化、位宽切换。
// 机器可验：任何断言失败即打印 ✗ 并以非零退出，接入 npm run build。
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const { buildSync } = await import("esbuild");
const out = join(tmpdir(), `tools-checksum-test-${process.pid}.mjs`);
buildSync({
  entryPoints: ["src/tools-checksum.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});
const M = await import(`file://${out}`);

let pass = 0;
let fail = 0;
function check(label, got, want) {
  const eq = (a, b) => (Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b);
  const ok = typeof want === "function" ? want(got) : eq(got, want);
  if (ok) pass++;
  else {
    fail++;
    console.error(`✗ ${label}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
  }
}
const ascii = (s) => M.utf8Encode(s);

// ── CRC 公认 check 向量：ASCII "123456789"（reveng/catalog 权威值）──
const INPUT = ascii("123456789");
const CRC_CHECKS = {
  crc8: 0xf4,
  "crc8-maxim": 0xa1,
  "crc8-sae": 0x4b,
  "crc16-modbus": 0x4b37,
  "crc16-ccitt": 0x29b1,
  "crc16-xmodem": 0x31c3,
  "crc16-arc": 0xbb3d,
  "crc16-usb": 0xb4c8,
  "crc16-x25": 0x906e,
  "crc16-dnp": 0xea82,
  "crc16-kermit": 0x2189,
  crc24: 0x21cf02,
  crc32: 0xcbf43926,
  "crc32-mpeg2": 0x0376e6e7,
  "crc32-bzip2": 0xfc891918,
  crc32c: 0xe3069283,
  "crc32-posix": 0x765e7680,
};
for (const [id, want] of Object.entries(CRC_CHECKS)) {
  check(`crc ${id} "123456789"`, M.crc(INPUT, M.crcVariant(id).params), want);
}

// ── CRC 空输入 / 单字节 ──
check("crc8 empty => 0", M.crc(new Uint8Array(0), M.crcVariant("crc8").params), 0);
check("crc32 empty => 0", M.crc(new Uint8Array(0), M.crcVariant("crc32").params), 0);
check("crc8 single 0x00 => init/xorout 恒 0", M.crc(new Uint8Array([0x00]), M.crcVariant("crc8").params), 0);

// ── MD5 / SHA-1 / SHA-256：用 node:crypto 权威基准交叉对照 ──
const HASH_VECTORS = [
  ["", [
    "D41D8CD98F00B204E9800998ECF8427E", // md5
    "DA39A3EE5E6B4B0D3255BFEF95601890AFD80709", // sha1
    "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855", // sha256
  ]],
  ["abc", [
    "900150983CD24FB0D6963F7D28E17F72",
    "A9993E364706816ABA3E25717850C26C9CD0D89D",
    "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD",
  ]],
  ["a".repeat(55), [null, null, null]], // 跨 56 字节 pad 边界（55→pad 到 64）——下端用 crypto 现算
  ["a".repeat(56), [null, null, null]], // 恰好 56 → pad 到 128（跨块）
  ["a".repeat(100), [null, null, null]], // 跨 2 块
  ["中文测试", [null, null, null]], // 多字节 UTF-8
];
for (const [text, known] of HASH_VECTORS) {
  const buf = ascii(text);
  const want = [
    createHash("md5").update(buf).digest("hex").toUpperCase(),
    createHash("sha1").update(buf).digest("hex").toUpperCase(),
    createHash("sha256").update(buf).digest("hex").toUpperCase(),
  ];
  check(`md5 ${JSON.stringify(text.slice(0, 12))}`, M.bytesHex(M.md5(buf)), want[0]);
  check(`sha1 ${JSON.stringify(text.slice(0, 12))}`, M.bytesHex(M.sha1(buf)), want[1]);
  check(`sha256 ${JSON.stringify(text.slice(0, 12))}`, M.bytesHex(M.sha256(buf)), want[2]);
  // FIPS 权威向量（非跨边界）额外咬合一次，双重保险
  if (known[0]) check(`md5 FIPS ${JSON.stringify(text.slice(0, 12))}`, M.bytesHex(M.md5(buf)), known[0]);
  if (known[1]) check(`sha1 FIPS ${JSON.stringify(text.slice(0, 12))}`, M.bytesHex(M.sha1(buf)), known[1]);
  if (known[2]) check(`sha256 FIPS ${JSON.stringify(text.slice(0, 12))}`, M.bytesHex(M.sha256(buf)), known[2]);
}

// ── CHECKSUM（node:crypto 无对应，用累加定义自验）──
check("checksum8 'ABC'", M.checksum(ascii("ABC"), 8), (65 + 66 + 67) & 0xff);
check("checksum16 'ABC'", M.checksum(ascii("ABC"), 16), 65 + 66 + 67);
check("checksum8 overflow mod 256", M.checksum(new Uint8Array([0xff, 0x02]), 8), 1);
check("checksum32 'hello'", M.checksum(ascii("hello"), 32), ascii("hello").reduce((a, b) => a + b, 0));

// ── XOR ──
// XOR 必须按位宽分组（width bits 一“字”）异或；若逐字节异或，结果恒落低 8 位、位宽形同虚设。
check("xor8 'ABC' => 65^66^67", M.xorSum(ascii("ABC"), 8), 65 ^ 66 ^ 67);
check("xor8 self => 0", M.xorSum(new Uint8Array([0x55, 0x55]), 8), 0);
// 位宽真实生效：同一数据 8/16 结果不同（16 按 2 字节一字）
const XYZZY = new Uint8Array([0xab, 0xcd, 0x12, 0x34]);
check("xor8 多数据", M.xorSum(XYZZY, 8), 0xab ^ 0xcd ^ 0x12 ^ 0x34);
check("xor16 按2字节一字", M.xorSum(XYZZY, 16), 0xabcd ^ 0x1234);
check("xor8 与 xor16 结果不同", M.xorSum(XYZZY, 8) !== M.xorSum(XYZZY, 16), true);
// 末尾不足一字：按自然大端值参与（高位置零），单字节输入在任意位宽=它自身
check("xor16 'ABC' 尾字高位置零", M.xorSum(ascii("ABC"), 16), 0x4142 ^ 0x0043);
check("xor24 三字节一字", M.xorSum(ascii("ABCDEF"), 24), 0x414243 ^ 0x444546);
check("xor16 单字节=自身", M.xorSum(new Uint8Array([0xab]), 16), 0x00ab);
check("xor32 四字节一字", M.xorSum(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 32), 0x01020304 ^ 0x05060708);

// ── 输入解析 ──
check("parseHex '01 A0 FF'", M.parseHex("01 A0 FF")?.join(","), "1,160,255");
check("parseHex '01A0FF' no sep", M.parseHex("01A0FF")?.join(","), "1,160,255");
check("parseHex '0x01,0xA0,0xFF'", M.parseHex("0x01,0xA0,0xFF")?.join(","), "1,160,255");
check("parseHex odd length => null", M.parseHex("1A0") === null, true);
check("parseHex invalid chars => null", M.parseHex("ZZ") === null, true);
check("parseHex empty => zero-len", M.parseHex("").length, 0);
check("utf8 '中文测试' 12 bytes", ascii("中文测试").length, 12);

// ── 字符串编码（浏览器原生部分）──
check("encodeString utf-8 'abc'", M.bytesHex(M.encodeString("abc", "utf-8")), "616263");
check("encodeString utf-8 '中'", M.bytesHex(M.encodeString("中", "utf-8")), "E4B8AD");
check("encodeString latin-1 'A'+0xFF", M.bytesHex(M.encodeString("A\u{FF}B", "latin-1")), "41FF42");
check("encodeString latin-1 超0xFF替换", M.bytesHex(M.encodeString("中", "latin-1")), "FF");
check("encodeString utf-16le 'AB' no BOM", M.bytesHex(M.encodeString("AB", "utf-16le")), "41004200");
check("encodeString utf-16be 'AB' no BOM", M.bytesHex(M.encodeString("AB", "utf-16be")), "00410042");
check("encodeString utf-16le '中' BOM", M.bytesHex(M.encodeString("中", "utf-16le", true)), "FFFE2D4E");
check("encodeString utf-16be '中' BOM", M.bytesHex(M.encodeString("中", "utf-16be", true)), "FEFF4E2D");
check("encodeString utf-16le surrogate pair", M.bytesHex(M.encodeString("\u{1F600}", "utf-16le")), "3DD800DE");

// ── 格式化 ──
const r16 = M.compute("crc", INPUT, "crc16-modbus");
check("format crc16-modbus hex", M.formatResult(r16, "hex"), "4B37");
check("format crc16-modbus dec", M.formatResult(r16, "dec"), "19255");
check("format crc16-modbus bin", M.formatResult(r16, "bin"), "0100101100110111");
const r32 = M.compute("crc", INPUT, "crc32");
check("format crc32 hex padded", M.formatResult(r32, "hex"), "CBF43926");
check("format crc32 bin 32 bits", M.formatResult(r32, "bin").length, 32);
const md = M.compute("md5", ascii("abc"));
check("format md5 hex 32 chars", M.formatResult(md, "hex"), "900150983CD24FB0D6963F7D28E17F72");

// ── compute 聚合 / 位宽切换 ──
check("compute checksum width 16", M.compute("checksum", ascii("ABC"), undefined, 16).value.toString(), "198");
check("compute xor width 8", M.compute("xor", ascii("ABC"), undefined, 8).value.toString(), (65 ^ 66 ^ 67).toString());
check("compute xor width 16", M.compute("xor", ascii("ABC"), undefined, 16).value.toString(), (0x4142 ^ 0x0043).toString());
check("compute unknown crc variant throws", (() => { try { M.compute("crc", INPUT, "nope"); return false; } catch { return true; } })(), true);

// ── crcResult（“自定义”CRC：显式参数，等价 CRC-8）──
const custom = M.crcResult(ascii("123456789"), { width: 8, poly: 0x07, init: 0x00, refin: false, refout: false, xorout: 0x00 });
check("crcResult 等价CRC-8=0xF4", custom.value.toString(), "244");

console.log(`\nchecksum: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
