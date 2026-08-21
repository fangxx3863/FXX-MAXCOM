// 复现：下拉第二次打不开
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
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
document.body.appendChild(dd.el);
const face = dd.el.querySelector(".dd-face");
const popup = () => dd.el.querySelector(".dd-popup");

const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

click(face);
console.log("第1次点击后 popup hidden?", popup().className.includes("hidden"));
click(face); // 再点一次应关闭
console.log("第2次点击后(应关闭) hidden?", popup().className.includes("hidden"));
click(face); // 第3次应重新打开
console.log("第3次点击后(应打开) hidden?", popup().className.includes("hidden"));
