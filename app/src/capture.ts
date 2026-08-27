// 捕获相关纯函数：日志捕获格式 + 二进制捕获文件名（不含 DOM/Tauri 依赖，可单测）
import type { EntriesBatch } from "./types";

/** 日志捕获保存格式（设置下拉）。follow = 跟随当前标签页的显示格式 */
export type CaptureLogFormat = "absolute" | "relative" | "delta" | "follow";

/** 解析后的日志行时间戳前缀风格 */
export type ResolvedLogFmt = "date" | "time" | "relative" | "delta" | "none";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** 全日期时间戳：yyyy-MM-dd HH:mm:ss.SSS */
export function formatFullTs(wallMs: number): string {
  const d = new Date(wallMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 时分秒时间戳：HH:mm:ss.SSS */
export function formatTimeOnly(wallMs: number): string {
  const d = new Date(wallMs);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 时间戳前缀（末位带一个空格；none → 空串） */
export function formatTsPrefix(
  fmt: ResolvedLogFmt,
  tsMs: number,
  anchorMs: number,
  prevTsMs: number | null,
): string {
  switch (fmt) {
    case "none":
      return "";
    case "date":
      return formatFullTs(anchorMs + tsMs) + " ";
    case "time":
      return formatTimeOnly(anchorMs + tsMs) + " ";
    case "relative":
      return `+${tsMs}ms `;
    case "delta": {
      const base = prevTsMs ?? tsMs;
      const d = tsMs - base;
      return (d >= 0 ? `Δ+${d}ms` : `Δ${d}ms`) + " ";
    }
  }
}

/** 时间戳列固定宽度：相对/差值前缀可变长，padEnd 到该宽度让负载列对齐（date/time 已固定宽，不受影响） */
const CAPTURE_PAD = 12;

/** 把一条日志条目格式化为捕获行（不含续行合并）。相对/差值前缀对齐到固定列，文件更好看 */
export function captureLine(
  fmt: ResolvedLogFmt,
  tsMs: number,
  text: string,
  anchorMs: number,
  prevTsMs: number | null,
): string {
  const prefix = formatTsPrefix(fmt, tsMs, anchorMs, prevTsMs);
  if (fmt === "none") return text; // 无时间戳：负载顶到列 0
  return prefix.padEnd(CAPTURE_PAD) + text;
}

/** 把「设置格式 + 当前标签页时间戳模式」解析为实际行前缀风格 */
export function resolveLogFmt(setting: CaptureLogFormat, tabMode: string): ResolvedLogFmt {
  switch (setting) {
    case "absolute":
      return "date";
    case "relative":
      return "relative";
    case "delta":
      return "delta";
    case "follow":
      switch (tabMode) {
        case "none":
          return "none";
        case "relative":
          return "relative";
        case "delta":
          return "delta";
        default:
          return "time"; // 标签页 absolute（HH:mm:ss.SSS）
      }
  }
}

/** 日志捕获累计器：对齐收发页的 partial 续行语义，同一行只带一个时间戳 */
export class LogCapture {
  readonly fmt: ResolvedLogFmt;
  readonly startMs: number;
  /** HEX 显示模式开启时，捕获原始字节十六进制（raw_hex）而非解码文本 */
  hex = false;
  private lines: string[] = [];
  private prevTsMs: number | null = null;
  private pending: { ts: number; text: string } | null = null;
  private _count = 0;

  constructor(fmt: ResolvedLogFmt, startMs: number = Date.now()) {
    this.fmt = fmt;
    this.startMs = startMs;
  }

  get count(): number {
    return this._count;
  }

  feed(batch: EntriesBatch): void {
    const anchor = batch.epoch_anchor_ms;
    for (const item of batch.items) {
      const text = this.hex ? item.raw_hex : item.text;
      if (item.partial === true) {
        if (this.pending) {
          this.mergePartial(text);
        } else {
          this.pending = { ts: item.ts_ms, text };
        }
        continue;
      }
      if (this.pending) {
        this.mergePartial(text);
        this.flush(this.pending.ts, this.pending.text, anchor);
        this.pending = null;
      } else {
        this.flush(item.ts_ms, text, anchor);
      }
    }
  }

  /** partial 续行：hex 用空格分隔字节（raw_hex 为 "48 65" 式，直接拼会把字节粘死）；非 hex 直接拼接 */
  private mergePartial(text: string): void {
    if (this.pending) {
      if (this.hex && this.pending.text && text) this.pending.text += " ";
      this.pending.text += text;
    }
  }

  private flush(ts: number, text: string, anchor: number): void {
    this.lines.push(captureLine(this.fmt, ts, text, anchor, this.prevTsMs));
    this.prevTsMs = ts;
    this._count++;
  }

  /** 捕获完成的全文（含换行收尾） */
  content(): string {
    return this.lines.length ? this.lines.join("\n") + "\n" : "";
  }
}

/** 文件名茎：<名称>_<COM号>_<yyyymmdd-hhmmss_ms>（不含扩展名）。
    名称 = 自定义标签页名，否则设备制造商/产品名；COM号从设备路径取数字。 */
export function captureStem(name: string, device: string, startMs: number): string {
  const portName = sanitizeName(name || device || "device");
  const port = portToken(device);
  const d = new Date(startMs);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}`;
  return `CAP_${portName}${port ? `_${port}` : ""}_${stamp}`;
}

/** 文件名安全化：只替换 Windows 文件名非法字符/控制符；保留中文、字母、数字、点、下划线、连字符 */
function sanitizeName(s: string): string {
  return (
    s
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/[\x00-\x1f\x7f]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "device"
  );
}

/** 端口标识 token：COM14 / ttyUSB4 / tty4 / cu.usbserial-xxx（保留前缀，不剥成裸号） */
function portToken(device: string): string {
  const base = device.replace(/\\/g, "/").split("/").pop() ?? device;
  const m = base.match(/(tty(?:USB|ACM|AMA|S|O|LP|THS|XR)?\d+|cu\.[A-Za-z0-9._-]+|COM\d+)/i);
  return m ? m[0] : "";
}
