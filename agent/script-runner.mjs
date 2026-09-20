import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const scriptPath = process.argv[2];
if (!scriptPath) throw new Error("script path is missing");

process.stdin.setEncoding("utf8");
process.stdin.once("end", () => process.exit(1));
process.stdin.resume();

function firstInputLine() {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      process.stdin.off("data", onData);
      resolve(buffer.slice(0, newline).replace(/\r$/, ""));
    };
    const onEnd = () => {
      process.stdin.off("data", onData);
      reject(new Error("runner input is missing"));
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
}

async function run(input) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(input.endpoint, { timeout: 30_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("AliasMode browser context is unavailable");
    const page = context.pages()[0] ?? await context.newPage();
    const module = await import(pathToFileURL(scriptPath).href);
    if (typeof module.default !== "function") {
      throw new Error("Playwright script must export a default async function");
    }
    await module.default({
      browser,
      context,
      page,
      profile: input.profile,
      inputs: input.inputs,
      credentials: input.credentials ?? null,
      log: (...values) => console.log(...values),
    });
  } finally {
    await browser?.close().catch(() => {});
  }
}

try {
  await run(JSON.parse(await firstInputLine()));
} catch (error) {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.stack : error);
} finally {
  process.stdin.pause();
}
