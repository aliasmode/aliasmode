import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = 1;
const MAX_BYTES = 16 * 1024 * 1024;
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const ERROR_MESSAGES = {
  invalid_request: "Playwright worker request is invalid",
  operation_failed: "Playwright operation failed",
  timeout: "Playwright operation timed out",
  runtime_unavailable: "Playwright runtime is unavailable",
};

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_BYTES) throw typed("invalid_request");
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw typed("invalid_request"); }
  if (value?.version !== VERSION || typeof value.operation !== "string" || !value.payload || typeof value.payload !== "object") {
    throw typed("invalid_request");
  }
  return value;
}

function typed(code) {
  const error = new Error(ERROR_MESSAGES[code] || ERROR_MESSAGES.operation_failed);
  error.code = code;
  return error;
}

async function closeWithin(close, timeoutMs = 5_000) {
  if (!close) return true;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(close).then(() => true, () => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function withBrowser(chromium, endpoint, timeout, run) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout });
    return await run(browser);
  } finally {
    if (browser) await closeWithin(() => browser.close());
  }
}

function contextOf(browser) {
  const context = browser.contexts()[0];
  if (!context) throw typed("operation_failed");
  return context;
}

const SESSION_URLS = [
  "https://x.com", "https://web.telegram.org", "https://www.linkedin.com", "https://linkedin.com",
  "https://www.instagram.com", "https://instagram.com", "https://www.facebook.com", "https://facebook.com",
  "https://www.tiktok.com", "https://tiktok.com", "https://www.reddit.com", "https://reddit.com",
];
const SESSION_HOSTS = [...new Set(SESSION_URLS.map((url) => new URL(url).hostname))];
const TELEGRAM_ORIGIN = "https://web.telegram.org";
const LINKEDIN_DEVICE_COOKIES = new Set(["bcookie", "bscookie", "li_rm"]);

function sessionCookie(cookie) {
  const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
  return SESSION_HOSTS.some((host) => domain === host || domain.endsWith(`.${host}`));
}

async function captureSession(browser) {
  const context = contextOf(browser);
  const state = await context.storageState({ indexedDB: true });
  const origins = (state.origins || []).filter((item) => item.origin === TELEGRAM_ORIGIN);
  let telegramClient;
  for (const page of context.pages()) {
    try {
      const url = new URL(page.url());
      if (url.origin !== TELEGRAM_ORIGIN) continue;
      if (url.pathname === "/a" || url.pathname.startsWith("/a/")) telegramClient = "a";
      if (url.pathname === "/k" || url.pathname.startsWith("/k/")) telegramClient = "k";
      const localStorage = await page.evaluate(() => Object.keys(globalThis.localStorage).map((name) => ({ name, value: globalThis.localStorage.getItem(name) })));
      const index = origins.findIndex((item) => item.origin === TELEGRAM_ORIGIN);
      const next = { origin: TELEGRAM_ORIGIN, localStorage, ...(index >= 0 && origins[index].indexedDB ? { indexedDB: origins[index].indexedDB } : {}) };
      if (index >= 0) origins[index] = next; else origins.push(next);
      break;
    } catch {}
  }
  return JSON.stringify({ cookies: state.cookies.filter(sessionCookie), origins, ...(telegramClient ? { telegramClient } : {}) });
}

async function restoreSession(browser, payload) {
  let bundle;
  try { bundle = JSON.parse(payload.bundle); } catch { throw typed("invalid_request"); }
  const context = contextOf(browser);
  const origins = Array.isArray(bundle.origins) ? bundle.origins.filter((item) => item?.origin === TELEGRAM_ORIGIN) : [];
  const storageScriptSource = await readFile(join(ROOT, "node_modules", "playwright-core", "lib", "generated", "storageScriptSource.js"), "utf8");
  for (const target of origins) {
    const existing = context.pages();
    for (const page of existing) {
      try { if (new URL(page.url()).origin === TELEGRAM_ORIGIN) await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 }); } catch {}
    }
    const page = await context.newPage();
    const restoreUrl = `${TELEGRAM_ORIGIN}/?__aliasmode_session_restore__=${Date.now()}`;
    const handler = (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>restore</title>" });
    try {
      await context.route(restoreUrl, handler);
      await page.goto(restoreUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await page.evaluate(async ({ localStorage: entries, indexedDB: databases, storageScriptSource: source }) => {
        if (Array.isArray(databases) && databases.length) {
          const module = { exports: {} };
          Function("module", source)(module);
          const script = new module.exports.StorageScript()(false);
          for (const database of databases) {
            await new Promise((resolve, reject) => {
              const request = globalThis.indexedDB.deleteDatabase(database.name);
              request.onsuccess = resolve;
              request.onerror = () => reject(request.error);
              request.onblocked = () => reject(new Error("blocked"));
            });
            await script._restoreDB(database);
          }
        }
        globalThis.localStorage.clear();
        for (const entry of Array.isArray(entries) ? entries : []) globalThis.localStorage.setItem(entry.name, entry.value);
      }, { ...target, storageScriptSource });
    } finally {
      await context.unroute(restoreUrl, handler).catch(() => {});
      await page.close().catch(() => {});
    }
  }
  await context.clearCookies();
  const cookies = (Array.isArray(bundle.cookies) ? bundle.cookies : []).filter((cookie) => !LINKEDIN_DEVICE_COOKIES.has(cookie.name));
  if (cookies.length) await context.addCookies(cookies);
  for (let i = 0; i < (payload.urls || []).length; i++) {
    const page = i === 0 ? context.pages()[0] || await context.newPage() : await context.newPage();
    await page.goto(payload.urls[i], { waitUntil: "domcontentloaded", timeout: 30_000 });
  }
  return null;
}

async function searchProvider(context) {
  const page = await context.newPage();
  try {
    await page.goto("chrome://settings/searchEngines", { waitUntil: "domcontentloaded", timeout: 10_000 });
    return await page.evaluate(async () => {
      const cr = await import("chrome://resources/js/cr.js");
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const engines = async () => Object.values(await cr.sendWithPromise("getSearchEnginesList")).filter(Array.isArray).flat();
      const identity = (engine) => [engine.keyword, engine.name, engine.displayName, engine.url].filter(Boolean).join(" ").toLowerCase();
      const current = (await engines()).find((engine) => engine.default);
      const noSearch = current && (identity(current).includes("no search") || /^https?:\/\/%s\/?$/.test(String(current.url || "").toLowerCase()));
      if (current && !noSearch) return { status: identity(current).includes("duckduckgo") ? "already-default" : "kept-existing", engine: current.displayName || current.name || current.keyword || "Current search provider" };
      const deep = (root, selector) => {
        const found = [...root.querySelectorAll(selector)];
        for (const element of root.querySelectorAll("*")) if (element.shadowRoot) found.push(...deep(element.shadowRoot, selector));
        return found;
      };
      let add;
      for (let i = 0; i < 30 && !add; i++) { add = deep(document, "#addSearchEngine")[0]; if (!add) await wait(100); }
      if (!add) throw new Error("add unavailable");
      add.click();
      let dialog;
      for (let i = 0; i < 20 && !dialog; i++) { await wait(100); dialog = deep(document, "settings-search-engine-edit-dialog")[0]; }
      if (!dialog) throw new Error("dialog unavailable");
      for (const [id, value] of [["searchEngine", "DuckDuckGo"], ["keyword", "duckduckgo.com"], ["queryUrl", "https://duckduckgo.com/?q=%s"]]) {
        const input = deep(dialog, `cr-input#${id}`)[0]?.shadowRoot?.querySelector("input");
        if (!input) throw new Error("input unavailable");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set.call(input, value);
        input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      }
      let save;
      for (let i = 0; i < 30; i++) { await wait(100); save = deep(dialog, "#actionButton")[0]; if (save && !save.disabled) break; }
      if (!save || save.disabled) throw new Error("settings rejected");
      save.click();
      let duck;
      for (let i = 0; i < 20 && !duck; i++) { await wait(100); duck = (await engines()).find((engine) => identity(engine).includes("duckduckgo")); }
      if (!duck) throw new Error("not saved");
      const usesModelIndex = typeof duck.modelIndex === "number";
      const ref = usesModelIndex ? duck.modelIndex : duck.id;
      if (duck.canBeActivated) { globalThis.chrome.send("setIsActiveSearchEngine", [ref, true]); await wait(100); }
      globalThis.chrome.send("setDefaultSearchEngine", [ref, usesModelIndex ? 0 : 1, null]);
      for (let i = 0; i < 20; i++) { await wait(100); const saved = (await engines()).find((engine) => identity(engine).includes("duckduckgo")); if (saved?.default) return { status: "configured", engine: saved.displayName || saved.name || "DuckDuckGo" }; }
      throw new Error("not persisted");
    });
  } finally { await page.close().catch(() => {}); }
}

async function operate(chromium, operation, payload) {
  const endpoint = payload.endpoint;
  if (typeof endpoint !== "string" || !/^https?:\/\/|^wss?:\/\//.test(endpoint)) throw typed("invalid_request");
  const timeout = Math.max(1, Math.min(Number(payload.connectTimeoutMs) || 30_000, 120_000));
  return withBrowser(chromium, endpoint, timeout, async (browser) => {
    const context = contextOf(browser);
    if (operation === "session-capture") return captureSession(browser);
    if (operation === "session-restore") return restoreSession(browser, payload);
    if (operation === "cookie-harvest") return context.cookies(Array.isArray(payload.urls) && payload.urls.length ? payload.urls : SESSION_URLS);
    if (operation === "search-provider") return searchProvider(context);
    if (operation === "navigate") {
      for (let i = 0; i < payload.urls.length; i++) {
        const page = i === 0 ? context.pages()[0] || await context.newPage() : await context.newPage();
        await page.goto(payload.urls[i], { waitUntil: "domcontentloaded", timeout: 30_000 });
      }
      return null;
    }
    if (operation === "profile-card") {
      const automation = context.pages()[0];
      const page = await context.newPage();
      await page.goto(payload.url, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      if (automation && automation !== page) await automation.bringToFront().catch(() => {});
      return null;
    }
    if (operation === "label-window") {
      await context.addInitScript({ content: payload.script }).catch(() => {});
      for (const page of context.pages()) await page.evaluate(payload.script).catch(() => {});
      return null;
    }
    if (operation === "ensure-cookies") {
      const existing = await context.cookies(payload.url);
      const current = (cookie) => cookie.expires === undefined || Number(cookie.expires) < 0 || Number(cookie.expires) > Date.now() / 1000;
      const usable = payload.target === "X"
        ? existing.some((cookie) => cookie.name === "auth_token" && cookie.value && current(cookie))
        : existing.some((cookie) => cookie.name && cookie.value && String(cookie.domain || "").replace(/^\./, "").toLowerCase().endsWith("telegram.org") && current(cookie));
      if (usable) return { injected: false };
      await context.addCookies(payload.cookies);
      return { injected: true };
    }
    if (operation === "diagnostics") {
      const page = await context.newPage();
      try {
        await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: payload.timeoutMs }).catch(() => {});
        const fingerprint = await page.evaluate(payload.fingerprintScript).catch(() => ({ errors: { probe: "diagnostic probe failed" } }));
        const webrtcIps = await page.evaluate(payload.webrtcScript).catch(() => []);
        let egress = null;
        for (const url of payload.egressUrls) {
          try { const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: payload.timeoutMs }); if (response?.ok()) { egress = await page.locator("body").innerText({ timeout: Math.min(payload.timeoutMs, 5_000) }); break; } } catch {}
        }
        let login = null;
        if (payload.collectLogin) {
          try {
            await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: payload.timeoutMs });
            await page.waitForSelector('[data-testid="SideNav_NewTweet_Button"], [data-testid="AppTabBar_Home_Link"], [aria-label="Home timeline"], input[name="text"], a[href="/login"], [data-testid="loginButton"]', { timeout: 15_000 }).catch(() => {});
            login = await page.evaluate(payload.loginScript);
          } catch { login = { loggedIn: false, loggedOut: false, url: "error", title: "diagnostic navigation failed" }; }
        }
        return { fingerprint, webrtcIps, egress, login };
      } finally { await page.close().catch(() => {}); }
    }
    if (operation === "page") {
      const page = payload.temporary ? await context.newPage() : context.pages()[0] || await context.newPage();
      try {
        if (payload.url) await page.goto(payload.url, { waitUntil: "domcontentloaded", timeout: payload.timeoutMs || 30_000 }).catch(() => {});
        if (payload.kind === "user-agent") return page.evaluate(() => navigator.userAgent);
        if (payload.kind === "scripts") {
          const values = [];
          for (const source of payload.scripts) values.push(await page.evaluate(source).catch((error) => ({ __aliasmodeError: String(error) })));
          return values;
        }
        if (payload.kind === "egress") {
          for (const url of payload.urls) {
            try { const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: payload.timeoutMs }); if (response?.ok()) return await page.locator("body").innerText({ timeout: Math.min(payload.timeoutMs, 5_000) }); } catch {}
          }
          return null;
        }
        throw typed("invalid_request");
      } finally { if (payload.temporary) await page.close().catch(() => {}); }
    }
    throw typed("invalid_request");
  });
}

let response;
let exitCode = 0;
try {
  const request = await readStdin();
  let runtime;
  try { runtime = await import(join(ROOT, "node_modules", "playwright-core", "index.mjs")); } catch { throw typed("runtime_unavailable"); }
  const result = await operate(runtime.chromium || runtime.default?.chromium, request.operation, request.payload);
  response = { version: VERSION, ok: true, result };
} catch (error) {
  exitCode = 1;
  const code = error?.code && ERROR_MESSAGES[error.code] ? error.code : "operation_failed";
  response = { version: VERSION, ok: false, error: { code, message: ERROR_MESSAGES[code] } };
}
const output = JSON.stringify(response);
if (Buffer.byteLength(output) > MAX_BYTES) {
  process.stdout.write(JSON.stringify({ version: VERSION, ok: false, error: { code: "operation_failed", message: ERROR_MESSAGES.operation_failed } }));
  process.exitCode = 1;
} else {
  process.stdout.write(output);
  process.exitCode = exitCode;
}
