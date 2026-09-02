import { expect, test } from "bun:test";
import { handleCloudBrowserControl } from "./server.ts";

const req = (path: string) => new Request(`http://127.0.0.1:50400${path}`);
const emptyStore = () => ({ getLaunch: () => null }) as any;

test("Cloud AdsPower start routes through Cloud lifecycle and forwards launch_args", async () => {
  const calls: Array<{ id: string; args: string[] }> = [];
  const cloudBrowser: any = {
    open: async (id: string, args: string[]) => {
      calls.push({ id, args });
      return { ok: true, ws: "ws://x/cloud", port: 9333, warning: "read-only session" };
    },
  };
  const launcher: any = { certifiedActive: async () => false };

  const response = await handleCloudBrowserControl(
    req("/api/v1/browser/start?user_id=k1&launch_args=%5B%22--flag%22%5D"),
    cloudBrowser,
    launcher,
    emptyStore(),
  );
  const body = await response.json();

  expect(calls).toEqual([{ id: "k1", args: ["--flag"] }]);
  expect(body).toMatchObject({
    code: 0,
    data: {
      ws: { puppeteer: "ws://x/cloud", selenium: "" },
      debug_port: "9333",
      webdriver: "",
      warning: "read-only session",
    },
  });
});

test("Cloud AdsPower start failures always use a clean AdsPower envelope", async () => {
  const launcher: any = { certifiedActive: async () => false };
  const failed = await handleCloudBrowserControl(
    req("/api/v1/browser/start?user_id=k1"),
    { open: async () => ({ ok: false, error: "Cloud authentication expired" }) } as any,
    launcher,
    emptyStore(),
  );
  expect(await failed.json()).toMatchObject({ code: -1, msg: "Cloud authentication expired", data: {} });

  const malformed = await handleCloudBrowserControl(
    req("/api/v1/browser/start?user_id=k1"),
    { open: async () => ({ ok: true }) } as any,
    launcher,
    emptyStore(),
  );
  expect(await malformed.json()).toMatchObject({ code: -1, data: {} });

  const thrown = await handleCloudBrowserControl(
    req("/api/v1/browser/start?user_id=k1"),
    { open: async () => { throw new Error("Cloud unavailable"); } } as any,
    launcher,
    emptyStore(),
  );
  expect(await thrown.json()).toMatchObject({ code: -1, msg: "Cloud unavailable", data: {} });
});

test("Cloud AdsPower stop succeeds only after confirmed browser teardown", async () => {
  const calls: string[] = [];
  const launcher: any = { certifiedActive: async () => false };
  const closed = await handleCloudBrowserControl(
    req("/api/v1/browser/stop?user_id=k1"),
    { close: async (id: string) => { calls.push(id); return { closed: true, sync: "pending" }; } } as any,
    launcher,
    emptyStore(),
  );
  expect((await closed.json()).code).toBe(0);
  expect(calls).toEqual(["k1"]);

  const uncertain = await handleCloudBrowserControl(
    req("/api/v1/browser/stop?user_id=k1"),
    { close: async () => ({ closed: false, reason: "teardown_unconfirmed" }) } as any,
    launcher,
    emptyStore(),
  );
  expect(await uncertain.json()).toMatchObject({ code: -1, msg: "browser teardown unconfirmed: k1" });
});

test("Cloud AdsPower active reports only certified durable launches", async () => {
  const cloudBrowser = {} as any;
  const active = await handleCloudBrowserControl(
    req("/api/v1/browser/active?user_id=k1"),
    cloudBrowser,
    { certifiedActive: async () => true } as any,
    { getLaunch: () => ({ ws: "ws://x/live" }) } as any,
  );
  expect((await active.json()).data).toEqual({
    status: "Active",
    lifecycle: "running",
    ws: { puppeteer: "ws://x/live", selenium: "" },
  });

  const inactive = await handleCloudBrowserControl(
    req("/api/v1/browser/active?user_id=k1"),
    cloudBrowser,
    { certifiedActive: async () => true } as any,
    emptyStore(),
  );
  expect((await inactive.json()).data).toEqual({ status: "Inactive" });
});
