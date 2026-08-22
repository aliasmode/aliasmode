import { expect, test } from "bun:test";
import {
  DESKTOP_PROTOCOL,
  DesktopCredentialBridge,
  ManagedDesktopRuntime,
  desktopHealthMetadata,
  desktopReadyRecord,
  isDesktopShutdownCommand,
} from "./desktop-runtime.ts";

const NONCE = "ab".repeat(32);

function admission(inFlight = 0, queued = 0): any {
  return { stats: () => ({ inFlight, queued }) };
}

test("desktop health metadata requires a nonce, version, and root", () => {
  expect(desktopHealthMetadata({}, undefined)).toBeNull();
  expect(desktopHealthMetadata({
    ALIASMODE_DESKTOP_NONCE: NONCE,
    ALIASMODE_DESKTOP_VERSION: "0.1.0-beta.1",
  }, "C:\\Users\\me\\AppData\\Roaming\\com.aliasmode.desktop")).toEqual({
    instance: NONCE,
    version: "0.1.0-beta.1",
    root: "C:\\Users\\me\\AppData\\Roaming\\com.aliasmode.desktop",
  });
  expect(() => desktopHealthMetadata({
    ALIASMODE_DESKTOP_NONCE: "not-a-nonce",
    ALIASMODE_DESKTOP_VERSION: "0.1.0-beta.1",
  }, "root")).toThrow("64 lowercase hexadecimal");
});

test("desktop readiness is emitted only for a valid owned port and pid", () => {
  expect(desktopReadyRecord(NONCE, 49_152, 42)).toEqual({
    protocol: DESKTOP_PROTOCOL,
    event: "ready",
    nonce: NONCE,
    pid: 42,
    port: 49_152,
  });
  expect(() => desktopReadyRecord(NONCE, 0, 42)).toThrow("port is invalid");
  expect(() => desktopReadyRecord(NONCE, 49_152, 0)).toThrow("pid is invalid");
});

test("desktop control accepts only the fixed nonce-bound shutdown command", () => {
  const valid = JSON.stringify({ protocol: DESKTOP_PROTOCOL, command: "shutdown", nonce: NONCE });
  expect(isDesktopShutdownCommand(valid, NONCE)).toBe(true);
  expect(isDesktopShutdownCommand(JSON.stringify({ protocol: DESKTOP_PROTOCOL, command: "shutdown", nonce: "cd".repeat(32) }), NONCE)).toBe(false);
  expect(isDesktopShutdownCommand(JSON.stringify({ protocol: DESKTOP_PROTOCOL, command: "run", nonce: NONCE }), NONCE)).toBe(false);
  expect(isDesktopShutdownCommand("not json", NONCE)).toBe(false);
});

test("desktop credential bridge waits for a nonce-bound parent acknowledgement", async () => {
  const output: string[] = [];
  const bridge = new DesktopCredentialBridge(NONCE, (line) => { output.push(line); });
  const stored = bridge.persistRefreshToken("rotated-refresh");
  const request = JSON.parse(output[0]!) as { request: number };
  expect(bridge.handleLine(JSON.stringify({
    protocol: DESKTOP_PROTOCOL,
    event: "credential-result",
    nonce: "cd".repeat(32),
    request: request.request,
    ok: true,
  }))).toBe(false);
  expect(bridge.handleLine(JSON.stringify({
    protocol: DESKTOP_PROTOCOL,
    event: "credential-result",
    nonce: NONCE,
    request: request.request,
    ok: true,
  }))).toBe(true);
  await stored;
});

test("desktop credential bridge surfaces Credential Manager rejection", async () => {
  const output: string[] = [];
  const bridge = new DesktopCredentialBridge(NONCE, (line) => { output.push(line); });
  const stored = bridge.persistRefreshToken("rotated-refresh");
  const request = JSON.parse(output[0]!) as { request: number };
  bridge.handleLine(JSON.stringify({
    protocol: DESKTOP_PROTOCOL,
    event: "credential-result",
    nonce: NONCE,
    request: request.request,
    ok: false,
  }));
  await expect(stored).rejects.toThrow("Credential Manager rejected");
});

test("desktop credential bridge clears refresh and device credentials", async () => {
  const output: string[] = [];
  const bridge = new DesktopCredentialBridge(NONCE, (line) => { output.push(line); });
  const cleared = bridge.clearCloudSessionCredentials();
  const refresh = JSON.parse(output[0]!) as { request: number; event: string; key: string };
  expect(refresh).toMatchObject({ event: "credential-delete", key: "refresh_token" });
  bridge.handleLine(JSON.stringify({
    protocol: DESKTOP_PROTOCOL,
    event: "credential-result",
    nonce: NONCE,
    request: refresh.request,
    ok: true,
  }));
  await Promise.resolve();
  const device = JSON.parse(output[1]!) as { request: number; event: string; key: string };
  expect(device).toMatchObject({ event: "credential-delete", key: "device_credential" });
  bridge.handleLine(JSON.stringify({
    protocol: DESKTOP_PROTOCOL,
    event: "credential-result",
    nonce: NONCE,
    request: device.request,
    ok: true,
  }));
  await cleared;
  expect(output.map((line) => JSON.parse(line).key)).toEqual(["refresh_token", "device_credential"]);
  expect(output.join("\n")).not.toContain("queue_encryption_key");
});

test("desktop shutdown coalesces and closes authoritative local launches", async () => {
  const events: string[] = [];
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => { events.push("server"); } },
    admission: admission(),
    store: {
      listLaunches: () => [{ profileId: "one" }, { profileId: "two" }],
      close: () => { events.push("store"); },
    },
    launcher: { stop: async (id) => { events.push(`stop:${id}`); return true; } },
    stopInbox: () => { events.push("inbox"); },
  });

  const first = runtime.shutdown();
  const second = runtime.shutdown();
  expect(first).toBe(second);
  await first;
  expect(events).toEqual(["server", "inbox", "stop:one", "stop:two", "store"]);
});

test("desktop shutdown delegates remote capture and release to the coordinator drain", async () => {
  const events: string[] = [];
  let remainingMs = 0;
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => { events.push("server"); } },
    admission: admission(),
    store: { listLaunches: () => [], close: () => { events.push("store"); } },
    launcher: { stop: async () => { throw new Error("local stop must not run"); } },
    remoteShutdown: async (remaining) => { remainingMs = remaining; events.push("releaseAll"); },
  });
  await runtime.shutdown();
  expect(events).toEqual(["server", "releaseAll", "store"]);
  expect(remainingMs).toBeGreaterThan(0);
});

test("desktop shutdown attempts every local browser after one stop throws", async () => {
  const attempted: string[] = [];
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => {} },
    admission: admission(),
    store: {
      listLaunches: () => [{ profileId: "one" }, { profileId: "two" }],
      close: () => {},
    },
    launcher: {
      stop: async (id) => {
        attempted.push(id);
        if (id === "one") throw new Error("stop failed");
        return true;
      },
    },
  });
  await expect(runtime.shutdown()).rejects.toThrow("browser teardown was not confirmed");
  expect(attempted).toEqual(["one", "two"]);
});

test("desktop shutdown fails closed when browser teardown is unconfirmed", async () => {
  let storeClosed = false;
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => {} },
    admission: admission(),
    store: { listLaunches: () => [{ profileId: "one" }], close: () => { storeClosed = true; } },
    launcher: { stop: async () => false },
  });
  await expect(runtime.shutdown()).rejects.toThrow("browser teardown was not confirmed");
  expect(storeClosed).toBe(true);
});
