// 下拉回归：含 label 包裹场景（label 会把点击转发给内部按钮 → 曾导致选完重新弹开）
import { JSDOM } from "jsdom";
const dom = new JSDOM(`<!doctype html><html><body>
<label>校验 <div id="host"></div></label>
</body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
const w = dom.window;
w.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
global.document = w.document;
global.window = w;
global.HTMLElement = w.HTMLElement;
global.HTMLInputElement = w.HTMLInputElement;

const ddMod = await import("../dd.cjs");
const createDropdown = ddMod.createDropdown ?? ddMod.default?.createDropdown;

const dd = createDropdown({
  items: [{ value: "a", label: "选项A" }, { value: "b", label: "选项B" }],
  onChange: () => {},
});
document.querySelector("#host").replaceWith(dd.el);
const face = dd.el.querySelector(".dd-face");
const popup = () => dd.el.querySelector(".dd-popup");
const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

click(face);
click(dd.el.querySelectorAll(".dd-item")[0]);
console.log("label 包裹下选中后关闭:", popup().className.includes("hidden"));
process.exit(0);
