import { test, expect } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "./store.ts";
import { Launcher } from "./launcher.ts";
import { parseExport } from "./parse.ts";
import { listUiProfiles, handleUiRequest } from "./ui.ts";
import { readXlsx, writeXlsx } from "./xlsx.ts";
import { AppConfigStore } from "./app-config.ts";
import { CloudAuthRuntime } from "./cloud-auth.ts";
import type { CloudConnectionRuntime } from "./cloud-connection.ts";
import { PendingSyncRuntime } from "./pending-sync.ts";
import { EmailVerificationRequiredError, SupabaseAuthRequestError, type SupabaseAuthClient } from "./supabase-auth.ts";
import { CloudApiError, CloudRequestError } from "./cloud-client.ts";
import { encodePortableProfile } from "./portable-profile.ts";
import type { Profile } from "./types.ts";

const SAMPLE = `id=k1d0cd11
name=sophia
group=va1
username=account-user
password=SECRETpw
email=mailbox@example.com
emailpassword=MAILSECRETpw
fakey=TOTPSEED
cookie=[{"name":"auth_token","value":"COOKIEVAL","domain":".x.com","path":"/","expires":4070908800}]
proxytype=http
proxy=1.2.3.4:8080:proxyuser:PROXYPASS
ua=Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/143.0.0.0 Safari/537.36
resolution=1680*1050
******************`;

function store(): ProfileStore {
  const s = new ProfileStore(":memory:");
  for (const p of parseExport(SAMPLE).profiles) s.upsertProfile(p);
  return s;
}

function timezoneFetch(timezones: Record<string, string>, calls?: string[][]) {
  return async (_url: string, init: RequestInit) => {
    const queries = (JSON.parse(String(init.body)) as Array<{ query: string }>).map((item) => item.query);
    calls?.push(queries);
    return {
      async json() {
        return queries.map((query) => timezones[query]
          ? { query, timezone: timezones[query], status: "success" }
          : { query, status: "fail" });
      },
    };
  };
}

const EXTENSION_ZIP = Buffer.from(
  "UEsDBBQAAAAAAFtxHl1SmQ+hOwAAADsAAAANAAAAbWFuaWZlc3QuanNvbnsibWFuaWZlc3RfdmVyc2lvbiI6MywibmFtZSI6IlJvdXRlIEZpeHR1cmUiLCJ2ZXJzaW9uIjoiMSJ9UEsBAhQDFAAAAAAAW3EeXVKZD6E7AAAAOwAAAA0AAAAAAAAAAAAAAIABAAAAAG1hbmlmZXN0Lmpzb25QSwUGAAAAAAEAAQA7AAAAZgAAAAAA",
  "base64",
);

function extensionId(publicKey: Uint8Array): string {
  const digest = createHash("sha256").update(publicKey).digest();
  return [...digest.subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
}

const extensionKeys = generateKeyPairSync("rsa", { modulusLength: 1024 });
const extensionPublicKey = new Uint8Array(
  extensionKeys.publicKey.export({ format: "der", type: "spki" }),
);

function extensionCrx(): Uint8Array {
  const signature = new Uint8Array(sign("sha1", EXTENSION_ZIP, extensionKeys.privateKey));
  const header = new Uint8Array(16);
  header.set(new TextEncoder().encode("Cr24"));
  const view = new DataView(header.buffer);
  view.setUint32(4, 2, true);
  view.setUint32(8, extensionPublicKey.length, true);
  view.setUint32(12, signature.length, true);
  const out = new Uint8Array(header.length + extensionPublicKey.length + signature.length + EXTENSION_ZIP.length);
  out.set(header);
  out.set(extensionPublicKey, header.length);
  out.set(signature, header.length + extensionPublicKey.length);
  out.set(EXTENSION_ZIP, header.length + extensionPublicKey.length + signature.length);
  return out;
}

function extensionResponse(): Response {
  const bytes = extensionCrx();
  return new Response(bytes.buffer as ArrayBuffer);
}

test("listUiProfiles exposes metadata but redacts every secret", () => {
  const s = store();
  const list = listUiProfiles(s);
  const p = list[0]!;
  expect(p.proxy).toBe("1.2.3.4:8080"); // host:port only
  expect(p.cookieCount).toBe(1);
  expect(p.screen).toBe("1680x1050");
  expect(p.running).toBe(false);

  const json = JSON.stringify(list);
  for (const secret of ["account-user", "SECRETpw", "MAILSECRETpw", "mailbox@example.com", "TOTPSEED", "COOKIEVAL", "PROXYPASS", "proxyuser"]) {
    expect(json.includes(secret)).toBe(false);
  }
  s.close();
});

test("a quarantined legacy proxy stays visible and repairable without exposing credentials", async () => {
  const s = store();
  const raw = JSON.stringify({ type: "socks4", host: "legacy.example", port: "1080", user: "legacy-user", pass: "legacy-pass" });
  (s as any)["db"].query("UPDATE profiles SET proxy_json = ? WHERE id = ?").run(raw, "k1d0cd11");

  const roster = listUiProfiles(s);
  expect(roster).toHaveLength(1);
  expect(roster[0]!.proxy).toBeNull();
  expect(roster[0]!.proxyError).toContain("unsupported proxy type");
  expect(JSON.stringify(roster)).not.toContain("legacy-pass");

  const response = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11"),
    {} as any,
    s,
  );
  const edit = (await response!.json()).profile;
  expect(edit.proxy).toBe("");
  expect(edit.proxyError).toContain("unsupported proxy type");
  s.close();
});

test("full profile edit keeps account and mailbox credentials in separate fields", async () => {
  const s = store();
  const response = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11"),
    {} as any,
    s,
  );
  const edit = (await response!.json()).profile;
  expect(edit).toMatchObject({
    username: "account-user",
    password: "SECRETpw",
    email: "mailbox@example.com",
    emailPassword: "MAILSECRETpw",
    twofa: "TOTPSEED",
  });
  const updated = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      body: JSON.stringify({ set: {
        username: "account-user", password: "linkedin-pass",
        email: "new-mail@example.com", emailPassword: "new-mail-pass", twofa: "NEWSEED",
      } }),
    }),
    {} as any,
    s,
  );
  expect(updated!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")).toMatchObject({
    username: "account-user", password: "linkedin-pass",
    email: "new-mail@example.com", emailPassword: "new-mail-pass", twofa: "NEWSEED",
  });
  s.close();
});

test("listUiProfiles reflects running status from the launches table", () => {
  const s = store();
  s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://x", startedAt: 123 });
  const p = listUiProfiles(s)[0]!;
  expect(p.running).toBe(true);
  expect(p.debugPort).toBe(9412);
  s.close();
});

test("open/close routes call the launcher", async () => {
  const s = store();
  const calls: string[] = [];
  const launcher: any = {
    start: async (id: string) => { calls.push(`start:${id}`); return { ws: "ws://x", port: 9333 }; },
    stop: async (id: string) => { calls.push(`stop:${id}`); return true; },
  };
  const open = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/open", { method: "POST" }), launcher, s);
  expect((await open!.json()).ok).toBe(true);
  const close = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/close", { method: "POST" }), launcher, s);
  expect((await close!.json()).ok).toBe(true);
  expect(calls).toEqual(["start:k1d0cd11", "stop:k1d0cd11"]);
  s.close();
});

test("cookie route adds one persistent cookie to an active Cloud browser without changing imports", async () => {
  const s = store();
  const importedCookies = structuredClone(s.getProfile("k1d0cd11")!.cookies);
  s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://live-browser", startedAt: 123 });
  const appConfig = new AppConfigStore(join(mkdtempSync(join(tmpdir(), "aliasmode-ui-cookie-")), "config.json"));
  appConfig.setMode("cloud", "https://cloud.aliasmode.test");
  const calls: Array<{ ws: string; cookie: any }> = [];
  const startedAt = Math.floor(Date.now() / 1_000);

  const response = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://x" },
      body: JSON.stringify({
        name: "session",
        value: "private-cookie-value",
        domain: "https://Example.com/account",
        path: "/account",
      }),
    }),
    { certifiedActive: async () => true } as any,
    s,
    null,
    {
      appConfig,
      cloudBrowser: {} as any,
      addCookie: async (ws: string, cookie: any) => { calls.push({ ws, cookie }); },
    } as any,
  );

  expect(response!.status).toBe(200);
  expect(await response!.json()).toEqual({ ok: true });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    ws: "ws://live-browser",
    cookie: {
      name: "session",
      value: "private-cookie-value",
      domain: "example.com",
      path: "/account",
      secure: true,
      sameSite: "Lax",
    },
  });
  expect(calls[0]!.cookie.expires).toBeGreaterThanOrEqual(startedAt + 31_536_000);
  expect(calls[0]!.cookie.expires).toBeLessThanOrEqual(Math.floor(Date.now() / 1_000) + 31_536_000);
  expect(s.getProfile("k1d0cd11")!.cookies).toEqual(importedCookies);
  s.close();
});

test("cookie route rejects untrusted, malformed, and closed-browser requests", async () => {
  const s = store();
  let certifications = 0;
  let writes = 0;
  const launcher = { certifiedActive: async () => { certifications++; return false; } } as any;
  const options = { addCookie: async () => { writes++; } } as any;

  const untrusted = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
    method: "POST",
    headers: { "content-type": "text/plain", origin: "https://outside.invalid" },
    body: "{}",
  }), launcher, s, null, options);
  expect(untrusted!.status).toBe(415);

  const crossOrigin = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://outside.invalid" },
    body: JSON.stringify({ name: "session", value: "value", domain: "example.com", path: "/" }),
  }), launcher, s, null, options);
  expect(crossOrigin!.status).toBe(403);

  for (const body of [
    { name: "", value: "value", domain: "example.com", path: "/" },
    { name: "bad name", value: "value", domain: "example.com", path: "/" },
    { name: "bad=name", value: "value", domain: "example.com", path: "/" },
    { name: "name", value: "bad;value", domain: "example.com", path: "/" },
    { name: "name", value: "value", domain: "", path: "/" },
    { name: "name", value: "value", domain: "example.com", path: "account" },
  ]) {
    const malformed = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }), launcher, s, null, options);
    expect(malformed!.status).toBe(400);
  }

  const closed = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "session", value: "value", domain: "example.com", path: "/" }),
  }), launcher, s, null, options);
  expect(closed!.status).toBe(409);
  expect(await closed!.json()).toEqual({ ok: false, error: "profile browser is not open" });
  expect(certifications).toBe(1);
  expect(writes).toBe(0);
  s.close();
});

test("cookie route never returns the cookie value or a raw worker error", async () => {
  const s = store();
  s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://live-browser", startedAt: 123 });
  const secret = "private-cookie-value";
  const response = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "session", value: secret, domain: "example.com", path: "/" }),
  }), { certifiedActive: async () => true } as any, s, null, {
    addCookie: async () => { throw new Error(`worker rejected ${secret}`); },
  } as any);
  const body = await response!.text();

  expect(response!.status).toBe(500);
  expect(body).toContain("cookie could not be added");
  expect(body).not.toContain(secret);
  expect(body).not.toContain("worker rejected");
  s.close();
});

test("raise route brings Local and Cloud browsers to the front", async () => {
  const s = store();
  const calls: string[] = [];
  const launcher = {
    async bringToFront(id: string) { calls.push(id); },
  } as any;

  const local = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/raise", { method: "POST" }),
    launcher,
    s,
  );
  expect(local!.status).toBe(200);
  expect(await local!.json()).toEqual({ ok: true });

  const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-cloud-raise-"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  appConfig.setMode("cloud", "https://cloud.aliasmode.test");
  const cloud = await handleUiRequest(
    new Request("http://x/ui/api/profiles/cloud1/raise", { method: "POST" }),
    launcher,
    s,
    null,
    { appConfig, cloudBrowser: {} as any },
  );
  expect(cloud!.status).toBe(200);
  expect(await cloud!.json()).toEqual({ ok: true });
  expect(calls).toEqual(["k1d0cd11", "cloud1"]);
  s.close();
});

test("remote open returns an advisory warning as a success", async () => {
  const s = store();
  const remote: any = {
    open: async () => ({
      ok: true,
      port: 9333,
      warning: "Possible concurrent use; session sync is disabled for this browser.",
    }),
  };
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/open", { method: "POST" }),
    {} as any,
    s,
    remote,
  );
  expect(res!.status).toBe(200);
  expect(await res!.json()).toEqual({
    ok: true,
    port: 9333,
    warning: "Possible concurrent use; session sync is disabled for this browser.",
  });
  s.close();
});

test("open on an unknown profile 404s without touching the launcher", async () => {
  const s = store();
  const launcher: any = { start: async () => { throw new Error("must not be called"); } };
  const res = await handleUiRequest(new Request("http://x/ui/api/profiles/nope/open", { method: "POST" }), launcher, s);
  expect(res!.status).toBe(404);
  s.close();
});

test("GET /ui/api/health is independent of launcher and hub state", async () => {
  const s = store();
  const res = await handleUiRequest(
    new Request("http://x/ui/api/health"),
    new Proxy({}, { get: () => { throw new Error("launcher must not be touched"); } }) as any,
    s,
    new Proxy({}, { get: () => { throw new Error("hub must not be touched"); } }) as any,
  );
  expect(res!.status).toBe(200);
  expect(await res!.json()).toMatchObject({ ok: true, version: expect.any(String), root: import.meta.dir });
  s.close();
});

test("GET /ui/api/health uses desktop parent metadata when supplied", async () => {
  const s = store();
  const health = { version: "0.1.0-beta.1", root: "C:\\AliasMode", instance: "ab".repeat(32) };
  const res = await handleUiRequest(
    new Request("http://x/ui/api/health"),
    {} as any,
    s,
    null,
    { health },
  );
  expect(await res!.json()).toEqual({ ok: true, ...health });
  s.close();
});

test("GET /ui/api/profiles clears a stale launch row before reporting status", async () => {
  const s = store();
  // A launch row whose browser is gone (crash / external teardown).
  s.recordLaunch({
    profileId: "k1d0cd11",
    pid: 99999,
    debugPort: 9999,
    ws: "ws://x",
    startedAt: 1,
    binaryPath: "/fake",
    userDataDir: "/tmp/ui-recon/k1d0cd11",
    processGroupId: 99999,
    rootStartTime: "1",
  });
  const launcher = new Launcher({
    store: s,
    binaryPath: "/fake",
    unsafeDisableIdentityGates: true,
    dataRoot: "/tmp/ui-recon",
    spawn: () => ({ pid: 1, kill() {} }),
    fetch: async () => ({ ok: false, json: async () => ({}) }), // CDP port is dead
    ensureCookies: async () => ({ injected: false }),
    killPid: async () => {},
    isPidAlive: () => false,
    findOwnedBrowserPids: async () => [],
    cdpReadyTimeoutMs: 100,
  });

  const res = await handleUiRequest(new Request("http://x/ui/api/profiles"), launcher, s);
  const body = await res!.json();
  expect(body.profiles[0].running).toBe(false); // not shown as running
  expect(body.healthSources).toEqual([]);
  expect(s.getLaunch("k1d0cd11")).toBeNull(); // stale row reconciled away
  s.close();
});

test("GET /ui/api/profiles carries remote health and node freshness through local launch overlays", async () => {
  const s = store();
  const launcher: any = { reconcileOrphans: async () => {} };
  const remote: any = {
    listRoster: async () => ({
      profiles: [{
        id: "k1d0cd11",
        name: "sophia",
        group: "va1",
        healthStatus: "suspended",
        healthObservedAt: 1_000,
      }],
      healthSources: [{ sourceId: "node-a", lastSnapshotAt: 1_000, stale: false }],
    }),
  };

  const res = await handleUiRequest(new Request("http://x/ui/api/profiles"), launcher, s, remote);
  expect(await res!.json()).toEqual({
    profiles: [{
      id: "k1d0cd11",
      name: "sophia",
      group: "va1",
      healthStatus: "suspended",
      healthObservedAt: 1_000,
      running: false,
    }],
    healthSources: [{ sourceId: "node-a", lastSnapshotAt: 1_000, stale: false }],
  });
  s.close();
});

test("GET /ui/api/profiles returns a JSON error when remote roster loading fails", async () => {
  const s = store();
  const launcher: any = { reconcileOrphans: async () => {} };
  const remote: any = { listRoster: async () => { throw new Error("hub roster unavailable"); } };

  const res = await handleUiRequest(new Request("http://x/ui/api/profiles"), launcher, s, remote);
  expect(res!.status).toBe(502);
  expect(res!.headers.get("content-type")).toContain("application/json");
  const body = await res!.json();
  expect(body.error).toBe("profile roster failed: hub roster unavailable");
  s.close();
});

test("GET /ui/api/profiles returns a JSON error when local reconciliation fails", async () => {
  const s = store();
  const launcher: any = { reconcileOrphans: async () => { throw new Error("process scan unavailable"); } };

  const res = await handleUiRequest(new Request("http://x/ui/api/profiles"), launcher, s);
  expect(res!.status).toBe(500);
  expect(res!.headers.get("content-type")).toContain("application/json");
  expect((await res!.json()).error).toBe("profile roster failed: process scan unavailable");
  s.close();
});

test("Local group creation keeps an empty group in the profile roster", async () => {
  const s = store();
  const created = await handleUiRequest(
    new Request("http://x/ui/api/groups/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Empty group" }),
    }),
    {} as any,
    s,
  );
  expect(created!.status).toBe(200);
  expect(await created!.json()).toEqual({ ok: true, name: "Empty group" });

  const reserved = await handleUiRequest(
    new Request("http://x/ui/api/groups/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "all" }),
    }),
    {} as any,
    s,
  );
  expect(reserved!.status).toBe(400);

  const roster = await handleUiRequest(
    new Request("http://x/ui/api/profiles"),
    { reconcileOrphans: async () => {} } as any,
    s,
  );
  expect((await roster!.json()).groups).toContain("Empty group");
  s.close();
});

test("move route reassigns selected profiles' group", async () => {
  const s = store();
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/move", { method: "POST", body: JSON.stringify({ ids: ["k1d0cd11"], group: "newgrp" }) }),
    {} as any,
    s,
  );
  const body = await res!.json();
  expect(body.ok).toBe(true);
  expect(body.moved).toBe(1);
  expect(listUiProfiles(s)[0]!.group).toBe("newgrp");
  s.close();
});

test("move route with no ids is a 400", async () => {
  const s = store();
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/move", { method: "POST", body: JSON.stringify({ ids: [], group: "x" }) }),
    {} as any,
    s,
  );
  expect(res!.status).toBe(400);
  s.close();
});

test("upload route imports profiles from posted files", async () => {
  const s = new ProfileStore(":memory:");
  // No proxy line → geoip is skipped (no network in the test).
  const NOPROXY = `id=k1up0001\nname=uploaded\ngroup=ug\ncookie=[]\nresolution=1280*720\n******************`;
  const form = new FormData();
  form.append("files", new File([NOPROXY], "export.txt", { type: "text/plain" }));
  const res = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: form }),
    {} as any,
    s,
  );
  const body = await res!.json();
  expect(body.ok).toBe(true);
  expect(body.profiles).toBe(1);
  expect(s.getProfile("k1up0001")!.group).toBe("ug");
  s.close();
});

test("upload route atomically imports two AdsPower profiles from one pasted file", async () => {
  const s = new ProfileStore(":memory:");
  const ADSPOWER = `id=k1up0002\nname=first\ngroup=ug\ncookie=[]\nresolution=1280*720\n******************\nid=k1up0003\nname=second\ngroup=ug\ncookie=[]\nresolution=1280*720\n******************`;
  const form = new FormData();
  form.append("files", new File([ADSPOWER], "pasted-adspower.txt", { type: "text/plain" }));
  const res = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: form }),
    {} as any,
    s,
  );
  expect(res!.status).toBe(200);
  expect(await res!.json()).toMatchObject({ ok: true, files: 1, profiles: 2 });
  expect(s.count()).toBe(2);
  expect(s.getProfile("k1up0002")).not.toBeNull();
  expect(s.getProfile("k1up0003")).not.toBeNull();
  s.close();
});

test("upload route rejects a malformed AdsPower record without partial writes", async () => {
  const s = store();
  const beforeCount = s.count();
  const ADSPOWER = `id=k1up0002\nname=first\ngroup=ug\ncookie=[]\nresolution=1280*720\n******************\nid=k1up0003\nname=second\ngroup=ug\ncookie=[]\nresolution=0x0\n******************`;
  const form = new FormData();
  form.append("files", new File([ADSPOWER], "pasted-adspower.txt", { type: "text/plain" }));
  const res = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: form }),
    {} as any,
    s,
  );
  expect(res!.status).toBe(500);
  expect((await res!.json()).error).toContain("invalid resolution");
  expect(s.count()).toBe(beforeCount);
  expect(s.getProfile("k1up0002")).toBeNull();
  expect(s.getProfile("k1up0003")).toBeNull();
  s.close();
});

test("upload route applies group override in local mode", async () => {
  const s = new ProfileStore(":memory:");
  const NOPROXY = `id=k1up0001\nname=uploaded\ngroup=fromfile\ncookie=[]\nresolution=1280*720\n******************`;
  const form = new FormData();
  form.append("group", "selected");
  form.append("files", new File([NOPROXY], "export.txt", { type: "text/plain" }));
  const res = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: form }),
    {} as any,
    s,
  );
  expect((await res!.json()).ok).toBe(true);
  expect(s.getProfile("k1up0001")!.group).toBe("selected");
  s.close();
});

test("upload route sends one parsed batch to Cloud without writing the Local store", async () => {
  const s = new ProfileStore(":memory:");
  const appConfig = new AppConfigStore(join(mkdtempSync(join(tmpdir(), "aliasmode-ui-cloud-import-")), "config.json"));
  appConfig.setMode("cloud", "https://cloud.aliasmode.test");
  const batches: Array<{ destination: string; profiles: any[] }> = [];
  const cloudBrowser = {
    async importProfiles(destination: string, profiles: any[]) {
      batches.push({ destination, profiles: structuredClone(profiles) });
      return { ok: true, imported: profiles.length, ids: profiles.map((profile) => profile.id) };
    },
  } as any;
  const form = new FormData();
  form.append("group", "Sales");
  form.append("platform", "telegram.org");
  form.append("files", new File([
    `id=cloudimp1\nname=First\ngroup=from-file\ncookie=[]\nresolution=1280*720\n******************\n` +
    `id=cloudimp2\nname=Second\ngroup=from-file\ncookie=[]\nresolution=1280*720\n******************`,
  ], "export.txt", { type: "text/plain" }));

  const res = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: form }),
    {} as any,
    s,
    null,
    { appConfig, cloudBrowser },
  );

  expect(res!.status).toBe(200);
  expect(await res!.json()).toMatchObject({ ok: true, files: 1, profiles: 2 });
  expect(batches).toHaveLength(1);
  expect(batches[0]!.destination).toBe("Sales");
  expect(batches[0]!.profiles.map((profile) => ({ id: profile.id, group: profile.group, platform: profile.platform }))).toEqual([
    { id: "cloudimp1", group: "Sales", platform: "telegram.org" },
    { id: "cloudimp2", group: "Sales", platform: "telegram.org" },
  ]);
  expect(s.getProfile("cloudimp1")).toBeNull();
  expect(s.getProfile("cloudimp2")).toBeNull();
  s.close();
});

test("Cloud upload requires an explicit destination before parsing files", async () => {
  const s = new ProfileStore(":memory:");
  const appConfig = new AppConfigStore(join(mkdtempSync(join(tmpdir(), "aliasmode-ui-cloud-import-group-")), "config.json"));
  appConfig.setMode("cloud", "https://cloud.aliasmode.test");
  const form = new FormData();
  form.append("files", new File(["not parsed"], "export.txt", { type: "text/plain" }));
  const res = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: form }),
    {} as any,
    s,
    null,
    { appConfig, cloudBrowser: { importProfiles: async () => { throw new Error("must not import"); } } as any },
  );
  expect(res!.status).toBe(400);
  expect((await res!.json()).error).toContain("destination");
  s.close();
});

test("upload route forwards overrides in remote mode", async () => {
  const s = new ProfileStore(":memory:");
  const form = new FormData();
  form.append("group", "hubgrp");
  form.append("platform", "telegram.org");
  form.append("files", new File(["x"], "export.txt", { type: "text/plain" }));
  let gotOverride: any = null;
  const remote = {
    importToHub: async (_uploads: any, override: any) => {
      gotOverride = override;
      return { files: 1, profiles: 0 };
    },
  } as any;
  const res = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: form }),
    {} as any,
    s,
    remote,
  );
  expect((await res!.json()).ok).toBe(true);
  expect(gotOverride).toEqual({ group: "hubgrp", platform: "telegram.org" });
  s.close();
});

test("upload route with no files is a 400", async () => {
  const s = new ProfileStore(":memory:");
  const res = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: new FormData() }),
    {} as any,
    s,
  );
  expect(res!.status).toBe(400);
  s.close();
});

test("bulk update validates every row before atomically writing any profile", async () => {
  const s = store();
  const first = s.getProfile("k1d0cd11")!;
  s.upsertProfile({ ...first, id: "k1d0cd22", name: "second" });
  const csv = [
    "id,name,proxy,proxytype",
    "k1d0cd11,renamed,proxy.example:8080:u:p,http",
    "k1d0cd22,also-renamed,malformed,http",
  ].join("\n");
  const form = new FormData();
  form.append("files", new File([csv], "updates.csv", { type: "text/csv" }));

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }),
    {} as any,
    s,
  );
  const body = await res!.json();
  expect(res!.status).toBe(400);
  expect(body.updated).toBe(0);
  expect(body.errors).toEqual([{ id: "k1d0cd22", error: expect.stringContaining("proxy must be") }]);
  expect(s.getProfile("k1d0cd11")!.name).toBe("sophia");
  expect(s.getProfile("k1d0cd22")!.name).toBe("second");
  s.close();
});

test("a short CSV update row preserves omitted trailing identity fields", async () => {
  const s = store();
  const before = s.getProfile("k1d0cd11")!;
  before.timezone = "America/Los_Angeles";
  s.upsertProfile(before);
  const form = new FormData();
  form.append("files", new File([
    "id,name,proxy,proxytype,resolution\n" +
    "k1d0cd11,renamed",
  ], "updates.csv", { type: "text/csv" }));

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }),
    {} as any,
    s,
  );

  expect(res!.status).toBe(200);
  const after = s.getProfile("k1d0cd11")!;
  expect(after.name).toBe("renamed");
  expect(after.proxy).toEqual(before.proxy);
  expect(after.timezone).toBe("America/Los_Angeles");
  expect([after.screenWidth, after.screenHeight]).toEqual([before.screenWidth, before.screenHeight]);
  s.close();
});

test("bulk proxy edits resolve changed timezones in one request", async () => {
  const s = store();
  const first = s.getProfile("k1d0cd11")!;
  first.timezone = "America/Los_Angeles";
  s.upsertProfile(first);
  s.upsertProfile({ ...first, id: "k1d0cd22", name: "second" });
  const form = new FormData();
  form.append("files", new File([
    "id,proxy,proxytype\n" +
    "k1d0cd11,first-proxy.example:8080:u:p,http\n" +
    "k1d0cd22,second-proxy.example:1080:u:p,socks5",
  ], "updates.csv", { type: "text/csv" }));
  const calls: string[][] = [];

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }),
    {} as any,
    s,
    null,
    { timezoneFetch: timezoneFetch({
      "first-proxy.example": "Europe/London",
      "second-proxy.example": "Asia/Tokyo",
    }, calls) },
  );

  expect(res!.status).toBe(200);
  expect(calls).toEqual([["first-proxy.example", "second-proxy.example"]]);
  expect(s.getProfile("k1d0cd11")!.timezone).toBe("Europe/London");
  expect(s.getProfile("k1d0cd22")!.timezone).toBe("Asia/Tokyo");
  s.close();
});

test("single edits reject malformed resolutions without changing stored identity", async () => {
  for (const resolution of ["", "0x0", "319x1080", "99999x1080", "1920xnope"]) {
    const s = store();
    const before = s.getProfile("k1d0cd11")!;
    const res = await handleUiRequest(
      new Request("http://x/ui/api/profiles/k1d0cd11/update", {
        method: "POST",
        body: JSON.stringify({ set: { resolution } }),
      }),
      {} as any,
      s,
    );
    expect(res!.status).toBe(500);
    expect((await res!.json()).error).toContain("invalid resolution");
    const after = s.getProfile("k1d0cd11")!;
    expect([after.screenWidth, after.screenHeight]).toEqual([before.screenWidth, before.screenHeight]);
    s.close();
  }
});

test("a malformed nonblank proxy edit is rejected without removing the existing proxy", async () => {
  const s = store();
  const before = s.getProfile("k1d0cd11")!;
  before.timezone = "America/Los_Angeles";
  s.upsertProfile(before);

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      body: JSON.stringify({ set: { proxy: "proxy.example:not-a-port" } }),
    }),
    {} as any,
    s,
  );

  expect(res!.status).toBe(500);
  expect((await res!.json()).error).toContain("invalid proxy port");
  const after = s.getProfile("k1d0cd11")!;
  expect(after.proxy).toEqual(before.proxy);
  expect(after.timezone).toBe("America/Los_Angeles");
  s.close();
});

test("a changed proxy resolves its replacement timezone before saving", async () => {
  const s = store();
  const before = s.getProfile("k1d0cd11")!;
  before.timezone = "America/Los_Angeles";
  s.upsertProfile(before);
  const calls: string[][] = [];

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      body: JSON.stringify({ set: { proxyType: "socks5", proxy: "new-proxy.example:1080:user:pass" } }),
    }),
    {} as any,
    s,
    null,
    { timezoneFetch: timezoneFetch({ "new-proxy.example": "Europe/Paris" }, calls) },
  );

  expect(res!.status).toBe(200);
  expect(calls).toEqual([["new-proxy.example"]]);
  expect(s.getProfile("k1d0cd11")).toMatchObject({
    proxy: { type: "socks5", host: "new-proxy.example", port: "1080", user: "user", pass: "pass" },
    timezone: "Europe/Paris",
  });
  s.close();
});

test("legacy remote proxy edits resolve timezone before saving without changing the local cache", async () => {
  const s = store();
  const local = s.getProfile("k1d0cd11")!;
  local.timezone = "America/Los_Angeles";
  s.upsertProfile(local);
  const remoteProfile = structuredClone(local);
  let saved: typeof remoteProfile | null = null;
  const remote = {
    async getProfile() { return structuredClone(remoteProfile); },
    async saveProfile(profile: typeof remoteProfile) { saved = structuredClone(profile); },
  } as any;

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      body: JSON.stringify({ set: { proxyType: "http", proxy: "remote-proxy.example:8080:user:pass" } }),
    }),
    {} as any,
    s,
    remote,
    { timezoneFetch: timezoneFetch({ "remote-proxy.example": "Asia/Singapore" }) },
  );

  expect(res!.status).toBe(200);
  expect(saved).toMatchObject({
    proxy: { type: "http", host: "remote-proxy.example", port: "8080", user: "user", pass: "pass" },
    timezone: "Asia/Singapore",
  });
  expect(s.getProfile("k1d0cd11")).toMatchObject({
    proxy: local.proxy,
    timezone: "America/Los_Angeles",
  });
  s.close();
});

test("an explicit blank proxy edit removes the proxy and clears its stale timezone", async () => {
  const s = store();
  const before = s.getProfile("k1d0cd11")!;
  before.timezone = "America/Los_Angeles";
  s.upsertProfile(before);
  const calls: string[][] = [];

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      body: JSON.stringify({ set: { proxy: "" } }),
    }),
    {} as any,
    s,
    null,
    { timezoneFetch: timezoneFetch({}, calls) },
  );
  expect(res!.status).toBe(200);
  expect(calls).toEqual([]);
  expect(s.getProfile("k1d0cd11")!.proxy).toBeNull();
  expect(s.getProfile("k1d0cd11")!.timezone).toBe("");
  s.close();
});

test("an IPv6 proxy round-trips through the edit view without losing its identity", async () => {
  const s = store();
  const before = s.getProfile("k1d0cd11")!;
  before.proxy = { type: "socks5", host: "2001:db8::1", port: "1080", user: "user", pass: "p:ss" };
  before.timezone = "America/New_York";
  s.upsertProfile(before);
  const calls: string[][] = [];

  const detail = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11"),
    {} as any,
    s,
  );
  const edit = (await detail!.json()).profile;
  expect(edit.proxy).toBe("[2001:db8::1]:1080:user:p:ss");

  const saved = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      body: JSON.stringify({ set: { proxy: edit.proxy, proxyType: edit.proxyType } }),
    }),
    {} as any,
    s,
    null,
    { timezoneFetch: timezoneFetch({}, calls) },
  );
  expect(saved!.status).toBe(200);
  expect(calls).toEqual([]);
  expect(s.getProfile("k1d0cd11")!.proxy).toEqual(before.proxy);
  expect(s.getProfile("k1d0cd11")!.timezone).toBe("America/New_York");
  s.close();
});

test("Chrome Web Store endpoint installs once and reuses the registered extension", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-web-store-"));
  const id = extensionId(extensionPublicKey);
  let fetches = 0;
  const request = () => new Request("http://x/ui/api/extensions/web-store", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: `https://chromewebstore.google.com/detail/fixture/${id}` }),
  });

  const first = await handleUiRequest(request(), {} as any, s, null, {
    paths: { extensions: root } as any,
    extensionFetch: async () => { fetches++; return extensionResponse(); },
  });
  expect(first!.status).toBe(200);
  expect(await first!.json()).toMatchObject({ ok: true, installed: { id, name: "Route Fixture" }, alreadyInstalled: false });
  expect(s.getExtension(id)?.loadDir).toBe(join(root, id));
  expect(existsSync(join(root, id, "manifest.json"))).toBe(true);

  const second = await handleUiRequest(request(), {} as any, s, null, {
    paths: { extensions: root } as any,
    extensionFetch: async () => { fetches++; throw new Error("must not fetch again"); },
  });
  expect(second!.status).toBe(200);
  expect(await second!.json()).toMatchObject({ ok: true, installed: { id, name: "Route Fixture" }, alreadyInstalled: true });
  expect(fetches).toBe(1);
  s.close();
});

test("Chrome Web Store endpoint leaves no registry or files after identity failure", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-web-store-"));
  const requestedId = "a".repeat(32);
  expect(requestedId).not.toBe(extensionId(extensionPublicKey));
  const response = await handleUiRequest(
    new Request("http://x/ui/api/extensions/web-store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: requestedId }),
    }),
    {} as any,
    s,
    null,
    {
      paths: { extensions: root } as any,
      extensionFetch: async () => extensionResponse(),
    },
  );

  expect(response!.status).toBe(500);
  expect(s.getExtension(requestedId)).toBeNull();
  expect(existsSync(join(root, requestedId))).toBe(false);
  s.close();
});

test("Chrome Web Store endpoint rejects cross-origin simple requests", async () => {
  const s = store();
  let fetches = 0;
  const response = await handleUiRequest(
    new Request("http://x/ui/api/extensions/web-store", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Origin: "https://example.com",
      },
      body: JSON.stringify({ source: extensionId(extensionPublicKey) }),
    }),
    {} as any,
    s,
    null,
    {
      extensionFetch: async () => {
        fetches++;
        return extensionResponse();
      },
    },
  );

  expect(response!.status).toBe(415);
  expect(fetches).toBe(0);
  expect(s.listExtensions()).toEqual([]);
  s.close();
});

test("Chrome Web Store endpoint keeps the existing remote-mode restriction", async () => {
  const s = store();
  const response = await handleUiRequest(
    new Request("http://x/ui/api/extensions/web-store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "aapbdbdomjkkjkaonfhkkikfgjllcleb" }),
    }),
    {} as any,
    s,
    {} as any,
  );
  expect(response!.status).toBe(400);
  s.close();
});

test("extension assignment is atomic and blocked when any selected profile is open", async () => {
  const s = store();
  const first = s.getProfile("k1d0cd11")!;
  s.upsertProfile({ ...first, id: "k1d0cd22", name: "second", extensions: [] });
  s.addExtension({ id: "ext-one", name: "Extension One", loadDir: "/tmp/ext-one" });
  s.recordLaunch({ profileId: "k1d0cd11", pid: 123, debugPort: 9333, ws: "ws://x", startedAt: 1 });

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/extensions", {
      method: "POST",
      body: JSON.stringify({ ids: ["k1d0cd11", "k1d0cd22"], extensionId: "ext-one", op: "add" }),
    }),
    {} as any,
    s,
  );

  expect(res!.status).toBe(409);
  expect(s.getProfile("k1d0cd11")!.extensions).toEqual([]);
  expect(s.getProfile("k1d0cd22")!.extensions).toEqual([]);
  s.close();
});

test("extension deletion cannot mutate the persona of an open profile", async () => {
  const s = store();
  s.addExtension({ id: "ext-one", name: "Extension One", loadDir: "/tmp/ext-one" });
  expect(s.assignExtension(["k1d0cd11"], "ext-one", true)).toBe(1);
  s.recordLaunch({ profileId: "k1d0cd11", pid: 123, debugPort: 9333, ws: "ws://x", startedAt: 1 });

  const res = await handleUiRequest(
    new Request("http://x/ui/api/extensions/delete", {
      method: "POST",
      body: JSON.stringify({ id: "ext-one" }),
    }),
    {} as any,
    s,
  );

  expect(res!.status).toBe(409);
  expect(s.getExtension("ext-one")).not.toBeNull();
  expect(s.getProfile("k1d0cd11")!.extensions).toEqual(["ext-one"]);
  s.close();
});

test("local edits are stored while the profile browser is open and apply next launch", async () => {
  const s = store();
  s.recordLaunch({ profileId: "k1d0cd11", pid: 123, debugPort: 9333, ws: "ws://x", startedAt: 1 });
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      body: JSON.stringify({ set: { resolution: "1366x768" } }),
    }),
    {} as any,
    s,
  );
  expect(res!.status).toBe(200);
  // The running browser is untouched; the stored fields drive the NEXT launch.
  expect([s.getProfile("k1d0cd11")!.screenWidth, s.getProfile("k1d0cd11")!.screenHeight]).toEqual([1366, 768]);
  expect(s.getLaunch("k1d0cd11")).not.toBeNull();
  s.close();
});

test("mobile persona conversion preserves the account and replaces only incoherent device fields", async () => {
  const s = store();
  const before = s.getProfile("k1d0cd11")!;
  before.ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/146.0.0.0 Mobile Safari/537.36";
  before.screenWidth = 412;
  before.screenHeight = 915;
  before.timezone = "America/New_York";
  before.tags = ["priority"];
  before.extensions = ["ext-one"];
  s.upsertProfile(before);

  const detail = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11"), {} as any, s);
  const edit = (await detail!.json()).profile;
  expect(edit.mobilePersona).toBe(true);
  expect(edit.desktopConversion.platform).toBe("windows");
  expect(edit.desktopConversion.screenChanged).toBe(true);

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/convert-mobile", { method: "POST" }),
    {} as any,
    s,
  );
  expect(res!.status).toBe(200);
  const body = await res!.json();
  expect(body).toMatchObject({ ok: true, changed: true, platform: "windows", screenChanged: true });

  const after = s.getProfile("k1d0cd11")!;
  expect(after.ua).toContain("Windows NT 10.0");
  expect(after.ua.toLowerCase()).not.toContain("mobile");
  expect(after.screenWidth).toBeGreaterThanOrEqual(1024);
  for (const key of ["id", "accId", "username", "password", "email", "emailPassword", "twofa", "proxy", "timezone", "fingerprintSeed", "cookies", "seeded", "tags", "extensions"] as const) {
    expect(after[key]).toEqual(before[key]);
  }
  s.close();
});

test("mobile persona conversion is idempotent and refuses local mutation while open", async () => {
  const s = store();
  const p = s.getProfile("k1d0cd11")!;
  p.ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148";
  s.upsertProfile(p);
  s.recordLaunch({ profileId: p.id, pid: 123, debugPort: 9333, ws: "ws://live", startedAt: 1 });

  const blocked = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/convert-mobile", { method: "POST" }),
    {} as any,
    s,
  );
  expect(blocked!.status).toBe(409);
  expect(s.getProfile(p.id)!.ua).toContain("iPhone");

  s.clearLaunch(p.id);
  const converted = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/convert-mobile", { method: "POST" }),
    {} as any,
    s,
  );
  expect((await converted!.json()).platform).toBe("macos");
  const repeated = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/convert-mobile", { method: "POST" }),
    {} as any,
    s,
  );
  expect(await repeated!.json()).toEqual({ ok: true, changed: false });
  s.close();
});

test("remote mobile persona conversion saves a fresh hub profile without touching the local cache", async () => {
  const s = store();
  const hubProfile = s.getProfile("k1d0cd11")!;
  hubProfile.ua = "Mozilla/5.0 (Linux; Android 13; Mobile) Chrome/145.0.0.0 Safari/537.36";
  let saved: typeof hubProfile | null = null;
  const remote = {
    getProfile: async () => structuredClone(hubProfile),
    saveProfile: async (profile: typeof hubProfile) => { saved = structuredClone(profile); },
  } as any;

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/convert-mobile", { method: "POST" }),
    {} as any,
    s,
    remote,
  );
  expect(res!.status).toBe(200);
  expect(saved!.ua).toContain("Windows NT 10.0");
  expect(saved!.fingerprintSeed).toBe(hubProfile.fingerprintSeed);
  expect(saved!.cookies).toEqual(hubProfile.cookies);
  expect(s.getProfile("k1d0cd11")!.ua).not.toContain("Android");
  s.close();
});

test("bulk updates reject all rows when any target profile is open", async () => {
  const s = store();
  const first = s.getProfile("k1d0cd11")!;
  s.upsertProfile({ ...first, id: "k1bulk02", name: "second-before" });
  s.recordLaunch({ profileId: "k1bulk02", pid: 123, debugPort: 9334, ws: "ws://live", startedAt: 1 });
  const form = new FormData();
  form.append("file", new File([
    [
      "id,name",
      "k1d0cd11,first-after",
      "k1bulk02,second-after",
    ].join("\n"),
  ], "updates.csv", { type: "text/csv" }));

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }),
    {} as any,
    s,
  );
  expect(res!.status).toBe(409);
  expect(s.getProfile("k1d0cd11")!.name).toBe("sophia");
  expect(s.getProfile("k1bulk02")!.name).toBe("second-before");
  s.close();
});

test("export route fails explicitly in remote mode", async () => {
  const s = new ProfileStore(":memory:");
  const res = await handleUiRequest(
    new Request("http://x/ui/api/export", { method: "POST", body: JSON.stringify({ ids: ["k1d0cd11"] }) }),
    {} as any,
    s,
    {} as any,
  );
  expect(res!.status).toBe(400);
  const body = await res!.json();
  expect(body.ok).toBe(false);
  expect(body.error).toContain("remote mode");
  s.close();
});

test("create (local mode) adds a new profile", async () => {
  const s = new ProfileStore(":memory:");
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles", { method: "POST", body: JSON.stringify({ name: "fresh", group: "g" }) }),
    {} as any,
    s,
  );
  const body = await res!.json();
  expect(body.ok).toBe(true);
  expect(s.getProfile(body.id)!.name).toBe("fresh");
  s.close();
});

test("create in remote mode delegates to the hub (not the local store)", async () => {
  const s = new ProfileStore(":memory:");
  const remote = { createProfile: async (input: any) => ({ id: "remote-" + (input.name || "x") }) } as any;
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles", { method: "POST", body: JSON.stringify({ name: "rp" }) }),
    {} as any,
    s,
    remote,
  );
  const body = await res!.json();
  expect(body.ok).toBe(true);
  expect(body.id).toBe("remote-rp");
  expect(s.getProfile("remote-rp")).toBeNull(); // went to the hub, not created locally
  s.close();
});

test("export in remote mode pulls every selected profile from the hub, not the local launch cache", async () => {
  const s = store(); // local launch cache holds only k1d0cd11
  // Two accounts that live on the hub roster but were never opened on this
  // machine — exactly what the launch cache can't serve. Selecting these and
  // exporting used to silently produce a file missing both rows.
  const base = parseExport(SAMPLE).profiles[0]!;
  const hubProfiles: Record<string, any> = {
    hub0001: { ...base, id: "hub0001", name: "alpha" },
    hub0002: { ...base, id: "hub0002", name: "bravo" },
  };
  const fetched: string[] = [];
  const remote = {
    async getProfiles(ids: string[]) {
      fetched.push(...ids);
      return ids.map((id) => hubProfiles[id]).filter(Boolean);
    },
  } as any;

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/export", {
      method: "POST",
      body: JSON.stringify({ ids: ["hub0001", "hub0002"], format: "csv" }),
    }),
    {} as any,
    s,
    remote,
  );
  expect(res!.status).toBe(200);
  expect(res!.headers.get("content-disposition")).toContain("aliasmode-export.csv");
  const text = await res!.text();
  expect(fetched).toEqual(["hub0001", "hub0002"]); // resolved against the hub, not the local store
  const rows = text.trim().split("\n");
  expect(rows.length).toBe(3); // header + both selected accounts (not just the locally-cached one)
  expect(text).toContain("hub0001");
  expect(text).toContain("hub0002");
  expect(text).not.toContain("k1d0cd11"); // the local-cache fallback is gone
  s.close();
});

test("export as xlsx returns a workbook carrying the full identity", async () => {
  const s = store();
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/export", {
      method: "POST",
      body: JSON.stringify({ ids: ["k1d0cd11"], format: "xlsx" }),
    }),
    {} as any,
    s,
    null as any,
  );
  expect(res!.status).toBe(200);
  expect(res!.headers.get("content-disposition")).toContain("aliasmode-export.xlsx");
  expect(res!.headers.get("content-type")).toContain("spreadsheetml.sheet");

  const rows = await readXlsx(new Uint8Array(await res!.arrayBuffer()));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.id).toBe("k1d0cd11");
  expect(rows[0]!.proxy).toBe("1.2.3.4:8080:proxyuser:PROXYPASS");
  expect(rows[0]!.resolution).toBe("1680*1050");
  // The identity the export exists to move: cookies and the user-agent.
  expect(JSON.parse(rows[0]!.cookie!)[0].name).toBe("auth_token");
  expect(rows[0]!.ua).toContain("Chrome/143.0.0.0");
  s.close();
});

test("export as xlsx pulls from the hub in remote mode, with secrets", async () => {
  const s = store();
  const asked: Array<[string[], boolean | undefined]> = [];
  const base = parseExport(SAMPLE).profiles[0]!;
  const remote = {
    async getProfiles(ids: string[], full?: boolean) {
      asked.push([ids, full]);
      return ids.map((id) => ({ ...base, id }));
    },
  } as any;

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/export", {
      method: "POST",
      body: JSON.stringify({ ids: ["hub0001"], format: "xlsx" }),
    }),
    {} as any,
    s,
    remote,
  );
  expect(res!.status).toBe(200);
  // A full-fidelity sheet without cookies would be a silent downgrade, so the
  // hub fetch must ask for secrets exactly as the .txt export does.
  expect(asked).toEqual([[["hub0001"], true]]);
  expect((await readXlsx(new Uint8Array(await res!.arrayBuffer())))[0]!.id).toBe("hub0001");
  s.close();
});

test("update-file accepts an edited .xlsx and applies only editable columns", async () => {
  const s = store();
  const book = await writeXlsx(
    ["id", "name", "group", "cookie"],
    [["k1d0cd11", "renamed", "NewGroup", "[]"]],
  );
  const form = new FormData();
  form.append("files", new File([book as unknown as BlobPart], "edited.xlsx"));

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }),
    {} as any,
    s,
    null as any,
  );
  const body = (await res!.json()) as any;
  expect(body.ok).toBe(true);
  expect(body.updated).toBe(1);

  const p = s.getProfile("k1d0cd11")!;
  expect(p.name).toBe("renamed");
  expect(p.group).toBe("NewGroup");
  // Identity columns stay inert on re-upload, exactly as for .txt and .csv.
  expect(p.cookies).toHaveLength(1);
  s.close();
});

test("delete (standalone) blocks an open profile without stopping it or removing its data", async () => {
  const s = store();
  const dataRoot = join("/tmp", `ui-del-${process.pid}-${s.count()}`);
  const launcher: any = {
    profileDeletionBlocked: () => true,
    stop: async () => { throw new Error("must not stop an open profile during delete"); },
    removeUserDataDir: () => { throw new Error("must not remove an open profile"); },
  };
  s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://x", startedAt: 1 });
  const dir = join(dataRoot, "k1d0cd11");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Cookies"), "logged-in");

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/delete", { method: "POST", body: JSON.stringify({ ids: ["k1d0cd11"] }) }),
    launcher,
    s,
  );
  const body = await res!.json();
  expect(res!.status).toBe(409);
  expect(body).toMatchObject({ ok: false, deleted: 0, locked: ["k1d0cd11"] });
  expect(existsSync(dir)).toBe(true);
  expect(s.getProfile("k1d0cd11")).not.toBeNull();

  rmSync(dataRoot, { recursive: true, force: true });
  s.close();
});

test("delete (standalone) keeps a mixed open and closed selection atomic", async () => {
  const s = store();
  const closedId = "closed001";
  s.upsertProfile({ ...s.getProfile("k1d0cd11")!, id: closedId, name: "closed" });
  const dataRoot = join("/tmp", `ui-del-mixed-${process.pid}-${s.count()}`);
  const openDir = join(dataRoot, "k1d0cd11");
  const closedDir = join(dataRoot, closedId);
  mkdirSync(openDir, { recursive: true });
  mkdirSync(closedDir, { recursive: true });
  writeFileSync(join(openDir, "Cookies"), "open");
  writeFileSync(join(closedDir, "Cookies"), "closed");
  s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://x", startedAt: 1 });
  const launcher: any = {
    profileDeletionBlocked: (id: string) => id === "k1d0cd11",
    stop: async () => { throw new Error("must not stop profiles during delete"); },
    removeUserDataDir: () => { throw new Error("must not mutate a blocked batch"); },
  };

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/delete", {
      method: "POST", body: JSON.stringify({ ids: [closedId, "k1d0cd11"] }),
    }),
    launcher,
    s,
  );
  expect(res!.status).toBe(409);
  expect(await res!.json()).toMatchObject({ deleted: 0, locked: ["k1d0cd11"] });
  expect(s.getProfile(closedId)).not.toBeNull();
  expect(s.getProfile("k1d0cd11")).not.toBeNull();
  expect(existsSync(closedDir)).toBe(true);
  expect(existsSync(openDir)).toBe(true);
  rmSync(dataRoot, { recursive: true, force: true });
  s.close();
});

test("delete (standalone) removes a closed profile without calling stop", async () => {
  const s = store();
  const calls: string[] = [];
  const launcher: any = {
    profileDeletionBlocked: () => false,
    stop: async () => { throw new Error("delete must not stop a profile"); },
    removeUserDataDir: (id: string) => { calls.push(id); return true; },
  };

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/delete", { method: "POST", body: JSON.stringify({ ids: ["k1d0cd11"] }) }),
    launcher,
    s,
  );

  expect(await res!.json()).toMatchObject({ ok: true, deleted: 1, locked: [] });
  expect(calls).toEqual(["k1d0cd11"]);
  expect(s.getProfile("k1d0cd11")).toBeNull();
  s.close();
});

test("delete (standalone) preserves a closed profile when data cleanup fails and allows retry", async () => {
  const s = store();
  let failCleanup = true;
  const launcher: any = {
    profileDeletionBlocked: () => false,
    removeUserDataDir: () => {
      if (failCleanup) throw new Error("cleanup failed");
      return true;
    },
  };
  const request = () => new Request("http://x/ui/api/profiles/delete", {
    method: "POST", body: JSON.stringify({ ids: ["k1d0cd11"] }),
  });

  const failed = await handleUiRequest(request(), launcher, s);
  expect(failed!.status).toBe(500);
  expect(s.getProfile("k1d0cd11")).not.toBeNull();

  failCleanup = false;
  const retried = await handleUiRequest(request(), launcher, s);
  expect(retried!.status).toBe(200);
  expect(await retried!.json()).toMatchObject({ ok: true, deleted: 1 });
  expect(s.getProfile("k1d0cd11")).toBeNull();
  s.close();
});

test("delete with an unknown id never touches the launcher (no rmSync on a crafted path)", async () => {
  const s = store();
  const launcher: any = {
    stop: async () => { throw new Error("must not be called"); },
    userDataDir: () => { throw new Error("must not be called"); },
  };
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/delete", { method: "POST", body: JSON.stringify({ ids: ["../../etc"] }) }),
    launcher,
    s,
  );
  expect((await res!.json()).deleted).toBe(0);
  s.close();
});

test("handleUiRequest returns null for non-ui paths (falls through to the AdsPower API)", async () => {
  const s = store();
  const res = await handleUiRequest(new Request("http://x/api/v1/status"), {} as any, s);
  expect(res).toBeNull();
  s.close();
});

test("app mode API exposes unconfigured first launch and persists Local selection", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-config-"));
  const appConfig = new AppConfigStore(join(root, "config.json"));

  const initial = await handleUiRequest(
    new Request("http://x/ui/api/app-mode"),
    {} as any,
    s,
    null,
    { appConfig },
  );
  expect(await initial!.json()).toEqual({ version: 1, mode: "unconfigured", localAnalytics: false });

  const selected = await handleUiRequest(
    new Request("http://x/ui/api/app-mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "local" }),
    }),
    {} as any,
    s,
    null,
    { appConfig },
  );
  expect(await selected!.json()).toEqual({
    ok: true,
    config: { version: 1, mode: "local", localAnalytics: false },
    restartRequired: true,
  });
  expect(appConfig.read().mode).toBe("local");
  s.close();
});

test("app mode API keeps restart-required state across dashboard reloads", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-config-"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  const options = { appConfig, runtimeMode: "local" as const, defaultCloudUrl: "https://cloud.aliasmode.test" };

  const selected = await handleUiRequest(
    new Request("http://x/ui/api/app-mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "cloud" }),
    }),
    {} as any,
    s,
    null,
    options,
  );
  expect(await selected!.json()).toMatchObject({ restartRequired: true });

  const reloaded = await handleUiRequest(
    new Request("http://x/ui/api/app-mode"),
    {} as any,
    s,
    null,
    options,
  );
  expect(await reloaded!.json()).toMatchObject({ mode: "cloud", restartRequired: true });
  s.close();
});

test("app mode API switches persisted Local mode to Cloud without touching Cloud runtimes", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-config-"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  appConfig.setMode("local");
  let cloudRuntimeReads = 0;
  const unavailableRuntime = new Proxy({}, {
    get() {
      cloudRuntimeReads++;
      throw new Error("mode selection must not initialize Cloud");
    },
  });

  const selected = await handleUiRequest(
    new Request("http://x/ui/api/app-mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "cloud" }),
    }),
    {} as any,
    s,
    null,
    {
      appConfig,
      defaultCloudUrl: "https://cloud.aliasmode.test",
      cloudAuth: unavailableRuntime as any,
      cloudConnection: unavailableRuntime as any,
    },
  );

  expect(await selected!.json()).toEqual({
    ok: true,
    config: {
      version: 1,
      mode: "cloud",
      cloudUrl: "https://cloud.aliasmode.test",
      localAnalytics: false,
    },
    restartRequired: true,
  });
  expect(appConfig.read().mode).toBe("cloud");
  expect(cloudRuntimeReads).toBe(0);
  s.close();
});

test("app mode API uses the packaged Cloud endpoint", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-config-"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  const response = await handleUiRequest(
    new Request("http://x/ui/api/app-mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "cloud", cloudUrl: "https://attacker.example" }),
    }),
    {} as any,
    s,
    null,
    { appConfig, defaultCloudUrl: "https://cloud.aliasmode.test" },
  );
  expect(await response!.json()).toEqual({
    ok: true,
    config: {
      version: 1,
      mode: "cloud",
      cloudUrl: "https://cloud.aliasmode.test",
      localAnalytics: false,
    },
    restartRequired: true,
  });
  const profiles = await handleUiRequest(
    new Request("http://x/ui/api/profiles"),
    {} as any,
    s,
    null,
    { appConfig },
  );
  expect(profiles!.status).toBe(503);
  expect((await profiles!.json()).error).toContain("authentication is required");
  s.close();
});

test("Cloud connector API creates, checks, and revokes only the selected connector", async () => {
  const s = store();
  const revoked: string[] = [];
  const connectors = [
    { id: "settings-connector", deviceId: "device-1", label: "AliasMode Settings", revokedAt: null },
    { id: "cli-connector", deviceId: "device-1", label: "Linux Claude", revokedAt: null },
  ];
  const client = {
    async createMcpConnector(label: string) {
      expect(label).toBe("AliasMode Settings");
      return {
        ok: true,
        connector: connectors[0],
        token: "test-connector-secret",
      };
    },
    async listMcpConnectors() { return { ok: true, connectors }; },
    async revokeMcpConnector(id: string) { revoked.push(id); return { ok: true }; },
    remoteMcpUrl(deviceId: string) { return `https://cloud.aliasmode.test/v1/mcp/devices/${deviceId}`; },
  };
  const options = {
    cloudConnection: {
      accountId: () => "account-1",
      deviceId: () => "device-1",
      client,
    } as unknown as CloudConnectionRuntime,
  };
  const request = (body: unknown) => new Request("http://x/ui/api/cloud-connector", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const created = await handleUiRequest(request({ action: "create" }), {} as any, s, null, options);
  expect(created!.headers.get("cache-control")).toBe("no-store");
  expect(await created!.json()).toEqual({
    ok: true,
    state: "active",
    connectorId: "settings-connector",
    deviceId: "device-1",
    url: "https://cloud.aliasmode.test/v1/mcp/devices/device-1",
    token: "test-connector-secret",
  });

  const active = await handleUiRequest(request({
    action: "status", connectorId: "settings-connector",
  }), {} as any, s, null, options);
  expect(await active!.json()).toEqual({
    ok: true,
    state: "active",
    url: "https://cloud.aliasmode.test/v1/mcp/devices/device-1",
  });

  const missing = await handleUiRequest(request({
    action: "status", connectorId: "unknown-connector",
  }), {} as any, s, null, options);
  expect((await missing!.json()).state).toBe("missing");

  const disabled = await handleUiRequest(request({
    action: "revoke", connectorId: "settings-connector",
  }), {} as any, s, null, options);
  expect(await disabled!.json()).toEqual({ ok: true, state: "disabled" });
  expect(revoked).toEqual(["settings-connector"]);
  expect(revoked).not.toContain("cli-connector");
  s.close();
});

test("Cloud connector API requires an authenticated trusted JSON request", async () => {
  const s = store();
  const unavailable = await handleUiRequest(new Request("http://x/ui/api/cloud-connector", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"action":"create"}',
  }), {} as any, s);
  expect(unavailable!.status).toBe(503);
  expect(unavailable!.headers.get("cache-control")).toBe("no-store");

  const unauthenticated = await handleUiRequest(new Request("http://x/ui/api/cloud-connector", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"action":"create"}',
  }), {} as any, s, null, {
    cloudConnection: {
      accountId: () => null,
      deviceId: () => null,
      client: {},
    } as unknown as CloudConnectionRuntime,
  });
  expect(unauthenticated!.status).toBe(401);
  expect(unauthenticated!.headers.get("cache-control")).toBe("no-store");

  const cloudConnection = {
    accountId: () => "account-1",
    deviceId: () => "device-1",
    client: {},
  } as unknown as CloudConnectionRuntime;
  const rejected = await handleUiRequest(new Request("http://x/ui/api/cloud-connector", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://outside.invalid" },
    body: '{"action":"create"}',
  }), {} as any, s, null, { cloudConnection });
  expect(rejected!.status).toBe(403);
  expect(rejected!.headers.get("cache-control")).toBe("no-store");
  s.close();
});

test("Cloud workspace API returns editable folders to members without loading invitations", async () => {
  const s = store();
  let invitationCalls = 0;
  const client = {
    async status() { return { workspace: { role: "member" } }; },
    async listFolders() { return { ok: true, folders: [{ name: "Sales", archivedAt: null, permission: "edit" }] }; },
    async listMembers() { return { ok: true, members: [] }; },
    async listInvitations() { invitationCalls++; throw new Error("members cannot list invitations"); },
  };
  const response = await handleUiRequest(
    new Request("http://x/ui/api/cloud-workspace"),
    {} as any,
    s,
    null,
    { cloudConnection: { client } as unknown as CloudConnectionRuntime },
  );
  expect(response!.status).toBe(200);
  expect(await response!.json()).toEqual({
    ok: true, folders: [{ name: "Sales", archivedAt: null, permission: "edit" }], members: [], invitations: [],
  });
  expect(invitationCalls).toBe(0);
  s.close();
});

test("Cloud workspace API returns pending invitations to admins", async () => {
  const s = store();
  const invitation = { id: "invite-admin", email: "next-admin@example.com", role: "admin", acceptedAt: null, revokedAt: null };
  const client = {
    async status() { return { workspace: { role: "admin" } }; },
    async listFolders() { return { ok: true, folders: [] }; },
    async listMembers() { return { ok: true, members: [] }; },
    async listInvitations() { return { ok: true, invitations: [invitation] }; },
  };
  const response = await handleUiRequest(
    new Request("http://x/ui/api/cloud-workspace"),
    {} as any,
    s,
    null,
    { cloudConnection: { client } as unknown as CloudConnectionRuntime },
  );
  expect(response!.status).toBe(200);
  expect((await response!.json()).invitations).toEqual([invitation]);
  s.close();
});

test("Cloud workspace API combines team state and forwards grants", async () => {
  const s = store();
  const calls: unknown[] = [];
  const client = {
    async status() { return { workspace: { role: "owner" } }; },
    async listFolders() { return { ok: true, folders: [{ name: "Sales", archivedAt: null, permission: "edit" }] }; },
    async listMembers() { return { ok: true, members: [] }; },
    async listInvitations() { return { ok: true, invitations: [] }; },
    async setFolderGrant(folderName: string, accountId: string, permission: string) {
      calls.push({ folderName, accountId, permission });
      return { ok: true, grant: { folderName, accountId, permission } };
    },
  };
  const options = { cloudConnection: { client } as unknown as CloudConnectionRuntime };
  const listed = await handleUiRequest(new Request("http://x/ui/api/cloud-workspace"), {} as any, s, null, options);
  expect(await listed!.json()).toEqual({
    ok: true, folders: [{ name: "Sales", archivedAt: null, permission: "edit" }], members: [], invitations: [],
  });
  const granted = await handleUiRequest(new Request("http://x/ui/api/cloud-workspace", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "grant", folderName: "Sales", accountId: "account1", permission: "view" }),
  }), {} as any, s, null, options);
  expect(granted!.status).toBe(200);
  expect(calls).toEqual([{ folderName: "Sales", accountId: "account1", permission: "view" }]);
  s.close();
});
test("Cloud workspace API forwards folder deletion and preserves Cloud conflicts", async () => {
  const s = store();
  const deleted: string[] = [];
  const client = {
    async deleteFolder(name: string) {
      deleted.push(name);
      if (name === "Used folder") {
        throw new CloudApiError("Only an empty folder can be deleted.", "workspace_conflict", 409);
      }
      return { ok: true };
    },
  };
  const options = { cloudConnection: { client } as unknown as CloudConnectionRuntime };
  const request = (name: string) => new Request("http://x/ui/api/cloud-workspace", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "delete-folder", name }),
  });

  const removed = await handleUiRequest(request("Empty folder"), {} as any, s, null, options);
  expect(removed!.status).toBe(200);
  expect(await removed!.json()).toEqual({ ok: true });
  const rejected = await handleUiRequest(request("Used folder"), {} as any, s, null, options);
  expect(rejected!.status).toBe(409);
  expect((await rejected!.json()).error).toBe("Only an empty folder can be deleted.");
  expect(deleted).toEqual(["Empty folder", "Used folder"]);
  s.close();
});

test("Cloud auth API accepts verified sign-in without exposing extra user metadata", async () => {
  const s = store();
  const cloudAuth = new CloudAuthRuntime({
    async signIn() {
      return {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresIn: 60,
        expiresAt: 61_000,
        user: {
          id: "account1",
          email: "user@example.com",
          email_confirmed_at: "verified",
          privateMetadata: "must-not-leak",
        },
      };
    },
  } as unknown as SupabaseAuthClient, () => 1_000);
  let secures = 0;
  let resumes = 0;
  const currentLegal = { terms: "1", privacy: "1", acceptableUse: "1" };
  const cloudConnection = {
    accountId() { return "account1"; },
    async bootstrap() {
      return {
        device: { id: "device1" },
        deviceCredential: "device-credential",
        legal: { current: currentLegal, accepted: null },
      };
    },
    client: {
      async status() {
        return { legal: { current: currentLegal, accepted: null } };
      },
      async acceptLegal() {
        return { ok: true, accepted: { ...currentLegal, acceptedAt: 1 } };
      },
    },
  } as unknown as CloudConnectionRuntime;
  const cloudBrowser = {
    async secureAfterAuthentication() { secures++; },
    async resumeAfterAuthentication() { resumes++; },
  } as any;
  const pendingSync = new PendingSyncRuntime(
    join(mkdtempSync(join(tmpdir(), "aliasmode-ui-pending-")), "pending.sqlite"),
  );
  const queueKey = Buffer.alloc(32, 7).toString("base64");
  const response = await handleUiRequest(
    new Request("http://x/ui/api/cloud-auth/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", password: "password", queueKey }),
    }),
    {} as any,
    s,
    null,
    { cloudAuth, cloudConnection, pendingSync, cloudBrowser },
  );
  expect(await response!.json()).toEqual({
    ok: true,
    authenticated: true,
    refreshToken: "refresh-token",
    deviceId: "device1",
    deviceCredential: "device-credential",
    expiresAt: 61_000,
    legal: { current: { terms: "1", privacy: "1", acceptableUse: "1" }, accepted: null },
    user: { id: "account1", email: "user@example.com" },
  });
  expect(cloudAuth.accessToken()).toBe("access-token");
  expect(secures).toBe(1);
  expect(resumes).toBe(0);

  const authState = await handleUiRequest(
    new Request("http://x/ui/api/cloud-auth"),
    {} as any,
    s,
    null,
    { cloudAuth, cloudConnection },
  );
  expect(await authState!.json()).toMatchObject({
    ok: true,
    authenticated: true,
    legal: { current: currentLegal, accepted: null },
  });

  const accepted = await handleUiRequest(
    new Request("http://x/ui/api/cloud-auth/accept-legal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    {} as any,
    s,
    null,
    { cloudAuth, cloudConnection, pendingSync, cloudBrowser },
  );
  expect(await accepted!.json()).toEqual({
    ok: true,
    legal: { current: currentLegal, accepted: { ...currentLegal, acceptedAt: 1 } },
  });
  expect(resumes).toBe(1);
  pendingSync.close();
  s.close();
});

test("Cloud auth routes cannot replace an active account session", async () => {
  const s = store();
  let remoteSignIns = 0;
  const cloudAuth = new CloudAuthRuntime({
    async signIn() {
      remoteSignIns++;
      return {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresIn: 60,
        expiresAt: 61_000,
        user: { id: "account1", email_confirmed_at: "verified" },
      };
    },
  } as unknown as SupabaseAuthClient, () => 1_000);
  await cloudAuth.signIn("first@example.com", "password");
  const options = {
    cloudAuth,
    cloudConnection: {} as CloudConnectionRuntime,
    pendingSync: {} as PendingSyncRuntime,
  };

  const signIn = await handleUiRequest(new Request("http://x/ui/api/cloud-auth/signin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "second@example.com", password: "password" }),
  }), {} as any, s, null, options);
  const restore = await handleUiRequest(new Request("http://x/ui/api/cloud-auth/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      refreshToken: "other-refresh-token",
      deviceCredential: "other-device-credential",
      queueKey: Buffer.alloc(32, 9).toString("base64"),
    }),
  }), {} as any, s, null, options);

  expect(signIn!.status).toBe(409);
  expect(restore!.status).toBe(409);
  expect(remoteSignIns).toBe(1);
  expect(cloudAuth.state()).toMatchObject({ authenticated: true, user: { id: "account1" } });
  s.close();
});

test("Cloud sign-out cancels a stale bootstrap without delaying the next account", async () => {
  const s = store();
  const pendingSync = new PendingSyncRuntime(
    join(mkdtempSync(join(tmpdir(), "aliasmode-ui-auth-transition-")), "pending.sqlite"),
  );
  const queueKey = Buffer.alloc(32, 7).toString("base64");
  const legal = { terms: "1", privacy: "1", acceptableUse: "1" };
  let account = 1;
  const cloudAuth = new CloudAuthRuntime({
    async signIn() {
      const id = account++;
      return {
        accessToken: `access-${id}`,
        refreshToken: `refresh-${id}`,
        expiresIn: 60,
        expiresAt: 61_000,
        user: { id: `account${id}`, email_confirmed_at: "verified" },
      };
    },
    async signOut() {},
  } as unknown as SupabaseAuthClient, () => 1_000);
  let markFirstBootstrapStarted!: () => void;
  const firstBootstrapStarted = new Promise<void>((resolve) => { markFirstBootstrapStarted = resolve; });
  let finishFirstBootstrap!: () => void;
  const firstBootstrap = new Promise<void>((resolve) => { finishFirstBootstrap = resolve; });
  let bootstrapCalls = 0;
  let accountId: string | undefined;
  const cloudConnection = {
    async bootstrap(accept: () => boolean = () => true) {
      const call = ++bootstrapCalls;
      if (call === 1) {
        markFirstBootstrapStarted();
        await firstBootstrap;
      }
      if (!accept()) throw new Error("Cloud authentication was cancelled");
      accountId = `account${call}`;
      return {
        account: { id: accountId },
        device: { id: `device${call}` },
        deviceCredential: `device-credential-${call}`,
        legal: { current: legal, accepted: legal },
        workspace: { id: `workspace${call}` },
      };
    },
    accountId() { return accountId; },
    clearDevice() { accountId = undefined; },
  } as unknown as CloudConnectionRuntime;
  const cloudBrowser = {
    async resumeAfterAuthentication() {},
    async releaseAll() { return true; },
  } as any;
  const request = (email: string) => new Request("http://x/ui/api/cloud-auth/signin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password", queueKey }),
  });
  const options = { cloudAuth, cloudConnection, pendingSync, cloudBrowser };

  const staleSignIn = handleUiRequest(request("first@example.com"), {} as any, s, null, options);
  await firstBootstrapStarted;
  const signingOut = handleUiRequest(new Request("http://x/ui/api/cloud-auth/signout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }), {} as any, s, null, options);
  const signOut = await Promise.race([
    signingOut,
    Bun.sleep(200).then(() => null),
  ]);
  expect(signOut).not.toBeNull();
  expect(signOut!.status).toBe(200);

  const nextSignIn = await handleUiRequest(request("second@example.com"), {} as any, s, null, options);
  expect(nextSignIn!.status).toBe(200);
  finishFirstBootstrap();
  expect((await staleSignIn)!.status).toBe(409);
  expect(cloudAuth.state()).toMatchObject({ authenticated: true, user: { id: "account2" } });
  expect(cloudConnection.accountId()).toBe("account2");
  expect(pendingSync.queue()).toBeDefined();
  pendingSync.close();
  s.close();
});

test("Cloud auth API creates a pending-sync key only for a new queue", async () => {
  const s = store();
  const cloudAuth = new CloudAuthRuntime({
    async signIn() {
      return {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresIn: 60,
        expiresAt: 61_000,
        user: { id: "account1", email: "user@example.com", email_confirmed_at: "verified" },
      };
    },
  } as unknown as SupabaseAuthClient, () => 1_000);
  const cloudConnection = {
    async bootstrap() {
      return {
        device: { id: "device1" },
        deviceCredential: "device-credential",
        legal: { current: { terms: "1", privacy: "1", acceptableUse: "1" }, accepted: null },
      };
    },
    clearDevice() {},
  } as unknown as CloudConnectionRuntime;
  const pendingSync = new PendingSyncRuntime(
    join(mkdtempSync(join(tmpdir(), "aliasmode-ui-pending-")), "pending.sqlite"),
  );
  const response = await handleUiRequest(
    new Request("http://x/ui/api/cloud-auth/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", password: "password" }),
    }),
    {} as any,
    s,
    null,
    { cloudAuth, cloudConnection, pendingSync },
  );
  const body = await response!.json();
  expect(body.queueKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  expect(pendingSync.queue()).toBeDefined();
  pendingSync.close();
  s.close();
});

test("Cloud auth API reports a server-persisted queue key without returning it", async () => {
  const s = store();
  const cloudAuth = new CloudAuthRuntime({
    async signIn() {
      return {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresIn: 60,
        expiresAt: 61_000,
        user: { id: "account1", email: "user@example.com", email_confirmed_at: "verified" },
      };
    },
  } as unknown as SupabaseAuthClient, () => 1_000);
  const cloudConnection = {
    async bootstrap() {
      return {
        device: { id: "device1" },
        deviceCredential: "device-credential",
        legal: { current: { terms: "1", privacy: "1", acceptableUse: "1" }, accepted: null },
      };
    },
    clearDevice() {},
  } as unknown as CloudConnectionRuntime;
  const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-persisted-key-"));
  const pendingSync = new PendingSyncRuntime(
    join(root, "pending.sqlite"),
    join(root, "pending.key"),
  );
  const response = await handleUiRequest(
    new Request("http://x/ui/api/cloud-auth/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", password: "password" }),
    }),
    {} as any,
    s,
    null,
    { cloudAuth, cloudConnection, pendingSync },
  );
  const body = await response!.json();
  expect(body.queueKey).toBeUndefined();
  expect(body.queueKeyPersisted).toBe(true);
  expect(existsSync(join(root, "pending.key"))).toBe(true);
  pendingSync.close();
  s.close();
});

test("Cloud auth API does not replace an existing queue when its key is missing", async () => {
  const s = store();
  const path = join(mkdtempSync(join(tmpdir(), "aliasmode-ui-pending-")), "pending.sqlite");
  const pendingSync = new PendingSyncRuntime(path);
  pendingSync.initialize().queue.recordOpen({
    accountId: "account1",
    profileId: "profile1",
    registrationId: "registration1",
    expectedVersion: 1,
  });
  pendingSync.close();
  const cloudAuth = new CloudAuthRuntime({
    async signIn() {
      return {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresIn: 60,
        expiresAt: 61_000,
        user: { id: "account1", email: "user@example.com", email_confirmed_at: "verified" },
      };
    },
  } as unknown as SupabaseAuthClient, () => 1_000);
  let bootstrapCalls = 0;
  let cleared = 0;
  const cloudConnection = {
    async bootstrap() { bootstrapCalls++; throw new Error("must not bootstrap"); },
    clearDevice() { cleared++; },
  } as unknown as CloudConnectionRuntime;
  const response = await handleUiRequest(
    new Request("http://x/ui/api/cloud-auth/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", password: "password" }),
    }),
    {} as any,
    s,
    null,
    { cloudAuth, cloudConnection, pendingSync },
  );
  expect(response!.status).toBe(400);
  expect((await response!.json()).error).toContain("requires its stored encryption key");
  expect(bootstrapCalls).toBe(0);
  expect(cleared).toBe(0);
  expect(cloudAuth.accessToken()).toBeUndefined();
  expect(existsSync(path)).toBe(true);
  s.close();
});

test("Cloud auth API restores rotated credentials with the stored queue key", async () => {
  const s = store();
  const path = join(mkdtempSync(join(tmpdir(), "aliasmode-ui-pending-")), "pending.sqlite");
  const created = new PendingSyncRuntime(path);
  const queueKey = created.initialize().createdKey!;
  created.close();
  const pendingSync = new PendingSyncRuntime(path);
  const cloudAuth = new CloudAuthRuntime({
    async refresh() {
      return {
        accessToken: "restored-access-token",
        refreshToken: "rotated-refresh-token",
        expiresIn: 60,
        expiresAt: 61_000,
        user: { id: "account1", email: "user@example.com", email_confirmed_at: "verified" },
      };
    },
  } as unknown as SupabaseAuthClient, () => 1_000);
  let restoredCredential = "";
  let restoredDevice = "";
  const cloudConnection = {
    accountId() { return undefined; },
    restoreCredential(value: string) { restoredCredential = value; },
    client: {
      async status() {
        return {
          account: { id: "account1" },
          device: { id: "device1" },
          legal: { current: { terms: "1", privacy: "1", acceptableUse: "1" }, accepted: null },
        };
      },
    },
    restoreAccount() {},
    restoreDevice(deviceId: string) { restoredDevice = deviceId; },
    clearDevice() {},
  } as unknown as CloudConnectionRuntime;
  const response = await handleUiRequest(
    new Request("http://x/ui/api/cloud-auth/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        refreshToken: "stored-refresh-token",
        deviceCredential: "device-credential",
        queueKey,
      }),
    }),
    {} as any,
    s,
    null,
    { cloudAuth, cloudConnection, pendingSync },
  );
  const body = await response!.json();
  expect(body).toMatchObject({
    ok: true,
    authenticated: true,
    refreshToken: "rotated-refresh-token",
    deviceId: "device1",
  });
  expect(body.queueKey).toBeUndefined();
  expect(restoredCredential).toBe("device-credential");
  expect(restoredDevice).toBe("device1");
  expect(pendingSync.queue()).toBeDefined();
  pendingSync.close();
  s.close();
});

test("Cloud restore retains rotated auth, device, and queue state after a retryable status failure", async () => {
  const s = store();
  const path = join(mkdtempSync(join(tmpdir(), "aliasmode-ui-retryable-restore-")), "pending.sqlite");
  const pendingSync = new PendingSyncRuntime(path);
  const queueKey = pendingSync.initialize().createdKey!;
  const persisted: string[] = [];
  const cloudAuth = new CloudAuthRuntime({
    async refresh() {
      return {
        accessToken: "rotated-access-token",
        refreshToken: "rotated-refresh-token",
        expiresIn: 60,
        expiresAt: 61_000,
        user: { id: "account1", email: "user@example.com", email_confirmed_at: "verified" },
      };
    },
  } as unknown as SupabaseAuthClient, () => 1_000, (token) => { persisted.push(token); });
  let cleared = 0;
  let restoredCredential = "";
  let statusCalls = 0;
  const currentLegal = { terms: "1", privacy: "1", acceptableUse: "1" };
  const cloudConnection = {
    accountId() { return "account1"; },
    restoreAccount() {},
    restoreDevice() {},
    restoreCredential(value: string) { restoredCredential = value; },
    client: {
      async status() {
        statusCalls++;
        if (statusCalls === 1) {
          throw new CloudRequestError("offline", { kind: "transport", retryable: true });
        }
        return {
          account: { id: "account1" },
          device: { id: "device1" },
          legal: { current: currentLegal, accepted: currentLegal },
          workspace: { id: "workspace1" },
        };
      },
    },
    clearDevice() { cleared++; },
  } as unknown as CloudConnectionRuntime;

  const response = await handleUiRequest(new Request("http://x/ui/api/cloud-auth/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      refreshToken: "stored-refresh-token",
      deviceCredential: "stored-device-credential",
      queueKey,
    }),
  }), {} as any, s, null, { cloudAuth, cloudConnection, pendingSync });
  const body = await response!.json();

  expect(response!.status).toBe(503);
  expect(body).toEqual({
    ok: false,
    error: "Saved Cloud session could not be restored. Try again when the connection is available.",
    stage: "cloud_status",
    retryable: true,
    category: "network",
    code: "network_unavailable",
  });
  expect(persisted).toEqual(["rotated-refresh-token"]);
  expect(cloudAuth.state().authenticated).toBe(true);
  expect(restoredCredential).toBe("stored-device-credential");
  expect(cleared).toBe(0);
  expect(pendingSync.queue()).toBeDefined();
  expect(JSON.stringify(body)).not.toContain("stored-refresh-token");
  expect(JSON.stringify(body)).not.toContain("stored-device-credential");
  expect(body.queueKey).toBeUndefined();

  const recovered = await handleUiRequest(new Request("http://x/ui/api/cloud-auth/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      refreshToken: "rotated-refresh-token",
      deviceCredential: "stored-device-credential",
      queueKey,
    }),
  }), {} as any, s, null, { cloudAuth, cloudConnection, pendingSync });

  expect(recovered!.status).toBe(200);
  expect(await recovered!.json()).toMatchObject({
    ok: true,
    authenticated: true,
    refreshToken: "rotated-refresh-token",
    deviceId: "device1",
  });
  expect(statusCalls).toBe(2);
  expect(persisted).toEqual(["rotated-refresh-token"]);
  pendingSync.close();
  s.close();
});

test("Cloud restore clears only invalid session state after an unstructured 401 status failure", async () => {
  const s = store();
  const path = join(mkdtempSync(join(tmpdir(), "aliasmode-ui-unauthorized-restore-")), "pending.sqlite");
  const pendingSync = new PendingSyncRuntime(path);
  const queueKey = pendingSync.initialize().createdKey!;
  let durableSessionClears = 0;
  let remoteSignOuts = 0;
  const cloudAuth = new CloudAuthRuntime({
    async refresh() {
      return {
        accessToken: "rotated-access-token",
        refreshToken: "rotated-refresh-token",
        expiresIn: 60,
        expiresAt: 61_000,
        user: { id: "account1", email: "user@example.com", email_confirmed_at: "verified" },
      };
    },
    async signOut() { remoteSignOuts++; },
  } as unknown as SupabaseAuthClient, () => 1_000, undefined, () => { durableSessionClears++; });
  let deviceClears = 0;
  const cloudConnection = {
    accountId() { return "account1"; },
    restoreCredential() {},
    client: {
      async status() {
        throw new CloudApiError("AliasMode Cloud /status returned non-JSON (401, text/html)", "internal_error", 401);
      },
    },
    clearDevice() { deviceClears++; },
  } as unknown as CloudConnectionRuntime;

  const response = await handleUiRequest(new Request("http://x/ui/api/cloud-auth/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      refreshToken: "stored-refresh-token",
      deviceCredential: "stored-device-credential",
      queueKey,
    }),
  }), {} as any, s, null, { cloudAuth, cloudConnection, pendingSync });
  const body = await response!.json();

  expect(response!.status).toBe(401);
  expect(body).toEqual({
    ok: false,
    error: "Saved Cloud session is no longer valid. Sign in again.",
    stage: "cloud_status",
    retryable: false,
    category: "authentication",
    code: "authentication_invalid",
  });
  expect(durableSessionClears).toBe(1);
  expect(remoteSignOuts).toBe(0);
  expect(deviceClears).toBe(1);
  expect(cloudAuth.state()).toEqual({ authenticated: false });
  expect(pendingSync.queue()).toBeUndefined();
  expect(pendingSync.initialize(queueKey).createdKey).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain("stored-refresh-token");
  expect(JSON.stringify(body)).not.toContain("stored-device-credential");
  pendingSync.close();
  s.close();
});

test("Cloud restore clears only invalid session state after a permanent refresh failure", async () => {
  const s = store();
  const path = join(mkdtempSync(join(tmpdir(), "aliasmode-ui-permanent-restore-")), "pending.sqlite");
  const pendingSync = new PendingSyncRuntime(path);
  const queueKey = pendingSync.initialize().createdKey!;
  let durableSessionClears = 0;
  const cloudAuth = new CloudAuthRuntime({
    async refresh() {
      throw new SupabaseAuthRequestError(
        "invalid refresh token",
        { kind: "http", status: 401, retryable: false },
      );
    },
  } as unknown as SupabaseAuthClient, () => 1_000, undefined, () => { durableSessionClears++; });
  let deviceClears = 0;
  const cloudConnection = {
    accountId() { return undefined; },
    clearDevice() { deviceClears++; },
  } as unknown as CloudConnectionRuntime;

  const response = await handleUiRequest(new Request("http://x/ui/api/cloud-auth/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      refreshToken: "invalid-stored-refresh",
      deviceCredential: "stored-device-credential",
      queueKey,
    }),
  }), {} as any, s, null, { cloudAuth, cloudConnection, pendingSync });
  const body = await response!.json();

  expect(body).toEqual({
    ok: false,
    error: "Saved Cloud session is no longer valid. Sign in again.",
    stage: "auth_refresh",
    retryable: false,
    category: "authentication",
    code: "authentication_invalid",
  });
  expect(response!.status).toBe(401);
  expect(durableSessionClears).toBe(1);
  expect(deviceClears).toBe(1);
  expect(cloudAuth.state()).toEqual({ authenticated: false });
  expect(pendingSync.queue()).toBeUndefined();
  expect(pendingSync.initialize(queueKey).createdKey).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain("invalid-stored-refresh");
  expect(JSON.stringify(body)).not.toContain("stored-device-credential");
  pendingSync.close();
  s.close();
});

test("Cloud restore treats unverified email as permanent and clears credentials locally", async () => {
  const s = store();
  let localClears = 0;
  let remoteSignOuts = 0;
  const cloudAuth = {
    async acquireTransition() { return { generation: 0, release() {} }; },
    isTransitionCurrent() { return true; },
    canRestore() { return true; },
    async restore() { throw new EmailVerificationRequiredError(); },
    async clearStoredSession() { localClears++; },
    async signOut() { remoteSignOuts++; },
  } as unknown as CloudAuthRuntime;
  let deviceClears = 0;
  const cloudConnection = {
    accountId() { return undefined; },
    clearDevice() { deviceClears++; },
  } as unknown as CloudConnectionRuntime;
  let queueCloses = 0;
  const pendingSync = {
    queue() { return {}; },
    close() { queueCloses++; },
  } as unknown as PendingSyncRuntime;

  const response = await handleUiRequest(new Request("http://x/ui/api/cloud-auth/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      refreshToken: "unverified-refresh",
      deviceCredential: "stored-device-credential",
      queueKey: "stored-queue-key",
    }),
  }), {} as any, s, null, { cloudAuth, cloudConnection, pendingSync });
  const body = await response!.json();

  expect(response!.status).toBe(401);
  expect(body).toEqual({
    ok: false,
    error: "Saved Cloud session is no longer valid. Sign in again.",
    stage: "auth_refresh",
    retryable: false,
    category: "authentication",
    code: "email_not_verified",
  });
  expect([localClears, remoteSignOuts, deviceClears, queueCloses]).toEqual([1, 0, 1, 1]);
  expect(JSON.stringify(body)).not.toContain("unverified-refresh");
  expect(JSON.stringify(body)).not.toContain("stored-device-credential");
  expect(JSON.stringify(body)).not.toContain("stored-queue-key");
  s.close();
});

test("Cloud restore treats device and membership revocation as permanent", async () => {
  for (const code of ["device_revoked", "membership_revoked"] as const) {
    const s = store();
    let credentialClears = 0;
    let deviceClears = 0;
    let queueCloses = 0;
    const cloudAuth = new CloudAuthRuntime({
      async refresh() {
        return {
          accessToken: "access-token",
          refreshToken: "rotated-refresh-token",
          expiresIn: 60,
          expiresAt: 61_000,
          user: { id: "account1", email_confirmed_at: "verified" },
        };
      },
      async signOut() {},
    } as unknown as SupabaseAuthClient, () => 1_000, undefined, () => { credentialClears++; });
    const cloudConnection = {
      accountId() { return "account1"; },
      restoreCredential() {},
      client: { async status() { throw new CloudApiError("revoked", code, 403); } },
      clearDevice() { deviceClears++; },
    } as unknown as CloudConnectionRuntime;
    const pendingSync = {
      queue() { return {}; },
      close() { queueCloses++; },
    } as unknown as PendingSyncRuntime;

    const response = await handleUiRequest(new Request("http://x/ui/api/cloud-auth/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "refresh", deviceCredential: "device", queueKey: "queue" }),
    }), {} as any, s, null, { cloudAuth, cloudConnection, pendingSync });

    expect(response!.status).toBe(401);
    expect(await response!.json()).toMatchObject({
      stage: "cloud_status",
      retryable: false,
      category: "authentication",
      code,
    });
    expect([credentialClears, deviceClears, queueCloses]).toEqual([1, 1, 1]);
    s.close();
  }
});

test("Cloud diagnostics route returns only sanitized current-process events", async () => {
  const s = store();
  const cloudBrowser = {
    diagnostics() {
      return [{
        timestamp: 123,
        type: "session_restore_context_timeout",
        profileId: "profile-secret",
        error: "raw browser secret",
      }];
    },
  } as any;

  const response = await handleUiRequest(
    new Request("http://x/ui/api/cloud-events"),
    {} as any,
    s,
    null,
    { cloudBrowser },
  );

  expect(response!.headers.get("cache-control")).toBe("no-store");
  expect(await response!.json()).toEqual({
    events: [{ timestamp: 123, type: "session_restore_context_timeout" }],
  });

  const empty = await handleUiRequest(
    new Request("http://x/ui/api/cloud-events"),
    {} as any,
    s,
  );
  expect(await empty!.json()).toEqual({ events: [] });
  s.close();
});

test("Cloud forget releases browsers and clears only stored session state", async () => {
  const s = store();
  const calls: string[] = [];
  const cloudAuth = {
    beginExit() { return () => {}; },
    async clearStoredSession() { calls.push("clearStoredSession"); },
    async signOut() { throw new Error("remote sign-out must not run"); },
  } as unknown as CloudAuthRuntime;
  const cloudConnection = {
    clearDevice() { calls.push("clearDevice"); },
  } as unknown as CloudConnectionRuntime;
  const pendingSync = { close() { calls.push("closeQueue"); } } as unknown as PendingSyncRuntime;
  const cloudBrowser = { async releaseAll() { calls.push("releaseAll"); return true; } } as any;

  const response = await handleUiRequest(new Request("http://x/ui/api/cloud-auth/forget", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }), {} as any, s, null, { cloudAuth, cloudConnection, pendingSync, cloudBrowser });

  expect(response!.status).toBe(200);
  expect(calls).toEqual(["releaseAll", "closeQueue", "clearDevice", "clearStoredSession"]);
  s.close();
});

test("Cloud sign-out keeps auth and account state when browsers cannot release", async () => {
  const s = store();
  const calls: string[] = [];
  const cloudAuth = {
    beginExit() { return () => {}; },
    state() { return { authenticated: true }; },
    async signOut() { calls.push("signOut"); },
  } as unknown as CloudAuthRuntime;
  const cloudConnection = {
    accountId() { return "account1"; },
    clearDevice() { calls.push("clearDevice"); },
  } as unknown as CloudConnectionRuntime;
  const pendingSync = { close() { calls.push("closeQueue"); } } as unknown as PendingSyncRuntime;
  const cloudBrowser = { async releaseAll() { calls.push("releaseAll"); return false; } } as any;
  const mcpTunnel = {
    async disconnect() { calls.push("disconnectTunnel"); },
    refresh() { calls.push("refreshTunnel"); },
  };

  const response = await handleUiRequest(new Request("http://x/ui/api/cloud-auth/signout", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }), {} as any, s, null, { cloudAuth, cloudConnection, pendingSync, cloudBrowser, mcpTunnel });

  expect(response!.status).toBe(409);
  expect(calls).toEqual(["disconnectTunnel", "releaseAll", "refreshTunnel"]);
  expect(cloudConnection.accountId()).toBe("account1");
  s.close();
});

test("Cloud sign-out releases browsers before queue, device, and credentials", async () => {
  const s = store();
  const calls: string[] = [];
  const cloudAuth = {
    beginExit() { return () => {}; },
    async signOut() { calls.push("signOut"); },
  } as unknown as CloudAuthRuntime;
  const cloudConnection = {
    clearDevice() { calls.push("clearDevice"); },
  } as unknown as CloudConnectionRuntime;
  const pendingSync = { close() { calls.push("closeQueue"); } } as unknown as PendingSyncRuntime;
  const cloudBrowser = { async releaseAll() { calls.push("releaseAll"); return true; } } as any;
  const mcpTunnel = {
    async disconnect() { calls.push("disconnectTunnel"); },
    refresh() { calls.push("refreshTunnel"); },
  };

  const response = await handleUiRequest(new Request("http://x/ui/api/cloud-auth/signout", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }), {} as any, s, null, { cloudAuth, cloudConnection, pendingSync, cloudBrowser, mcpTunnel });

  expect(response!.status).toBe(200);
  expect(calls).toEqual(["disconnectTunnel", "releaseAll", "closeQueue", "clearDevice", "signOut"]);
  s.close();
});

test("Cloud sign-out returns success after a remote logout failure", async () => {
  const s = store();
  const calls: string[] = [];
  const cloudAuth = new CloudAuthRuntime({
    async signIn() {
      return {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresIn: 60,
        expiresAt: 61_000,
        user: { id: "account1", email_confirmed_at: "verified" },
      };
    },
    async signOut() { throw new Error("offline"); },
  } as unknown as SupabaseAuthClient, () => 1_000, undefined, () => {
    calls.push("clearCredentials");
  });
  await cloudAuth.signIn("user@example.com", "password");
  const cloudConnection = {
    clearDevice() { calls.push("clearDevice"); },
  } as unknown as CloudConnectionRuntime;
  const pendingSync = { close() { calls.push("closeQueue"); } } as unknown as PendingSyncRuntime;
  const cloudBrowser = { async releaseAll() { calls.push("releaseAll"); return true; } } as any;
  const mcpTunnel = {
    async disconnect() { calls.push("disconnectTunnel"); },
    refresh() { calls.push("refreshTunnel"); },
  };

  const response = await handleUiRequest(new Request("http://x/ui/api/cloud-auth/signout", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }), {} as any, s, null, { cloudAuth, cloudConnection, pendingSync, cloudBrowser, mcpTunnel });

  expect(response!.status).toBe(200);
  expect(cloudAuth.state()).toEqual({ authenticated: false });
  expect(calls).toEqual([
    "disconnectTunnel",
    "releaseAll",
    "closeQueue",
    "clearDevice",
    "clearCredentials",
  ]);
  s.close();
});

test("Cloud profile routes use the Cloud browser coordinator without local fallback", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-cloud-browser-"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  appConfig.setMode("cloud", "https://cloud.aliasmode.test");
  const calls: string[] = [];
  const cloudBrowser = {
    async listRoster() {
      calls.push("list");
      return { profiles: [{ id: "cloud1", name: "Cloud profile" }], healthSources: [] };
    },
    async create(profile: { id: string; name: string }) {
      calls.push(`create:${profile.name}`);
      return { id: profile.id };
    },
    async open(profileId: string) {
      calls.push(`open:${profileId}`);
      return { ok: true, port: 9222 };
    },
    async close() { return { closed: true, sync: "complete" }; },
    async resumeAfterAuthentication() {},
    async retryPending() {},
    async releaseAll() { return true; },
  } as any;

  const roster = await handleUiRequest(
    new Request("http://x/ui/api/profiles"),
    {} as any,
    s,
    null,
    { appConfig, cloudBrowser },
  );
  expect(await roster!.json()).toEqual({
    profiles: [{ id: "cloud1", name: "Cloud profile" }],
    healthSources: [],
  });
  const opened = await handleUiRequest(
    new Request("http://x/ui/api/profiles/cloud1/open", { method: "POST" }),
    {} as any,
    s,
    null,
    { appConfig, cloudBrowser },
  );
  expect(await opened!.json()).toEqual({ ok: true, port: 9222 });
  expect(calls).toEqual(["list", "open:cloud1"]);

  const created = await handleUiRequest(
    new Request("http://x/ui/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New Cloud profile" }),
    }),
    {} as any,
    s,
    null,
    { appConfig, cloudBrowser },
  );
  expect(created!.status).toBe(200);
  const createdBody = await created!.json();
  expect(createdBody).toMatchObject({ ok: true, id: expect.any(String) });
  expect(calls).toEqual(["list", "open:cloud1", "create:New Cloud profile"]);
  expect(s.getProfile(createdBody.id)).toBeNull();
  s.close();
});

test("Cloud close route separates teardown from Cloud sync outcomes", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-cloud-close-"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  appConfig.setMode("cloud", "https://cloud.aliasmode.test");
  let result: any = { closed: true, sync: "pending" };
  const cloudBrowser = { async close() { return result; } } as any;
  const request = () => handleUiRequest(
    new Request("http://x/ui/api/profiles/cloud1/close", { method: "POST" }),
    {} as any,
    s,
    null,
    { appConfig, cloudBrowser },
  );

  let response = await request();
  expect(response!.status).toBe(200);
  expect(await response!.json()).toEqual({
    ok: true,
    sync: "pending",
    warning: "Browser closed. Saving this profile to Cloud will retry automatically.",
  });

  result = { closed: true, sync: "conflict" };
  response = await request();
  expect(response!.status).toBe(200);
  expect(await response!.json()).toEqual({
    ok: true,
    sync: "conflict",
    warning: "Browser closed, but Cloud could not accept the saved session. The encrypted snapshot remains on this device.",
  });

  result = { closed: false, reason: "teardown_unconfirmed" };
  response = await request();
  expect(response!.status).toBe(500);
  expect(await response!.json()).toEqual({ ok: false, error: "browser teardown unconfirmed" });
  s.close();
});

test("app mode API reports when Cloud is unavailable in the build", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-config-"));
  const response = await handleUiRequest(
    new Request("http://x/ui/api/app-mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "cloud" }),
    }),
    {} as any,
    s,
    null,
    { appConfig: new AppConfigStore(join(root, "config.json")) },
  );
  expect(response!.status).toBe(503);
  expect((await response!.json()).error).toContain("not configured");
  s.close();
});

test("app mode API rejects cross-origin JSON requests", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-config-"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  const response = await handleUiRequest(
    new Request("http://x/ui/api/app-mode", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ mode: "local" }),
    }),
    {} as any,
    s,
    null,
    { appConfig },
  );
  expect(response!.status).toBe(403);
  expect(appConfig.read().mode).toBe("unconfigured");
  s.close();
});

test("app mode API rejects cross-site simple requests", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-config-"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  const response = await handleUiRequest(
    new Request("http://x/ui/api/app-mode", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://attacker.example" },
      body: JSON.stringify({ mode: "local" }),
    }),
    {} as any,
    s,
    null,
    { appConfig },
  );
  expect(response!.status).toBe(415);
  expect(appConfig.read().mode).toBe("unconfigured");
  s.close();
});

test("Cloud bulk delete keeps closed profiles, rejects opens, and continues after errors", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-cloud-delete-"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  appConfig.setMode("cloud", "https://cloud.aliasmode.test");
  const deleted: string[] = [];
  const cloudConnection = {
    client: {
      async getProfile(id: string) {
        if (id === "open") return { profile: { version: 1, activeOpens: [{}] } };
        return { profile: { version: 1, activeOpens: [] } };
      },
      async trashProfile(id: string) {
        if (id === "raced") throw new CloudApiError("profile is open", "profile_open", 409);
        if (id === "broken") throw new Error("service unavailable");
        deleted.push(id);
      },
    },
  } as any;
  const response = await handleUiRequest(
    new Request("http://x/ui/api/profiles/delete", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["closed", "open", "raced", "broken"] }),
    }),
    {} as any,
    s,
    null,
    { appConfig, cloudBrowser: {} as any, cloudConnection },
  );
  expect(response!.status).toBe(200);
  expect(await response!.json()).toEqual({ ok: true, deleted: 1, locked: ["open", "raced"], failed: ["broken"] });
  expect(deleted).toEqual(["closed"]);
  s.close();
});


test("Cloud profile editor routes return no session data and forward expectedVersion", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-cloud-editor-"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  appConfig.setMode("cloud", "https://cloud.aliasmode.test");
  const localName = s.getProfile("k1d0cd11")!.name;
  const payload = encodePortableProfile({
    ...s.getProfile("k1d0cd11")!,
    name: "Authoritative Cloud name",
  });
  let updateRequest: any;
  let moveRequest: any;
  const cloudConnection = {
    client: {
      async getProfile() {
        return {
          ok: true,
          profile: {
            id: "k1d0cd11",
            name: "Authoritative Cloud name",
            group: "va1",
            platform: "",
            tags: [],
            version: 11,
            trashedAt: null,
            trashedBy: null,
            updatedAt: 1,
            activeOpens: [],
          },
          payload,
          payloadDigest: "digest",
        };
      },
      async moveProfile(_id: string, request: unknown) {
        moveRequest = request;
        return { ok: true, profile: { version: 12 } };
      },
      async updateProfile(_id: string, request: unknown) {
        updateRequest = request;
        return { ok: true, profile: {}, payloadDigest: "next" };
      },
    },
  } as any;
  const cloudBrowser = {} as any;

  const getResponse = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11"),
    {} as any,
    s,
    null,
    { appConfig, cloudBrowser, cloudConnection },
  );
  expect(getResponse!.status).toBe(200);
  const getBody = await getResponse!.json();
  expect(getBody.profile).toMatchObject({ name: "Authoritative Cloud name", expectedVersion: 11, cookieCount: 1 });
  expect(JSON.stringify(getBody)).not.toContain("COOKIEVAL");
  expect(JSON.stringify(getBody)).not.toContain('"session"');

  const saveResponse = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 11, set: { name: "Saved Cloud name", group: "va2" } }),
    }),
    {} as any,
    s,
    null,
    { appConfig, cloudBrowser, cloudConnection },
  );
  expect(saveResponse!.status).toBe(200);
  expect(moveRequest).toEqual({ destination: "va2", expectedVersion: 11 });
  expect(updateRequest.expectedVersion).toBe(12);
  expect(updateRequest.payload.profile.name).toBe("Saved Cloud name");
  expect(updateRequest.payload.profile.group).toBe("va2");
  expect(updateRequest.payload.session).toEqual(payload.session);
  expect(s.getProfile("k1d0cd11")!.name).toBe(localName);
  s.close();
});

test("Cloud profile open on this device is edited live through the local cache", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-cloud-live-edit-"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  appConfig.setMode("cloud", "https://cloud.aliasmode.test");
  // The running session's checkpoint/close sync owns the Cloud version, so the
  // editor must never be consulted — the local cached copy is the truth.
  const cloudConnection = {
    client: new Proxy({}, {
      get() { throw new Error("Cloud must not be called for a live edit"); },
    }),
  } as any;
  const noted: string[] = [];
  const cloudBrowser = {
    canEditLive(id: string) {
      return id === "k1d0cd11";
    },
    async commitLiveEdit(profile: Profile) {
      s.upsertProfile(profile);
      noted.push(profile.id);
      return true;
    },
  } as any;
  s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://x", startedAt: 123 });

  const getResponse = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11"),
    {} as any,
    s,
    null,
    { appConfig, cloudBrowser, cloudConnection },
  );
  expect(getResponse!.status).toBe(200);
  const getBody = await getResponse!.json();
  expect(getBody.profile.liveEdit).toBe(true);
  expect(getBody.profile.expectedVersion).toBeUndefined();

  // A transient Cloud connectivity outage must not block editing a profile
  // that is open on this very device — the live path never uses the connection.
  const offline = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11"),
    {} as any,
    s,
    null,
    { appConfig, cloudBrowser },
  );
  expect(offline!.status).toBe(200);

  const saveResponse = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // customNo is ignored: the portable-profile contract cannot carry it, so
      // honoring it would only last until the next open erased it.
      body: JSON.stringify({ set: { name: "Live edited name", customNo: "999" } }),
    }),
    {} as any,
    s,
    null,
    { appConfig, cloudBrowser, cloudConnection },
  );
  expect(saveResponse!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")!.name).toBe("Live edited name");
  expect(s.getProfile("k1d0cd11")!.customNo ?? "").not.toBe("999");
  // The edit was made durable immediately, not left to ride on the next
  // session-content change.
  expect(noted).toEqual(["k1d0cd11"]);

  // Once the browser has closed, a stale live-edit dialog cannot silently fall
  // through to the versioned editor without an expectedVersion.
  s.clearLaunch("k1d0cd11");
  const staleResponse = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ set: { name: "Too late" } }),
    }),
    {} as any,
    s,
    null,
    { appConfig, cloudBrowser: {} as any, cloudConnection },
  );
  expect(staleResponse!.status).toBe(409);
  expect((await staleResponse!.json()).error).toContain("reopen Edit");
  s.close();
});

test("Cloud live edit rejects a save that loses the close race", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-cloud-live-edit-close-race-"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  appConfig.setMode("cloud", "https://cloud.aliasmode.test");
  const originalName = s.getProfile("k1d0cd11")!.name;
  s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://x", startedAt: 123 });
  let live = true;
  const cloudBrowser = {
    canEditLive() {
      return live;
    },
    async commitLiveEdit() {
      return false;
    },
  } as any;
  const saveRequest = () => new Request("http://x/ui/api/profiles/k1d0cd11/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ set: { name: "Too late" } }),
  });

  const duringCommit = await handleUiRequest(
    saveRequest(),
    {} as any,
    s,
    null,
    { appConfig, cloudBrowser },
  );
  expect(duringCommit!.status).toBe(409);
  expect((await duringCommit!.json()).error).toContain("reopen Edit");
  expect(s.getProfile("k1d0cd11")!.name).toBe(originalName);

  live = false;
  const afterCloseStarted = await handleUiRequest(
    saveRequest(),
    {} as any,
    s,
    null,
    { appConfig, cloudBrowser },
  );
  expect(afterCloseStarted!.status).toBe(409);
  expect((await afterCloseStarted!.json()).error).toContain("reopen Edit");
  expect(s.getProfile("k1d0cd11")!.name).toBe(originalName);
  s.close();
});

test("Cloud profile save rejects untrusted JSON before calling Cloud", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-cloud-editor-trust-"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  appConfig.setMode("cloud", "https://cloud.aliasmode.test");
  const cloudConnection = {
    client: new Proxy({}, {
      get() { throw new Error("Cloud must not be called"); },
    }),
  } as any;
  const response = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ expectedVersion: 11, set: { name: "attacker" } }),
    }),
    {} as any,
    s,
    null,
    { appConfig, cloudBrowser: {} as any, cloudConnection },
  );
  expect(response!.status).toBe(403);
  s.close();
});

test("the roster carries each profile's serial and custom NO.", () => {
  const s = store();
  const [before] = listUiProfiles(s);
  expect(before!.serial).toBe(s.getSerial("k1d0cd11")!);
  expect(before!.customNo).toBe(""); // unset -> the UI falls back to the serial

  s.upsertProfile({ ...s.getProfile("k1d0cd11")!, customNo: "907341" });
  expect(listUiProfiles(s)[0]!.customNo).toBe("907341");
  s.close();
});

test("editing a custom NO. validates digits and survives a reopen of the editor", async () => {
  const s = store();
  const save = (customNo: string) => handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      body: JSON.stringify({ set: { customNo } }),
    }),
    {} as any,
    s,
  );

  expect((await save("4421"))!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")!.customNo).toBe("4421");

  const view = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11"), {} as any, s);
  expect((await view!.json()).profile.customNo).toBe("4421");

  const rejected = await save("44-21");
  expect(rejected!.status).toBe(500);
  expect((await rejected!.json()).error).toContain("digits only");
  expect(s.getProfile("k1d0cd11")!.customNo).toBe("4421"); // rejected edit changed nothing

  expect((await save(""))!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")!.customNo).toBe("");
  s.close();
});

test("creating a profile stores the credentials supplied with it", async () => {
  const s = store();
  const response = await handleUiRequest(
    new Request("http://x/ui/api/profiles", {
      method: "POST",
      body: JSON.stringify({
        name: "fresh", group: "Warmup", platform: "x.com", customNo: "5150",
        username: "fresh_user", password: "fresh-pass",
        email: "fresh@example.com", emailPassword: "mailbox-pass",
        twofa: "JBSWY3DPEHPK3PXP",
      }),
    }),
    {} as any,
    s,
  );
  const { ok, id } = await response!.json();
  expect(ok).toBe(true);

  // The create endpoint has always accepted these; this pins that the dialog is
  // not the only thing that can set them and that none are silently dropped.
  expect(s.getProfile(id)).toMatchObject({
    name: "fresh", group: "Warmup", platform: "x.com", customNo: "5150",
    username: "fresh_user", password: "fresh-pass",
    email: "fresh@example.com", emailPassword: "mailbox-pass",
    twofa: "JBSWY3DPEHPK3PXP",
  });
  s.close();
});

test("the dashboard profile payload carries the fingerprint verdict", () => {
  const s = store();
  s.saveObservedFingerprint(
    "k1d0cd11",
    { canvas: "deadbeef", capturedAt: "2026-08-29T11:04:22Z" },
    { verdict: "mismatch", differences: [{ field: "canvas", expected: "a3f19c8e", observed: "deadbeef" }] },
  );
  const row = listUiProfiles(s).find((p) => p.id === "k1d0cd11")!;
  expect(row.fpVerdict!.verdict).toBe("mismatch");
  expect(row.fpVerdict!.differences[0]!.field).toBe("canvas");
  expect(row.fpCapturedAt).toBe("2026-08-29T11:04:22Z");
  s.close();
});

test("a profile that has never been probed carries no verdict", () => {
  const s = store();
  const row = listUiProfiles(s).find((p) => p.id === "k1d0cd11")!;
  expect(row.fpVerdict).toBeNull();
  expect(row.fpCapturedAt).toBe("");
  s.close();
});
