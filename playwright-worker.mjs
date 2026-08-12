import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

function typed(code, details) {
  const error = new Error(ERROR_MESSAGES[code] || ERROR_MESSAGES.operation_failed);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function sessionError(operation, outcome = "failed") {
  return typed(outcome === "timeout" ? "timeout" : "operation_failed", { operation, outcome });
}

async function sessionStep(operation, run) {
  try { return await run(); }
  catch (error) { if (error?.details) throw error; throw sessionError(operation); }
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

async function withBrowser(chromium, endpoint, timeout, operation, run) {
  const deadline = Date.now() + timeout;
  let browser;
  let context;
  let waitingFor = "connect";
  while (!context) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw operation === "session-restore"
      ? sessionError(waitingFor, "timeout")
      : typed("timeout");
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: remaining });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
      continue;
    }
    context = browser.contexts()[0];
    if (!context) {
      waitingFor = "context";
      const detached = await closeWithin(() => browser.close(), Math.min(5_000, Math.max(1, deadline - Date.now())));
      if (!detached) throw operation === "session-restore"
        ? sessionError("disconnect", "timeout")
        : typed("timeout");
      browser = undefined;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
  }

  let operationError;
  let result;
  try {
    result = await run(browser, context);
  } catch (error) {
    operationError = error;
  }
  const detached = await closeWithin(() => browser.close());
  if (operationError) throw operationError;
  if (!detached) throw operation === "session-restore"
    ? sessionError("disconnect", "timeout")
    : typed("timeout");
  return result;
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
const TELEGRAM_AUTH_INDEXEDDB_RULES = [
  { databaseName: "tt-passcode", stores: ["store"], presence: [{ stores: ["store"], allKeys: ["sessionEncrypted", "globalEncrypted"] }] },
  { databaseName: "tweb-common", stores: ["session", "localStorage__encrypted"], presence: [{ stores: ["localStorage__encrypted"], allKeys: ["data"] }] },
  { databasePattern: "^tweb(?:-account-\\d+)?$", stores: ["session", "session__encrypted"], presence: [{ stores: ["session", "session__encrypted"], anyKeyPattern: "^dc[1-5]_auth_key$", caseInsensitive: true }] },
];

function sessionCookie(cookie) {
  const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
  return SESSION_HOSTS.some((host) => domain === host || domain.endsWith(`.${host}`));
}

function telegramRule(name) {
  return TELEGRAM_AUTH_INDEXEDDB_RULES.find((rule) => rule.databaseName
    ? name === rule.databaseName
    : rule.databasePattern && new RegExp(rule.databasePattern).test(name));
}

function filterTelegramIndexedDB(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((database) => {
    if (typeof database?.name !== "string" || typeof database.version !== "number" || database.version <= 0 || !Array.isArray(database.stores)) return [];
    const rule = telegramRule(database.name);
    if (!rule) return [];
    const allowed = new Set(rule.stores);
    const stores = database.stores.filter((store) => typeof store?.name === "string" && allowed.has(store.name));
    return stores.length ? [{ ...database, stores }] : [];
  });
}

function localStorageHasTelegramAuth(entries) {
  return (Array.isArray(entries) ? entries : []).some((entry) => {
    if (typeof entry?.name !== "string" || typeof entry.value !== "string") return false;
    if (/^dc[1-5]_auth_key$/i.test(entry.name)) return entry.value.length > 0;
    if (!/^account[1-9]\d*$/i.test(entry.name)) return false;
    try {
      const account = JSON.parse(entry.value);
      if (!account || typeof account !== "object" || Array.isArray(account)) return false;
      const dcId = Number(account.dcId ?? account.dcID);
      if (Number.isInteger(dcId) && dcId >= 1 && dcId <= 5 && typeof account[`dc${dcId}_auth_key`] === "string" && account[`dc${dcId}_auth_key`]) return true;
      return Object.entries(account).some(([name, value]) => /^dc[1-5]_auth_key$/i.test(name) && typeof value === "string" && value.length > 0);
    } catch { return false; }
  });
}

async function passcodeDatabasePresent(page) {
  return page.evaluate(async (rules) => {
    const ruleFor = (name) => rules.find((rule) => rule.databaseName ? name === rule.databaseName : rule.databasePattern && new RegExp(rule.databasePattern).test(name));
    const resultOf = (request) => new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
    for (const meta of await indexedDB.databases()) {
      const rule = meta?.name && ruleFor(meta.name);
      if (!rule) continue;
      const db = await resultOf(indexedDB.open(meta.name));
      if (!db) continue;
      try {
        for (const presence of rule.presence) for (const storeName of presence.stores) {
          if (!db.objectStoreNames.contains(storeName)) continue;
          const store = db.transaction(storeName, "readonly").objectStore(storeName);
          if (presence.allKeys) {
            const values = await Promise.all(presence.allKeys.map((key) => resultOf(store.get(key))));
            if (values.every((value) => value !== undefined && value !== null)) return true;
          }
          if (presence.anyKeyPattern) {
            const keys = await resultOf(store.getAllKeys());
            const matcher = new RegExp(presence.anyKeyPattern, presence.caseInsensitive ? "i" : "");
            if (Array.isArray(keys) && keys.some((key) => matcher.test(String(key)))) return true;
          }
        }
      } finally { db.close(); }
    }
    return false;
  }, TELEGRAM_AUTH_INDEXEDDB_RULES);
}

async function storageScriptSource() {
  const module = await import(pathToFileURL(join(ROOT, "node_modules", "playwright-core", "lib", "generated", "storageScriptSource.js")).href);
  const source = typeof module.source === "string" ? module.source : module.default?.source;
  if (typeof source !== "string") throw typed("runtime_unavailable");
  return source;
}
async function collectPasscodeStorage(page) {
  const source = await storageScriptSource();
  return page.evaluate(async ({ rules, source }) => {
    const module = { exports: {} };
    Function("module", "exports", source)(module, module.exports);
    const script = new module.exports.StorageScript(false);
    const ruleFor = (name) => rules.find((rule) => rule.databaseName ? name === rule.databaseName : rule.databasePattern && new RegExp(rule.databasePattern).test(name));
    const localStorage = Object.keys(globalThis.localStorage).map((name) => ({ name, value: globalThis.localStorage.getItem(name) }));
    const indexedDB = [];
    for (const meta of await globalThis.indexedDB.databases()) {
      const rule = meta?.name && ruleFor(meta.name);
      if (!rule) continue;
      const db = await script._collectDB(meta);
      const allowed = new Set(rule.stores);
      db.stores = db.stores.filter((store) => allowed.has(store.name));
      if (db.stores.length) indexedDB.push(db);
    }
    return { localStorage, indexedDB };
  }, { rules: TELEGRAM_AUTH_INDEXEDDB_RULES, source });
}

async function captureSession(browser) {
  const context = contextOf(browser);
  const state = await context.storageState();
  const byOrigin = new Map();
  for (const origin of state.origins || []) {
    if (origin.origin !== TELEGRAM_ORIGIN) continue;
    const localStorage = (Array.isArray(origin.localStorage) ? origin.localStorage : []).filter((entry) => typeof entry?.name === "string" && typeof entry.value === "string");
    const indexedDB = filterTelegramIndexedDB(origin.indexedDB);
    if (localStorage.length || indexedDB.length) byOrigin.set(TELEGRAM_ORIGIN, { origin: TELEGRAM_ORIGIN, localStorage, ...(indexedDB.length ? { indexedDB } : {}) });
  }
  let telegramClient;
  for (const page of context.pages()) {
    try {
      const url = new URL(page.url());
      if (url.origin !== TELEGRAM_ORIGIN) continue;
      if (url.pathname === "/a" || url.pathname.startsWith("/a/")) telegramClient = "a";
      if (url.pathname === "/k" || url.pathname.startsWith("/k/")) telegramClient = "k";
      let storage = await page.evaluate(() => ({ localStorage: Object.keys(globalThis.localStorage).map((name) => ({ name, value: globalThis.localStorage.getItem(name) })) }));
      let capturePasscode = !localStorageHasTelegramAuth(storage.localStorage);
      if (!capturePasscode) capturePasscode = await passcodeDatabasePresent(page).catch(() => false);
      if (capturePasscode) storage = await collectPasscodeStorage(page).catch(() => storage);
      const localStorage = (storage.localStorage || []).filter((entry) => typeof entry?.name === "string" && typeof entry.value === "string");
      const indexedDB = filterTelegramIndexedDB(storage.indexedDB);
      const previous = byOrigin.get(TELEGRAM_ORIGIN);
      if (localStorage.length || indexedDB.length || previous?.indexedDB) byOrigin.set(TELEGRAM_ORIGIN, {
        origin: TELEGRAM_ORIGIN,
        localStorage,
        ...(indexedDB.length ? { indexedDB } : previous?.indexedDB ? { indexedDB: previous.indexedDB } : {}),
      });
      break;
    } catch {}
  }
  return JSON.stringify({ cookies: (state.cookies || []).filter(sessionCookie), origins: [...byOrigin.values()], ...(telegramClient ? { telegramClient } : {}) });
}

async function restoreSession(browser, context, payload) {
  let bundle;
  try { bundle = JSON.parse(payload.bundle); } catch { throw sessionError("invalid_bundle"); }
  const origins = Array.isArray(bundle.origins) ? bundle.origins.filter((item) => item?.origin === TELEGRAM_ORIGIN).map((target) => ({
    origin: TELEGRAM_ORIGIN,
    localStorage: (Array.isArray(target.localStorage) ? target.localStorage : []).filter((entry) => typeof entry?.name === "string" && typeof entry.value === "string"),
    indexedDB: filterTelegramIndexedDB(target.indexedDB),
  })).filter((target) => target.localStorage.length || target.indexedDB.length) : [];
  const cookies = Array.isArray(bundle.cookies) ? bundle.cookies : [];
  if (!cookies.length && !origins.length && !(payload.urls || []).length) return null;
  const storageSource = origins.some((target) => target.indexedDB.length)
    ? await sessionStep("origin_storage", storageScriptSource)
    : undefined;
  for (const target of origins) {
    await sessionStep("origin_storage", async () => {
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
      if (new URL(page.url()).origin !== TELEGRAM_ORIGIN) throw new Error("wrong restore origin");
      await page.evaluate(async ({ entries, databases, source }) => {
        if (databases.length) {
          const module = { exports: {} };
          Function("module", "exports", source)(module, module.exports);
          const script = new module.exports.StorageScript(false);
          for (const database of databases) {
            await new Promise((resolve, reject) => {
              const request = globalThis.indexedDB.deleteDatabase(database.name);
              request.onsuccess = resolve;
              request.onerror = () => reject(request.error || new Error("delete failed"));
              request.onblocked = () => reject(new Error("delete blocked"));
            });
            await script._restoreDB(database);
          }
        }
        const backup = Object.keys(localStorage).map((name) => ({ name, value: localStorage.getItem(name) }));
        try {
          localStorage.clear();
          for (const entry of entries) localStorage.setItem(entry.name, entry.value);
          for (const entry of entries) if (localStorage.getItem(entry.name) !== entry.value) throw new Error("localStorage verification failed");
        } catch (error) {
          try { localStorage.clear(); for (const entry of backup) localStorage.setItem(entry.name, entry.value); } catch {}
          throw error;
        }
      }, { entries: target.localStorage, databases: target.indexedDB, source: storageSource });
      } finally {
        await context.unroute(restoreUrl, handler).catch(() => {});
        await page.close();
      }
    });
  }
  await sessionStep("cookie_clear", () => context.clearCookies());
  const inject = cookies.filter((cookie) => !LINKEDIN_DEVICE_COOKIES.has(cookie.name));
  if (inject.length) await sessionStep("cookie_add", () => context.addCookies(inject));
  await sessionStep("navigation", async () => {
    for (let i = 0; i < (payload.urls || []).length; i++) {
      const page = i === 0 ? context.pages()[0] || await context.newPage() : await context.newPage();
      await page.goto(payload.urls[i], { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
  });
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
      for (let i = 0; i < 30; i++) { await wait(100); save = deep(dialog, "#actionButton")[0]; if (save && !save.disabled && !save.hasAttribute("disabled")) break; }
      if (!save || save.disabled || save.hasAttribute("disabled")) throw new Error("settings rejected");
      save.click();
      let duck;
      for (let i = 0; i < 20 && !duck; i++) { await wait(100); duck = (await engines()).find((engine) => identity(engine).includes("duckduckgo")); }
      if (!duck) throw new Error("not saved");
      const usesModelIndex = typeof duck.modelIndex === "number";
      const ref = usesModelIndex ? duck.modelIndex : duck.id;
      if (duck.canBeActivated) { globalThis.chrome.send("setIsActiveSearchEngine", [ref, true]); await wait(100); }
      if (!duck.canBeDefault) throw new Error("default unavailable");
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
  return withBrowser(chromium, endpoint, timeout, operation, async (browser, context) => {
    if (operation === "session-capture") return captureSession(browser);
    if (operation === "session-restore") return restoreSession(browser, context, payload);
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
  try { runtime = await import(pathToFileURL(join(ROOT, "node_modules", "playwright-core", "index.mjs")).href); } catch { throw typed("runtime_unavailable"); }
  const result = await operate(runtime.chromium || runtime.default?.chromium, request.operation, request.payload);
  response = { version: VERSION, ok: true, result };
} catch (error) {
  exitCode = 1;
  const code = error?.code && ERROR_MESSAGES[error.code] ? error.code : "operation_failed";
  response = { version: VERSION, ok: false, error: { code, message: ERROR_MESSAGES[code], ...(error?.details ? { details: error.details } : {}) } };
}
const output = JSON.stringify(response);
if (Buffer.byteLength(output) > MAX_BYTES) {
  process.stdout.write(JSON.stringify({ version: VERSION, ok: false, error: { code: "operation_failed", message: ERROR_MESSAGES.operation_failed } }));
  process.exitCode = 1;
} else {
  process.stdout.write(output);
  process.exitCode = exitCode;
}
