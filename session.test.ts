import { test, expect } from "bun:test";
import {
  applySessionToEndpoint,
  bundleHasRestorableLogin,
  bundleLoggedInPlatforms,
  bundleTelegramClient,
  collectSessionFromContext,
  isSessionCookie,
  normalizeBundle,
  normalizeOriginStorage,
  parseCapturedSessionBundle,
  playwrightTransportAttribution,
  readSessionFromBrowser,
  restoreOriginStorage,
  SessionRestoreError,
  sessionBundleSignature,
  TELEGRAM_AUTH_INDEXEDDB_RULES,
  telegramAuthSignature,
  writeSession,
  writeSessionToBrowser,
} from "./session.ts";

test("playwrightTransportAttribution reads the shared transport counters", () => {
  const key = Symbol.for("aliasmode.playwrightTransportStats");
  const prior = (globalThis as any)[key];
  try {
    delete (globalThis as any)[key];
    expect(playwrightTransportAttribution()).toEqual({ opened: 0, closed: 0, forced: 0, active: 0 });

    (globalThis as any)[key] = { opened: 12, closed: 10, forced: 2, active: 2 };
    expect(playwrightTransportAttribution()).toEqual({ opened: 12, closed: 10, forced: 2, active: 2 });
  } finally {
    if (prior === undefined) delete (globalThis as any)[key];
    else (globalThis as any)[key] = prior;
  }
});

function textStream(value: string): ReadableStream<Uint8Array> {
  return new Response(value).body as ReadableStream<Uint8Array>;
}

async function expectRestoreError(
  promise: Promise<unknown>,
  operation: SessionRestoreError["operation"],
  outcome: SessionRestoreError["outcome"],
): Promise<SessionRestoreError> {
  const error = await promise.then(
    () => null,
    (failure) => failure,
  );
  expect(error).toBeInstanceOf(SessionRestoreError);
  expect(error).toMatchObject({ operation, outcome });
  expect((error as Error).message).toBe(`session_restore/${operation} (${outcome})`);
  return error as SessionRestoreError;
}

test("readSessionFromBrowser bounds a wedged capture and disconnects the CDP client", async () => {
  let closes = 0;
  const browser = {
    contexts: () => [{ storageState: () => new Promise(() => {}), pages: () => [] }],
    async close() { closes++; },
  };

  await expect(readSessionFromBrowser(browser, {
    captureTimeoutMs: 5,
    disconnectTimeoutMs: 5,
  })).rejects.toThrow("session capture exceeded 5ms");
  expect(closes).toBe(1);
});

test("readSessionFromBrowser does not hang when CDP disconnect stalls", async () => {
  const browser = {
    contexts: () => [{ storageState: async () => ({ cookies: [], origins: [] }), pages: () => [] }],
    close: () => new Promise(() => {}),
  };

  expect(await readSessionFromBrowser(browser, {
    captureTimeoutMs: 20,
    disconnectTimeoutMs: 5,
  })).toBe('{"cookies":[],"origins":[]}');
});

test("writeSessionToBrowser bounds a hung origin restore and disconnects", async () => {
  let closes = 0;
  const page = {
    url: () => "about:blank",
    goto: () => new Promise(() => {}),
    async evaluate() {},
  };
  const context = {
    pages: () => [page],
    async clearCookies() {},
    async addCookies() {},
  };
  const browser = {
    contexts: () => [context],
    async close() { closes++; },
  };
  const bundle = normalizeBundle({
    cookies: [],
    origins: [{ origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "value" }] }],
  });

  await expectRestoreError(writeSessionToBrowser(browser, bundle, {
    writeTimeoutMs: 5,
    disconnectTimeoutMs: 5,
  }), "origin_storage", "timeout");
  expect(closes).toBe(1);
});

test("writeSessionToBrowser restores without detaching its borrowed CDP lease", async () => {
  let closes = 0;
  let cleared = false;
  let injected: any[] = [];
  const browser = {
    contexts: () => [{
      pages: () => [],
      async clearCookies() { cleared = true; },
      async addCookies(cookies: any[]) { injected = cookies; },
    }],
    async close() { closes++; },
  };

  await writeSessionToBrowser(browser, normalizeBundle({
    cookies: [{ name: "auth_token", value: "live", domain: ".x.com", path: "/" }],
  }), { disconnect: false });

  expect(cleared).toBe(true);
  expect(injected.map((cookie) => cookie.name)).toEqual(["auth_token"]);
  expect(closes).toBe(0);
});

test("timed-out borrowed session work cannot continue after its owner detaches", async () => {
  let finishClear!: () => void;
  const clearing = new Promise<void>((resolve) => { finishClear = resolve; });
  let added = false;
  let closes = 0;
  const browser = {
    contexts: () => [{
      pages: () => [],
      clearCookies: () => clearing,
      async addCookies() { added = true; },
    }],
    async close() {
      closes++;
      finishClear();
    },
  };

  await expectRestoreError(writeSessionToBrowser(browser, normalizeBundle({
    cookies: [{ name: "auth_token", value: "live", domain: ".x.com", path: "/" }],
  }), { writeTimeoutMs: 5, disconnect: false }), "cookie_clear", "timeout");
  expect(closes).toBe(0);

  await browser.close();
  await Promise.resolve();
  expect(added).toBe(false);
});

test("writeSessionToBrowser restores cookies and localStorage for a web origin", async () => {
  let opened = false;
  let cleared = false;
  let injected: any[] = [];
  let currentUrl = "about:blank";
  const routes = new Map<string, (route: any) => unknown>();
  const context = {
    pages: () => [],
    async newPage() {
      opened = true;
      return {
        async goto(url: string) {
          currentUrl = url;
          await routes.get(url)?.({ fulfill: async () => {} });
        },
        url: () => currentUrl,
        async evaluate() {},
        async close() {},
      };
    },
    async route(url: string, handler: (route: any) => unknown) { routes.set(url, handler); },
    async unroute(url: string) { routes.delete(url); },
    async clearCookies() { cleared = true; },
    async addCookies(cookies: any[]) { injected = cookies; },
  };
  const browser = {
    contexts: () => [context],
    async close() {},
  };

  await writeSessionToBrowser(browser, normalizeBundle({
    cookies: [{ name: "sessionid", value: "live", domain: ".instagram.com", path: "/" }],
    origins: [{ origin: "https://www.instagram.com", localStorage: [{ name: "incidental", value: "state" }] }],
  }));

  expect(opened).toBe(true);
  expect(currentUrl).toStartWith("https://www.instagram.com/");
  expect(cleared).toBe(true);
  expect(injected.map((cookie) => cookie.name)).toEqual(["sessionid"]);
});

test("writeSessionToBrowser bounds hung cookie clear and injection", async () => {
  const clearBrowser = {
    contexts: () => [{ pages: () => [], clearCookies: () => new Promise(() => {}), async addCookies() {} }],
    async close() {},
  };
  await expectRestoreError(writeSessionToBrowser(clearBrowser, normalizeBundle({ cookies: [] }), {
    writeTimeoutMs: 5,
    disconnectTimeoutMs: 5,
  }), "cookie_clear", "timeout");

  const addBrowser = {
    contexts: () => [{ pages: () => [], async clearCookies() {}, addCookies: () => new Promise(() => {}) }],
    async close() {},
  };
  await expectRestoreError(writeSessionToBrowser(addBrowser, normalizeBundle({
    cookies: [{ name: "auth_token", value: "v", domain: ".x.com", path: "/" }],
  }), {
    writeTimeoutMs: 5,
    disconnectTimeoutMs: 5,
  }), "cookie_add", "timeout");
});

test("a timed-out cookie write drains after disconnect and cannot continue into injection", async () => {
  let finishClear!: () => void;
  const clearing = new Promise<void>((resolve) => { finishClear = resolve; });
  let added = false;
  const browser = {
    contexts: () => [{
      pages: () => [],
      clearCookies: () => clearing,
      async addCookies() { added = true; },
    }],
    async close() { finishClear(); },
  };

  await expectRestoreError(writeSessionToBrowser(browser, normalizeBundle({
    cookies: [{ name: "auth_token", value: "v", domain: ".x.com", path: "/" }],
  }), {
    writeTimeoutMs: 5,
    disconnectTimeoutMs: 20,
  }), "cookie_clear", "timeout");
  expect(added).toBe(false);
});

test("writeSessionToBrowser bounds disconnect and preserves a primary restore failure", async () => {
  const context = { pages: () => [], async clearCookies() {}, async addCookies() {} };
  const hungDisconnect = {
    contexts: () => [context],
    close: () => new Promise(() => {}),
  };
  await expectRestoreError(writeSessionToBrowser(hungDisconnect, normalizeBundle({ cookies: [] }), {
    writeTimeoutMs: 20,
    disconnectTimeoutMs: 5,
  }), "disconnect", "timeout");

  const restoreAndDisconnectFail = {
    contexts: () => [{ pages: () => [], async clearCookies() { throw new Error("cookie restore failed secret"); }, async addCookies() {} }],
    close: () => new Promise(() => {}),
  };
  const error = await expectRestoreError(writeSessionToBrowser(
    restoreAndDisconnectFail,
    normalizeBundle({ cookies: [] }),
    { writeTimeoutMs: 20, disconnectTimeoutMs: 5 },
  ), "cookie_clear", "failed");
  expect(error.message).not.toContain("secret");
});

test("writeSession waits for the persistent context without creating an incognito context", async () => {
  let attempts = 0;
  let closes = 0;
  let newContexts = 0;
  let cleared = false;
  const context = {
    pages: () => [],
    async clearCookies() { cleared = true; },
    async addCookies() {},
  };

  await writeSession("ws://verified-browser", JSON.stringify({
    cookies: [{ name: "auth_token", value: "live", domain: ".x.com", path: "/" }],
  }), {
    connectTimeoutMs: 100,
    contextRetryMs: 1,
    sleep: async () => {},
    async connect(endpoint) {
      expect(endpoint).toBe("ws://verified-browser");
      attempts++;
      if (attempts === 1) throw new Error("transient connect secret");
      if (attempts === 2) {
        return {
          contexts: () => [],
          async newContext() { newContexts++; },
          async close() { closes++; },
        };
      }
      return {
        contexts: () => [context],
        async newContext() { newContexts++; },
        async close() { closes++; },
      };
    },
  });

  expect(attempts).toBe(3);
  expect(newContexts).toBe(0);
  expect(closes).toBe(2);
  expect(cleared).toBe(true);
});

test("writeSession reports fixed connect and context readiness timeouts", async () => {
  const connectError = await expectRestoreError(writeSession(
    "ws://verified-browser",
    JSON.stringify({ cookies: [{ name: "auth_token", value: "live", domain: ".x.com", path: "/" }] }),
    {
      connectTimeoutMs: 5,
      contextRetryMs: 1,
      async connect() { throw new Error("connect credential secret"); },
    },
  ), "connect", "timeout");
  expect(connectError.message).not.toContain("credential");

  let closes = 0;
  const contextError = await expectRestoreError(writeSession(
    "ws://verified-browser",
    JSON.stringify({ cookies: [{ name: "auth_token", value: "live", domain: ".x.com", path: "/" }] }),
    {
      connectTimeoutMs: 5,
      contextRetryMs: 1,
      async connect() {
        return {
          contexts: () => [],
          async newContext() { throw new Error("must not create"); },
          async close() { closes++; },
        };
      },
    },
  ), "context", "timeout");
  expect(contextError.message).not.toContain("must not create");
  expect(closes).toBeGreaterThan(0);
});

test("session restore operation errors never expose raw failure text", async () => {
  const invalid = await expectRestoreError(
    writeSession("ws://verified-browser", "secret invalid payload"),
    "invalid_bundle",
    "failed",
  );
  expect(invalid.message).not.toContain("payload");

  const contextBrowser = {
    contexts: () => [],
    async newContext() { throw new Error("must not create secret"); },
    async close() {},
  };
  await expectRestoreError(
    writeSessionToBrowser(contextBrowser, normalizeBundle({ cookies: [] })),
    "context",
    "failed",
  );

  const originPage = {
    url: () => "about:blank",
    async goto() { throw new Error("origin secret"); },
    async evaluate() {},
  };
  const originBrowser = {
    contexts: () => [{ pages: () => [originPage], async clearCookies() {}, async addCookies() {} }],
    async close() {},
  };
  await expectRestoreError(writeSessionToBrowser(originBrowser, normalizeBundle({
    cookies: [],
    origins: [{ origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "secret" }] }],
  })), "origin_storage", "failed");

  const clearBrowser = {
    contexts: () => [{ pages: () => [], async clearCookies() { throw new Error("cookie clear secret"); }, async addCookies() {} }],
    async close() {},
  };
  await expectRestoreError(
    writeSessionToBrowser(clearBrowser, normalizeBundle({ cookies: [] })),
    "cookie_clear",
    "failed",
  );

  const addBrowser = {
    contexts: () => [{ pages: () => [], async clearCookies() {}, async addCookies() { throw new Error("cookie add secret"); } }],
    async close() {},
  };
  await expectRestoreError(writeSessionToBrowser(addBrowser, normalizeBundle({
    cookies: [{ name: "auth_token", value: "secret", domain: ".x.com", path: "/" }],
  })), "cookie_add", "failed");
});

test("bundleHasRestorableLogin: true only when injecting the bundle can put a login back", () => {
  expect(bundleHasRestorableLogin(JSON.stringify({ cookies: [{ name: "auth_token", value: "x", domain: ".x.com" }] }))).toBe(true); // X cookie
  expect(bundleHasRestorableLogin(JSON.stringify({ cookies: [{ name: "sessionid", value: "x", domain: ".instagram.com" }] }))).toBe(true);
  expect(bundleHasRestorableLogin(JSON.stringify({ cookies: [{ name: "c_user", value: "1", domain: ".facebook.com" }] }))).toBe(true);
  expect(bundleHasRestorableLogin(JSON.stringify({ cookies: [{ name: "sessionid_ss", value: "x", domain: ".tiktok.com" }] }))).toBe(true);
  expect(bundleHasRestorableLogin(JSON.stringify({ cookies: [{ name: "li_at", value: "x", domain: ".linkedin.com" }] }))).toBe(true); // LinkedIn cookie
  expect(bundleHasRestorableLogin(JSON.stringify({ cookies: [{ name: "reddit_session", value: "x", domain: ".reddit.com" }] }))).toBe(true);
  expect(
    bundleHasRestorableLogin(JSON.stringify({ cookies: [], origins: [{ origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "live" }] }] })),
  ).toBe(true); // Telegram origin storage
  expect(bundleHasRestorableLogin(JSON.stringify({ cookies: [] }))).toBe(false); // Telegram first migration — nothing to restore
  expect(bundleHasRestorableLogin(JSON.stringify({ cookies: [{ name: "auth_token", value: "" }] }))).toBe(false); // empty-valued cookie
  expect(bundleHasRestorableLogin(JSON.stringify({ cookies: [{ name: "auth_token", value: "x", domain: ".x.com", expires: 1 }] }), 10_000)).toBe(false); // expired
  expect(bundleHasRestorableLogin(JSON.stringify({ cookies: [{ name: "auth_token", value: "x", domain: ".evil.com" }] }))).toBe(false); // wrong domain
  expect(
    bundleHasRestorableLogin(JSON.stringify({ cookies: [], origins: [{ origin: "https://web.telegram.org", localStorage: [{ name: "theme", value: "dark" }] }] })),
  ).toBe(false); // incidental Telegram storage, not auth
  expect(bundleHasRestorableLogin(JSON.stringify({ cookies: [{ name: "stel_token", value: "x", domain: "web.telegram.org" }] }))).toBe(false); // Telegram cookies alone don't restore Web auth
  expect(bundleHasRestorableLogin("not-json")).toBe(false);
});

test("bundleLoggedInPlatforms recognizes each supported auth marker", () => {
  const bundle = JSON.stringify({
    cookies: [
      { name: "auth_token", value: "x", domain: ".x.com" },
      { name: "sessionid", value: "i", domain: ".instagram.com" },
      { name: "c_user", value: "1", domain: ".facebook.com" },
      { name: "sessionid_ss", value: "t", domain: ".tiktok.com" },
      { name: "li_at", value: "l", domain: ".linkedin.com" },
      { name: "reddit_session", value: "r", domain: ".reddit.com" },
    ],
    origins: [{ origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "tg" }] }],
  });
  expect([...bundleLoggedInPlatforms(bundle, Date.now())].sort()).toEqual([
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "reddit.com",
    "telegram.org",
    "tiktok.com",
    "x.com",
  ]);
});

test("bundleHasRestorableLogin: logged-OUT Telegram state must NOT read as restorable (no spurious reset/roam)", () => {
  const tg = (localStorage: any[], indexedDB?: any[]) =>
    JSON.stringify({ cookies: [], origins: [{ origin: "https://web.telegram.org", localStorage, ...(indexedDB ? { indexedDB } : {}) }] });
  // Real auth → true (the MTProto auth key + signed-in user, stable across K/A/Z clients).
  expect(bundleHasRestorableLogin(tg([{ name: "dc1_auth_key", value: "KEY" }]))).toBe(true);
  expect(bundleHasRestorableLogin(tg([{ name: "user_auth", value: "42" }]))).toBe(false); // user marker without an MTProto key cannot reconnect
  expect(bundleHasRestorableLogin(tg([{ name: "account1", value: JSON.stringify({ dcId: 2, dc2_auth_key: "KEY", userId: "42" }) }]))).toBe(true);
  expect(bundleHasRestorableLogin(tg([{ name: "account1", value: JSON.stringify({ dcId: 2, userId: "42" }) }]))).toBe(false);
  // Logged-out / incidental state that the old broad regex false-matched → must be false.
  expect(bundleHasRestorableLogin(tg([{ name: "last_error", value: "unauthorized" }]))).toBe(false); // "auth" in "unauthorized"
  expect(bundleHasRestorableLogin(tg([{ name: "tt-global-state", value: '{"lastAuthorMenu":true}' }]))).toBe(false); // "auth" in "author"
  expect(bundleHasRestorableLogin(tg([{ name: "dc1_server_salt", value: "abc" }]))).toBe(false); // salt present pre-login, not auth
  expect(bundleHasRestorableLogin(tg([{ name: "ux_session_shown", value: "1" }]))).toBe(false); // "session" substring, analytics flag
  expect(bundleHasRestorableLogin(tg([{ name: "note", value: "my auth_key is secret" }]))).toBe(false); // token only in a VALUE, not a key
  // IndexedDB cache-only store (records but no auth key) → false; auth key in IndexedDB → true.
  expect(bundleHasRestorableLogin(tg([], [{ name: "tweb", version: 1, stores: [{ name: "cache", records: [{ key: "theme", value: "dark" }] }] }]))).toBe(false);
  expect(bundleHasRestorableLogin(tg([], [{ name: "tweb", version: 1, stores: [{ name: "session", records: [{ key: "dc2_auth_key", value: "K" }] }] }]))).toBe(true);
  expect(bundleHasRestorableLogin(tg([], [{ name: "tt-passcode", version: 1, stores: [{ name: "store", records: [
    { key: "sessionEncrypted", value: [1, 2] }, { key: "globalEncrypted", value: [3, 4] },
  ] }] }]))).toBe(true); // Web A local-passcode session
  expect(bundleHasRestorableLogin(tg([], [{ name: "tweb-common", version: 8, stores: [{ name: "localStorage__encrypted", records: [
    { key: "data", valueEncoded: { ta: { b: "AQI=", k: "ui8" } } },
  ] }] }]))).toBe(true); // Web K local-passcode session
});

test("Telegram client/signature recognizes current accountN storage and preserves A/K", () => {
  const bundle = JSON.stringify({
    cookies: [], telegramClient: "a",
    origins: [{
      origin: "https://web.telegram.org",
      localStorage: [
        { name: "theme", value: "dark" },
        { name: "account2", value: JSON.stringify({ dcId: 4, dc4_auth_key: "KEY2", userId: "99" }) },
      ],
    }],
  });
  expect(bundleTelegramClient(bundle)).toBe("a");
  expect(telegramAuthSignature(bundle)).toContain("account2");
  expect(telegramAuthSignature(bundle)).not.toContain("theme");
  expect(bundleTelegramClient(JSON.stringify({ origins: [{ origin: "https://web.telegram.org", localStorage: [{ name: "kz_version", value: '"K"' }] }] }))).toBe("k");
});

test("isSessionCookie matches supported platform hosts and rejects others", () => {
  expect(isSessionCookie({ domain: ".x.com" })).toBe(true);
  expect(isSessionCookie({ domain: "x.com" })).toBe(true);
  expect(isSessionCookie({ domain: "web.telegram.org" })).toBe(true);
  expect(isSessionCookie({ domain: ".instagram.com" })).toBe(true);
  expect(isSessionCookie({ domain: ".facebook.com" })).toBe(true);
  expect(isSessionCookie({ domain: ".tiktok.com" })).toBe(true);
  expect(isSessionCookie({ domain: ".reddit.com" })).toBe(true);
  expect(isSessionCookie({ domain: ".linkedin.com" })).toBe(true);
  expect(isSessionCookie({ domain: "www.linkedin.com" })).toBe(true);
  expect(isSessionCookie({ domain: "evil.com" })).toBe(false);
  expect(isSessionCookie({ domain: "notx.com" })).toBe(false); // suffix match must respect the dot boundary
  expect(isSessionCookie({})).toBe(false);
});

test("normalizeOriginStorage accepts web origins and rejects non-web or malformed origins", () => {
  expect(normalizeOriginStorage("https://example.com", { localStorage: [{ name: "a", value: "b" }] })).toEqual({
    origin: "https://example.com",
    localStorage: [{ name: "a", value: "b" }],
  });
  expect(normalizeOriginStorage("chrome-extension://example", { localStorage: [{ name: "a", value: "b" }] })).toBeNull();
  expect(normalizeOriginStorage("not a url", { localStorage: [{ name: "a", value: "b" }] })).toBeNull();
  expect(normalizeOriginStorage("https://web.telegram.org", {})).toBeNull();
  expect(normalizeOriginStorage("https://web.telegram.org", { localStorage: [{ name: "bad", value: 42 }] })).toBeNull();
  expect(normalizeOriginStorage("https://web.telegram.org", { localStorage: [] })).toEqual({
    origin: "https://web.telegram.org",
    localStorage: [],
  });
});

test("normalizeOriginStorage filters malformed localStorage entries but keeps well-shaped ones", () => {
  const result = normalizeOriginStorage("https://web.telegram.org", {
    localStorage: [
      { name: "dc2_auth_key", value: "live" },
      { name: "bad", value: 42 }, // non-string value, dropped
      { value: "no-name" }, // missing name, dropped
      "not-an-object",
    ],
  });
  expect(result?.localStorage).toEqual([{ name: "dc2_auth_key", value: "live" }]);
  expect(result?.indexedDB).toBeUndefined();
});

test("normalizeOriginStorage keeps localStorage for cookie-auth platforms but drops arbitrary IndexedDB", () => {
  const storage = {
    localStorage: [{ name: "auth", value: "value" }],
    indexedDB: [{ name: "cache", version: 1, stores: [] }],
  };
  expect(normalizeOriginStorage("https://x.com", storage)).toEqual({
    origin: "https://x.com",
    localStorage: [{ name: "auth", value: "value" }],
  });
  expect(normalizeOriginStorage("https://www.instagram.com", storage)).toEqual({
    origin: "https://www.instagram.com",
    localStorage: [{ name: "auth", value: "value" }],
  });
});

test("normalizeOriginStorage drops Telegram cache DBs but keeps the A/K passcode DBs", () => {
  const result = normalizeOriginStorage("https://web.telegram.org", {
    localStorage: [],
    indexedDB: [
      { name: "tt-data", version: 1, stores: [{ name: "store", records: [{ key: "chat", value: {} }] }] },
      { name: "tt-passcode", version: 1, stores: [{ name: "store", records: [{ key: "sessionEncrypted", value: [1] }] }] },
      { name: "tweb-common", version: 8, stores: [
        { name: "session", records: [] }, { name: "messages", records: [{ key: "huge", value: {} }] },
      ] },
    ],
  });
  expect((result?.indexedDB as any[]).map((db) => db.name)).toEqual(["tt-passcode", "tweb-common"]);
  expect((result?.indexedDB as any[])[1].stores.map((store: any) => store.name)).toEqual(["session"]);
});

test("Telegram IndexedDB auth rules cover current A/K and legacy tweb databases from one allowlist", () => {
  expect(TELEGRAM_AUTH_INDEXEDDB_RULES.map((rule) => rule.databaseName).filter(Boolean)).toEqual(["tt-passcode", "tweb-common"]);
  expect(TELEGRAM_AUTH_INDEXEDDB_RULES.some((rule) => rule.databasePattern?.includes("tweb"))).toBe(true);
});

test("parseCapturedSessionBundle accepts only complete fresh-capture shapes", () => {
  const valid = {
    cookies: [{
      name: "session",
      value: "active",
      domain: ".example.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    }],
    origins: [{ origin: "https://example.com", localStorage: [{ name: "auth", value: "value" }] }],
  };
  expect(parseCapturedSessionBundle(JSON.stringify(valid))).toEqual(valid);
  expect(parseCapturedSessionBundle(JSON.stringify({
    cookies: [],
    origins: [{ origin: "https://example.com", localStorage: [] }],
  }))).toEqual({
    cookies: [],
    origins: [{ origin: "https://example.com", localStorage: [] }],
  });

  for (const invalid of [
    null,
    {},
    { cookies: [], origins: "wrong" },
    { cookies: [{ name: "session", value: "active", domain: ".example.com" }], origins: [] },
    { cookies: [{ name: "session", value: "active", domain: ".example.com", path: "/", secure: "yes" }], origins: [] },
    { cookies: [], origins: [{ origin: "https://example.com/path", localStorage: [] }] },
    { cookies: [], origins: [{ origin: "https://example.com", localStorage: [{ name: "auth", value: 1 }] }] },
    { cookies: [], origins: [{ origin: "https://example.com", localStorage: [], indexedDB: [] }] },
    { cookies: [], origins: [{ origin: "https://web.telegram.org", localStorage: [], indexedDB: [{ name: "tt-passcode", version: 1, stores: [] }] }] },
    { cookies: [], origins: [], telegramClient: "z" },
  ]) {
    expect(() => parseCapturedSessionBundle(JSON.stringify(invalid))).toThrow("invalid captured session bundle");
  }
  expect(() => parseCapturedSessionBundle("not json")).toThrow("invalid captured session bundle");
});

test("sessionBundleSignature ignores portable entry order but detects session changes", () => {
  const first = JSON.stringify({
    cookies: [
      { name: "b", value: "2", domain: ".example.com", path: "/" },
      { name: "a", value: "1", domain: ".example.com", path: "/" },
    ],
    origins: [{
      origin: "https://example.com",
      localStorage: [{ name: "b", value: "2" }, { name: "a", value: "1" }],
    }],
  });
  const reordered = JSON.stringify({
    cookies: [
      { path: "/", domain: ".example.com", value: "1", name: "a" },
      { path: "/", domain: ".example.com", value: "2", name: "b" },
    ],
    origins: [{
      localStorage: [{ value: "1", name: "a" }, { value: "2", name: "b" }],
      origin: "https://example.com",
    }],
  });
  const changed = JSON.stringify({
    cookies: [{ name: "a", value: "changed", domain: ".example.com", path: "/" }],
    origins: [],
  });
  expect(sessionBundleSignature(first)).toBe(sessionBundleSignature(reordered));
  expect(sessionBundleSignature(first)).not.toBe(sessionBundleSignature(changed));
});

test("normalizeBundle tolerates missing/malformed input instead of throwing", () => {
  expect(normalizeBundle(null)).toEqual({ cookies: [], origins: [], hasOrigins: false });
  expect(normalizeBundle({})).toEqual({ cookies: [], origins: [], hasOrigins: false });
  expect(normalizeBundle({ cookies: "not-an-array" })).toEqual({ cookies: [], origins: [], hasOrigins: false });
});

test("normalizeBundle distinguishes a legacy cookie-only bundle from a modern one with an empty origins list", () => {
  expect(normalizeBundle({ cookies: [] }).hasOrigins).toBe(false); // legacy: no origins key at all
  expect(normalizeBundle({ cookies: [], origins: [] }).hasOrigins).toBe(true); // modern: explicitly empty
});

test("normalizeBundle keeps web origin localStorage and drops malformed or internal origins", () => {
  const bundle = normalizeBundle({
    cookies: [],
    origins: [
      { origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "live" }] },
      { origin: "https://www.instagram.com", localStorage: [{ name: "incidental", value: "state" }] },
      { origin: "https://example.com", localStorage: [{ name: "auth", value: "value" }] },
      { origin: "https://web.telegram.org" },
      { origin: "https://invalid.example", localStorage: "invalid" },
      { origin: "chrome-extension://private", localStorage: [{ name: "private", value: "state" }] },
      { localStorage: [{ name: "no-origin-field", value: "x" }] },
      null,
    ],
  });
  expect(bundle.origins).toEqual([
    { origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "live" }] },
    { origin: "https://www.instagram.com", localStorage: [{ name: "incidental", value: "state" }] },
    { origin: "https://example.com", localStorage: [{ name: "auth", value: "value" }] },
  ]);
});

test("restoreOriginStorage restores only origins present in the bundle, never wiping absent ones", async () => {
  const navigated: string[] = [];
  const restored: string[] = [];
  const page = {
    async goto(url: string) {
      navigated.push(url);
    },
    async evaluate(expr: string) {
      restored.push(expr);
    },
    async close() {},
  };
  const ctx = { pages: () => [page] };

  await restoreOriginStorage(ctx, [{ origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "live" }] }]);

  // Only Telegram was visited + restored. x.com / linkedin were never navigated, so
  // restore(undefined) never ran against them — their local login is left untouched.
  expect(navigated.filter((u) => u !== "about:blank")).toEqual(["https://web.telegram.org"]);
  expect(restored.length).toBe(2);
  expect(restored[0]).toContain("deleteDatabase(database.name)");
  expect(restored[0]).toContain("ruleFor(database.name)");
  expect(restored[1]).toContain("dc2_auth_key");
  expect(restored[1]).toContain("localStorage.setItem");
});

test("restoreOriginStorage restores selected passcode IndexedDB first, then verified localStorage", async () => {
  const restored: string[] = [];
  const page = {
    async goto() {},
    async evaluate(expr: string) {
      restored.push(expr);
    },
    async close() {},
  };
  const ctx = { pages: () => [page] };

  await restoreOriginStorage(ctx, [
    {
      origin: "https://web.telegram.org",
      localStorage: [{ name: "dc2_auth_key", value: "live" }],
      indexedDB: [{ name: "tt-passcode", version: 1, stores: [{ name: "store", records: [{ key: "sessionEncrypted", value: [1] }] }] }],
    },
  ]);
  // Two fail-closed passes: selected passcode DB, then transactional localStorage.
  expect(restored.length).toBe(2);
  expect(restored[0]).toContain("StorageScript");
  expect(restored[0]).toContain("deleteDatabase(database.name)");
  expect(restored[1]).toContain("localStorage.setItem");
  expect(restored[1]).toContain("dc2_auth_key");
  expect(restored[1]).toContain("backup");
});

test("restoreOriginStorage applies an empty Telegram tombstone without deleting unrelated databases", async () => {
  const restored: string[] = [];
  const page = {
    async goto() {},
    async evaluate(expr: string) { restored.push(expr); },
    async close() {},
  };
  const ctx = { pages: () => [page] };

  await restoreOriginStorage(ctx, [{ origin: "https://web.telegram.org", localStorage: [] }]);

  expect(restored.length).toBe(2);
  expect(restored[0]).toContain("tt-passcode");
  expect(restored[0]).toContain("tweb-common");
  expect(restored[0]).toContain("if (database && database.name && ruleFor(database.name))");
  expect(restored[0]).toContain("const databases = []");
  expect(restored[1]).toContain("const entries = []");
  expect(restored[1]).toContain("localStorage.clear()");
});

test("restoreOriginStorage restores localStorage for an arbitrary web origin", async () => {
  let opened = false;
  const navigated: string[] = [];
  const evaluated: string[] = [];
  const ctx = {
    pages: () => [],
    async newPage() {
      opened = true;
      return {
        async goto(url: string) { navigated.push(url); },
        url: () => navigated.at(-1),
        async evaluate(expression: string) { evaluated.push(expression); },
        async close() {},
      };
    },
  };
  await restoreOriginStorage(ctx, [{ origin: "https://www.instagram.com", localStorage: [{ name: "x", value: "y" }] }]);
  expect(opened).toBe(true);
  expect(navigated[0]).toBe("https://www.instagram.com");
  expect(evaluated[0]).toContain("localStorage.setItem");
});

test("restoreOriginStorage blanks every live same-origin page before restoring", async () => {
  const navigated: string[] = [];
  const existingAtTarget = {
    url: () => "https://example.com/dashboard",
    async goto(url: string) { navigated.push(`target:${url}`); },
  };
  const existingElsewhere = {
    url: () => "https://other.example/dashboard",
    async goto(url: string) { navigated.push(`other:${url}`); },
  };
  let restoreUrl = "about:blank";
  const restorePage = {
    async goto(url: string) { restoreUrl = url; navigated.push(`restore:${url}`); },
    url: () => restoreUrl,
    async evaluate() {},
    async close() {},
  };
  const ctx = {
    pages: () => [existingAtTarget, existingElsewhere],
    async newPage() { return restorePage; },
  };

  await restoreOriginStorage(ctx, [{
    origin: "https://example.com",
    localStorage: [{ name: "session", value: "active" }],
  }]);

  expect(navigated[0]).toBe("target:about:blank");
  expect(navigated.some((entry) => entry.startsWith("other:"))).toBe(false);
  expect(navigated[1]).toBe("restore:https://example.com");
});

test("restoreOriginStorage propagates a storage failure instead of reporting a partial restore", async () => {
  const page = {
    async goto() {},
    async evaluate() { throw new Error("quota denied"); },
    async close() {},
  };
  const ctx = { pages: () => [page] };
  await expect(restoreOriginStorage(ctx, [{
    origin: "https://web.telegram.org",
    localStorage: [{ name: "dc2_auth_key", value: "live" }],
  }])).rejects.toThrow("quota denied");
});

test("restoreOriginStorage rejects an unclosed throwaway page", async () => {
  const page = {
    async goto() {},
    async evaluate() {},
    async close() { throw new Error("page close failed"); },
  };
  const ctx = {
    pages: () => [],
    async newPage() { return page; },
  };

  await expect(restoreOriginStorage(ctx, [{
    origin: "https://web.telegram.org",
    localStorage: [{ name: "dc2_auth_key", value: "live" }],
  }])).rejects.toThrow("page close failed");
});

test("collectSessionFromContext rejects malformed raw origin storage", async () => {
  const malformedLocalStorage = {
    async storageState() {
      return {
        cookies: [],
        origins: [{ origin: "https://example.com", localStorage: [{ name: "session", value: 42 }] }],
      };
    },
    pages: () => [],
  };
  await expect(collectSessionFromContext(malformedLocalStorage)).rejects.toThrow("invalid captured origin storage");

  const internalOrigin = {
    async storageState() {
      return {
        cookies: [],
        origins: [{ origin: "chrome-extension://private", localStorage: [{ name: "session", value: "active" }] }],
      };
    },
    pages: () => [],
  };
  await expect(collectSessionFromContext(internalOrigin)).rejects.toThrow("invalid captured origin storage");
});

test("collectSessionFromContext includes storage from pages loaded before CDP attach", async () => {
  const ctx = {
    async storageState(opts?: any) {
      expect(opts).toBeUndefined();
      return {
        cookies: [
          { name: "stel_token", value: "tg", domain: "web.telegram.org", path: "/" },
          { name: "other", value: "no", domain: "example.com", path: "/" },
        ],
        origins: [],
      };
    },
    pages() {
      return [
        {
          url: () => "https://web.telegram.org/a/",
          evaluate: async (expression: string) => {
            expect(expression).not.toContain("StorageScript");
            if (expression.includes("indexedDB.databases")) return false; // cheap passcode-presence probe
            return {
              localStorage: [{ name: "dc2_auth_key", value: "live" }],
            };
          },
        },
      ];
    },
  };

  const bundle = await collectSessionFromContext(ctx);

  expect(bundle.cookies.map((c) => c.name)).toEqual(["stel_token", "other"]);
  expect(bundle.origins).toEqual([
    {
      origin: "https://web.telegram.org",
      localStorage: [{ name: "dc2_auth_key", value: "live" }],
    },
  ]);
  expect(bundle.telegramClient).toBe("a");
});

test("collectSessionFromContext rejects Telegram passcode presence read errors", async () => {
  const ctx = {
    async storageState() { return { cookies: [], origins: [] }; },
    pages() {
      return [{
        url: () => "https://web.telegram.org/a/",
        async evaluate(expression: string) {
          if (expression.includes("indexedDB.databases")) throw new Error("IndexedDB request failed");
          return { localStorage: [{ name: "dc2_auth_key", value: "live" }] };
        },
      }];
    },
  };

  await expect(collectSessionFromContext(ctx)).rejects.toThrow("IndexedDB request failed");
});

test("collectSessionFromContext preserves origin storage for every web platform", async () => {
  let evaluations = 0;
  const ctx = {
    async storageState() {
      return {
        cookies: [
          { name: "sessionid", value: "live", domain: ".instagram.com", path: "/" },
          { name: "custom_session", value: "live", domain: ".example.com", path: "/" },
        ],
        origins: [
          { origin: "https://www.instagram.com", localStorage: [{ name: "incidental", value: "state" }] },
          { origin: "https://example.com", localStorage: [{ name: "auth", value: "custom" }] },
        ],
      };
    },
    pages() {
      return [{
        url: () => "https://www.instagram.com/",
        async evaluate() {
          evaluations++;
          return { localStorage: [{ name: "incidental", value: "state" }] };
        },
      }];
    },
  };

  const bundle = await collectSessionFromContext(ctx);

  expect(bundle.cookies.map((cookie) => cookie.name)).toEqual(["sessionid", "custom_session"]);
  expect(bundle.origins).toEqual([
    { origin: "https://www.instagram.com", localStorage: [{ name: "incidental", value: "state" }] },
    { origin: "https://example.com", localStorage: [{ name: "auth", value: "custom" }] },
  ]);
  expect(evaluations).toBe(0);
});

test("collectSessionFromContext reads a closed origin from its durable capture seed", async () => {
  const storage = new Map([
    ["https://closed.example", [{ name: "token", value: "fresh-closed-value" }]],
    ["https://live.example", [{ name: "live", value: "current-value" }]],
  ]);
  const routes = new Map<string, (route: any) => unknown>();
  const pages: Array<{ currentUrl: string; closed: boolean }> = [];
  const livePage = { url: () => "https://live.example/dashboard" };
  const ctx = {
    pages: () => [livePage, ...pages.map((state) => ({
      url: () => state.currentUrl,
      close: async () => { state.closed = true; },
    }))],
    async newPage() {
      const state = { currentUrl: "about:blank", closed: false };
      pages.push(state);
      return {
        url: () => state.currentUrl,
        async goto(url: string) {
          const handler = routes.get(url);
          if (!handler) throw new Error("capture escaped to the network");
          await handler({ fulfill: async () => {} });
          state.currentUrl = url;
        },
        async close() { state.closed = true; },
      };
    },
    async route(url: string, handler: (route: any) => unknown) { routes.set(url, handler); },
    async unroute(url: string) { routes.delete(url); },
    async storageState() {
      return {
        cookies: [],
        origins: pages.map((page) => {
          const origin = new URL(page.currentUrl).origin;
          return { origin, localStorage: storage.get(origin) ?? [] };
        }),
      };
    },
  };

  const bundle = await collectSessionFromContext(ctx, {
    origins: ["https://closed.example", "https://empty.example"],
  });

  expect(bundle.origins).toEqual([
    { origin: "https://closed.example", localStorage: [{ name: "token", value: "fresh-closed-value" }] },
    { origin: "https://empty.example", localStorage: [] },
    { origin: "https://live.example", localStorage: [{ name: "live", value: "current-value" }] },
  ]);
  expect(pages.every((page) => page.closed)).toBe(true);
  expect(routes.size).toBe(0);
});

test("collectSessionFromContext does not walk Telegram cache IndexedDB when localStorage auth exists", async () => {
  let stateAttempts = 0;
  let pageAttempts = 0;
  const ctx = {
    async storageState(opts?: any) {
      expect(opts).toBeUndefined();
      stateAttempts++;
      return { cookies: [{ name: "auth_token", value: "x", domain: ".x.com", path: "/" }], origins: [] };
    },
    pages() {
      return [
        {
          url: () => "https://web.telegram.org/a/",
          evaluate: async (expr: string) => {
            pageAttempts++;
            expect(expr).not.toContain("StorageScript");
            if (expr.includes("indexedDB.databases")) return false;
            return { localStorage: [{ name: "dc2_auth_key", value: "live" }] };
          },
        },
      ];
    },
  };

  const bundle = await collectSessionFromContext(ctx);

  expect(stateAttempts).toBe(1);
  expect(pageAttempts).toBe(2); // localStorage + cheap passcode probe; no cache-DB collection pass
  expect(bundle.cookies.map((c) => c.name)).toEqual(["auth_token"]); // cookies survived
  // The roamable Telegram localStorage auth survived even though its IndexedDB couldn't be serialized.
  expect(bundle.origins).toEqual([{ origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "live" }] }]);
});

test("collectSessionFromContext captures only allowlisted passcode DBs when localStorage auth is absent", async () => {
  let evaluations = 0;
  const ctx = {
    async storageState() { return { cookies: [], origins: [] }; },
    pages() {
      return [{
        url: () => "https://web.telegram.org/k/",
        async evaluate(expr: string) {
          evaluations++;
          if (!expr.includes("StorageScript")) return { localStorage: [{ name: "theme", value: "dark" }] };
          expect(expr).toContain('"databaseName":"tweb-common"');
          return {
            localStorage: [{ name: "theme", value: "dark" }],
            indexedDB: [{ name: "tweb-common", version: 8, stores: [{
              name: "localStorage__encrypted", autoIncrement: false, indexes: [],
              records: [{ key: "data", valueEncoded: { ta: { b: "AQI=", k: "ui8" } } }],
            }] }],
          };
        },
      }];
    },
  };
  const bundle = await collectSessionFromContext(ctx);
  expect(evaluations).toBe(2);
  expect(bundle.telegramClient).toBe("k");
  expect(telegramAuthSignature(JSON.stringify(bundle))).not.toBeNull();
});

test("collectSessionFromContext captures legacy tweb-account passcode auth", async () => {
  let evaluations = 0;
  const legacyDb = { name: "tweb-account-2", version: 3, stores: [{
    name: "session__encrypted", autoIncrement: false, indexes: [], records: [
      { key: "dc4_auth_key", value: "LEGACY-AUTH" },
    ],
  }] };
  const ctx = {
    async storageState() { return { cookies: [], origins: [] }; },
    pages() {
      return [{
        url: () => "https://web.telegram.org/k/",
        async evaluate(expr: string) {
          evaluations++;
          if (!expr.includes("StorageScript")) return { localStorage: [{ name: "theme", value: "dark" }] };
          expect(expr).toContain('"databasePattern":"^tweb(?:-account-\\\\d+)?$"');
          expect(expr).toContain("session__encrypted");
          return { localStorage: [{ name: "theme", value: "dark" }], indexedDB: [legacyDb] };
        },
      }];
    },
  };

  const bundle = await collectSessionFromContext(ctx);

  expect(evaluations).toBe(2);
  expect(bundle.origins?.[0]?.indexedDB).toEqual([legacyDb]);
  expect(telegramAuthSignature(JSON.stringify(bundle))).not.toBeNull();
});

test("collectSessionFromContext includes Web A passcode DB even before its last tab clears localStorage auth", async () => {
  let evaluations = 0;
  const localStorage = [{ name: "account1", value: JSON.stringify({ dcId: 2, dc2_auth_key: "KEY" }) }];
  const passcodeDb = { name: "tt-passcode", version: 1, stores: [{
    name: "store", autoIncrement: false, indexes: [], records: [
      { key: "sessionEncrypted", value: [1] }, { key: "globalEncrypted", value: [2] },
    ],
  }] };
  const ctx = {
    async storageState() { return { cookies: [], origins: [] }; },
    pages() {
      return [{
        url: () => "https://web.telegram.org/a/",
        async evaluate(expr: string) {
          evaluations++;
          if (expr.includes("StorageScript")) return { localStorage, indexedDB: [passcodeDb] };
          if (expr.includes("indexedDB.databases")) return true;
          return { localStorage };
        },
      }];
    },
  };
  const bundle = await collectSessionFromContext(ctx);
  expect(evaluations).toBe(3);
  const telegram = bundle.origins?.find((origin) => origin.origin === "https://web.telegram.org");
  expect((telegram?.indexedDB as any[])[0].name).toBe("tt-passcode");
});

test("legacy tweb passcode presence triggers capture even while localStorage auth still exists", async () => {
  let evaluations = 0;
  const localStorage = [{ name: "account1", value: JSON.stringify({ dcId: 2, dc2_auth_key: "KEY" }) }];
  const legacyDb = { name: "tweb", version: 2, stores: [{
    name: "session", autoIncrement: false, indexes: [], records: [
      { key: "dc2_auth_key", value: "LEGACY" },
    ],
  }] };
  const ctx = {
    async storageState() { return { cookies: [], origins: [] }; },
    pages() {
      return [{
        url: () => "https://web.telegram.org/k/",
        async evaluate(expr: string) {
          evaluations++;
          if (expr.includes("StorageScript")) return { localStorage, indexedDB: [legacyDb] };
          if (expr.includes("indexedDB.databases")) {
            expect(expr).toContain('"databasePattern":"^tweb(?:-account-\\\\d+)?$"');
            return true;
          }
          return { localStorage };
        },
      }];
    },
  };

  const bundle = await collectSessionFromContext(ctx);

  expect(evaluations).toBe(3);
  expect(bundle.origins?.[0]?.indexedDB).toEqual([legacyDb]);
});

test("writeSession skips the browser attach entirely for an empty bundle", async () => {
  let connects = 0;
  await writeSession("ws://verified-browser", JSON.stringify({ cookies: [], origins: [] }), {
    async connect() { connects++; throw new Error("must not connect for an empty bundle"); },
  });
  expect(connects).toBe(0);
});

test("applySessionToEndpoint restores and navigates over one attach, then detaches once", async () => {
  const events: string[] = [];
  const context = {
    pages: () => [{
      async goto(url: string) { events.push(`goto:${url}`); },
    }],
    async newPage() { events.push("newPage"); return { async goto(url: string) { events.push(`goto:${url}`); } }; },
    async clearCookies() { events.push("clear"); },
    async addCookies() { events.push("add"); },
  };
  await applySessionToEndpoint(
    "ws://verified-browser",
    JSON.stringify({ cookies: [{ name: "auth_token", value: "live", domain: ".x.com", path: "/" }] }),
    ["https://x.com/home"],
    {
      sleep: async () => {},
      async connect() {
        events.push("connect");
        return {
          contexts: () => [context],
          async close() { events.push("close"); },
        };
      },
    },
  );
  expect(events).toEqual(["connect", "clear", "add", "goto:https://x.com/home", "close"]);
});

test("applySessionToEndpoint detaches after restore fails", async () => {
  const events: string[] = [];
  const context = {
    pages: () => [],
    async clearCookies() {
      events.push("clear");
      throw new Error("restore failed");
    },
  };

  await expect(applySessionToEndpoint(
    "ws://verified-browser",
    JSON.stringify({ cookies: [{ name: "auth_token", value: "live", domain: ".x.com", path: "/" }] }),
    [],
    {
      async connect() {
        events.push("connect");
        return {
          contexts: () => [context],
          async close() { events.push("close"); },
        };
      },
    },
  )).rejects.toMatchObject({ operation: "cookie_clear", outcome: "failed" });
  expect(events).toEqual(["connect", "clear", "close"]);
});

test("applySessionToEndpoint detaches after restore times out", async () => {
  const events: string[] = [];
  const context = {
    pages: () => [],
    async clearCookies() {
      events.push("clear");
      await new Promise(() => {});
    },
  };

  await expect(applySessionToEndpoint(
    "ws://verified-browser",
    JSON.stringify({ cookies: [{ name: "auth_token", value: "live", domain: ".x.com", path: "/" }] }),
    [],
    {
      writeTimeoutMs: 5,
      async connect() {
        events.push("connect");
        return {
          contexts: () => [context],
          async close() { events.push("close"); },
        };
      },
    },
  )).rejects.toMatchObject({ operation: "cookie_clear", outcome: "timeout" });
  expect(events).toEqual(["connect", "clear", "close"]);
});

test("applySessionToEndpoint with an empty bundle navigates without cookie work", async () => {
  const events: string[] = [];
  const context = {
    pages: () => [{ async goto(url: string) { events.push(`goto:${url}`); } }],
  };
  await applySessionToEndpoint("ws://verified-browser", JSON.stringify({ cookies: [], origins: [] }), ["https://x.com/home"], {
    sleep: async () => {},
    async connect() {
      events.push("connect");
      return { contexts: () => [context], async close() { events.push("close"); } };
    },
  });
  expect(events).toEqual(["connect", "goto:https://x.com/home", "close"]);
});
