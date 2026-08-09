import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileStore } from "./store.ts";
import { importBuffers, importInbox } from "./inbox.ts";
import { parseExport } from "./parse.ts";

const REC = (id: string) => `id=${id}
name=acct-${id}
group=g
cookie=[{"name":"auth_token","value":"v","domain":".x.com","path":"/","session":false,"expires":1788000000},{"name":"ext","value":"x","domain":"browserext.adspower.net","path":"/","session":true}]
proxytype=http
proxy=1.2.3.4:8080:u:p
ua=Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/143.0.0.0 Safari/537.36
resolution=1680*1050
******************`;

test("importInbox imports every .txt and ignores non-txt files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cloak-inbox-"));
  writeFileSync(join(dir, "batch1.txt"), REC("k1a0001") + "\n" + REC("k1a0002"));
  writeFileSync(join(dir, "batch2.txt"), REC("k1a0003"));
  writeFileSync(join(dir, "notes.md"), "id=should_not_import"); // wrong extension → skipped
  const store = new ProfileStore(":memory:");

  const r = await importInbox(store, dir);
  expect(r.files).toBe(2);
  expect(r.profiles).toBe(3);
  expect(r.cookiesStripped).toBe(3); // one adspower ext cookie per record
  expect(store.count()).toBe(3);
  expect(store.getProfile("should_not_import")).toBeNull();

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("re-importing the inbox preserves the seeded flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cloak-inbox-"));
  writeFileSync(join(dir, "batch.txt"), REC("k1a0001"));
  const store = new ProfileStore(":memory:");

  await importInbox(store, dir);
  store.markSeeded("k1a0001");
  await importInbox(store, dir); // drop again / refresh
  expect(store.getProfile("k1a0001")!.seeded).toBe(true);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("importBuffers applies a group override before upsert", async () => {
  const store = new ProfileStore(":memory:");
  const r = await importBuffers(
    store,
    [{ name: "batch.txt", bytes: new TextEncoder().encode(REC("k1a0001")) }],
    () => {},
    { group: "selected" },
  );
  expect(r.profiles).toBe(1);
  expect(store.getProfile("k1a0001")!.group).toBe("selected");
  store.close();
});

test("importBuffers rejects a malformed proxy without partially writing valid records", async () => {
  const store = new ProfileStore(":memory:");
  const malformed = REC("bad-proxy").replace("proxytype=http", "proxytype=socks4");
  const valid = REC("good-profile").replace(
    "proxytype=http\nproxy=1.2.3.4:8080:u:p",
    "proxytype=\nproxy=",
  );
  const logs: string[] = [];

  await expect(importBuffers(
    store,
    [{ name: "mixed.txt", bytes: new TextEncoder().encode(`${malformed}\n${valid}`) }],
    (message) => logs.push(message),
  )).rejects.toThrow("unsafe import rejected; no profiles were changed");

  expect(store.count()).toBe(0);
  expect(store.getProfile("bad-proxy")).toBeNull();
  expect(store.getProfile("good-profile")).toBeNull();
  store.close();
});

test("sparse same-id re-import updates only present fields and preserves identity state", async () => {
  const store = new ProfileStore(":memory:");
  const original = {
    ...parseExport(REC("k1a0001")).profiles[0]!,
    platform: "x.com",
    username: "account@example.com",
    password: "secret",
    twofa: "JBSWY3DPEHPK3PXP",
    timezone: "America/New_York",
    extensions: ["wallet"],
    tags: ["returning-account"],
  };
  store.upsertProfile(original);
  store.markSeeded(original.id);

  const sparse = new TextEncoder().encode(`id=${original.id}\nname=renamed\ntags=stale-export-tag\nextensions=stale-extension\n******************`);
  await importBuffers(store, [{ name: "sparse.txt", bytes: sparse }], () => {});

  const got = store.getProfile(original.id)!;
  expect(got.name).toBe("renamed");
  expect(got.platform).toBe("x.com");
  expect(got.username).toBe("account@example.com");
  expect(got.password).toBe("secret");
  expect(got.twofa).toBe("JBSWY3DPEHPK3PXP");
  expect(got.proxy).toEqual(original.proxy);
  expect(got.cookies).toEqual(original.cookies);
  expect(got.ua).toBe(original.ua);
  expect([got.screenWidth, got.screenHeight]).toEqual([original.screenWidth, original.screenHeight]);
  expect(got.fingerprintSeed).toBe(original.fingerprintSeed);
  expect(got.timezone).toBe("America/New_York");
  expect(got.extensions).toEqual(["wallet"]);
  expect(got.tags).toEqual(["returning-account"]);
  expect(got.seeded).toBe(true);
  store.close();
});

test("sparse re-import preserves a quarantined legacy proxy for later repair", async () => {
  const store = new ProfileStore(":memory:");
  const original = parseExport(REC("legacy-proxy")).profiles[0]!;
  store.upsertProfile(original);
  const raw = JSON.stringify({ type: "socks4", host: "legacy.example", port: "1080", user: "u", pass: "p" });
  (store as any)["db"].query("UPDATE profiles SET proxy_json = ? WHERE id = ?").run(raw, original.id);
  expect(store.getProfile(original.id)!.proxyError).toContain("unsupported proxy type");

  await importBuffers(
    store,
    [{ name: "sparse.txt", bytes: new TextEncoder().encode(`id=${original.id}\nname=renamed\n******************`) }],
    () => {},
  );
  const got = store.getProfile(original.id)!;
  expect(got.name).toBe("renamed");
  expect(got.proxy).toBeNull();
  expect(got.proxyError).toContain("unsupported proxy type");
  expect((store as any)["db"].query("SELECT proxy_json FROM profiles WHERE id = ?").get(original.id).proxy_json).toBe(raw);
  store.close();
});

test("malformed same-id import rejects the whole batch before any profile changes", async () => {
  const store = new ProfileStore(":memory:");
  const original = parseExport(REC("existing")).profiles[0]!;
  store.upsertProfile(original);
  const upload = `id=new-profile\nname=new\n******************\nid=existing\nname=erased\ncookie={broken\n******************`;

  await expect(importBuffers(
    store,
    [{ name: "bad.txt", bytes: new TextEncoder().encode(upload) }],
    () => {},
  )).rejects.toThrow("unsafe import rejected; no profiles were changed");
  expect(store.count()).toBe(1);
  expect(store.getProfile("new-profile")).toBeNull();
  expect(store.getProfile("existing")!.name).toBe(original.name);
  expect(store.getProfile("existing")!.cookies).toEqual(original.cookies);
  store.close();
});

test("impossible screens and invalid proxies reject the whole re-import batch", async () => {
  const invalidFields = [
    "resolution=0x0",
    "resolution=99999x1080",
    "proxytype=gopher\nproxy=9.9.9.9:8080:u:p",
    "proxytype=http\nproxy=bad host:8080:u:p",
  ];
  for (const field of invalidFields) {
    const store = new ProfileStore(":memory:");
    const original = parseExport(REC("existing")).profiles[0]!;
    store.upsertProfile(original);
    const upload = [
      "id=new-profile\nname=must-not-land\nresolution=1280x720",
      `id=existing\nname=must-not-change\n${field}`,
    ].join("\n******************\n") + "\n******************";

    await expect(importBuffers(
      store,
      [{ name: "invalid-identity.txt", bytes: new TextEncoder().encode(upload) }],
      () => {},
    )).rejects.toThrow("unsafe import rejected; no profiles were changed");
    expect(store.count()).toBe(1);
    const got = store.getProfile("existing")!;
    expect(got.name).toBe(original.name);
    expect(got.proxy).toEqual(original.proxy);
    expect([got.screenWidth, got.screenHeight]).toEqual([original.screenWidth, original.screenHeight]);
    expect(store.getProfile("new-profile")).toBeNull();
    store.close();
  }
});

test("an unsafe profile id rejects the whole import before any row changes", async () => {
  for (const unsafeId of ["../shared", "safe/shared", "safe\\shared", "safe%2Fshared", ".", "C:\\shared"]) {
    const store = new ProfileStore(":memory:");
    const original = parseExport(REC("existing")).profiles[0]!;
    store.upsertProfile(original);
    const upload = [
      "id=existing\nname=must-not-change",
      `id=${unsafeId}\nname=must-not-land`,
    ].join("\n******************\n") + "\n******************";

    await expect(importBuffers(
      store,
      [{ name: "unsafe-id.txt", bytes: new TextEncoder().encode(upload) }],
      () => {},
    )).rejects.toThrow("invalid profile id");
    expect(store.count()).toBe(1);
    expect(store.getProfile("existing")!.name).toBe(original.name);
    expect(store.getProfile(unsafeId)).toBeNull();
    store.close();
  }
});

test("blank same-id fields cannot silently erase stored proxy, cookies, UA, or screen", async () => {
  const store = new ProfileStore(":memory:");
  const original = parseExport(REC("existing")).profiles[0]!;
  store.upsertProfile(original);
  const upload = `id=existing\nproxy=\ncookie=\nua=\nresolution=\n******************`;

  await expect(importBuffers(
    store,
    [{ name: "blank.txt", bytes: new TextEncoder().encode(upload) }],
    () => {},
  )).rejects.toThrow("blank proxy would erase the stored proxy");
  const got = store.getProfile("existing")!;
  expect(got.proxy).toEqual(original.proxy);
  expect(got.cookies).toEqual(original.cookies);
  expect(got.ua).toBe(original.ua);
  expect([got.screenWidth, got.screenHeight]).toEqual([original.screenWidth, original.screenHeight]);
  store.close();
});

test("valid explicit empty cookie array can intentionally clear stored cookies", async () => {
  const store = new ProfileStore(":memory:");
  const original = parseExport(REC("existing")).profiles[0]!;
  store.upsertProfile(original);
  await importBuffers(
    store,
    [{ name: "clear.txt", bytes: new TextEncoder().encode("id=existing\ncookie=[]\n******************") }],
    () => {},
  );
  expect(store.getProfile("existing")!.cookies).toEqual([]);
  expect(store.getProfile("existing")!.proxy).toEqual(original.proxy);
  store.close();
});

test("stripping extension-only cookie input cannot accidentally clear stored auth cookies", async () => {
  const store = new ProfileStore(":memory:");
  const original = parseExport(REC("existing")).profiles[0]!;
  store.upsertProfile(original);
  const onlyExtension = JSON.stringify([{ name: "ext", value: "x", domain: "browserext.adspower.net", path: "/" }]);
  await expect(importBuffers(
    store,
    [{ name: "extensions.txt", bytes: new TextEncoder().encode(`id=existing\ncookie=${onlyExtension}\n******************`) }],
    () => {},
  )).rejects.toThrow("contained only stripped extension cookies");
  expect(store.getProfile("existing")!.cookies).toEqual(original.cookies);
  store.close();
});

test("duplicate ids across an import batch reject deterministically instead of last-file-wins", async () => {
  const store = new ProfileStore(":memory:");
  await expect(importBuffers(
    store,
    [
      { name: "old.txt", bytes: new TextEncoder().encode("id=duplicate\nname=old\n******************") },
      { name: "new.txt", bytes: new TextEncoder().encode("id=duplicate\nname=new\n******************") },
    ],
    () => {},
  )).rejects.toThrow("duplicate profile id duplicate");
  expect(store.count()).toBe(0);
  store.close();
});

test("the pre-commit guard can abort an import without writing any prepared rows", async () => {
  const store = new ProfileStore(":memory:");
  const upload = "id=guarded\nname=must-not-land\n******************";
  let guardedIds: string[] = [];
  await expect(importBuffers(
    store,
    [{ name: "guarded.txt", bytes: new TextEncoder().encode(upload) }],
    () => {},
    {},
    (profiles) => {
      guardedIds = profiles.map((profile) => profile.id);
      throw new Error("became locked");
    },
  )).rejects.toThrow("became locked");
  expect(guardedIds).toEqual(["guarded"]);
  expect(store.getProfile("guarded")).toBeNull();
  store.close();
});

test("re-import refuses to change a profile with a live local launch", async () => {
  const store = new ProfileStore(":memory:");
  const original = parseExport(REC("live-profile")).profiles[0]!;
  store.upsertProfile(original);
  store.recordLaunch({
    profileId: original.id,
    pid: 123,
    debugPort: 9333,
    ws: "ws://127.0.0.1:9333/devtools/browser/live",
    startedAt: Date.now(),
  });
  await expect(importBuffers(
    store,
    [{ name: "live.txt", bytes: new TextEncoder().encode(`id=${original.id}\nname=changed\n******************`) }],
    () => {},
  )).rejects.toThrow("currently open; close them before importing");
  expect(store.getProfile(original.id)!.name).toBe(original.name);
  store.close();
});

test("importInbox creates the inbox dir when missing", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "cloak-inbox-")), "nested-inbox");
  const store = new ProfileStore(":memory:");
  const r = await importInbox(store, dir); // dir does not exist yet
  expect(r.files).toBe(0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
