import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
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
const TELEGRAM_ORIGIN = "https://web.telegram.org";
const UNGOOGLED_FIRST_RUN_URL = "chrome://ungoogled-first-run/";
const CHROME_NEW_TAB_URL = "chrome://newtab/";
const LINKEDIN_DEVICE_COOKIES = new Set(["bcookie", "bscookie", "li_rm"]);
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

function canonicalUserPageUrl(value) {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (parsed.searchParams.has("__aliasmode_session_capture__")
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
async function collectPasscodeStorage(page) {
  const source = await storageScriptSource();
  return page.evaluate(async ({ rules, source }) => {
    if (globalThis.location.origin !== "https://web.telegram.org") throw new Error("Wrong capture origin");
    const module = { exports: {} };
    Function("module", "exports", source)(module, module.exports);
    const script = new (module.exports.StorageScript())(false);
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

async function captureLiveOrigin(context, origin) {
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
      const live = await page.evaluate((expectedOrigin) => {
        const currentOrigin = globalThis.location.origin;
        if (currentOrigin !== expectedOrigin) return { origin: currentOrigin };
        return {
          origin: currentOrigin,
          localStorage: Object.keys(globalThis.localStorage).map((name) => ({ name, value: globalThis.localStorage.getItem(name) })),
        };
      }, origin);
      if (live?.origin !== origin) continue;
      let storage = { localStorage: live.localStorage };
      if (origin === TELEGRAM_ORIGIN) {
        let capturePasscode = !localStorageHasTelegramAuth(storage.localStorage);
        if (!capturePasscode) capturePasscode = await passcodeDatabasePresent(page);
        if (capturePasscode) storage = await collectPasscodeStorage(page);
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
          indexName: "",
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
    if (!Number.isSafeInteger(productMajor) || productMajor < 137) {
      throw new Error("hidden storage target requires Chromium 137 or newer");
    }

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
      await context.route(url, handler);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
        if (!intercepted) throw new Error("Capture navigation was not intercepted");
        if (new URL(page.url()).origin !== origin) throw new Error("Wrong capture origin");
        const response = await cdp.send("DOMStorage.getDOMStorageItems", {
          storageId: { securityOrigin: origin, isLocalStorage: true },
        });
        const localStorage = (response.entries ?? []).map(([name, value]) => ({ name, value }));
        const indexedDB = origin === TELEGRAM_ORIGIN ? await collectTelegramIndexedDB(cdp, origin) : [];
        return { localStorage, ...(indexedDB.length ? { indexedDB } : {}) };
      } finally {
        await context.unroute(url, handler).catch(() => {});
      }
    },
    close,
  };
}

async function captureSession(browser, payload) {
  const context = contextOf(browser);
  const tabs = context.pages().map((page) => canonicalUserPageUrl(page.url())).filter(Boolean);
  const seed = payload.captureSeed;
  if (seed !== undefined && (!seed || typeof seed !== "object" || Array.isArray(seed)
    || !Array.isArray(seed.origins)
    || seed.origins.some((origin) => typeof origin !== "string" || canonicalWebOrigin(origin) !== origin)
    || (seed.telegramClient !== undefined && seed.telegramClient !== "a" && seed.telegramClient !== "k"))) {
    throw new Error("Invalid session capture seed");
  }

  const origins = new Set(seed?.origins ?? []);
  let telegramClient = seed?.telegramClient;
  for (const page of context.pages()) {
    try {
      const pageUrl = canonicalUserPageUrl(page.url());
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

  let reader;
  try {
    const byOrigin = new Map();
    for (const origin of [...origins].sort()) {
      let storage = await captureLiveOrigin(context, origin);
      if (!storage) {
        reader ??= await createReadOnlyStorageReader(browser, context);
        storage = await reader.read(origin);
      }
      const captured = capturedWebOriginStorage(origin, storage);
      if (captured) byOrigin.set(origin, captured);
    }

    const cookies = typeof context.cookies === "function"
      ? await context.cookies()
      : (await context.storageState()).cookies;
    if (!Array.isArray(cookies) || cookies.some((cookie) =>
      typeof cookie?.name !== "string" || typeof cookie.value !== "string" ||
      typeof cookie.domain !== "string" || typeof cookie.path !== "string" ||
      (cookie.expires !== undefined && (typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires))) ||
      (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== "boolean") ||
      (cookie.secure !== undefined && typeof cookie.secure !== "boolean") ||
      (cookie.partitionKey !== undefined && typeof cookie.partitionKey !== "string") ||
      (cookie._crHasCrossSiteAncestor !== undefined && typeof cookie._crHasCrossSiteAncestor !== "boolean") ||
      (cookie.sameSite !== undefined && !["Strict", "Lax", "None"].includes(cookie.sameSite))
    )) throw new Error("Invalid captured cookies");
    return JSON.stringify({
      cookies,
      origins: [...byOrigin.values()],
      tabs,
      ...(telegramClient ? { telegramClient } : {}),
    });
  } finally {
    await reader?.close();
  }
}

async function navigatePages(context, urls, replacePages = false) {
  const targets = (Array.isArray(urls) ? urls : []).map(canonicalUserPageUrl).filter(Boolean);
  const existing = [...context.pages()];
  const existingUserPage = existing.some((page) => {
    try { return canonicalUserPageUrl(page.url()) !== undefined; } catch { return false; }
  });
  let blank = existing.find((page) => {
    try { return page.url() === "about:blank"; } catch { return false; }
  }) || existing.find((page) => {
    try { return page.url() === CHROME_NEW_TAB_URL; } catch { return false; }
  }) || existing.find((page) => {
    try { return page.url() === UNGOOGLED_FIRST_RUN_URL; } catch { return false; }
  });
  if (!replacePages && existingUserPage) blank = undefined;
  let firstError;

  if (replacePages) {
    if (!blank) blank = await context.newPage();
    for (const page of existing) {
      let url = "";
      try { url = page.url(); } catch {}
      const disposable = canonicalUserPageUrl(url) !== undefined
        || (url === UNGOOGLED_FIRST_RUN_URL && page !== blank)
        || (url === CHROME_NEW_TAB_URL && page !== blank)
        || (url === "about:blank" && page !== blank);
      if (!disposable) continue;
      try { await page.close(); } catch (error) { firstError ??= error; }
    }
  } else {
    for (const page of existing) {
      let url = "";
      try { url = page.url(); } catch {}
      if (url !== UNGOOGLED_FIRST_RUN_URL) continue;
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

  for (let index = 0; index < targets.length; index++) {
    try {
      const page = index === 0 && blank ? blank : await context.newPage();
      await page.goto(targets[index], { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

async function restoreSession(browser, context, payload) {
  let bundle;
  try { bundle = JSON.parse(payload.bundle); } catch { throw sessionError("invalid_bundle"); }
  const origins = Array.isArray(bundle.origins)
    ? bundle.origins.map((target) => normalizeWebOriginStorage(target?.origin, target)).filter(Boolean)
    : [];
  const cookies = Array.isArray(bundle.cookies) ? bundle.cookies : [];
  if (!cookies.length && !origins.length && !(payload.urls || []).length && !payload.replacePages && !payload.authoritative) return null;
  const storageSource = origins.some((target) => target.indexedDB?.length)
    ? await sessionStep("origin_storage", storageScriptSource)
    : undefined;
  for (const target of origins) {
    await sessionStep("origin_storage", async () => {
      const existing = context.pages();
      for (const page of existing) {
        try { if (new URL(page.url()).origin === target.origin) await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 }); } catch {}
      }
      const page = await context.newPage();
      const restoreUrl = `${target.origin}/?__aliasmode_session_restore__=${Date.now()}`;
      let intercepted = false;
      const handler = (route) => {
        intercepted = true;
        return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>restore</title>" });
      };
      const cdp = typeof context.newCDPSession === "function" ? await context.newCDPSession(page) : null;
      try {
        if (cdp) {
          await cdp.send("Network.enable");
          await cdp.send("Network.setBypassServiceWorker", { bypass: true });
        }
        await context.route(restoreUrl, handler);
        await page.goto(restoreUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
        if (!intercepted) throw new Error("Restore navigation was not intercepted");
        if (new URL(page.url()).origin !== target.origin) throw new Error("wrong restore origin");
      await page.evaluate(async ({ entries, databases, source, databaseRules }) => {
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
          const script = new (module.exports.StorageScript())(false);
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
          databaseRules: target.origin === TELEGRAM_ORIGIN ? TELEGRAM_AUTH_INDEXEDDB_RULES : [],
        });
      } finally {
        await context.unroute(restoreUrl, handler).catch(() => {});
        await page.close();
        if (cdp) await cdp.detach().catch(() => {});
      }
    });
  }
  await sessionStep("cookie_clear", () => context.clearCookies());
  const inject = cookies.filter((cookie) => !LINKEDIN_DEVICE_COOKIES.has(cookie.name));
  if (inject.length) await sessionStep("cookie_add", () => context.addCookies(inject));
  await sessionStep("navigation", () => navigatePages(context, payload.urls, !!payload.replacePages));
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

      const modelIndex = (engine) => {
        if (!Number.isInteger(engine.modelIndex) || engine.modelIndex < 0) {
          throw new Error("Chromium search engine model index was unavailable");
        }
        return engine.modelIndex;
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

async function operate(chromium, operation, payload) {
  if (operation === "search-provider") return searchProvider(chromium, payload);
  const endpoint = payload.endpoint;
  if (typeof endpoint !== "string" || !/^https?:\/\/|^wss?:\/\//.test(endpoint)) throw typed("invalid_request");
  const timeout = Math.max(1, Math.min(Number(payload.connectTimeoutMs) || 30_000, 120_000));
  return withBrowser(chromium, endpoint, timeout, operation, async (browser, context) => {
    if (operation === "session-capture") return captureSession(browser, payload);
    if (operation === "session-restore") return restoreSession(browser, context, payload);
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
          if (canCreate) {
            const page = await context.newPage();
            await page.goto(payload.url, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
            if (automation !== page) await automation.bringToFront().catch(() => {});
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
