import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUpdateFile, serializeCsv, serializeAdsTxt, serializeXlsxRows, rowsToUpdates, XLSX_COLUMNS, parseExport, recordToProfile } from "./parse.ts";
import { FP_BLOCK_KEYS } from "./fingerprint-attestation.ts";
import { deriveFingerprintFlags, deterministicSeed } from "./fingerprint.ts";
import { writeXlsx, readXlsx } from "./xlsx.ts";
import { handleUiRequest, type UiRuntimeOptions } from "./ui.ts";
import { encodePortableProfile } from "./portable-profile.ts";
import type { Launcher } from "./launcher.ts";

const NEWLINE = String.fromCharCode(10);
import { ProfileStore } from "./store.ts";
import type { Profile } from "./types.ts";

function profile(over: Partial<Profile> = {}): Profile {
  return {
    id: "p1", accId: "", name: "n", group: "", platform: "", username: "", password: "",
    twofa: "", proxy: null, ua: "", timezone: "", screenWidth: 1920, screenHeight: 1080,
    fingerprintSeed: 1, cookies: [], seeded: false, ...over,
  };
}

// ---- File-based bulk update (parseUpdateFile) ----

test("parseUpdateFile: partial CSV updates only present columns", () => {
  const { updates, skipped } = parseUpdateFile("id,name,group\np1,Renamed,NewGrp\nMISSING,x,y\n");
  expect(skipped).toBe(0);
  expect(updates).toEqual([
    { id: "p1", set: { name: "Renamed", group: "NewGrp" } },
    { id: "MISSING", set: { name: "x", group: "y" } },
  ]);
});

test("parseUpdateFile: CSV header aliases + quoted commas", () => {
  const { updates } = parseUpdateFile('id,email,emailpassword,pass,2fa\np1,a@b.com,mail-pw,"p,w",JBSW\n');
  expect(updates[0]).toEqual({
    id: "p1",
    set: { email: "a@b.com", emailPassword: "mail-pw", password: "p,w", twofa: "JBSW" },
  });
});

test("parseUpdateFile: AdsPower .txt blocks map fakey/proxytype", () => {
  const txt = "id=p1\ngroup=G\nplatform=x.com\nfakey=SECRET\nproxytype=socks5\nproxy=1.2.3.4:9\n******************\n";
  const { updates } = parseUpdateFile(txt);
  expect(updates[0]!.id).toBe("p1");
  expect(updates[0]!.set).toMatchObject({ group: "G", platform: "x.com", twofa: "SECRET", proxyType: "socks5", proxy: "1.2.3.4:9" });
});

test("parseUpdateFile: a file with no id column updates nothing", () => {
  // No `id` column → not treated as an update file → zero updates (safe no-op).
  expect(parseUpdateFile("name,group\nfoo,bar\n").updates).toHaveLength(0);
  expect(parseUpdateFile("id,name\n,blank-id-row\n").updates).toHaveLength(0);
});

// ---- Export serializers (round-trip) ----

test("serializeCsv/AdsTxt round-trip through parseUpdateFile", () => {
  const p = profile({
    id: "k1", name: "alice", group: "Warmup", platform: "x.com",
    username: "alice-user", password: "pw:1", email: "a@b.com", emailPassword: "mail-pw", twofa: "JBSW",
    proxy: { type: "http", host: "1.2.3.4", port: "8080", user: "u", pass: "p" },
  });
  const csv = serializeCsv([p]);
  expect(csv.split("\n")[0]).toBe("id,name,group,platform,proxy,proxytype,username,password,email,emailpassword,twofa,resolution");
  const fromCsv = parseUpdateFile(csv).updates[0]!;
  expect(fromCsv.id).toBe("k1");
  expect(fromCsv.set).toMatchObject({
    name: "alice", group: "Warmup", platform: "x.com", proxy: "1.2.3.4:8080:u:p",
    username: "alice-user", password: "pw:1", email: "a@b.com", emailPassword: "mail-pw", twofa: "JBSW",
  });

  const txt = serializeAdsTxt([p]);
  const fromTxt = parseUpdateFile(txt).updates[0]!;
  expect(fromTxt.id).toBe("k1");
  expect(fromTxt.set).toMatchObject({
    platform: "x.com", email: "a@b.com", emailPassword: "mail-pw", twofa: "JBSW", proxy: "1.2.3.4:8080:u:p",
  });
});

// ---- Excel export (full-fidelity sheet) ----

test("serializeXlsxRows emits the documented columns in order", () => {
  const { headers } = serializeXlsxRows([profile()]);
  expect(headers).toEqual([...XLSX_COLUMNS]);
  expect(headers[0]).toBe("id"); // first, so a re-upload can match rows
});

test("serializeXlsxRows carries the same values the .txt export writes", () => {
  const p = profile({
    id: "k1", accId: "476436", name: "alice", group: "Warmup", platform: "x.com",
    username: "alice-user", password: "pw:1", email: "a@b.com", emailPassword: "mail-pw", twofa: "JBSW",
    ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/143.0.0.0",
    screenWidth: 1680, screenHeight: 1050,
    proxy: { type: "http", host: "1.2.3.4", port: "8080", user: "u", pass: "p" },
    cookies: [{ name: "auth_token", value: "v1", domain: ".x.com", path: "/" }],
  });
  const { headers, rows } = serializeXlsxRows([p]);
  const cell = (k: string) => rows[0]![headers.indexOf(k)];

  // The .txt block is the reference encoding; the sheet must agree field for field.
  const block = Object.fromEntries(
    serializeAdsTxt([p]).split(NEWLINE).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  for (const key of ["id", "acc_id", "group", "platform", "name", "username", "password", "email", "emailpassword", "fakey", "cookie", "proxytype", "proxy", "ua", "resolution"]) {
    expect([key, cell(key)]).toEqual([key, block[key]!]);
  }
});

test("a profile survives the full export-to-Excel and read-back trip", async () => {
  const p = profile({
    id: "k1", name: "alice", group: "Warmup", platform: "x.com", twofa: "JBSW",
    proxy: { type: "socks5", host: "2001:db8::1", port: "1080", user: "u", pass: "p:ss" },
    cookies: [{ name: "auth_token", value: "v&<1>", domain: ".x.com", path: "/" }],
  });
  const { headers, rows } = serializeXlsxRows([p]);
  const back = await readXlsx(await writeXlsx(headers, rows));
  expect(back[0]!.id).toBe("k1");
  expect(back[0]!.proxy).toBe("[2001:db8::1]:1080:u:p:ss");
  expect(JSON.parse(back[0]!.cookie!)).toEqual(p.cookies);
});

test("rowsToUpdates maps an Excel row to the same edits the CSV path produces", async () => {
  const p = profile({
    id: "k1", name: "alice", group: "Warmup", platform: "x.com",
    username: "alice-user", password: "pw:1", email: "a@b.com", emailPassword: "mail-pw", twofa: "JBSW",
    proxy: { type: "http", host: "1.2.3.4", port: "8080", user: "u", pass: "p" },
  });
  const { headers, rows } = serializeXlsxRows([p]);
  const fromXlsx = rowsToUpdates(await readXlsx(await writeXlsx(headers, rows))).updates[0]!;

  expect(fromXlsx.id).toBe("k1");
  expect(fromXlsx.set).toMatchObject(parseUpdateFile(serializeCsv([p])).updates[0]!.set);
});

test("rowsToUpdates skips rows with no id instead of creating profiles", () => {
  const summary = rowsToUpdates([
    { id: "k1", name: "kept" },
    { id: "", name: "dropped" },
    { id: "   ", name: "dropped too" },
  ]);
  expect(summary.updates).toEqual([{ id: "k1", set: { name: "kept" } }]);
  expect(summary.skipped).toBe(2);
});

test("rowsToUpdates ignores identity columns, matching the .txt and .csv rules", () => {
  // cookie/ua/acc_id are exported for transfer, but "Edit from file" has never
  // rewritten an identity — an edited cookie column must stay inert here too.
  const { set } = rowsToUpdates([{ id: "k1", cookie: "[]", ua: "spoofed", acc_id: "9", name: "kept" }]).updates[0]!;
  expect(set).toEqual({ name: "kept" });
});

// ---- Groups: rename + delete ----

test("existing group registries gain empty extension defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-group-defaults-"));
  const path = join(root, "profiles.sqlite");
  const legacy = new Database(path, { create: true });
  legacy.exec(`CREATE TABLE groups (name TEXT PRIMARY KEY); INSERT INTO groups (name) VALUES ('Legacy')`);
  legacy.close();

  const s = new ProfileStore(path);
  expect(s.listGroupExtensionDefaults()).toContainEqual({ name: "Legacy", extensions: [] });
  s.close();
  rmSync(root, { recursive: true, force: true });
});

test("renameGroup moves members and migrates the registry", () => {
  const s = new ProfileStore(":memory:");
  s.upsertProfile(profile({ id: "a", group: "Old" }));
  s.upsertProfile(profile({ id: "b", group: "Old" }));
  expect(s.renameGroup("Old", "Fresh")).toBe(2);
  expect(s.getProfile("a")!.group).toBe("Fresh");
  expect(s.listGroups()).toContain("Fresh");
  expect(s.listGroups()).not.toContain("Old");
  s.close();
});

test("deleteGroup ungroups members (does not delete them)", () => {
  const s = new ProfileStore(":memory:");
  s.upsertProfile(profile({ id: "a", group: "Temp" }));
  expect(s.deleteGroup("Temp")).toBe(1);
  expect(s.getProfile("a")).not.toBeNull();
  expect(s.getProfile("a")!.group).toBe("");
  expect(s.listGroups()).not.toContain("Temp");
  s.close();
});

test("group extension defaults replace current members and seed moves", () => {
  const s = new ProfileStore(":memory:");
  s.upsertProfile(profile({ id: "a", group: "Sales", extensions: ["old"] }));
  s.upsertProfile(profile({ id: "b", group: "Sales" }));
  s.upsertProfile(profile({ id: "c", group: "Other", extensions: ["personal"] }));

  expect(s.setGroupExtensionDefaults("Sales", ["e2", "e1", "e2"])).toBe(2);
  expect(s.listGroupExtensionDefaults()).toContainEqual({ name: "Sales", extensions: ["e2", "e1"] });
  expect(s.getProfile("a")!.extensions).toEqual(["e2", "e1"]);
  expect(s.getProfile("b")!.extensions).toEqual(["e2", "e1"]);

  expect(s.setGroup(["c"], "Sales")).toBe(1);
  expect(s.getProfile("c")).toMatchObject({ group: "Sales", extensions: ["e2", "e1"] });
  s.close();
});

test("group inheritance preserves divergence on same-group and ungroup moves", () => {
  const s = new ProfileStore(":memory:");
  s.registerGroup("Sales");
  s.setGroupExtensionDefaults("Sales", ["default"]);
  s.upsertProfile(profile({ id: "a", group: "Sales", extensions: ["personal"] }));

  expect(s.setGroup(["a"], "Sales")).toBe(0);
  expect(s.getProfile("a")!.extensions).toEqual(["personal"]);
  expect(s.setGroup(["a"], "")).toBe(1);
  expect(s.getProfile("a")!.extensions).toEqual(["personal"]);
  s.close();
});

test("group default inheritance respects explicit assignments", () => {
  const s = new ProfileStore(":memory:");
  s.registerGroup("Sales");
  s.setGroupExtensionDefaults("Sales", ["default"]);
  const inherited = profile({ id: "a", group: "Sales", extensions: ["old"] });
  const explicit = profile({ id: "b", group: "Sales", extensions: ["chosen"] });

  s.applyGroupExtensionDefaults(inherited, "Other", false);
  s.applyGroupExtensionDefaults(explicit, "Other", true);
  expect(inherited.extensions).toEqual(["default"]);
  expect(explicit.extensions).toEqual(["chosen"]);
  s.close();
});

test("group rename carries defaults unless it merges into an existing group", () => {
  const s = new ProfileStore(":memory:");
  s.registerGroup("Old");
  s.setGroupExtensionDefaults("Old", ["source"]);
  expect(s.renameGroup("Old", "Fresh")).toBe(0);
  expect(s.getGroupExtensionDefaults("Fresh")).toEqual(["source"]);

  s.registerGroup("Destination");
  s.setGroupExtensionDefaults("Destination", ["destination"]);
  s.registerGroup("Merged");
  s.setGroupExtensionDefaults("Merged", ["discarded"]);
  expect(s.renameGroup("Merged", "Destination")).toBe(0);
  expect(s.getGroupExtensionDefaults("Destination")).toEqual(["destination"]);
  s.close();
});

// ---- Extensions registry + per-profile assignment ----

test("extensions: add/list/get/delete and assignment persistence", () => {
  const s = new ProfileStore(":memory:");
  s.addExtension({ id: "e1", name: "Ext One", loadDir: "/x/e1" });
  s.addExtension({ id: "e2", name: "Ext Two", loadDir: "/x/e2" });
  expect(s.listExtensions().map((e) => e.id).sort()).toEqual(["e1", "e2"]);
  expect(s.getExtension("e1")).toMatchObject({ name: "Ext One", loadDir: "/x/e1" });

  s.upsertProfile(profile({ id: "p", group: "Assigned", extensions: ["e1", "e2"] }));
  s.setGroupExtensionDefaults("Assigned", ["e1", "e2"]);
  expect(s.getProfile("p")!.extensions).toEqual(["e1", "e2"]);

  // Deleting unassigns from profiles and group defaults.
  s.unassignExtension("e1");
  s.deleteExtension("e1");
  expect(s.getExtension("e1")).toBeNull();
  expect(s.getProfile("p")!.extensions).toEqual(["e2"]);
  expect(s.getGroupExtensionDefaults("Assigned")).toEqual(["e2"]);
  s.close();
});

test("assignExtension: bulk add/remove across profiles (set semantics)", () => {
  const s = new ProfileStore(":memory:");
  s.addExtension({ id: "e1", name: "E1", loadDir: "/x/e1" });
  s.upsertProfile(profile({ id: "a", extensions: ["e1"] })); // already has it
  s.upsertProfile(profile({ id: "b" }));
  // add e1 to both: only b changes (a already had it, no dupe)
  expect(s.assignExtension(["a", "b"], "e1", true)).toBe(1);
  expect(s.getProfile("a")!.extensions).toEqual(["e1"]);
  expect(s.getProfile("b")!.extensions).toEqual(["e1"]);
  // remove from both
  expect(s.assignExtension(["a", "b"], "e1", false)).toBe(2);
  expect(s.getProfile("a")!.extensions).toEqual([]);
  expect(s.getProfile("b")!.extensions).toEqual([]);
  s.close();
});

// ---- Full-fidelity identity export ----

test("the export carries the restored identity fields", () => {
  const txt = serializeAdsTxt([
    profile({
      id: "k1d0cd11", fingerprintSeed: 2847193055, timezone: "America/New_York",
      platformOs: "windows", extensions: ["ext1"], tags: ["warm", "30day"],
    }),
  ]);
  expect(txt).toContain("seed=2847193055");
  expect(txt).toContain("timezone=America/New_York");
  expect(txt).toContain("platform_os=windows");
  expect(txt).toContain("extensions=ext1");
  expect(txt).toContain("tags=warm,30day");
});

test("full exports fill a blank UA from its capture without changing launch flags", async () => {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/146.0.0.0";
  const original = profile({
    platformOs: "windows", timezone: "America/New_York", fingerprintSeed: 1685817975,
    fpObserved: { ua, platform: "Win32", canvas: "captured-canvas" },
    cookies: [{ name: "session", value: "test-value", domain: ".example.com", path: "/", httpOnly: false, secure: false }],
  });
  const before = structuredClone(original);
  const txtProfile = parseExport(serializeAdsTxt([original])).profiles[0]!;
  const { headers, rows } = serializeXlsxRows([original]);
  const sheet = await readXlsx(await writeXlsx(headers, rows));
  const xlsxProfile = recordToProfile(sheet[0]!)!.profile;
  for (const restored of [txtProfile, xlsxProfile]) {
    const destination = new ProfileStore(":memory:");
    try {
      destination.upsertProfile(restored);
      const saved = destination.getProfile(original.id)!;
      expect(saved.ua).toBe(ua);
      expect(saved.cookies).toEqual(original.cookies);
      expect(saved.fpExpected).toEqual(original.fpObserved);
      expect(saved.fpObserved).toBeUndefined();
      expect(deriveFingerprintFlags(saved)).toEqual(deriveFingerprintFlags(original));
    } finally {
      destination.close();
    }
  }
  expect(original).toEqual(before);
});

test("export preserves the configured platform ahead of a conflicting capture", () => {
  for (const fields of [
    { platformOs: "macos" as const },
    { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
  ]) {
    const original = profile({ ...fields, fpObserved: { ua: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32" } });
    const restored = parseExport(serializeAdsTxt([original])).profiles[0]!;
    expect(restored.platformOs).toBe("macos");
    expect(deriveFingerprintFlags(restored)).toEqual(deriveFingerprintFlags(original));
    if (original.ua) expect(restored.ua).toBe(original.ua);
    else expect(restored.ua).toBe("");
  }
});

test("export pins a legacy platform from known fingerprint evidence only", () => {
  for (const [platform, platformOs] of [["Win32", "windows"], ["MacIntel", "macos"], ["Linux x86_64", "linux"]]) {
    const restored = parseExport(serializeAdsTxt([profile({ fpObserved: { platform } })])).profiles[0]!;
    expect(restored.platformOs).toBe(platformOs);
  }
  const expected = { ua: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32", canvas: "imported" };
  const restored = parseExport(serializeAdsTxt([profile({ fpExpected: expected })])).profiles[0]!;
  expect(restored.ua).toBe(expected.ua);
  expect(restored.platformOs).toBe("windows");
  expect(restored.fpExpected).toEqual(expected);
  const unknown = parseExport(serializeAdsTxt([profile()])).profiles[0]!;
  expect(unknown.ua).toBe("");
  expect(unknown.platformOs).toBe("");
  expect(unknown.fpExpected).toBeUndefined();
});

test("export does not combine partial observations with an older expectation", () => {
  const restored = parseExport(serializeAdsTxt([profile({
    fpObserved: { canvas: "new-canvas" },
    fpExpected: { ua: "Mozilla/5.0 (Windows NT 10.0)", canvas: "old-canvas" },
  })])).profiles[0]!;
  expect(restored.ua).toBe("");
  expect(restored.fpExpected).toEqual({ canvas: "new-canvas" });
});

test("Cloud exports retain local fingerprint evidence without using cached profile fields", async () => {
  const store = new ProfileStore(":memory:");
  const ua = "Mozilla/5.0 (Windows NT 10.0) Chrome/146.0.0.0";
  const expected = { ua, platform: "Win32", canvas: "imported-canvas" };
  const authoritative = profile({ name: "Cloud name", platformOs: "windows", fingerprintSeed: 123456 });
  const options = {
    cloudBrowser: {},
    cloudConnection: { client: { async getProfile() { return { payload: encodePortableProfile(authoritative) }; } } },
  } as unknown as UiRuntimeOptions;
  try {
    for (const observed of [undefined, { ...expected, canvas: "local-canvas" }]) {
      store.upsertProfile(profile({ name: "Stale local name", fpExpected: expected, fpObserved: observed }));
      for (const format of ["txt", "xlsx"]) {
        const response = await handleUiRequest(new Request("http://localhost/ui/api/profiles/export", {
          method: "POST", body: JSON.stringify({ ids: [authoritative.id], format }),
        }), {} as Launcher, store, null, options);
        expect(response!.status).toBe(200);
        const restored = format === "txt"
          ? parseExport(await response!.text()).profiles[0]!
          : recordToProfile((await readXlsx(new Uint8Array(await response!.arrayBuffer())))[0]!)!.profile;
        expect(restored.name).toBe(authoritative.name);
        expect(restored.fingerprintSeed).toBe(authoritative.fingerprintSeed);
        expect(restored.ua).toBe(ua);
        expect(restored.fpExpected).toEqual(observed ?? expected);
        expect(deriveFingerprintFlags(restored)).toEqual(deriveFingerprintFlags(authoritative));
      }
    }
  } finally {
    store.close();
  }
});

test("the export carries the measured fingerprint", () => {
  const txt = serializeAdsTxt([
    profile({
      id: "k1d0cd11",
      fpObserved: { canvas: "a3f19c8e", webglRenderer: "ANGLE (Intel, Mesa)", hardwareConcurrency: 8 },
    }),
  ]);
  expect(txt).toContain("fp_canvas=a3f19c8e");
  expect(txt).toContain("fp_webgl_renderer=ANGLE (Intel, Mesa)");
  expect(txt).toContain("fp_hw_concurrency=8");
});

test("a never-launched profile exports blank fp_ fields, not missing ones", () => {
  const txt = serializeAdsTxt([profile({ id: "k1d0cd11" })]);
  for (const key of FP_BLOCK_KEYS) expect(txt).toContain(`${key}=${NEWLINE}`);
});

test("existing columns keep their positions so operators' sheets do not shift", () => {
  expect(XLSX_COLUMNS.slice(0, 15)).toEqual([
    "id", "acc_id", "group", "platform", "name", "username", "password",
    "email", "emailpassword", "fakey", "cookie", "proxytype", "proxy", "ua", "resolution",
  ]);
});

test("a full export -> import round trip reproduces the identity exactly", () => {
  const original = profile({
    id: "k1d0cd11",
    // The marketplace case: a seed that is NOT derived from the id.
    fingerprintSeed: deterministicSeed("marketplace:melaniecanlq"),
    timezone: "America/New_York",
    platformOs: "macos",
    screenWidth: 1680,
    screenHeight: 1050,
    extensions: ["ext1"],
    tags: ["warm"],
    fpObserved: { canvas: "canvas-one", hardwareConcurrency: 8 },
  });
  const restored = parseExport(serializeAdsTxt([original])).profiles[0]!;
  expect(restored.fingerprintSeed).toBe(original.fingerprintSeed);
  expect(restored.timezone).toBe("America/New_York");
  expect(restored.platformOs).toBe("macos");
  expect(restored.screenWidth).toBe(1680);
  expect(restored.extensions).toEqual(["ext1"]);
  expect(restored.tags).toEqual(["warm"]);
  expect(restored.fpExpected).toEqual({ canvas: "canvas-one", hardwareConcurrency: 8 });
  expect(restored.fpObserved).toBeUndefined();
  expect(parseExport(serializeAdsTxt([restored])).profiles[0]!.fpExpected).toEqual(restored.fpExpected);
  expect(deriveFingerprintFlags(restored)).toEqual(deriveFingerprintFlags(original));
});

test("the same round trip survives the spreadsheet, which is what operators edit", async () => {
  const original = profile({
    id: "k1d0cd11",
    fingerprintSeed: deterministicSeed("marketplace:melaniecanlq"),
    timezone: "Europe/London",
    platformOs: "windows",
    fpObserved: { webglRenderer: "ANGLE (NVIDIA)", deviceMemory: 8 },
  });
  const { headers, rows } = serializeXlsxRows([original]);
  const back = await readXlsx(await writeXlsx(headers, rows));
  const restored = recordToProfile(back[0] as Record<string, string>)!.profile;
  expect(restored.fingerprintSeed).toBe(original.fingerprintSeed);
  expect(restored.timezone).toBe("Europe/London");
  expect(restored.platformOs).toBe("windows");
  expect(restored.fpExpected).toEqual({ webglRenderer: "ANGLE (NVIDIA)", deviceMemory: 8 });
  expect(restored.fpObserved).toBeUndefined();
});
