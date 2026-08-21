// 交互式终端（模式 A）：xterm.js 承担 ANSI 解析与渲染（ADR-0018），击键直传
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, on } from "../api";

export class TerminalPage {
  private term = new Terminal({
    convertEol: false,
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

  constructor(el: HTMLElement, private onSendError?: (msg: string) => void) {
    this.term.loadAddon(this.fit);
    this.term.open(el);
    this.fit.fit();
    new ResizeObserver(() => this.fit.fit()).observe(el);

    // 击键直传：xterm 给出完整转义序列（方向键等），原样发往端口
    let localEcho = false;
    this.term.onData((data) => {
      api
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

    // 原始流 → xterm 渲染
    void on.raw((bytes) => this.term.write(bytes));
    window.addEventListener("resize", () => this.fit.fit());
  }

  writeln(s: string) {
    this.term.writeln(s);
  }

  setFontSize(px: number) {
    this.term.options.fontSize = px;
    this.fit.fit();
  }

  clear() {
    // reset 连滚动缓冲一起清（clear() 只清视口上方，用户感知为'没清掉'）
    this.term.reset();
  }
}
