import { test, expect } from "bun:test";
import {
  bundleHasRestorableLogin,
  bundleLoggedInPlatforms,
  bundleTelegramClient,
  collectSessionFromContext,
  decodeReadSessionResult,
  encodeReadSessionResult,
  isSessionCookie,
  normalizeBundle,
  normalizeOriginStorage,
  playwrightTransportAttribution,
  readSessionFromBrowser,
  readSessionInSubprocess,
  readSessionWorkerCommand,
  restoreOriginStorage,
  runReadSessionWorker,
  SessionRestoreError,
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

test("read-session result envelopes preserve exact bundle text", () => {
  const bundle = "{\"quoted\":\"line one\\nline two — 你好\"}\n";
  const encoded = encodeReadSessionResult({ ok: true, bundle });
  const decoded = decodeReadSessionResult(encoded);

  expect(decoded).toEqual({ ok: true, bundle });
  if (decoded.ok) expect(Buffer.byteLength(decoded.bundle)).toBe(Buffer.byteLength(bundle));
});

test("readSessionInSubprocess returns the worker bundle and uses the current Bun entrypoint", async () => {
  let argv: string[] = [];
  let killed = false;
  const bundle = "{\"cookies\":[],\"origins\":[]}\n";

  const result = await readSessionInSubprocess("ws://127.0.0.1:9222/devtools/browser/id", {
    spawn(command) {
      argv = command;
      return {
        stdout: textStream(encodeReadSessionResult({ ok: true, bundle })),
        stderr: textStream("suppressed warning\n"),
        exited: Promise.resolve(0),
        kill() { killed = true; },
      };
    },
  });

  expect(result).toBe(bundle);
  expect(argv[0]).toBe(process.execPath);
  expect(argv[1]!.replace(/\\/g, "/")).toBe(`${import.meta.dir.replace(/\\/g, "/")}/session.ts`);
  expect(argv.slice(2)).toEqual([
    "--read-session-worker",
    "ws://127.0.0.1:9222/devtools/browser/id",
  ]);
  expect(killed).toBe(false);
});

test("compiled session workers re-enter the executable without an embedded script path", () => {
  expect(readSessionWorkerCommand("ws://capture", true)).toEqual([
    process.execPath,
    "--read-session-worker",
    "ws://capture",
  ]);
  expect(readSessionWorkerCommand("ws://capture", false)).toEqual([
    process.execPath,
    import.meta.path.replace(/session\.test\.ts$/, "session.ts"),
    "--read-session-worker",
    "ws://capture",
  ]);
});

test("readSessionInSubprocess preserves worker errors and rejects partial output", async () => {
  await expect(readSessionInSubprocess("ws://capture", {
    spawn: () => ({
      stdout: textStream(encodeReadSessionResult({ ok: false, error: "capture failed exactly" })),
      stderr: textStream(""),
      exited: Promise.resolve(1),
      kill() {},
    }),
  })).rejects.toThrow("capture failed exactly");

  await expect(readSessionInSubprocess("ws://capture", {
    spawn: () => ({
      stdout: textStream("{partial"),
      stderr: textStream(""),
      exited: Promise.resolve(2),
      kill() {},
    }),
  })).rejects.toThrow("session capture subprocess exited 2");
});

test("readSessionInSubprocess kills a timed-out worker and waits for exit", async () => {
  let killed = false;
  let settled = false;
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const outcome = readSessionInSubprocess("ws://capture", {
    timeoutMs: 5,
    spawn: () => ({
      stdout: textStream(""),
      stderr: textStream(""),
      exited,
      kill() { killed = true; },
    }),
  }).then(
    () => null,
    (error) => error as Error,
  ).finally(() => { settled = true; });

  await Bun.sleep(10);
  expect(killed).toBe(true);
  expect(settled).toBe(false);

  resolveExit(137);
  const error = await outcome;
  expect(error?.message).toContain("session capture subprocess exceeded 5ms");
});

test("runReadSessionWorker flushes success and error envelopes before exit", async () => {
  const events: string[] = [];
  await runReadSessionWorker(["--read-session-worker", "ws://success"], {
    async readSession() { return "exact bundle"; },
    async write(value) { events.push(`write:${value}`); },
    exit(code) { events.push(`exit:${code}`); },
  });
  expect(events).toEqual([
    `write:${encodeReadSessionResult({ ok: true, bundle: "exact bundle" })}`,
    "exit:0",
  ]);

  events.length = 0;
  await runReadSessionWorker(["--read-session-worker", "ws://failure"], {
    async readSession() { throw new Error("worker capture failed"); },
    async write(value) { events.push(`write:${value}`); },
    exit(code) { events.push(`exit:${code}`); },
  });
  expect(events).toEqual([
    `write:${encodeReadSessionResult({ ok: false, error: "worker capture failed" })}`,
    "exit:1",
  ]);
});

test("readSessionInSubprocess does not serialize captures across profiles", async () => {
  const exitResolvers: Array<(code: number) => void> = [];
  let spawned = 0;
  const reads = Array.from({ length: 64 }, (_, index) => readSessionInSubprocess(`ws://capture/${index}`, {
    spawn: () => {
      spawned++;
      let resolveExit!: (code: number) => void;
      const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
      exitResolvers.push(resolveExit);
      return {
        stdout: textStream(encodeReadSessionResult({ ok: true, bundle: `bundle-${index}` })),
        stderr: textStream(""),
        exited,
        kill() {},
      };
    },
  }));

  await Promise.resolve();
  expect(spawned).toBe(64);
  for (const resolve of exitResolvers) resolve(0);
  expect(await Promise.all(reads)).toEqual(Array.from({ length: 64 }, (_, index) => `bundle-${index}`));
});

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

test("writeSessionToBrowser restores cookie auth without opening a cookie-platform origin", async () => {
  let opened = false;
  let cleared = false;
  let injected: any[] = [];
  let currentUrl = "about:blank";
  const context = {
    pages: () => [],
    async newPage() {
      opened = true;
      return {
        async goto(url: string) { currentUrl = url; },
        url: () => currentUrl,
        async evaluate() {},
        async close() {},
      };
    },
    async route() {},
    async unroute() {},
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

  expect(opened).toBe(false);
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

  await writeSession("ws://verified-browser", JSON.stringify({ cookies: [] }), {
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
    JSON.stringify({ cookies: [] }),
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
    JSON.stringify({ cookies: [] }),
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

test("normalizeOriginStorage rejects unknown origins and drops entries with nothing usable", () => {
  expect(normalizeOriginStorage("https://evil.com", { localStorage: [{ name: "a", value: "b" }] })).toBeNull();
  expect(normalizeOriginStorage("https://web.telegram.org", {})).toBeNull();
  expect(normalizeOriginStorage("https://web.telegram.org", { localStorage: [] })).toBeNull();
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

test("normalizeOriginStorage rejects origin storage for cookie-auth platforms", () => {
  const storage = {
    localStorage: [{ name: "auth", value: "value" }],
    indexedDB: [{ name: "cache", version: 1, stores: [] }],
  };
  expect(normalizeOriginStorage("https://x.com", storage)).toBeNull();
  expect(normalizeOriginStorage("https://www.instagram.com", storage)).toBeNull();
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

test("normalizeBundle tolerates missing/malformed input instead of throwing", () => {
  expect(normalizeBundle(null)).toEqual({ cookies: [], origins: [], hasOrigins: false });
  expect(normalizeBundle({})).toEqual({ cookies: [], origins: [], hasOrigins: false });
  expect(normalizeBundle({ cookies: "not-an-array" })).toEqual({ cookies: [], origins: [], hasOrigins: false });
});

test("normalizeBundle distinguishes a legacy cookie-only bundle from a modern one with an empty origins list", () => {
  expect(normalizeBundle({ cookies: [] }).hasOrigins).toBe(false); // legacy: no origins key at all
  expect(normalizeBundle({ cookies: [], origins: [] }).hasOrigins).toBe(true); // modern: explicitly empty
});

test("normalizeBundle keeps only Telegram origin storage and drops malformed shapes", () => {
  const bundle = normalizeBundle({
    cookies: [],
    origins: [
      { origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "live" }] },
      { origin: "https://www.instagram.com", localStorage: [{ name: "incidental", value: "state" }] },
      { origin: "https://evil.com", localStorage: [{ name: "steal", value: "me" }] },
      { localStorage: [{ name: "no-origin-field", value: "x" }] },
      null,
    ],
  });
  expect(bundle.origins).toEqual([{ origin: "https://web.telegram.org", localStorage: [{ name: "dc2_auth_key", value: "live" }] }]);
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
  expect(restored.length).toBe(1);
  expect(restored[0]).toContain("dc2_auth_key");
  // localStorage-only bundle → localStorage-only restore. It must NOT invoke Playwright's restore
  // (which deletes every IndexedDB db first) — that would wipe the target's own Telegram cache/session.
  expect(restored[0]).toContain("localStorage.setItem");
  expect(restored[0]).not.toContain("StorageScript");
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

test("restoreOriginStorage is a no-op when the bundle carries no supported origins", async () => {
  let opened = false;
  const ctx = {
    pages: () => [],
    async newPage() {
      opened = true;
      return { async goto() {}, async evaluate() {}, async close() {} };
    },
  };
  await restoreOriginStorage(ctx, [{ origin: "https://www.instagram.com", localStorage: [{ name: "x", value: "y" }] }]);
  expect(opened).toBe(false); // nothing to restore → never even opens a page
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

  expect(bundle.cookies.map((c) => c.name)).toEqual(["stel_token"]);
  expect(bundle.origins).toEqual([
    {
      origin: "https://web.telegram.org",
      localStorage: [{ name: "dc2_auth_key", value: "live" }],
    },
  ]);
  expect(bundle.telegramClient).toBe("a");
});

test("collectSessionFromContext ignores origin storage for cookie-auth platforms", async () => {
  let evaluations = 0;
  const ctx = {
    async storageState() {
      return {
        cookies: [{ name: "sessionid", value: "live", domain: ".instagram.com", path: "/" }],
        origins: [{ origin: "https://www.instagram.com", localStorage: [{ name: "incidental", value: "state" }] }],
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

  expect(bundle.cookies.map((cookie) => cookie.name)).toEqual(["sessionid"]);
  expect(bundle.origins).toEqual([]);
  expect(evaluations).toBe(0);
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
            indexedDB: [{ name: "tweb-common", version: 8, stores: [{ name: "localStorage__encrypted", records: [{ key: "data", valueEncoded: { ta: { b: "AQI=", k: "ui8" } } }] }] }],
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
  const legacyDb = { name: "tweb-account-2", version: 3, stores: [{ name: "session__encrypted", records: [
    { key: "dc4_auth_key", value: "LEGACY-AUTH" },
  ] }] };
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
  const passcodeDb = { name: "tt-passcode", version: 1, stores: [{ name: "store", records: [
    { key: "sessionEncrypted", value: [1] }, { key: "globalEncrypted", value: [2] },
  ] }] };
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
  const legacyDb = { name: "tweb", version: 2, stores: [{ name: "session", records: [
    { key: "dc2_auth_key", value: "LEGACY" },
  ] }] };
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
