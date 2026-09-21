import assert from "node:assert/strict";
import { firefox } from "playwright-core";

const [origin, mode] = process.argv.slice(2);
if (!origin || !["write", "verify", "hold"].includes(mode)) throw new Error("Firefox bridge smoke runner input is missing");

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { endpoint } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (typeof endpoint !== "string") throw new Error("Firefox bridge endpoint is missing");

function safeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replaceAll(endpoint, "private Firefox endpoint")
    .replaceAll(/wss?:\/\/[^\s'"]+/g, "private Firefox endpoint")
    .replaceAll(/127\.0\.0\.1:\d+/g, "private Firefox endpoint")
    .slice(0, 500);
}

let phase = "connect";
let browser;
try {
  browser = await firefox.connect(endpoint);
  phase = "context";
  const context = browser.contexts()[0];
  assert.ok(context, "shared owner context is available to the external runner");
  phase = "page";
  const page = context.pages()[0] ?? await context.newPage();
  if (mode === "hold") {
    process.stdout.write("{\"ready\":true}\n");
    await page.evaluate(() => new Promise(() => {}));
  } else {
    phase = "navigate";
    await page.goto(origin);
    if (mode === "write") {
      await context.addCookies([{ name: "owner-proof", value: "saved", url: origin }]);
      await page.evaluate(() => localStorage.setItem("owner-proof", "saved"));
    }
    const result = await page.evaluate(() => ({
      stored: localStorage.getItem("owner-proof"),
      identity: { userAgent: navigator.userAgent, screen: [screen.width, screen.height] },
    }));
    if (context.pages().length === 1) await context.newPage();
    await page.close();
    process.stdout.write(JSON.stringify(result));
  }
} catch (error) {
  if (mode === "hold") process.stdout.write(`${JSON.stringify({ failed: phase, error: safeError(error) })}\n`);
  throw error;
} finally {
  await browser?.close();
}
