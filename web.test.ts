import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import { ProfileStore } from "./store.ts";
import {
  serveAutomationApi,
  serveDashboard,
  serveDesktopAutomationApi,
} from "./web.ts";

const webSource = readFileSync(join(import.meta.dir, "web.ts"), "utf8");

test("profile identity cards do not fetch egress IP automatically", () => {
  expect(webSource).not.toContain("ip-api.com/json");
  expect(webSource).not.toContain("checking egress IP");
  expect(webSource).toContain("AliasMode Firefox");
  expect(webSource).toContain("no CDP, PDF, or Chrome extensions");
});

test("dashboard health route blocks browser cross-origin submissions on loopback", async () => {
  let publishes = 0;
  const server = serveDashboard({
    port: 0,
    launcher: {} as any,
    store: {} as any,
    remote: {
      publishAutomationHealthSnapshot: async () => {
        publishes++;
        return { profiles: 1, alive: 0, suspended: 1 };
      },
    } as any,
    log: () => {},
  });

  try {
    const endpoint = `http://127.0.0.1:${server.port}/api/xactions/health-snapshot`;
    const body = JSON.stringify({ profiles: [{ profileId: "p1", suspended: true }] });

    const automation = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(automation.status).toBe(200);
    expect(publishes).toBe(1);

    const browser = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body,
    });
    expect(browser.status).toBe(403);

    const simplePost = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://attacker.example" },
      body,
    });
    expect(simplePost.status).toBe(415);
    expect(publishes).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test("Cloud file updates disable the idle timeout while saving the batch", async () => {
  const store = new ProfileStore(":memory:");
  const server = serveDashboard({
    port: 0, launcher: {} as any, store,
    appConfig: { read: () => ({ mode: "cloud" }) } as any,
    cloudBrowser: {} as any,
    cloudConnection: { client: {} } as any,
    log: () => {},
  });
  const timeout = spyOn(server, "timeout");
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/ui/api/profiles/update-file`, {
      method: "POST", body: new FormData(),
    });
    expect(await response.json()).toMatchObject({ ok: true, updated: 0 });
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout.mock.calls[0]![1]).toBe(0);
  } finally {
    timeout.mockRestore();
    await server.stop(true);
    store.close();
  }
});

test("automation API serves compatibility routes without desktop UI", async () => {
  const store = new ProfileStore(":memory:");
  let publishes = 0;
  const server = serveAutomationApi({
    port: 0,
    launcher: {} as any,
    store,
    remote: {
      listProfiles: async () => [],
      publishAutomationHealthSnapshot: async () => {
        publishes++;
        return { profiles: 1, alive: 1, suspended: 0 };
      },
    } as any,
    log: () => {},
  });

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const status = await fetch(`${origin}/api/v1/status`).then((response) => response.json());
    expect(status.code).toBe(0);

    const profiles = await fetch(`${origin}/api/v1/user/list?page=1&page_size=10`).then((response) => response.json());
    expect(profiles).toMatchObject({ code: 0, data: { list: [] } });

    const health = await fetch(`${origin}/api/xactions/health-snapshot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profiles: [{ profileId: "p1", suspended: false }] }),
    });
    expect(health.status).toBe(200);
    expect(publishes).toBe(1);

    for (const path of ["/", "/ui/api/health", "/card?id=p1", "/api/agent/v1/connect"]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.headers.get("content-type")).not.toContain("text/html");
      expect(await response.text()).not.toContain("<!doctype html>");
    }
  } finally {
    await server.stop(true);
    store.close();
  }
});

test("dashboard and automation API share lifecycle admission", async () => {
  const store = new ProfileStore(":memory:");
  const admission = new LifecycleAdmissionController({ limit: 1 });
  let release = () => {};
  const blocker = admission.run(
    { kind: "start", profileIds: ["held"] },
    () => new Promise<void>((resolve) => { release = resolve; }),
  );
  const dashboard = serveDashboard({
    port: 0,
    launcher: {} as any,
    store,
    lifecycleAdmission: admission,
    log: () => {},
  });
  const automation = serveAutomationApi({
    port: 0,
    launcher: {} as any,
    store,
    lifecycleAdmission: admission,
    log: () => {},
  });

  try {
    const dashboardStatus = await fetch(`http://127.0.0.1:${dashboard.port}/status`).then((response) => response.json());
    const automationStatus = await fetch(`http://127.0.0.1:${automation.port}/status`).then((response) => response.json());
    expect(dashboardStatus.data.admission.inFlight).toBe(1);
    expect(automationStatus.data.admission.inFlight).toBe(1);
  } finally {
    release();
    await blocker;
    await Promise.all([dashboard.stop(true), automation.stop(true)]);
    store.close();
  }
});

test("desktop automation API owns 127.0.0.1:50400 and desktop startup survives conflicts", async () => {
  const store = new ProfileStore(":memory:");
  const logs: string[] = [];
  const options = {
    launcher: {} as any,
    store,
    log: (message: string) => logs.push(message),
  };
  const server = serveDesktopAutomationApi(options);
  const dashboard = serveDashboard({ ...options, port: 0, log: () => {} });
  try {
    expect(dashboard.port).not.toBe(50_400);
    if (server) {
      expect(server.port).toBe(50_400);
      const response = await fetch("http://127.0.0.1:50400/status");
      expect(await response.json()).toMatchObject({ code: 0 });
      expect(serveDesktopAutomationApi(options)).toBeUndefined();
    }

    expect(logs.some((message) =>
      message.includes("automation API could not bind to http://127.0.0.1:50400")
    )).toBeTrue();
    expect(logs.filter((message) => message.includes("automation API on")).length)
      .toBe(server ? 1 : 0);

    const health = await fetch(`http://127.0.0.1:${dashboard.port}/ui/api/health`);
    expect(health.status).toBe(200);
  } finally {
    await Promise.all([server?.stop(true), dashboard.stop(true)]);
    store.close();
  }
});

test("Cloud automation API routes browser control through the Cloud lifecycle", async () => {
  const store = new ProfileStore(":memory:");
  const calls: string[] = [];
  let localStarts = 0;
  const server = serveAutomationApi({
    port: 0,
    launcher: {
      start: async () => { localStarts++; throw new Error("local start must not run"); },
      certifiedActive: async () => false,
    } as any,
    store,
    appConfig: { read: () => ({ mode: "cloud" }) } as any,
    cloudBrowser: {
      open: async (id: string, args: string[]) => {
        calls.push(`open:${id}:${JSON.stringify(args)}`);
        return { ok: true, ws: "ws://x/cloud", port: 9444 };
      },
      close: async (id: string) => {
        calls.push(`close:${id}`);
        return { closed: true, sync: "complete" };
      },
      listRoster: async () => ({
        profiles: [
          { id: "k1", name: "first", group: "Folder A" },
          { id: "k2", name: "second", group: "Folder B" },
        ],
        healthSources: [],
      }),
    } as any,
    cloudConnection: { client: { listFolders: async () => ({ folders: [
      { name: "Folder A", archivedAt: null },
      { name: "Folder B", archivedAt: null },
    ] }) } } as any,
    log: () => {},
  });

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const status = await fetch(`${origin}/api/v1/status`).then((response) => response.json());
    expect(status.code).toBe(0);

    // Folder import: resolve the group, then page its profiles from Cloud.
    const groups = await fetch(`${origin}/api/v1/group/list?group_name=Folder%20A&page_size=2000`)
      .then((response) => response.json());
    expect(groups.data.list).toEqual([
      { group_id: "Folder A", group_name: "Folder A" },
      { group_id: "Folder B", group_name: "Folder B" },
    ]);
    const members = await fetch(`${origin}/api/v1/user/list?group_id=Folder%20B&page_size=100&page=1`)
      .then((response) => response.json());
    expect(members.data.list.map((row: any) => [row.user_id, row.name])).toEqual([["k2", "second"]]);
    const byId = await fetch(`${origin}/api/v1/user/list?user_id=k1`).then((response) => response.json());
    expect(byId.data.list.map((row: any) => row.name)).toEqual(["first"]);

    const start = await fetch(`${origin}/api/v1/browser/start?user_id=k1&launch_args=%5B%22--flag%22%5D`)
      .then((response) => response.json());
    expect(start).toMatchObject({
      code: 0,
      data: { ws: { puppeteer: "ws://x/cloud" }, debug_port: "9444" },
    });

    const stop = await fetch(`${origin}/api/v1/browser/stop?user_id=k1`).then((response) => response.json());
    expect(stop.code).toBe(0);
    expect(calls).toEqual(['open:k1:["--flag"]', "close:k1"]);
    expect(localStarts).toBe(0);

    const blocked = await fetch(`${origin}/api/v1/user/update`, { method: "POST" });
    expect(blocked.status).toBe(503);
    const destructive = await fetch(`${origin}/api/v1/user/delete`, { method: "POST" });
    expect(destructive.status).toBe(503);
  } finally {
    await server.stop(true);
    store.close();
  }
});

test("Cloud automation API reports a roster failure in the AdsPower envelope", async () => {
  const store = new ProfileStore(":memory:");
  const server = serveAutomationApi({
    port: 0,
    launcher: {} as any,
    store,
    appConfig: { read: () => ({ mode: "cloud" }) } as any,
    cloudBrowser: {
      listRoster: async () => { throw new Error("Cloud authentication is required"); },
    } as any,
    log: () => {},
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/user/list?page_size=2000`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: -1, msg: "Cloud authentication is required", data: {} });
  } finally {
    await server.stop(true);
    store.close();
  }
});

test("Cloud setup lists empty folders and creates folders and profiles without local writes", async () => {
  const store = new ProfileStore(":memory:");
  const folders = [
    { name: "Empty", archivedAt: null as number | null },
    { name: "Archived", archivedAt: 1 },
  ];
  const profiles: any[] = [];
  const createdFolders: string[] = [];
  const server = serveAutomationApi({
    port: 0, launcher: {} as any, store,
    appConfig: { read: () => ({ mode: "cloud" }) } as any,
    cloudConnection: { client: {
      listFolders: async () => ({ folders }),
      createFolder: async (name: string) => {
        if (folders.some((folder) => folder.name === name)) throw new Error("Folder already exists");
        createdFolders.push(name);
        const folder = { name, archivedAt: null };
        folders.push(folder);
        return { ok: true, folder };
      },
    } } as any,
    cloudBrowser: {
      listRoster: async () => ({ profiles, healthSources: [] }),
      create: async (profile: any) => { profiles.push(profile); return { id: profile.id }; },
    } as any,
    log: () => {},
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: unknown) => fetch(`${origin}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((response) => response.json());
  const groups = (page = 1) => fetch(`${origin}/api/v1/group/list?page_size=1&page=${page}`)
    .then((response) => response.json());
  try {
    expect((await groups()).data.list).toEqual([{ group_id: "Empty", group_name: "Empty" }]);
    for (const name of ["Empty", "New", "New"]) {
      expect(await post("/api/v1/group/create", { group_name: name }))
        .toMatchObject({ code: 0, data: { group_id: name } });
    }
    expect(createdFolders).toEqual(["New"]);
    expect((await groups(2)).data.list).toEqual([{ group_id: "New", group_name: "New" }]);
    expect((await groups(3)).data.list).toEqual([]);
    expect(await post("/api/v1/group/create", { group_name: "Archived" }))
      .toMatchObject({ code: -1, msg: "Folder already exists" });

    const created = await post("/api/v1/user/create", { name: "newacct", group_id: "New" });
    expect(created.code).toBe(0);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ id: created.data.id, name: "newacct", group: "New" });
    const listed = await fetch(`${origin}/api/v1/user/list?group_id=New`).then((response) => response.json());
    expect(listed.data.list).toMatchObject([{ user_id: created.data.id, group_id: "New" }]);
    expect(store.count()).toBe(0);
    expect(store.listGroups()).toEqual([]);
  } finally {
    await server.stop(true);
    store.close();
  }
});

test("Cloud folder and profile errors never fall back to the local store", async () => {
  const store = new ProfileStore(":memory:");
  let failure = "list";
  const denied = () => { throw new Error("Cloud access denied"); };
  const server = serveAutomationApi({
    port: 0, launcher: {} as any, store,
    appConfig: { read: () => ({ mode: "cloud" }) } as any,
    cloudConnection: { client: {
      listFolders: async () => failure === "list" ? denied() : { folders: [] },
      createFolder: async () => denied(),
    } } as any,
    cloudBrowser: { create: async () => denied() } as any,
    log: () => {},
  });
  try {
    for (const [path, body] of [
      ["group/list", undefined],
      ["group/create", { group_name: "New" }],
      ["user/create", { name: "newacct", group_id: "New" }],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/${path}`, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(await response.json()).toMatchObject({ code: -1, msg: "Cloud access denied", data: {} });
      failure = "create";
    }
    expect(store.count()).toBe(0);
    expect(store.listGroups()).toEqual([]);
  } finally {
    await server.stop(true);
    store.close();
  }
});

test("Cloud automation API stays closed when the Cloud lifecycle is unavailable", async () => {
  const store = new ProfileStore(":memory:");
  const server = serveAutomationApi({
    port: 0,
    launcher: {} as any,
    store,
    appConfig: { read: () => ({ mode: "cloud" }) } as any,
    log: () => {},
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/browser/start?user_id=k1`);
    expect(response.status).toBe(503);
  } finally {
    await server.stop(true);
    store.close();
  }
});
