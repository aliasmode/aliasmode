import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VERSION = 1;
export const MAX_BYTES = 16 * 1024 * 1024;
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const ERROR_MESSAGES = {
  invalid_request: "Playwright worker request is invalid",
  operation_failed: "Playwright operation failed",
  timeout: "Playwright operation timed out",
  runtime_unavailable: "Playwright runtime is unavailable",
};
// Playwright emulates focus in every tab it attaches to, so the user's open tabs would read
// document.hasFocus() as true and get focus and blur events each time a helper connects.
// The patched Playwright leaves focus alone while this is false.
globalThis[Symbol.for("aliasmode.playwrightFocusEmulation")] = false;

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

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sessionError(operation, outcome = "failed") {
  return typed(outcome === "timeout" ? "timeout" : "operation_failed", { operation, outcome });
}

async function sessionStep(operation, run) {
  try { return await run(); }
  catch (error) { if (error?.details) throw error; throw sessionError(operation); }
}

// The 240 s worker limit leaves room for the connect (30 s), the origin reads and the cookies.
const ORIGIN_READ_TIMEOUT_MS = 20_000;
const ORIGINS_BUDGET_MS = 120_000;

/** Settle with `promise`, or reject after `timeoutMs` and call `onTimeout`; the late promise is ignored. */
async function within(promise, timeoutMs, onTimeout) {
  promise.catch(() => {});
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => { onTimeout(); reject(new Error("timed out")); }, Math.max(1, timeoutMs));
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
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
  const sessionOperation = operation === "session-restore" || operation === "session-capture";
  let browser;
  let context;
  let waitingFor = "connect";
  while (!context) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw sessionOperation
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
      if (!detached) throw sessionOperation
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
  if (!detached) throw sessionOperation
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
const TELEGRAM_ORIGIN = "https://web.telegram.org";
const UNGOOGLED_FIRST_RUN_URL = "chrome://ungoogled-first-run/";
const INTERNAL_NEW_TAB_URLS = new Set([
  "chrome://newtab/",
  "chrome://new-tab-page/",
  "chrome://new-tab-page-third-party/",
]);
const TELEGRAM_AUTH_INDEXEDDB_RULES = [
  { databaseName: "tt-passcode", stores: ["store"], presence: [{ stores: ["store"], allKeys: ["sessionEncrypted", "globalEncrypted"] }] },
  { databaseName: "tweb-common", stores: ["session", "localStorage__encrypted"], presence: [{ stores: ["localStorage__encrypted"], allKeys: ["data"] }] },
  { databasePattern: "^tweb(?:-account-\\d+)?$", stores: ["session", "session__encrypted"], presence: [{ stores: ["session", "session__encrypted"], anyKeyPattern: "^dc[1-5]_auth_key$", caseInsensitive: true }] },
];

function canonicalWebOrigin(value) {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === value
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

// AliasMode Chromium 155 exits when a document from a route loads on a Chrome Web Store origin, as
// the storage reads and restores below do. The Web Store keeps no login, so its storage is skipped.
const WEB_STORE_ORIGINS = new Set(["https://chromewebstore.google.com", "https://chrome.google.com"]);

function canonicalUserPageUrl(value) {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (parsed.searchParams.has("__aliasmode_session_capture__")
      || parsed.searchParams.has("__aliasmode_fingerprint__")
      || parsed.searchParams.has("__aliasmode_session_restore__")) return undefined;
    if (parsed.hostname === "127.0.0.1"
      && parsed.pathname === "/card"
      && parsed.searchParams.has("id")) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function normalizeWebOriginStorage(origin, storage) {
  if (!canonicalWebOrigin(origin) || !Array.isArray(storage?.localStorage)) return undefined;
  const localStorage = storage.localStorage
    .filter((entry) => typeof entry?.name === "string" && typeof entry.value === "string")
    .map((entry) => ({ name: entry.name, value: entry.value }));
  if (storage.localStorage.length && !localStorage.length) return undefined;
  const indexedDB = origin === TELEGRAM_ORIGIN ? filterTelegramIndexedDB(storage?.indexedDB) : [];
  return { origin, localStorage, ...(indexedDB.length ? { indexedDB } : {}) };
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

/** passcodeDatabasePresent for records already read over CDP. */
function indexedDBHasTelegramAuth(databases) {
  return databases.some((database) => (telegramRule(database.name)?.presence ?? []).some((presence) => presence.stores.some((storeName) => {
    const keys = (database.stores.find((store) => store.name === storeName)?.records ?? [])
      .filter((record) => record.valueEncoded !== undefined || (record.value !== undefined && record.value !== null))
      .map((record) => String(record.key));
    if (presence.allKeys?.every((key) => keys.includes(key))) return true;
    const matcher = presence.anyKeyPattern && new RegExp(presence.anyKeyPattern, presence.caseInsensitive ? "i" : "");
    return !!matcher && keys.some((key) => matcher.test(key));
  })));
}

async function passcodeDatabasePresent(page) {
  return page.evaluate(async (rules) => {
    if (globalThis.location.origin !== "https://web.telegram.org") throw new Error("Wrong capture origin");
    const ruleFor = (name) => rules.find((rule) => rule.databaseName ? name === rule.databaseName : rule.databasePattern && new RegExp(rule.databasePattern).test(name));
    const resultOf = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
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
async function collectPasscodeStorage(page, isFirefox = false) {
  const source = await storageScriptSource();
  return page.evaluate(async ({ rules, source, isFirefox }) => {
    if (globalThis.location.origin !== "https://web.telegram.org") throw new Error("Wrong capture origin");
    const module = { exports: {} };
    Function("module", "exports", source)(module, module.exports);
    const script = new (module.exports.StorageScript())(isFirefox);
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
  }, { rules: TELEGRAM_AUTH_INDEXEDDB_RULES, source, isFirefox });
}

function validOptionalKeyPath(value) {
  return (value.keyPath === undefined || typeof value.keyPath === "string")
    && (value.keyPathArray === undefined
      || (Array.isArray(value.keyPathArray) && value.keyPathArray.every((part) => typeof part === "string")));
}

function validCapturedTelegramIndexedDB(raw) {
  if (!Array.isArray(raw) || !raw.length) return false;
  return raw.every((database) => {
    if (!database || typeof database !== "object" || Array.isArray(database)
      || typeof database.name !== "string" || !Number.isInteger(database.version) || database.version <= 0
      || !Array.isArray(database.stores) || !database.stores.length) return false;
    const rule = telegramRule(database.name);
    if (!rule) return false;
    const allowedStores = new Set(rule.stores);
    return database.stores.every((store) => {
      if (!store || typeof store !== "object" || Array.isArray(store)
        || typeof store.name !== "string" || !allowedStores.has(store.name)
        || typeof store.autoIncrement !== "boolean" || !Array.isArray(store.records)
        || !store.records.every((record) => record && typeof record === "object" && !Array.isArray(record))
        || !Array.isArray(store.indexes) || !validOptionalKeyPath(store)) return false;
      return store.indexes.every((index) => index && typeof index === "object" && !Array.isArray(index)
        && typeof index.name === "string" && typeof index.multiEntry === "boolean"
        && typeof index.unique === "boolean" && validOptionalKeyPath(index));
    });
  });
}

function capturedWebOriginStorage(origin, storage) {
  let canonical;
  try {
    const parsed = new URL(origin);
    canonical = (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === origin;
  } catch {
    canonical = false;
  }
  if (!canonical || !storage || typeof storage !== "object" || Array.isArray(storage)
    || !Array.isArray(storage.localStorage)
    || !storage.localStorage.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      && typeof entry.name === "string" && typeof entry.value === "string")) {
    throw new Error("Invalid captured origin storage");
  }
  if (storage.indexedDB !== undefined
    && (origin !== TELEGRAM_ORIGIN || !validCapturedTelegramIndexedDB(storage.indexedDB))) {
    throw new Error("Invalid captured origin storage");
  }
  return normalizeWebOriginStorage(origin, storage);
}

function readOwnLocalStorage(expectedOrigin) {
  const currentOrigin = globalThis.location.origin;
  if (currentOrigin !== expectedOrigin) return { origin: currentOrigin };
  return {
    origin: currentOrigin,
    localStorage: Object.keys(globalThis.localStorage).map((name) => ({ name, value: globalThis.localStorage.getItem(name) })),
  };
}

// A Chromium page reads its storage in an isolated world, so the site's own scripts never see
// automation code run in their page, as they would with page.evaluate during every checkpoint.
async function readLiveLocalStorage(context, page, origin, isFirefox) {
  if (!isFirefox && typeof context.newCDPSession === "function") {
    let cdp;
    try {
      cdp = await context.newCDPSession(page);
      const { frameTree } = await cdp.send("Page.getFrameTree");
      const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "aliasmode-session-capture",
      });
      const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
        expression: `(${readOwnLocalStorage})(${JSON.stringify(origin)})`,
        contextId: executionContextId,
        returnByValue: true,
      });
      if (!exceptionDetails && result?.value) return result.value;
    } catch {
    } finally {
      await cdp?.detach().catch(() => {});
    }
  }
  return page.evaluate(readOwnLocalStorage, origin);
}

async function captureLiveOrigin(context, origin, isFirefox = false) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const page = context.pages().find((candidate) => {
      try {
        const url = new URL(candidate.url());
        return canonicalWebOrigin(url.origin) === origin
          && !url.searchParams.has("__aliasmode_session_capture__");
      } catch {
        return false;
      }
    });
    if (!page) return null;
    try {
      const live = await readLiveLocalStorage(context, page, origin, isFirefox);
      if (live?.origin !== origin) continue;
      let storage = { localStorage: live.localStorage };
      if (origin === TELEGRAM_ORIGIN) {
        let capturePasscode = !localStorageHasTelegramAuth(storage.localStorage);
        if (!capturePasscode) capturePasscode = await passcodeDatabasePresent(page);
        if (capturePasscode) storage = await collectPasscodeStorage(page, isFirefox);
      }
      return storage;
    } catch {}
  }
  return null;
}

function serializeIndexedDBValue(value) {
  const typedArrays = new Map([
    ["Int8Array", "i8"], ["Uint8Array", "ui8"], ["Uint8ClampedArray", "ui8c"],
    ["Int16Array", "i16"], ["Uint16Array", "ui16"], ["Int32Array", "i32"],
    ["Uint32Array", "ui32"], ["Float32Array", "f32"], ["Float64Array", "f64"],
    ["BigInt64Array", "bi64"], ["BigUint64Array", "bui64"],
  ]);
  const seenForTrivial = new Set();
  const isTrivial = (candidate) => {
    if (candidate === null || ["string", "number", "boolean"].includes(typeof candidate)) return true;
    if (!candidate || typeof candidate !== "object" || seenForTrivial.has(candidate)) return false;
    const proto = Object.getPrototypeOf(candidate);
    if (!Array.isArray(candidate) && proto !== Object.prototype && proto !== null) return false;
    seenForTrivial.add(candidate);
    const result = (Array.isArray(candidate) ? candidate : Object.values(candidate)).every(isTrivial);
    seenForTrivial.delete(candidate);
    return result;
  };
  if (value !== null && isTrivial(value)) return { trivial: value };

  const visited = new Map();
  let lastId = 0;
  const encode = (candidate) => {
    if (candidate === undefined || typeof candidate === "symbol" || typeof candidate === "function") return { v: "undefined" };
    if (candidate === null) return { v: "null" };
    if (Number.isNaN(candidate)) return { v: "NaN" };
    if (candidate === Infinity) return { v: "Infinity" };
    if (candidate === -Infinity) return { v: "-Infinity" };
    if (Object.is(candidate, -0)) return { v: "-0" };
    if (["string", "number", "boolean"].includes(typeof candidate)) return candidate;
    if (typeof candidate === "bigint") return { bi: candidate.toString() };
    if (candidate instanceof Date) return { d: candidate.toJSON() };
    if (candidate instanceof URL) return { u: candidate.toJSON() };
    if (candidate instanceof RegExp) return { r: { p: candidate.source, f: candidate.flags } };
    if (candidate instanceof Error) return { e: { n: candidate.name, m: candidate.message, s: candidate.stack ?? "" } };
    const typed = typedArrays.get(candidate?.constructor?.name);
    if (typed) {
      const bytes = new Uint8Array(candidate.buffer, candidate.byteOffset, candidate.byteLength);
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return { ta: { b: btoa(binary), k: typed } };
    }
    const prior = visited.get(candidate);
    if (prior) return { ref: prior };
    const id = ++lastId;
    visited.set(candidate, id);
    if (Array.isArray(candidate)) return { a: candidate.map(encode), id };
    return { o: Object.keys(candidate).filter((key) => key !== "__proto__").map((key) => ({ k: key, v: encode(candidate[key]) })), id };
  };
  return { encoded: encode(value) };
}

async function serializedRemoteValue(cdp, remote) {
  if (remote?.objectId) {
    const response = await cdp.send("Runtime.callFunctionOn", {
      objectId: remote.objectId,
      functionDeclaration: `function() { return (${serializeIndexedDBValue.toString()})(this); }`,
      returnByValue: true,
    });
    if (response.exceptionDetails || !response.result || !("value" in response.result)) {
      throw new Error("Unable to serialize IndexedDB value");
    }
    return response.result.value;
  }
  if (remote && "value" in remote) return serializeIndexedDBValue(remote.value);
  if (remote?.type === "undefined") return { encoded: { v: "undefined" } };
  const value = remote?.unserializableValue;
  if (value === "NaN" || value === "Infinity" || value === "-Infinity" || value === "-0") return { encoded: { v: value } };
  if (remote?.type === "bigint" && typeof value === "string" && value.endsWith("n")) return { encoded: { bi: value.slice(0, -1) } };
  throw new Error("Unable to serialize IndexedDB value");
}

function keyPathFields(keyPath) {
  if (typeof keyPath === "string") return { keyPath };
  if (Array.isArray(keyPath)) return { keyPathArray: keyPath };
  if (keyPath?.type === "string") return { keyPath: keyPath.string };
  if (keyPath?.type === "array") return { keyPathArray: keyPath.array };
  return {};
}

async function collectTelegramIndexedDB(cdp, origin) {
  await cdp.send("IndexedDB.enable");
  const names = await cdp.send("IndexedDB.requestDatabaseNames", { securityOrigin: origin });
  const databases = [];
  for (const name of [...(names.databaseNames ?? [])].sort()) {
    const rule = telegramRule(name);
    if (!rule) continue;
    const response = await cdp.send("IndexedDB.requestDatabase", { securityOrigin: origin, databaseName: name });
    const metadata = response.databaseWithObjectStores;
    if (!metadata || !Number.isInteger(metadata.version) || metadata.version <= 0) continue;
    const stores = [];
    for (const store of metadata.objectStores ?? []) {
      if (!rule.stores.includes(store.name)) continue;
      const records = [];
      let skipCount = 0;
      for (;;) {
        const data = await cdp.send("IndexedDB.requestData", {
          securityOrigin: origin,
          databaseName: name,
          objectStoreName: store.name,
          skipCount,
          pageSize: 1_000,
        });
        for (const entry of data.objectStoreDataEntries ?? []) {
          const record = {};
          if (store.keyPath?.type === "null" || store.keyPath == null) {
            const key = await serializedRemoteValue(cdp, entry.primaryKey ?? entry.key);
            if ("trivial" in key) record.key = key.trivial;
            else record.keyEncoded = key.encoded;
          }
          const value = await serializedRemoteValue(cdp, entry.value);
          if ("trivial" in value) record.value = value.trivial;
          else record.valueEncoded = value.encoded;
          records.push(record);
        }
        if (!data.hasMore) break;
        const count = data.objectStoreDataEntries?.length ?? 0;
        if (!count) throw new Error("IndexedDB pagination made no progress");
        skipCount += count;
      }
      stores.push({
        name: store.name,
        records,
        indexes: (store.indexes ?? []).map((index) => ({
          name: index.name,
          ...keyPathFields(index.keyPath),
          multiEntry: index.multiEntry,
          unique: index.unique,
        })),
        autoIncrement: store.autoIncrement,
        ...keyPathFields(store.keyPath),
      });
    }
    if (stores.length) databases.push({ name, version: metadata.version, stores });
  }
  return databases;
}

async function createHiddenPage(browser, context, marker) {
  if (typeof context.newCDPSession !== "function" || typeof browser.newBrowserCDPSession !== "function") {
    throw new Error("hidden page target is unavailable");
  }

  const browserCdp = await browser.newBrowserCDPSession();
  let targetId;
  let page;
  let cdp;
  const close = async () => {
    await cdp?.detach().catch(() => {});
    await page?.close().catch(() => {});
    if (targetId) await browserCdp.send("Target.closeTarget", { targetId }).catch(() => {});
    await browserCdp.detach().catch(() => {});
  };

  try {
    const version = await browserCdp.send("Browser.getVersion");
    const product = typeof version?.product === "string"
      ? /^[^/\s]+\/([1-9]\d*)(?:\.|$)/.exec(version.product)
      : null;
    const productMajor = product ? Number(product[1]) : NaN;
    if (!Number.isSafeInteger(productMajor)) throw sessionError("hidden_target");
    if (productMajor < 137) throw sessionError("hidden_target_unsupported");

    const existing = new Set(context.pages());
    const previousAttachToOther = process.env.PW_CHROMIUM_ATTACH_TO_OTHER;
    process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";
    try {
      ({ targetId } = await browserCdp.send("Target.createTarget", {
        url: marker,
        background: true,
        hidden: true,
      }));
      if (typeof targetId !== "string" || !targetId) throw new Error("hidden storage target identity is invalid");
      const target = (await browserCdp.send("Target.getTargetInfo", { targetId }))?.targetInfo;
      if (target?.targetId !== targetId || target.type !== "other" || target.url !== marker) {
        throw new Error("hidden storage target identity is invalid");
      }
      let windowless = false;
      try {
        await browserCdp.send("Browser.getWindowForTarget", { targetId });
      } catch (error) {
        windowless = [
          "Protocol error (Browser.getWindowForTarget): Browser window not found",
          "cdpSession.send: Protocol error (Browser.getWindowForTarget): Browser window not found",
        ].includes(error?.message);
        if (!windowless) throw error;
      }
      if (!windowless) throw new Error("hidden storage target is attached to a browser window");
      const rejected = new Set();
      for (let attempt = 0; attempt < 100 && !page; attempt++) {
        const candidates = context.pages().filter((candidate) =>
          !existing.has(candidate) && !rejected.has(candidate) && candidate.url() === marker);
        for (const candidate of candidates) {
          let candidateCdp;
          let identified = false;
          try {
            candidateCdp = await context.newCDPSession(candidate);
            const attached = (await candidateCdp.send("Target.getTargetInfo"))?.targetInfo;
            identified = true;
            if (attached?.targetId === targetId && attached.type === "other") {
              page = candidate;
              cdp = candidateCdp;
              break;
            }
          } catch {}
          if (identified) rejected.add(candidate);
          await candidateCdp?.detach().catch(() => {});
        }
        if (!page) await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      if (previousAttachToOther === undefined) delete process.env.PW_CHROMIUM_ATTACH_TO_OTHER;
      else process.env.PW_CHROMIUM_ATTACH_TO_OTHER = previousAttachToOther;
    }
    if (!page || !cdp) throw new Error("hidden page target is unavailable");
  } catch (error) {
    await close();
    throw error;
  }

  return { page, cdp, close };
}

async function createReadOnlyStorageReader(browser, context) {
  const { page, cdp, close } = await createHiddenPage(
    browser,
    context,
    "about:blank#__aliasmode_hidden_capture__",
  );
  try {
    await cdp.send("Network.enable");
    await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    await cdp.send("DOMStorage.enable");
  } catch (error) {
    await close();
    throw error;
  }

  let ordinal = 0;
  return {
    async read(origin) {
      const url = `${origin}/?__aliasmode_session_capture__=${++ordinal}`;
      let intercepted = false;
      const handler = (route) => {
        intercepted = true;
        return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>capture</title>" });
      };
      await sessionStep("navigation", () => context.route(url, handler));
      try {
        await sessionStep("navigation", async () => {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
          if (!intercepted) throw new Error("Capture navigation was not intercepted");
          if (new URL(page.url()).origin !== origin) throw new Error("Wrong capture origin");
        });
        const response = await cdp.send("DOMStorage.getDOMStorageItems", {
          storageId: { securityOrigin: origin, isLocalStorage: true },
        });
        const localStorage = (response.entries ?? []).map(([name, value]) => ({ name, value }));
        const collected = origin === TELEGRAM_ORIGIN ? await collectTelegramIndexedDB(cdp, origin) : [];
        // As for a live Telegram page: a normal A/K login is in localStorage; only a passcode login needs IndexedDB.
        const indexedDB = localStorageHasTelegramAuth(localStorage) && !indexedDBHasTelegramAuth(collected) ? [] : collected;
        return { localStorage, ...(indexedDB.length ? { indexedDB } : {}) };
      } finally {
        await context.unroute(url, handler).catch(() => {});
      }
    },
    close,
  };
}

async function nativeOriginStorage(context, origin) {
  const native = context?._connection?.toImpl?.(context);
  const trackedOrigins = native?._origins;
  const savedOrigins = trackedOrigins instanceof Set ? [...trackedOrigins] : undefined;
  try {
    if (savedOrigins) {
      trackedOrigins.clear();
      trackedOrigins.add(origin);
    }
    const state = await context.storageState({ indexedDB: origin === TELEGRAM_ORIGIN });
    const found = state?.origins?.find((candidate) => candidate?.origin === origin);
    if (!found) {
      if (!savedOrigins) return undefined;
      return { localStorage: [] };
    }
    return {
      localStorage: Array.isArray(found.localStorage) ? found.localStorage : [],
      ...(origin === TELEGRAM_ORIGIN && Array.isArray(found.indexedDB)
        ? { indexedDB: filterTelegramIndexedDB(found.indexedDB) }
        : {}),
    };
  } finally {
    if (savedOrigins) {
      const observedDuringCapture = [...trackedOrigins];
      trackedOrigins.clear();
      for (const savedOrigin of savedOrigins) trackedOrigins.add(savedOrigin);
      for (const observedOrigin of observedDuringCapture) trackedOrigins.add(observedOrigin);
    }
  }
}

function hasOriginPage(context, origin) {
  return context.pages().some((page) => {
    try { return new URL(page.url()).origin === origin; } catch { return false; }
  });
}

function registerNativeOrigins(context, origins) {
  const native = context?._connection?.toImpl?.(context);
  if (typeof native?.addVisitedOrigin !== "function") return;
  for (const origin of origins) native.addVisitedOrigin(origin);
}

export async function captureSession(browser, payload, options = {}) {
  const context = contextOf(browser);
  const pages = context.pages();
  const shown = await shownPageUrls(context, pages, !!options.nativeStorage);
  // No window is not an intentional empty tab list (a live blank page is). A browser can outlive
  // its last window: Firefox and Chromium both do on macOS.
  const tabs = pages.length === 0
    ? undefined
    : pages.map((page) => canonicalUserPageUrl(shown.get(page))).filter(Boolean);
  const seed = payload.captureSeed;
  if (seed !== undefined && (!seed || typeof seed !== "object" || Array.isArray(seed)
    || !Array.isArray(seed.origins)
    || seed.origins.some((origin) => typeof origin !== "string" || canonicalWebOrigin(origin) !== origin)
    || (seed.telegramClient !== undefined && seed.telegramClient !== "a" && seed.telegramClient !== "k"))) {
    throw sessionError("validation");
  }

  const origins = new Set(seed?.origins ?? []);
  let telegramClient = seed?.telegramClient;
  for (const page of pages) {
    try {
      const pageUrl = canonicalUserPageUrl(shown.get(page));
      if (!pageUrl) continue;
      const url = new URL(pageUrl);
      const origin = canonicalWebOrigin(url.origin);
      if (!origin) continue;
      origins.add(origin);
      if (origin === TELEGRAM_ORIGIN) {
        if (url.pathname === "/a" || url.pathname.startsWith("/a/")) telegramClient = "a";
        if (url.pathname === "/k" || url.pathname.startsWith("/k/")) telegramClient = "k";
      }
    } catch {}
  }

  if (options.nativeStorage) registerNativeOrigins(context, origins);
  // One hidden page reads every closed origin. A failed start fails each later read at once.
  let reader;
  const readOrigin = async (origin) => {
    const live = await captureLiveOrigin(context, origin, !!options.nativeStorage);
    // Without a live tab, an open-tab capture leaves the origin to the caller's saved copy.
    if (live || seed?.openTabsOnly) return live;
    if (!options.nativeStorage) {
      reader ??= createReadOnlyStorageReader(browser, context);
      return (await reader).read(origin);
    }
    // Closed-origin storage cannot change until that origin loads again, which clears its cache entry.
    let storage = options.storageCache?.get(origin);
    if (storage) return storage;
    storage = await nativeOriginStorage(context, origin);
    if (!storage) throw sessionError("origin_storage");
    if (!hasOriginPage(context, origin)) options.storageCache?.set(origin, storage);
    return storage;
  };
  try {
    const byOrigin = new Map();
    const unreadable = [];
    const deadline = Date.now() + ORIGINS_BUDGET_MS;
    const readTimeoutMs = options.originReadTimeoutMs ?? ORIGIN_READ_TIMEOUT_MS;
    let stalled = false;
    for (const origin of [...origins].sort()) {
      if (WEB_STORE_ORIGINS.has(origin)) continue;
      // A site that the browser refuses to open as a page (for example one that an extension
      // blocks), a storage or IndexedDB read that throws, or a tab that hangs must not stop the
      // capture: the caller keeps the storage that it saved for this origin before, and the cookies
      // below are still read. After a hang no further read starts, so two reads never overlap.
      let storage;
      try {
        if (stalled || Date.now() >= deadline) throw new Error("origin reads are out of time");
        storage = await within(readOrigin(origin), Math.min(readTimeoutMs, deadline - Date.now()), () => { stalled = true; });
        if (storage) storage = capturedWebOriginStorage(origin, storage);
      } catch {
        unreadable.push(origin);
        continue;
      }
      if (storage) byOrigin.set(origin, storage);
    }

    const cookies = await sessionStep("cookies", async () => typeof context.cookies === "function"
      ? await context.cookies()
      : (await context.storageState()).cookies);
    if (!Array.isArray(cookies) || cookies.some((cookie) =>
      typeof cookie?.name !== "string" || typeof cookie.value !== "string" ||
      typeof cookie.domain !== "string" || typeof cookie.path !== "string" ||
      (cookie.expires !== undefined && (typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires))) ||
      (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== "boolean") ||
      (cookie.secure !== undefined && typeof cookie.secure !== "boolean") ||
      (cookie.partitionKey !== undefined && typeof cookie.partitionKey !== "string") ||
      (cookie._crHasCrossSiteAncestor !== undefined && typeof cookie._crHasCrossSiteAncestor !== "boolean") ||
      (cookie.sameSite !== undefined && !["Strict", "Lax", "None"].includes(cookie.sameSite))
    )) throw sessionError("validation");
    return JSON.stringify({
      cookies,
      origins: [...byOrigin.values()],
      tabs,
      ...(telegramClient ? { telegramClient } : {}),
      ...(unreadable.length ? { unreadableOrigins: unreadable } : {}),
    });
  } finally {
    if (reader) await closeWithin(() => reader.then((opened) => opened.close(), () => {}));
  }
}

// Loads a document in a page with no new entry in the Back history of its window.
async function replaceDocument(page, target, timeout) {
  await Promise.all([
    page.waitForURL(target, { waitUntil: "domcontentloaded", timeout }),
    page.evaluate((next) => { globalThis.location.replace(next); }, target).catch(() => {}),
  ]);
}

function isInternalNewTabUrl(url) {
  return INTERNAL_NEW_TAB_URLS.has(url) || url === "about:newtab" || url === "about:home";
}

// Chromium shows the search engine's own new tab page (https://duckduckgo.com/chrome_newtab) as
// chrome://newtab/, but Playwright reports the web address, so that page counted as a site tab.
// The CDP target keeps the address that the tab shows. Firefox has no CDP.
async function shownPageUrl(context, page, isFirefox) {
  let url = "";
  let cdp;
  try {
    url = page.url();
    if (isFirefox || !/^https:/.test(url)) return url;
    cdp = await context.newCDPSession(page);
    const shown = (await cdp.send("Target.getTargetInfo"))?.targetInfo?.url;
    return isInternalNewTabUrl(shown) ? shown : url;
  } catch {
    return url;
  } finally {
    await cdp?.detach().catch(() => {});
  }
}

async function shownPageUrls(context, pages, isFirefox) {
  return new Map(await Promise.all(pages.map(async (page) => [page, await shownPageUrl(context, page, isFirefox)])));
}

// In Firefox a new page from Playwright is a new window. A page can open a tab in its own window,
// and "noopener" leaves that tab with no link to the page.
async function openTabBeside(context, page) {
  const opened = context.waitForEvent("page", { timeout: 5_000 });
  try {
    await page.evaluate(() => { globalThis.open("about:blank", "_blank", "noopener"); });
    return await opened;
  } catch {
    opened.catch(() => {});
    return undefined;
  }
}

async function navigatePages(context, urls, replacePages = false, tabsInOneWindow = false) {
  const targets = (Array.isArray(urls) ? urls : []).map(canonicalUserPageUrl).filter(Boolean);
  const existing = [...context.pages()];
  // Only Firefox opens the tabs in one window.
  const shown = await shownPageUrls(context, existing, tabsInOneWindow);
  const urlOf = (page) => shown.get(page) ?? "";
  const existingUserPage = existing.some((page) => canonicalUserPageUrl(urlOf(page)) !== undefined);
  let blank = existing.find((page) => urlOf(page) === "about:blank")
    || existing.find((page) => isInternalNewTabUrl(urlOf(page)))
    || existing.find((page) => urlOf(page) === UNGOOGLED_FIRST_RUN_URL);
  if (!replacePages && existingUserPage) blank = undefined;
  let firstError;

  if (replacePages) {
    if (!blank) blank = await context.newPage();
    for (const page of existing) {
      const url = urlOf(page);
      const disposable = canonicalUserPageUrl(url) !== undefined
        || (url === UNGOOGLED_FIRST_RUN_URL && page !== blank)
        || (isInternalNewTabUrl(url) && page !== blank)
        || (url === "about:blank" && page !== blank);
      if (!disposable) continue;
      try { await page.close(); } catch (error) { firstError ??= error; }
    }
  } else {
    for (const page of existing) {
      if (urlOf(page) !== UNGOOGLED_FIRST_RUN_URL) continue;
      if (page === blank && !existingUserPage) {
        if (targets.length > 0) continue;
        try {
          await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 });
        } catch (error) {
          firstError ??= error;
        }
        continue;
      }
      try { await page.close(); } catch (error) { firstError ??= error; }
    }
  }

  // The tabs open in the window of the empty page, before that page gets its own address. Each
  // tab opens from the tab before it, because Firefox puts a new tab directly after its opener.
  // With no empty page, the first tab opens beside an open user page and the open pages stay.
  const tabs = [];
  if (tabsInOneWindow) {
    let opener = blank ?? existing.findLast((page) => canonicalUserPageUrl(urlOf(page)) !== undefined);
    for (let index = blank ? 1 : 0; opener && index < targets.length; index++) {
      tabs[index] = await openTabBeside(context, opener);
      opener = tabs[index] ?? opener;
    }
  }
  const pages = [];
  for (let index = 0; index < targets.length; index++) {
    try {
      pages[index] = index === 0 && blank ? blank : tabs[index] ?? await context.newPage();
    } catch (error) {
      firstError ??= error;
    }
  }
  // The tabs exist in their order; they load at the same time, so an open waits for its slowest
  // page through the proxy, not for the sum of all pages.
  const loads = pages.map(async (page, index) => {
    try {
      await page.goto(targets[index], { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (error) {
      return error;
    }
  });
  for (const error of await Promise.all(loads)) if (error) firstError ??= error;
  if (tabs.some(Boolean)) await (blank ?? pages[0])?.bringToFront?.().catch(() => {});
  if (firstError) throw firstError;
}

export async function restoreSession(browser, context, payload, options = {}) {
  let bundle;
  try { bundle = JSON.parse(payload.bundle); } catch { throw sessionError("invalid_bundle"); }
  const origins = Array.isArray(bundle.origins)
    ? bundle.origins.map((target) => normalizeWebOriginStorage(target?.origin, target))
      .filter((target) => target && !WEB_STORE_ORIGINS.has(target.origin))
    : [];
  const cookies = Array.isArray(bundle.cookies) ? bundle.cookies : [];
  if (!cookies.length && !origins.length && !(payload.urls || []).length && !payload.replacePages && !payload.authoritative) return null;
  const storageSource = origins.some((target) => target.indexedDB?.length)
    ? await sessionStep("origin_storage", storageScriptSource)
    : undefined;
  // In Firefox a new page is a new window. One page then serves all origins: the empty first
  // window when there is one.
  let shared;
  let sharedIsFirstWindow = false;
  try {
  for (const target of origins) {
    await sessionStep("origin_storage", async () => {
      const existing = context.pages();
      for (const page of existing) {
        if (page === shared) continue;
        try {
          if (new URL(page.url()).origin !== target.origin) continue;
          if (isInternalNewTabUrl(await shownPageUrl(context, page, !!options.nativeStorage))) continue;
          await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 });
        } catch {}
      }
      if (options.nativeStorage && !shared) {
        const empty = context.pages().find((candidate) => {
          try { return candidate.url() === "about:blank"; } catch { return false; }
        });
        shared = empty ?? await context.newPage();
        sharedIsFirstWindow = !!empty;
      }
      const page = shared ?? await context.newPage();
      const restoreUrl = `${target.origin}/?__aliasmode_session_restore__=${Date.now()}`;
      let intercepted = false;
      const handler = (route) => {
        intercepted = true;
        return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>restore</title>" });
      };
      const cdp = !options.nativeStorage && typeof context.newCDPSession === "function" ? await context.newCDPSession(page) : null;
      try {
        if (cdp) {
          await cdp.send("Network.enable");
          await cdp.send("Network.setBypassServiceWorker", { bypass: true });
        }
        await context.route(restoreUrl, handler);
        if (shared) await replaceDocument(page, restoreUrl, 10_000);
        else await page.goto(restoreUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
        if (!intercepted) throw new Error("Restore navigation was not intercepted");
        if (new URL(page.url()).origin !== target.origin) throw new Error("wrong restore origin");
      await page.evaluate(async ({ entries, databases, source, isFirefox, databaseRules }) => {
        const removeDatabase = (name) => new Promise((resolve, reject) => {
          const request = globalThis.indexedDB.deleteDatabase(name);
          request.onsuccess = resolve;
          request.onerror = () => reject(request.error || new Error("delete failed"));
          request.onblocked = () => reject(new Error("delete blocked"));
        });
        if (databaseRules.length) {
          const ruleFor = (name) => databaseRules.find((rule) => rule.databaseName
            ? name === rule.databaseName
            : rule.databasePattern && new RegExp(rule.databasePattern).test(name));
          for (const database of await globalThis.indexedDB.databases()) {
            if (database?.name && ruleFor(database.name)) await removeDatabase(database.name);
          }
        }
        if (databases.length) {
          const module = { exports: {} };
          Function("module", "exports", source)(module, module.exports);
          const script = new (module.exports.StorageScript())(isFirefox);
          for (const database of databases) await script._restoreDB(database);
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
        }, {
          entries: target.localStorage,
          databases: target.indexedDB ?? [],
          source: storageSource,
          isFirefox: !!options.nativeStorage,
          databaseRules: target.origin === TELEGRAM_ORIGIN ? TELEGRAM_AUTH_INDEXEDDB_RULES : [],
        });
      } finally {
        await context.unroute(restoreUrl, handler).catch(() => {});
        if (!shared) await page.close();
        if (cdp) await cdp.detach().catch(() => {});
      }
    });
  }
  } finally {
    if (shared && sharedIsFirstWindow) await replaceDocument(shared, "about:blank", 5_000).catch(() => {});
    else await shared?.close().catch(() => {});
  }
  await sessionStep("cookie_clear", () => context.clearCookies());
  if (cookies.length) await sessionStep("cookie_add", () => context.addCookies(cookies));
  await sessionStep("navigation", () => navigatePages(context, payload.urls, !!payload.replacePages, !!options.nativeStorage));
  return null;
}

async function searchProvider(chromium, payload) {
  if (
    typeof payload.executablePath !== "string"
    || !payload.executablePath
    || typeof payload.executableSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(payload.executableSha256)
    || typeof payload.userDataDir !== "string"
    || !payload.userDataDir
    || typeof payload.endpoint !== "string"
    || !/^https?:\/\/|^wss?:\/\//.test(payload.endpoint)
  ) throw typed("invalid_request");

  if (await sha256File(payload.executablePath) !== payload.executableSha256) {
    throw new Error("approved CloakBrowser binary changed before search setup");
  }
  const timeout = Math.max(1, Math.min(Number(payload.connectTimeoutMs) || 20_000, 120_000));
  return withBrowser(chromium, payload.endpoint, timeout, "search-provider", async (_browser, context) => {
    const page = await context.newPage();
    try {
      await page.goto("chrome://settings/searchEngines", { waitUntil: "domcontentloaded", timeout: 10_000 });
      return await page.evaluate(async () => {
      const cr = await import("chrome://resources/js/cr.js");
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const engines = async () => Object.values(
        await cr.sendWithPromise("getSearchEnginesList"),
      ).filter(Array.isArray).flat();
      const isDuckDuckGo = (engine) => {
        if (typeof engine.url !== "string") return false;
        try {
          const url = new URL(engine.url);
          return url.protocol === "https:"
            && (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com"));
        } catch {
          return false;
        }
      };
      const findDuckDuckGo = (items) => items.find(isDuckDuckGo);
      const initial = await engines();
      const current = initial.find((engine) => engine.default);
      if (current && isDuckDuckGo(current)) {
        return {
          status: "already-default",
          engine: current.displayName || current.name || current.keyword || "DuckDuckGo",
        };
      }

      const deep = (root, selector) => {
        const found = [];
        if (root.shadowRoot) found.push(...deep(root.shadowRoot, selector));
        found.push(...root.querySelectorAll(selector));
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) found.push(...deep(element.shadowRoot, selector));
        }
        return [...new Set(found)];
      };
      let duck = findDuckDuckGo(initial);
      if (!duck) {
        let add;
        for (let i = 0; i < 30 && !add; i++) {
          add = deep(document, "#addSearchEngine")[0];
          if (!add) await wait(100);
        }
        if (!add) throw new Error("Chromium search Add button was not available");
        add.click();

        let dialog;
        for (let i = 0; i < 20 && !dialog; i++) {
          await wait(100);
          dialog = deep(document, "settings-search-engine-edit-dialog")[0];
        }
        if (!dialog) throw new Error("Chromium search dialog did not open");
        for (const [id, value] of [
          ["searchEngine", "DuckDuckGo"],
          ["keyword", "duckduckgo.com"],
          ["queryUrl", "https://duckduckgo.com/?q=%s"],
        ]) {
          const input = deep(dialog, `cr-input#${id}`)[0]?.shadowRoot?.querySelector("input");
          if (!input) throw new Error(`Chromium search input ${id} was not available`);
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set.call(input, value);
          input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
          input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        }

        let save;
        for (let i = 0; i < 30; i++) {
          await wait(100);
          save = deep(dialog, "#actionButton")[0];
          if (save && !save.disabled && !save.hasAttribute("disabled")) break;
        }
        if (!save || save.disabled || save.hasAttribute("disabled")) {
          throw new Error("Chromium rejected DuckDuckGo settings");
        }
        save.click();
        for (let i = 0; i < 20 && !duck; i++) {
          await wait(100);
          duck = findDuckDuckGo(await engines());
        }
      }
      if (!duck) throw new Error("Chromium did not save DuckDuckGo");

      // Chrome 146 identifies an engine by `modelIndex`; Chromium 155 renamed it to `id`.
      const modelIndex = (engine) => {
        const index = Number.isInteger(engine.modelIndex) ? engine.modelIndex : engine.id;
        if (!Number.isInteger(index) || index < 0) {
          throw new Error("Chromium search engine model index was unavailable");
        }
        return index;
      };
      if (duck.canBeActivated) {
        globalThis.chrome.send("setIsActiveSearchEngine", [modelIndex(duck), true]);
        for (let i = 0; i < 20; i++) {
          await wait(100);
          duck = findDuckDuckGo(await engines()) || duck;
          if (duck.default || duck.canBeDefault || !duck.canBeActivated) break;
        }
      }
      if (duck.default) {
        return {
          status: "configured",
          engine: duck.displayName || duck.name || "DuckDuckGo",
        };
      }
      if (!duck.canBeDefault) throw new Error("Chromium will not allow DuckDuckGo as default");

      globalThis.chrome.send("setDefaultSearchEngine", [
        modelIndex(duck),
        1,
        null,
      ]);
      for (let i = 0; i < 20; i++) {
        await wait(100);
        const saved = findDuckDuckGo(await engines());
        if (saved?.default) {
          return {
            status: "configured",
            engine: saved.displayName || saved.name || "DuckDuckGo",
          };
        }
      }
      throw new Error("DuckDuckGo was not persisted as default");
      });
    } finally { await page.close().catch(() => {}); }
  });
}

export async function operatePersistentContext(browser, context, operation, payload, options = {}) {
  const timeout = Math.max(1, Math.min(Number(payload.connectTimeoutMs) || 30_000, 120_000));
  if (operation === "session-capture") {
    return captureSession(browser, payload, { nativeStorage: !!options.nativeStorage, storageCache: options.storageCache });
  }
  if (operation === "session-restore") return restoreSession(browser, context, payload, { nativeStorage: !!options.nativeStorage });
  if (operation === "cookie-add") {
    await context.addCookies(payload.cookies);
    return null;
  }
  if (operation === "cookie-harvest") return context.cookies(Array.isArray(payload.urls) && payload.urls.length ? payload.urls : SESSION_URLS);
  if (operation === "navigate") {
    await navigatePages(context, payload.urls, !!payload.replacePages, true);
    return null;
  }
  if (operation === "profile-card") {
    if (!payload.temporary && context.pages().some((page) => {
      try { return typeof page.url === "function" && page.url() === payload.url; } catch { return false; }
    })) return { createdPageTargetIds: [] };
    const page = await context.newPage();
    try { await page.goto(payload.url, { waitUntil: "domcontentloaded", timeout: 15_000 }); } catch {}
    if (payload.temporary) await page.close().catch(() => {});
    return { createdPageTargetIds: [] };
  }
  if (operation === "label-window") {
    await context.addInitScript({ content: payload.script }).catch(() => {});
    for (const page of context.pages()) await page.evaluate(payload.script).catch(() => {});
    return null;
  }
  if (operation === "ensure-cookies") {
    const key = (cookie) => JSON.stringify([
      cookie.name, cookie.domain.toLowerCase(), cookie.path || "/",
      cookie.partitionKey || "", cookie.partitionKey ? cookie._crHasCrossSiteAncestor ?? true : null,
    ]);
    const present = new Set((await context.cookies()).map(key));
    const missing = payload.cookies.filter((cookie) => !present.has(key(cookie)));
    if (missing.length) await context.addCookies(missing);
    return { injected: missing.length > 0 };
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
  if (operation === "page" && payload.kind === "fingerprint") {
    // In Firefox a new page is a new window, and the user sees it open and close at each launch.
    // The empty first window loads the probe document instead, and then becomes empty again.
    const empty = context.pages().find((candidate) => {
      try { return candidate.url() === "about:blank"; } catch { return false; }
    });
    const page = empty ?? await context.newPage();
    const url = "https://fingerprint.aliasmode.invalid/?__aliasmode_fingerprint__=1";
    let intercepted = false;
    const handler = async (route) => {
      if (route.request().url() !== url) return route.abort();
      intercepted = true;
      return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Fingerprint</title>" });
    };
    try {
      await page.route("**/*", handler);
      if (empty) await replaceDocument(page, url, timeout);
      else await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      if (!intercepted || page.url() !== url) throw new Error("fingerprint document was not fulfilled locally");
      return await page.evaluate(payload.fingerprintScript);
    } finally {
      if (empty) await replaceDocument(page, "about:blank", 5_000).catch(() => {});
      await page.unroute("**/*", handler).catch(() => {});
      if (!empty) await page.close().catch(() => {});
    }
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
}

/** A plain CDP connection. Unlike Playwright's connectOverCDP it attaches to no tab by itself. */
async function openCdp(endpoint, timeout) {
  const url = /^https?:/.test(endpoint)
    ? (await (await fetch(new URL("/json/version", endpoint), { signal: AbortSignal.timeout(timeout) })).json()).webSocketDebuggerUrl
    : endpoint;
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP connection timed out")), timeout);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error("CDP connection failed")); };
  });
  let lastId = 0;
  const calls = new Map();
  const listeners = new Set();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(String(data));
    const call = calls.get(message.id);
    if (!call) return void listeners.forEach((listener) => listener(message));
    calls.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message || "CDP call failed"));
    else call.resolve(message.result ?? {});
  };
  socket.onclose = () => { for (const call of calls.values()) call.reject(new Error("CDP connection closed")); calls.clear(); };
  const within = (promise, what) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), timeout); })])
      .finally(() => clearTimeout(timer));
  };
  return {
    send(method, params = {}, sessionId) {
      const id = ++lastId;
      const reply = new Promise((resolve, reject) => calls.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return within(reply, method);
    },
    on(method, sessionId, listener) {
      const filtered = (message) => { if (message.method === method && message.sessionId === sessionId) listener(message.params); };
      listeners.add(filtered);
      return () => listeners.delete(filtered);
    },
    once(method, sessionId) {
      let off;
      return within(new Promise((resolve) => { off = this.on(method, sessionId, resolve); }), method).finally(() => off());
    },
    close() { socket.close(); },
  };
}

const FINGERPRINT_URL = "https://fingerprint.aliasmode.invalid/?__aliasmode_fingerprint__=1";

/**
 * The launch-time fingerprint capture of a Chromium browser, in its own background tab. Playwright's
 * connectOverCDP would attach to every tab (Runtime.enable, Page.enable), and a tab that loads
 * meanwhile, such as one the browser restores at startup, then plays unmuted media and runs audio
 * without a click, as under automation. This connection attaches to the capture tab only.
 */
export async function chromiumFingerprint(endpoint, script, timeout) {
  const cdp = await openCdp(endpoint, timeout);
  let targetId;
  try {
    ({ targetId } = await cdp.send("Target.createTarget", { url: "about:blank", background: true }));
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = (method, params) => cdp.send(method, params, sessionId);
    let intercepted = false;
    cdp.on("Fetch.requestPaused", sessionId, ({ requestId, request }) => {
      if (request.url !== FINGERPRINT_URL) return void page("Fetch.failRequest", { requestId, errorReason: "Aborted" }).catch(() => {});
      intercepted = true;
      const body = Buffer.from("<!doctype html><title>Fingerprint</title>").toString("base64");
      void page("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html" }], body }).catch(() => {});
    });
    await page("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await page("Page.enable");
    const loaded = cdp.once("Page.domContentEventFired", sessionId);
    loaded.catch(() => {});
    if ((await page("Page.navigate", { url: FINGERPRINT_URL })).errorText) throw new Error("fingerprint navigation failed");
    await loaded;
    if (!intercepted) throw new Error("fingerprint document was not fulfilled locally");
    const { result, exceptionDetails } = await page("Runtime.evaluate", { expression: script, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error("fingerprint probe failed");
    return result?.value;
  } finally {
    if (targetId) await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    cdp.close();
  }
}

async function operate(chromium, operation, payload) {
  if (operation === "search-provider") return searchProvider(chromium, payload);
  const endpoint = payload.endpoint;
  if (typeof endpoint !== "string" || !/^https?:\/\/|^wss?:\/\//.test(endpoint)) throw typed("invalid_request");
  const timeout = Math.max(1, Math.min(Number(payload.connectTimeoutMs) || 30_000, 120_000));
  if (operation === "page" && payload.kind === "fingerprint") return chromiumFingerprint(endpoint, payload.fingerprintScript, timeout);
  return withBrowser(chromium, endpoint, timeout, operation, async (browser, context) => {
    if (operation === "session-capture") return captureSession(browser, payload);
    if (operation === "session-restore") return restoreSession(browser, context, payload);
    if (operation === "cookie-add") {
      await context.addCookies(payload.cookies);
      return null;
    }
    if (operation === "cookie-harvest") return context.cookies(Array.isArray(payload.urls) && payload.urls.length ? payload.urls : SESSION_URLS);
    if (operation === "navigate") {
      await navigatePages(context, payload.urls, !!payload.replacePages);
      return null;
    }
    if (operation === "profile-card") {
      if (!payload.temporary && context.pages().some((page) => {
        try { return typeof page.url === "function" && page.url() === payload.url; } catch { return false; }
      })) return { createdPageTargetIds: [] };
      if (typeof browser.newBrowserCDPSession !== "function") throw new Error("browser target observation is unavailable");
      const targetCdp = await browser.newBrowserCDPSession();
      const existingPageTargetIds = new Set();
      const createdPageTargetIds = new Set();
      const destroyedPageTargetIds = new Set();
      let armed = false;
      let temporaryPage;
      try {
        const initialTargets = await targetCdp.send("Target.getTargets");
        for (const target of initialTargets?.targetInfos || []) {
          if (target?.type === "page" && typeof target.targetId === "string") existingPageTargetIds.add(target.targetId);
        }
        targetCdp.on("Target.targetCreated", (event) => {
          const target = event?.targetInfo;
          if (armed && target?.type === "page" && typeof target.targetId === "string" && !existingPageTargetIds.has(target.targetId)) {
            createdPageTargetIds.add(target.targetId);
          }
        });
        if (payload.temporary) {
          targetCdp.on("Target.targetDestroyed", (event) => {
            if (armed && createdPageTargetIds.has(event?.targetId)) destroyedPageTargetIds.add(event.targetId);
          });
        }
        armed = true;
        await targetCdp.send("Target.setDiscoverTargets", { discover: true });

        const automation = context.pages()[0];
        if (payload.temporary) {
          temporaryPage = await context.newPage();
          await temporaryPage.goto(payload.url, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
          await temporaryPage.close();
          temporaryPage = undefined;
        } else {
          let canCreate = false;
          if (automation && typeof context.newCDPSession === "function") {
            const cdp = await context.newCDPSession(automation);
            try {
              const { bounds } = await cdp.send("Browser.getWindowForTarget");
              canCreate = bounds?.windowState !== "minimized";
            } catch {
              canCreate = false;
            } finally {
              await cdp.detach().catch(() => {});
            }
          }
          // The card opens as a background tab, so the user's tab stays in front without being
          // activated again, which would focus it.
          if (canCreate) {
            const page = await context.newPage();
            await page.goto(payload.url, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
          }
        }
        await targetCdp.send("Target.getTargets");
      } finally {
        if (temporaryPage) await temporaryPage.close().catch(() => {});
        armed = false;
        await targetCdp.send("Target.setDiscoverTargets", { discover: false }).catch(() => {});
        await targetCdp.detach().catch(() => {});
      }
      return {
        createdPageTargetIds: [...createdPageTargetIds].sort(),
        ...(payload.temporary ? { destroyedPageTargetIds: [...destroyedPageTargetIds].sort() } : {}),
      };
    }
    if (operation === "label-window") {
      await context.addInitScript({ content: payload.script }).catch(() => {});
      for (const page of context.pages()) await page.evaluate(payload.script).catch(() => {});
      return null;
    }
    if (operation === "ensure-cookies") {
      const key = (cookie) => JSON.stringify([
        cookie.name, cookie.domain.toLowerCase(), cookie.path || "/",
        cookie.partitionKey || "", cookie.partitionKey ? cookie._crHasCrossSiteAncestor ?? true : null,
      ]);
      const present = new Set((await context.cookies()).map(key));
      const missing = payload.cookies.filter((cookie) => !present.has(key(cookie)));
      if (missing.length) await context.addCookies(missing);
      return { injected: missing.length > 0 };
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

export async function runWorkerMain() {
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
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await runWorkerMain();
