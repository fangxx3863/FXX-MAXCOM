// 工具页：左侧栏「工具」入口。以卡片目录 + 详情页方式提供嵌入式常用计算器。
// 每个工具注册一个 ToolDef（标题/图标/说明/构建器）。构建器返回 ToolController，负责自己的 DOM 与事件。
import { t } from "../i18n";
import katex from "katex";
import "katex/dist/katex.min.css";
import { toolDiagram, toolDiagramVariant } from "../tools-diagrams";
import {
  mono555, astable555, attenuator as attn,
  capCode3, batteryLifeHours, ohmLaw, reactance as rx,
  rcTau, ledResistor, filterFc, dbmToMwt, capDischarge,
  seriesRes, parallelRes, seriesCap, parallelCap,
} from "../tools-math";

function math(src: string): string {
  return katex.renderToString(src, { throwOnError: false, displayMode: false });
}


// ── 类型 ──
export interface ToolController {
  destroy?(): void;
  snapshot?(): Record<string, string>;
  applySnapshot?(snap: Record<string, string>): void;
}

export interface ToolDef {
  id: string;
  icon: string;
  title: string;
  desc: string;
  build: (host: HTMLElement) => ToolController;
}

// ── 小工具 ──
function num(v: string): number | null {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function fmt(v: number, digits = 6): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  if (Math.abs(v) >= 1e12 || (Math.abs(v) < 1e-6 && Math.abs(v) > 0)) return v.toExponential(4);
  const s = v.toFixed(digits);
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 电阻/电容的可读单位格式化（避免一大串 0）
function fmtOhm(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e6) return `${fmt(v / 1e6)} MΩ`;
  if (v >= 1e3) return `${fmt(v / 1e3)} kΩ`;
  if (v >= 1) return `${fmt(v)} Ω`;
  if (v >= 1e-3) return `${fmt(v * 1e3)} mΩ`;
  if (v >= 1e-6) return `${fmt(v * 1e6)} µΩ`;
  return `${fmt(v)} Ω`;
}

function fmtCap(pf: number): string {
  if (!Number.isFinite(pf)) return "—";
  if (pf >= 1e12) return `${fmt(pf / 1e12)} F`;
  if (pf >= 1e9) return `${fmt(pf / 1e9)} mF`;
  if (pf >= 1e6) return `${fmt(pf / 1e6)} µF`;
  if (pf >= 1e3) return `${fmt(pf / 1e3)} nF`;
  return `${fmt(pf)} pF`;
}

// ── 通用单位换算器 ──
interface UnitDef {
  id: string;
  symbol: string;
  factor: number;
  offset: number;
}

const UNITS = {
  length: [
    { id: "mm", symbol: "mm", factor: 0.001, offset: 0 },
    { id: "cm", symbol: "cm", factor: 0.01, offset: 0 },
    { id: "m", symbol: "m", factor: 1, offset: 0 },
    { id: "km", symbol: "km", factor: 1000, offset: 0 },
    { id: "in", symbol: "in", factor: 0.0254, offset: 0 },
    { id: "ft", symbol: "ft", factor: 0.3048, offset: 0 },
    { id: "yd", symbol: "yd", factor: 0.9144, offset: 0 },
    { id: "mi", symbol: "mi", factor: 1609.344, offset: 0 },
  ],
  weight: [
    { id: "mg", symbol: "mg", factor: 1e-6, offset: 0 },
    { id: "g", symbol: "g", factor: 0.001, offset: 0 },
    { id: "kg", symbol: "kg", factor: 1, offset: 0 },
    { id: "t", symbol: "t", factor: 1000, offset: 0 },
    { id: "oz", symbol: "oz", factor: 0.028349523125, offset: 0 },
    { id: "lb", symbol: "lb", factor: 0.45359237, offset: 0 },
  ],
  volume: [
    { id: "ml", symbol: "mL", factor: 0.001, offset: 0 },
    { id: "l", symbol: "L", factor: 1, offset: 0 },
    { id: "m3", symbol: "m³", factor: 1000, offset: 0 },
    { id: "floz", symbol: "fl oz (US)", factor: 0.0295735295625, offset: 0 },
    { id: "gal", symbol: "gal (US)", factor: 3.785411784, offset: 0 },
  ],
  pressure: [
    { id: "pa", symbol: "Pa", factor: 1, offset: 0 },
    { id: "kpa", symbol: "kPa", factor: 1000, offset: 0 },
    { id: "mpa", symbol: "MPa", factor: 1e6, offset: 0 },
    { id: "bar", symbol: "bar", factor: 100000, offset: 0 },
    { id: "atm", symbol: "atm", factor: 101325, offset: 0 },
    { id: "psi", symbol: "psi", factor: 6894.757293168, offset: 0 },
    { id: "mmhg", symbol: "mmHg", factor: 133.322387415, offset: 0 },
  ],
  energy: [
    { id: "j", symbol: "J", factor: 1, offset: 0 },
    { id: "kj", symbol: "kJ", factor: 1000, offset: 0 },
    { id: "wh", symbol: "Wh", factor: 3600, offset: 0 },
    { id: "kwh", symbol: "kWh", factor: 3.6e6, offset: 0 },
    { id: "cal", symbol: "cal", factor: 4.184, offset: 0 },
    { id: "kcal", symbol: "kcal", factor: 4184, offset: 0 },
    { id: "btu", symbol: "BTU", factor: 1055.05585262, offset: 0 },
  ],
  force: [
    { id: "n", symbol: "N", factor: 1, offset: 0 },
    { id: "kn", symbol: "kN", factor: 1000, offset: 0 },
    { id: "mn", symbol: "mN", factor: 0.001, offset: 0 },
    { id: "kgf", symbol: "kgf", factor: 9.80665, offset: 0 },
    { id: "lbf", symbol: "lbf", factor: 4.4482216152605, offset: 0 },
  ],
  power: [
    { id: "mw", symbol: "mW", factor: 0.001, offset: 0 },
    { id: "w", symbol: "W", factor: 1, offset: 0 },
    { id: "kw", symbol: "kW", factor: 1000, offset: 0 },
    { id: "hp", symbol: "hp", factor: 745.6998715822702, offset: 0 },
    { id: "ps", symbol: "PS", factor: 735.49875, offset: 0 },
  ],
  inductance: [
    { id: "nh", symbol: "nH", factor: 1e-9, offset: 0 },
    { id: "uh", symbol: "µH", factor: 1e-6, offset: 0 },
    { id: "mh", symbol: "mH", factor: 1e-3, offset: 0 },
    { id: "h", symbol: "H", factor: 1, offset: 0 },
  ],
  frequency: [
    { id: "hz", symbol: "Hz", factor: 1, offset: 0 },
    { id: "khz", symbol: "kHz", factor: 1e3, offset: 0 },
    { id: "mhz", symbol: "MHz", factor: 1e6, offset: 0 },
    { id: "ghz", symbol: "GHz", factor: 1e9, offset: 0 },
  ],
  temperature: [
    { id: "c", symbol: "°C", factor: 1, offset: 0 },
    { id: "f", symbol: "°F", factor: 5 / 9, offset: -32 * 5 / 9 },
    { id: "k", symbol: "K", factor: 1, offset: -273.15 },
  ],
} satisfies Record<string, UnitDef[]>;

function optionsHtml(units: UnitDef[], selected: string): string {
  return units.map((u) => `<option value="${u.id}"${u.id === selected ? " selected" : ""}>${esc(u.symbol)}</option>`).join("");
}

function buildUnitConverter(
  host: HTMLElement,
  units: UnitDef[],
  fromId: string,
  toId: string,
  hint: string,
): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field">
          <label>${t("tools.input")}</label>
          <div class="tool-inline"><input class="tool-input proto-in" placeholder="${esc(hint)}" /><select class="tool-sel proto-in">${optionsHtml(units, fromId)}</select></div>
        </div>
        <div class="tool-field">
          <label>${t("tools.result")}</label>
          <div class="tool-inline"><input class="tool-output proto-in" readonly placeholder="—" /><select class="tool-sel proto-in">${optionsHtml(units, toId)}</select></div>
        </div>
      </div>
      <div class="tool-resultline">${t("tools.formula")}: × / ÷ 单位制</div>
    </div>`;
  const input = host.querySelector<HTMLInputElement>(".tool-input")!;
  const output = host.querySelector<HTMLInputElement>(".tool-output")!;
  const selFrom = host.querySelector<HTMLSelectElement>(".tool-grid .tool-field:nth-child(1) .tool-sel")!;
  const selTo = host.querySelector<HTMLSelectElement>(".tool-grid .tool-field:nth-child(2) .tool-sel")!;
  const update = () => {
    const u = units.find((x) => x.id === selFrom.value) ?? units[0];
    const v = units.find((x) => x.id === selTo.value) ?? units[0];
    const n = num(input.value);
    if (n === null) {
      output.value = "";
      return;
    }
    const base = n * u.factor + u.offset;
    const r = (base - v.offset) / v.factor;
    output.value = `${fmt(r)} ${v.symbol}`;
  };
  input.addEventListener("input", update);
  selFrom.addEventListener("change", update);
  selTo.addEventListener("change", update);
  update();
  return {};
}

// ── 555 定时器（单稳态 / 非稳态）──
function build555(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-tabs">
        <button class="tool-tab active" data-mode="mono">单稳态 (单触发)</button>
        <button class="tool-tab" data-mode="astable">非稳态 (自由运行)</button>
      </div>
      <div class="tools-diagram" id="t555-diagram"><img class="tool-diagram" alt="555 电路原理图" /></div>
      <div class="tool-grid" id="t555-grid">
        <div class="tool-field"><label>R₁ 电阻值</label><div class="tool-inline"><input id="t555-r1" class="proto-in" type="number" min="0" value="100" /><select id="t555-r1s" class="tool-sel proto-in"><option value="1">Ω</option><option value="1e3">kΩ</option><option value="1e6">MΩ</option></select></div></div>
        <div class="tool-field"><label>C₁ 电容值</label><div class="tool-inline"><input id="t555-c" class="proto-in" type="number" min="0" value="10" /><select id="t555-cs" class="tool-sel proto-in"><option value="1e-12">pF</option><option value="1e-9">nF</option><option value="1e-6" selected>µF</option><option value="1e-3">mF</option><option value="1">F</option></select></div></div>
        <div class="tool-field" id="t555-out-box"><label>输出脉冲持续时间</label><div class="tool-inline"><input id="t555-out" class="tool-output proto-in" readonly placeholder="—" /><select id="t555-os" class="tool-sel proto-in"><option value="1e-3" selected>ms</option><option value="1">s</option><option value="60">min</option></select></div></div>
      </div>
      <div class="tool-formula" id="t555-formula"></div>
    </div>`;
  const diagramBox = host.querySelector<HTMLElement>("#t555-diagram")!;
  const img = diagramBox.querySelector<HTMLImageElement>("img")!;
  const r1 = host.querySelector<HTMLInputElement>("#t555-r1")!;
  const r1s = host.querySelector<HTMLSelectElement>("#t555-r1s")!;
  const c = host.querySelector<HTMLInputElement>("#t555-c")!;
  const cs = host.querySelector<HTMLSelectElement>("#t555-cs")!;
  const out = host.querySelector<HTMLInputElement>("#t555-out")!;
  const os = host.querySelector<HTMLSelectElement>("#t555-os")!;
  const formula = host.querySelector<HTMLElement>("#t555-formula")!;
  const grid = host.querySelector<HTMLElement>("#t555-grid")!;
  const outBox = host.querySelector<HTMLElement>("#t555-out-box")!;

  let mode = "mono";
  img.src = toolDiagramVariant("555", mode);
  // 非稳态额外需要 R2：动态插入一个字段
  const r2Field = document.createElement("div");
  r2Field.className = "tool-field";
  r2Field.innerHTML = `<label>R₂ 电阻值</label><div class="tool-inline"><input id="t555-r2" class="proto-in" type="number" min="0" value="47" /><select id="t555-r2s" class="tool-sel proto-in"><option value="1">Ω</option><option value="1e3" selected>kΩ</option><option value="1e6">MΩ</option></select></div></div>`;

  const update = () => {
    const r1v = num(r1.value);
    const cv = num(c.value);
    const r1m = Number(r1s.value);
    const cm = Number(cs.value);
    const om = Number(os.value);
    const R1 = r1v === null ? null : r1v * r1m;
    const C = cv === null ? null : cv * cm;
    if (mode === "mono") {
      formula.innerHTML = math("T = 1.1 \\times R_1 \\times C_1");
      if (R1 === null || C === null) { out.value = ""; return; }
      const t = mono555(R1, C);
      out.value = `${fmt(t / om)} ${os.selectedOptions[0].textContent}`;
      return;
    }
    // 非稳态
    const r2v = num((host.querySelector("#t555-r2") as HTMLInputElement).value);
    const r2m = Number((host.querySelector("#t555-r2s") as HTMLSelectElement).value);
    const R2 = r2v === null ? null : r2v * r2m;
    if (R1 === null || R2 === null || C === null || R1 <= 0 || R2 <= 0 || C <= 0) {
      out.value = ""; return;
    }
    const a = astable555(R1, R2, C);
    formula.innerHTML = math(
      `t_H = 0.693(R_1{+}R_2)C_1,\\quad t_L = 0.693\\,R_2 C_1,\\quad f=\\dfrac{1.44}{(R_1{+}2R_2)C_1}`,
    );
    out.value = `f=${fmt(a.freq)} Hz  t_H=${fmt(a.tHigh / om)} ms  t_L=${fmt(a.tLow / om)} ms  占空比=${fmt(a.duty * 100, 4)}%`;
  };

  const setMode = (m: string) => {
    mode = m;
    img.src = toolDiagramVariant("555", m);
    if (m === "astable") {
      if (!host.querySelector("#t555-r2")) {
        grid.insertBefore(r2Field, outBox);
      }
      outBox.querySelector("label")!.textContent = "输出特性";
    } else {
      host.querySelector("#t555-r2")?.remove();
      outBox.querySelector("label")!.textContent = "输出脉冲持续时间";
    }
    update();
  };
  host.querySelectorAll<HTMLButtonElement>(".tool-tab").forEach((b) =>
    b.addEventListener("click", () => {
      host.querySelectorAll(".tool-tab").forEach((x) => x.classList.toggle("active", x === b));
      setMode(b.dataset.mode!);
    }),
  );
  [r1, c].forEach((el) => el.addEventListener("input", update));
  [r1s, cs, os].forEach((el) => el.addEventListener("change", update));
  update();
  return {};
}

// ── 电池续航 ──
function buildBatteryLife(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>电池容量</label><div class="tool-inline"><input id="bt-cap" class="proto-in" type="number" min="0" value="1000" /><select id="bt-capu" class="tool-sel proto-in"><option value="1" selected>mAh</option><option value="1000">Ah</option><option value="0.001">µAh</option></select></div></div>
        <div class="tool-field"><label>设备功耗</label><div class="tool-inline"><input id="bt-cur" class="proto-in" type="number" min="0" value="100" /><select id="bt-curu" class="tool-sel proto-in"><option value="1" selected>mA</option><option value="1000">A</option><option value="0.001">µA</option></select></div></div>
        <div class="tool-field"><label>电池续航时间</label><div class="tool-inline"><input id="bt-out" class="tool-output proto-in" readonly placeholder="—" /><select id="bt-outu" class="tool-sel proto-in"><option value="1" selected>小时</option><option value="1/24">天</option><option value="1/8760">年</option></select></div></div>
      </div>
      <div class="tool-formula">${math("Battery\\ Life = \\dfrac{Battery\\ Capacity}{Load\\ Current}")}</div>
    </div>`;
  const update = () => {
    const cap = num((host.querySelector("#bt-cap") as HTMLInputElement).value);
    const cur = num((host.querySelector("#bt-cur") as HTMLInputElement).value);
    if (cap === null || cur === null) {
      (host.querySelector("#bt-out") as HTMLInputElement).value = "";
      return;
    }
    const capu = Number((host.querySelector("#bt-capu") as HTMLSelectElement).value);
    const curu = Number((host.querySelector("#bt-curu") as HTMLSelectElement).value);
    const outu = Number((host.querySelector("#bt-outu") as HTMLSelectElement).value);
    const hr = batteryLifeHours(cap * capu, cur * curu);
    (host.querySelector("#bt-out") as HTMLInputElement).value = `${fmt(hr * outu)} ${(host.querySelector("#bt-outu") as HTMLSelectElement).selectedOptions[0].textContent}`;
  };
  host.querySelectorAll("input,select").forEach((el) => el.addEventListener("input", update));
  host.querySelectorAll("select").forEach((el) => el.addEventListener("change", update));
  update();
  return {};
}

// ── 电容换算（含代码）──
function buildCapacitanceConversion(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>皮法</label><div class="tool-inline"><input id="cap-pf" class="proto-in" type="number" min="0" placeholder="pF" /></div></div>
        <div class="tool-field"><label>纳法</label><div class="tool-inline"><input id="cap-nf" class="proto-in" type="number" min="0" placeholder="nF" /></div></div>
        <div class="tool-field"><label>微法</label><div class="tool-inline"><input id="cap-uf" class="proto-in" type="number" min="0" placeholder="µF" /></div></div>
        <div class="tool-field"><label>法拉</label><div class="tool-inline"><input id="cap-f" class="proto-in" type="number" min="0" placeholder="F" /></div></div>
        <div class="tool-field"><label>三位代码</label><div class="tool-inline"><input id="cap-code" class="proto-in" type="text" value="104" placeholder="如 104" /></div></div>
      </div>
      <div class="tool-resultline" id="cap-result"></div>
    </div>`;
  const pf = host.querySelector<HTMLInputElement>("#cap-pf")!;
  const nf = host.querySelector<HTMLInputElement>("#cap-nf")!;
  const uf = host.querySelector<HTMLInputElement>("#cap-uf")!;
  const f = host.querySelector<HTMLInputElement>("#cap-f")!;
  const code = host.querySelector<HTMLInputElement>("#cap-code")!;
  const result = host.querySelector<HTMLElement>("#cap-result")!;
  const setAll = (vpf: number | null) => {
    if (vpf === null) {
      pf.value = nf.value = uf.value = f.value = "";
      result.textContent = "—";
      return;
    }
    pf.value = fmt(vpf);
    nf.value = fmt(vpf / 1e3);
    uf.value = fmt(vpf / 1e6);
    f.value = fmt(vpf / 1e12);
    result.textContent = `${fmtCap(vpf)} = ${fmt(vpf)} pF / ${fmt(vpf / 1e3)} nF / ${fmt(vpf / 1e6)} µF / ${fmt(vpf / 1e12)} F`;
  };
  const updateFrom = (src: HTMLInputElement, div: number) => () => {
    const v = num(src.value);
    if (v === null) {
      setAll(null);
      return;
    }
    setAll(v * div);
  };
  const onPf = updateFrom(pf, 1);
  const onNf = updateFrom(nf, 1e3);
  const onUf = updateFrom(uf, 1e6);
  const onF = updateFrom(f, 1e12);
  const onCode = () => {
    const m = code.value.trim().match(/^(\d{3})$/);
    if (!m) {
      result.textContent = "—";
      return;
    }
    const vpf = capCode3(m[1])!;
    setAll(vpf);
    code.value = m[1];
  };
  pf.addEventListener("input", onPf);
  nf.addEventListener("input", onNf);
  uf.addEventListener("input", onUf);
  f.addEventListener("input", onF);
  code.addEventListener("input", onCode);
  onCode();
  return {};
}

// ── 电容器安全放电 ──
function buildCapacitorDischarge(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>电容器容值</label><div class="tool-inline"><input id="capd-c" class="proto-in" type="number" min="0" value="100" /><select id="capd-cu" class="tool-sel proto-in"><option value="1e-12">pF</option><option value="1e-9">nF</option><option value="1e-6" selected>µF</option><option value="1">F</option></select></div></div>
        <div class="tool-field"><label>初始充电电压</label><div class="tool-inline"><input id="capd-v0" class="proto-in" type="number" min="0" value="100" /><span class="tool-suffix">V</span></div></div>
        <div class="tool-field"><label>安全阈值电压</label><div class="tool-inline"><input id="capd-vs" class="proto-in" type="number" min="0" value="1" /><span class="tool-suffix">V</span></div></div>
        <div class="tool-field"><label>电阻值</label><div class="tool-inline"><input id="capd-r" class="proto-in" type="number" min="0" value="100" /><select id="capd-ru" class="tool-sel proto-in"><option value="1">Ω</option><option value="1e3" selected>kΩ</option><option value="1e6">MΩ</option></select></div></div>
        <div class="tool-field"><label>到达安全电压所需的时间</label><div class="tool-inline"><input id="capd-t" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">s</span></div></div>
        <div class="tool-field"><label>初始功率</label><div class="tool-inline"><input id="capd-p" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">W</span></div></div>
        <div class="tool-field"><label>时间常数 τ</label><div class="tool-inline"><input id="capd-tau" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">s</span></div></div>
        <div class="tool-field"><label>释放的能量</label><div class="tool-inline"><input id="capd-e" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">J</span></div></div>
      </div>
      <div class="tool-formula">${math("t = R C \\ln(V_0 / V_s)")}</div>
    </div>`;
  const update = () => {
    const c = num((host.querySelector("#capd-c") as HTMLInputElement).value);
    const v0 = num((host.querySelector("#capd-v0") as HTMLInputElement).value);
    const vs = num((host.querySelector("#capd-vs") as HTMLInputElement).value);
    const r = num((host.querySelector("#capd-r") as HTMLInputElement).value);
    const cu = Number((host.querySelector("#capd-cu") as HTMLSelectElement).value);
    const ru = Number((host.querySelector("#capd-ru") as HTMLSelectElement).value);
    if (c === null || v0 === null || vs === null || r === null || v0 <= 0 || vs <= 0 || vs >= v0) {
      (host.querySelector("#capd-t") as HTMLInputElement).value = "";
      (host.querySelector("#capd-p") as HTMLInputElement).value = "";
      (host.querySelector("#capd-tau") as HTMLInputElement).value = "";
      (host.querySelector("#capd-e") as HTMLInputElement).value = "";
      return;
    }
    const rr = r * ru;
    const cc = c * cu;
    const d = capDischarge(cc, v0, vs, rr);
    (host.querySelector("#capd-t") as HTMLInputElement).value = fmt(d.time);
    (host.querySelector("#capd-p") as HTMLInputElement).value = fmt(d.power);
    (host.querySelector("#capd-tau") as HTMLInputElement).value = fmt(d.tau);
    (host.querySelector("#capd-e") as HTMLInputElement).value = fmt(d.energy);
  };
  host.querySelectorAll("input,select").forEach((el) => el.addEventListener("input", update));
  host.querySelectorAll("select").forEach((el) => el.addEventListener("change", update));
  update();
  return {};
}

// ── 分流器 ──
function buildCurrentDivider(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-field"><label>电流源</label><div class="tool-inline"><input id="cd-total" class="proto-in" type="number" min="0" value="1" /><select id="cd-totalu" class="tool-sel proto-in"><option value="1" selected>A</option><option value="0.001">mA</option><option value="1e-6">µA</option></select></div></div>
      <div id="cd-rows"></div>
      <div class="tool-actions"><button id="cd-add" class="primary">${t("tools.addResistor")}</button><button id="cd-remove" class="ghost">${t("tools.removeResistor")}</button></div>
      <div class="tool-resultline" id="cd-result"></div>
    </div>`;
  const rows = host.querySelector<HTMLElement>("#cd-rows")!;
  const result = host.querySelector<HTMLElement>("#cd-result")!;
  let n = 2;
  const row = (i: number) => {
    const div = document.createElement("div");
    div.className = "tool-grid";
    div.innerHTML = `
      <div class="tool-field"><label>R${i + 1}</label><div class="tool-inline"><input class="cd-r" type="number" min="0" value="${i === 0 ? 100 : 100}" /><select class="cd-ru tool-sel proto-in"><option value="1">Ω</option><option value="1e3" selected>kΩ</option><option value="1e6">MΩ</option></select></div></div>
      <div class="tool-field"><label>I${i + 1}</label><div class="tool-inline"><input class="cd-out tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">A</span></div></div>`;
    rows.appendChild(div);
  };
  for (let i = 0; i < n; i++) row(i);
  const update = () => {
    const is = num((host.querySelector("#cd-total") as HTMLInputElement).value);
    const iu = Number((host.querySelector("#cd-totalu") as HTMLSelectElement).value);
    const list = [...rows.querySelectorAll<HTMLElement>(".tool-grid")].map((g) => {
      const r = num(g.querySelector<HTMLInputElement>(".cd-r")!.value);
      const u = Number(g.querySelector<HTMLSelectElement>(".cd-ru")!.value);
      return r === null ? null : r * u;
    });
    if (is === null || list.some((x) => x === null || x <= 0)) {
      result.textContent = "—";
      rows.querySelectorAll<HTMLInputElement>(".cd-out").forEach((o) => (o.value = ""));
      return;
    }
    const total = 1 / list.reduce<number>((a, x) => a + 1 / x!, 0);
    rows.querySelectorAll<HTMLInputElement>(".cd-out").forEach((o, idx) => {
      o.value = fmt((is * iu * total) / list[idx]!);
    });
    result.textContent = `I_total = ${fmt(is * iu)} A, R_total = ${fmt(total)} Ω`;
  };
  rows.addEventListener("input", update);
  rows.addEventListener("change", update);
  const add = () => {
    if (n >= 10) return;
    row(n++);
    update();
  };
  const remove = () => {
    if (n <= 1) return;
    rows.lastElementChild?.remove();
    n--;
    update();
  };
  host.querySelector("#cd-add")!.addEventListener("click", add);
  host.querySelector("#cd-remove")!.addEventListener("click", remove);
  host.querySelector("#cd-total")!.addEventListener("input", update);
  host.querySelector("#cd-totalu")!.addEventListener("change", update);
  update();
  return {};
}

// ── 分压器 ──
function buildVoltageDivider(host: HTMLElement): ToolController {
  const E24 = [10,11,12,13,15,16,18,20,22,24,27,30,33,36,39,43,47,51,56,62,68,75,82,91];
  const E96 = [100,102,105,107,110,113,115,118,121,124,127,130,133,137,140,143,147,150,154,158,162,165,169,174,178,182,187,191,196,200,205,210,215,221,226,232,237,243,249,255,261,267,274,280,287,294,301,309,316,324,332,340,348,357,365,374,383,392,402,412,422,432,442,453,464,475,487,499,511,523,536,549,562,576,590,604,619,634,649,665,681,698,715,732,750,768,787,806,825,845,866,887,909,931,953,976];
  const stdValues = (series: string) => {
    const mant = series === "e24" ? E24 : E96;
    const out: number[] = [];
    for (let exp = -2; exp <= 6; exp++) {
      const mul = 10 ** exp;
      for (const m of mant) out.push(series === "e24" ? m * mul : (m / 100) * mul);
    }
    return out;
  };
  const fmtRes = (v: number) => {
    if (v >= 1e6) return `${fmt(v / 1e6)} MΩ`;
    if (v >= 1e3) return `${fmt(v / 1e3)} KΩ`;
    return `${fmt(v)} Ω`;
  };
  const resultRow = (r: { r1: number; r2: number; out: number }) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtRes(r.r1)}</td>
      <td>${fmtRes(r.r2)}</td>
      <td>${fmt(r.out)} V</td>`;
    return tr;
  };
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-tabs">
        <button class="tool-tab active" data-vdtab="calc">${t("tools.calc")}</button>
        <button class="tool-tab" data-vdtab="fit">分压拟合</button>
      </div>
      <div data-vdpanel="calc">
        <div class="tool-grid">
          <div class="tool-field"><label>输入电压</label><div class="tool-inline"><input id="vd-vin" class="proto-in" type="number" value="12" /><span class="tool-suffix">V</span></div></div>
          <div class="tool-field"><label>R1</label><div class="tool-inline"><input id="vd-r1" class="proto-in" type="number" min="0" value="1000" /><select id="vd-r1u" class="tool-sel proto-in"><option value="1">Ω</option><option value="1e3" selected>kΩ</option><option value="1e6">MΩ</option></select></div></div>
          <div class="tool-field"><label>R2</label><div class="tool-inline"><input id="vd-r2" class="proto-in" type="number" min="0" value="1000" /><select id="vd-r2u" class="tool-sel proto-in"><option value="1">Ω</option><option value="1e3" selected>kΩ</option><option value="1e6">MΩ</option></select></div></div>
          <div class="tool-field"><label>输出电压</label><div class="tool-inline"><input id="vd-vout" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">V</span></div></div>
        </div>
        <div class="tool-formula">${math("V_{out} = V_{in} \\times \\dfrac{R_2}{R_1+R_2}")}</div>
      </div>
      <div data-vdpanel="fit" class="hidden">
        <div class="tool-grid">
          <div class="tool-field"><label>输入电压</label><div class="tool-inline"><input id="fd-vin" class="proto-in" type="number" value="12" /><span class="tool-suffix">V</span></div></div>
          <div class="tool-field"><label>期望输出电压</label><div class="tool-inline"><input id="fd-vout" class="proto-in" type="number" value="0.6" /><span class="tool-suffix">V</span></div></div>
          <div class="tool-field"><label>系列</label><select id="fd-series" class="proto-in"><option value="e24" selected>E24</option><option value="e96">E96</option></select></div>
        </div>
        <table class="tools-fit-table">
          <thead><tr><th>电阻R1</th><th>电阻R2</th><th>输出电压</th></tr></thead>
          <tbody id="fd-rows"></tbody>
        </table>
        <div class="tool-resultline" id="fd-count"></div>
      </div>
    </div>`;
  const tabs = host.querySelectorAll<HTMLButtonElement>(".tool-tab");
  const panels = host.querySelectorAll<HTMLElement>("[data-vdpanel]");
  tabs.forEach((b) => b.addEventListener("click", () => {
    const kind = b.dataset.vdtab!;
    tabs.forEach((x) => x.classList.toggle("active", x.dataset.vdtab === kind));
    panels.forEach((p) => p.classList.toggle("hidden", p.dataset.vdpanel !== kind));
  }));
  const updateCalc = () => {
    const vin = num((host.querySelector("#vd-vin") as HTMLInputElement).value);
    const r1 = num((host.querySelector("#vd-r1") as HTMLInputElement).value);
    const r2 = num((host.querySelector("#vd-r2") as HTMLInputElement).value);
    const r1u = Number((host.querySelector("#vd-r1u") as HTMLSelectElement).value);
    const r2u = Number((host.querySelector("#vd-r2u") as HTMLSelectElement).value);
    if (vin === null || r1 === null || r2 === null || r1 * r1u + r2 * r2u === 0) {
      (host.querySelector("#vd-vout") as HTMLInputElement).value = "";
      return;
    }
    const vout = vin * (r2 * r2u) / (r1 * r1u + r2 * r2u);
    (host.querySelector("#vd-vout") as HTMLInputElement).value = fmt(vout);
  };
  const updateFit = () => {
    const vin = num((host.querySelector("#fd-vin") as HTMLInputElement).value);
    const want = num((host.querySelector("#fd-vout") as HTMLInputElement).value);
    const series = (host.querySelector("#fd-series") as HTMLSelectElement).value;
    const tbody = host.querySelector<HTMLTableSectionElement>("#fd-rows")!;
    if (vin === null || want === null || vin <= 0 || want <= 0 || want >= vin) {
      tbody.replaceChildren();
      setTextById(host, "#fd-count", "请确保 0 < Vout < Vin");
      return;
    }
    const vals = stdValues(series);
    const found: { r1: number; r2: number; out: number; err: number }[] = [];
    for (const r1 of vals) {
      for (const r2 of vals) {
        const out = vin * r2 / (r1 + r2);
        const err = Math.abs(out - want);
        found.push({ r1, r2, out, err });
      }
    }
    found.sort((a, b) => a.err - b.err || a.r1 - b.r1);
    const top = found.slice(0, 10);
    tbody.replaceChildren(...top.map(resultRow));
    setTextById(host, "#fd-count", `最接近的 ${top.length} 个结果`);
  };
  const setTextById = (root: HTMLElement, sel: string, text: string) => {
    const el = root.querySelector<HTMLElement>(sel);
    if (el) el.textContent = text;
  };
  host.querySelectorAll("[data-vdpanel=calc] input,[data-vdpanel=calc] select").forEach((el) => {
    el.addEventListener("input", updateCalc);
    el.addEventListener("change", updateCalc);
  });
  host.querySelectorAll("[data-vdpanel=fit] input,[data-vdpanel=fit] select").forEach((el) => {
    el.addEventListener("input", updateFit);
    el.addEventListener("change", updateFit);
  });
  updateCalc();
  updateFit();
  return {};
}

// ── dBm / 瓦 ──
function buildDbmWatt(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>dBm</label><div class="tool-inline"><input id="dbm" class="proto-in" type="number" value="0" /><span class="tool-suffix">dBm</span></div></div>
        <div class="tool-field"><label>瓦特</label><div class="tool-inline"><input id="dbm-w" class="proto-in" type="number" value="0.001" /><span class="tool-suffix">W</span></div></div>
        <div class="tool-field"><label>毫瓦</label><div class="tool-inline"><input id="dbm-mw" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">mW</span></div></div>
      </div>
      <div class="tool-formula">${math("P_{dBm} = 10 \\log_{10}(P/1mW)")}</div>
    </div>`;
  const dbm = host.querySelector<HTMLInputElement>("#dbm")!;
  const watt = host.querySelector<HTMLInputElement>("#dbm-w")!;
  const mwOut = host.querySelector<HTMLInputElement>("#dbm-mw")!;
  const updateFromDbm = () => {
    const d = num(dbm.value);
    if (d === null) return;
    const mw = dbmToMwt(d);
    watt.value = fmt(mw / 1000, 10);
    mwOut.value = fmt(mw, 10);
  };
  const updateFromWatt = () => {
    const w = num(watt.value);
    if (w === null || w < 0) return;
    const mw = w * 1000;
    dbm.value = fmt(10 * Math.log10(mw), 8);
    mwOut.value = fmt(mw, 10);
  };
  dbm.addEventListener("input", updateFromDbm);
  watt.addEventListener("input", updateFromWatt);
  updateFromDbm();
  return {};
}

// ── LED 串联电阻 ──
function buildLedResistor(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>电源电压</label><div class="tool-inline"><input id="led-vs" class="proto-in" type="number" value="5" /><span class="tool-suffix">V</span></div></div>
        <div class="tool-field"><label>LED 正向压降</label><div class="tool-inline"><input id="led-vf" class="proto-in" type="number" value="2" /><span class="tool-suffix">V</span></div></div>
        <div class="tool-field"><label>LED 电流</label><div class="tool-inline"><input id="led-if" class="proto-in" type="number" value="20" /><select id="led-ifu" class="tool-sel proto-in"><option value="1" selected>mA</option><option value="0.001">A</option></select></div></div>
        <div class="tool-field"><label>串联电阻</label><div class="tool-inline"><input id="led-r" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">Ω</span></div></div>
      </div>
      <div class="tool-formula">${math("R = \\dfrac{V_s - V_f}{I_f}")}</div>
    </div>`;
  const update = () => {
    const vs = num((host.querySelector("#led-vs") as HTMLInputElement).value);
    const vf = num((host.querySelector("#led-vf") as HTMLInputElement).value);
    const ifv = num((host.querySelector("#led-if") as HTMLInputElement).value);
    const ifu = Number((host.querySelector("#led-ifu") as HTMLSelectElement).value);
    if (vs === null || vf === null || ifv === null || vs - vf <= 0 || ifv * ifu <= 0) {
      (host.querySelector("#led-r") as HTMLInputElement).value = "";
      return;
    }
    (host.querySelector("#led-r") as HTMLInputElement).value = fmt(ledResistor(vs, vf, ifv * ifu));
  };
  host.querySelectorAll("input,select").forEach((el) => el.addEventListener("input", update));
  host.querySelectorAll("select").forEach((el) => el.addEventListener("change", update));
  update();
  return {};
}

// ── 欧姆定律 ──
function buildOhm(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>电压</label><div class="tool-inline"><input id="ohm-v" class="proto-in" type="number" value="5" /><span class="tool-suffix">V</span></div></div>
        <div class="tool-field"><label>电流</label><div class="tool-inline"><input id="ohm-i" class="proto-in" type="number" value="0.1" /><select id="ohm-iu" class="tool-sel proto-in"><option value="1" selected>A</option><option value="0.001">mA</option><option value="1e-6">µA</option></select></div></div>
        <div class="tool-field"><label>电阻</label><div class="tool-inline"><input id="ohm-r" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">Ω</span></div></div>
      </div>
      <div class="tool-formula">${math("R = V/I,\\quad P = V \\times I")}</div>
    </div>`;
  const update = () => {
    const v = num((host.querySelector("#ohm-v") as HTMLInputElement).value);
    const i = num((host.querySelector("#ohm-i") as HTMLInputElement).value);
    const iu = Number((host.querySelector("#ohm-iu") as HTMLSelectElement).value);
    if (v === null || i === null || i * iu === 0) {
      (host.querySelector("#ohm-r") as HTMLInputElement).value = "";
      return;
    }
    const o = ohmLaw(v, i * iu);
    const iOut = host.querySelector<HTMLInputElement>("#ohm-r")!;
    iOut.value = `${fmt(o.r)} Ω (P = ${fmt(o.p)} W)`;
  };
  host.querySelectorAll("input,select").forEach((el) => el.addEventListener("input", update));
  host.querySelectorAll("select").forEach((el) => el.addEventListener("change", update));
  update();
  return {};
}

// ── 低通/高通滤波器 ──
function buildFilter(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>滤波类型</label><select id="flt-type" class="proto-in"><option value="rc" selected>RC</option><option value="rl">RL</option><option value="lc">LC</option></select></div>
        <div class="tool-field"><label>电阻</label><div class="tool-inline"><input id="flt-r" class="proto-in" type="number" min="0" value="1000" /><select id="flt-ru" class="tool-sel proto-in"><option value="1">Ω</option><option value="1e3" selected>kΩ</option><option value="1e6">MΩ</option></select></div></div>
        <div class="tool-field"><label>电容</label><div class="tool-inline"><input id="flt-c" class="proto-in" type="number" min="0" value="100" /><select id="flt-cu" class="tool-sel proto-in"><option value="1e-12">pF</option><option value="1e-9">nF</option><option value="1e-6" selected>µF</option></select></div></div>
        <div class="tool-field"><label>电感</label><div class="tool-inline"><input id="flt-l" class="proto-in" type="number" min="0" value="10" /><select id="flt-lu" class="tool-sel proto-in"><option value="1e-9">nH</option><option value="1e-6" selected>µH</option><option value="1e-3">mH</option><option value="1">H</option></select></div></div>
        <div class="tool-field"><label>-3dB 截止频率</label><div class="tool-inline"><input id="flt-f" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">Hz</span></div></div>
      </div>
      <div class="tool-formula" id="flt-formula"></div>
    </div>`;
  const type = host.querySelector<HTMLSelectElement>("#flt-type")!;
  const formula = host.querySelector<HTMLElement>("#flt-formula")!;
  const update = () => {
    const t = type.value;
    const r = num((host.querySelector("#flt-r") as HTMLInputElement).value);
    const c = num((host.querySelector("#flt-c") as HTMLInputElement).value);
    const l = num((host.querySelector("#flt-l") as HTMLInputElement).value);
    const ru = Number((host.querySelector("#flt-ru") as HTMLSelectElement).value);
    const cu = Number((host.querySelector("#flt-cu") as HTMLSelectElement).value);
    const lu = Number((host.querySelector("#flt-lu") as HTMLSelectElement).value);
    const f = filterFc(t as "rc" | "rl" | "lc", r === null ? null : r * ru, c === null ? null : c * cu, l === null ? null : l * lu);
    if (t === "rc") formula.innerHTML = math("f_c = \\dfrac{1}{2\\pi RC}");
    else if (t === "rl") formula.innerHTML = math("f_c = \\dfrac{R}{2\\pi L}");
    else formula.innerHTML = math("f_c = \\dfrac{1}{2\\pi\\sqrt{LC}}");
    (host.querySelector("#flt-f") as HTMLInputElement).value = f === null ? "" : fmt(f) + " Hz";
  };
  host.querySelectorAll("input,select").forEach((el) => el.addEventListener("input", update));
  host.querySelectorAll("select").forEach((el) => el.addEventListener("change", update));
  update();
  return {};
}

// ── 数制转换（含 Win11 程序员模式风格的二进制码盘）──
const WORD_SIZES = [
  { id: 8, label: "BYTE" },
  { id: 16, label: "WORD" },
  { id: 32, label: "DWORD" },
  { id: 64, label: "QWORD" },
];
function buildNumberBase(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>十进制</label><div class="tool-inline"><input id="nb-d" class="proto-in" type="text" value="42" /></div></div>
        <div class="tool-field"><label>十六进制</label><div class="tool-inline"><input id="nb-h" class="proto-in" type="text" value="2A" /></div></div>
        <div class="tool-field"><label>八进制</label><div class="tool-inline"><input id="nb-o" class="proto-in" type="text" value="52" /></div></div>
        <div class="tool-field"><label>二进制</label><div class="tool-inline"><input id="nb-b" class="proto-in" type="text" value="101010" /></div></div>
      </div>
      <div class="nb-bithead">
        <label>位宽</label>
        <select id="nb-wordsize" class="tool-sel proto-in">${WORD_SIZES.map((w) => `<option value="${w.id}"${w.id === 16 ? " selected" : ""}>${w.label}</option>`).join("")}</select>
      </div>
      <div class="nb-bitgrid" id="nb-bitgrid"></div>
      <div class="tool-resultline" id="nb-result"></div>
    </div>`;
  const d = host.querySelector<HTMLInputElement>("#nb-d")!;
  const h = host.querySelector<HTMLInputElement>("#nb-h")!;
  const o = host.querySelector<HTMLInputElement>("#nb-o")!;
  const b = host.querySelector<HTMLInputElement>("#nb-b")!;
  const res = host.querySelector<HTMLElement>("#nb-result")!;
  const wordSel = host.querySelector<HTMLSelectElement>("#nb-wordsize")!;
  const grid = host.querySelector<HTMLElement>("#nb-bitgrid")!;
  let cur = 42n;

  const wordsize = () => Number(wordSel.value);
  const renderBits = (v: bigint) => {
    const W = wordsize();
    const nibbles = W / 4;
    let html = "";
    // 从高位组到低位组，组内 MSB→LSB 排列
    for (let nib = nibbles - 1; nib >= 0; nib--) {
      let cells = "";
      for (let bit = 4 * nib + 3; bit >= 4 * nib; bit--) {
        const on = (v >> BigInt(bit)) & 1n;
        cells += `<button type="button" class="nb-bit${on ? " on" : ""}" data-bit="${bit}">${on}</button>`;
      }
      html += `<div class="nb-nibble">${cells}<span class="nb-niblbl">${4 * nib}</span></div>`;
    }
    grid.innerHTML = html;
  };
  const setAll = (v: bigint) => {
    cur = v;
    d.value = v.toString();
    h.value = v.toString(16).toUpperCase();
    o.value = v.toString(8);
    b.value = v.toString(2);
    res.textContent = `dec=${v} hex=0x${h.value} oct=0o${o.value} bin=0b${b.value}`;
    renderBits(v);
  };
  const parseBig = (s: string, radix: number): bigint | null => {
    const m = s.trim().replace(/^0x/i, "0x").replace(/^0o/i, "0o").replace(/^0b/i, "0b");
    if (!m) return null;
    try {
      if (radix === 10) return BigInt(m);
      if (radix === 16) return BigInt("0x" + m.replace(/^0x/i, "").replace(/[^0-9a-f]/gi, "") || "0");
      if (radix === 8) return BigInt("0o" + m.replace(/^0o/i, "").replace(/[^0-7]/g, "") || "0");
      return BigInt("0b" + m.replace(/^0b/i, "").replace(/[^01]/g, "") || "0");
    } catch {
      return null;
    }
  };
  const parseAndSet = (src: HTMLInputElement, radix: number) => () => {
    const v = parseBig(src.value, radix);
    if (v === null) return;
    setAll(v);
  };
  d.addEventListener("input", parseAndSet(d, 10));
  h.addEventListener("input", parseAndSet(h, 16));
  o.addEventListener("input", parseAndSet(o, 8));
  b.addEventListener("input", parseAndSet(b, 2));
  wordSel.addEventListener("change", () => renderBits(cur));
  // 点击位即切换
  grid.addEventListener("click", (e) => {
    const bitEl = (e.target as HTMLElement).closest<HTMLElement>(".nb-bit");
    if (!bitEl) return;
    const bit = Number(bitEl.dataset.bit);
    const mask = 1n << BigInt(bit);
    // 保留位宽内其它位，位宽外的高位一并保留
    setAll(cur ^ mask);
  });
  setAll(42n);
  return {};
}

// ── 串/并联电容 ──
function buildParallelSeriesCapacitor(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-field"><label>电容值</label><div class="tool-inline"><input id="cap-c1" class="proto-in" type="number" min="0" value="10" /><select class="tool-sel proto-in" id="cap-u"><option value="1e-12">pF</option><option value="1e-9">nF</option><option value="1e-6" selected>µF</option></select></div></div>
      <div id="cap-rows"></div>
      <div class="tool-actions"><button id="cap-add" class="primary">添加电容器</button><button id="cap-remove" class="ghost">移除电容器</button></div>
      <div class="tool-grid">
        <div class="tool-field"><label>并联总电容</label><div class="tool-inline"><input id="cap-par" class="tool-output proto-in" readonly placeholder="—" /></div></div>
        <div class="tool-field"><label>串联总电容</label><div class="tool-inline"><input id="cap-ser" class="tool-output proto-in" readonly placeholder="—" /></div></div>
      </div>
    </div>`;
  const rows = host.querySelector<HTMLElement>("#cap-rows")!;
  let n = 2;
  const row = () => {
    const div = document.createElement("div");
    div.className = "tool-grid";
    div.innerHTML = `<div class="tool-field"><label>C${n}</label><div class="tool-inline"><input class="cap-v" type="number" min="0" value="10" /><select class="cap-u tool-sel proto-in"><option value="1e-12">pF</option><option value="1e-9">nF</option><option value="1e-6" selected>µF</option></select></div></div>`;
    rows.appendChild(div);
  };
  row();
  const update = () => {
    const values = [host.querySelector<HTMLInputElement>("#cap-c1")!, ...rows.querySelectorAll<HTMLInputElement>(".cap-v")].map((el) => {
      const v = num(el.value);
      const u = Number((el.parentElement!.querySelector<HTMLSelectElement>(".cap-u") ?? el.closest(".tool-panel")!.querySelector<HTMLSelectElement>("#cap-u"))!.value);
      return v === null ? null : v * u;
    });
    const par = parallelCap(values);
    const ser = seriesCap(values);
    (host.querySelector("#cap-par") as HTMLInputElement).value = par === null ? "" : fmt(par) + " F";
    (host.querySelector("#cap-ser") as HTMLInputElement).value = ser === null ? "" : fmt(ser) + " F";
  };
  host.querySelector("#cap-add")!.addEventListener("click", () => { row(); update(); });
  host.querySelector("#cap-remove")!.addEventListener("click", () => {
    if (rows.children.length <= 1) return;
    rows.lastElementChild?.remove();
    update();
  });
  const input = host.querySelector<HTMLInputElement>("#cap-c1")!;
  input.addEventListener("input", update);
  rows.addEventListener("input", update);
  rows.addEventListener("change", update);
  update();
  return {};
}

// ── SMD 电阻代码 ──
function buildSmdResistor(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-tabs">
        <button class="tool-tab active" data-mode="3">3 位 EIA</button>
        <button class="tool-tab" data-mode="4">4 位 EIA</button>
        <button class="tool-tab" data-mode="96">EIA-96</button>
      </div>
      <div class="tool-field"><label>SMD 电阻代码</label><div class="tool-inline"><input id="smdr-code" class="proto-in" type="text" value="103" placeholder="如 103 / 1003 / 01Y" /></div></div>
      <div class="tool-resultline" id="smdr-result"></div>
    </div>`;
  const code = host.querySelector<HTMLInputElement>("#smdr-code")!;
  const res = host.querySelector<HTMLElement>("#smdr-result")!;
  const mode = () => host.querySelector<HTMLButtonElement>(".tool-tab.active")!.dataset.mode!;
  const E96_MULT: Record<string, number> = { Y: -2, Z: -1, R: 0, S: 1, T: 2, U: 3, V: 4, W: 5, X: 6, A: 7, B: 8, C: 9, D: 10, E: 11, F: 12 };
  const e96 = [100,102,105,107,110,113,115,118,121,124,127,130,133,137,140,143,147,150,154,158,162,165,169,174,178,182,187,191,196,200,205,210,215,221,226,232,237,243,249,255,261,267,274,280,287,294,301,309,316,324,332,340,348,357,365,374,383,392,402,412,422,432,442,453,464,475,487,499,511,523,536,549,562,576,590,604,619,634,649,665,681,698,715,732,750,768,787,806,825,845,866,887,909,931,953,976];
  const update = () => {
    const s = code.value.trim().toUpperCase();
    const rdec = s.match(/^(\d*)R(\d*)$/);
    if (rdec) {
      const v = Number(`${rdec[1] || "0"}.${rdec[2] || "0"}`);
      res.textContent = Number.isFinite(v) ? `${s} = ${fmtOhm(v)}` : "—";
      return;
    }
    const m = mode();
    if (m === "3") {
      const g = s.match(/^(\d{3})$/);
      if (!g) { res.textContent = "—"; return; }
      const v = Number(g[1].slice(0, 2)) * 10 ** Number(g[1][2]);
      res.textContent = `${s} = ${fmtOhm(v)}`;
      return;
    }
    if (m === "4") {
      const g = s.match(/^(\d{4})$/);
      if (!g) { res.textContent = "—"; return; }
      const v = Number(g[1].slice(0, 3)) * 10 ** Number(g[1][3]);
      res.textContent = `${s} = ${fmtOhm(v)}`;
      return;
    }
    const g = s.match(/^(\d{2})([A-Z])$/);
    if (!g) { res.textContent = "—"; return; }
    const base = e96[Number(g[1]) - 1] ?? NaN;
    const mult = E96_MULT[g[2]!] ?? NaN;
    const v = base * 10 ** mult;
    res.textContent = Number.isFinite(v) ? `${s} = ${fmtOhm(v)}` : "—";
  };
  host.querySelectorAll<HTMLButtonElement>(".tool-tab").forEach((b) =>
    b.addEventListener("click", () => {
      host.querySelectorAll(".tool-tab").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      update();
    }),
  );
  code.addEventListener("input", update);
  update();
  return {};
}

// ── SMD 电容代码 ──
function buildSmdCapacitor(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-tabs">
        <button class="tool-tab active" data-mode="3">3 位 EIA</button>
        <button class="tool-tab" data-mode="4">4 位 EIA</button>
      </div>
      <div class="tool-field"><label>SMD 电容代码</label><div class="tool-inline"><input id="smdc-code" class="proto-in" type="text" value="104" placeholder="如 104 / 1004" /></div></div>
      <div class="tool-resultline" id="smdc-result"></div>
    </div>`;
  const code = host.querySelector<HTMLInputElement>("#smdc-code")!;
  const res = host.querySelector<HTMLElement>("#smdc-result")!;
  const update = () => {
    const s = code.value.trim().toUpperCase();
    const rdec = s.match(/^(\d*)R(\d*)$/);
    if (rdec) {
      const v = Number(`${rdec[1] || "0"}.${rdec[2] || "0"}`);
      res.textContent = Number.isFinite(v) ? `${s} = ${fmtCap(v)}` : "—";
      return;
    }
    const g = s.match(/^(\d{3,4})$/);
    if (!g) { res.textContent = "—"; return; }
    const digits = g[1];
    const sig = Number(digits.slice(0, digits.length - 1));
    const pf = sig * 10 ** Number(digits[digits.length - 1]);
    res.textContent = `${s} = ${fmtCap(pf)} (${fmt(pf)} pF)`;
  };
  host.querySelectorAll<HTMLButtonElement>(".tool-tab").forEach((b) =>
    b.addEventListener("click", () => {
      host.querySelectorAll(".tool-tab").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      update();
    }),
  );
  code.addEventListener("input", update);
  update();
  return {};
}

// ── 电阻色环 ──
function buildColorCode(host: HTMLElement): ToolController {
  const colors: [string, number, string][] = [["黑",0,""],["棕",1,"±1%"],["红",2,"±2%"],["橙",3,""],["黄",4,""],["绿",5,"±0.5%"],["蓝",6,"±0.25%"],["紫",7,"±0.1%"],["灰",8,""],["白",9,""],["金",-1,"±5%"],["银",-2,"±10%"]];
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>第一环</label><select id="cc-a" class="proto-in">${colors.map((c,i)=>`<option value="${i}"${i===1?" selected":""}>${c[0]}</option>`).join("")}</select></div>
        <div class="tool-field"><label>第二环</label><select id="cc-b" class="proto-in">${colors.map((c,i)=>`<option value="${i}"${i===0?" selected":""}>${c[0]}</option>`).join("")}</select></div>
        <div class="tool-field"><label>倍率环</label><select id="cc-m" class="proto-in">${colors.map((c,i)=>`<option value="${i}"${i===2?" selected":""}>${c[0]}</option>`).join("")}</select></div>
        <div class="tool-field"><label>误差环</label><select id="cc-t" class="proto-in">${colors.map((c,i)=>`<option value="${i}"${i===10?" selected":""}>${c[0]}</option>`).join("")}</select></div>
      </div>
      <div class="tool-resultline" id="cc-result"></div>
    </div>`;
  const res = host.querySelector<HTMLElement>("#cc-result")!;
  const update = () => {
    const get = (id: string) => Number((host.querySelector(id) as HTMLSelectElement).value);
    const a = colors[get("#cc-a")]!;
    const b = colors[get("#cc-b")]!;
    const m = colors[get("#cc-m")]!;
    const tol = colors[get("#cc-t")]!;
    const value = (a[1] * 10 + b[1]) * 10 ** m[1];
    res.textContent = `${a[0]} ${b[0]} ${m[0]} ${tol[0]} = ${fmt(value)} Ω ${tol[2]}`;
  };
  host.querySelectorAll("select").forEach((el) => el.addEventListener("change", update));
  update();
  return {};
}

// ── 热敏电阻 ──
function buildThermistor(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>标称电阻 R₀</label><div class="tool-inline"><input id="th-r0" class="proto-in" type="number" min="0" value="10000" /><span class="tool-suffix">Ω</span></div></div>
        <div class="tool-field"><label>标称温度 T₀</label><div class="tool-inline"><input id="th-t0" class="proto-in" type="number" value="25" /><span class="tool-suffix">°C</span></div></div>
        <div class="tool-field"><label>当前电阻 R</label><div class="tool-inline"><input id="th-r" class="proto-in" type="number" min="0" value="10000" /><span class="tool-suffix">Ω</span></div></div>
        <div class="tool-field"><label>B 值</label><div class="tool-inline"><input id="th-b" class="proto-in" type="number" min="0" value="3950" /><span class="tool-suffix">K</span></div></div>
        <div class="tool-field"><label>当前温度</label><div class="tool-inline"><input id="th-t" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">°C</span></div></div>
      </div>
      <div class="tool-formula">${math("T = \\dfrac{1}{1/T_0 + \\ln(R/R_0)/B} - 273.15")}</div>
    </div>`;
  const update = () => {
    const r0 = num((host.querySelector("#th-r0") as HTMLInputElement).value);
    const t0 = num((host.querySelector("#th-t0") as HTMLInputElement).value);
    const r = num((host.querySelector("#th-r") as HTMLInputElement).value);
    const b = num((host.querySelector("#th-b") as HTMLInputElement).value);
    if (r0 === null || t0 === null || r === null || b === null || r0 <= 0 || r <= 0 || b <= 0) {
      (host.querySelector("#th-t") as HTMLInputElement).value = "";
      return;
    }
    const tk = 1 / (1 / (t0 + 273.15) + Math.log(r / r0) / b);
    (host.querySelector("#th-t") as HTMLInputElement).value = fmt(tk - 273.15);
  };
  host.querySelectorAll("input").forEach((el) => el.addEventListener("input", update));
  update();
  return {};
}

// ── 时间常数 ──
function buildTimeConstant(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>电阻</label><div class="tool-inline"><input id="tc-r" class="proto-in" type="number" min="0" value="1000" /><select id="tc-ru" class="tool-sel proto-in"><option value="1">Ω</option><option value="1e3" selected>kΩ</option><option value="1e6">MΩ</option></select></div></div>
        <div class="tool-field"><label>电容</label><div class="tool-inline"><input id="tc-c" class="proto-in" type="number" min="0" value="10" /><select id="tc-cu" class="tool-sel proto-in"><option value="1e-12">pF</option><option value="1e-9">nF</option><option value="1e-6" selected>µF</option></select></div></div>
        <div class="tool-field"><label>电压</label><div class="tool-inline"><input id="tc-v" class="proto-in" type="number" min="0" value="12" /><span class="tool-suffix">V</span></div></div>
        <div class="tool-field"><label>时间常数 τ</label><div class="tool-inline"><input id="tc-out" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">s</span></div></div>
        <div class="tool-field"><label>电容储能</label><div class="tool-inline"><input id="tc-e" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">J</span></div></div>
      </div>
      <div class="tool-formula">${math("\\tau = R \\times C,\\quad E = \\dfrac{1}{2}CV^2")}</div>
    </div>`;
  const update = () => {
    const r = num((host.querySelector("#tc-r") as HTMLInputElement).value);
    const c = num((host.querySelector("#tc-c") as HTMLInputElement).value);
    const v = num((host.querySelector("#tc-v") as HTMLInputElement).value);
    const ru = Number((host.querySelector("#tc-ru") as HTMLSelectElement).value);
    const cu = Number((host.querySelector("#tc-cu") as HTMLSelectElement).value);
    if (r === null || c === null) {
      (host.querySelector("#tc-out") as HTMLInputElement).value = "";
      (host.querySelector("#tc-e") as HTMLInputElement).value = "";
      return;
    }
    (host.querySelector("#tc-out") as HTMLInputElement).value = fmt(rcTau(r * ru, c * cu)) + " s";
    (host.querySelector("#tc-e") as HTMLInputElement).value = v === null ? "" : fmt(0.5 * c * cu * v * v) + " J";
  };
  host.querySelectorAll("input,select").forEach((el) => el.addEventListener("input", update));
  host.querySelectorAll("select").forEach((el) => el.addEventListener("change", update));
  update();
  return {};
}

// ── 三相功率 ──
function buildThreePhase(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>线电压</label><div class="tool-inline"><input id="tp-v" class="proto-in" type="number" value="380" /><span class="tool-suffix">V</span></div></div>
        <div class="tool-field"><label>线电流</label><div class="tool-inline"><input id="tp-i" class="proto-in" type="number" value="10" /><span class="tool-suffix">A</span></div></div>
        <div class="tool-field"><label>功率因数</label><div class="tool-inline"><input id="tp-pf" class="proto-in" type="number" step="0.01" value="0.8" /></div></div>
        <div class="tool-field"><label>视在功率</label><div class="tool-inline"><input id="tp-s" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">VA</span></div></div>
        <div class="tool-field"><label>有功功率</label><div class="tool-inline"><input id="tp-p" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">W</span></div></div>
        <div class="tool-field"><label>无功功率</label><div class="tool-inline"><input id="tp-q" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">var</span></div></div>
      </div>
      <div class="tool-formula">${math("S = \\sqrt{3} V I,\\quad P = S \\cos\\varphi,\\quad Q = S \\sin\\varphi")}</div>
    </div>`;
  const update = () => {
    const v = num((host.querySelector("#tp-v") as HTMLInputElement).value);
    const i = num((host.querySelector("#tp-i") as HTMLInputElement).value);
    const pf = num((host.querySelector("#tp-pf") as HTMLInputElement).value);
    if (v === null || i === null || pf === null) {
      (host.querySelector("#tp-s") as HTMLInputElement).value = "";
      (host.querySelector("#tp-p") as HTMLInputElement).value = "";
      (host.querySelector("#tp-q") as HTMLInputElement).value = "";
      return;
    }
    const s = Math.sqrt(3) * v * i;
    const p = s * pf;
    const q = s * Math.sqrt(1 - pf * pf);
    (host.querySelector("#tp-s") as HTMLInputElement).value = fmt(s);
    (host.querySelector("#tp-p") as HTMLInputElement).value = fmt(p);
    (host.querySelector("#tp-q") as HTMLInputElement).value = fmt(q);
  };
  host.querySelectorAll("input").forEach((el) => el.addEventListener("input", update));
  update();
  return {};
}

// ── 频率/波长 ──
function buildFrequencyWavelength(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>频率</label><div class="tool-inline"><input id="fw-f" class="proto-in" type="number" value="100" /><select id="fw-fu" class="tool-sel proto-in"><option value="1">Hz</option><option value="1e3" selected>kHz</option><option value="1e6">MHz</option><option value="1e9">GHz</option></select></div></div>
        <div class="tool-field"><label>波长（真空）</label><div class="tool-inline"><input id="fw-w" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">m</span></div></div>
      </div>
      <div class="tool-formula">${math("\\lambda = c/f")}</div>
    </div>`;
  const update = () => {
    const f = num((host.querySelector("#fw-f") as HTMLInputElement).value);
    const fu = Number((host.querySelector("#fw-fu") as HTMLSelectElement).value);
    if (f === null || f * fu <= 0) {
      (host.querySelector("#fw-w") as HTMLInputElement).value = "";
      return;
    }
    (host.querySelector("#fw-w") as HTMLInputElement).value = fmt(299792458 / (f * fu)) + " m";
  };
  host.querySelectorAll("input,select").forEach((el) => el.addEventListener("input", update));
  host.querySelectorAll("select").forEach((el) => el.addEventListener("change", update));
  update();
  return {};
}

// ── 线径换算 AWG ──
function buildWireGauge(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>AWG</label><div class="tool-inline"><input id="wg-awg" class="proto-in" type="number" min="0" max="40" value="24" /></div></div>
        <div class="tool-field"><label>直径（英寸）</label><div class="tool-inline"><input id="wg-in" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">in</span></div></div>
        <div class="tool-field"><label>直径（毫米）</label><div class="tool-inline"><input id="wg-mm" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">mm</span></div></div>
        <div class="tool-field"><label>圆密耳</label><div class="tool-inline"><input id="wg-cm" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">CM</span></div></div>
      </div>
      <div class="tool-formula">${math("d(mm) = 0.127 \\times 92^{(36-AWG)/39}")}</div>
    </div>`;
  const update = () => {
    const awg = num((host.querySelector("#wg-awg") as HTMLInputElement).value);
    if (awg === null || awg < 0 || awg > 40) {
      (host.querySelector("#wg-in") as HTMLInputElement).value = "";
      (host.querySelector("#wg-mm") as HTMLInputElement).value = "";
      (host.querySelector("#wg-cm") as HTMLInputElement).value = "";
      return;
    }
    const dmm = 0.127 * 92 ** ((36 - awg) / 39);
    (host.querySelector("#wg-in") as HTMLInputElement).value = fmt(dmm / 25.4);
    (host.querySelector("#wg-mm") as HTMLInputElement).value = fmt(dmm);
    (host.querySelector("#wg-cm") as HTMLInputElement).value = fmt((dmm / 25.4 * 1000) ** 2);
  };
  host.querySelector("#wg-awg")!.addEventListener("input", update);
  update();
  return {};
}

// ── 走线阻抗（微带线近似）──
function buildTraceImpedance(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>线宽 W</label><div class="tool-inline"><input id="ti-w" class="proto-in" type="number" value="0.25" /><span class="tool-suffix">mm</span></div></div>
        <div class="tool-field"><label>介质高度 H</label><div class="tool-inline"><input id="ti-h" class="proto-in" type="number" value="0.2" /><span class="tool-suffix">mm</span></div></div>
        <div class="tool-field"><label>铜厚 T</label><div class="tool-inline"><input id="ti-t" class="proto-in" type="number" value="0.035" /><span class="tool-suffix">mm</span></div></div>
        <div class="tool-field"><label>介电常数 εr</label><div class="tool-inline"><input id="ti-e" class="proto-in" type="number" step="0.1" value="4.5" /></div></div>
        <div class="tool-field"><label>特性阻抗</label><div class="tool-inline"><input id="ti-z" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">Ω</span></div></div>
      </div>
      <div class="tool-formula">${math("Z_0 \\approx \\dfrac{87}{\\sqrt{\\epsilon_r+1.41}} \\ln\\left(\\dfrac{5.98H}{0.8W+T}\\right)")}</div>
    </div>`;
  const update = () => {
    const w = num((host.querySelector("#ti-w") as HTMLInputElement).value);
    const h = num((host.querySelector("#ti-h") as HTMLInputElement).value);
    const th = num((host.querySelector("#ti-t") as HTMLInputElement).value);
    const er = num((host.querySelector("#ti-e") as HTMLInputElement).value);
    if (w === null || h === null || th === null || er === null || w <= 0 || h <= 0 || th < 0 || 0.8 * w + th <= 0) {
      (host.querySelector("#ti-z") as HTMLInputElement).value = "";
      return;
    }
    const z = (87 / Math.sqrt(er + 1.41)) * Math.log((5.98 * h) / (0.8 * w + th));
    (host.querySelector("#ti-z") as HTMLInputElement).value = fmt(z);
  };
  host.querySelectorAll("input").forEach((el) => el.addEventListener("input", update));
  update();
  return {};
}

// ── PCB 走线宽度（IPC-2221 近似）──
function buildPcbTraceWidth(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>电流</label><div class="tool-inline"><input id="pcb-i" class="proto-in" type="number" min="0" value="1" /><span class="tool-suffix">A</span></div></div>
        <div class="tool-field"><label>允许温升</label><div class="tool-inline"><input id="pcb-dt" class="proto-in" type="number" min="0" value="10" /><span class="tool-suffix">°C</span></div></div>
        <div class="tool-field"><label>铜厚</label><div class="tool-inline"><input id="pcb-th" class="proto-in" type="number" min="0" value="1" /><select id="pcb-thu" class="tool-sel proto-in"><option value="0.035" selected>1 oz (35 µm)</option><option value="0.07">2 oz (70 µm)</option><option value="0.105">3 oz (105 µm)</option></select></div></div>
        <div class="tool-field"><label>推荐线宽</label><div class="tool-inline"><input id="pcb-w" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">mm</span></div></div>
      </div>
      <div class="tool-formula">${math("A = \\left(\\dfrac{I}{k\\Delta T^{0.44}}\\right)^{1/0.725},\\quad W = \\dfrac{A}{T},\\quad k=0.048")}</div>
    </div>`;
  const update = () => {
    const i = num((host.querySelector("#pcb-i") as HTMLInputElement).value);
    const dt = num((host.querySelector("#pcb-dt") as HTMLInputElement).value);
    const th = num((host.querySelector("#pcb-th") as HTMLInputElement).value);
    if (i === null || dt === null || th === null || i <= 0 || dt <= 0 || th <= 0) {
      (host.querySelector("#pcb-w") as HTMLInputElement).value = "";
      return;
    }
    // IPC-2221: A[mils²] = (I/(k·ΔT^b))^(1/c); W = A/T. 外层(外层走线) k=0.048, b=0.44, c=0.725
    const thickMil = th * 39.3701;
    const areaMils2 = (i / (0.048 * dt ** 0.44)) ** (1 / 0.725);
    const widthMil = areaMils2 / thickMil;
    const widthMm = widthMil * 0.0254;
    (host.querySelector("#pcb-w") as HTMLInputElement).value = fmt(widthMm) + " mm";
  };
  host.querySelectorAll("input,select").forEach((el) => el.addEventListener("input", update));
  host.querySelectorAll("select").forEach((el) => el.addEventListener("change", update));
  update();
  return {};
}

// ── 衰减器 ──
function buildAttenuator(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-tabs">
        <button class="tool-tab active" data-type="pi">Pi</button>
        <button class="tool-tab" data-type="bridgeT">桥 T 型</button>
        <button class="tool-tab" data-type="reflective">反射式</button>
        <button class="tool-tab" data-type="T">T 型</button>
      </div>
      <div class="tools-diagram" id="att-diagram"><img class="tool-diagram" alt="衰减器电路图" /></div>
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.attenuator.atten")}</label><div class="tool-inline"><input id="att-db" class="proto-in" type="number" value="20" /></div></div>
        <div class="tool-field"><label>${t("tools.attenuator.impedance")}</label><div class="tool-inline"><input id="att-z" class="proto-in" type="number" value="50" /><span class="tool-suffix">Ω</span></div></div>
        <div class="tool-field"><label>R₁</label><div class="tool-inline"><input id="att-r1" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">Ω</span></div></div>
        <div class="tool-field"><label>R₂</label><div class="tool-inline"><input id="att-r2" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">Ω</span></div></div>
      </div>
      <div class="tool-formula" id="att-formula"></div>
    </div>`;
  const tabs = host.querySelectorAll<HTMLButtonElement>(".tool-tab");
  const img = host.querySelector<HTMLImageElement>("#att-diagram img")!;
  const db = host.querySelector<HTMLInputElement>("#att-db")!;
  const z = host.querySelector<HTMLInputElement>("#att-z")!;
  const r1 = host.querySelector<HTMLInputElement>("#att-r1")!;
  const r2 = host.querySelector<HTMLInputElement>("#att-r2")!;
  const formula = host.querySelector<HTMLElement>("#att-formula")!;
  const type = () => host.querySelector<HTMLButtonElement>(".tool-tab.active")!.dataset.type!;
  const setDiagram = () => { img.src = toolDiagramVariant("attenuator", type()); };
  const updated = () => {
    setDiagram();
    const dbv = num(db.value);
    const zv = num(z.value);
    if (dbv === null || zv === null || dbv < 0) {
      r1.value = "";
      r2.value = "";
      formula.textContent = "";
      return;
    }
    const res = attn(type() as "pi" | "bridgeT" | "reflective" | "T", dbv, zv);
    if (type() === "reflective") {
      r1.value = `${fmt(res.rHi!)} / ${fmt(res.rLo!)}`;
      r2.value = "";
      formula.innerHTML = math("R_{hi}=Z_0\\dfrac{K+1}{K-1},\\quad R_{lo}=Z_0\\dfrac{K-1}{K+1},\\quad K=10^{A_{dB}/20}");
    } else {
      r1.value = fmt(res.r1);
      r2.value = res.r2 === null ? "" : fmt(res.r2);
      const f = type() === "pi"
        ? math("R_1 = Z_0 \\dfrac{K+1}{K-1},\\quad R_2 = \\dfrac{Z_0}{2}\\dfrac{K^2-1}{K},\\quad K=10^{A_{dB}/20}")
        : type() === "bridgeT"
          ? math("R_1 = Z_0(K-1),\\quad R_2 = \\dfrac{Z_0}{K-1}")
          : math("R_1=Z_0\\dfrac{K-1}{K+1},\\quad R_2=2Z_0\\dfrac{K}{K^2-1}");
      formula.innerHTML = f;
    }
  };
  tabs.forEach((b) => b.addEventListener("click", () => {
    tabs.forEach((x) => x.classList.toggle("active", x === b));
    updated();
  }));
  db.addEventListener("input", updated);
  z.addEventListener("input", updated);
  updated();
  return {};
}

// ── 占位 ──

// ── 小数/分数 ──
function buildFraction(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-field"><label>小数</label><div class="tool-inline"><input id="frac-in" class="proto-in" type="text" value="0.125" /></div></div>
      <div class="tool-resultline" id="frac-out"></div>
    </div>`;
  const input = host.querySelector<HTMLInputElement>("#frac-in")!;
  const out = host.querySelector<HTMLElement>("#frac-out")!;
  const update = () => {
    const v = num(input.value);
    if (v === null || v < 0) {
      out.textContent = "—";
      return;
    }
    let bestN = 0, bestD = 1, bestErr = Math.abs(v);
    for (let d = 1; d <= 10000; d++) {
      const n = Math.round(v * d);
      const err = Math.abs(v - n / d);
      if (err < bestErr - 1e-12) {
        bestErr = err; bestN = n; bestD = d;
        if (err < 1e-9) break;
      }
    }
    out.textContent = `${fmt(bestN, 6)}/${fmt(bestD, 6)} ≈ ${fmt(bestN / bestD, 6)}`;
  };
  input.addEventListener("input", update);
  update();
  return {};
}

// ── 串联/并联电阻 ──
function buildParallelSeriesResistor(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-field"><label>电阻值</label><div class="tool-inline"><input id="res-r1" class="proto-in" type="number" min="0" value="100" /><select class="tool-sel proto-in" id="res-u"><option value="1" selected>Ω</option><option value="1e3">kΩ</option><option value="1e6">MΩ</option></select></div></div>
      <div id="res-rows"></div>
      <div class="tool-actions"><button id="res-add" class="primary">添加电阻器</button><button id="res-remove" class="ghost">移除电阻器</button></div>
      <div class="tool-grid">
        <div class="tool-field"><label>串联总电阻</label><div class="tool-inline"><input id="res-ser" class="tool-output proto-in" readonly placeholder="—" /></div></div>
        <div class="tool-field"><label>并联总电阻</label><div class="tool-inline"><input id="res-par" class="tool-output proto-in" readonly placeholder="—" /></div></div>
      </div>
    </div>`;
  const rows = host.querySelector<HTMLElement>("#res-rows")!;
  let n = 2;
  const row = () => {
    const div = document.createElement("div");
    div.className = "tool-grid";
    div.innerHTML = `<div class="tool-field"><label>R${n}</label><div class="tool-inline"><input class="res-v" type="number" min="0" value="100" /><select class="res-u tool-sel proto-in"><option value="1">Ω</option><option value="1e3" selected>kΩ</option><option value="1e6">MΩ</option></select></div></div>`;
    rows.appendChild(div);
  };
  row();
  const update = () => {
    const values = [host.querySelector<HTMLInputElement>("#res-r1")!, ...rows.querySelectorAll<HTMLInputElement>(".res-v")].map((el) => {
      const v = num(el.value);
      const u = Number((el.parentElement!.querySelector<HTMLSelectElement>(".res-u") ?? el.closest(".tool-panel")!.querySelector<HTMLSelectElement>("#res-u"))!.value);
      return v === null ? null : v * u;
    });
    const ser = seriesRes(values);
    const par = parallelRes(values);
    (host.querySelector("#res-ser") as HTMLInputElement).value = ser === null ? "" : fmt(ser) + " Ω";
    (host.querySelector("#res-par") as HTMLInputElement).value = par === null ? "" : fmt(par) + " Ω";
  };
  host.querySelector("#res-add")!.addEventListener("click", () => { row(); update(); });
  host.querySelector("#res-remove")!.addEventListener("click", () => {
    if (rows.children.length <= 1) return;
    rows.lastElementChild?.remove();
    update();
  });
  host.querySelector("#res-r1")!.addEventListener("input", update);
  host.querySelector("#res-u")!.addEventListener("change", update);
  rows.addEventListener("input", update);
  rows.addEventListener("change", update);
  update();
  return {};
}

// ── 电抗计算器 ──
function buildReactance(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>频率</label><div class="tool-inline"><input id="rx-f" class="proto-in" type="number" min="0" value="1000" /><select id="rx-fu" class="tool-sel proto-in"><option value="1">Hz</option><option value="1e3" selected>kHz</option><option value="1e6">MHz</option></select></div></div>
        <div class="tool-field"><label>电感</label><div class="tool-inline"><input id="rx-l" class="proto-in" type="number" min="0" value="10" /><select id="rx-lu" class="tool-sel proto-in"><option value="1e-9">nH</option><option value="1e-6" selected>µH</option><option value="1e-3">mH</option><option value="1">H</option></select></div></div>
        <div class="tool-field"><label>电容</label><div class="tool-inline"><input id="rx-c" class="proto-in" type="number" min="0" value="10" /><select id="rx-cu" class="tool-sel proto-in"><option value="1e-12">pF</option><option value="1e-9">nF</option><option value="1e-6" selected>µF</option></select></div></div>
        <div class="tool-field"><label>感抗 XL</label><div class="tool-inline"><input id="rx-xl" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">Ω</span></div></div>
        <div class="tool-field"><label>容抗 XC</label><div class="tool-inline"><input id="rx-xc" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">Ω</span></div></div>
      </div>
      <div class="tool-formula">${math("X_L = 2\\pi f L,\\quad X_C = \\dfrac{1}{2\\pi f C}")}</div>
    </div>`;
  const update = () => {
    const f = num((host.querySelector("#rx-f") as HTMLInputElement).value);
    const fu = Number((host.querySelector("#rx-fu") as HTMLSelectElement).value);
    const l = num((host.querySelector("#rx-l") as HTMLInputElement).value);
    const lu = Number((host.querySelector("#rx-lu") as HTMLSelectElement).value);
    const c = num((host.querySelector("#rx-c") as HTMLInputElement).value);
    const cu = Number((host.querySelector("#rx-cu") as HTMLSelectElement).value);
    if (f === null || f * fu <= 0 || l === null || c === null) {
      (host.querySelector("#rx-xl") as HTMLInputElement).value = "";
      (host.querySelector("#rx-xc") as HTMLInputElement).value = "";
      return;
    }
    const r = rx(f * fu, l * lu, c * cu);
    (host.querySelector("#rx-xl") as HTMLInputElement).value = fmt(r.xl);
    (host.querySelector("#rx-xc") as HTMLInputElement).value = fmt(r.xc);
  };
  host.querySelectorAll("input,select").forEach((el) => el.addEventListener("input", update));
  host.querySelectorAll("select").forEach((el) => el.addEventListener("change", update));
  update();
  return {};
}

// ── 工具目录 ──
const TOOLS: ToolDef[] = [
  { id: "555", icon: "⏱", title: "555 定时器计算器", desc: "根据 R1 和 C1 计算单稳态输出脉冲宽度", build: build555 },
  { id: "attenuator", icon: "🔽", title: "衰减器计算器", desc: "Pi / 桥T / 反射式 / T 型衰减器电阻计算", build: buildAttenuator },
  { id: "battery-life", icon: "🔋", title: "电池续航时间计算器", desc: "根据电池容量和负载电流估算续航时间", build: buildBatteryLife },
  { id: "capacitance-conversion", icon: "⚡", title: "电容换算", desc: "pF/nF/µF/F 换算及三位电容代码解读", build: buildCapacitanceConversion },
  { id: "capacitor-safe-discharge", icon: "🛡", title: "电容器安全放电计算器", desc: "计算放电时间、初始功率、时间常数和能量", build: buildCapacitorDischarge },
  { id: "current-divider", icon: "🔀", title: "分流器计算器", desc: "计算多路并联电阻上的分流电流", build: buildCurrentDivider },
  { id: "voltage-divider", icon: "🔽", title: "分压器计算器", desc: "根据输入电压和 R1/R2 计算输出电压", build: buildVoltageDivider },
  { id: "dbm-watt", icon: "📶", title: "dBm 和瓦特转换", desc: "dBm 与 mW/W 之间互转", build: buildDbmWatt },
  { id: "led-resistor", icon: "💡", title: "LED 串联电阻计算器", desc: "根据电源电压、LED 压降和电流计算限流电阻", build: buildLedResistor },
  { id: "ohm", icon: "Ω", title: "欧姆定律计算器", desc: "已知电压电流求电阻与功率", build: buildOhm },
  { id: "filter", icon: "𝍌", title: "低通/高通滤波器计算器", desc: "RC 低通/高通截止频率计算", build: buildFilter },
  { id: "number-base", icon: "🔢", title: "数制转换", desc: "二进制/八进制/十进制/十六进制互转", build: buildNumberBase },
  { id: "parallel-series-cap", icon: "≋", title: "串联和并联电容器计算器", desc: "多个电容器的串联/并联总容量", build: buildParallelSeriesCapacitor },
  { id: "parallel-series-res", icon: "⌁", title: "并联和串联电阻器计算器", desc: "多个电阻器的串联/并联总电阻", build: buildParallelSeriesResistor },
  { id: "reactance", icon: "Ω", title: "电抗计算器", desc: "计算感抗 XL、容抗 XC 与导纳", build: buildReactance },
  { id: "smd-resistor", icon: "🔖", title: "SMD 电阻器代码计算器", desc: "三位代码与 EIA-96 代码解读", build: buildSmdResistor },
  { id: "smd-capacitor", icon: "🔖", title: "SMD 电容器代码计算器", desc: "三位电容代码换算", build: buildSmdCapacitor },
  { id: "color-code", icon: "🌈", title: "电阻器色码计算器", desc: "四环电阻色环值计算", build: buildColorCode },
  { id: "thermistor", icon: "🌡", title: "热敏电阻计算器", desc: "NTC B 值温度换算", build: buildThermistor },
  { id: "time-constant", icon: "⏳", title: "时间常数计算器", desc: "RC 电路时间常数 τ 计算", build: buildTimeConstant },
  { id: "three-phase", icon: "〰", title: "三相功率计算器", desc: "三相交流系统的视在/有功/无功功率", build: buildThreePhase },
  { id: "frequency-wavelength", icon: "📡", title: "频率波长换算", desc: "频率与真空波长互转", build: buildFrequencyWavelength },
  { id: "wire-gauge", icon: "🧵", title: "线径换算器", desc: "AWG 与英寸/毫米/圆密耳换算", build: buildWireGauge },
  { id: "trace-impedance", icon: "🛤", title: "走线阻抗计算器", desc: "微带线 PCB 走线阻抗近似计算", build: buildTraceImpedance },
  { id: "pcb-trace-width", icon: "📐", title: "PCB 印制线宽度计算器", desc: "基于 IPC-2221 的载流线宽估算", build: buildPcbTraceWidth },
  { id: "length", icon: "📏", title: "长度换算", desc: "毫米/厘米/米/英寸/英尺/码/英里互转", build: (h) => buildUnitConverter(h, UNITS.length, "mm", "in", "mm") },
  { id: "weight", icon: "⚖", title: "重量换算", desc: "毫克/克/千克/吨/盎司/磅互转", build: (h) => buildUnitConverter(h, UNITS.weight, "g", "oz", "g") },
  { id: "volume", icon: "🧪", title: "体积和容量换算", desc: "毫升/升/立方米/美制加仑互转", build: (h) => buildUnitConverter(h, UNITS.volume, "ml", "l", "mL") },
  { id: "temperature", icon: "🌡", title: "温度换算", desc: "摄氏/华氏/开尔文互转", build: (h) => buildUnitConverter(h, UNITS.temperature, "c", "f", "°C") },
  { id: "pressure", icon: "🗜", title: "压力换算", desc: "Pa/kPa/MPa/bar/atm/psi/mmHg 互转", build: (h) => buildUnitConverter(h, UNITS.pressure, "kpa", "psi", "kPa") },
  { id: "energy", icon: "⚡", title: "能量换算", desc: "J/kJ/Wh/kWh/BTU/cal/kcal 互转", build: (h) => buildUnitConverter(h, UNITS.energy, "j", "kwh", "J") },
  { id: "force", icon: "💪", title: "力的换算", desc: "N/kN/mN/kgf/lbf 互转", build: (h) => buildUnitConverter(h, UNITS.force, "n", "lbf", "N") },
  { id: "power", icon: "🔌", title: "功率换算", desc: "mW/W/kW/hp/PS 互转", build: (h) => buildUnitConverter(h, UNITS.power, "w", "hp", "W") },
  { id: "inductance", icon: "🔗", title: "电感换算", desc: "nH/µH/mH/H 互转", build: (h) => buildUnitConverter(h, UNITS.inductance, "uh", "nh", "µH") },
  { id: "fraction", icon: "➗", title: "小数/分数换算", desc: "将小数转换为最接近的分数值", build: buildFraction },
];

// ── 页面 ──
export class ToolsPage {
  private root: HTMLElement;
  private activeId = "";
  private search = "";

  constructor(root: HTMLElement) {
    this.root = root;
    this.renderCatalog();
  }

  private q<T extends HTMLElement>(sel: string): T {
    return this.root.querySelector<T>(sel)!;
  }

  private renderCatalog(): void {
    this.activeId = "";
    this.search = "";
    this.root.innerHTML = `
      <div class="tools-page">
        <div class="tools-header">
          <h3>${t("tools.catalog")}</h3>
          <p>嵌入式常用计算工具，数据保存在当前标签页内。</p>
          <input id="tools-search" class="tools-search" type="search" placeholder="${esc(t("tools.search"))}" autocomplete="off" />
        </div>
        <div class="tools-grid" id="tools-grid"></div>
      </div>`;
    this.renderGrid();
    this.q<HTMLInputElement>("#tools-search").addEventListener("input", (e) => {
      this.search = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderGrid();
    });
  }

  private renderGrid(): void {
    const grid = this.root.querySelector<HTMLElement>("#tools-grid");
    if (!grid) return;
    const q = this.search;
    const list = TOOLS.filter(
      (tool) =>
        !q ||
        tool.title.toLowerCase().includes(q) ||
        tool.desc.toLowerCase().includes(q) ||
        tool.id.toLowerCase().includes(q),
    );
    grid.innerHTML = list.length
      ? list
          .map((tool) => `
            <button class="tool-card" data-tool="${tool.id}">
              <span class="tool-icon">${tool.icon}</span>
              <span class="tool-title">${esc(tool.title)}</span>
              <span class="tool-desc">${esc(tool.desc)}</span>
            </button>`).join("")
      : `<div class="tools-empty">${esc(t("tools.empty"))}</div>`;
    grid.querySelectorAll<HTMLButtonElement>(".tool-card").forEach((btn) =>
      btn.addEventListener("click", () => this.open(btn.dataset.tool!)),
    );
  }

  private open(id: string): void {
    const def = TOOLS.find((x) => x.id === id);
    if (!def) return;
    this.activeId = id;
    const diag = toolDiagram(id);
    this.root.innerHTML = `
      <div class="tools-page">
        <div class="tools-detail-head">
          <button id="tools-back" class="ghost">← ${t("tools.back")}</button>
          <div class="tools-title-line"><span class="tool-icon">${def.icon}</span><h3>${esc(def.title)}</h3></div>
          <p>${esc(def.desc)}</p>
        </div>
        ${diag ? `<div class="tools-diagram"><img class="tool-diagram" src="${diag}" alt="${esc(def.title)} 原理图" /></div>` : ""}
        <div class="tools-detail-body" id="tools-host"></div>
      </div>`;
    this.q("#tools-back").addEventListener("click", () => this.renderCatalog());
    def.build(this.q("#tools-host"));
  }

  snapshot(): Record<string, string> {
    return this.activeId ? { __active: this.activeId } : {};
  }

  applySnapshot(snap: Record<string, string>): void {
    const id = snap["__active"];
    if (id && TOOLS.some((x) => x.id === id)) this.open(id);
  }
}
