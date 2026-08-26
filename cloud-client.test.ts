import { expect, test } from "bun:test";
import { CloudApiError, CloudClient, CloudRequestError, type CloudFetch } from "./cloud-client.ts";
import type { PortableProfileV1 } from "./contracts/cloud-v1.ts";

const payload: PortableProfileV1 = {
  schemaVersion: 1,
  profile: {
    id: "profile/1",
    accId: "",
    name: "Profile",
    group: "",
    platform: "x.com",
    username: "user",
    password: "pass",
    email: "",
    emailPassword: "",
    twofa: "",
    proxy: null,
    extensionAssignments: [],
    tags: [],
    ua: "ua",
    timezone: "UTC",
    screenWidth: 1920,
    screenHeight: 1080,
    fingerprintSeed: 1,
  },
  session: { cookies: [] },
};

function client(fetchFn: CloudFetch, timeout = 1_000) {
  return new CloudClient({
    baseUrl: "https://cloud.aliasmode.test/",
    accessToken: () => "access-token",
    deviceCredential: () => "device-token",
    fetchFn,
    requestTimeoutMs: timeout,
  });
}

test("Cloud client rejects insecure non-loopback service URLs", () => {
  expect(() => new CloudClient({
    baseUrl: "http://cloud.example",
    accessToken: () => "token",
  })).toThrow("AliasMode Cloud URL must use HTTPS");
});

test("Cloud client sends bearer and device credentials to versioned endpoints", async () => {
  let url = "";
  let request: RequestInit | undefined;
  const cloud = client(async (nextUrl, init) => {
    url = String(nextUrl);
    request = init;
    return Response.json({
      ok: true,
      registrationId: "registration-1",
      baseVersion: 4,
      payload,
      activeOpens: [],
    });
  });

  await cloud.openProfile("profile/1", { deviceId: "device-1" });
  expect(url).toBe("https://cloud.aliasmode.test/v1/profiles/profile%2F1/open");
  const headers = new Headers(request?.headers);
  expect(headers.get("authorization")).toBe("Bearer access-token");
  expect(headers.get("x-aliasmode-device")).toBe("device-token");
  expect(headers.get("content-type")).toBe("application/json");
  expect(request?.method).toBe("POST");
  expect(JSON.parse(String(request?.body))).toEqual({ deviceId: "device-1" });
});

test("Cloud client encodes folder and account path segments", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const cloud = client(async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(init?.method === "PUT"
      ? { ok: true, grant: { folderName: "Sales / US", accountId: "account/1", permission: "view" } }
      : { ok: true, folder: { name: "Sales", archivedAt: null, permission: "edit" } });
  });
  await cloud.renameFolder("Sales / US", "Sales");
  await cloud.setFolderGrant("Sales / US", "account/1", "view");
  expect(calls.map((call) => call.url)).toEqual([
    "https://cloud.aliasmode.test/v1/workspace/folders/Sales%20%2F%20US",
    "https://cloud.aliasmode.test/v1/workspace/folders/Sales%20%2F%20US/grants/account%2F1",
  ]);
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ name: "Sales" });
  expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ permission: "view" });
});

test("Cloud client uses invitation and move request shapes", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const cloud = client(async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ ok: true });
  });
  await cloud.createInvitation("person@example.com", "member");
  await cloud.acceptInvitation("pasted-code");
  await cloud.moveProfile("profile/1", { destination: "Sales", expectedVersion: 4 });
  expect(calls.map((call) => [call.url, call.init?.method, JSON.parse(String(call.init?.body))])).toEqual([
    ["https://cloud.aliasmode.test/v1/workspace/invitations", "POST", { email: "person@example.com", role: "member" }],
    ["https://cloud.aliasmode.test/v1/invitations/accept", "POST", { code: "pasted-code" }],
    ["https://cloud.aliasmode.test/v1/profiles/profile%2F1/move", "POST", { destination: "Sales", expectedVersion: 4 }],
  ]);
});

test("Cloud client manages device-scoped MCP connectors", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const cloud = client(async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(String(url).endsWith("/mcp/connectors") && init?.method === "POST"
      ? { ok: true, connector: {}, token: "returned-once" }
      : String(url).endsWith("/mcp/connectors")
        ? { ok: true, connectors: [] }
        : { ok: true });
  });
  await cloud.createMcpConnector("Linux Claude");
  await cloud.listMcpConnectors();
  await cloud.revokeMcpConnector("connector/1");
  expect(cloud.remoteMcpUrl("device/1")).toBe("https://cloud.aliasmode.test/v1/mcp/devices/device%2F1");
  expect(calls.map((call) => [call.url, call.init?.method ?? "GET"])).toEqual([
    ["https://cloud.aliasmode.test/v1/mcp/connectors", "POST"],
    ["https://cloud.aliasmode.test/v1/mcp/connectors", "GET"],
    ["https://cloud.aliasmode.test/v1/mcp/connectors/connector%2F1", "DELETE"],
  ]);
  expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ label: "Linux Claude" });
});

test("Cloud client rejects calls without an in-memory access token", async () => {
  const cloud = new CloudClient({
    baseUrl: "https://cloud.aliasmode.test",
    accessToken: () => undefined,
    fetchFn: async () => { throw new Error("must not fetch"); },
  });
  await expect(cloud.status()).rejects.toMatchObject({
    name: "CloudApiError",
    code: "authentication_required",
    status: 401,
  });
});

test("Cloud client exposes structured revocation errors", async () => {
  const cloud = client(async () => Response.json({
    ok: false,
    error: { code: "device_revoked", message: "This device was revoked" },
  }, { status: 403 }));
  try {
    await cloud.heartbeat("registration-1");
    throw new Error("expected heartbeat to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CloudApiError);
    expect(error).toMatchObject({ code: "device_revoked", status: 403 });
  }
});

test("Cloud close returns a terminal version conflict without retrying", async () => {
  let calls = 0;
  const cloud = client(async () => {
    calls++;
    return Response.json({
      ok: false,
      error: { code: "version_conflict", message: "stale", currentVersion: 8 },
    }, { status: 409 });
  });
  expect(await cloud.closeOpen("registration-1", { expectedVersion: 7, payload })).toEqual({
    ok: false,
    error: { code: "version_conflict", message: "stale", currentVersion: 8 },
  });
  expect(calls).toBe(1);
});

test("Cloud close rejects malformed conflicts without a current version", async () => {
  const cloud = client(async () => Response.json({
    ok: false,
    error: { code: "version_conflict", message: "stale" },
  }, { status: 409 }));
  await expect(cloud.closeOpen("registration-1", { expectedVersion: 7, payload }))
    .rejects.toThrow("missing currentVersion");
});

test("Cloud client imports one profile batch and invalidates its roster cache", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const rosterRequests: Array<string | null> = [];
  const cloud = client(async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/profiles/import")) {
      return Response.json({ ok: true, imported: 2, ids: ["profile1", "profile2"] }, { status: 201 });
    }
    rosterRequests.push(new Headers(init?.headers).get("if-none-match"));
    return Response.json({ ok: true, profiles: [] }, { headers: { etag: `"roster-${rosterRequests.length}"` } });
  });
  const first = structuredClone(payload);
  first.profile.id = "profile1";
  const second = structuredClone(payload);
  second.profile.id = "profile2";

  await cloud.listProfiles();
  expect(await cloud.importProfiles({ destination: "Sales", profiles: [first, second] })).toEqual({
    ok: true,
    imported: 2,
    ids: ["profile1", "profile2"],
  });
  await cloud.listProfiles();

  expect(calls[1]!.url).toBe("https://cloud.aliasmode.test/v1/profiles/import");
  expect(calls[1]!.init?.method).toBe("POST");
  expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ destination: "Sales", profiles: [first, second] });
  expect(rosterRequests).toEqual([null, null]);
});

test("Cloud profile roster reuses its per-client ETag cache", async () => {
  const requests: Array<string | null> = [];
  const roster = { ok: true as const, profiles: [] };
  let calls = 0;
  const cloud = client(async (_url, init) => {
    requests.push(new Headers(init?.headers).get("if-none-match"));
    calls++;
    if (calls === 1) return Response.json(roster, { headers: { etag: '"roster-1"' } });
    return new Response(null, { status: 304, headers: { etag: '"roster-1"' } });
  });

  expect(await cloud.listProfiles()).toEqual(roster);
  expect(await cloud.listProfiles()).toEqual(roster);
  expect(requests).toEqual([null, '"roster-1"']);
});

test("Cloud client preserves HTTP status for non-JSON failures", async () => {
  const cloud = client(async () => new Response("<html>failure</html>", {
    status: 502,
    headers: { "content-type": "text/html" },
  }));
  await expect(cloud.listProfiles()).rejects.toMatchObject({
    name: "CloudApiError",
    code: "internal_error",
    status: 502,
    message: "AliasMode Cloud /profiles returned non-JSON (502, text/html)",
  });
});

test("Cloud client classifies fetch failures without losing their cause", async () => {
  const failure = new TypeError("fetch failed");
  const cloud = client(async () => { throw failure; });
  try {
    await cloud.status();
    throw new Error("expected status to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CloudRequestError);
    expect(error).toMatchObject({ failure: { kind: "transport", retryable: true }, cause: failure });
  }
});

test("Cloud client bounds fetch implementations that ignore abort", async () => {
  const cloud = client(() => new Promise<Response>(() => {}), 5);
  await expect(cloud.status()).rejects.toMatchObject({
    message: expect.stringContaining("timed out after 5ms"),
    failure: { kind: "timeout", retryable: true },
  });
});
