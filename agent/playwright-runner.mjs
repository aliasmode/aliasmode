import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

process.stdin.resume();
process.stdin.once("end", () => process.exit(1));

const endpoint = process.env.ALIASMODE_CDP_ENDPOINT;
const scriptPath = process.argv[2];
if (!endpoint || !scriptPath) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: "runner input is missing" })}\n`);
  process.exit(1);
}

let browser;
try {
  browser = await chromium.connectOverCDP(endpoint, { timeout: 30_000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("AliasMode browser context is unavailable");
  const pages = context.pages();
  const page = pages[0] ?? await context.newPage();
  const module = await import(pathToFileURL(scriptPath).href);
  if (typeof module.default !== "function") {
    throw new Error("Playwright script must export a default async function");
  }
  const result = await module.default({ browser, context, page });
  process.stdout.write(`${JSON.stringify({ ok: true, result: result ?? null })}\n`);
} catch {
  process.stdout.write(`${JSON.stringify({ ok: false, error: "Playwright script failed" })}\n`);
  process.exitCode = 1;
} finally {
  process.stdin.pause();
  await browser?.close().catch(() => {});
}
