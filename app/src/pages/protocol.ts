// 协议页：左侧栏「协议」入口。采用协议注册表（PROTOCOLS）驱动，后续协议（CAN 等）只需在此注册
// 一项即可出现在顶部切换条中。当前实现 Modbus RTU（见 protocol-modbus.ts）。
// 传输复用当前标签页顶部栏连接（发送走 api.send，响应走 onRaw 原始流），不做二次串口管理。
//
// 架构：
//   ProtoDef        — 协议定义（id / 标签 / 面板构建器）
//   ProtoController — 协议运行期控制器（onRaw/setConnected/snapshot/applySnapshot）
//   ProtocolPage    — 顶栏协议切换 + 宿主挂载 + 连接状态 + 快照聚合
//
// 快照：每个协议的快照键做前缀隔离（modbus:i0 / can:i0），避免跨协议冲突；__active 记录当前选中协议。

import type { SessionApi } from "../api";
import { t } from "../i18n";
import { ModbusPanel } from "./protocol-modbus";

export interface ProtoCtx {
  api: SessionApi;
  getConnected: () => boolean;
}

export interface ProtoController {
  onRaw?(bytes: Uint8Array): void;
  setConnected?(on: boolean): void;
  snapshot?(): Record<string, string>;
  applySnapshot?(snap: Record<string, string>): void;
}

export interface ProtoDef {
  id: string;
  label: () => string;
  build: (host: HTMLElement, ctx: ProtoCtx) => ProtoController;
}

/** CAN 面板：占位，待后续实现（挂载即显示敬请期待）。 */
function canPanel(host: HTMLElement, _ctx: ProtoCtx): ProtoController {
  host.innerHTML = `<div class="proto-can">${t("protocol.canSoon")}</div>`;
  return {};
}

/** 协议注册表：顶部切换条按此顺序生成，新增协议在此追加一项即可。 */
const PROTOCOLS: ProtoDef[] = [
  { id: "modbus", label: () => t("protocol.modbus"), build: (h, c) => new ModbusPanel(h, c) },
  { id: "can", label: () => t("protocol.can"), build: canPanel },
];

export class ProtocolPage {
  private root: HTMLElement;
  private api: SessionApi;
  private getConnected: () => boolean;

  private tabsEl!: HTMLElement;
  private stackEl!: HTMLElement;
  private dotEl!: HTMLElement;
  private statusEl!: HTMLElement;

  private activeId = "";
  private active: ProtoController | null = null;
  private mounted = new Map<string, ProtoController>();
  private pendingSnap: Record<string, string> | null = null;

  constructor(root: HTMLElement, api: SessionApi, getConnected: () => boolean) {
    this.root = root;
    this.api = api;
    this.getConnected = getConnected;
    this.build();
    this.select(PROTOCOLS[0].id);
  }

  private q<T extends HTMLElement>(sel: string): T | null {
    return this.root.querySelector<T>(sel);
  }

  // ── DOM 构建 ──
  private build(): void {
    this.root.innerHTML = `
      <div class="proto-page">
        <div class="proto-tabs">
          ${PROTOCOLS.map((p) => `<button class="proto-tab" data-proto="${p.id}">${p.label()}</button>`).join("")}
        </div>
        <div class="proto-status"><span class="dot off" id="proto-dot"></span><span id="proto-status"></span></div>
        <div class="proto-stack">
          ${PROTOCOLS.map((p) => `<div class="proto-panel hidden" data-panel="${p.id}"></div>`).join("")}
        </div>
      </div>`;

    this.tabsEl = this.q(".proto-tabs")!;
    this.stackEl = this.q(".proto-stack")!;
    this.dotEl = this.q<HTMLElement>("#proto-dot")!;
    this.statusEl = this.q<HTMLElement>("#proto-status")!;

    this.tabsEl.querySelectorAll("button").forEach((btn) =>
      btn.addEventListener("click", () => this.select(btn.dataset.proto!)),
    );
    this.renderStatus(this.getConnected());
  }

  /** 从快照中抽取出某个协议的前缀隔离子集。 */
  private subsetFor(id: string, snap: Record<string, string>): Record<string, string> {
    const s: Record<string, string> = {};
    const pre = id + ":";
    for (const [k, v] of Object.entries(snap)) if (k.startsWith(pre)) s[k.slice(pre.length)] = v;
    return s;
  }

  private select(id: string): void {
    this.activeId = id;
    for (const btn of this.tabsEl.querySelectorAll<HTMLButtonElement>(".proto-tab"))
      btn.classList.toggle("active", btn.dataset.proto === id);
    for (const panel of this.stackEl.querySelectorAll<HTMLElement>("[data-panel]"))
      panel.classList.toggle("hidden", panel.dataset.panel !== id);

    let ctrl = this.mounted.get(id);
    if (!ctrl) {
      const def = PROTOCOLS.find((p) => p.id === id)!;
      const host = this.stackEl.querySelector<HTMLElement>(`[data-panel="${id}"]`)!;
      ctrl = def.build(host, { api: this.api, getConnected: this.getConnected });
      this.mounted.set(id, ctrl);
      ctrl.setConnected?.(this.getConnected());
      // 若已有快照（applySnapshot 早于本次挂载），回放该协议子集
      if (this.pendingSnap) ctrl.applySnapshot?.(this.subsetFor(id, this.pendingSnap));
    }
    this.active = ctrl;
  }

  // ── 对外 API（main.ts 调用；方法签名保持不变）──

  /** 协议页全局路由喂入原始流（仅活动协议消费解析） */
  onRaw(bytes: Uint8Array): void {
    this.active?.onRaw?.(bytes);
  }

  setConnected(on: boolean): void {
    this.renderStatus(on);
    for (const ctrl of this.mounted.values()) ctrl.setConnected?.(on);
  }

  private renderStatus(on: boolean): void {
    this.dotEl.className = `dot ${on ? "on" : "off"}`;
    this.statusEl.textContent = on ? t("protocol.connected") : t("protocol.notConnected");
  }

  snapshot(): Record<string, string> {
    const out: Record<string, string> = { __active: this.activeId };
    for (const [id, ctrl] of this.mounted) {
      const s = ctrl.snapshot?.();
      if (!s) continue;
      const pre = id + ":";
      for (const [k, v] of Object.entries(s)) out[pre + k] = v;
    }
    return out;
  }

  applySnapshot(snap: Record<string, string>): void {
    this.pendingSnap = snap;
    const act = snap["__active"];
    if (act && act !== this.activeId && PROTOCOLS.some((p) => p.id === act)) this.select(act);
    for (const [id, ctrl] of this.mounted) ctrl.applySnapshot?.(this.subsetFor(id, snap));
  }
}
