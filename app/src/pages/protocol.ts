// 协议页：左侧栏「协议」入口。第一个协议实现为 Modbus RTU（参考 MODBUS 调试助手 V1.0）。
// 传输复用当前标签页顶部栏连接（发送走 api.send，响应走 onRaw 原始流），不做二次串口管理。
// 全部为纯前端逻辑（app/src/modbus.ts），浏览器演示模式与桌面端行为一致。
//
// 布局：顶部连接状态条 + 两列卡片栅格（读 01/02/03/04、写 05/06/0x10、任意指令、收发缓冲区）。

import type { SessionApi } from "../api";
import { t } from "../i18n";
import {
  ModbusRx, buildRead, buildWriteCoil, buildWriteReg, buildWriteMulti,
  hexToBytes, bytesToHex, bytesToHexSpaced, parseNum, parseRegList,
  exceptionText, appendCrc, type ModbusResponse,
} from "../modbus";

/** 卡片上的结果文本（一行）。 */
type ResultFmt = (r: ModbusResponse, reqCount: number) => string;

interface ActiveReq {
  el: HTMLElement;
  fmt: ResultFmt;
  count: number;
}

const MAX_BUF = 4096; // 收发缓冲区显示字节上限

export class ProtocolPage {
  private root: HTMLElement;
  private api: SessionApi;
  private getConnected: () => boolean;

  private rxBus = new ModbusRx();
  /** 展示用接收缓冲（不随解析消费） */
  private rxShow: number[] = [];
  /** 展示用发送缓冲 */
  private txShow: number[] = [];

  private active: ActiveReq | null = null;
  private reqTimer: number | null = null;

  // 输入引用（wire 时填充）
  private statusEl!: HTMLElement;
  private txView!: HTMLTextAreaElement;
  private rxView!: HTMLTextAreaElement;

  constructor(root: HTMLElement, api: SessionApi, getConnected: () => boolean) {
    this.root = root;
    this.api = api;
    this.getConnected = getConnected;
    this.build();
    this.renderStatus();
  }

  // ── DOM 构建 ──
  private build(): void {
    this.root.innerHTML = `
      <div class="proto-page">
        <div class="proto-status"><span class="dot off" id="proto-dot"></span><span id="proto-status"></span></div>
        <div class="proto-grid">
          ${this.readCard(1, "1")}
          ${this.readCard(2, "0")}
          ${this.readCard(3, "40")}
          ${this.readCard(4, "0x40")}
          ${this.writeCoilCard()}
          ${this.writeRegCard()}
          ${this.writeMultiCard()}
          ${this.arbitraryCard()}
          <div class="proto-card proto-buf">
            <div class="proto-card-head">${t("protocol.txBuf")}</div>
            <textarea id="proto-tx" class="proto-buf-view" readonly spellcheck="false"></textarea>
            <div class="proto-buf-foot"><button class="ghost" id="proto-tx-clear">${t("protocol.clear")}</button></div>
          </div>
          <div class="proto-card proto-buf">
            <div class="proto-card-head">${t("protocol.rxBuf")}</div>
            <textarea id="proto-rx" class="proto-buf-view" readonly spellcheck="false"></textarea>
            <div class="proto-buf-foot"><button class="ghost" id="proto-rx-clear">${t("protocol.clear")}</button></div>
          </div>
        </div>
      </div>`;

    this.statusEl = this.q("#proto-status")!;
    this.txView = this.q<HTMLTextAreaElement>("#proto-tx")!;
    this.rxView = this.q<HTMLTextAreaElement>("#proto-rx")!;

    this.q("#proto-tx-clear")!.addEventListener("click", () => {
      this.txShow = [];
      this.txView.value = "";
    });
    this.q("#proto-rx-clear")!.addEventListener("click", () => {
      this.rxShow = [];
      this.rxView.value = "";
      this.rxBus.clearBuf();
    });

    // 读卡
    for (const func of [1, 2, 3, 4] as const) this.wireReadCard(func);
    // 写卡
    this.wireWriteCoil();
    this.wireWriteReg();
    this.wireWriteMulti();
    this.wireArbitrary();
    this.updateConnected(this.getConnected());
  }

  private q<T extends HTMLElement>(sel: string): T | null {
    return this.root.querySelector<T>(sel);
  }

  // ── 卡片模板 ──
  private card(title: string, body: string): string {
    return `<div class="proto-card"><div class="proto-card-head">${title}</div><div class="proto-card-body">${body}</div></div>`;
  }

  private readCard(func: number, startValue: string): string {
    const title =
      func === 1 ? t("protocol.f01")
      : func === 2 ? t("protocol.f02")
      : func === 3 ? t("protocol.f03")
      : t("protocol.f04");
    return this.card(
      title,
      `<div class="proto-row">
        <label class="proto-lab">${t("protocol.slave")}<input class="proto-in" data-slave value="1" /></label>
        <label class="proto-lab">${t("protocol.regAddr")}<input class="proto-in" data-start value="${startValue}" title="${t("protocol.regAddr")}" /></label>
        <label class="proto-lab">${t("protocol.regCount")}<input class="proto-in" data-count value="1" /></label>
        <button class="primary proto-go" data-read="${func}">${t("protocol.read")}</button>
      </div>
      <div class="proto-result" data-result>${t("protocol.empty")}</div>`,
    );
  }

  private writeCoilCard(): string {
    return this.card(
      t("protocol.f05"),
      `<div class="proto-row">
        <label class="proto-lab">${t("protocol.slave")}<input class="proto-in" data-slave value="1" /></label>
        <label class="proto-lab">${t("protocol.regAddr")}<input class="proto-in" data-addr value="1" /></label>
        <label class="proto-lab">${t("protocol.coilValue")}<input class="proto-in" data-value value="0" title="0=关 非0=开" /></label>
        <button class="primary proto-go" data-write="5">${t("protocol.send")}</button>
      </div>
      <div class="proto-result" data-result>${t("protocol.empty")}</div>`,
    );
  }

  private writeRegCard(): string {
    return this.card(
      t("protocol.f06"),
      `<div class="proto-row">
        <label class="proto-lab">${t("protocol.slave")}<input class="proto-in" data-slave value="1" /></label>
        <label class="proto-lab">${t("protocol.regAddr")}<input class="proto-in" data-addr value="1" /></label>
        <label class="proto-lab">${t("protocol.regValue")}<input class="proto-in" data-value value="0" /></label>
        <button class="primary proto-go" data-write="6">${t("protocol.send")}</button>
      </div>
      <div class="proto-result" data-result>${t("protocol.empty")}</div>`,
    );
  }

  private writeMultiCard(): string {
    return this.card(
      t("protocol.f10"),
      `<div class="proto-row">
        <label class="proto-lab">${t("protocol.slave")}<input class="proto-in" data-slave value="1" /></label>
        <label class="proto-lab">${t("protocol.regAddr")}<input class="proto-in" data-addr value="0" /></label>
        <label class="proto-lab proto-lab-wide">${t("protocol.regValues")}<input class="proto-in" data-values value="1 2 3" title="${t("protocol.regValues")}" /></label>
        <button class="primary proto-go" data-write="16">${t("protocol.send")}</button>
      </div>
      <div class="proto-result" data-result>${t("protocol.empty")}</div>`,
    );
  }

  private arbitraryCard(): string {
    return this.card(
      t("protocol.arbitrary"),
      `<div class="proto-row proto-arb">
        <textarea class="proto-in proto-arb-in" data-arb placeholder="${t("protocol.arbitraryPlaceholder")}" rows="1"></textarea>
        <button class="primary proto-go" data-arb-send>${t("protocol.send")}</button>
        <button class="primary proto-go" data-arb-crc>${t("protocol.crcSend")}</button>
      </div>
      <div class="proto-result" data-result>${t("protocol.empty")}</div>`,
    );
  }

  // ── 读卡接线 ──
  private wireReadCard(func: 1 | 2 | 3 | 4): void {
    const btn = this.q<HTMLButtonElement>(`[data-read="${func}"]`)!;
    btn.addEventListener("click", () => {
      const card = btn.closest(".proto-card") as HTMLElement;
      const res = card.querySelector<HTMLElement>("[data-result]")!;
      const slave = this.readNum(card, "slave");
      const start = this.readNum(card, "start");
      const count = this.readNum(card, "count");
      if (slave === null || start === null || count === null || count < 1) {
        return this.showMsg(res, t("protocol.invalidInput"), true);
      }
      const frame = buildRead(slave, func, start, count);
      const fmt: ResultFmt = (r, reqCount) => {
        if (r.kind === "exception") return t("protocol.respErr", { code: `${r.code} ${exceptionText(r.code)}` });
        if (r.kind === "bits") return t("protocol.bitsResult", { n: reqCount, bits: r.bits.slice(0, reqCount).join(" ") });
        if (r.kind === "regs") return t("protocol.regsResult", { n: r.values.length, vals: r.values.join(", ") });
        return t("protocol.unexpected");
      };
      this.doRequest(frame, func, count, res, fmt);
    });
  }

  // ── 写卡接线 ──
  private wireWriteCoil(): void {
    const btn = this.q<HTMLButtonElement>(`[data-write="5"]`)!;
    btn.addEventListener("click", () => {
      const card = btn.closest(".proto-card") as HTMLElement;
      const res = card.querySelector<HTMLElement>("[data-result]")!;
      const slave = this.readNum(card, "slave");
      const addr = this.readNum(card, "addr");
      const val = this.readNum(card, "value");
      if (slave === null || addr === null || val === null) return this.showMsg(res, t("protocol.invalidInput"), true);
      const on = val !== 0;
      const frame = buildWriteCoil(slave, addr, on);
      const fmt: ResultFmt = (r) => {
        if (r.kind === "exception") return t("protocol.respErr", { code: `${r.code} ${exceptionText(r.code)}` });
        if (r.kind !== "write") return t("protocol.unexpected");
        return t("protocol.writeOk", { address: r.address, value: r.value === 0xff00 ? t("protocol.on") : t("protocol.off") });
      };
      this.doRequest(frame, 5, 1, res, fmt);
    });
  }

  private wireWriteReg(): void {
    const btn = this.q<HTMLButtonElement>(`[data-write="6"]`)!;
    btn.addEventListener("click", () => {
      const card = btn.closest(".proto-card") as HTMLElement;
      const res = card.querySelector<HTMLElement>("[data-result]")!;
      const slave = this.readNum(card, "slave");
      const addr = this.readNum(card, "addr");
      const val = this.readNum(card, "value");
      if (slave === null || addr === null || val === null || val < 0 || val > 0xffff)
        return this.showMsg(res, t("protocol.invalidInput"), true);
      const frame = buildWriteReg(slave, addr, val);
      const fmt: ResultFmt = (r) => {
        if (r.kind === "exception") return t("protocol.respErr", { code: `${r.code} ${exceptionText(r.code)}` });
        if (r.kind !== "write") return t("protocol.unexpected");
        return t("protocol.writeOk", { address: r.address, value: r.value ?? "?" });
      };
      this.doRequest(frame, 6, 1, res, fmt);
    });
  }

  private wireWriteMulti(): void {
    const btn = this.q<HTMLButtonElement>(`[data-write="16"]`)!;
    btn.addEventListener("click", () => {
      const card = btn.closest(".proto-card") as HTMLElement;
      const res = card.querySelector<HTMLElement>("[data-result]")!;
      const slave = this.readNum(card, "slave");
      const addr = this.readNum(card, "addr");
      const raw = card.querySelector<HTMLInputElement>("[data-values]")!.value;
      let values: number[];
      try {
        values = parseRegList(raw);
      } catch {
        return this.showMsg(res, t("protocol.invalidInput"), true);
      }
      if (slave === null || addr === null) return this.showMsg(res, t("protocol.invalidInput"), true);
      const frame = buildWriteMulti(slave, addr, values);
      const fmt: ResultFmt = (r) => {
        if (r.kind === "exception") return t("protocol.respErr", { code: `${r.code} ${exceptionText(r.code)}` });
        if (r.kind !== "write") return t("protocol.unexpected");
        return t("protocol.writeMultiOk", { address: r.address, count: r.count ?? values.length });
      };
      this.doRequest(frame, 0x10, values.length, res, fmt);
    });
  }

  private wireArbitrary(): void {
    const card = this.root.querySelector<HTMLElement>("[data-arb]")!.closest(".proto-card") as HTMLElement;
    const send = this.q<HTMLButtonElement>("[data-arb-send]")!;
    const crcSend = this.q<HTMLButtonElement>("[data-arb-crc]")!;
    const onArb = (withCrc: boolean) => {
      const input = card.querySelector<HTMLTextAreaElement>("[data-arb]")!;
      const res = card.querySelector<HTMLElement>("[data-result]");
      if (!this.getConnected()) {
        if (res) this.showMsg(res, t("protocol.notConnected"), true);
        return;
      }
      let bytes: Uint8Array;
      try {
        bytes = hexToBytes(input.value);
      } catch {
        if (res) this.showMsg(res, t("protocol.invalidInput"), true);
        return;
      }
      if (!bytes.length) {
        if (res) this.showMsg(res, t("protocol.invalidInput"), true);
        return;
      }
      const frame = withCrc ? appendCrc(bytes) : bytes;
      this.txLog(frame);
      // 任意指令不设 pending（只做原始收发，不做帧解析）
      this.rxBus.clearPending();
      this.api.send({ hex: bytesToHex(frame), newline: "none" }).catch((e) => {
        if (res) this.showMsg(res, t("protocol.sendError", { e }), true);
      });
    };
    send.addEventListener("click", () => onArb(false));
    crcSend.addEventListener("click", () => onArb(true));
  }

  // ── 请求 / 响应流水 ──
  private doRequest(frame: Uint8Array, func: number, count: number, res: HTMLElement, fmt: ResultFmt): void {
    if (!this.getConnected()) return this.showMsg(res, t("protocol.notConnected"), true);
    this.clearReqTimer();
    this.txLog(frame);
    this.rxBus.setPending(func);
    this.active = { el: res, fmt, count };
    this.reqTimer = window.setTimeout(() => {
      this.clearReqTimer();
      this.rxBus.clearPending();
      this.active = null;
      this.showMsg(res, t("protocol.timeout"), true);
    }, 1500);
    this.api.send({ hex: bytesToHex(frame), newline: "none" }).catch((e) => {
      this.clearReqTimer();
      this.rxBus.clearPending();
      this.active = null;
      this.showMsg(res, t("protocol.sendError", { e }), true);
    });
  }

  private handleResponse(r: ModbusResponse): void {
    if (!this.active) return;
    const a = this.active;
    this.clearReqTimer();
    this.active = null;
    this.showMsg(a.el, a.fmt(r, a.count), r.kind === "exception");
  }

  private clearReqTimer(): void {
    if (this.reqTimer !== null) window.clearTimeout(this.reqTimer);
    this.reqTimer = null;
  }

  /** session 原始流喂入（main.ts 全局路由 → 本页） */
  onRaw(bytes: Uint8Array): void {
    // 展示缓冲（不消费）
    this.rxShow.push(...Array.from(bytes));
    if (this.rxShow.length > MAX_BUF) this.rxShow.splice(0, this.rxShow.length - MAX_BUF);
    this.renderRx();
    // 解析缓冲（消费匹配帧）
    const rs = this.rxBus.push(bytes);
    for (const r of rs) this.handleResponse(r);
  }

  setConnected(on: boolean): void {
    this.updateConnected(on);
  }

  private updateConnected(on: boolean): void {
    const dot = this.q<HTMLElement>("#proto-dot")!;
    dot.className = `dot ${on ? "on" : "off"}`;
    this.statusEl.textContent = on ? t("protocol.connected") : t("protocol.notConnected");
    this.root.querySelectorAll<HTMLButtonElement>(".proto-go").forEach((b) => (b.disabled = !on));
  }

  private renderStatus(): void {
    this.updateConnected(this.getConnected());
  }

  private txLog(frame: Uint8Array): void {
    this.txShow.push(...Array.from(frame));
    if (this.txShow.length > MAX_BUF) this.txShow.splice(0, this.txShow.length - MAX_BUF);
    this.txView.value = bytesToHexSpaced(Uint8Array.from(this.txShow));
    this.txView.scrollTop = this.txView.scrollHeight;
  }

  private renderRx(): void {
    this.rxView.value = bytesToHexSpaced(Uint8Array.from(this.rxShow));
    this.rxView.scrollTop = this.rxView.scrollHeight;
  }

  // ── 工具 ──
  private readNum(card: HTMLElement, key: string): number | null {
    const el = card.querySelector<HTMLInputElement>(`[data-${key}]`);
    if (!el) return null;
    return parseNum(el.value);
  }

  private showMsg(el: HTMLElement, msg: string, err: boolean): void {
    el.textContent = msg;
    el.classList.toggle("err", err);
    el.classList.toggle("ok", !err);
  }

  // ── 持久化（随标签快照）──
  snapshot(): Record<string, string> {
    const store: Record<string, string> = {};
    let i = 0;
    for (const input of this.root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".proto-in")) {
      store[`i${i}`] = input.value;
      i++;
    }
    return store;
  }

  applySnapshot(s: Record<string, string>): void {
    const inputs = this.root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".proto-in");
    inputs.forEach((el, i) => {
      const v = s[`i${i}`];
      if (v !== undefined) el.value = v;
    });
  }
}
