import { test, expect } from "bun:test";
import { ProfileStore } from "./store.ts";
import type { Launcher } from "./launcher.ts";
import { parseExport } from "./parse.ts";
import { handleUserApi } from "./adspower-users.ts";

const SAMPLE = `id=k1d0cd11
name=acct
group=g
cookie=[{"name":"auth_token","value":"v","domain":".x.com","path":"/","session":false,"expires":4070908800}]
proxytype=http
proxy=1.2.3.4:8080:u:p
ua=Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/143.0.0.0 Safari/537.36
resolution=1680*1050
******************`;

/** A fresh in-memory store seeded with one profile, plus a stub launcher (the
 *  management routes only touch userDataDir/stop, and only on delete). */
function setup() {
  const store = new ProfileStore(":memory:");
  for (const p of parseExport(SAMPLE).profiles) store.upsertProfile(p);
  const launcher = {
    userDataDir: (id: string) => `/tmp/cloak-adspower-users-test/${id}`,
    stop: async () => true,
    removeUserDataDir: () => true,
  } as unknown as Launcher;
  return { store, launcher };
}

// geoip stub so create resolves a deterministic timezone without hitting the network.
const geoip = async () => ({
  json: async () => [{ query: "9.9.9.9", timezone: "America/New_York", status: "success" }],
});

const get = (path: string) => new Request(`http://127.0.0.1:50400${path}`);
const post = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1:50400${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("group/list returns distinct labels as id==name", async () => {
  const { store, launcher } = setup();
  const res = await handleUserApi(get("/api/v1/group/list?page=1&page_size=100"), launcher, store);
  expect(res).not.toBeNull();
  const body = await res!.json();
  expect(body.code).toBe(0);
  expect(body.data.list).toEqual([{ group_id: "g", group_name: "g" }]);
});

test("group/create registers an empty folder that group/list then returns", async () => {
  const { store, launcher } = setup();
  const created = await (await handleUserApi(post("/api/v1/group/create", { group_name: "emptyfolder" }), launcher, store))!.json();
  expect(created.code).toBe(0);
  expect(created.data.group_id).toBe("emptyfolder"); // id == name

  // Listed even though no profile uses it yet — so the client's find_group_id resolves it.
  const names = (await (await handleUserApi(get("/api/v1/group/list"), launcher, store))!.json()).data.list.map(
    (g: any) => g.group_name,
  );
  expect(names).toContain("emptyfolder");
  expect(names).toContain("g"); // existing populated group still present
});

test("group/create requires a name", async () => {
  const { store, launcher } = setup();
  const body = await (await handleUserApi(post("/api/v1/group/create", { group_name: "  " }), launcher, store))!.json();
  expect(body.code).toBe(-1);
});

test("user/list returns AdsPower-shaped rows with timestamps + serial", async () => {
  const { store, launcher } = setup();
  const body = await (await handleUserApi(get("/api/v1/user/list?page=1&page_size=100"), launcher, store))!.json();
  const row = body.data.list.find((r: any) => r.user_id === "k1d0cd11");
  expect(row).toBeTruthy();
  expect(row.name).toBe("acct");
  expect(row.group_id).toBe("g");
  expect(typeof row.serial_number).toBe("string");
  expect(row.created_time).toBeGreaterThan(0); // created_at set on the seeding upsert
  expect(row.last_open_time).toBe(0); // never launched
});

test("user/list filters by group_id; '0' means ungrouped", async () => {
  const { store, launcher } = setup();
  const inGroup = await (await handleUserApi(get("/api/v1/user/list?group_id=g"), launcher, store))!.json();
  expect(inGroup.data.list.length).toBe(1);
  const ungrouped = await (await handleUserApi(get("/api/v1/user/list?group_id=0"), launcher, store))!.json();
  expect(ungrouped.data.list.length).toBe(0);
});

test("user/create maps AdsPower payload → profile (proxy, screen, geoip tz, group '0'→ungrouped)", async () => {
  const { store, launcher } = setup();
  const res = await handleUserApi(
    post("/api/v1/user/create", {
      name: "newacct",
      group_id: "0",
      domain_name: "x.com",
      username: "alice",
      password: "x-password",
      email: "alice@example.com",
      email_password: "mail-password",
      fakey: "M4YHM7YCL73FLIEV",
      fingerprint_config: { screen_resolution: "1600_900" },
      user_proxy_config: {
        proxy_type: "http",
        proxy_host: "9.9.9.9",
        proxy_port: "8000",
        proxy_user: "u",
        proxy_password: "p",
      },
    }),
    launcher,
    store,
    null,
    geoip,
  );
  const body = await res!.json();
  expect(body.code).toBe(0);
  const id = body.data.id as string;
  expect(typeof id).toBe("string");

  const p = store.getProfile(id)!;
  expect(p.name).toBe("newacct");
  expect(p.group).toBe(""); // "0" → ungrouped
  expect(p.platform).toBe("x.com");
  expect(p.username).toBe("alice");
  expect(p.password).toBe("x-password");
  expect(p.email).toBe("alice@example.com");
  expect(p.emailPassword).toBe("mail-password");
  expect(p.twofa).toBe("M4YHM7YCL73FLIEV");
  expect(p.proxy).toEqual({ type: "http", host: "9.9.9.9", port: "8000", user: "u", pass: "p" });
  expect(p.screenWidth).toBe(1600);
  expect(p.screenHeight).toBe(900);
  expect(p.timezone).toBe("America/New_York");
  expect(p.fingerprintSeed).toBeGreaterThan(0);
});

test("user/create without a proxy succeeds and skips geoip", async () => {
  const { store, launcher } = setup();
  const body = await (await handleUserApi(post("/api/v1/user/create", { name: "noproxy", group_id: "g" }), launcher, store))!.json();
  expect(body.code).toBe(0);
  const p = store.getProfile(body.data.id)!;
  expect(p.proxy).toBeNull();
  expect(p.group).toBe("g");
});

test("user/update persists the exact name and AdsPower credential fields", async () => {
  const { store, launcher } = setup();
  const before = store.getProfile("k1d0cd11")!;
  const payload = {
    user_id: "k1d0cd11",
    name: "  renamed exactly  ",
    username: "new_handle",
    password: "x-password",
    email: "alice@example.com",
    email_password: "mail-password",
    fakey: "M4YHM7YCL73FLIEV",
  };
  for (let i = 0; i < 2; i++) {
    const res = await handleUserApi(post("/api/v1/user/update", payload), launcher, store);
    expect(await res!.json()).toEqual({ code: 0, msg: "success", data: {} });
  }

  const updated = store.getProfile("k1d0cd11")!;
  expect(updated).toMatchObject({
    name: payload.name,
    username: payload.username,
    password: payload.password,
    email: payload.email,
    emailPassword: payload.email_password,
    twofa: payload.fakey,
  });
  expect(updated.proxy).toEqual(before.proxy);
  expect(updated.cookies).toEqual(before.cookies);
  expect(updated.fingerprintSeed).toBe(before.fingerprintSeed);
  expect(store.count()).toBe(1);

  const listed = await (await handleUserApi(get("/api/v1/user/list"), launcher, store))!.json();
  expect(listed.data.list.find((row: any) => row.user_id === "k1d0cd11")!.name).toBe(payload.name);
});

test("user/update leaves omitted credentials unchanged", async () => {
  const { store, launcher } = setup();
  const profile = store.getProfile("k1d0cd11")!;
  Object.assign(profile, {
    username: "existing",
    password: "existing-password",
    email: "existing@example.com",
    emailPassword: "existing-mail-password",
    twofa: "EXISTINGSEED",
  });
  store.upsertProfile(profile);

  const body = await (await handleUserApi(
    post("/api/v1/user/update", { user_id: profile.id, name: "renamed" }),
    launcher,
    store,
  ))!.json();

  expect(body.code).toBe(0);
  expect(store.getProfile(profile.id)).toMatchObject({
    name: "renamed",
    username: "existing",
    password: "existing-password",
    email: "existing@example.com",
    emailPassword: "existing-mail-password",
    twofa: "EXISTINGSEED",
  });
});

test("user/update on an unknown id fails AdsPower-style", async () => {
  const { store, launcher } = setup();
  const body = await (await handleUserApi(post("/api/v1/user/update", { user_id: "nope", name: "x" }), launcher, store))!.json();
  expect(body.code).toBe(-1);
  expect(body.msg).toContain("no such profile: nope");
});

test("user/update rejects invalid names without changing the profile", async () => {
  const { store, launcher } = setup();
  for (const name of [undefined, null, 7, "", " \t "]) {
    const body = await (await handleUserApi(post("/api/v1/user/update", { user_id: "k1d0cd11", name }), launcher, store))!.json();
    expect(body.code).toBe(-1);
    expect(body.msg).toBe("name must be a non-empty string");
  }
  expect(store.getProfile("k1d0cd11")!.name).toBe("acct");
});

test("user/update returns a useful persistence failure", async () => {
  const { store, launcher } = setup();
  store.upsertProfile = () => { throw new Error("database is read-only"); };
  const body = await (await handleUserApi(post("/api/v1/user/update", { user_id: "k1d0cd11", name: "x" }), launcher, store))!.json();
  expect(body.code).toBe(-1);
  expect(body.msg).toBe("failed to persist profile update: database is read-only");
  expect(store.getProfile("k1d0cd11")!.name).toBe("acct");
});

test("user/delete removes the profile row", async () => {
  const { store } = setup();
  const stopped: string[] = [];
  const launcher = {
    stop: async (id: string) => { stopped.push(id); return true; },
    removeUserDataDir: () => true,
  } as unknown as Launcher;
  const body = await (await handleUserApi(post("/api/v1/user/delete", { user_ids: ["k1d0cd11"] }), launcher, store))!.json();
  expect(body.code).toBe(0);
  expect(body.data.deleted).toBe(1);
  expect(stopped).toEqual(["k1d0cd11"]);
  expect(store.getProfile("k1d0cd11")).toBeNull();
});

test("user/delete preserves a running profile when teardown is unconfirmed", async () => {
  const { store } = setup();
  store.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9333, ws: "ws://x", startedAt: 1 });
  const launcher = {
    stop: async () => false,
    removeUserDataDir: () => { throw new Error("must not remove a live profile"); },
  } as unknown as Launcher;

  const body = await (await handleUserApi(post("/api/v1/user/delete", { user_ids: ["k1d0cd11"] }), launcher, store))!.json();
  expect(body.code).toBe(0);
  expect(body.data.deleted).toBe(0);
  expect(body.data.locked).toEqual(["k1d0cd11"]);
  expect(store.getProfile("k1d0cd11")).not.toBeNull();
});

test("user/delete drops the SQLite row even when the user-data path is refused", async () => {
  const { store } = setup();
  // Bypass today's write validator to model a crafted row from an older store.
  (store as any)["db"].query(`UPDATE profiles SET id = ? WHERE id = ?`).run("../evil", "k1d0cd11");
  let askedToRemove = "";
  const launcher = {
    userDataDir: (id: string) => `/tmp/cloak-adspower-users-test/${id}`,
    stop: async () => true,
    // Real Launcher.removeUserDataDir refuses out-of-root paths (returns false);
    // model that and assert the row is still cleaned up (path-safe SQL delete).
    removeUserDataDir: (id: string) => {
      askedToRemove = id;
      return false;
    },
  } as unknown as Launcher;
  const body = await (await handleUserApi(post("/api/v1/user/delete", { user_ids: ["../evil"] }), launcher, store))!.json();
  expect(body.code).toBe(0);
  expect(askedToRemove).toBe("../evil"); // delegated to the contained remover, not raw rmSync
  expect(store.getProfile("../evil")).toBeNull();
});

test("unowned routes return null so web.ts falls through to browser control", async () => {
  const { store, launcher } = setup();
  expect(await handleUserApi(get("/api/v1/browser/start?user_id=x"), launcher, store)).toBeNull();
  expect(await handleUserApi(get("/api/v1/status"), launcher, store)).toBeNull();
});

// --- remote (HUB_URL) mode: management routes through the hub coordinator ---
function fakeRemote() {
  const roster = [
    {
      id: "rp1", name: "alice", group: "teamA", proxy: null, timezone: "", cookieCount: 0,
      seeded: false, screen: "1920x1080", lockedBy: null, hasSession: false,
      username: "old_handle", password: "old-password", email: "old@example.com",
      emailPassword: "old-mail-password", twofa: "OLDSEED",
    },
    { id: "rp2", name: "bob", group: "", proxy: null, timezone: "", cookieCount: 0, seeded: false, screen: "1920x1080", lockedBy: null, hasSession: false },
  ];
  const calls = {
    created: [] as any[],
    deleted: [] as string[][],
    renamed: [] as Array<[string, string]>,
    saved: [] as any[],
  };
  const remote = {
    calls,
    listProfiles: async () => roster,
    createProfile: async (input: any) => { calls.created.push(input); return { id: "newremote1" }; },
    renameProfile: async (id: string, name: string) => {
      calls.renamed.push([id, name]);
      const profile = roster.find((p) => p.id === id);
      if (!profile) throw new Error(`no such profile: ${id}`);
      profile.name = name;
    },
    getProfile: async (id: string) => {
      const profile = roster.find((p) => p.id === id);
      if (!profile) throw new Error(`no such profile: ${id}`);
      return { ...profile };
    },
    saveProfile: async (profile: any) => {
      calls.saved.push(profile);
      const current = roster.find((p) => p.id === profile.id);
      if (!current) throw new Error(`no such profile: ${profile.id}`);
      Object.assign(current, profile);
    },
    deleteProfiles: async (ids: string[]) => { calls.deleted.push(ids); return { deleted: ids.length, locked: [] as string[] }; },
    move: async () => 0,
  } as any;
  return { remote, roster, calls };
}

test("remote mode: group/list + user/list come from the hub roster", async () => {
  const { store, launcher } = setup();
  const { remote } = fakeRemote();
  const gl = await (await handleUserApi(get("/api/v1/group/list"), launcher, store, remote))!.json();
  expect(gl.data.list).toEqual([{ group_id: "teamA", group_name: "teamA" }]); // only non-empty labels
  const ul = await (await handleUserApi(get("/api/v1/user/list"), launcher, store, remote))!.json();
  expect(ul.data.list.map((r: any) => r.user_id)).toEqual(["rp1", "rp2"]);
  const inA = await (await handleUserApi(get("/api/v1/user/list?group_id=teamA"), launcher, store, remote))!.json();
  expect(inA.data.list.map((r: any) => r.user_id)).toEqual(["rp1"]);
});

test("remote mode: create + delete route through the hub coordinator", async () => {
  const { store, launcher } = setup();
  const { remote, calls } = fakeRemote();
  const cr = await (await handleUserApi(
    post("/api/v1/user/create", {
      name: "carol", group_id: "teamA", domain_name: "x.com",
      username: "carol-user", password: "x-password",
      email: "carol@example.com", email_password: "mail-password", fakey: "TOTPSEED",
      user_proxy_config: { proxy_host: "1.1.1.1", proxy_port: "9000", proxy_user: "u", proxy_password: "p" },
    }),
    launcher, store, remote,
  ))!.json();
  expect(cr.code).toBe(0);
  expect(cr.data.id).toBe("newremote1");            // id from the hub, not the local store
  expect(calls.created[0].group).toBe("teamA");
  expect(calls.created[0].proxy.host).toBe("1.1.1.1");
  expect(calls.created[0]).toMatchObject({
    platform: "x.com", username: "carol-user", password: "x-password",
    email: "carol@example.com", emailPassword: "mail-password", twofa: "TOTPSEED",
  });
  expect(store.getProfile("newremote1")).toBeNull(); // NOT written to the local cache

  const dl = await (await handleUserApi(post("/api/v1/user/delete", { user_ids: ["rp1", "rp2"] }), launcher, store, remote))!.json();
  expect(dl.data.deleted).toBe(2);
  expect(calls.deleted[0]).toEqual(["rp1", "rp2"]);
});

test("remote mode: group/create is a no-op pass and update saves the full profile", async () => {
  const { store, launcher } = setup();
  const { remote, roster, calls } = fakeRemote();
  const gc = await (await handleUserApi(post("/api/v1/group/create", { group_name: "teamB" }), launcher, store, remote))!.json();
  expect(gc.data.group_id).toBe("teamB");
  const up = await (await handleUserApi(post("/api/v1/user/update", {
    user_id: "rp1",
    name: "x",
    username: "new_handle",
    password: "new-password",
    email: "new@example.com",
    email_password: "new-mail-password",
    fakey: "NEWSEED",
  }), launcher, store, remote))!.json();
  expect(up.code).toBe(0);
  expect(calls.saved).toHaveLength(1);
  expect(calls.saved[0]).toMatchObject({
    id: "rp1",
    name: "x",
    username: "new_handle",
    password: "new-password",
    email: "new@example.com",
    emailPassword: "new-mail-password",
    twofa: "NEWSEED",
  });
  expect(roster[0]).toMatchObject(calls.saved[0]);
});

test("remote mode: name-only update keeps the lock-safe rename path", async () => {
  const { store, launcher } = setup();
  const { remote, roster, calls } = fakeRemote();

  const body = await (await handleUserApi(
    post("/api/v1/user/update", { user_id: "rp1", name: "renamed" }),
    launcher,
    store,
    remote,
  ))!.json();

  expect(body.code).toBe(0);
  expect(calls.renamed).toEqual([["rp1", "renamed"]]);
  expect(calls.saved).toEqual([]);
  expect(roster[0]!.name).toBe("renamed");
});

test("remote mode: update reports missing profiles and rejects invalid names locally", async () => {
  const { store, launcher } = setup();
  const { remote, calls } = fakeRemote();

  const missing = await (await handleUserApi(
    post("/api/v1/user/update", { user_id: "missing", name: "x" }), launcher, store, remote,
  ))!.json();
  expect(missing.code).toBe(-1);
  expect(missing.msg).toContain("no such profile: missing");

  const invalid = await (await handleUserApi(
    post("/api/v1/user/update", { user_id: "rp1", name: "   " }), launcher, store, remote,
  ))!.json();
  expect(invalid.code).toBe(-1);
  expect(invalid.msg).toBe("name must be a non-empty string");
  expect(calls.renamed).toEqual([["missing", "x"]]);
  expect(calls.saved).toEqual([]);
});
