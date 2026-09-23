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
    // Expose Gecko's native controls to System Events in these scratch profiles.
    ...(nativeUi ? { firefoxUserPrefs: { "accessibility.force_disabled": -1 } } : {}),
    timeout: 120_000,
  });
  contexts.add(context);
  assert.ok(context.browser(), "persistent context exposes the browser used by scripts");
  return context;
}

async function fixturePage(page, title) {
  await page.goto(origin);
  if (title) await page.evaluate((title) => { document.title = title; }, title);
}

async function openFixture(context) {
  const page = context.pages()[0] ?? await context.newPage();
  await fixturePage(page);
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

function nativeBrowserLookupScript() {
  return `ObjC.import('AppKit');
ObjC.import('Foundation');
const canonicalPath = (url) => url ? ObjC.unwrap(url.URLByResolvingSymlinksInPath.path) : null;
const targetBundlePath = canonicalPath($.NSURL.fileURLWithPath($(${JSON.stringify(nativeAppBundle)})));
const targetExecutablePath = canonicalPath($.NSURL.fileURLWithPath($(${JSON.stringify(nativeExecutable)})));
const applications = $.NSWorkspace.sharedWorkspace.runningApplications;
const matches = [];
const aliasModeCandidates = [];
for (let index = 0; index < applications.count; index += 1) {
  const application = applications.objectAtIndex(index);
  const bundlePath = canonicalPath(application.bundleURL);
  const executablePath = canonicalPath(application.executableURL);
  const name = application.localizedName ? ObjC.unwrap(application.localizedName) : "";
  const pid = Number(application.processIdentifier);
  if (bundlePath === targetBundlePath || executablePath === targetExecutablePath) {
    matches.push({ pid, name, bundlePath, executablePath });
  }
  if (name.toLowerCase().includes("aliasmode")) aliasModeCandidates.push({ pid, name, bundlePath, executablePath });
}
if (matches.length !== 1) throw new Error("expected exactly one supplied Firefox application process; matched " + matches.length + "; AliasMode candidates " + JSON.stringify(aliasModeCandidates));
JSON.stringify(matches[0]);`;
}

function nativeBrowserScript(pid, commands = "") {
  return `tell application "System Events"
  set browserProcesses to every application process whose unix id is ${pid}
  if (count of browserProcesses) is not 1 then error "expected supplied Firefox process by PID; matched " & (count of browserProcesses)
  tell item 1 of browserProcesses
    set frontmost to true
    delay 0.2
${commands}  end tell
end tell`;
}

async function focusNativeBrowser() {
  const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", nativeBrowserLookupScript()]);
  const application = JSON.parse(stdout);
  const pid = application.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("native Firefox application lookup returned an invalid PID");
  assert.equal(application.name, "AliasMode Firefox", "native Dock application uses the Firefox-specific name");
  await run("osascript", ["-e", nativeBrowserScript(pid)]);
  return pid;
}

async function nativeAddressBarSearch(page, phase, duckDuckGoResponses) {
  if (!nativeUi) return;
  const query = `aliasmode firefox ${phase} search`;
  const before = duckDuckGoResponses();
  const pid = await focusNativeBrowser();
  await page.bringToFront();
  const searchResult = page.waitForURL((url) => {
    const destination = new URL(url);
    return (destination.hostname === "duckduckgo.com" || destination.hostname.endsWith(".duckduckgo.com"))
      && destination.searchParams.get("q") === query;
  }, { timeout: 30_000 });
  await run("osascript", ["-e", nativeBrowserScript(pid, `    keystroke "l" using command down
    keystroke "${query}"
    key code 36
`)]);
  try {
    await searchResult;
  } finally {
    await captureNativeFirefoxUi(page, `search-${phase}`);
  }
  assert.ok(duckDuckGoResponses() > before, "DuckDuckGo navigation must use the synthetic response");
}

async function captureRawNativeFirefoxUi(name) {
  if (!nativeUi) return;
  await run("screencapture", ["-x", join(root, `firefox-dock-tabs-${name}.png`)]);
}

async function captureNativeFirefoxUi(page, name) {
  if (!nativeUi) return;
  await focusNativeBrowser();
  await page.bringToFront();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await run("screencapture", ["-x", join(root, `firefox-dock-tabs-${name}.png`)]);
}

async function assertOneNativeWindow() {
  const pid = await focusNativeBrowser();
  const { stdout } = await run("osascript", ["-e", `tell application "System Events" to tell first application process whose unix id is ${pid} to count windows`]);
  assert.equal(Number.parseInt(stdout, 10), 1, "native tab evidence uses one browser window");
  return pid;
}

async function nativeTabButton(pid, label) {
  const { stdout } = await run("osascript", ["-e", nativeBrowserScript(pid, `    set targetButtons to {}
    set observedButtons to ""
    set navigationPosition to missing value
    set browserElements to entire contents of window 1
    repeat with candidate in browserElements
      if role of candidate is "AXButton" then
        set buttonName to ""
        set buttonDescription to ""
        set buttonHelp to ""
        try
          set buttonName to name of candidate as text
        end try
        try
          set buttonDescription to description of candidate as text
        end try
        try
          set buttonHelp to value of attribute "AXHelp" of candidate as text
        end try
        set observedButtons to observedButtons & buttonName & " / " & buttonDescription & " / " & buttonHelp & linefeed
        if buttonName is "Back" or buttonDescription is "Back" then set navigationPosition to position of candidate
        set buttonSize to size of candidate
        if enabled of candidate and (item 1 of buttonSize) > 0 and (item 2 of buttonSize) > 0 then
          if buttonName is ${JSON.stringify(label)} or buttonDescription is ${JSON.stringify(label)} or buttonHelp is ${JSON.stringify(label)} then
            set end of targetButtons to contents of candidate
          end if
        end if
      end if
    end repeat
    if (count of targetButtons) is 0 then error "native tab button missing; observed buttons: " & observedButtons
    if ${JSON.stringify(label)} is "New Tab" and (count of targetButtons) is not 1 then error "native new-tab button is ambiguous"
    set targetButton to item 1 of targetButtons
    set targetPosition to position of targetButton
    repeat with candidate in targetButtons
      set candidatePosition to position of candidate
      if (item 1 of candidatePosition) > (item 1 of targetPosition) then
        set targetButton to contents of candidate
        set targetPosition to candidatePosition
      end if
    end repeat
    if ${JSON.stringify(label)} is "New Tab" then
      if navigationPosition is missing value then error "native navigation toolbar was not found"
      if (item 2 of targetPosition) >= (item 2 of navigationPosition) then error "new-tab button must be beside the tabs, above the navigation toolbar"
    end if
    set observedButtons to observedButtons & "Selected ${label} at " & (item 1 of targetPosition) & ", " & (item 2 of targetPosition) & linefeed
    perform action "AXPress" of targetButton
    return observedButtons
`)]);
  await writeFile(join(root, `firefox-native-buttons-${label === "New Tab" ? "new" : "close"}.txt`), stdout);
}

async function nativeTab(context, title) {
  const pid = await assertOneNativeWindow();
  const [page] = await Promise.all([
    context.waitForEvent("page", { timeout: 30_000 }),
    nativeTabButton(pid, "New Tab"),
  ]);
  await fixturePage(page, title);
  await assertOneNativeWindow();
  return page;
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
  await fixturePage(page, "Tab1");
  await assertOneNativeWindow();
  await captureNativeFirefoxUi(page, "one");
  const second = await nativeTab(context, "Tab2");
  assert.equal(context.pages().length, 2, "native two-tab evidence has two tabs");
  await captureNativeFirefoxUi(second, "two");
  const closePid = await assertOneNativeWindow();
  await Promise.all([
    second.waitForEvent("close", { timeout: 30_000 }),
    nativeTabButton(closePid, "Close tab"),
  ]);
  assert.equal(context.pages().length, 1, "native close-tab button closes the selected second tab");
  await captureNativeFirefoxUi(page, "after-close");
  await nativeTab(context, "Tab2");
  for (let index = 3; index <= 6; index += 1) {
    await nativeTab(context, `Tab${index}`);
  }
  assert.equal(context.pages().length, 6, "native several-tab evidence has six tabs");
  const lastPage = context.pages().at(-1);
  await captureNativeFirefoxUi(lastPage, "several");
  const pid = await assertOneNativeWindow();
  await run("osascript", ["-e", nativeBrowserScript(pid, "    set size of window 1 to {720, 620}\n")]);
  await assertOneNativeWindow();
  await captureNativeFirefoxUi(lastPage, "narrow");
  const overflowTab = await nativeTab(context, "Tab7");
  assert.equal(context.pages().length, 7, "native new-tab button works while tabs overflow");
  await captureNativeFirefoxUi(overflowTab, "narrow-new");
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
    await captureRawNativeFirefoxUi("raw-baseline");
    await captureNativeFirefoxUi(page, "baseline");
  }
  await nativeAddressBarSearch(page, "fresh", duckDuckGoResponses);
  if (nativeUi) {
    await page.goto(origin);
    const freshTab = await nativeTab(context, "Fresh tab");
    await captureNativeFirefoxUi(freshTab, "fresh-new");
    await freshTab.close();
  }

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
    await closeOtherPages(context, page);
    const upgradedTab = await nativeTab(context, "Upgraded tab");
    await captureNativeFirefoxUi(upgradedTab, "upgraded-new");
    await context.close();
    contexts.delete(context);

    context = await launch("previous-runtime-profile");
    page = await openFixture(context);
    await closeOtherPages(context, page);
    const reopenedTab = await nativeTab(context, "Upgraded reopened tab");
    await captureNativeFirefoxUi(reopenedTab, "upgraded-reopened-new");
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
    nativeNewAndCloseTabButtons: nativeUi,
    nativeFirefoxDockName: nativeUi,
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
