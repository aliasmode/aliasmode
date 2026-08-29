import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "./store.ts";
import { parseExport } from "./parse.ts";
import type { Profile } from "./types.ts";

const SAMPLE = `id=k1d0cd11
name=sophiaskye852
group=g1
fakey=ABCD
password=pw
cookie=[{"name":"auth_token","value":"v","domain":".x.com","path":"/","session":false,"expires":1788000000}]
proxytype=http
proxy=1.2.3.4:8080:u:p
ua=Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/143.0.0.0 Safari/537.36
resolution=1680*1050
******************`;

function memStore(): ProfileStore {
  return new ProfileStore(":memory:");
}

test("upsert + get round-trips a full profile", () => {
  const store = memStore();
  const p = parseExport(SAMPLE).profiles[0]!;
  p.email = "mailbox@example.com";
  p.emailPassword = "mailbox-secret";
  store.upsertProfile(p);
  const got = store.getProfile("k1d0cd11")!;
  expect(got.name).toBe("sophiaskye852");
  expect(got.proxy).toEqual({ type: "http", host: "1.2.3.4", port: "8080", user: "u", pass: "p" });
  expect(got.cookies.length).toBe(1);
  expect(got.screenWidth).toBe(1680);
  expect(got.fingerprintSeed).toBe(p.fingerprintSeed);
  expect(got.email).toBe("mailbox@example.com");
  expect(got.emailPassword).toBe("mailbox-secret");
  expect(got.seeded).toBe(false);
  store.close();
});

test("rename is exact, idempotent, durable, and preserves all profile metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloak-rename-"));
  const db = join(dir, "profiles.sqlite");
  let store: ProfileStore | undefined;
  try {
    store = new ProfileStore(db);
    const parsed = parseExport(SAMPLE).profiles[0]!;
    const profile: Profile = {
      ...parsed,
      accId: "account-id",
      name: "old-name",
      group: "team-a",
      platform: "x.com",
      username: "x-user",
      password: "x-password",
      email: "mailbox@example.com",
      emailPassword: "mail-password",
      twofa: "TOTPSECRET",
      timezone: "America/New_York",
      extensions: ["extension-a"],
      tags: ["priority", "automation"],
      seeded: true,
    };
    store.upsertProfile(profile);
    store.recordLaunch({
      profileId: profile.id,
      pid: 1234,
      debugPort: 9333,
      ws: "ws://127.0.0.1:9333/devtools/browser/test",
      startedAt: 1_720_000_000_000,
      sessionBaseVersion: 9,
      binaryPath: "/opt/cloakbrowser",
      userDataDir: `/profiles/${profile.id}`,
      binarySha256: "a".repeat(64),
      personaDigest: "b".repeat(64),
    });

    const beforeProfile = store.getProfile(profile.id)!;
    const beforeRows = store.listUserRecords();
    const beforeLaunch = store.getLaunch(profile.id);
    const name = "  new-X-username  ";

    store.rename(profile.id, name);
    store.rename(profile.id, name);
    expect(store.getProfile(profile.id)).toEqual({ ...beforeProfile, name });
    expect(store.listUserRecords()).toEqual(beforeRows.map((row) => ({ ...row, name })));
    expect(store.getLaunch(profile.id)).toEqual(beforeLaunch);
    expect(store.count()).toBe(1);

    store.close();
    store = undefined;
    store = new ProfileStore(db);
    expect(store.getProfile(profile.id)).toEqual({ ...beforeProfile, name });
    expect(store.listUserRecords()).toEqual(beforeRows.map((row) => ({ ...row, name })));
    expect(store.getLaunch(profile.id)).toEqual(beforeLaunch);
    expect(store.count()).toBe(1);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store rejects malformed full-profile identity before persistence", () => {
  const store = memStore();
  const base = parseExport(SAMPLE).profiles[0]!;
  const invalid: Array<[Partial<Profile>, string]> = [
    [{ screenWidth: 1 }, "profile screen"],
    [{ screenHeight: -2 }, "profile screen"],
    [{ fingerprintSeed: 0 }, "fingerprintSeed"],
    [{ cookies: "not-an-array" as any }, "cookies must be an array"],
    [{ timezone: "Not/A_Timezone" }, "valid IANA timezone"],
    [{ extensions: [1] as any }, "extensions must be an array of strings"],
    [{ proxy: undefined as any }, "proxy must be an object or null"],
  ];

  for (const [change, message] of invalid) {
    expect(() => store.upsertProfile({ ...base, ...change })).toThrow(message);
  }
  expect(store.count()).toBe(0);
  store.close();
});

test("store ingress canonicalizes proxy types before persistence", () => {
  const store = memStore();
  const p = parseExport(SAMPLE).profiles[0]!;
  store.upsertProfile({
    ...p,
    proxy: { ...p.proxy!, type: " SOCKS5 " },
  } as unknown as Profile);
  expect(store.getProfile("k1d0cd11")!.proxy).toEqual({
    type: "socks5",
    host: "1.2.3.4",
    port: "8080",
    user: "u",
    pass: "p",
  });
  store.close();
});

test("store rejects unsafe ids on every profile upsert and rolls back a mixed batch", () => {
  const store = memStore();
  const p = parseExport(SAMPLE).profiles[0]!;
  expect(() => store.upsertProfile({ ...p, id: "../outside" })).toThrow("invalid profile id");
  expect(() => store.upsertProfiles([
    { ...p, id: "safe-profile" },
    { ...p, id: "safe/profile" },
  ])).toThrow("invalid profile id");
  expect(store.count()).toBe(0);
  store.close();
});

test("re-import preserves the seeded flag", () => {
  const store = memStore();
  const p = parseExport(SAMPLE).profiles[0]!;
  store.upsertProfile(p);
  store.markSeeded("k1d0cd11");
  expect(store.getProfile("k1d0cd11")!.seeded).toBe(true);

  // Re-importing the same profile (e.g. refreshed export) must not un-seed it.
  store.upsertProfile({ ...p, name: "renamed" } as Profile);
  const got = store.getProfile("k1d0cd11")!;
  expect(got.seeded).toBe(true);
  expect(got.name).toBe("renamed");
  store.close();
});

test("re-import with an empty timezone keeps the stored one (geoip failure must not erase it)", () => {
  const store = memStore();
  const p = parseExport(SAMPLE).profiles[0]!;
  store.upsertProfile({ ...p, timezone: "America/New_York" } as Profile);
  expect(store.getProfile("k1d0cd11")!.timezone).toBe("America/New_York");

  // A later re-import while ip-api was unreachable carries timezone "".
  store.upsertProfile({ ...p, timezone: "" } as Profile);
  expect(store.getProfile("k1d0cd11")!.timezone).toBe("America/New_York"); // preserved

  // A successful new lookup still updates it.
  store.upsertProfile({ ...p, timezone: "Europe/London" } as Profile);
  expect(store.getProfile("k1d0cd11")!.timezone).toBe("Europe/London");
  store.close();
});

test("re-import that changes the proxy with no new timezone clears the stale one", () => {
  const store = memStore();
  const p = parseExport(SAMPLE).profiles[0]!; // proxy host 1.2.3.4
  store.upsertProfile({ ...p, timezone: "America/New_York" } as Profile);

  // New export: different proxy, geoip unresolved (tz "") → stale NY must clear.
  const moved = { ...p, timezone: "", proxy: { ...p.proxy!, host: "5.6.7.8" } } as Profile;
  store.upsertProfile(moved);
  expect(store.getProfile("k1d0cd11")!.timezone).toBe("");

  // Same (new) proxy + empty tz → preserve (transient geoip failure).
  store.upsertProfile({ ...moved, timezone: "Asia/Tokyo" } as Profile);
  store.upsertProfile({ ...moved, timezone: "" } as Profile);
  expect(store.getProfile("k1d0cd11")!.timezone).toBe("Asia/Tokyo");
  store.close();
});

test("a corrupt JSON column doesn't break reads (returns safe defaults)", () => {
  const store = memStore();
  const p = parseExport(SAMPLE).profiles[0]!;
  store.upsertProfile(p);
  // Reach into the private db to simulate on-disk corruption.
  (store as any)["db"].query(`UPDATE profiles SET cookies_json = '{bad', proxy_json = 'nope' WHERE id = ?`).run("k1d0cd11");
  const got = store.getProfile("k1d0cd11")!; // must not throw
  expect(got.cookies).toEqual([]);
  expect(got.proxy).toBeNull();
  expect(got.proxyError).toBe("invalid stored proxy JSON");
  store.close();
});

test("legacy invalid proxies are quarantined per profile and remain repairable", () => {
  const store = memStore();
  const p = parseExport(SAMPLE).profiles[0]!;
  store.upsertProfile(p);
  store.upsertProfile({ ...p, id: "healthy" });
  const legacy = JSON.stringify({ type: "socks4", host: "legacy.example", port: "1080", user: "u", pass: "p" });
  (store as any)["db"].query("UPDATE profiles SET proxy_json = ? WHERE id = ?").run(legacy, p.id);

  const quarantined = store.getProfile(p.id)!;
  expect(quarantined.proxy).toBeNull();
  expect(quarantined.proxyError).toContain("unsupported proxy type");
  expect(store.listProfiles().map((profile) => profile.id)).toEqual(["healthy", p.id]);

  quarantined.name = "still visible";
  store.upsertProfile(quarantined);
  expect((store as any)["db"].query("SELECT proxy_json FROM profiles WHERE id = ?").get(p.id).proxy_json).toBe(legacy);

  quarantined.proxy = { type: "socks5", host: "fixed.example", port: "1080", user: "u", pass: "p" };
  delete quarantined.proxyError;
  store.upsertProfile(quarantined);
  expect(store.getProfile(p.id)!.proxy?.type).toBe("socks5");
  expect(store.getProfile(p.id)!.proxyError).toBeUndefined();
  store.close();
});

test("setGroup reassigns multiple profiles and ignores unknown ids", () => {
  const store = memStore();
  const p = parseExport(SAMPLE).profiles[0]!;
  store.upsertProfile(p);
  store.upsertProfile({ ...p, id: "k1d0cd22", group: "la2" } as Profile);

  const n = store.setGroup(["k1d0cd11", "k1d0cd22", "ghost"], "moved");
  expect(n).toBe(2); // unknown "ghost" ignored
  expect(store.getProfile("k1d0cd11")!.group).toBe("moved");
  expect(store.getProfile("k1d0cd22")!.group).toBe("moved");
  store.close();
});

test("launch records round-trip exact process, kernel, and persona identity", () => {
  const store = memStore();
  store.recordLaunch({
    profileId: "k1d0cd11",
    pid: 1234,
    debugPort: 9333,
    ws: "ws://x",
    startedAt: 111,
    sessionBaseVersion: 4,
    binaryPath: "/approved/cloak",
    userDataDir: "/profiles/k1d0cd11",
    binarySha256: "a".repeat(64),
    personaDigest: "b".repeat(64),
    headless: true,
    processGroupId: 1234,
    rootStartTime: "987654",
  });
  expect(store.getLaunch("k1d0cd11")).toEqual({
    profileId: "k1d0cd11",
    pid: 1234,
    debugPort: 9333,
    ws: "ws://x",
    startedAt: 111,
    sessionBaseVersion: 4,
    binaryPath: "/approved/cloak",
    userDataDir: "/profiles/k1d0cd11",
    binarySha256: "a".repeat(64),
    personaDigest: "b".repeat(64),
    headless: true,
    processGroupId: 1234,
    rootStartTime: "987654",
  });
  store.updateLaunchSessionBaseVersion("k1d0cd11", 5);
  expect(store.getLaunch("k1d0cd11")!.sessionBaseVersion).toBe(5);
  expect(store.listLaunches().length).toBe(1);
  store.clearLaunch("k1d0cd11");
  expect(store.getLaunch("k1d0cd11")).toBeNull();
  store.close();
});

test("temporary agent profile markers survive restart-style reads and clear on deletion", () => {
  const store = memStore();
  const profile = parseExport(SAMPLE).profiles[0]!;
  store.upsertProfile(profile);

  store.markAgentTemporary(profile.id);
  expect(store.listAgentTemporary()).toEqual([profile.id]);
  store.markAgentTemporary(profile.id);
  expect(store.listAgentTemporary()).toEqual([profile.id]);
  expect(store.deleteProfile(profile.id)).toBe(true);
  expect(store.listAgentTemporary()).toEqual([]);
  store.close();
});

test("count reflects imported profiles", () => {
  const store = memStore();
  for (const p of parseExport(SAMPLE).profiles) store.upsertProfile(p);
  expect(store.count()).toBe(1);
  store.close();
});

test("custom NO. round-trips and listProfileMeta numbers every profile", () => {
  const store = memStore();
  const p = parseExport(SAMPLE).profiles[0]!;
  store.upsertProfile({ ...p, customNo: "907341" });
  expect(store.getProfile("k1d0cd11")!.customNo).toBe("907341");

  // An unrelated edit must not silently drop the operator's number.
  store.upsertProfile({ ...store.getProfile("k1d0cd11")!, name: "renamed" });
  expect(store.getProfile("k1d0cd11")!.customNo).toBe("907341");

  // Clearing it is an explicit empty string, which falls back to the serial.
  store.upsertProfile({ ...store.getProfile("k1d0cd11")!, customNo: "" });
  expect(store.getProfile("k1d0cd11")!.customNo).toBe("");

  const meta = store.listProfileMeta();
  expect(meta.get("k1d0cd11")!.serial).toBe(store.getSerial("k1d0cd11")!);
  expect(meta.get("k1d0cd11")!.createdAt).toBeGreaterThan(0);
  expect(meta.get("k1d0cd11")!.lastOpenAt).toBe(0); // never launched
  store.close();
});

test("a profile stored before the custom_no column reads back as empty", () => {
  const store = memStore();
  const p = parseExport(SAMPLE).profiles[0]!;
  delete (p as { customNo?: string }).customNo;
  store.upsertProfile(p);
  expect(store.getProfile("k1d0cd11")!.customNo).toBe("");
  store.close();
});

// --- full-fidelity identity: platform and the fingerprint attestation ---

function fpProfile(id: string, overrides: Partial<Profile> = {}): Profile {
  return { ...parseExport(SAMPLE).profiles[0]!, id, ...overrides };
}

test("a profile round-trips platformOs and both fingerprint records", () => {
  const store = memStore();
  store.upsertProfile(fpProfile("fp0001", {
    platformOs: "windows",
    fpObserved: { canvas: "a3f19c8e", hardwareConcurrency: 8, capturedAt: "2026-08-29T11:04:22Z" },
    fpExpected: { canvas: "a3f19c8e" },
    fpVerdict: { verdict: "match", differences: [] },
  }));
  const back = store.getProfile("fp0001")!;
  expect(back.platformOs).toBe("windows");
  expect(back.fpObserved).toEqual({ canvas: "a3f19c8e", hardwareConcurrency: 8, capturedAt: "2026-08-29T11:04:22Z" });
  expect(back.fpExpected).toEqual({ canvas: "a3f19c8e" });
  store.close();
});

test("an upsert cannot assert its own verdict — only a real comparison writes one", () => {
  // Otherwise an import could hand itself a "verified" badge by putting one in
  // the payload, which would make the badge worthless. The verdict is written
  // ONLY by saveObservedFingerprint, from an actual measurement.
  const store = memStore();
  store.upsertProfile(fpProfile("fp0006", {
    fpExpected: { canvas: "a3f19c8e" },
    fpVerdict: { verdict: "match", differences: [] },
  }));
  expect(store.getProfile("fp0006")!.fpVerdict).toBeUndefined();
  store.saveObservedFingerprint("fp0006", { canvas: "a3f19c8e" }, { verdict: "match", differences: [] });
  expect(store.getProfile("fp0006")!.fpVerdict!.verdict).toBe("match");
  store.close();
});

test("a profile with no fingerprint data reads back with the fields absent", () => {
  const store = memStore();
  store.upsertProfile(fpProfile("fp0002", { platformOs: undefined }));
  const back = store.getProfile("fp0002")!;
  expect(back.fpObserved).toBeUndefined();
  expect(back.fpExpected).toBeUndefined();
  expect(back.fpVerdict).toBeUndefined();
  expect(back.platformOs).toBe("");
  store.close();
});

test("saveObservedFingerprint updates the capture and verdict without touching the expectation", () => {
  const store = memStore();
  store.upsertProfile(fpProfile("fp0003", { fpExpected: { canvas: "a3f19c8e" } }));
  store.saveObservedFingerprint(
    "fp0003",
    { canvas: "deadbeef" },
    { verdict: "mismatch", differences: [{ field: "canvas", expected: "a3f19c8e", observed: "deadbeef" }] },
  );
  const back = store.getProfile("fp0003")!;
  expect(back.fpObserved).toEqual({ canvas: "deadbeef" });
  expect(back.fpExpected).toEqual({ canvas: "a3f19c8e" });
  expect(back.fpVerdict!.verdict).toBe("mismatch");
  store.close();
});

test("an upsert that carries no capture preserves the one already stored", () => {
  const store = memStore();
  store.upsertProfile(fpProfile("fp0004"));
  store.saveObservedFingerprint("fp0004", { canvas: "a3f19c8e" }, null);
  store.upsertProfile(fpProfile("fp0004", { name: "renamed" }));
  const back = store.getProfile("fp0004")!;
  expect(back.name).toBe("renamed");
  expect(back.fpObserved).toEqual({ canvas: "a3f19c8e" });
  store.close();
});

test("a new expectation clears a verdict computed against the previous one", () => {
  const store = memStore();
  store.upsertProfile(fpProfile("fp0005", { fpExpected: { canvas: "a3f19c8e" } }));
  store.saveObservedFingerprint("fp0005", { canvas: "a3f19c8e" }, { verdict: "match", differences: [] });
  store.upsertProfile(fpProfile("fp0005", { fpExpected: { canvas: "ffffffff" } }));
  const back = store.getProfile("fp0005")!;
  expect(back.fpExpected).toEqual({ canvas: "ffffffff" });
  expect(back.fpVerdict).toBeUndefined();
  store.close();
});
