import { afterEach, expect, spyOn, test } from "bun:test";
import {
  acceptCloudLegal,
  addProfileCookie,
  CloudSessionRestoreError,
  cloudSessionContextReady,
  createCloudConnector,
  fetchCloudConnector,
  revokeCloudConnector,
  cloudWorkspaceReady,
  fetchAppMode,
  fetchCloudAuth,
  fetchCloudEvents,
  fetchCloudTeam,
  fetchGroupExtensionDefaults,
  setGroupExtensionDefaults,
  cloudWorkspaceAction,
  checkProxy,
  exportProfiles,
  fetchProfiles,
  fetchPublishedScript,
  fetchPublishedScripts,
  fetchScriptLibraryInfo,
  fetchScripts,
  importPublishedScript,
  openProfile,
  publishScript,
  scriptsDesktopAvailable,
  startScriptRun,
  unpublishScript,
  restoreCloudSession,
  selectAppMode,
  signInCloud,
  signOutCloud,
  updateProfile,
} from "./api.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("dashboard API reports an HTML/version mismatch instead of a JSON SyntaxError", async () => {
  globalThis.fetch = (async () => new Response("<!doctype html><title>AliasMode</title>", {
    status: 200,
    headers: { "content-type": "text/html" },
  })) as unknown as typeof fetch;

  await expect(fetchProfiles()).rejects.toThrow("dashboard and local server may be on different versions");
  await expect(openProfile("profile1")).rejects.toThrow("returned non-JSON");
});

test("dashboard API distinguishes an HTML server crash from a version mismatch", async () => {
  globalThis.fetch = (async () => new Response("<!doctype html><title>Internal Server Error</title>", {
    status: 500,
    headers: { "content-type": "text/html" },
  })) as unknown as typeof fetch;

  await expect(fetchProfiles()).rejects.toThrow("local server failed before it could return JSON");
});

test("dashboard profile roster rejects malformed JSON shape explicitly", async () => {
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
  await expect(fetchProfiles()).rejects.toThrow("no profile roster");
});

test("profile export reports the server error", async () => {
  globalThis.fetch = (async () => Response.json(
    { ok: false, error: "Cloud profile could not be downloaded" },
    { status: 502 },
  )) as unknown as typeof fetch;

  await expect(exportProfiles(["profile1"], "txt")).rejects.toThrow(
    "Cloud profile could not be downloaded",
  );
});

test("profile export reads split progress records and downloads the exact file bytes", async () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const records = [
    { type: "progress", completed: 0, total: 2 },
    { type: "progress", completed: 2, total: 2 },
    { type: "file", mime: "application/octet-stream", data: Buffer.from(bytes).toString("base64") },
  ].map((record) => JSON.stringify(record) + "\n").join("");
  let request: any;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(String(init?.body));
    return new Response(new ReadableStream({ start(controller) {
      const encoded = new TextEncoder().encode(records);
      for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.slice(i, i + 7));
      controller.close();
    } }), { headers: { "content-type": "application/x-ndjson" } });
  }) as typeof fetch;
  const progress: unknown[] = [];
  let downloaded: Blob | undefined;
  let clicks = 0;
  const anchor = { href: "", download: "", click() { clicks++; }, remove() {} };
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: () => anchor, body: { appendChild() {} },
  } });
  const create = spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    downloaded = blob as Blob;
    return "blob:synthetic";
  });
  const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  try {
    await exportProfiles(["p1", "p2"], "xlsx", (value) => progress.push(value));
    expect(request).toEqual({ ids: ["p1", "p2"], format: "xlsx", stream: true });
    expect(progress).toEqual([{ completed: 0, total: 2 }, { completed: 2, total: 2 }]);
    expect(new Uint8Array(await downloaded!.arrayBuffer())).toEqual(bytes);
    expect(anchor.download).toBe("aliasmode-export.xlsx");
    expect(clicks).toBe(1);
  } finally {
    create.mockRestore();
    revoke.mockRestore();
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("profile export rejects streamed errors and incomplete files", async () => {
  for (const body of [
    '{"type":"progress","completed":1,"total":2}\n',
    '{"type":"file","mime":"text/plain","data":"YWJj"}',
    '{"type":"error","error":"Cloud export failed"}\n',
  ]) {
    globalThis.fetch = (async () => new Response(body, {
      headers: { "content-type": "application/x-ndjson" },
    })) as unknown as typeof fetch;
    await expect(exportProfiles(["p1", "p2"], "txt")).rejects.toThrow(
      body.includes('"error"') ? "Cloud export failed" : "Export interrupted",
    );
  }
});

test("dashboard roster carries health and group metadata while tolerating an older local server", async () => {
  globalThis.fetch = (async () => Response.json({
    profiles: [{ id: "p1", healthStatus: "suspended", healthObservedAt: 1_000 }],
    healthSources: [{ sourceId: "node-a", lastSnapshotAt: 1_000, stale: false }],
    groups: ["Empty group"],
  })) as unknown as typeof fetch;
  const roster = await fetchProfiles();
  expect(roster.profiles[0]).toMatchObject({ id: "p1", healthStatus: "suspended", healthObservedAt: 1_000 });
  expect(roster.healthSources).toEqual([{ sourceId: "node-a", lastSnapshotAt: 1_000, stale: false }]);
  expect(roster.groups).toEqual(["Empty group"]);

  globalThis.fetch = (async () => Response.json({ profiles: [{ id: "legacy" }] })) as unknown as typeof fetch;
  const legacy = await fetchProfiles();
  expect(legacy.profiles[0]).toMatchObject({ id: "legacy" });
  expect(legacy.healthSources).toEqual([]);
  expect(legacy.groups).toEqual([]);
});

test("dashboard adds one cookie through a same-origin JSON request", async () => {
  let input: RequestInfo | URL | undefined;
  let init: RequestInit | undefined;
  globalThis.fetch = (async (nextInput: RequestInfo | URL, nextInit?: RequestInit) => {
    input = nextInput;
    init = nextInit;
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;

  const cookie = { name: "session", value: "private", domain: "example.com", path: "/" };
  await expect(addProfileCookie("profile/id", cookie)).resolves.toEqual({ ok: true });
  expect(input).toBe("/ui/api/profiles/profile%2Fid/cookies");
  expect(init?.method).toBe("POST");
  expect(init?.headers).toEqual({ "Content-Type": "application/json" });
  expect(JSON.parse(String(init?.body))).toEqual(cookie);
});

test("dashboard checks an unsaved proxy through same-origin JSON", async () => {
  let input: RequestInfo | URL | undefined;
  let init: RequestInit | undefined;
  globalThis.fetch = (async (nextInput: RequestInfo | URL, nextInit?: RequestInit) => {
    input = nextInput;
    init = nextInit;
    return Response.json({
      ok: true,
      status: "working",
      attempts: 3,
      successes: 3,
      ip: "203.0.113.20",
      country: "US",
      rotating: false,
      ignored: "server-only field",
    });
  }) as unknown as typeof fetch;

  const proxy = {
    type: "socks5",
    host: "proxy.example",
    port: "1080",
    user: "proxy-user",
    pass: "private-password",
  };
  await expect(checkProxy(proxy)).resolves.toEqual({
    status: "working",
    attempts: 3,
    successes: 3,
    ip: "203.0.113.20",
    country: "US",
    rotating: false,
  });
  expect(input).toBe("/ui/api/proxy/check");
  expect(init?.method).toBe("POST");
  expect(init?.headers).toEqual({ "Content-Type": "application/json" });
  expect(JSON.parse(String(init?.body))).toEqual({ proxy });
});

test("proxy check client rejects errors and malformed results without exposing credentials", async () => {
  globalThis.fetch = (async () => Response.json(
    { ok: false, error: "private-password was rejected" },
    { status: 400 },
  )) as unknown as typeof fetch;
  const invalid = await checkProxy({ host: "proxy.example", port: "8080", pass: "private-password" })
    .catch((error) => error);
  expect(invalid).toMatchObject({
    name: "ProxyCheckError",
    message: "Proxy check failed",
    kind: "invalid",
  });

  globalThis.fetch = (async () => Response.json(
    { ok: false, error: "private-password reached an unavailable checker" },
    { status: 503 },
  )) as unknown as typeof fetch;
  const unavailable = await checkProxy({ host: "proxy.example", port: "8080" }).catch((error) => error);
  expect(unavailable).toMatchObject({
    name: "ProxyCheckError",
    message: "Proxy check failed",
    kind: "unavailable",
  });

  globalThis.fetch = (async () => Response.json({
    ok: true,
    status: "unknown",
    attempts: 3,
    successes: 3,
    password: "private-password",
  })) as unknown as typeof fetch;
  await expect(checkProxy({ host: "proxy.example", port: "8080" }))
    .rejects.toThrow("Proxy check returned invalid data");
});

test("app mode client reads first-launch state", async () => {
  globalThis.fetch = (async () => Response.json({
    version: 1,
    mode: "unconfigured",
    localAnalytics: false,
  })) as unknown as typeof fetch;
  expect(await fetchAppMode()).toEqual({ version: 1, mode: "unconfigured", localAnalytics: false });
});

test("Cloud diagnostics client accepts only the fixed event schema", async () => {
  let requested: RequestInfo | URL | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = input;
    return Response.json({
      events: [{ timestamp: 123, type: "session_restore_context_timeout" }],
    });
  }) as unknown as typeof fetch;

  expect(await fetchCloudEvents()).toEqual([
    { timestamp: 123, type: "session_restore_context_timeout" },
  ]);
  expect(requested).toBe("/ui/api/cloud-events");

  globalThis.fetch = (async () => Response.json({
    events: [{ timestamp: 123, type: "open_failed", message: "raw server secret" }],
  })) as unknown as typeof fetch;
  await expect(fetchCloudEvents()).rejects.toThrow("invalid data");

  globalThis.fetch = (async () => Response.json({
    events: [{ timestamp: 123, type: "unknown" }],
  })) as unknown as typeof fetch;
  await expect(fetchCloudEvents()).rejects.toThrow("invalid data");
});

test("Cloud auth client reads status and sends credentials as JSON", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    if (!init) return Response.json({ ok: true, authenticated: false });
    return Response.json({
      ok: true,
      authenticated: true,
      refreshToken: "refresh-token",
      user: { id: "account1", email: "user@example.com" },
    });
  }) as unknown as typeof fetch;

  expect(await fetchCloudAuth()).toEqual({
    authenticated: false,
    expiresAt: undefined,
    user: undefined,
    workspace: undefined,
    legal: undefined,
  });
  expect(await signInCloud("user@example.com", "password", "queue-key")).toMatchObject({ authenticated: true });
  expect(requests[1]?.input).toBe("/ui/api/cloud-auth/signin");
  expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
    email: "user@example.com",
    password: "password",
    queueKey: "queue-key",
  });
  await restoreCloudSession("refresh-token", "device-credential", "queue-key");
  expect(requests[2]?.input).toBe("/ui/api/cloud-auth/restore");
  expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
    refreshToken: "refresh-token",
    deviceCredential: "device-credential",
    queueKey: "queue-key",
  });
  await acceptCloudLegal();
  expect(requests[3]?.input).toBe("/ui/api/cloud-auth/accept-legal");
  await signOutCloud();
  expect(requests[4]?.input).toBe("/ui/api/cloud-auth/signout");
  expect(JSON.parse(String(requests[4]?.init?.body))).toEqual({});
});

test("Remote MCP settings client sends only explicit connector actions", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    const request = JSON.parse(String(init?.body));
    return Response.json(request.action === "create"
      ? {
          ok: true,
          state: "active",
          connectorId: "connector-1",
          deviceId: "device-1",
          url: "https://cloud.aliasmode.com/v1/mcp/devices/device-1",
          token: "one-time-token",
        }
      : { ok: true, state: request.action === "status" ? "active" : "disabled" });
  }) as unknown as typeof fetch;

  expect(await createCloudConnector()).toMatchObject({ connectorId: "connector-1", token: "one-time-token" });
  expect(await fetchCloudConnector("connector-1")).toMatchObject({ state: "active" });
  expect(await revokeCloudConnector("connector-1")).toMatchObject({ state: "disabled" });
  expect(requests.map((request) => request.input)).toEqual([
    "/ui/api/cloud-connector",
    "/ui/api/cloud-connector",
    "/ui/api/cloud-connector",
  ]);
  expect(requests.map((request) => JSON.parse(String(request.init?.body)))).toEqual([
    { action: "create" },
    { action: "status", connectorId: "connector-1" },
    { action: "revoke", connectorId: "connector-1" },
  ]);
});

test("Cloud restore can request startup lifecycle recovery", async () => {
  let body: unknown;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ ok: true, authenticated: true, refreshToken: "rotated" });
  }) as unknown as typeof fetch;

  await restoreCloudSession("refresh", "device", "queue", true);
  expect(body).toEqual({
    refreshToken: "refresh",
    deviceCredential: "device",
    queueKey: "queue",
    resumeLifecycle: true,
  });
});

test("Cloud restore client preserves safe retry metadata", async () => {
  globalThis.fetch = (async () => Response.json({
    ok: false,
    error: "Saved Cloud session could not be restored. Try again when the connection is available.",
    stage: "cloud_status",
    retryable: true,
    category: "network",
    code: "network_unavailable",
  }, { status: 503 })) as unknown as typeof fetch;

  try {
    await restoreCloudSession("secret-refresh", "secret-device", "secret-queue-key");
    throw new Error("expected restore to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CloudSessionRestoreError);
    expect(error).toMatchObject({
      stage: "cloud_status",
      retryable: true,
      category: "network",
      code: "network_unavailable",
    });
    expect(JSON.stringify(error)).not.toContain("secret-refresh");
    expect(JSON.stringify(error)).not.toContain("secret-device");
    expect(JSON.stringify(error)).not.toContain("secret-queue-key");
  }
});

test("Cloud team client uses the compact workspace endpoint", async () => {
  const requests: RequestInit[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init) requests.push(init);
    return Response.json({ ok: true, folders: [], members: [], invitations: [] });
  }) as unknown as typeof fetch;
  expect(await fetchCloudTeam()).toEqual({ folders: [], members: [], invitations: [] });
  await cloudWorkspaceAction("grant", { folderName: "Sales", accountId: "a1", permission: "view" });
  expect(JSON.parse(String(requests[0]?.body))).toEqual({
    action: "grant", folderName: "Sales", accountId: "a1", permission: "view",
  });
});


test("Cloud startup requires complete saved-session context", () => {
  const legal = {
    current: { terms: "v2", privacy: "v2", acceptableUse: "v2" },
    accepted: null,
  };
  const workspace = {
    id: "workspace1",
    name: "Workspace",
    ownerAccountId: "account1",
    role: "member" as const,
  };
  expect(cloudSessionContextReady({ authenticated: true })).toBe(false);
  expect(cloudSessionContextReady({ authenticated: true, workspace })).toBe(false);
  expect(cloudSessionContextReady({ authenticated: true, legal })).toBe(false);
  expect(cloudSessionContextReady({ authenticated: true, workspace, legal })).toBe(true);
});

test("Cloud workspace becomes ready only after current legal acceptance", () => {
  const current = { terms: "v2", privacy: "v2", acceptableUse: "v2" };
  expect(cloudWorkspaceReady({ authenticated: true, legal: { current, accepted: null } })).toBe(false);
  expect(cloudWorkspaceReady({
    authenticated: true,
    legal: {
      current,
      accepted: { terms: "v1", privacy: "v2", acceptableUse: "v2", acceptedAt: 1 },
    },
  })).toBe(false);
  expect(cloudWorkspaceReady({
    authenticated: true,
    legal: { current, accepted: { ...current, acceptedAt: 1 } },
  })).toBe(true);
});

test("profile update forwards Cloud expectedVersion and response status", async () => {
  let body: unknown;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ ok: false, error: "reload required" }, { status: 409 });
  }) as unknown as typeof fetch;

  const result = await updateProfile("profile1", { name: "Changed" }, 7);
  expect(body).toEqual({ set: { name: "Changed" }, expectedVersion: 7 });
  expect(result).toMatchObject({ ok: false, error: "reload required", status: 409 });
});

test("group extension defaults client reads and replaces exact selections", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return init
      ? Response.json({ ok: true, updatedCount: 2 })
      : Response.json({
          ok: true,
          groups: [{ name: "Sales", extensions: ["ext-1"], permission: "edit" }],
        });
  }) as unknown as typeof fetch;

  expect(await fetchGroupExtensionDefaults()).toEqual([
    { name: "Sales", extensions: ["ext-1"], permission: "edit" },
  ]);
  expect(await setGroupExtensionDefaults("Sales", ["ext-2"])).toEqual({ ok: true, updatedCount: 2 });
  expect(requests.map((request) => request.input)).toEqual([
    "/ui/api/groups/extensions",
    "/ui/api/groups/extensions",
  ]);
  expect(requests[1]?.init?.method).toBe("POST");
  expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ group: "Sales", extensions: ["ext-2"] });
});

test("app mode client sends Cloud selection with JSON", async () => {
  let input: RequestInfo | URL | undefined;
  let init: RequestInit | undefined;
  globalThis.fetch = (async (nextInput: RequestInfo | URL, nextInit?: RequestInit) => {
    input = nextInput;
    init = nextInit;
    return Response.json({ ok: true, restartRequired: true });
  }) as unknown as typeof fetch;

  await selectAppMode("cloud");
  expect(input).toBe("/ui/api/app-mode");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({ mode: "cloud" });
});

test("scripts require the desktop capability and send it on every request", async () => {
  const originalWindow = (globalThis as any).window;
  const calls: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke: async (command: string) => { calls.push(command); return "test-capability"; } } },
  });
  const requests: Array<{ path: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (path: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ path, init });
    return Response.json(init?.method === "POST"
      ? { ok: true, run: { id: "run-1", scriptName: "Check", status: "running", profiles: [] } }
      : { ok: true, scripts: [] });
  }) as unknown as typeof fetch;
  try {
    expect(scriptsDesktopAvailable()).toBe(true);
    await fetchScripts();
    await startScriptRun({ scriptId: "script-1", profileIds: ["profile-1"], inputs: {}, useCredentials: false });
    expect(calls).toEqual(["script_capability", "script_capability"]);
    expect(requests.map((request) => request.path)).toEqual(["/ui/api/scripts", "/ui/api/scripts/run"]);
    expect(requests.map((request) => new Headers(request.init?.headers).get("Authorization"))).toEqual([
      "Bearer test-capability", "Bearer test-capability",
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      scriptId: "script-1", profileIds: ["profile-1"], inputs: {}, useCredentials: false,
    });
  } finally {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("public script library calls use the desktop capability and exact contracts", async () => {
  const originalWindow = (globalThis as any).window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke: async () => "test-capability" } },
  });
  const requests: Array<{ path: RequestInfo | URL; init?: RequestInit }> = [];
  const publication = { id: "public-1", name: "Public", description: "", language: "python", authorName: "Author", authorEmail: null, sourceRevision: 2, publishedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  globalThis.fetch = (async (path: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ path, init });
    const url = String(path);
    if (url.includes("/library?") || url.endsWith("/library")) return Response.json({ ok: true, scripts: [publication], nextOffset: null });
    if (url.endsWith("/import")) return Response.json({ ok: true, script: { ...publication, source: "print('copy')", revision: 1, createdAt: publication.publishedAt } });
    if (url.includes("/library/")) return Response.json({ ok: true, script: { ...publication, source: "print('source')" } });
    if (url.endsWith("/publication")) return Response.json({ ok: true, ...(init?.method === "DELETE" ? { unpublished: true } : { script: { ...publication, source: "print('source')" } }) });
    return Response.json({ ok: true, scripts: [], canPublish: true, publicationDefaults: { authorName: "Author" } });
  }) as typeof fetch;
  try {
    await expect(fetchScriptLibraryInfo()).resolves.toEqual({ scripts: [], canPublish: true, publicationDefaults: { authorName: "Author" } });
    await expect(fetchScripts()).resolves.toEqual([]);
    await expect(fetchPublishedScripts({ q: "hello world", language: "python", offset: 50 })).resolves.toMatchObject({ scripts: [publication], nextOffset: null });
    await expect(fetchPublishedScript("public/id")).resolves.toMatchObject({ ...publication, source: "print('source')" });
    await expect(importPublishedScript("public/id")).resolves.toMatchObject({ id: "public-1", source: "print('copy')" });
    await expect(publishScript("private/id", { expectedRevision: 2, authorName: "Author", showEmail: false })).resolves.toMatchObject(publication);
    await expect(unpublishScript("private/id")).resolves.toBeUndefined();
    expect(requests.map((request) => request.path)).toEqual([
      "/ui/api/scripts",
      "/ui/api/scripts",
      "/ui/api/scripts/library?q=hello+world&language=python&offset=50",
      "/ui/api/scripts/library/public%2Fid",
      "/ui/api/scripts/library/public%2Fid/import",
      "/ui/api/scripts/private%2Fid/publication",
      "/ui/api/scripts/private%2Fid/publication",
    ]);
    expect(requests.map((request) => new Headers(request.init?.headers).get("Authorization"))).toEqual([
      "Bearer test-capability", "Bearer test-capability", "Bearer test-capability", "Bearer test-capability", "Bearer test-capability", "Bearer test-capability", "Bearer test-capability",
    ]);
    expect(requests.map((request) => request.init?.method)).toEqual([undefined, undefined, undefined, undefined, "POST", "PUT", "DELETE"]);
    expect(JSON.parse(String(requests[5]?.init?.body))).toEqual({ expectedRevision: 2, authorName: "Author", showEmail: false });
    expect(new Headers(requests[6]?.init?.headers).get("Content-Type")).toBe("application/json");
    expect(requests[6]?.init?.body).toBe("{}");
  } finally {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});
