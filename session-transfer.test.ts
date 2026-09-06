import { expect, test } from "bun:test";
import { parseExport, parseUpdateFile, serializeAdsTxt, serializeXlsxRows } from "./parse.ts";
import { parseImportFile } from "./import-formats.ts";
import { importBuffers } from "./inbox.ts";
import { ProfileStore } from "./store.ts";
import { writeXlsx } from "./xlsx.ts";
import { handleUiRequest } from "./ui.ts";
import { Launcher } from "./launcher.ts";

const profile = () => parseExport("id=transfer\nname=Original\ncookie=[]").profiles[0]!;
const cookie = { name: "session", value: "test-only", domain: ".example.com", path: "/", secure: true, httpOnly: true };
const session = {
  cookies: [cookie],
  origins: [{ origin: "https://example.com", localStorage: [{ name: "device", value: "a=b\n***\n" + "x".repeat(40_000) }] }],
  tabs: ["https://example.com/account"],
};
const bundle = JSON.stringify(session);
const file = (text: string) => [{ name: "profiles.txt", bytes: new TextEncoder().encode(text) }];

test("TXT and long XLSX session fields round trip with one authoritative cookie jar", async () => {
  const exported = { ...profile(), sessionBundle: bundle };
  const txt = serializeAdsTxt([exported]);
  const parsed = parseExport(txt);
  expect(JSON.parse(parsed.imports[0]!.sessionBundle!)).toEqual(session);
  expect(parsed.profiles[0]!.cookies).toEqual([cookie]);
  expect(JSON.parse(txt.split("\n").find(line => line.startsWith("cookie="))!.slice(7))).toEqual([cookie]);
  const { headers, rows } = serializeXlsxRows([exported]);
  const sheet = await parseImportFile("profiles.xlsx", await writeXlsx(headers, rows));
  expect(JSON.parse(sheet.imports[0]!.sessionBundle!)).toEqual(session);
  expect(sheet.profiles[0]!.cookies).toEqual([cookie]);
  expect(parseUpdateFile(txt).updates[0]!.set).not.toHaveProperty("session");
});

test("session-only import overrides old cookies and persists outside the profile, without sparse reimport loss", async () => {
  const store = new ProfileStore(":memory:");
  try {
    store.upsertProfile(profile());
    await importBuffers(store, file(`id=transfer\nsession=${bundle}`), () => {});
    expect(store.getProfile("transfer")!.cookies).toEqual([cookie]);
    expect(store.getProfile("transfer")).not.toHaveProperty("sessionBundle");
    expect(store.getSessionBundle("transfer")).toBe(bundle);
    expect(store.getPendingSessionBundle("transfer")).toBe(bundle);
    await importBuffers(store, file("id=transfer\nname=Renamed"), () => {});
    expect(store.getPendingSessionBundle("transfer")).toBe(bundle);
    store.markSessionRestored("transfer", bundle);
    expect(store.getPendingSessionBundle("transfer")).toBeNull();
    store.saveSessionBundle("transfer", JSON.stringify({ cookies: [], origins: [] }));
    expect(store.getPendingSessionBundle("transfer")).toBeNull();
    expect(store.getProfile("transfer")!.name).toBe("Renamed");
  } finally { store.close(); }
});

test("malformed session rejects an entire batch and never exposes its value", async () => {
  const store = new ProfileStore(":memory:");
  try {
    store.upsertProfile(profile());
    for (const invalid of ['{"cookies":"private-test"}', '{"cookies":[],"origins":null}', '{"cookies":[],"origins":[{}]}', 'private-test']) {
      await expect(importBuffers(store, file(`id=new\nname=New\n***\nid=transfer\nsession=${invalid}`), () => {})).rejects.toThrow("invalid session");
      expect(store.count()).toBe(1);
      expect(store.getSessionBundle("transfer")).toBeNull();
    }
    await importBuffers(store, file('id=transfer\nsession={"cookies":[]}'), () => {});
    expect(JSON.parse(store.getSessionBundle("transfer")!)).toEqual({ cookies: [], origins: [] });
  } finally { store.close(); }
});

test("profile and imported-session writes roll back together", () => {
  const store = new ProfileStore(":memory:");
  try {
    store.upsertProfile(profile());
    expect(() => store.upsertProfiles([
      { ...profile(), name: "Changed" },
      { ...profile(), id: "../invalid" },
    ], new Map([["transfer", bundle]]))).toThrow();
    expect(store.getProfile("transfer")!.name).toBe("Original");
    expect(store.getSessionBundle("transfer")).toBeNull();
    expect(store.getPendingSessionBundle("transfer")).toBeNull();
  } finally { store.close(); }
});

test("Local full export uses live snapshots or saved fallback; CSV never captures", async () => {
  const store = new ProfileStore(":memory:");
  store.upsertProfile(profile());
  const launcher = new Launcher({ store });
  const request = (format: string) => handleUiRequest(new Request("http://x/ui/api/profiles/export", {
    method: "POST", body: JSON.stringify({ ids: ["transfer"], format }),
  }), launcher, store);
  try {
    const closed = await request("txt");
    expect(closed!.status).toBe(200);
    expect(await closed!.text()).toContain("session_source=stored-cookies");
    let captures = 0;
    launcher.captureLocalSession = async () => {
      captures++;
      store.saveSessionBundle("transfer", bundle);
      return true;
    };
    const live = await request("txt");
    const text = await live!.text();
    expect(text).toContain("session_source=live");
    expect(JSON.parse(parseExport(text).imports[0]!.sessionBundle!)).toEqual(session);
    expect(store.getProfile("transfer")!.cookies).toEqual([]);
    expect((await request("csv"))!.status).toBe(200);
    expect(captures).toBe(1);
    launcher.captureLocalSession = async () => false;
    const saved = await request("txt");
    const savedText = await saved!.text();
    expect(savedText).toContain("session_source=saved");
    expect(JSON.parse(parseExport(savedText).imports[0]!.sessionBundle!)).toEqual(session);
  } finally { store.close(); }
});

test("blank legacy session fields do not arm restoration", async () => {
  const store = new ProfileStore(":memory:");
  try {
    await importBuffers(store, file(serializeAdsTxt([profile()])), () => {});
    expect(store.getPendingSessionBundle("transfer")).toBeNull();
  } finally { store.close(); }
});
