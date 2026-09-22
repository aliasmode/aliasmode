import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { firefox } from "playwright-core";
import { connectOfficial, nonClosingContext } from "../agent/playwright-proxy.mjs";

const executablePath = process.argv[2];
const root = process.argv[3] && resolve(process.argv[3]);
const headed = process.argv.includes("--headed");
const nativeUi = process.argv.includes("--native-ui");
const previousBrowserIndex = process.argv.indexOf("--previous-browser");
const previousBrowser = previousBrowserIndex < 0 ? undefined : process.argv[previousBrowserIndex + 1];
const run = promisify(execFile);
if (!executablePath || !root) {
  throw new Error("usage: node scripts/firefox-compatibility-smoke.mjs <browser> <new-test-directory> [--headed] [--native-ui] [--previous-browser <browser>]");
}
if (previousBrowserIndex >= 0 && (!previousBrowser || previousBrowser.startsWith("--"))) {
  throw new Error("--previous-browser requires a browser executable");
}
if (nativeUi && (!headed || process.platform !== "darwin")) {
  throw new Error("native Firefox UI acceptance requires headed macOS");
}
if (previousBrowser && !nativeUi) {
  throw new Error("--previous-browser requires native Firefox UI acceptance");
}
function appBundlePath(path) {
  const executable = resolve(path);
  const suffix = ".app/Contents/MacOS/";
  const index = executable.lastIndexOf(suffix);
  if (index < 0) throw new Error("native Firefox UI acceptance requires an executable inside a .app bundle");
  return executable.slice(0, index + 4);
}
const nativeExecutable = nativeUi ? resolve(executablePath) : undefined;
const nativeAppBundle = nativeUi ? appBundlePath(executablePath) : undefined;
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

async function launch(directory, browser = executablePath) {
  const context = await firefox.launchPersistentContext(join(root, directory), {
    executablePath: resolve(browser),
    headless: !headed,
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

async function syntheticDuckDuckGo(context) {
  let fulfilled = 0;
  await context.route(/^https?:\/\/(?:[^/]+\.)?duckduckgo\.com(?:[/?]|$)/, async (route) => {
    fulfilled += 1;
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><title>AliasMode DuckDuckGo proof</title>",
    });
  });
  return () => fulfilled;
}

function nativeBrowserScript(commands = "") {
  return `set browserBundlePath to POSIX path of (POSIX file ${JSON.stringify(nativeAppBundle)} as alias)
set browserExecutablePath to POSIX path of (POSIX file ${JSON.stringify(nativeExecutable)} as alias)
tell application "System Events"
  set browserProcesses to {}
  repeat with browserProcess in every application process
    try
      set processPath to POSIX path of ((application file of browserProcess) as alias)
      if processPath is browserBundlePath or processPath is browserExecutablePath then set end of browserProcesses to browserProcess
    end try
  end repeat
  if (count of browserProcesses) is not 1 then error "expected exactly one supplied Firefox application process; matched " & (count of browserProcesses)
  tell item 1 of browserProcesses
    set frontmost to true
    delay 0.2
${commands}  end tell
end tell`;
}

async function focusNativeBrowser() {
  await run("osascript", ["-e", nativeBrowserScript()]);
}

async function nativeAddressBarSearch(page, phase, duckDuckGoResponses) {
  if (!nativeUi) return;
  const query = `aliasmode firefox ${phase} search`;
  const before = duckDuckGoResponses();
  await focusNativeBrowser();
  await page.bringToFront();
  const searchResult = page.waitForURL((url) => {
    const destination = new URL(url);
    return (destination.hostname === "duckduckgo.com" || destination.hostname.endsWith(".duckduckgo.com"))
      && destination.searchParams.get("q") === query;
  }, { timeout: 30_000 });
  await run("osascript", ["-e", nativeBrowserScript(`    keystroke "l" using command down
    keystroke "${query}"
    key code 36
`)]);
  await searchResult;
  assert.ok(duckDuckGoResponses() > before, "DuckDuckGo navigation must use the synthetic response");
}

async function captureNativeFirefoxUi(page, name) {
  if (!nativeUi) return;
  await focusNativeBrowser();
  await page.bringToFront();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await run("screencapture", ["-x", join(root, `firefox-dock-tabs-${name}.png`)]);
}

async function closeOtherPages(context, page) {
  for (const other of context.pages()) {
    if (other !== page) await other.close();
  }
  assert.equal(context.pages().length, 1, "native tab evidence starts with one tab");
}

async function captureNativeTabEvidence(context, page) {
  if (!nativeUi) return;
  await closeOtherPages(context, page);
  await captureNativeFirefoxUi(page, "one");
  const second = await context.newPage();
  await second.goto(origin);
  assert.equal(context.pages().length, 2, "native two-tab evidence has two tabs");
  await captureNativeFirefoxUi(second, "two");
  for (let index = 0; index < 4; index += 1) {
    const extra = await context.newPage();
    await extra.goto(origin);
  }
  assert.equal(context.pages().length, 6, "native several-tab evidence has six tabs");
  const lastPage = context.pages().at(-1);
  await captureNativeFirefoxUi(lastPage, "several");
  await run("osascript", ["-e", nativeBrowserScript("    set size of window 1 to {720, 620}\n")]);
  await captureNativeFirefoxUi(lastPage, "narrow");
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
  let duckDuckGoResponses = nativeUi ? await syntheticDuckDuckGo(context) : () => 0;
  let page = await openFixture(context);
  const initialIdentity = await identity(page);
  await context.addCookies([{ name: "proof", value: "saved", url: origin, expires: Math.floor(Date.now() / 1000) + 86400 }]);
  await page.evaluate(() => localStorage.setItem("proof", "saved"));
  await databaseValue(page, { restored: true });
  if (nativeUi) {
    await closeOtherPages(context, page);
    await captureNativeFirefoxUi(page, "baseline");
  }
  await nativeAddressBarSearch(page, "fresh", duckDuckGoResponses);
  if (nativeUi) await page.goto(origin);

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
  duckDuckGoResponses = nativeUi ? await syntheticDuckDuckGo(context) : () => 0;
  page = await openFixture(context);
  assert.deepEqual(await identity(page), initialIdentity);
  assert.ok((await context.cookies()).some((cookie) => cookie.name === "proof" && cookie.value === "saved"));
  assert.equal(await page.evaluate(() => localStorage.getItem("proof")), "saved");
  assert.deepEqual(await databaseValue(page, null), { restored: true });
  await nativeAddressBarSearch(page, "reopened", duckDuckGoResponses);
  await captureNativeTabEvidence(context, page);
  await context.close();
  contexts.delete(context);

  if (previousBrowser) {
    context = await launch("previous-runtime-profile", previousBrowser);
    page = await openFixture(context);
    const previousIdentity = await identity(page);
    await context.addCookies([{ name: "previous-proof", value: "saved", url: origin, expires: Math.floor(Date.now() / 1000) + 86400 }]);
    await page.evaluate(() => localStorage.setItem("previous-proof", "saved"));
    await databaseValue(page, { upgraded: true });
    await context.close();
    contexts.delete(context);

    context = await launch("previous-runtime-profile");
    duckDuckGoResponses = await syntheticDuckDuckGo(context);
    page = await openFixture(context);
    assert.deepEqual(await identity(page), previousIdentity, "candidate preserves prior runtime identity");
    assert.ok((await context.cookies()).some((cookie) => cookie.name === "previous-proof" && cookie.value === "saved"));
    assert.equal(await page.evaluate(() => localStorage.getItem("previous-proof")), "saved");
    assert.deepEqual(await databaseValue(page, null), { upgraded: true });
    await nativeAddressBarSearch(page, "upgraded", duckDuckGoResponses);
    await context.close();
    contexts.delete(context);
  }

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
    nativeAddressBarDuckDuckGo: nativeUi,
    nativeTabAndDockEvidence: nativeUi,
    previousRuntimeUpgrade: Boolean(previousBrowser),
  };
  await writeFile(join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  await official?.client.close().catch(() => {});
  await official?.server.close().catch(() => {});
  for (const context of contexts) await context.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
