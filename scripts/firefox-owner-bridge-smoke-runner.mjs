import assert from "node:assert/strict";
import { firefox } from "playwright-core";

const [origin, mode] = process.argv.slice(2);
if (!origin || !["write", "verify", "hold"].includes(mode)) throw new Error("Firefox bridge smoke runner input is missing");

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { endpoint } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (typeof endpoint !== "string") throw new Error("Firefox bridge endpoint is missing");

const browser = await firefox.connect(endpoint);
try {
  const context = browser.contexts()[0];
  assert.ok(context, "shared owner context is available to the external runner");
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(origin);
  if (mode === "hold") {
    process.stdout.write("{\"ready\":true}\n");
    await page.evaluate(() => new Promise(() => {}));
  } else {
    if (mode === "write") {
      await context.addCookies([{ name: "owner-proof", value: "saved", url: origin }]);
      await page.evaluate(() => localStorage.setItem("owner-proof", "saved"));
    }
    const result = await page.evaluate(() => ({
      stored: localStorage.getItem("owner-proof"),
      identity: { userAgent: navigator.userAgent, screen: [screen.width, screen.height] },
    }));
    await page.close();
    process.stdout.write(JSON.stringify(result));
  }
} finally {
  await browser.close();
}
