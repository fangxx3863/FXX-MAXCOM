// 校验计算器：纯函数计算层（无 DOM / 无 i18n 依赖）。
// tools.ts 里 buildChecksum 调用本文件导出函数完成计算；scripts/tools-checksum-test.mjs
// 用 esbuild 打包本文件后在 Node 里跑断言，保证算法可被独立回归测试。
// 覆盖：参数化 CRC(8/16/24/32 多变体) / CHECKSUM / XOR / MD5 / SHA-1 / SHA-256，
// 输入源：HEX 文本、UTF-8 字符串、原始字节（文件读入后送入）。
// 输出格式：HEX / DEC / BIN。
// CRC 用 BigInt 计算：CRC-24/32 结果超过 JS 32 位有符号范围，number 按位运算
// 会把 mask/top 转成 ToInt32 的负中间值，虽末段可救但含歧义；BigInt 全程无符号等价、无歧义。

// ── 字节工具 ──
function bufToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out.toUpperCase();
}

/** 公开助手：字节数组 → 大写 HEX 串（供测试/DOM 层复用）。 */
export function bytesHex(bytes: Uint8Array): string {
  return bufToHex(bytes);
}

function bufToBin(bytes: Uint8Array): string {
  if (bytes.length === 0) return "0";
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
  let s = v.toString(2);
  while (s.length < bytes.length * 8) s = "0" + s;
  return s;
}

// ── 输入解析 ──

/** 解析 HEX 文本为字节。容忍分隔符(空格/逗号/分号/冒号/换行/制表/连字符/0x 前缀)。
 *  非法 hex 字符或非偶数长度时返回 null；空结果返回零长数组。 */
export function parseHex(text: string): Uint8Array | null {
  if (text == null) return null;
  const cleaned = text
    .replace(/0x/gi, "")
    .replace(/[\s,;:+\-\r\n\t]/g, "");
  if (cleaned.length === 0) return new Uint8Array(0);
  if (cleaned.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) return null;
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.substr(i * 2, 2), 16);
  return out;
}

/** UTF-8 编码字符串为字节。 */
export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ── 字符串 → 字节：浏览器原生编码（UTF-8 / Latin-1 / UTF-16LE / UTF-16BE）──
// GBK/GB2312 浏览器无法原生编码（TextEncoder 仅 UTF-8；TextDecoder 只能解不能编），
// 由 DOM 构建器走 Tauri invoke("encode_text") 调 Rust encoding_rs 处理。

export type InputEncoding = "utf-8" | "latin-1" | "utf-16le" | "utf-16be";

/** 按编码把字符串转字节。UTF-16 可加 BOM；Latin-1 超 0xFF 字节用 0xFF 替换。 */
export function encodeString(text: string, enc: InputEncoding, bom = false): Uint8Array {
  switch (enc) {
    case "utf-8":
      return utf8Encode(text);
    case "latin-1": {
      const out = new Uint8Array(text.length);
      let n = 0;
      for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        out[n++] = cp <= 0xff ? cp : 0xff;
      }
      return out.subarray(0, n);
    }
    case "utf-16le": {
      const b = utf16Encode(text, true, bom);
      return b;
    }
    case "utf-16be": {
      const b = utf16Encode(text, false, bom);
      return b;
    }
  }
}

function utf16Encode(text: string, littleEndian: boolean, bom: boolean): Uint8Array {
  const units: number[] = [];
  // BOM = U+FEFF；存成 LE 是 FF FE、BE 是 FE FF，由 setUint16 的 littleEndian 决定。
  if (bom) units.push(0xfeff);
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0xffff) {
      units.push(cp);
    } else {
      // 代理对
      const v = cp - 0x10000;
      units.push(0xd800 | (v >> 10), 0xdc00 | (v & 0x3ff));
    }
  }
  const out = new Uint8Array(units.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < units.length; i++) dv.setUint16(i * 2, units[i], littleEndian);
  return out;
}

// ── CRC 参数化（BigInt） ──

export interface CrcParams {
  width: number;   // 位宽 8/16/24/32
  poly: number;    // 多项式（不含最高位）
  init: number;    // 初始值
  refin: boolean;  // 输入反射
  refout: boolean; // 输出反射
  xorout: number;  // 输出异或
}

/** 位反射：把 v 的低 bits 位按位反转。 */
function reflectBits(v: bigint, bits: bigint): bigint {
  let r = 0n;
  for (let i = 0n; i < bits; i++) {
    if (v & (1n << i)) r |= 1n << (bits - 1n - i);
  }
  return r;
}

/** 参数化 CRC（MSB-first）。返回 width 位无符号校验值（number）。 */
export function crc(data: Uint8Array, p: CrcParams): number {
  const width = BigInt(p.width);
  const mask = (1n << width) - 1n;
  const top = 1n << (width - 1n);
  let crc = BigInt(p.init) & mask;
  const poly = (BigInt(p.poly) & mask);
  const shift = width - 8n;
  for (let idx = 0; idx < data.length; idx++) {
    let b = BigInt(data[idx]);
    if (p.refin) b = reflectBits(b, 8n);
    crc ^= b << shift;
    for (let i = 0; i < 8; i++) {
      if (crc & top) crc = ((crc << 1n) ^ poly) & mask;
      else crc = (crc << 1n) & mask;
    }
  }
  let res = crc;
  if (p.refout) res = reflectBits(res, width) & mask;
  res = (res ^ BigInt(p.xorout)) & mask;
  return Number(res);
}

/** 单个 CRC 变体（预设参数）。 */
export interface CrcVariant {
  id: string;
  label: string;
  params: CrcParams;
}

// 标准 check 向量：ASCII "123456789" 时 CRC 校验值（catalog/reveng 公认值，单测据此回归）。
export const CRC_VARIANTS: CrcVariant[] = [
  { id: "crc8", label: "CRC-8", params: { width: 8, poly: 0x07, init: 0x00, refin: false, refout: false, xorout: 0x00 } },
  { id: "crc8-maxim", label: "CRC-8/MAXIM", params: { width: 8, poly: 0x31, init: 0x00, refin: true, refout: true, xorout: 0x00 } },
  { id: "crc8-sae", label: "CRC-8/SAE-J1850", params: { width: 8, poly: 0x1d, init: 0xff, refin: false, refout: false, xorout: 0xff } },
  { id: "crc16-modbus", label: "CRC-16/MODBUS", params: { width: 16, poly: 0x8005, init: 0xffff, refin: true, refout: true, xorout: 0x0000 } },
  { id: "crc16-ccitt", label: "CRC-16/CCITT-FALSE", params: { width: 16, poly: 0x1021, init: 0xffff, refin: false, refout: false, xorout: 0x0000 } },
  { id: "crc16-xmodem", label: "CRC-16/XMODEM", params: { width: 16, poly: 0x1021, init: 0x0000, refin: false, refout: false, xorout: 0x0000 } },
  { id: "crc16-arc", label: "CRC-16/ARC(IBM)", params: { width: 16, poly: 0x8005, init: 0x0000, refin: true, refout: true, xorout: 0x0000 } },
  { id: "crc16-usb", label: "CRC-16/USB", params: { width: 16, poly: 0x8005, init: 0xffff, refin: true, refout: true, xorout: 0xffff } },
  { id: "crc16-x25", label: "CRC-16/X25(IBM-SDLC)", params: { width: 16, poly: 0x1021, init: 0xffff, refin: true, refout: true, xorout: 0xffff } },
  { id: "crc16-dnp", label: "CRC-16/DNP", params: { width: 16, poly: 0x3d65, init: 0x0000, refin: true, refout: true, xorout: 0xffff } },
  { id: "crc16-kermit", label: "CRC-16/KERMIT", params: { width: 16, poly: 0x1021, init: 0x0000, refin: true, refout: true, xorout: 0x0000 } },
  { id: "crc24", label: "CRC-24/OPENPGP", params: { width: 24, poly: 0x864cfb, init: 0xb704ce, refin: false, refout: false, xorout: 0x000000 } },
  { id: "crc32", label: "CRC-32", params: { width: 32, poly: 0x04c11db7, init: 0xffffffff, refin: true, refout: true, xorout: 0xffffffff } },
  { id: "crc32-mpeg2", label: "CRC-32/MPEG-2", params: { width: 32, poly: 0x04c11db7, init: 0xffffffff, refin: false, refout: false, xorout: 0x00000000 } },
  { id: "crc32-bzip2", label: "CRC-32/BZIP2", params: { width: 32, poly: 0x04c11db7, init: 0xffffffff, refin: false, refout: false, xorout: 0xffffffff } },
  { id: "crc32c", label: "CRC-32C (Castagnoli)", params: { width: 32, poly: 0x1edc6f41, init: 0xffffffff, refin: true, refout: true, xorout: 0xffffffff } },
  { id: "crc32-posix", label: "CRC-32/POSIX(ck)", params: { width: 32, poly: 0x04c11db7, init: 0x00000000, refin: false, refout: false, xorout: 0xffffffff } },
];

export function crcVariant(id: string): CrcVariant | null {
  return CRC_VARIANTS.find((v) => v.id === id) ?? null;
}

// ── CHECKSUM（累加和） ──
/** 所有字节求和截断到 width 位。width 8/16/24/32。 */
export function checksum(data: Uint8Array, width: number): number {
  const mask = width === 32 ? 0xffffffff : ((1 << width) - 1);
  let acc = 0;
  for (let i = 0; i < data.length; i++) acc = (acc + data[i]) & mask;
  return width === 32 ? (acc >>> 0) : (acc & mask);
}

// ── XOR ──
/** 所有字节按 width 位字长分组逐个异或（大端字），截断到 width 位。
 *  width=8 即逐字节异或；width=16/24/32 时每 2/3/4 字节合成一个大端字再异或。
 *  末尾不足一字时按自然大端值参与（高位置零），故单字节输入在任意位宽都等于它自身。
 *  说明：若仍是逐字节异或，则结果恒 ≤ 0xff（xor 只影响累加器低 8 位），无论位宽改成
 *  16/24/32 都一样——位宽将形同虚设。按字分组后位宽才真实生效。 */
export function xorSum(data: Uint8Array, width: number): number {
  const wordBytes = width / 8;
  const mask = width === 32 ? 0xffffffff : ((1 << width) - 1);
  let acc = 0;
  for (let i = 0; i < data.length; i += wordBytes) {
    const n = Math.min(wordBytes, data.length - i);
    let w = 0;
    for (let j = 0; j < n; j++) w = (w << 8) | data[i + j];
    acc = (acc ^ w) & mask;
  }
  return width === 32 ? (acc >>> 0) : acc;
}

// ── MD5（RFC 1321，big-endian 摘要输出） ──
// WebCrypto 不提供 MD5，必须纯 JS 实现，保证浏览器/Node/测试两端一致。
const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K: number[] = (() => {
  const K = new Array<number>(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  return K;
})();

/** 消息填充：返回 { buf, total }，total 是 64 的倍数，末尾 8 字节放 64 位长度。 */
function padMessage(msgLen: number, bigEndianLen: boolean): { buf: Uint8Array; dv: DataView; total: number } {
  const x = msgLen % 64;
  const padLen = x <= 55 ? (64 - x) : (128 - x); // 保证 >= 8，容下 0x80 + 长度
  const total = msgLen + padLen;
  const buf = new Uint8Array(total);
  buf[msgLen] = 0x80;
  const dv = new DataView(buf.buffer);
  const bitLen = msgLen * 8;
  if (bigEndianLen) {
    dv.setUint32(total - 8, Math.floor(bitLen / 4294967296), false);
    dv.setUint32(total - 4, bitLen >>> 0, false);
  } else {
    dv.setUint32(total - 8, bitLen >>> 0, true);
    dv.setUint32(total - 4, Math.floor(bitLen / 4294967296), true);
  }
  return { buf, dv, total };
}

export function md5(data: Uint8Array): Uint8Array {
  const { buf, dv, total } = padMessage(data.length, false);
  buf.set(data, 0);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < total; off += 64) {
    // 本地复制 16 字（节省重复 DataView 读取）
    const M = new Array<number>(16);
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(off + j * 4, true);
    let A = a0 >>> 0, B = b0 >>> 0, C = c0 >>> 0, D = d0 >>> 0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const sum = (A + F + MD5_K[i] + M[g]) >>> 0;
      const rot = ((sum << MD5_S[i]) | (sum >>> (32 - MD5_S[i]))) >>> 0;
      const tmpD = D;
      D = C;
      C = B;
      B = (B + rot) >>> 0;
      A = tmpD;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const od = new DataView(out.buffer);
  od.setUint32(0, a0, true); od.setUint32(4, b0, true); od.setUint32(8, c0, true); od.setUint32(12, d0, true);
  return out;
}

// ── SHA-1 ──
export function sha1(data: Uint8Array): Uint8Array {
  const { buf, dv, total } = padMessage(data.length, true);
  buf.set(data, 0);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Array<number>(80);
  for (let off = 0; off < total; off += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(off + j * 4, false);
    for (let j = 16; j < 80; j++) w[j] = (((w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16]) << 1) | ((w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16]) >>> 31)) >>> 0;
    let a = h0 >>> 0, b = h1 >>> 0, c = h2 >>> 0, d = h3 >>> 0, e = h4 >>> 0;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const tmp = ((((a << 5) | (a >>> 27)) >>> 0) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = tmp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const od = new DataView(out.buffer);
  od.setUint32(0, h0, false); od.setUint32(4, h1, false); od.setUint32(8, h2, false);
  od.setUint32(12, h3, false); od.setUint32(16, h4, false);
  return out;
}

// ── SHA-256 ──
const SHA256_K: number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];

export function sha256(data: Uint8Array): Uint8Array {
  const { buf, dv, total } = padMessage(data.length, true);
  buf.set(data, 0);

  const h = new Array<number>(
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
  const w = new Array<number>(64);
  for (let off = 0; off < total; off += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(off + j * 4, false);
    for (let j = 16; j < 64; j++) {
      const s0 = (((w[j - 15] >>> 7) | (w[j - 15] << 25)) ^ ((w[j - 15] >>> 18) | (w[j - 15] << 14)) ^ (w[j - 15] >>> 3)) >>> 0;
      const s1 = (((w[j - 2] >>> 17) | (w[j - 2] << 15)) ^ ((w[j - 2] >>> 19) | (w[j - 2] << 13)) ^ (w[j - 2] >>> 10)) >>> 0;
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let a = h[0] >>> 0, b = h[1] >>> 0, c = h[2] >>> 0, d = h[3] >>> 0,
        e = h[4] >>> 0, f = h[5] >>> 0, g = h[6] >>> 0, hh = h[7] >>> 0;
    for (let i = 0; i < 64; i++) {
      const S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const od = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) od.setUint32(i * 4, h[i], false);
  return out;
}

// ── 顶层算法聚合 ──
export type ChecksumAlgo = "crc" | "checksum" | "xor" | "md5" | "sha1" | "sha256";

export interface ChecksumResult {
  /** 摘要字节（big-endian 表示）。CRC/CHECKSUM/XOR 为低位宽字节，MD5/SHA 为完整摘要。 */
  bytes: Uint8Array;
  /** 无符号数值（MD5/SHA 为整个大摘要的整数）。 */
  value: bigint;
  /** 位宽（CRC/CHECKSUM/XOR 为约定位宽；MD5/SHA 为 bytes.length*8）。 */
  width: number;
}

function bytesToValue(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

/** 把 number 结果按位宽转成 big-endian 字节数组。 */
function valueToBytes(value: number, width: number): Uint8Array {
  const n = width / 8;
  const out = new Uint8Array(n);
  let v = width === 32 ? (value >>> 0) : value;
  for (let i = n - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

/** 主计算入口。param：CRC 变体 id；width：CHECKSUM/XOR 位宽（8/16/24/32）。 */
export function compute(algo: ChecksumAlgo, data: Uint8Array, param?: string, width = 8): ChecksumResult {
  switch (algo) {
    case "crc": {
      const variant = param ? crcVariant(param) : CRC_VARIANTS[0];
      if (!variant) throw new Error("unknown crc variant");
      const v = crc(data, variant.params);
      return { bytes: valueToBytes(v, variant.params.width), value: BigInt(v), width: variant.params.width };
    }
    case "checksum": {
      const v = checksum(data, width);
      return { bytes: valueToBytes(v, width), value: BigInt(v), width };
    }
    case "xor": {
      const v = xorSum(data, width);
      return { bytes: valueToBytes(v, width), value: BigInt(v), width };
    }
    case "md5": { const b = md5(data); return { bytes: b, value: bytesToValue(b), width: b.length * 8 }; }
    case "sha1": { const b = sha1(data); return { bytes: b, value: bytesToValue(b), width: b.length * 8 }; }
    case "sha256": { const b = sha256(data); return { bytes: b, value: bytesToValue(b), width: b.length * 8 }; }
  }
}

/** 用显式参数计算 CRC 并构造结果（校验计算器“自定义”模式用）。 */
export function crcResult(data: Uint8Array, p: CrcParams): ChecksumResult {
  const v = crc(data, p);
  return { bytes: valueToBytes(v, p.width), value: BigInt(v), width: p.width };
}

// ── 输出格式化 ──
export type OutputFormat = "hex" | "dec" | "bin";

/** 结果按指定格式输出。CRC/CHECKSUM/XOR 数值型补零到位宽；MD5/SHA 逐字节 hex / 大整数。 */
export function formatResult(res: ChecksumResult, fmt: OutputFormat): string {
  switch (fmt) {
    case "hex":
      if (res.width <= 32) return res.value.toString(16).toUpperCase().padStart(res.width / 4, "0");
      return bufToHex(res.bytes);
    case "dec":
      return res.value.toString();
    case "bin":
      if (res.width <= 32) return res.value.toString(2).padStart(res.width, "0");
      return bufToBin(res.bytes);
  }
}
