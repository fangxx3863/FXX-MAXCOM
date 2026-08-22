import { chromium } from "playwright-core";
const browser = await chromium.launch({
  executablePath: "/tmp/pw-browsers/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1210, height: 787 } });
await page.goto("http://localhost:1420");
await page.waitForTimeout(600);
await page.click("#connect-btn");
await page.click('#sidebar button[data-page="plot"]');
await page.waitForTimeout(1200);
const probe = await page.evaluate(() => {
  const cell = document.querySelector(".plot-cell");
  const up = cell.querySelector(".uplot");
  const title = cell.querySelector(".uplot .title");
  const wrap = cell.querySelector(".uplot-wrap") || cell.querySelector(".uplot canvas")?.parentElement;
  const canvas = cell.querySelector("canvas");
  const cs = title ? getComputedStyle(title) : null;
  return {
    cellClient: cell.clientHeight, cellScroll: cell.scrollHeight,
    uplotRootH: up?.offsetHeight, titleH: title?.offsetHeight, titleMargin: cs ? cs.margin + "/" + cs.fontSize : null,
    canvasH: canvas?.offsetHeight, wrapH: wrap?.offsetHeight,
    uplotChildren: [...(up?.children ?? [])].map(c => `${c.className || c.tagName}:${c.offsetHeight}`),
  };
});
console.log(JSON.stringify(probe, null, 1));
await browser.close();
