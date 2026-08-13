import { afterEach, expect, test } from "bun:test";
import {
  acceptCloudLegal,
  cloudWorkspaceReady,
  fetchAppMode,
  fetchCloudAuth,
  fetchCloudEvents,
  fetchCloudTeam,
  cloudWorkspaceAction,
  fetchProfiles,
  openProfile,
  restoreCloudSession,
  selectAppMode,
  signInCloud,
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

test("dashboard roster carries health metadata and tolerates an older local server", async () => {
  globalThis.fetch = (async () => Response.json({
    profiles: [{ id: "p1", healthStatus: "suspended", healthObservedAt: 1_000 }],
    healthSources: [{ sourceId: "node-a", lastSnapshotAt: 1_000, stale: false }],
  })) as unknown as typeof fetch;
  const roster = await fetchProfiles();
  expect(roster.profiles[0]).toMatchObject({ id: "p1", healthStatus: "suspended", healthObservedAt: 1_000 });
  expect(roster.healthSources).toEqual([{ sourceId: "node-a", lastSnapshotAt: 1_000, stale: false }]);

  globalThis.fetch = (async () => Response.json({ profiles: [{ id: "legacy" }] })) as unknown as typeof fetch;
  const legacy = await fetchProfiles();
  expect(legacy.profiles[0]).toMatchObject({ id: "legacy" });
  expect(legacy.healthSources).toEqual([]);
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
