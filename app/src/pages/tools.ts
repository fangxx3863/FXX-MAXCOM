// 工具页：左侧栏「工具」入口。以卡片目录 + 详情页方式提供嵌入式常用计算器。
// 每个工具注册一个 ToolDef（标题/图标/说明/构建器）。构建器返回 ToolController，负责自己的 DOM 与事件。
import { t } from "../i18n";
import katex from "katex";
import "katex/dist/katex.min.css";
import { toolDiagram, toolDiagramVariant } from "../tools-diagrams";
import {
  mono555, astable555, attenuator as attn,
  capCode3, batteryLifeHours, ohmLaw, reactance as rx,
  rcTau, ledResistor, ledPower, filterFc, dbmToMwt, capDischarge,
  seriesRes, parallelRes, seriesCap, parallelCap,
  traceImpedance as tImp, type TraceTopo, type TraceDir, type TraceInput,
} from "../tools-math";
import {
  dbToLinear, linearToDb, bandwidthFromRiseTime, riseTimeFromBandwidth,
  vToDbv, vToDbu, vToDbm, dbvToV, dbuToV, dbmToV,
  crest, type CrestWave, vrmsFromVpeak, vpeakFromVrms, voltageFromPowerMw,
  gainToDb, dbToGain, gainToNp, npToGain,
  AIR_Z0, paToSpl, splToPa, soundIntensity, paFromIntensity, intensityToSil,
  pacToLw, lwToPac, pointArea,
} from "../tools-math";

function math(src: string): string {
  return katex.renderToString(src, { throwOnError: false, displayMode: false });
}

// 目录卡片与详情页标题/说明走 i18n：键为 tools.<id>.title / tools.<id>.desc
const tTitle = (id: string): string => t(`tools.${id}.title`);
const tDesc = (id: string): string => t(`tools.${id}.desc`);


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

// ── 通用工程计数法 ──
// 把数值缩放进 [1e-3, 1e3) 的尾数并配 SI 前缀：0.00002 F → 20 µF、500000 Ω → 500 kΩ、
// 5000 W → 5 kW；而 0.5 W、6 W、0.1 s、0.005 J、0.0628 Ω 等本例原值保持不动，
// 避免把已可读的小数值强行压成 mW/mJ/mΩ。
function engScale(v: number): { m: number; p: string } {
  if (!Number.isFinite(v)) return { m: v, p: "" };
  if (v === 0) return { m: 0, p: "" };
  const a = Math.abs(v);
  if (a >= 1e9) return { m: v / 1e9, p: "G" };
  if (a >= 1e6) return { m: v / 1e6, p: "M" };
  if (a >= 1e3) return { m: v / 1e3, p: "k" };
  if (a >= 1e-3) return { m: v, p: "" };
  if (a >= 1e-6) return { m: v * 1e6, p: "µ" };
  if (a >= 1e-9) return { m: v * 1e9, p: "n" };
  return { m: v * 1e12, p: "p" };
}

// 值+单位 一体字符串：如 20 µF、500 kΩ、5 kW。
function fmtEng(v: number, unit: string): string {
  if (!Number.isFinite(v)) return "—";
  const { m, p } = engScale(v);
  return `${fmt(m)} ${p}${unit}`.trim();
}

// 把「数值放 input、单位放 tool-suffix span」的输出赋值：数值按工程计数缩放到尾数，
// span 文字设为 前缀+单位（如 500 | kΩ）。返回一个 setter 供 update 复用。
function setEng(input: HTMLInputElement, baseUnit: string): (v: number) => void {
  const sfx = input.parentElement?.querySelector<HTMLElement>(".tool-suffix");
  return (v: number) => {
    if (!Number.isFinite(v)) { input.value = ""; if (sfx) sfx.textContent = baseUnit; return; }
    if (v === 0) { input.value = "0"; if (sfx) sfx.textContent = baseUnit; return; }
    const { m, p } = engScale(v);
    input.value = fmt(m);
    if (sfx) sfx.textContent = p + baseUnit;
  };
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
      <div class="tool-resultline">${t("tools.formula")}: ${t("tools.unitConverterNote")}</div>
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
        <button class="tool-tab active" data-mode="mono">${t("tools.555.mono")}</button>
        <button class="tool-tab" data-mode="astable">${t("tools.555.astable")}</button>
      </div>
      <div class="tools-diagram" id="t555-diagram"><img class="tool-diagram" alt="${t("tools.555.diagramAlt")}" /></div>
      <div class="tool-grid" id="t555-grid">
        <div class="tool-field"><label>${t("tools.555.r1")}</label><div class="tool-inline"><input id="t555-r1" class="proto-in" type="number" min="0" value="100" /><select id="t555-r1s" class="tool-sel proto-in"><option value="1">Ω</option><option value="1e3">kΩ</option><option value="1e6">MΩ</option></select></div></div>
        <div class="tool-field"><label>${t("tools.555.c1")}</label><div class="tool-inline"><input id="t555-c" class="proto-in" type="number" min="0" value="10" /><select id="t555-cs" class="tool-sel proto-in"><option value="1e-12">pF</option><option value="1e-9">nF</option><option value="1e-6" selected>µF</option><option value="1e-3">mF</option><option value="1">F</option></select></div></div>
        <div class="tool-field" id="t555-out-box"><label>${t("tools.555.outPulse")}</label><div class="tool-inline"><input id="t555-out" class="tool-output proto-in" readonly placeholder="—" /><select id="t555-os" class="tool-sel proto-in"><option value="1e-3" selected>ms</option><option value="1">s</option><option value="60">min</option></select></div><div class="tool-resultline" id="t555-lines" hidden></div></div>
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
  const lines = host.querySelector<HTMLElement>("#t555-lines")!;

  let mode = "mono";
  img.src = toolDiagramVariant("555", mode);
  // 非稳态额外需要 R2：字段按需创建；切回单稳态时整体移除，再来时重新创建。
  // 之前的实现复用一个 r2Field，切回单稳态只删掉它内部的 R2 输入子节点、留下残缺节点，
  // 再次进入非稳态时 `#t555-r2` 已是 null → addEventListener 抛错，页面切不回去。
  let r2Field: HTMLElement | null = null;
  let r2Input: HTMLInputElement | null = null;
  let r2Unit: HTMLSelectElement | null = null;

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
    const r2v = num(r2Input!.value);
    const r2m = Number(r2Unit!.value);
    const R2 = r2v === null ? null : r2v * r2m;
    if (R1 === null || R2 === null || C === null || R1 <= 0 || R2 <= 0 || C <= 0) {
      out.value = ""; return;
    }
    const a = astable555(R1, R2, C);
    formula.innerHTML = math(
      `t_H = 0.693(R_1{+}R_2)C_1,\\quad t_L = 0.693\\,R_2 C_1,\\quad f=\\dfrac{1.44}{(R_1{+}2R_2)C_1}`,
    );
    // 非稳态是多值结果（频率/高电平/低电平/占空比），塞进单行 input 会被截断；
    // 且时间单位须跟随所选单位，不能写死 ms。改用可换行的 resultline 展示。
    const unit = os.selectedOptions[0].textContent;
    lines.textContent =
      `${t("tools.555.freq")} ${fmtEng(a.freq, "Hz")}\n` +
      `${t("tools.555.tHigh")} ${fmt(a.tHigh / om)} ${unit}\n` +
      `${t("tools.555.tLow")} ${fmt(a.tLow / om)} ${unit}\n` +
      `${t("tools.555.duty")} ${fmt(a.duty * 100, 4)} %`;
  };

  const setMode = (m: string) => {
    mode = m;
    img.src = toolDiagramVariant("555", m);
    if (m === "astable") {
      if (!r2Field) {
        r2Field = document.createElement("div");
        r2Field.className = "tool-field";
        r2Field.innerHTML = `<label>${t("tools.555.r2")}</label><div class="tool-inline"><input id="t555-r2" class="proto-in" type="number" min="0" value="47" /><select id="t555-r2s" class="tool-sel proto-in"><option value="1">Ω</option><option value="1e3" selected>kΩ</option><option value="1e6">MΩ</option></select></div></div>`;
        r2Input = r2Field.querySelector<HTMLInputElement>("#t555-r2")!;
        r2Unit = r2Field.querySelector<HTMLSelectElement>("#t555-r2s")!;
        // 新建的 R2 输入/单位必须绑定事件，否则改 R2 不重算
        r2Input.addEventListener("input", update);
        r2Unit.addEventListener("change", update);
        grid.insertBefore(r2Field, outBox);
      }
      outBox.querySelector("label")!.textContent = t("tools.555.outProps");
      out.style.display = "none"; // 非稳态用多行 resultline 展示，隐藏单值输入框
      os.style.display = "";     // 时间单位选择保留生效（作用于 t_H / t_L）
      lines.hidden = false;
    } else {
      if (r2Field) {
        r2Field.remove();
        r2Field = null;
        r2Input = null;
        r2Unit = null;
      }
      outBox.querySelector("label")!.textContent = t("tools.555.outPulse");
      out.style.display = "";
      os.style.display = "";
      lines.hidden = true;
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
        <div class="tool-field"><label>${t("tools.battery.capacity")}</label><div class="tool-inline"><input id="bt-cap" class="proto-in" type="number" min="0" value="1000" /><select id="bt-capu" class="tool-sel proto-in"><option value="1" selected>mAh</option><option value="1000">Ah</option><option value="0.001">µAh</option></select></div></div>
        <div class="tool-field"><label>${t("tools.battery.power")}</label><div class="tool-inline"><input id="bt-cur" class="proto-in" type="number" min="0" value="100" /><select id="bt-curu" class="tool-sel proto-in"><option value="1" selected>mA</option><option value="1000">A</option><option value="0.001">µA</option></select></div></div>
        <div class="tool-field"><label>${t("tools.battery.runTime")}</label><div class="tool-inline"><input id="bt-out" class="tool-output proto-in" readonly placeholder="—" /><select id="bt-outu" class="tool-sel proto-in"><option value="1" selected>${t("tools.battery.hour")}</option><option value="1/24">${t("tools.battery.day")}</option><option value="1/8760">${t("tools.battery.year")}</option></select></div></div>
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
        <div class="tool-field"><label>${t("tools.cap.picofarad")}</label><div class="tool-inline"><input id="cap-pf" class="proto-in" type="number" min="0" placeholder="pF" /></div></div>
        <div class="tool-field"><label>${t("tools.cap.nanofarad")}</label><div class="tool-inline"><input id="cap-nf" class="proto-in" type="number" min="0" placeholder="nF" /></div></div>
        <div class="tool-field"><label>${t("tools.cap.microfarad")}</label><div class="tool-inline"><input id="cap-uf" class="proto-in" type="number" min="0" placeholder="µF" /></div></div>
        <div class="tool-field"><label>${t("tools.cap.farad")}</label><div class="tool-inline"><input id="cap-f" class="proto-in" type="number" min="0" placeholder="F" /></div></div>
        <div class="tool-field"><label>${t("tools.cap.threeDigit")}</label><div class="tool-inline"><input id="cap-code" class="proto-in" type="text" value="104" placeholder="${t("tools.cap.codePlaceholder")}" /></div></div>
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
        <div class="tool-field"><label>${t("tools.capd.capacitance")}</label><div class="tool-inline"><input id="capd-c" class="proto-in" type="number" min="0" value="100" /><select id="capd-cu" class="tool-sel proto-in"><option value="1e-12">pF</option><option value="1e-9">nF</option><option value="1e-6" selected>µF</option><option value="1">F</option></select></div></div>
        <div class="tool-field"><label>${t("tools.capd.v0")}</label><div class="tool-inline"><input id="capd-v0" class="proto-in" type="number" min="0" value="100" /><span class="tool-suffix">V</span></div></div>
        <div class="tool-field"><label>${t("tools.capd.vSafe")}</label><div class="tool-inline"><input id="capd-vs" class="proto-in" type="number" min="0" value="1" /><span class="tool-suffix">V</span></div></div>
        <div class="tool-field"><label>${t("tools.capd.resistance")}</label><div class="tool-inline"><input id="capd-r" class="proto-in" type="number" min="0" value="100" /><select id="capd-ru" class="tool-sel proto-in"><option value="1">Ω</option><option value="1e3" selected>kΩ</option><option value="1e6">MΩ</option></select></div></div>
        <div class="tool-field"><label>${t("tools.capd.timeToSafe")}</label><div class="tool-inline"><input id="capd-t" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">s</span></div></div>
        <div class="tool-field"><label>${t("tools.capd.initPower")}</label><div class="tool-inline"><input id="capd-p" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">W</span></div></div>
        <div class="tool-field"><label>${t("tools.capd.tau")}</label><div class="tool-inline"><input id="capd-tau" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">s</span></div></div>
        <div class="tool-field"><label>${t("tools.capd.energy")}</label><div class="tool-inline"><input id="capd-e" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">J</span></div></div>
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
    setEng(host.querySelector<HTMLInputElement>("#capd-t")!, "s")(d.time);
    setEng(host.querySelector<HTMLInputElement>("#capd-p")!, "W")(d.power);
    setEng(host.querySelector<HTMLInputElement>("#capd-tau")!, "s")(d.tau);
    setEng(host.querySelector<HTMLInputElement>("#capd-e")!, "J")(d.energy);
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
      <div class="tool-field"><label>${t("tools.cd.currentSource")}</label><div class="tool-inline"><input id="cd-total" class="proto-in" type="number" min="0" value="1" /><select id="cd-totalu" class="tool-sel proto-in"><option value="1" selected>A</option><option value="0.001">mA</option><option value="1e-6">µA</option></select></div></div>
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
      setEng(o, "A")((is * iu * total) / list[idx]!);
    });
    result.textContent = `I_total = ${fmtEng(is * iu, "A")}, R_total = ${fmtEng(total, "Ω")}`;
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
  const fmtRes = (v: number) => fmtEng(v, "Ω");
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
        <button class="tool-tab" data-vdtab="fit">${t("tools.vd.fit")}</button>
      </div>
      <div data-vdpanel="calc">
        <div class="tool-grid">
          <div class="tool-field"><label>${t("tools.vd.vin")}</label><div class="tool-inline"><input id="vd-vin" class="proto-in" type="number" value="12" /><span class="tool-suffix">V</span></div></div>
          <div class="tool-field"><label>R1</label><div class="tool-inline"><input id="vd-r1" class="proto-in" type="number" min="0" value="1000" /><select id="vd-r1u" class="tool-sel proto-in"><option value="1">Ω</option><option value="1e3" selected>kΩ</option><option value="1e6">MΩ</option></select></div></div>
          <div class="tool-field"><label>R2</label><div class="tool-inline"><input id="vd-r2" class="proto-in" type="number" min="0" value="1000" /><select id="vd-r2u" class="tool-sel proto-in"><option value="1">Ω</option><option value="1e3" selected>kΩ</option><option value="1e6">MΩ</option></select></div></div>
          <div class="tool-field"><label>${t("tools.vd.vout")}</label><div class="tool-inline"><input id="vd-vout" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">V</span></div></div>
        </div>
        <div class="tool-formula">${math("V_{out} = V_{in} \\times \\dfrac{R_2}{R_1+R_2}")}</div>
      </div>
      <div data-vdpanel="fit" class="hidden">
        <div class="tool-grid">
          <div class="tool-field"><label>${t("tools.vd.vin")}</label><div class="tool-inline"><input id="fd-vin" class="proto-in" type="number" value="12" /><span class="tool-suffix">V</span></div></div>
          <div class="tool-field"><label>${t("tools.vd.want")}</label><div class="tool-inline"><input id="fd-vout" class="proto-in" type="number" value="0.6" /><span class="tool-suffix">V</span></div></div>
          <div class="tool-field"><label>${t("tools.vd.series")}</label><select id="fd-series" class="proto-in"><option value="e24" selected>E24</option><option value="e96">E96</option></select></div>
        </div>
        <table class="tools-fit-table">
          <thead><tr><th>${t("tools.vd.r1")}</th><th>${t("tools.vd.r2")}</th><th>${t("tools.vd.vout")}</th></tr></thead>
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
    const voutEl = host.querySelector<HTMLInputElement>("#vd-vout")!;
    if (vin === null || r1 === null || r2 === null || r1 * r1u + r2 * r2u === 0) {
      voutEl.value = "";
      return;
    }
    const vout = vin * (r2 * r2u) / (r1 * r1u + r2 * r2u);
    setEng(voutEl, "V")(vout);
  };
  const updateFit = () => {
    const vin = num((host.querySelector("#fd-vin") as HTMLInputElement).value);
    const want = num((host.querySelector("#fd-vout") as HTMLInputElement).value);
    const series = (host.querySelector("#fd-series") as HTMLSelectElement).value;
    const tbody = host.querySelector<HTMLTableSectionElement>("#fd-rows")!;
    if (vin === null || want === null || vin <= 0 || want <= 0 || want >= vin) {
      tbody.replaceChildren();
      setTextById(host, "#fd-count", t("tools.vd.fitErr"));
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
    setTextById(host, "#fd-count", t("tools.vd.fitCount", { n: top.length }));
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
        <div class="tool-field"><label>${t("tools.dbm.watt")}</label><div class="tool-inline"><input id="dbm-w" class="proto-in" type="number" value="0.001" /><span class="tool-suffix">W</span></div></div>
        <div class="tool-field"><label>${t("tools.dbm.milliwatt")}</label><div class="tool-inline"><input id="dbm-mw" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">mW</span></div></div>
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
        <div class="tool-field"><label>${t("tools.led.vs")}</label><div class="tool-inline"><input id="led-vs" class="proto-in" type="number" value="5" /><span class="tool-suffix">V</span></div></div>
        <div class="tool-field"><label>${t("tools.led.vf")}</label><div class="tool-inline"><input id="led-vf" class="proto-in" type="number" value="2" /><span class="tool-suffix">V</span></div></div>
        <div class="tool-field"><label>${t("tools.led.if")}</label><div class="tool-inline"><input id="led-if" class="proto-in" type="number" value="20" /><select id="led-ifu" class="tool-sel proto-in"><option value="0.001" selected>mA</option><option value="1">A</option></select></div></div>
        <div class="tool-field"><label>${t("tools.led.r")}</label><div class="tool-inline"><input id="led-r" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">Ω</span></div></div>
        <div class="tool-field"><label>${t("tools.led.watt")}</label><div class="tool-inline"><input id="led-w" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">W</span></div></div>
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
      (host.querySelector("#led-w") as HTMLInputElement).value = "";
      return;
    }
    setEng(host.querySelector<HTMLInputElement>("#led-r")!, "Ω")(ledResistor(vs, vf, ifv * ifu));
    setEng(host.querySelector<HTMLInputElement>("#led-w")!, "W")(ledPower(vs, vf, ifv * ifu));
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
        <div class="tool-field"><label>${t("tools.ohm.v")}</label><div class="tool-inline"><input id="ohm-v" class="proto-in" type="number" value="5" /><span class="tool-suffix">V</span></div></div>
        <div class="tool-field"><label>${t("tools.ohm.i")}</label><div class="tool-inline"><input id="ohm-i" class="proto-in" type="number" value="0.1" /><select id="ohm-iu" class="tool-sel proto-in"><option value="1" selected>A</option><option value="0.001">mA</option><option value="1e-6">µA</option></select></div></div>
        <div class="tool-field"><label>${t("tools.ohm.r")}</label><div class="tool-inline"><input id="ohm-r" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">Ω</span></div></div>
      </div>
      <div class="tool-resultline" id="ohm-line"></div>
      <div class="tool-formula">${math("R = V/I,\\quad P = V \\times I")}</div>
    </div>`;
  const update = () => {
    const v = num((host.querySelector("#ohm-v") as HTMLInputElement).value);
    const i = num((host.querySelector("#ohm-i") as HTMLInputElement).value);
    const iu = Number((host.querySelector("#ohm-iu") as HTMLSelectElement).value);
    const iOut = host.querySelector<HTMLInputElement>("#ohm-r")!;
    const line = host.querySelector<HTMLElement>("#ohm-line")!;
    const setOut = setEng(iOut, "Ω");
    if (v === null || i === null || i * iu === 0) {
      iOut.value = "";
      line.textContent = "";
      return;
    }
    const o = ohmLaw(v, i * iu);
    // 功率 P 是独立结果，不应塞进带 Ω 后缀的电阻输入框（会被截断且单位重复）；
    // 阻值/功率都用工程计数法缩放（500000→500 kΩ、5000→5 kW）
    setOut(o.r);
    line.textContent = t("tools.ohm.power", { p: fmtEng(o.p, "W") });
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
      <div class="tools-diagram" id="flt-diagram"><img class="tool-diagram" alt="${esc(t("tools.filter.diagramAlt"))}" /></div>
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.filter.type")}</label><select id="flt-type" class="proto-in"><option value="rc" selected>RC</option><option value="rl">RL</option><option value="lc">LC</option></select></div>
        <div class="tool-field"><label>${t("tools.filter.band")}</label><select id="flt-band" class="proto-in"><option value="lp" selected>${t("tools.filter.lp")}</option><option value="hp">${t("tools.filter.hp")}</option></select></div>
        <div class="tool-field"><label>${t("tools.filter.r")}</label><div class="tool-inline"><input id="flt-r" class="proto-in" type="number" min="0" value="1000" /><select id="flt-ru" class="tool-sel proto-in"><option value="1">Ω</option><option value="1e3" selected>kΩ</option><option value="1e6">MΩ</option></select></div></div>
        <div class="tool-field"><label>${t("tools.filter.c")}</label><div class="tool-inline"><input id="flt-c" class="proto-in" type="number" min="0" value="100" /><select id="flt-cu" class="tool-sel proto-in"><option value="1e-12">pF</option><option value="1e-9">nF</option><option value="1e-6" selected>µF</option></select></div></div>
        <div class="tool-field"><label>${t("tools.filter.l")}</label><div class="tool-inline"><input id="flt-l" class="proto-in" type="number" min="0" value="10" /><select id="flt-lu" class="tool-sel proto-in"><option value="1e-9">nH</option><option value="1e-6" selected>µH</option><option value="1e-3">mH</option><option value="1">H</option></select></div></div>
        <div class="tool-field"><label>${t("tools.filter.fc")}</label><div class="tool-inline"><input id="flt-f" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">Hz</span></div></div>
      </div>
      <div class="tool-formula" id="flt-formula"></div>
    </div>`;
  const type = host.querySelector<HTMLSelectElement>("#flt-type")!;
  const band = host.querySelector<HTMLSelectElement>("#flt-band")!;
  const formula = host.querySelector<HTMLElement>("#flt-formula")!;
  const diagram = host.querySelector<HTMLElement>("#flt-diagram")!;
  const diagImg = diagram.querySelector<HTMLImageElement>("img")!;
  const update = () => {
    const ftype = type.value;
    const src = toolDiagramVariant("filter", `${ftype}_${band.value}`);
    if (src) { diagImg.src = src; diagram.style.display = ""; }
    else { diagram.style.display = "none"; }
    const bandLabel = band.value === "hp" ? t("tools.filter.bandHp") : t("tools.filter.bandLp");
    const r = num((host.querySelector("#flt-r") as HTMLInputElement).value);
    const c = num((host.querySelector("#flt-c") as HTMLInputElement).value);
    const l = num((host.querySelector("#flt-l") as HTMLInputElement).value);
    const ru = Number((host.querySelector("#flt-ru") as HTMLSelectElement).value);
    const cu = Number((host.querySelector("#flt-cu") as HTMLSelectElement).value);
    const lu = Number((host.querySelector("#flt-lu") as HTMLSelectElement).value);
    const f = filterFc(ftype as "rc" | "rl" | "lc", r === null ? null : r * ru, c === null ? null : c * cu, l === null ? null : l * lu);
    const bandSpan = `<span class="tool-band">${esc(bandLabel)}</span> `;
    if (ftype === "rc") formula.innerHTML = bandSpan + math("f_c = \\dfrac{1}{2\\pi RC}");
    else if (ftype === "rl") formula.innerHTML = bandSpan + math("f_c = \\dfrac{R}{2\\pi L}");
    else formula.innerHTML = bandSpan + math("f_c = \\dfrac{1}{2\\pi\\sqrt{LC}}");
    setEng(host.querySelector<HTMLInputElement>("#flt-f")!, "Hz")(f === null ? NaN : f);
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
        <div class="tool-field"><label>${t("tools.nb.dec")}</label><div class="tool-inline"><input id="nb-d" class="proto-in" type="text" value="42" /></div></div>
        <div class="tool-field"><label>${t("tools.nb.hex")}</label><div class="tool-inline"><input id="nb-h" class="proto-in" type="text" value="2A" /></div></div>
        <div class="tool-field"><label>${t("tools.nb.oct")}</label><div class="tool-inline"><input id="nb-o" class="proto-in" type="text" value="52" /></div></div>
        <div class="tool-field"><label>${t("tools.nb.bin")}</label><div class="tool-inline"><input id="nb-b" class="proto-in" type="text" value="101010" /></div></div>
      </div>
      <div class="nb-bithead">
        <label>${t("tools.nb.bitsize")}</label>
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
      <div class="tool-field"><label>${t("tools.pscap.value")}</label><div class="tool-inline"><input id="cap-c1" class="proto-in" type="number" min="0" value="10" /><select class="tool-sel proto-in" id="cap-u"><option value="1e-12">pF</option><option value="1e-9">nF</option><option value="1e-6" selected>µF</option></select></div></div>
      <div id="cap-rows"></div>
      <div class="tool-actions"><button id="cap-add" class="primary">${t("tools.addCapacitor")}</button><button id="cap-remove" class="ghost">${t("tools.removeCapacitor")}</button></div>
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.pscap.par")}</label><div class="tool-inline"><input id="cap-par" class="tool-output proto-in" readonly placeholder="—" /></div></div>
        <div class="tool-field"><label>${t("tools.pscap.ser")}</label><div class="tool-inline"><input id="cap-ser" class="tool-output proto-in" readonly placeholder="—" /></div></div>
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
    (host.querySelector("#cap-par") as HTMLInputElement).value = par === null ? "" : fmtEng(par, "F");
    (host.querySelector("#cap-ser") as HTMLInputElement).value = ser === null ? "" : fmtEng(ser, "F");
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
        <button class="tool-tab active" data-mode="3">${t("tools.smdr.tab3")}</button>
        <button class="tool-tab" data-mode="4">${t("tools.smdr.tab4")}</button>
        <button class="tool-tab" data-mode="96">${t("tools.smdr.tab96")}</button>
      </div>
      <div class="tool-field"><label>${t("tools.smdr.code")}</label><div class="tool-inline"><input id="smdr-code" class="proto-in" type="text" value="103" placeholder="${t("tools.smdr.placeholder")}" /></div></div>
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
        <button class="tool-tab active" data-mode="3">${t("tools.smdc.tab3")}</button>
        <button class="tool-tab" data-mode="4">${t("tools.smdc.tab4")}</button>
      </div>
      <div class="tool-field"><label>${t("tools.smdc.code")}</label><div class="tool-inline"><input id="smdc-code" class="proto-in" type="text" value="104" placeholder="${t("tools.smdc.placeholder")}" /></div></div>
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
  const colors: [string, number, string][] = [["black",0,""],["brown",1,"±1%"],["red",2,"±2%"],["orange",3,""],["yellow",4,""],["green",5,"±0.5%"],["blue",6,"±0.25%"],["violet",7,"±0.1%"],["gray",8,""],["white",9,""],["gold",-1,"±5%"],["silver",-2,"±10%"]];
  const digits = colors.slice(0, 10);
  const tempcoef: [string, number][] = [["brown",100],["red",50],["orange",15],["yellow",25],["blue",10],["violet",5],["gray",1]];
  const colorName = (k: string): string => t(`tools.cc.colors.${k}`);
  const opt = (arr: [string, number, string][], sel: number) => arr.map((c, i) => `<option value="${i}"${i === sel ? " selected" : ""}>${esc(colorName(c[0]))}</option>`).join("");
  const oid = (arr: [string, number][], sel: number) => arr.map((c, i) => `<option value="${i}"${i === sel ? " selected" : ""}>${esc(colorName(c[0]))}</option>`).join("");
  let cur = 4;
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.cc.band")}</label><select id="cc-band" class="tool-sel proto-in"><option value="4" selected>4 环</option><option value="5">5 环</option><option value="6">6 环</option></select></div>
        <div class="tool-field"><label>${t("tools.cc.d1")}</label><select id="cc-a" class="proto-in">${opt(digits,1)}</select></div>
        <div class="tool-field"><label>${t("tools.cc.d2")}</label><select id="cc-b" class="proto-in">${opt(digits,0)}</select></div>
        <div class="tool-field" id="cc-d3f"><label>${t("tools.cc.d3")}</label><select id="cc-d3" class="proto-in">${opt(digits,0)}</select></div>
        <div class="tool-field"><label>${t("tools.cc.mult")}</label><select id="cc-m" class="proto-in">${opt(colors,2)}</select></div>
        <div class="tool-field"><label>${t("tools.cc.tol")}</label><select id="cc-t" class="proto-in">${opt(colors,10)}</select></div>
        <div class="tool-field" id="cc-tcf"><label>${t("tools.cc.tc")}</label><select id="cc-tc" class="proto-in">${oid(tempcoef,0)}</select></div>
      </div>
      <div class="tool-resultline" id="cc-result"></div>
    </div>`;
  const res = host.querySelector<HTMLElement>("#cc-result")!;
  const show = (n: number) => {
    cur = n;
    (host.querySelector("#cc-d3f") as HTMLElement).style.display = n >= 5 ? "" : "none";
    (host.querySelector("#cc-tcf") as HTMLElement).style.display = n >= 6 ? "" : "none";
  };
  const update = () => {
    const g = (id: string) => Number((host.querySelector(id) as HTMLSelectElement).value);
    const get = (id: string) => colors[g(id)]!;
    const d1 = get("#cc-a");
    const d2 = get("#cc-b");
    const m = get("#cc-m");
    const tol = get("#cc-t");
    let value: number;
    let sig3 = "";
    if (cur >= 5) {
      const d3 = get("#cc-d3");
      sig3 = d3[0] + " ";
      value = (d1[1] * 100 + d2[1] * 10 + d3[1]) * 10 ** m[1];
    } else {
      value = (d1[1] * 10 + d2[1]) * 10 ** m[1];
    }
    let msg = `${colorName(d1[0])} ${colorName(d2[0])} ${sig3}${colorName(m[0])} ${colorName(tol[0])} = ${fmt(value)} Ω ${tol[2]}`;
    if (cur >= 6) {
      const tc = tempcoef[g("#cc-tc")];
      msg += `（${colorName(tc[0])} ${tc[1]} ppm/K）`;
    }
    res.textContent = msg;
  };
  host.querySelectorAll("select").forEach((el) => el.addEventListener("change", () => {
    if (el.id === "cc-band") show(Number((el as HTMLSelectElement).value));
    update();
  }));
  show(4);
  update();
  return {};
}

// ── 热敏电阻 ──
function buildThermistor(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.th.r0")}</label><div class="tool-inline"><input id="th-r0" class="proto-in" type="number" min="0" value="10000" /><span class="tool-suffix">Ω</span></div></div>
        <div class="tool-field"><label>${t("tools.th.t0")}</label><div class="tool-inline"><input id="th-t0" class="proto-in" type="number" value="25" /><span class="tool-suffix">°C</span></div></div>
        <div class="tool-field"><label>${t("tools.th.r")}</label><div class="tool-inline"><input id="th-r" class="proto-in" type="number" min="0" value="10000" /><span class="tool-suffix">Ω</span></div></div>
        <div class="tool-field"><label>${t("tools.th.b")}</label><div class="tool-inline"><input id="th-b" class="proto-in" type="number" min="0" value="3950" /><span class="tool-suffix">K</span></div></div>
        <div class="tool-field"><label>${t("tools.th.t")}</label><div class="tool-inline"><input id="th-t" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">°C</span></div></div>
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
        <div class="tool-field"><label>${t("tools.tc.r")}</label><div class="tool-inline"><input id="tc-r" class="proto-in" type="number" min="0" value="1000" /><select id="tc-ru" class="tool-sel proto-in"><option value="1">Ω</option><option value="1e3" selected>kΩ</option><option value="1e6">MΩ</option></select></div></div>
        <div class="tool-field"><label>${t("tools.tc.c")}</label><div class="tool-inline"><input id="tc-c" class="proto-in" type="number" min="0" value="10" /><select id="tc-cu" class="tool-sel proto-in"><option value="1e-12">pF</option><option value="1e-9">nF</option><option value="1e-6" selected>µF</option></select></div></div>
        <div class="tool-field"><label>${t("tools.tc.v")}</label><div class="tool-inline"><input id="tc-v" class="proto-in" type="number" min="0" value="12" /><span class="tool-suffix">V</span></div></div>
        <div class="tool-field"><label>${t("tools.tc.tau")}</label><div class="tool-inline"><input id="tc-out" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">s</span></div></div>
        <div class="tool-field"><label>${t("tools.tc.energy")}</label><div class="tool-inline"><input id="tc-e" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">J</span></div></div>
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
    setEng(host.querySelector<HTMLInputElement>("#tc-out")!, "s")(rcTau(r * ru, c * cu));
    setEng(host.querySelector<HTMLInputElement>("#tc-e")!, "J")(v === null ? NaN : 0.5 * c * cu * v * v);
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
      <div class="tools-diagram" id="tp-diagram"><img class="tool-diagram" alt="${esc(t("tools.tp.diagramAlt"))}" /></div>
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.tp.conn")}</label><select id="tp-conn" class="proto-in"><option value="y" selected>${t("tools.tp.y")}</option><option value="delta">${t("tools.tp.delta")}</option></select></div>
        <div class="tool-field"><label>${t("tools.tp.v")}</label><div class="tool-inline"><input id="tp-v" class="proto-in" type="number" value="380" /><span class="tool-suffix">V</span></div></div>
        <div class="tool-field"><label>${t("tools.tp.i")}</label><div class="tool-inline"><input id="tp-i" class="proto-in" type="number" value="10" /><span class="tool-suffix">A</span></div></div>
        <div class="tool-field"><label>${t("tools.tp.pf")}</label><div class="tool-inline"><input id="tp-pf" class="proto-in" type="number" step="0.01" value="0.8" /></div></div>
        <div class="tool-field"><label>${t("tools.tp.s")}</label><div class="tool-inline"><input id="tp-s" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">VA</span></div></div>
        <div class="tool-field"><label>${t("tools.tp.p")}</label><div class="tool-inline"><input id="tp-p" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">W</span></div></div>
        <div class="tool-field"><label>${t("tools.tp.q")}</label><div class="tool-inline"><input id="tp-q" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">var</span></div></div>
        <div class="tool-field"><label>${t("tools.tp.vph")}</label><div class="tool-inline"><input id="tp-vph" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">V</span></div></div>
        <div class="tool-field"><label>${t("tools.tp.iph")}</label><div class="tool-inline"><input id="tp-iph" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">A</span></div></div>
      </div>
      <div class="tool-formula">${math("S = \\sqrt{3} V I,\\quad P = S \\cos\\varphi,\\quad Q = S \\sin\\varphi")}</div>
    </div>`;
  const update = () => {
    const conn = (host.querySelector("#tp-conn") as HTMLSelectElement).value;
    const diagram = host.querySelector<HTMLElement>("#tp-diagram")!;
    const diagImg = diagram.querySelector<HTMLImageElement>("img")!;
    const src = toolDiagramVariant("three-phase", conn);
    if (src) { diagImg.src = src; diagram.style.display = ""; }
    else { diagram.style.display = "none"; }
    const v = num((host.querySelector("#tp-v") as HTMLInputElement).value);
    const i = num((host.querySelector("#tp-i") as HTMLInputElement).value);
    const pf = num((host.querySelector("#tp-pf") as HTMLInputElement).value);
    if (v === null || i === null || pf === null) {
      (host.querySelector("#tp-s") as HTMLInputElement).value = "";
      (host.querySelector("#tp-p") as HTMLInputElement).value = "";
      (host.querySelector("#tp-q") as HTMLInputElement).value = "";
      (host.querySelector("#tp-vph") as HTMLInputElement).value = "";
      (host.querySelector("#tp-iph") as HTMLInputElement).value = "";
      return;
    }
    const s = Math.sqrt(3) * v * i;
    const p = s * pf;
    const q = s * Math.sqrt(1 - pf * pf);
    const vph = conn === "delta" ? v : v / Math.sqrt(3);
    const iph = conn === "delta" ? i / Math.sqrt(3) : i;
    setEng(host.querySelector<HTMLInputElement>("#tp-s")!, "VA")(s);
    setEng(host.querySelector<HTMLInputElement>("#tp-p")!, "W")(p);
    setEng(host.querySelector<HTMLInputElement>("#tp-q")!, "var")(q);
    setEng(host.querySelector<HTMLInputElement>("#tp-vph")!, "V")(vph);
    setEng(host.querySelector<HTMLInputElement>("#tp-iph")!, "A")(iph);
  };
  host.querySelectorAll("input,select").forEach((el) => el.addEventListener("input", update));
  host.querySelectorAll("select").forEach((el) => el.addEventListener("change", update));
  update();
  return {};
}

// ── 频率/波长 ──
function buildFrequencyWavelength(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.fw.freq")}</label><div class="tool-inline"><input id="fw-f" class="proto-in" type="number" value="100" /><select id="fw-fu" class="tool-sel proto-in"><option value="1">Hz</option><option value="1e3" selected>kHz</option><option value="1e6">MHz</option><option value="1e9">GHz</option></select></div></div>
        <div class="tool-field"><label>${t("tools.fw.wavelength")}</label><div class="tool-inline"><input id="fw-w" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">m</span></div></div>
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
    setEng(host.querySelector<HTMLInputElement>("#fw-w")!, "m")(299792458 / (f * fu));
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
        <div class="tool-field"><label>${t("tools.wg.diameterIn")}</label><div class="tool-inline"><input id="wg-in" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">in</span></div></div>
        <div class="tool-field"><label>${t("tools.wg.diameterMm")}</label><div class="tool-inline"><input id="wg-mm" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">mm</span></div></div>
        <div class="tool-field"><label>${t("tools.wg.circularMil")}</label><div class="tool-inline"><input id="wg-cm" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">CM</span></div></div>
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

// ── 走线阻抗（7 种结构）──
function buildTraceImpedance(host: HTMLElement): ToolController {
  const ROW_VIS: Record<TraceTopo, string[]> = {
    m: ["t", "h"],
    "m-embedded": ["t", "h", "hp"],
    "m-edge": ["t", "h", "s"],
    s: ["t", "h"],
    "s-asym": ["t", "ha", "hb"],
    "s-broadside": ["t", "hp", "ht"],
    "s-edge": ["t", "h", "s"],
  };
  const DIRS: Record<TraceTopo, TraceDir[]> = {
    m: ["im", "w"], "m-embedded": ["im"], "m-edge": ["im", "w"],
    s: ["im"], "s-asym": ["im"], "s-broadside": ["im"], "s-edge": ["im"],
  };
  const FORMULA: Record<TraceTopo, string> = {
    m: "Z_0 = \\frac{87}{\\sqrt{\\varepsilon_r+1.41}}\\ln(\\frac{5.98h}{0.8w+t})",
    "m-embedded": "\\varepsilon_{eff}=\\varepsilon_r(1-e^{-1.55h/h_p}), Z_0=\\frac{60}{\\sqrt{\\varepsilon_{eff}}}\\ln(\\frac{5.98h_p}{0.8w+t})",
    "m-edge": "Z_0=\\frac{87}{\\sqrt{\\varepsilon_r+1.41}}\\ln(\\frac{5.98h}{0.8w+t}), Z_d=2Z_0(1-\\frac{0.48}{e^{0.96s/h}})",
    s: "Z_0 = \\frac{60}{\\sqrt{\\varepsilon_r}}\\ln(\\frac{1.9(2h+t)}{0.8w+t})",
    "s-asym": "Z_0 = \\frac{80}{\\sqrt{\\varepsilon_r}}\\ln(\\frac{1.9(2h+t)}{0.8w+t})(1-\\frac{h}{4h_1})",
    "s-broadside": "Z_0=\\frac{80}{\\sqrt{\\varepsilon_r}}\\ln(\\frac{1.9(2h_p+t)}{0.8w+t})(1-\\frac{h_p}{4(h_p+h_t+t)})",
    "s-edge": "Z_0=\\frac{60}{\\sqrt{\\varepsilon_r}}\\ln(\\frac{1.9(2h+t)}{0.8w+t}), Z_d=2Z_0(1-\\frac{0.347}{e^{2.9s/(2h+t)}})",
  };
  const LEN_U = '<option value="39.3" selected>mm</option><option value="1">mil</option><option value="393">cm</option><option value="0.0393">µm</option><option value="1000">inch</option>';
  const THICK_U = '<option value="39.3" selected>mm</option><option value="1">mil</option><option value="1.379">oz</option><option value="0.0393">µm</option><option value="1000">inch</option>';
  const typeOpts = (["m", "m-embedded", "m-edge", "s", "s-asym", "s-broadside", "s-edge"] as TraceTopo[]).map((v) => `<option value="${v}">${t(`tools.ti.topos.${v}`)}</option>`).join("");

  host.innerHTML = `
    <div class="tool-panel">
      <div class="tools-diagram" id="ti-diagram"><img class="tool-diagram" alt="${esc(t("tools.ti.diagramAlt"))}" /></div>
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.ti.type")}</label><select id="ti-type" class="proto-in">${typeOpts}</select></div>
        <div class="tool-field" id="ti-dir-field" style="display:none"><label>${t("tools.ti.dir")}</label><select id="ti-dir" class="proto-in"><option value="im">${t("tools.ti.dirIm")}</option><option value="w">${t("tools.ti.dirW")}</option></select></div>
      </div>
      <div class="tool-grid" id="ti-fields">
        <div class="tool-field" id="ti-row-input"><label id="ti-input-label">${t("tools.ti.w")}</label><div class="tool-inline"><input id="ti-input" class="proto-in" type="number" value="0.25" /><select id="ti-input-u" class="tool-sel proto-in">${LEN_U}</select><span id="ti-input-sfx" class="tool-suffix" style="display:none">Ω</span></div></div>
        <div class="tool-field" id="ti-row-t"><label>${t("tools.ti.t")}</label><div class="tool-inline"><input id="ti-t" class="proto-in" type="number" value="0.035" /><select id="ti-t-u" class="tool-sel proto-in">${THICK_U}</select></div></div>
        <div class="tool-field" id="ti-row-h"><label>${t("tools.ti.h")}</label><div class="tool-inline"><input id="ti-h" class="proto-in" type="number" value="0.2" /><select id="ti-h-u" class="tool-sel proto-in">${LEN_U}</select></div></div>
        <div class="tool-field" id="ti-row-s" style="display:none"><label>${t("tools.ti.s")}</label><div class="tool-inline"><input id="ti-s" class="proto-in" type="number" value="0.25" /><select id="ti-s-u" class="tool-sel proto-in">${LEN_U}</select></div></div>
        <div class="tool-field" id="ti-row-hp" style="display:none"><label>${t("tools.ti.hp")}</label><div class="tool-inline"><input id="ti-hp" class="proto-in" type="number" value="0.15" /><select id="ti-hp-u" class="tool-sel proto-in">${LEN_U}</select></div></div>
        <div class="tool-field" id="ti-row-ht" style="display:none"><label>${t("tools.ti.ht")}</label><div class="tool-inline"><input id="ti-ht" class="proto-in" type="number" value="0.15" /><select id="ti-ht-u" class="tool-sel proto-in">${LEN_U}</select></div></div>
        <div class="tool-field" id="ti-row-ha" style="display:none"><label>${t("tools.ti.ha")}</label><div class="tool-inline"><input id="ti-ha" class="proto-in" type="number" value="0.2" /><select id="ti-ha-u" class="tool-sel proto-in">${LEN_U}</select></div></div>
        <div class="tool-field" id="ti-row-hb" style="display:none"><label>${t("tools.ti.hb")}</label><div class="tool-inline"><input id="ti-hb" class="proto-in" type="number" value="0.4" /><select id="ti-hb-u" class="tool-sel proto-in">${LEN_U}</select></div></div>
        <div class="tool-field"><label>${t("tools.ti.er")}</label><div class="tool-inline"><input id="ti-er" class="proto-in" type="number" step="0.1" value="4.5" /></div></div>
        <div class="tool-field" id="ti-row-out"><label id="ti-out-label">${t("tools.ti.z")}</label><div class="tool-inline"><input id="ti-out" class="tool-output proto-in" readonly placeholder="—" /><span id="ti-out-sfx" class="tool-suffix">Ω</span></div></div>
      </div>
      <div class="tool-formula" id="ti-formula"></div>
    </div>`;
  const typeEl = host.querySelector<HTMLSelectElement>("#ti-type")!;
  const dirEl = host.querySelector<HTMLSelectElement>("#ti-dir")!;
  const dirField = host.querySelector<HTMLElement>("#ti-dir-field")!;
  const inputEl = host.querySelector<HTMLInputElement>("#ti-input")!;
  const inputU = host.querySelector<HTMLSelectElement>("#ti-input-u")!;
  const inputSfx = host.querySelector<HTMLElement>("#ti-input-sfx")!;
  const inputLabel = host.querySelector<HTMLElement>("#ti-input-label")!;
  const outEl = host.querySelector<HTMLInputElement>("#ti-out")!;
  const outSfx = host.querySelector<HTMLElement>("#ti-out-sfx")!;
  const outLabel = host.querySelector<HTMLElement>("#ti-out-label")!;
  const formulaEl = host.querySelector<HTMLElement>("#ti-formula")!;
  const diagram = host.querySelector<HTMLElement>("#ti-diagram")!;
  const diagImg = diagram.querySelector<HTMLImageElement>("img")!;

  const unitVal = (sel: HTMLSelectElement) => Number(sel.value);
  const compute = () => {
    const topo = typeEl.value as TraceTopo;
    const dir = dirEl.value as TraceDir;
    const er = num(host.querySelector<HTMLInputElement>("#ti-er")!.value);
    const input: TraceInput = { er: er ?? 0 };
    let bad = er === null;
    for (const k of ROW_VIS[topo]) {
      const el = host.querySelector<HTMLInputElement>("#ti-" + k);
      if (!el) continue;
      const v = num(el.value);
      if (v === null) { bad = true; continue; }
      const u = unitVal(host.querySelector<HTMLSelectElement>("#ti-" + k + "-u")!);
      (input as unknown as Record<string, unknown>)[k] = v * u;
    }
    const p = num(inputEl.value);
    if (p === null) bad = true;
    if (dir === "im") (input as unknown as Record<string, unknown>).w = p !== null ? p * unitVal(inputU) : NaN;
    else (input as unknown as Record<string, unknown>).z = p;
    formulaEl.innerHTML = math(FORMULA[topo]);
    if (bad) { outEl.value = ""; outEl.title = ""; return; }
    const res = tImp(topo, dir, input);
    if (dir === "im") {
      outEl.value = res.z !== undefined ? fmt(res.z) : "";
    } else {
      const wu = unitVal(inputU);
      outEl.value = res.w !== undefined ? fmt(res.w / wu) : "";
    }
    outEl.title = res.warn ?? "";
  };
  const render = () => {
    const topo = typeEl.value as TraceTopo;
    const dir = dirEl.value as TraceDir;
    for (const k of ["t", "h", "s", "hp", "ht", "ha", "hb"]) {
      (host.querySelector("#ti-row-" + k) as HTMLElement | null)!.style.display = ROW_VIS[topo].includes(k) ? "" : "none";
    }
    dirField.style.display = DIRS[topo].length > 1 ? "" : "none";
    if (!DIRS[topo].includes(dir)) dirEl.value = "im";
    const im = dirEl.value === "im";
    inputEl.value = im ? "0.25" : "50";
    inputLabel.textContent = im ? t("tools.ti.w") : t("tools.ti.z");
    inputU.style.display = im ? "" : "none";
    inputSfx.style.display = im ? "none" : "";
    outLabel.textContent = im ? t("tools.ti.z") : t("tools.ti.w");
    outSfx.textContent = im ? "Ω" : (inputU.options[inputU.selectedIndex]?.textContent || "mm").trim();
    const src = toolDiagramVariant("trace-impedance", topo);
    if (src) { diagImg.src = src; diagram.style.display = ""; } else { diagram.style.display = "none"; }
    compute();
  };
  host.querySelectorAll("#ti-type, #ti-dir").forEach((el) => el.addEventListener("change", render));
  host.querySelectorAll("#ti-fields input, #ti-fields select").forEach((el) => {
    el.addEventListener("input", compute);
    el.addEventListener("change", compute);
  });
  render();
  return {};
}

// ── PCB 走线宽度（IPC-2221 近似）──
function buildPcbTraceWidth(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.pcb.current")}</label><div class="tool-inline"><input id="pcb-i" class="proto-in" type="number" min="0" value="1" /><span class="tool-suffix">A</span></div></div>
        <div class="tool-field"><label>${t("tools.pcb.deltaT")}</label><div class="tool-inline"><input id="pcb-dt" class="proto-in" type="number" min="0" value="10" /><span class="tool-suffix">°C</span></div></div>
        <div class="tool-field"><label>${t("tools.pcb.layer")}</label><select id="pcb-layer" class="proto-in"><option value="0.048" selected>${t("tools.pcb.outer")}</option><option value="0.024">${t("tools.pcb.inner")}</option></select></div>
        <div class="tool-field"><label>${t("tools.pcb.copper")}</label><div class="tool-inline"><input id="pcb-th" class="proto-in" type="number" min="0" value="1" /><select id="pcb-thu" class="tool-sel proto-in"><option value="0.035" selected>1 oz (35 µm)</option><option value="0.07">2 oz (70 µm)</option><option value="0.105">3 oz (105 µm)</option></select></div></div>
        <div class="tool-field"><label>${t("tools.pcb.width")}</label><div class="tool-inline"><input id="pcb-w" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">mm</span></div></div>
      </div>
      <div class="tool-formula">${math("A = \\left(\\dfrac{I}{k\\Delta T^{0.44}}\\right)^{1/0.725},\\quad W = \\dfrac{A}{T},\\quad k=0.048")}</div>
    </div>`;
  const update = () => {
    const i = num((host.querySelector("#pcb-i") as HTMLInputElement).value);
    const dt = num((host.querySelector("#pcb-dt") as HTMLInputElement).value);
    const th = num((host.querySelector("#pcb-th") as HTMLInputElement).value);
    const thu = Number((host.querySelector("#pcb-thu") as HTMLSelectElement).value);
    const k = Number((host.querySelector("#pcb-layer") as HTMLSelectElement).value);
    if (i === null || dt === null || th === null || thu === null || i <= 0 || dt <= 0 || th * thu <= 0) {
      (host.querySelector("#pcb-w") as HTMLInputElement).value = "";
      return;
    }
    // IPC-2221: A[mils²] = (I/(k·ΔT^b))^(1/c); W = A/T. 外层走线 k=0.048, 内层 k=0.024, b=0.44, c=0.725
    // 铜厚 [mm] = 输入的倍数 × 所选 oz 对应厚度(0.035/0.07/0.105 mm)
    const thickMil = th * thu * 39.3701;
    const areaMils2 = (i / (k * dt ** 0.44)) ** (1 / 0.725);
    const widthMil = areaMils2 / thickMil;
    const widthMm = widthMil * 0.0254;
    setEng(host.querySelector<HTMLInputElement>("#pcb-w")!, "mm")(widthMm);
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
        <button class="tool-tab active" data-type="pi">${t("tools.attenuator.pi")}</button>
        <button class="tool-tab" data-type="bridgeT">${t("tools.attenuator.bridgeT")}</button>
        <button class="tool-tab" data-type="reflective">${t("tools.attenuator.reflective")}</button>
        <button class="tool-tab" data-type="T">${t("tools.attenuator.T")}</button>
      </div>
      <div class="tools-diagram" id="att-diagram"><img class="tool-diagram" alt="${esc(t("tools.attenuator.diagramAlt"))}" /></div>
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
      setEng(r1, "Ω")(res.r1);
      setEng(r2, "Ω")(res.r2 === null ? NaN : res.r2);
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
      <div class="tool-field"><label>${t("tools.frac.decimal")}</label><div class="tool-inline"><input id="frac-in" class="proto-in" type="text" value="0.125" /></div></div>
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
      <div class="tool-field"><label>${t("tools.psres.value")}</label><div class="tool-inline"><input id="res-r1" class="proto-in" type="number" min="0" value="100" /><select class="tool-sel proto-in" id="res-u"><option value="1" selected>Ω</option><option value="1e3">kΩ</option><option value="1e6">MΩ</option></select></div></div>
      <div id="res-rows"></div>
      <div class="tool-actions"><button id="res-add" class="primary">${t("tools.addResistor")}</button><button id="res-remove" class="ghost">${t("tools.removeResistor")}</button></div>
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.psres.ser")}</label><div class="tool-inline"><input id="res-ser" class="tool-output proto-in" readonly placeholder="—" /></div></div>
        <div class="tool-field"><label>${t("tools.psres.par")}</label><div class="tool-inline"><input id="res-par" class="tool-output proto-in" readonly placeholder="—" /></div></div>
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
    (host.querySelector("#res-ser") as HTMLInputElement).value = ser === null ? "" : fmtEng(ser, "Ω");
    (host.querySelector("#res-par") as HTMLInputElement).value = par === null ? "" : fmtEng(par, "Ω");
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
        <div class="tool-field"><label>${t("tools.rx.freq")}</label><div class="tool-inline"><input id="rx-f" class="proto-in" type="number" min="0" value="1000" /><select id="rx-fu" class="tool-sel proto-in"><option value="1">Hz</option><option value="1e3" selected>kHz</option><option value="1e6">MHz</option></select></div></div>
        <div class="tool-field"><label>${t("tools.rx.l")}</label><div class="tool-inline"><input id="rx-l" class="proto-in" type="number" min="0" value="10" /><select id="rx-lu" class="tool-sel proto-in"><option value="1e-9">nH</option><option value="1e-6" selected>µH</option><option value="1e-3">mH</option><option value="1">H</option></select></div></div>
        <div class="tool-field"><label>${t("tools.rx.c")}</label><div class="tool-inline"><input id="rx-c" class="proto-in" type="number" min="0" value="10" /><select id="rx-cu" class="tool-sel proto-in"><option value="1e-12">pF</option><option value="1e-9">nF</option><option value="1e-6" selected>µF</option></select></div></div>
        <div class="tool-field"><label>${t("tools.rx.xl")}</label><div class="tool-inline"><input id="rx-xl" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">Ω</span></div></div>
        <div class="tool-field"><label>${t("tools.rx.xc")}</label><div class="tool-inline"><input id="rx-xc" class="tool-output proto-in" readonly placeholder="—" /><span class="tool-suffix">Ω</span></div></div>
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
    setEng(host.querySelector<HTMLInputElement>("#rx-xl")!, "Ω")(r.xl);
    setEng(host.querySelector<HTMLInputElement>("#rx-xc")!, "Ω")(r.xc);
  };
  host.querySelectorAll("input,select").forEach((el) => el.addEventListener("input", update));
  host.querySelectorAll("select").forEach((el) => el.addEventListener("change", update));
  update();
  return {};
}

// ── dB ↔ 线性（电压/功率）──
function buildDbLinear(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.dbl.qty")}</label><select id="dbl-qty" class="tool-sel proto-in"><option value="v">${t("tools.dbl.voltage")}</option><option value="p">${t("tools.dbl.power")}</option></select></div>
        <div class="tool-field"><label>${t("tools.dbl.dir")}</label><select id="dbl-dir" class="tool-sel proto-in"><option value="db2lin">${t("tools.dbl.db2lin")}</option><option value="lin2db">${t("tools.dbl.lin2db")}</option></select></div>
        <div class="tool-field"><label>${t("tools.dbl.reference")}</label><div class="tool-inline"><input id="dbl-ref" class="proto-in" type="number" value="1" /><span id="dbl-refu" class="tool-suffix">V</span></div></div>
      </div>
      <div class="tool-grid">
        <div class="tool-field"><label id="dbl-inlabel">${t("tools.dbl.dbVal")}</label><div class="tool-inline"><input id="dbl-in" class="proto-in" type="number" value="0" /><span id="dbl-inu" class="tool-suffix">dB</span></div></div>
        <div class="tool-field"><label id="dbl-outlabel">${t("tools.dbl.linearVal")}</label><div class="tool-inline"><input id="dbl-out" class="tool-output proto-in" readonly placeholder="—" /><span id="dbl-outu" class="tool-suffix"></span></div></div>
      </div>
      <div class="tool-formula" id="dbl-formula"></div>
    </div>`;
  const qtyEl = host.querySelector<HTMLSelectElement>("#dbl-qty")!;
  const dirEl = host.querySelector<HTMLSelectElement>("#dbl-dir")!;
  const refEl = host.querySelector<HTMLInputElement>("#dbl-ref")!;
  const refuEl = host.querySelector<HTMLElement>("#dbl-refu")!;
  const inEl = host.querySelector<HTMLInputElement>("#dbl-in")!;
  const inuEl = host.querySelector<HTMLElement>("#dbl-inu")!;
  const outEl = host.querySelector<HTMLInputElement>("#dbl-out")!;
  const outuEl = host.querySelector<HTMLElement>("#dbl-outu")!;
  const inLabel = host.querySelector<HTMLElement>("#dbl-inlabel")!;
  const outLabel = host.querySelector<HTMLElement>("#dbl-outlabel")!;
  const formulaEl = host.querySelector<HTMLElement>("#dbl-formula")!;
  const compute = () => {
    const power = qtyEl.value === "p";
    const ref = num(refEl.value);
    const inp = num(inEl.value);
    if (ref === null || inp === null || ref <= 0) { outEl.value = ""; return; }
    if (dirEl.value === "db2lin") {
      outEl.value = fmt(ref * dbToLinear(inp, power), 8);
      formulaEl.innerHTML = math(power ? "P = P_{ref} \\cdot 10^{L_P/10}" : "V = V_{ref} \\cdot 10^{L_V/20}");
    } else {
      outEl.value = fmt(linearToDb(inp / ref, power), 8);
      formulaEl.innerHTML = math(power ? "L_P = 10\\log_{10}(P/P_{ref})" : "L_V = 20\\log_{10}(V/V_{ref})");
    }
  };
  const render = () => {
    const power = qtyEl.value === "p";
    refuEl.textContent = power ? "W" : "V";
    if (dirEl.value === "db2lin") {
      inLabel.textContent = t("tools.dbl.dbVal"); inuEl.textContent = "dB";
      outLabel.textContent = power ? t("tools.dbl.powerP") : t("tools.dbl.voltageV"); outuEl.textContent = power ? "W" : "V";
    } else {
      inLabel.textContent = power ? t("tools.dbl.powerP") : t("tools.dbl.voltageV"); inuEl.textContent = power ? "W" : "V";
      outLabel.textContent = t("tools.dbl.dbVal"); outuEl.textContent = "dB";
    }
    compute();
  };
  host.querySelectorAll("#dbl-qty, #dbl-dir").forEach((el) => el.addEventListener("change", render));
  host.querySelectorAll("#dbl-ref, #dbl-in").forEach((el) => el.addEventListener("input", compute));
  render();
  return {};
}

// ── 带宽 ↔ 上升时间（BW ≈ 0.35/tr）──
function buildBandwidth(host: HTMLElement): ToolController {
  const TIME_U = '<option value="1">s</option><option value="1e-3">ms</option><option value="1e-6">µs</option><option value="1e-9" selected>ns</option><option value="1e-12">ps</option>';
  const FREQ_U = '<option value="1">Hz</option><option value="1e3">kHz</option><option value="1e6">MHz</option><option value="1e9" selected>GHz</option>';
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.bw.dir")}</label><select id="bw-dir" class="tool-sel proto-in"><option value="tr">${t("tools.bw.tr2bw")}</option><option value="bw">${t("tools.bw.bw2tr")}</option></select></div>
      </div>
      <div class="tool-grid">
        <div class="tool-field"><label id="bw-inlabel">${t("tools.bw.tr")}</label><div class="tool-inline"><input id="bw-in" class="proto-in" type="number" value="1" /><select id="bw-inu" class="tool-sel proto-in">${TIME_U}</select></div></div>
        <div class="tool-field"><label id="bw-outlabel">${t("tools.bw.bw")}</label><div class="tool-inline"><input id="bw-out" class="tool-output proto-in" readonly placeholder="—" /><span id="bw-outu" class="tool-suffix">Hz</span></div></div>
      </div>
      <div class="tool-formula" id="bw-formula"></div>
    </div>`;
  const dirEl = host.querySelector<HTMLSelectElement>("#bw-dir")!;
  const inEl = host.querySelector<HTMLInputElement>("#bw-in")!;
  const inuEl = host.querySelector<HTMLSelectElement>("#bw-inu")!;
  const outEl = host.querySelector<HTMLInputElement>("#bw-out")!;
  const outuEl = host.querySelector<HTMLElement>("#bw-outu")!;
  outuEl.style.display = "none"; // 输出自动量级已把单位写进值，隐藏静态后缀避免矛盾
  const inLabel = host.querySelector<HTMLElement>("#bw-inlabel")!;
  const outLabel = host.querySelector<HTMLElement>("#bw-outlabel")!;
  const formulaEl = host.querySelector<HTMLElement>("#bw-formula")!;
  const fmtF = (v: number): string => {
    if (!Number.isFinite(v)) return "—";
    if (v >= 1e9) return `${fmt(v / 1e9)} GHz`;
    if (v >= 1e6) return `${fmt(v / 1e6)} MHz`;
    if (v >= 1e3) return `${fmt(v / 1e3)} kHz`;
    if (v >= 1) return `${fmt(v)} Hz`;
    return `${fmt(v * 1e3)} mHz`;
  };
  const fmtT = (v: number): string => {
    if (!Number.isFinite(v)) return "—";
    if (v >= 1) return `${fmt(v)} s`;
    if (v >= 1e-3) return `${fmt(v * 1e3)} ms`;
    if (v >= 1e-6) return `${fmt(v * 1e6)} µs`;
    if (v >= 1e-9) return `${fmt(v * 1e9)} ns`;
    return `${fmt(v * 1e12)} ps`;
  };
  const compute = () => {
    const v = num(inEl.value);
    const u = Number(inuEl.value);
    if (v === null || v <= 0) { outEl.value = ""; return; }
    if (dirEl.value === "tr") {
      outEl.value = fmtF(bandwidthFromRiseTime(v * u));
      formulaEl.innerHTML = math("BW \\approx 0.35/t_r");
    } else {
      outEl.value = fmtT(riseTimeFromBandwidth(v * u));
      formulaEl.innerHTML = math("t_r = 0.35/BW");
    }
  };
  const render = () => {
    if (dirEl.value === "tr") { inLabel.textContent = t("tools.bw.tr"); outLabel.textContent = t("tools.bw.bw"); inuEl.innerHTML = TIME_U; outuEl.textContent = "Hz"; }
    else { inLabel.textContent = t("tools.bw.bw"); outLabel.textContent = t("tools.bw.tr"); inuEl.innerHTML = FREQ_U; outuEl.textContent = "s"; }
    compute();
  };
  dirEl.addEventListener("change", render);
  inEl.addEventListener("input", compute);
  inuEl.addEventListener("change", compute);
  render();
  return {};
}

// ── VRMS / dBm / dBu / dBV（音频参考电平）──
function buildAudioDb(host: HTMLElement): ToolController {
  host.innerHTML = `
    <div class="tool-panel">
      <div class="tool-resultline">${t("tools.adb.hintLevel")}</div>
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.adb.z")}</label><div class="tool-inline"><input id="adb-z" class="proto-in" type="number" value="600" /><span class="tool-suffix">Ω</span></div></div>
        <div class="tool-field"><label>${t("tools.adb.wave")}</label><select id="adb-wave" class="tool-sel proto-in"><option value="sine">${t("tools.adb.sine")}</option><option value="square">${t("tools.adb.square")}</option><option value="triangle">${t("tools.adb.triangle")}</option></select></div>
      </div>
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.adb.vpk")}</label><div class="tool-inline"><input id="adb-vpk" class="proto-in" type="number" value="1" /><span class="tool-suffix">V</span></div></div>
        <div class="tool-field"><label>${t("tools.adb.vpp")}</label><div class="tool-inline"><input id="adb-vpp" class="proto-in" type="number" placeholder="—" /><span class="tool-suffix">V</span></div></div>
        <div class="tool-field"><label>${t("tools.adb.vrms")}</label><div class="tool-inline"><input id="adb-vrms" class="proto-in" type="number" placeholder="—" /><span class="tool-suffix">V</span></div></div>
      </div>
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.adb.power")}</label><div class="tool-inline"><input id="adb-pm" class="proto-in" type="number" placeholder="—" /><span class="tool-suffix">mW</span></div></div>
        <div class="tool-field"><label>dBm</label><div class="tool-inline"><input id="adb-dbm" class="proto-in" type="number" placeholder="—" /><span class="tool-suffix">dBm</span></div></div>
        <div class="tool-field"><label>dBu</label><div class="tool-inline"><input id="adb-dbu" class="proto-in" type="number" placeholder="—" /><span class="tool-suffix">dBu</span></div></div>
        <div class="tool-field"><label>dBV</label><div class="tool-inline"><input id="adb-dbv" class="proto-in" type="number" placeholder="—" /><span class="tool-suffix">dBV</span></div></div>
      </div>
      <div class="tool-resultline">${t("tools.adb.hintGain")}</div>
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.adb.gain")}</label><div class="tool-inline"><input id="adb-gain" class="proto-in" type="number" value="10" /><span class="tool-suffix">V/V</span></div></div>
        <div class="tool-field"><label>dB</label><div class="tool-inline"><input id="adb-gaindb" class="proto-in" type="number" placeholder="—" /><span class="tool-suffix">dB</span></div></div>
        <div class="tool-field"><label>Np</label><div class="tool-inline"><input id="adb-gainnp" class="proto-in" type="number" placeholder="—" /><span class="tool-suffix">Np</span></div></div>
      </div>
      <div class="tool-resultline">${t("tools.adb.hintSource")}</div>
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.adb.lw")}</label><div class="tool-inline"><input id="adb-lw" class="proto-in" type="number" value="120" /><span class="tool-suffix">dB</span></div></div>
        <div class="tool-field"><label>${t("tools.adb.pac")}</label><div class="tool-inline"><input id="adb-pac" class="proto-in" type="number" value="1" /><span class="tool-suffix">W</span></div></div>
      </div>
      <div class="tool-resultline">${t("tools.adb.hintGeo")}</div>
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.adb.r")}</label><div class="tool-inline"><input id="adb-r" class="proto-in" type="number" value="1" /><span class="tool-suffix">m</span></div></div>
        <div class="tool-field"><label>${t("tools.adb.q")}</label><select id="adb-q" class="tool-sel proto-in"><option value="1">${t("tools.adb.q1")}</option><option value="2">${t("tools.adb.q2")}</option><option value="4">${t("tools.adb.q4")}</option><option value="8">${t("tools.adb.q8")}</option></select></div>
      </div>
      <div class="tool-resultline">${t("tools.adb.hintMeasure")}</div>
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.adb.spl")}</label><div class="tool-inline"><input id="adb-spl" class="proto-in" type="number" placeholder="—" /><span class="tool-suffix">dBSPL</span></div></div>
        <div class="tool-field"><label>${t("tools.adb.sil")}</label><div class="tool-inline"><input id="adb-sil" class="proto-in" type="number" placeholder="—" /><span class="tool-suffix">dB</span></div></div>
      </div>
      <div class="tool-grid">
        <div class="tool-field"><label>${t("tools.adb.i")}</label><div class="tool-inline"><input id="adb-i" class="proto-in" type="number" placeholder="—" /><span class="tool-suffix">W/m²</span></div></div>
        <div class="tool-field"><label>${t("tools.adb.pa")}</label><div class="tool-inline"><input id="adb-pa" class="proto-in" type="number" placeholder="—" /><span class="tool-suffix">Pa</span></div></div>
      </div>
      <div class="tool-formula" id="adb-formula"></div>
      <div class="tool-resultline">${t("tools.adb.footnote")}</div>
    </div>`;
  const q = (id: string) => host.querySelector<HTMLInputElement>(id)!;
  const zEl = q("#adb-z");
  const waveEl = host.querySelector<HTMLSelectElement>("#adb-wave")!;
  const lvl: Record<string, HTMLInputElement> = {
    vpk: q("#adb-vpk"), vpp: q("#adb-vpp"), vrms: q("#adb-vrms"),
    pm: q("#adb-pm"), dbm: q("#adb-dbm"), dbu: q("#adb-dbu"), dbv: q("#adb-dbv"),
  };
  const g: Record<string, HTMLInputElement> = { a: q("#adb-gain"), db: q("#adb-gaindb"), np: q("#adb-gainnp") };
  const snd: Record<string, HTMLInputElement> = { spl: q("#adb-spl"), sil: q("#adb-sil"), pa: q("#adb-pa"), i: q("#adb-i") };
  const lwEl = q("#adb-lw");
  const pacEl = q("#adb-pac");
  const rEl = q("#adb-r");
  const qSel = host.querySelector<HTMLSelectElement>("#adb-q")!;
  const formulaEl = q("#adb-formula");

  const clearLvl = (from: string) => Object.keys(lvl).forEach((k) => { if (k !== from) lvl[k].value = ""; });
  const recomputeLvl = (from: string) => {
    const z = num(zEl.value);
    const wave = (waveEl.value || "sine") as CrestWave;
    const cf = crest(wave);
    const src = num(lvl[from].value);
    if (z === null || z <= 0 || src === null || !Number.isFinite(src)) { clearLvl(from); return; }
    let vpk: number;
    if (from === "vpk") vpk = src;
    else if (from === "vpp") vpk = src / 2;
    else if (from === "vrms") vpk = src * cf;
    else if (from === "pm") vpk = vpeakFromVrms(voltageFromPowerMw(src, z), wave);
    else if (from === "dbm") vpk = vpeakFromVrms(dbmToV(src, z), wave);
    else if (from === "dbu") vpk = vpeakFromVrms(dbuToV(src), wave);
    else vpk = vpeakFromVrms(dbvToV(src), wave);
    if (!Number.isFinite(vpk) || vpk < 0) { clearLvl(from); return; }
    const vrms = vrmsFromVpeak(vpk, wave);
    const pm = ((vrms * vrms) / z) * 1000;
    const vals: Record<string, number> = {
      vpk, vpp: 2 * vpk, vrms, pm,
      dbm: vToDbm(vrms, z), dbu: vToDbu(vrms), dbv: vToDbv(vrms),
    };
    Object.keys(lvl).forEach((k) => { if (k !== from) lvl[k].value = Number.isFinite(vals[k]) ? fmt(vals[k], 6) : ""; });
  };

  const clearG = (from: string) => ["a", "db", "np"].forEach((k) => { if (k !== from) g[k].value = ""; });
  const recomputeG = (from: "a" | "db" | "np") => {
    const src = num(g[from].value);
    if (src === null || !Number.isFinite(src)) { clearG(from); return; }
    let a: number;
    if (from === "a") a = src;
    else if (from === "db") a = dbToGain(src);
    else a = npToGain(src);
    if (!Number.isFinite(a)) { clearG(from); return; }
    const vals: Record<string, number> = { a, db: gainToDb(a), np: gainToNp(a) };
    ["a", "db", "np"].forEach((k) => { if (k !== from) g[k].value = fmt(vals[k], 6); });
  };

  const clearSnd = (from: string) => Object.keys(snd).forEach((k) => { if (k !== from) snd[k].value = ""; });
  // 声学：声源键(lw/pac/r/q) 走前向（源功率级→距离处 SPL/I/p）；测量点键(spl/sil/pa/i) 走反向（反推 Lw/Pac）
  const recomputeSnd = (from: string) => {
    const r = num(rEl.value);
    const q = num(qSel.value);
    if (r === null || r <= 0 || q === null || q <= 0) return;
    const isForward = from === "lw" || from === "pac" || from === "r" || from === "q";
    if (isForward) {
      let lw = num(lwEl.value);
      if (from === "pac") {
        const pv = num(pacEl.value);
        lw = pv === null || !Number.isFinite(pv) ? null : pacToLw(pv);
      }
      if (lw === null || !Number.isFinite(lw)) return;
      const pac = lwToPac(lw);
      const area = pointArea(q, r);
      const i = pac / area;                       // I = P_ac/A = Q·P_ac/(4πr²)
      const p = paFromIntensity(i, AIR_Z0);
      const spl = paToSpl(p);
      const sil = intensityToSil(i);
      lwEl.value = fmt(lw, 6);
      pacEl.value = fmt(pac, 6);
      snd.pa.value = fmt(p, 6); snd.spl.value = fmt(spl, 6); snd.i.value = fmt(i, 6); snd.sil.value = fmt(sil, 6);
      return;
    }
    const src = num(snd[from].value);
    if (src === null || !Number.isFinite(src)) { clearSnd(from); return; }
    let p: number;
    if (from === "pa") p = src;
    else if (from === "i") p = paFromIntensity(src, AIR_Z0);
    else p = splToPa(src); // spl 或 sil：Z0=400 时点处恒等
    if (!Number.isFinite(p) || p < 0) { clearSnd(from); return; }
    const i = soundIntensity(p, AIR_Z0);
    const spl = paToSpl(p);
    const sil = intensityToSil(i);
    const pac = i * pointArea(q, r);              // 反向：点处 I×面积 → 源声功率
    const lw = pacToLw(pac);
    lwEl.value = fmt(lw, 6);
    pacEl.value = fmt(pac, 6);
    const vals: Record<string, number> = { spl, sil, pa: p, i };
    Object.keys(snd).forEach((k) => { if (k !== from) snd[k].value = Number.isFinite(vals[k]) ? fmt(vals[k], 6) : ""; });
  };

  formulaEl.innerHTML =
    math("L_V = 20\\log_{10}(V/1)") + "<br>" +
    math("L_u = 20\\log_{10}(V/\\sqrt{0.6})") + "<br>" +
    math("L_m = 10\\log_{10}(1000V^2/Z)") + "<br>" +
    math("V_{pp} = 2\\sqrt{2}\\,V_{rms}") + "<br>" +
    math("N_p = \\ln A") + "<br>" +
    math("L_p = 20\\log_{10}(p/20{\\mu}Pa)") + "<br>" +
    math("L_W = 10\\log_{10}(P_{ac}/10^{-12})") + "<br>" +
    math("L_p = L_W - 10\\log_{10}(4\\pi r^2/Q)");
  waveEl.addEventListener("change", () => recomputeLvl("vpk"));
  zEl.addEventListener("input", () => recomputeLvl("vpk"));
  Object.keys(lvl).forEach((k) => lvl[k].addEventListener("input", () => recomputeLvl(k)));
  ["a", "db", "np"].forEach((k) => g[k].addEventListener("input", () => recomputeG(k as "a" | "db" | "np")));
  Object.keys(snd).forEach((k) => snd[k].addEventListener("input", () => recomputeSnd(k)));
  lwEl.addEventListener("input", () => recomputeSnd("lw"));
  pacEl.addEventListener("input", () => recomputeSnd("pac"));
  rEl.addEventListener("input", () => recomputeSnd("r"));
  qSel.addEventListener("change", () => recomputeSnd("q"));
  recomputeLvl("vpk");
  recomputeG("a");
  recomputeSnd("lw");
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
  { id: "db-linear", icon: "🔁", title: "dB 与线性转换", desc: "电压(20log)/功率(10log)与线性值互转", build: buildDbLinear },
  { id: "bandwidth", icon: "📈", title: "带宽/上升时间计算", desc: "一阶带宽 BW≈0.35/tr 与上升时间互转", build: buildBandwidth },
  { id: "audio-db", icon: "🎚", title: "音频电平/声压换算", desc: "Vp/Vpp/Vrms、mW、dBm/dBu/dBV、增益(V/V·dB·Np) 与 dB SPL 声压级互转", build: buildAudioDb },
  { id: "led-resistor", icon: "💡", title: "LED 串联电阻计算器", desc: "根据电源电压、LED 压降和电流计算限流电阻", build: buildLedResistor },
  { id: "ohm", icon: "Ω", title: "欧姆定律计算器", desc: "已知电压电流求电阻与功率", build: buildOhm },
  { id: "filter", icon: "𝍌", title: "低通/高通滤波器计算器", desc: "RC 低通/高通截止频率计算", build: buildFilter },
  { id: "number-base", icon: "🔢", title: "数制转换", desc: "二进制/八进制/十进制/十六进制互转", build: buildNumberBase },
  { id: "parallel-series-cap", icon: "≋", title: "串联和并联电容器计算器", desc: "多个电容器的串联/并联总容量", build: buildParallelSeriesCapacitor },
  { id: "parallel-series-res", icon: "⌁", title: "并联和串联电阻器计算器", desc: "多个电阻器的串联/并联总电阻", build: buildParallelSeriesResistor },
  { id: "reactance", icon: "Ω", title: "电抗计算器", desc: "计算感抗 XL、容抗 XC 与导纳", build: buildReactance },
  { id: "smd-resistor", icon: "🔖", title: "SMD 电阻器代码计算器", desc: "三位/四位代码与 EIA-96 代码解读", build: buildSmdResistor },
  { id: "smd-capacitor", icon: "🔖", title: "SMD 电容器代码计算器", desc: "三位电容代码换算", build: buildSmdCapacitor },
  { id: "color-code", icon: "🌈", title: "电阻器色码计算器", desc: "四/五/六环电阻色环值计算", build: buildColorCode },
  { id: "thermistor", icon: "🌡", title: "热敏电阻计算器", desc: "NTC B 值温度换算", build: buildThermistor },
  { id: "time-constant", icon: "⏳", title: "时间常数计算器", desc: "RC 电路时间常数 τ 计算", build: buildTimeConstant },
  { id: "three-phase", icon: "〰", title: "三相功率计算器", desc: "三相交流系统的视在/有功/无功功率", build: buildThreePhase },
  { id: "frequency-wavelength", icon: "📡", title: "频率波长换算", desc: "频率与真空波长互转", build: buildFrequencyWavelength },
  { id: "wire-gauge", icon: "🧵", title: "线径换算器", desc: "AWG 与英寸/毫米/圆密耳换算", build: buildWireGauge },
  { id: "trace-impedance", icon: "🛤", title: "走线阻抗计算器", desc: "微带线/带状线等 7 种结构特性阻抗与线宽互算（含嵌入与耦合型）", build: buildTraceImpedance },
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
          <p>${t("tools.catalogSub")}</p>
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
        tTitle(tool.id).toLowerCase().includes(q) ||
        tDesc(tool.id).toLowerCase().includes(q) ||
        tool.id.toLowerCase().includes(q),
    );
    grid.innerHTML = list.length
      ? list
          .map((tool) => `
            <button class="tool-card" data-tool="${tool.id}">
              <span class="tool-icon">${tool.icon}</span>
              <span class="tool-title">${esc(tTitle(tool.id))}</span>
              <span class="tool-desc">${esc(tDesc(tool.id))}</span>
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
          <div class="tools-title-line"><span class="tool-icon">${def.icon}</span><h3>${esc(tTitle(def.id))}</h3></div>
          <p>${esc(tDesc(def.id))}</p>
        </div>
        ${diag ? `<div class="tools-diagram"><img class="tool-diagram" src="${diag}" alt="${esc(tTitle(def.id))} ${t("tools.diagramAlt")}" /></div>` : ""}
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

// 供 tools-dom-test.mjs 以真实 DOM 驱动各工具构建器（不影响页面）
export { TOOLS };
