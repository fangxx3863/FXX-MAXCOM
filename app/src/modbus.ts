// Modbus RTU 纯逻辑：帧构造 / 帧解析 / CRC16 / 响应累积器。
// 独立于 Tauri 与 DOM（纯函数），可在浏览器演示模式与桌面端复用。
// 参考 MODBUS 调试助手（V1.0）：01/02/03/04 读，05/06/0x10 写，任意指令 HEX/CRC 发送。
//
// Modbus RTU 帧 = [从站地址][功能码][数据…][CRC16 低字节][CRC16 高字节]（CRC 小端）。

/** 请求功能码（8 位） */
export type ModbusFunc = 1 | 2 | 3 | 4 | 5 | 6 | 0x10;

export interface ReadBits {
  kind: "bits";
  addr: number;
  /** 原始功能码（无 0x80） */
  func: number;
  byteCount: number;
  /** 原始数据字节（未解位） */
  data: number[];
  /** 解出的位（0/1），长度 = byteCount*8 */
  bits: number[];
}

export interface ReadRegs {
  kind: "regs";
  addr: number;
  func: number;
  byteCount: number;
  /** 寄存器值（大端，u16） */
  values: number[];
}

export interface WriteEcho {
  kind: "write";
  addr: number;
  func: number;
  /** 起始地址（线圈/寄存器） */
  address: number;
  /** 05/06 写入的值；0x10 回显无 value */
  value?: number;
  /** 0x10 写入的寄存器个数 */
  count?: number;
}

export interface Exception {
  kind: "exception";
  addr: number;
  /** 响应功能码（已去除 0x80） */
  func: number;
  code: number;
}

export type ModbusResponse = ReadBits | ReadRegs | WriteEcho | Exception;

/** Modbus 异常码描述 */
export function exceptionText(code: number): string {
  switch (code) {
    case 1: return "Illegal function (非法功能)";
    case 2: return "Illegal data address (非法数据地址)";
    case 3: return "Illegal data value (非法数据值)";
    case 4: return "Slave device failure (从站设备故障)";
    case 5: return "Acknowledge (确认)";
    case 6: return "Slave device busy (从站忙碌)";
    case 8: return "Memory parity error (存储器奇偶错误)";
    case 0x0a: return "Gateway path unavailable (网关路径不可用)";
    case 0x0b: return "Gateway target device failed (网关目标设备无响应)";
    default: return `Unknown exception (未知异常 ${code})`;
  }
}

/** Modbus CRC16：init 0xFFFF，poly 0xA001（反射）。返回 16 位 CRC 值。 */
export function crc16(data: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) crc = (crc >> 1) ^ 0xa001;
      else crc >>= 1;
    }
  }
  return crc & 0xffff;
}

/** 在无校验数据末尾追加 CRC16（低字节在前），返回完整帧。 */
export function appendCrc(data: Uint8Array): Uint8Array {
  const c = crc16(data);
  const out = new Uint8Array(data.length + 2);
  out.set(data);
  out[data.length] = c & 0xff;
  out[data.length + 1] = (c >> 8) & 0xff;
  return out;
}

let u8 = (n: number): number => n & 0xff;
const u16hi = (n: number): number => ((n >> 8) & 0xff);
const u16lo = (n: number): number => (n & 0xff);

/** 读功能码 01/02/03/04：读线圈/离散输入/保持/输入寄存器。 */
export function buildRead(slave: number, func: 1 | 2 | 3 | 4, start: number, count: number): Uint8Array {
  return appendCrc(Uint8Array.from([u8(slave), func, u16hi(start), u16lo(start), u16hi(count), u16lo(count)]));
}

/** 05 写单个线圈：value 为布尔，编码为 0xFF00/0x0000。 */
export function buildWriteCoil(slave: number, addr: number, on: boolean): Uint8Array {
  const v = on ? 0xff00 : 0x0000;
  return appendCrc(Uint8Array.from([u8(slave), 0x05, u16hi(addr), u16lo(addr), u16hi(v), u16lo(v)]));
}

/** 06 写单个保持寄存器。 */
export function buildWriteReg(slave: number, addr: number, value: number): Uint8Array {
  return appendCrc(Uint8Array.from([u8(slave), 0x06, u16hi(addr), u16lo(addr), u16hi(value), u16lo(value)]));
}

/** 0x10 写多个保持寄存器：values 为寄存器 u16 数组。 */
export function buildWriteMulti(slave: number, start: number, values: number[]): Uint8Array {
  const n = values.length;
  const bc = n * 2;
  const out = [u8(slave), 0x10, u16hi(start), u16lo(start), u16hi(n), u16lo(n), bc];
  for (const v of values) out.push(u16hi(v), u16lo(v));
  return appendCrc(Uint8Array.from(out));
}

/** 校验一帧（含 CRC）是否有效。 */
export function verifyFrame(frame: Uint8Array): boolean {
  if (frame.length < 4) return false;
  const crc = frame[frame.length - 2] | (frame[frame.length - 1] << 8);
  return crc16(frame.subarray(0, frame.length - 2)) === crc;
}

/** 解析一帧（须先 verifyFrame 通过；未通过会抛错）。 */
export function parseFrame(frame: Uint8Array): ModbusResponse {
  if (!verifyFrame(frame)) throw new Error("bad crc");
  const addr = frame[0];
  const rawFunc = frame[1];
  // 异常响应：func|0x80
  if (rawFunc & 0x80) {
    return { kind: "exception", addr, func: rawFunc & 0x7f, code: frame[2] };
  }
  if (rawFunc >= 1 && rawFunc <= 4) {
    const byteCount = frame[2];
    const d = frame.subarray(3, 3 + byteCount);
    if (rawFunc === 1 || rawFunc === 2) {
      const bits: number[] = [];
      for (const b of d) for (let i = 0; i < 8; i++) bits.push((b >> i) & 1);
      return { kind: "bits", addr, func: rawFunc, byteCount, data: [...d], bits };
    }
    const values: number[] = [];
    for (let i = 0; i + 1 < d.length; i += 2) values.push((d[i] << 8) | d[i + 1]);
    return { kind: "regs", addr, func: rawFunc, byteCount, values };
  }
  const a16 = (o: number) => (frame[o] << 8) | frame[o + 1];
  if (rawFunc === 5) {
    return { kind: "write", addr, func: 5, address: a16(2), value: a16(4) };
  }
  if (rawFunc === 6) {
    return { kind: "write", addr, func: 6, address: a16(2), value: a16(4) };
  }
  if (rawFunc === 0x10) {
    return { kind: "write", addr, func: 0x10, address: a16(2), count: a16(4) };
  }
  throw new Error(`unsupported func ${rawFunc}`);
}

/** 连续 hex（小端/大端无关，仅拼接）；去掉空白与 0x 前缀。 */
export function bytesToHex(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const b of bytes) parts.push(b.toString(16).padStart(2, "0"));
  return parts.join("").toUpperCase();
}

/** 空格分隔 hex（显示用）。 */
export function bytesToHexSpaced(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const b of bytes) parts.push(b.toString(16).padStart(2, "0"));
  return parts.join(" ").toUpperCase();
}

/** 解析 hex 字符串（允许空格 / 0x 前缀，忽略非法字符），返回字节数组。 */
export function hexToBytes(input: string): Uint8Array {
  const clean = input.replace(/0x/gi, "").replace(/\s+/g, "");
  if (clean.length % 2 !== 0) throw new Error("hex 长度必须为偶数");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 宽松地把用户输入解析成整数：支持 0x 前缀 / 十进制。 */
export function parseNum(text: string): number | null {
  const s = text.trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s.slice(2), 16);
  return null;
}

/** 把一串寄存器值文本（空格/逗号分隔，可十六进制）解析成 u16 数组。 */
export function parseRegList(text: string): number[] {
  const toks = text.split(/[\s,;]+/).filter(Boolean);
  const values: number[] = [];
  for (const tok of toks) {
    const n = parseNum(tok);
    if (n === null || n < 0 || n > 0xffff) throw new Error(`非法的寄存器值: ${tok}`);
    values.push(n);
  }
  if (!values.length) throw new Error("至少需要一个寄存器值");
  return values;
}

/** 响应帧长度（按功能码推断；读类用 byteCount 在帧内取）。 */
export function responseLen(func: number, byteCount?: number): number {
  if (func & 0x80) return 5; // 异常：addr+func+code+crc2
  if (func >= 1 && func <= 4) return 3 + (byteCount ?? 0) + 2;
  return 8; // 05/06/0x10 回显
}

/**
 * 响应累积器：接收原始字节 → 依据"待处理请求"提取一整帧并解析。
 * 不消费无关字节（保留在缓冲区，可由调用方展示）。
 */
export class ModbusRx {
  private buf: number[] = [];
  /** 当前待响应请求的功能码（未定义时不解析，仅累积） */
  private pendingFunc: number | null = null;

  clearPending(): void {
    this.pendingFunc = null;
  }
  setPending(func: number): void {
    this.pendingFunc = func;
  }
  get pending(): boolean {
    return this.pendingFunc !== null;
  }
  reset(): void {
    this.buf = [];
    this.pendingFunc = null;
  }
  /** 清空缓冲（用户点了清空） */
  clearBuf(): void {
    this.buf = [];
  }
  get length(): number {
    return this.buf.length;
  }
  get hex(): string {
    return bytesToHexSpaced(Uint8Array.from(this.buf));
  }

  /** 喂入字节，返回本次解析出的一或多个响应帧。 */
  push(bytes: number[] | Uint8Array): ModbusResponse[] {
    for (const b of bytes) this.buf.push(b);
    const out: ModbusResponse[] = [];
    if (this.pendingFunc !== null) this.scan(out);
    return out;
  }

  private scan(out: ModbusResponse[]): void {
    const pf = this.pendingFunc!;
    const n = this.buf.length;
    for (let i = 0; i + 4 <= n; i++) {
      const f = this.buf[i + 1];
      const isException = f === (pf | 0x80);
      const isNormal = f === pf;
      if (!isException && !isNormal) continue;
      let len: number;
      if (isException) len = 5;
      else if (f >= 1 && f <= 4) {
        // 需要 byteCount 字节（i+2）；数据不足则继续扫描后续偏移，等待更多数据
        if (i + 3 > n) continue;
        len = 3 + this.buf[i + 2] + 2;
      } else len = 8;
      if (i + len > n) continue;
      const frame = Uint8Array.from(this.buf.slice(i, i + len));
      const crc = frame[len - 2] | (frame[len - 1] << 8);
      if (crc16(frame.subarray(0, len - 2)) !== crc) continue; // 坏帧，跳到下一个偏移
      out.push(parseFrame(frame));
      this.buf.splice(0, i + len);
      this.pendingFunc = null;
      return;
    }
    // 未找到有效帧：防止缓冲无限增长，超限丢最旧
    if (this.buf.length > 512) this.buf.splice(0, this.buf.length - 512);
  }
}
