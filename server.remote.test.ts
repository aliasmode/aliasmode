import { test, expect } from "bun:test";
import { handleRemoteBrowserControl } from "./server.ts";
import {
  LifecycleAdmissionController,
  dispatchWithLifecycleAdmission,
} from "./lifecycle-admission.ts";

const req = (path: string) => new Request(`http://127.0.0.1:50400${path}`);
const emptyStore = () => ({ getLaunch: () => null }) as any;

test("remote AdsPower start routes through the coordinator and returns the AdsPower shape + forwards launch_args", async () => {
  const calls: string[] = [];
  const coord: any = {
    open: async (id: string, args: string[]) => {
      calls.push(`open:${id}:${JSON.stringify(args)}`);
      return { ok: true, ws: "ws://x/1", port: 9333 };
    },
  };
  const launcher: any = { certifiedActive: async () => true };
  // launch_args = ["--flag"]  (URL-encoded)
  const res = await handleRemoteBrowserControl(
    req("/api/v1/browser/start?user_id=k1&launch_args=%5B%22--flag%22%5D"),
    coord,
    launcher,
    emptyStore(),
  );
  const body = await res.json();
  expect(body.code).toBe(0);
  expect(body.data.ws.puppeteer).toBe("ws://x/1");
  expect(body.data.debug_port).toBe("9333");
  expect(calls[0]).toBe('open:k1:["--flag"]'); // claimed the lock + forwarded automation flags
});

test("shared admission queues remote open and close before coordinator side effects", async () => {
  const calls: string[] = [];
  const coord: any = {
    open: async (id: string) => {
      calls.push(`open:${id}`);
      return { ok: true, ws: "ws://x/1", port: 9333 };
    },
    close: async (id: string) => {
      calls.push(`close:${id}`);
      return true;
    },
  };
  const launcher: any = { certifiedActive: async () => false };
  const admission = new LifecycleAdmissionController({ limit: 1 });
  let release!: () => void;
  const held = admission.run({ kind: "cleanup", profileIds: ["other"] }, () =>
    new Promise<void>((resolve) => { release = resolve; })
  );
  const startReq = req("/api/v1/browser/start?user_id=start-profile");
  const closeReq = req("/api/v1/browser/stop?user_id=stop-profile");
  const start = dispatchWithLifecycleAdmission(startReq, admission, () =>
    handleRemoteBrowserControl(startReq, coord, launcher, emptyStore(), { admission })
  );
  const close = dispatchWithLifecycleAdmission(closeReq, admission, () =>
    handleRemoteBrowserControl(closeReq, coord, launcher, emptyStore(), { admission })
  );

  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(calls).toEqual([]);
  release();
  await held;
  const responses = await Promise.all([start, close]);
  expect(calls).toEqual(["close:stop-profile", "open:start-profile"]);
  expect((await responses[0]!.json()).code).toBe(0);
  expect((await responses[1]!.json()).code).toBe(0);
});

test("start on a profile with another session writer returns a warned success", async () => {
  const coord: any = {
    open: async () => ({
      ok: true,
      ws: "ws://x/1",
      port: 9333,
      lockedBy: "ana",
      warning: "Possible concurrent use: hub reports this profile in use by ana; session sync is disabled for this browser.",
    }),
  };
  const launcher: any = { certifiedActive: async () => false };
  const body = await (await handleRemoteBrowserControl(
    req("/api/v1/browser/start?user_id=k1"),
    coord,
    launcher,
    emptyStore(),
  )).json();
  expect(body.code).toBe(0);
  expect(body.data.ws.puppeteer).toBe("ws://x/1");
  expect(body.data.warning).toContain("session sync is disabled");
});

test("stop releases via the coordinator; active reports only certified durable local identity", async () => {
  const calls: string[] = [];
  const coord: any = {
    close: async (id: string) => calls.push(`close:${id}`),
    lifecycleState: () => null,
  };
  const launcher: any = { certifiedActive: async () => true };
  const store: any = { getLaunch: () => ({ ws: "ws://x/live" }) };
  expect((await (await handleRemoteBrowserControl(
    req("/api/v1/browser/stop?user_id=k1"),
    coord,
    launcher,
    store,
  )).json()).code).toBe(0);
  expect(calls).toEqual(["close:k1"]);
  const active = await (await handleRemoteBrowserControl(
    req("/api/v1/browser/active?user_id=k1"),
    coord,
    launcher,
    store,
  )).json();
  expect(active.data).toEqual({
    status: "Active",
    lifecycle: "running",
    ws: { puppeteer: "ws://x/live", selenium: "" },
  });
});

test("remote active merges admission and coordinator transition evidence without certification", async () => {
  let certified = 0;
  const launcher: any = { certifiedActive: async () => { certified++; return false; } };
  const admission = new LifecycleAdmissionController({ limit: 1 });
  let release!: () => void;
  const held = admission.run({ kind: "start", profileIds: ["k1"] }, () =>
    new Promise<void>((resolve) => { release = resolve; })
  );
  const coord: any = { lifecycleState: () => null };

  const starting = await (await handleRemoteBrowserControl(
    req("/api/v1/browser/active?user_id=k1"),
    coord,
    launcher,
    emptyStore(),
    { admission },
  )).json();
  expect(starting.data).toEqual({ status: "Active", lifecycle: "starting" });
  expect(certified).toBe(0);
  release();
  await held;

  coord.lifecycleState = () => "stopping";
  const stopping = await (await handleRemoteBrowserControl(
    req("/api/v1/browser/active?user_id=k1"),
    coord,
    launcher,
    emptyStore(),
    { admission },
  )).json();
  expect(stopping.data).toEqual({ status: "Active", lifecycle: "stopping" });
  expect(certified).toBe(0);
});

test("remote durable but uncertified launch stays Active/uncertain without websocket", async () => {
  const coord: any = { lifecycleState: () => null };
  const launcher: any = { certifiedActive: async () => false };
  const store: any = { getLaunch: () => ({ ws: "ws://x/uncertified" }) };
  const body = await (await handleRemoteBrowserControl(
    req("/api/v1/browser/active?user_id=k1"),
    coord,
    launcher,
    store,
  )).json();
  expect(body.data).toEqual({ status: "Active", lifecycle: "uncertain" });
});

test("missing user_id is a clean AdsPower failure", async () => {
  const body = await (await handleRemoteBrowserControl(
    req("/api/v1/browser/start"),
    {} as any,
    { certifiedActive: async () => false } as any,
    emptyStore(),
  )).json();
  expect(body.code).toBe(-1);
});

test("a thrown hub error (hub down / token revoked) comes back as a clean AdsPower code:-1, not an exception", async () => {
  const coord: any = { open: async () => { throw new Error("hub unreachable"); } };
  const launcher: any = { certifiedActive: async () => false };
  const res = await handleRemoteBrowserControl(
    req("/api/v1/browser/start?user_id=k1"),
    coord,
    launcher,
    emptyStore(),
  );
  const body = await res.json();
  expect(body.code).toBe(-1);
  expect(body.msg).toContain("hub unreachable");
});
