import { expect, test } from "bun:test";
import { CloudApiError } from "./cloud-client.ts";
import { CloudProfileEditor } from "./cloud-profile-editor.ts";
import type { PortableProfileV1 } from "./contracts/cloud-v1.ts";

function payload(): PortableProfileV1 {
  return {
    schemaVersion: 1,
    profile: {
      id: "cloud1",
      accId: "account-1",
      name: "Cloud profile",
      group: "group-1",
      platform: "x.com",
      username: "account-user",
      password: "account-password",
      email: "mail@example.com",
      emailPassword: "mail-password",
      twofa: "TOTPSEED",
      proxy: { type: "http", host: "proxy.example", port: "8080", user: "proxy-user", pass: "proxy-pass" },
      extensionAssignments: ["ext-1"],
      tags: ["tag-1"],
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/143.0.0.0 Safari/537.36",
      timezone: "Etc/UTC",
      screenWidth: 1680,
      screenHeight: 1050,
      fingerprintSeed: 1234,
    },
    session: {
      cookies: [{ name: "auth_token", value: "session-secret", domain: ".x.com", path: "/" }],
      origins: [{ origin: "https://x.com", localStorage: [{ name: "token", value: "origin-secret" }] }],
      telegramClient: "k",
    },
  };
}

function response(version = 7, activeOpens: unknown[] = []) {
  return {
    ok: true as const,
    profile: {
      id: "cloud1",
      name: "Cloud profile",
      group: "group-1",
      platform: "x.com",
      tags: ["tag-1"],
      version,
      trashedAt: null,
      trashedBy: null,
      updatedAt: 1,
      activeOpens,
    },
    payload: payload(),
    payloadDigest: "digest",
  } as any;
}

function readOnlyStore(launch: unknown = null) {
  return new Proxy({
    getLaunch(profileId: string) {
      expect(profileId).toBe("cloud1");
      return launch;
    },
  }, {
    get(target, property, receiver) {
      if (property !== "getLaunch") throw new Error(`local store method ${String(property)} must not be used`);
      return Reflect.get(target, property, receiver);
    },
  }) as any;
}

test("Cloud editor closedProfileVersion reuses authoritative and local open guards", async () => {
  const cloud = { getProfile: async () => response(9) } as any;
  await expect(new CloudProfileEditor(cloud, readOnlyStore()).closedProfileVersion("cloud1")).resolves.toBe(9);
  await expect(new CloudProfileEditor(cloud, readOnlyStore({ profileId: "cloud1" })).closedProfileVersion("cloud1"))
    .rejects.toMatchObject({ status: 409 });
  await expect(new CloudProfileEditor({ getProfile: async () => response(9, [{}]) } as any, readOnlyStore()).closedProfileVersion("cloud1"))
    .rejects.toMatchObject({ status: 409 });
});


test("Cloud editor GET returns only editable data and the authoritative version", async () => {
  const cloud = new Proxy({
    async getProfile(profileId: string) {
      expect(profileId).toBe("cloud1");
      return response();
    },
  }, {
    get(target, property, receiver) {
      if (property !== "getProfile") throw new Error(`Cloud method ${String(property)} must not be used`);
      return Reflect.get(target, property, receiver);
    },
  }) as any;

  const view = await new CloudProfileEditor(cloud, readOnlyStore()).get("cloud1");
  expect(view).toMatchObject({
    id: "cloud1",
    name: "Cloud profile",
    username: "account-user",
    cookieCount: 1,
    expectedVersion: 7,
  });
  const json = JSON.stringify(view);
  expect(json).not.toContain("session-secret");
  expect(json).not.toContain("origin-secret");
  expect(json).not.toContain('"session"');
});

test("Cloud editor save forwards the version once and preserves session and unedited payload fields", async () => {
  const authoritative = response();
  (authoritative.payload as any).futureTopLevel = { retained: true };
  (authoritative.payload.profile as any).futureProfileField = "retained";
  (authoritative.payload.profile as any).proxyError = "legacy proxy error";
  (authoritative.payload.session as any).futureSessionField = "retained";
  let updateCalls = 0;
  let updateRequest: any;
  const cloud = new Proxy({
    async getProfile() {
      return authoritative;
    },
    async updateProfile(profileId: string, request: unknown) {
      updateCalls++;
      expect(profileId).toBe("cloud1");
      updateRequest = request;
      return { ok: true, profile: { ...authoritative.profile, version: 8 }, payloadDigest: "next" };
    },
  }, {
    get(target, property, receiver) {
      if (property !== "getProfile" && property !== "updateProfile") {
        throw new Error(`Cloud method ${String(property)} must not be used`);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as any;

  await new CloudProfileEditor(cloud, readOnlyStore()).save("cloud1", 7, {
    name: "Renamed",
    resolution: "1920*1080",
    proxyType: "https",
    proxy: "next-proxy.example:8443:next-user:next-pass",
  });

  expect(updateCalls).toBe(1);
  expect(updateRequest.expectedVersion).toBe(7);
  expect(updateRequest.payload.profile).toMatchObject({
    name: "Renamed",
    group: "group-1",
    fingerprintSeed: 1234,
    screenWidth: 1920,
    screenHeight: 1080,
    timezone: "",
    proxy: { type: "https", host: "next-proxy.example", port: "8443", user: "next-user", pass: "next-pass" },
    futureProfileField: "retained",
  });
  expect(updateRequest.payload.profile.proxyError).toBeUndefined();
  expect(updateRequest.payload.futureTopLevel).toEqual({ retained: true });
  expect(updateRequest.payload.session).toEqual(authoritative.payload.session);
  expect(updateRequest.payload.session.futureSessionField).toBe("retained");
});

test("Cloud editor moves folders before saving metadata with the incremented version", async () => {
  const authoritative = response();
  const calls: unknown[] = [];
  const cloud = {
    getProfile: async () => authoritative,
    moveProfile: async (profileId: string, request: unknown) => {
      calls.push(["move", profileId, request]);
      authoritative.profile.version++;
      return { ok: true, profile: authoritative.profile };
    },
    updateProfile: async (profileId: string, request: any) => {
      calls.push(["update", profileId, request.expectedVersion, request.payload.profile.group]);
    },
  } as any;

  await new CloudProfileEditor(cloud, readOnlyStore()).save("cloud1", 7, {
    group: "group-2",
    name: "Renamed",
  });

  expect(calls).toEqual([
    ["move", "cloud1", { destination: "group-2", expectedVersion: 7 }],
    ["update", "cloud1", 8, "group-2"],
  ]);
});

test("Cloud editor does not move when the folder is unchanged", async () => {
  let moveCalls = 0;
  let updateVersion: number | undefined;
  const cloud = {
    getProfile: async () => response(),
    moveProfile: async () => { moveCalls++; },
    updateProfile: async (_profileId: string, request: any) => { updateVersion = request.expectedVersion; },
  } as any;

  await new CloudProfileEditor(cloud, readOnlyStore()).save("cloud1", 7, { group: "group-1", name: "Renamed" });

  expect(moveCalls).toBe(0);
  expect(updateVersion).toBe(7);
});

test("Cloud editor preserves timezone when the submitted proxy is unchanged", async () => {
  const authoritative = response();
  let updated: any;
  const cloud = {
    getProfile: async () => authoritative,
    updateProfile: async (_profileId: string, request: unknown) => { updated = request; },
  } as any;

  await new CloudProfileEditor(cloud, readOnlyStore()).save("cloud1", 7, {
    name: "Renamed",
    proxyType: "http",
    proxy: "proxy.example:8080:proxy-user:proxy-pass",
  });

  expect(updated.payload.profile.timezone).toBe("Etc/UTC");
  expect(updated.payload.profile.proxy).toEqual(authoritative.payload.profile.proxy);
});

test("Cloud editor does not retry a PATCH version conflict", async () => {
  let updateCalls = 0;
  const cloud = {
    async getProfile() {
      return response();
    },
    async updateProfile() {
      updateCalls++;
      throw new CloudApiError("version conflict", "version_conflict", 409, 8);
    },
  } as any;

  await expect(new CloudProfileEditor(cloud, readOnlyStore()).save("cloud1", 7, { name: "Renamed" }))
    .rejects.toMatchObject({ code: "version_conflict", status: 409 });
  expect(updateCalls).toBe(1);
});

test("Cloud editor rejects authoritative active opens and exact local launches", async () => {
  const activeCloud = { getProfile: async () => response(7, [{}]) } as any;
  await expect(new CloudProfileEditor(activeCloud, readOnlyStore()).get("cloud1"))
    .rejects.toMatchObject({ status: 409 });

  let updateCalls = 0;
  const localCloud = {
    getProfile: async () => response(),
    updateProfile: async () => { updateCalls++; },
  } as any;
  const launch = { profileId: "cloud1", debugPort: 9222, startedAt: 1 };
  await expect(new CloudProfileEditor(localCloud, readOnlyStore(launch)).save("cloud1", 7, { name: "Renamed" }))
    .rejects.toMatchObject({ status: 409 });
  expect(updateCalls).toBe(0);
});

test("Cloud editor rejects a stale expected version before PATCH", async () => {
  let updateCalls = 0;
  const cloud = {
    getProfile: async () => response(8),
    updateProfile: async () => { updateCalls++; },
  } as any;
  await expect(new CloudProfileEditor(cloud, readOnlyStore()).save("cloud1", 7, { name: "Renamed" }))
    .rejects.toMatchObject({ status: 409 });
  expect(updateCalls).toBe(0);
});
