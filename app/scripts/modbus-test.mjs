// Modbus RTU 纯逻辑回归：esbuild 打包 src/modbus.ts 后在 Node 中跑断言。
// 覆盖：规范 F 校验向量、大端编码（寄存器值高字节在前）、帧构造 01/02/03/04/05/06/0x10、
// 帧解析（普通/异常/回显）、hex 工具、寄存器值列表解析、响应累积器（分包/无关字节）。
// 机器可验：任何断言失败即打印 ✗ 并以非零退出，接入 npm run build。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(tmpdir(), `modbus-test-${process.pid}.mjs`);
execFileSync(
  join(process.cwd(), "node_modules", ".bin", "esbuild"),
  ["src/modbus.ts", "--bundle", "--format=esm", `--outfile=${out}`, "--log-level=error"],
  { cwd: process.cwd() },
);
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
const hex = (u) => M.bytesToHex(u);
const hx = (s) => M.hexToBytes(s);
const crc16 = M.crc16;

// ── 1. 规范校验向量（权威）──
check("crc16 spec 01 03 00 00 00 0A", crc16(hx("01 03 00 00 00 0A")), 0xcdc5);
check("buildRead spec 0x11 regs", hex(M.buildRead(0x11, 3, 0x006b, 3)), "1103006B00037687");
check("buildWriteCoil spec 0x11 ON", hex(M.buildWriteCoil(0x11, 0x00ac, true)), "110500ACFF004E8B");
check("write-coil spec appends 4E 8B", [M.buildWriteCoil(0x11, 0x00ac, true)[6], M.buildWriteCoil(0x11, 0x00ac, true)[7]], [0x4e, 0x8b]);

// ── 2. 大端编码（寄存器值/地址高字节在前）──
check("read big-endian addr", [M.buildRead(1, 3, 0x1234, 0x0002)[2], M.buildRead(1, 3, 0x1234, 0x0002)[3]], [0x12, 0x34]);
check("read big-endian count", [M.buildRead(1, 3, 0x1234, 0x0002)[4], M.buildRead(1, 3, 0x1234, 0x0002)[5]], [0x00, 0x02]);
check("writeReg big-endian value", [M.buildWriteReg(1, 0x0102, 0xabcd)[4], M.buildWriteReg(1, 0x0102, 0xabcd)[5]], [0xab, 0xcd]);
check("writeReg big-endian addr", [M.buildWriteReg(1, 0x0102, 0xabcd)[2], M.buildWriteReg(1, 0x0102, 0xabcd)[3]], [0x01, 0x02]);
const wm = M.buildWriteMulti(1, 0x0010, [0x0a, 0x0102]);
check("writeMulti big-endian data", [...wm.slice(7, 11)], [0x00, 0x0a, 0x01, 0x02]);
check("writeMulti byteCount", wm[6], 4);
check("writeMulti qty", [wm[4], wm[5]], [0x00, 0x02]);

// ── 3. 帧解析 ──
const mkResp = (payloadHex, func) => {
  const p = hx(payloadHex);
  const body = new Uint8Array([1, func, ...p]);
  return M.appendCrc(body);
};
// 寄存器响应: values [10, 20]（大端）
let rp = M.parseFrame(mkResp("04 00 0A 00 14", 3));
check("parse regs kind", rp.kind, "regs");
check("parse regs values", rp.values, [10, 20]);
check("parse regs big-endian", rp.values, [10, 20]);
// 线圈/离散输入响应: byte 0x05 -> bits 1,0,1,0,0,0,0,0
rp = M.parseFrame(mkResp("02 05 00", 1));
check("parse bits kind", rp.kind, "bits");
check("parse bits", rp.bits.slice(0, 8), [1, 0, 1, 0, 0, 0, 0, 0]);
// 写单个线圈回显
rp = M.parseFrame(M.appendCrc(hx("01 05 00 AC FF 00")));
check("parse write-coil echo kind", rp.kind, "write");
check("parse write-coil echo value", rp.value, 0xff00);
// 写多个保持寄存器回显
rp = M.parseFrame(M.appendCrc(hx("01 10 00 10 00 02")));
check("parse write-multi echo count", rp.count, 2);
check("parse write-multi echo addr", rp.address, 0x10);
// 异常响应
rp = M.parseFrame(M.appendCrc(hx("01 83 02")));
check("parse exception kind", rp.kind, "exception");
check("parse exception code", rp.code, 2);
check("parse exception func", rp.func, 3);

// ── 4. verifyFrame / 坏帧 ──
const good = mkResp("04 00 0A 00 14", 3);
check("verifyFrame good", M.verifyFrame(good), true);
check("verifyFrame corrupt", M.verifyFrame(Uint8Array.from([...good.slice(0, 5), 0x00])), false);

// ── 5. hex 工具 ──
check("hexToBytes spaced", [...hx("01 03 00 6B 00 03")], [1, 3, 0, 0x6b, 0, 3]);
check("hexToBytes 0x prefix", [...hx("0x01 0x03")], [1, 3]);
check("hexToBytes odd throws", (() => { try { hx("010"); return false; } catch { return true; } })(), true);
check("bytesToHex roundtrip", hex(hx("AA BB CC")), "AABBCC");

// ── 6. 寄存器值列表 ──
check("parseRegList basic", M.parseRegList("1 2 3"), [1, 2, 3]);
check("parseRegList hex", M.parseRegList("0x0A,0x0B"), [10, 11]);
check("parseRegList out-of-range throws", (() => { try { M.parseRegList("99999"); return false; } catch { return true; } })(), true);
check("parseRegList empty throws", (() => { try { M.parseRegList("   "); return false; } catch { return true; } })(), true);

// ── 7. 响应累积器 ──
const rx = new M.ModbusRx();
rx.setPending(3);
check("rx no pending parse when garbage", (() => { const r = rx.push([0xff, 0xfe, 0xfd]); return r.length; })(), 0);
// 读保持寄存器响应帧: [01][03][04][00 0A][00 14][crc2]（大端 values=10,20）
const split = M.appendCrc(Uint8Array.from([1, 3, 4, 0x00, 0x0a, 0x00, 0x14])); // 9 字节
const rs = [];
rs.push(...rx.push([split[0], split[1]])); // 分包：前 2 字节
rs.push(...rx.push([split[2]])); // 1 字节
check("rx not complete yet", rs.length, 0);
rs.push(...rx.push([...split.slice(3)]));
check("rx completes one frame", rs.length, 1);
check("rx response correct", rs[0].values, [10, 20]);
check("rx pending cleared", rx.pending, false);

// 无关字节在前：仍能扫到完整帧
const rx2 = new M.ModbusRx();
rx2.setPending(3);
const j = rx2.push([0xff, 0xfe, 0xfd, ...split]);
check("rx skips noise", j.length, 1);
check("rx noise-skip values", j[0]?.values, [10, 20]);

// ── 8. 呼吸：ModbusRx.hex 不抛 ──
check("rx hex getter", typeof new M.ModbusRx().hex, "string");

console.log(`\n结果: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
