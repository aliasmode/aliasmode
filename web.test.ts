import { expect, test } from "bun:test";
import { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import { ProfileStore } from "./store.ts";
import {
  serveAutomationApi,
  serveDashboard,
  serveDesktopAutomationApi,
} from "./web.ts";

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

test("desktop automation API owns 127.0.0.1:50400 and fails on conflicts", async () => {
  const store = new ProfileStore(":memory:");
  const options = { launcher: {} as any, store, log: () => {} };
  const server = serveDesktopAutomationApi(options);
  const dashboard = serveDashboard({ ...options, port: 0 });
  try {
    expect(server.port).toBe(50_400);
    expect(dashboard.port).not.toBe(50_400);
    const response = await fetch("http://127.0.0.1:50400/status");
    expect(await response.json()).toMatchObject({ code: 0 });
  } finally {
    await Promise.all([server.stop(true), dashboard.stop(true)]);
  }

  const occupied = Bun.serve({
    hostname: "127.0.0.1",
    port: 50_400,
    fetch: () => new Response("occupied"),
  });
  try {
    expect(() => serveDesktopAutomationApi(options)).toThrow("127.0.0.1:50400");
  } finally {
    await occupied.stop(true);
    store.close();
  }
});
