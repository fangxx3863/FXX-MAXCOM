import { chromium } from "playwright-core";
const browser = await chromium.launch({
  executablePath: "/tmp/pw-browsers/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("console", (m) => { const t = m.text(); if (t.startsWith("[ov]") || t.startsWith("[sub]")) console.log(t); });
await page.goto("http://localhost:1420");
await page.waitForTimeout(600);
await page.click("#connect-btn");
await page.click('#sidebar button[data-page="plot"]');
await page.waitForTimeout(400);
console.log("── 叠加4ch ──");
await page.fill("#plot-channels", "4");
await page.click("#plot-apply");
await page.locator("#plot-controls span.ctl", { hasText: "布局" }).first().locator(".dd-face").click();
await page.locator(".dd-item", { hasText: "单图叠加" }).first().click();
await page.waitForTimeout(1000);
await browser.close();
