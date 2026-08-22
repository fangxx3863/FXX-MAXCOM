// 交互式终端（模式 A）：xterm.js 承担 ANSI 解析与渲染（ADR-0018），击键直传
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { SessionApi } from "../api";

export class TerminalPage {
  private term = new Terminal({
    // \n 也视为换行（很多设备只发 \n；标准终端要求 \r\n，这里宽容处理）
    convertEol: true,
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Consolas, "Cascadia Mono", monospace',
    theme: {
      background: "#14161a",
      foreground: "#dce0e8",
      cursor: "#4da3ff",
    },
    scrollback: 10000,
  });
  private fit = new FitAddon();

  constructor(el: HTMLElement, private api: SessionApi, private onSendError?: (msg: string) => void) {
    // 宿主容器占工具条以下剩余空间；FitAddon 按 parentElement 测量，
    // 若直接以页面为父级会把工具条高度也算进行数 → 内容溢出引发整页滚动
    const host = document.createElement("div");
    host.className = "term-host";
    el.appendChild(host);

    this.term.loadAddon(this.fit);
    this.term.open(host);
    this.fit.fit();
    new ResizeObserver(() => this.fit.fit()).observe(host);

    // 击键直传：xterm 给出完整转义序列（方向键等），原样发往端口
    let localEcho = false;
    this.term.onData((data) => {
      this.api
        .send({ text: data, newline: "none" })
        .then(() => {
          if (localEcho) this.term.write(data); // 回显只在写入成功后做
        })
        .catch((e) => this.onSendError?.(`发送失败: ${e}`));
    });

    // 工具条：本地回显 / 清屏
    const bar = document.createElement("div");
    bar.className = "term-bar";
    const echoLabel = document.createElement("label");
    echoLabel.className = "chk";
    const echoChk = document.createElement("input");
    echoChk.type = "checkbox";
    echoChk.addEventListener("change", () => {
      localEcho = echoChk.checked;
    });
    echoLabel.append(echoChk, document.createTextNode("本地回显"));
    const clearBtn = document.createElement("button");
    clearBtn.textContent = "清屏";
    clearBtn.addEventListener("click", () => this.clear());
    bar.append(echoLabel, clearBtn);
    el.prepend(bar);

    // 原始流由 main 按会话路由进来（feed）；窗口尺寸变化时自适应。
    // 注意：resize 监听挂在 window 上，多标签共享无妨——fit 只作用于本实例。
    window.addEventListener("resize", () => this.fit.fit());
  }

  /** 原始字节流入终端渲染（main 的事件路由按 session 分发） */
  feed(bytes: Uint8Array) {
    this.term.write(bytes);
  }

  writeln(s: string) {
    this.term.writeln(s);
  }

  setFontSize(px: number) {
    this.term.options.fontSize = px;
    this.fit.fit();
  }

  setTheme(theme: { background: string; foreground: string; cursor: string }) {
    this.term.options.theme = theme;
  }

  clear() {
    // reset 连滚动缓冲一起清（clear() 只清视口上方，用户感知为'没清掉'）
    this.term.reset();
  }
}
