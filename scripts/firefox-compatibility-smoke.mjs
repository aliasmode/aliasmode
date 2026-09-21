import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { firefox } from "playwright-core";
import { connectOfficial, nonClosingContext } from "../agent/playwright-proxy.mjs";

const executablePath = process.argv[2];
const root = process.argv[3] && resolve(process.argv[3]);
if (!executablePath || !root) {
  throw new Error("usage: node scripts/firefox-compatibility-smoke.mjs <browser> <new-test-directory> [--headed]");
}
await mkdir(root, { recursive: false });
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>AliasMode Firefox proof</title><h1>Browser compatibility fixture</h1><button onclick=\"this.textContent='Clicked'\">Click</button>");
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const contexts = new Set();
let official;

async function launch(directory) {
  const context = await firefox.launchPersistentContext(join(root, directory), {
    executablePath: resolve(executablePath),
    headless: !process.argv.includes("--headed"),
    viewport: null,
    timeout: 120_000,
  });
  contexts.add(context);
  assert.ok(context.browser(), "persistent context exposes the browser used by scripts");
  return context;
}

async function openFixture(context) {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(origin);
  return page;
}

async function identity(page) {
  return page.evaluate(() => ({
    ua: navigator.userAgent,
    platform: navigator.platform,
    languages: [...navigator.languages],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: [screen.width, screen.height, screen.colorDepth],
  }));
}

async function databaseValue(page, value) {
  return page.evaluate((value) => new Promise((resolve, reject) => {
    const request = indexedDB.open("aliasmode-proof", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onerror = () => reject(new Error("could not open fixture IndexedDB"));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("state", value === null ? "readonly" : "readwrite");
      const store = transaction.objectStore("state");
      const operation = value === null ? store.get("session") : store.put(value, "session");
      let result;
      operation.onsuccess = () => { result = operation.result; };
      transaction.oncomplete = () => { database.close(); resolve(result); };
      transaction.onerror = () => { database.close(); reject(new Error("fixture IndexedDB transaction failed")); };
    };
  }), value);
}

try {
  let context = await launch("profile");
  let page = await openFixture(context);
  const initialIdentity = await identity(page);
  await context.addCookies([{ name: "proof", value: "saved", url: origin, expires: Math.floor(Date.now() / 1000) + 86400 }]);
  await page.evaluate(() => localStorage.setItem("proof", "saved"));
  await databaseValue(page, { restored: true });

  official = await connectOfficial("firefox-proof", async () => nonClosingContext(context));
  assert.ok(official.tools.some((tool) => tool.name === "browser_snapshot"));
  const snapshot = await official.client.callTool({ name: "browser_snapshot", arguments: {} });
  assert.notEqual(snapshot.isError, true, JSON.stringify(snapshot));
  await official.client.close();
  await official.server.close();
  official = undefined;
  assert.equal(await page.title(), "AliasMode Firefox proof", "MCP disconnect leaves the browser open");

  const script = join(root, "proof-script.mjs");
  await writeFile(script, `export default async ({ browser, context, page }) => ({
    sameBrowser: context.browser() === browser,
    samePage: context.pages().includes(page),
    stored: await page.evaluate(() => localStorage.getItem("proof")),
  });\n`);
  const run = (await import(pathToFileURL(script).href)).default;
  assert.deepEqual(await run({ browser: context.browser(), context, page }), {
    sameBrowser: true, samePage: true, stored: "saved",
  });

  const transferred = {
    cookies: await context.cookies(),
    localStorage: await page.evaluate(() => Object.entries(localStorage)),
    indexedDB: await databaseValue(page, null),
  };
  const nativeState = await context.storageState({ indexedDB: true });
  assert.ok(nativeState.origins.some((entry) => entry.origin === origin && entry.indexedDB?.length));
  await context.close();
  contexts.delete(context);

  context = await launch("profile");
  page = await openFixture(context);
  assert.deepEqual(await identity(page), initialIdentity);
  assert.ok((await context.cookies()).some((cookie) => cookie.name === "proof" && cookie.value === "saved"));
  assert.equal(await page.evaluate(() => localStorage.getItem("proof")), "saved");
  assert.deepEqual(await databaseValue(page, null), { restored: true });
  await context.close();
  contexts.delete(context);

  context = await launch("transferred-profile");
  await context.addCookies(transferred.cookies);
  page = await openFixture(context);
  await page.evaluate((entries) => {
    for (const [key, value] of entries) localStorage.setItem(key, value);
  }, transferred.localStorage);
  await databaseValue(page, transferred.indexedDB);
  assert.ok((await context.cookies()).some((cookie) => cookie.name === "proof" && cookie.value === "saved"));
  assert.equal(await page.evaluate(() => localStorage.getItem("proof")), "saved");
  assert.deepEqual(await databaseValue(page, null), { restored: true });

  const result = {
    platform: process.platform,
    browserVersion: context.browser().version(),
    persistentContext: true,
    localStateSurvivesRestart: true,
    nativeIdentityStableAcrossRestart: true,
    officialMcp: true,
    mcpDisconnectPreservesContext: true,
    scriptContext: true,
    selectedStateTransfer: true,
    indexedDbSnapshot: true,
  };
  await writeFile(join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  await official?.client.close().catch(() => {});
  await official?.server.close().catch(() => {});
  for (const context of contexts) await context.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
