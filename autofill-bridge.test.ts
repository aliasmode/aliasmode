import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutofillBridge, matchesAutofillSite } from "./autofill-bridge.ts";
import { AUTOFILL_BACKGROUND, AUTOFILL_CONTENT, autofillExtensionDir } from "./autofill-extension.ts";
import { ProfileStore } from "./store.ts";
import { generateTotp } from "./totp.ts";
import type { LaunchInfo, Profile } from "./types.ts";

const roots: string[] = [];
const stores: ProfileStore[] = [];
const bridges: AutofillBridge[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-autofill-"));
  roots.push(root);
  const store = new ProfileStore(":memory:");
  stores.push(store);
  const profile: Profile = {
    id: "autofill-test", accId: "1", name: "Test account", group: "", platform: "x.com",
    username: "test-user", password: "test-password", email: "test@example.com",
    emailPassword: "mailbox-only", twofa: "JBSWY3DPEHPK3PXP", proxy: null, ua: "",
    timezone: "", screenWidth: 1920, screenHeight: 1080, fingerprintSeed: 1, cookies: [], seeded: false,
  };
  store.upsertProfile(profile);
  const launch: LaunchInfo = {
    profileId: profile.id, pid: 1, debugPort: 9333, startedAt: 1,
    ws: "ws://127.0.0.1:9333/test", userDataDir: join(root, profile.id),
  };
  store.recordLaunch(launch);
  const bridge = new AutofillBridge(store);
  bridges.push(bridge);
  bridge.listen();
  bridge.install(launch);
  const binding = () => JSON.parse(readFileSync(join(autofillExtensionDir(launch.userDataDir!), "bind.json"), "utf8"));
  const request = (operation = "fields", body: object = { url: "https://x.com/i/flow/login" }, token = binding().token) =>
    new Request(`http://127.0.0.1:${bridge.port}/v1/${operation}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { store, profile, launch, bridge, binding, request };
}

test("matches platform hosts, explicit aliases and custom domains without suffix confusion", () => {
  for (const platform of ["x", "x.com", "twitter", "twitter.com", "https://www.x.com/home"]) {
    for (const host of ["x.com", "www.x.com", "twitter.com", "mobile.twitter.com"]) {
      expect(matchesAutofillSite(platform, `https://${host}/login`)).toBe(true);
    }
    for (const url of ["https://x.com.evil.test", "https://notx.com", "https://example.com", "file:///x.com", "not a url"]) {
      expect(matchesAutofillSite(platform, url)).toBe(false);
    }
  }
  for (const platform of ["example.com", "https://www.example.com/login"]) {
    expect(matchesAutofillSite(platform, "https://app.example.com/signin")).toBe(true);
  }
  for (const platform of ["", undefined, "unknown"]) expect(matchesAutofillSite(platform, "https://x.com")).toBe(false);
  for (const platform of ["instagram", "facebook", "tiktok", "reddit", "linkedin"]) {
    expect(matchesAutofillSite(platform, `https://www.${platform}.com/login`)).toBe(true);
  }
  expect(matchesAutofillSite("telegram", "https://web.telegram.org/a/")).toBe(true);
  expect(matchesAutofillSite("accounts.example.com", "https://other.example.com")).toBe(false);
});

test("metadata contains field names, never credential values or launch tokens", async () => {
  const f = fixture();
  const response = await f.bridge.handle(f.request());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ ok: true, name: "Test account", fields: ["username", "email", "password", "totp"] });
  expect(JSON.stringify(f.store.getLaunch(f.profile.id)).includes(f.binding().token)).toBe(false);
});

test("returns only the selected field and observes live profile edits", async () => {
  const f = fixture();
  for (const field of ["username", "email", "password"] as const) {
    const response = await f.bridge.handle(f.request("fill", { url: "https://x.com/login", field }));
    expect(await response.json()).toEqual({ ok: true, value: f.profile[field] });
  }
  f.store.upsertProfile({ ...f.profile, password: "updated-password" });
  const response = await f.bridge.handle(f.request("fill", { url: "https://x.com/login", field: "password" }));
  expect(await response.json()).toEqual({ ok: true, value: "updated-password" });
  for (const field of ["emailPassword", "twofa", "cookies", "proxy"]) {
    expect((await f.bridge.handle(f.request("fill", { url: "https://x.com", field }))).status).toBe(400);
  }
});

test("generates the current authenticator code at fill time", async () => {
  const f = fixture();
  const before = generateTotp(f.profile.twofa)!.code;
  const response = await f.bridge.handle(f.request("fill", { url: "https://x.com", field: "totp" }));
  const result = await response.json();
  expect([before, generateTotp(f.profile.twofa)!.code]).toContain(result.value);
  expect(Object.keys(result).sort()).toEqual(["ok", "value"]);
});

test("missing fields are omitted and cannot be filled", async () => {
  const f = fixture();
  f.store.upsertProfile({ ...f.profile, password: "", email: "", twofa: "" });
  expect((await (await f.bridge.handle(f.request())).json()).fields).toEqual(["username"]);
  for (const field of ["email", "password", "totp"]) {
    expect((await f.bridge.handle(f.request("fill", { url: "https://x.com", field }))).status).toBe(404);
  }
});

test("rejects missing tokens, unrelated sites and requests after stop", async () => {
  const f = fixture();
  for (const token of ["", "wrong-token"]) expect((await f.bridge.handle(f.request("fields", {}, token))).status).toBe(401);
  expect((await f.bridge.handle(f.request("fields", { url: "https://evil.test" }))).status).toBe(403);
  const request = f.request();
  f.store.clearLaunch(f.profile.id);
  expect((await f.bridge.handle(request)).status).toBe(401);
});

test("tokens cannot choose another profile or outlive their launch generation", async () => {
  const f = fixture();
  f.store.upsertProfile({ ...f.profile, id: "other-profile", username: "other-user" });
  const response = await f.bridge.handle(f.request("fill", { url: "https://x.com", field: "username", profileId: "other-profile" }));
  expect(await response.json()).toEqual({ ok: true, value: f.profile.username });
  const oldRequest = f.request();
  f.store.recordLaunch({ ...f.launch, startedAt: 2 });
  expect((await f.bridge.handle(oldRequest)).status).toBe(401);
  f.bridge.install({ ...f.launch, startedAt: 2 });
  f.bridge.retire(f.profile.id, f.launch);
  expect((await f.bridge.handle(f.request())).status).toBe(200);
});

test("restart refreshes port and token, while retire removes the private binding", async () => {
  const f = fixture();
  const oldToken = f.binding().token;
  f.bridge.close();
  const restarted = new AutofillBridge(f.store);
  bridges.push(restarted);
  restarted.listen();
  expect(f.binding().port).toBe(restarted.port);
  expect(f.binding().token !== oldToken).toBe(true);
  expect((await restarted.handle(f.request("fields", { url: "https://x.com" }, oldToken))).status).toBe(401);
  expect((await restarted.handle(f.request())).status).toBe(200);
  const request = f.request();
  restarted.retire(f.profile.id, f.launch);
  expect((await restarted.handle(request)).status).toBe(401);
  expect(existsSync(join(autofillExtensionDir(f.launch.userDataDir!), "bind.json"))).toBe(false);
});

test("one unwritable survivor helper does not prevent the manager bridge from starting", async () => {
  const f = fixture();
  f.bridge.close();
  const file = join(autofillExtensionDir(f.launch.userDataDir!), "background.js");
  rmSync(file);
  mkdirSync(file);
  const restarted = new AutofillBridge(f.store);
  bridges.push(restarted);
  expect(() => restarted.listen()).not.toThrow();
  expect(restarted.port).toBeGreaterThan(0);
  expect(existsSync(join(autofillExtensionDir(f.launch.userDataDir!), "bind.json"))).toBe(false);
});

test("installed extension scripts parse and its private binding is not web-accessible", async () => {
  const f = fixture();
  const dir = autofillExtensionDir(f.launch.userDataDir!);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.content_scripts[0].all_frames).toBe(true);
  expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"]);
  expect(manifest.web_accessible_resources).toBeUndefined();
  expect(() => new Function(AUTOFILL_BACKGROUND)).not.toThrow();
  expect(() => new Function(AUTOFILL_CONTENT)).not.toThrow();
  const response = await fetch(f.request());
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});
