import { chromium } from "playwright";
import { WebSocket } from "ws";

const baseUrl = process.env["SPIKE_URL"] ?? "http://127.0.0.1:4311/?token=dashboard-action-token";
const rpcUrl = new URL(baseUrl);
rpcUrl.pathname = "/rpc";
rpcUrl.searchParams.set("token", "not-a-real-token");

const rejected = await new Promise<boolean>((resolve) => {
  const socket = new WebSocket(rpcUrl);
  socket.on("unexpected-response", (_request, response) => {
    resolve(response.statusCode === 401);
  });
  socket.on("open", () => {
    socket.close();
    resolve(false);
  });
  socket.on("error", () => {
    resolve(true);
  });
});
if (!rejected) throw new Error("the proxy accepted an invalid artifact token");
console.log("security ok: invalid token rejected");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors: Array<string> = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#count")?.textContent === "1");
  await page.waitForFunction(() => document.querySelectorAll("#events li").length >= 2);
  await page.click("#increment");
  await page.waitForFunction(() => document.querySelector("#count")?.textContent === "2");
  await page.waitForFunction(() => document.querySelectorAll("#events li").length >= 3);

  const count = await page.locator("#count").textContent();
  const events = await page.locator("#events li").count();
  const project = await page.locator("#project").textContent();
  if (errors.length > 0) throw new Error("browser errors: " + errors.join(" | "));
  console.log("browser ok: count=" + String(count) + " events=" + String(events) + " project=" + String(project));
} finally {
  await browser.close();
}
