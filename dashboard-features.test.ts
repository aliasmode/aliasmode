import { test, expect } from "bun:test";
import { parseUpdateFile, serializeCsv, serializeAdsTxt, serializeXlsxRows, rowsToUpdates, XLSX_COLUMNS } from "./parse.ts";
import { writeXlsx, readXlsx } from "./xlsx.ts";

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

// ---- Extensions registry + per-profile assignment ----

test("extensions: add/list/get/delete and assignment persistence", () => {
  const s = new ProfileStore(":memory:");
  s.addExtension({ id: "e1", name: "Ext One", loadDir: "/x/e1" });
  s.addExtension({ id: "e2", name: "Ext Two", loadDir: "/x/e2" });
  expect(s.listExtensions().map((e) => e.id).sort()).toEqual(["e1", "e2"]);
  expect(s.getExtension("e1")).toMatchObject({ name: "Ext One", loadDir: "/x/e1" });

  s.upsertProfile(profile({ id: "p", extensions: ["e1", "e2"] }));
  expect(s.getProfile("p")!.extensions).toEqual(["e1", "e2"]);

  // Deleting unassigns from profiles.
  s.unassignExtension("e1");
  s.deleteExtension("e1");
  expect(s.getExtension("e1")).toBeNull();
  expect(s.getProfile("p")!.extensions).toEqual(["e2"]);
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
