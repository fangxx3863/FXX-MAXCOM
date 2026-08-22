import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: "/tmp/pw-browsers/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell",
  args: ["--no-sandbox", "--force-device-scale-factor=1.5"],
});
const page = await browser.newPage({ viewport: { width: 1210, height: 787 } });
const logs = [];
page.on("console", (msg) => {
  const t = msg.text();
  if (t.includes("buildWave")) logs.push(t);
});
await page.goto("http://localhost:1420");
await page.waitForTimeout(600);

async function dump(tag) {
  const m = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const info = (el) => el ? { h: el.clientHeight, sh: el.scrollHeight, kids: el.children.length } : null;
    const cells = [...document.querySelectorAll(".plot-cell")].map(c => ({ top: Math.round(c.getBoundingClientRect().top), h: c.clientHeight }));
    const meters = document.querySelectorAll(".bar-meter").length;
    const viewLabel = q("#plot-controls span.ctl .dd-face")?.textContent;
    return { holder: info(q("#plot-holder")), barsKids: q("#plot-bars")?.children.length,
             barsHidden: q("#plot-bars")?.classList.contains("hidden"), meters, cells, viewLabel };
  });
  console.log(`### ${tag}:`, JSON.stringify(m));
}

await page.click("#connect-btn");
await page.click('#sidebar button[data-page="plot"]');
await page.waitForTimeout(400);
await dump("初始(波形图,1ch)");

await page.fill("#plot-channels", "4");
await page.click("#plot-apply");
await page.waitForTimeout(500);
await dump("改4通道后");

// 显示 → 同屏显示
await page.locator("#plot-controls span.ctl", { hasText: "显示" }).first().locator(".dd-face").click();
await page.waitForTimeout(120);
await page.locator(".dd-item", { hasText: "同屏显示" }).first().click();
await page.waitForTimeout(300); await dump("切同屏+300ms");
await page.waitForTimeout(700); await dump("切同屏+1000ms");
await page.waitForTimeout(1500); await dump("切同屏+2500ms");

console.log("── buildWave 时间线 ──");
for (const l of logs) console.log(l);
await page.screenshot({ path: "/tmp/shot-final.png", fullPage: false });
await browser.close();
