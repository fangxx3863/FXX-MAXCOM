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

  constructor(el: HTMLElement) {
    this.term.loadAddon(this.fit);
    this.term.open(el);
    this.fit.fit();
    new ResizeObserver(() => this.fit.fit()).observe(el);

    // 击键直传：xterm 给出完整转义序列（方向键等），原样发往端口
    this.term.onData((data) => {
      void api.send({ text: data, newline: "none" }).catch(() => {});
    });

    // 原始流 → xterm 渲染
    void on.raw((bytes) => this.term.write(bytes));
    window.addEventListener("resize", () => this.fit.fit());
  }

  writeln(s: string) {
    this.term.writeln(s);
  }

  clear() {
    this.term.clear();
  }
}
