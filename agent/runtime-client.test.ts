import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import {
  AgentRuntimeClient,
  RUNTIME_PROTOCOL,
  defaultRuntimeDescriptorPath,
  validateRuntimeDescriptor,
  windowsProcessIdentityCommand,
} from "./runtime-client.mjs";

function descriptor() {
  return {
    protocol: RUNTIME_PROTOCOL,
    appVersion: "0.1.0-beta.32",
    generation: "a".repeat(64),
    nonce: "b".repeat(64),
    port: 50400,
    desktopPid: 11,
    desktopStartedAt: "123456",
    sidecarPid: 12,
    readiness: "local",
    createdAt: 1_700_000_000,
  };
}

test("runtime descriptor validation binds protocol, version, process, and nonce", () => {
  expect(validateRuntimeDescriptor(descriptor())).toEqual(descriptor());
  expect(() => validateRuntimeDescriptor({ ...descriptor(), appVersion: "other" }))
    .toThrow("did not match");
  expect(() => validateRuntimeDescriptor({ ...descriptor(), nonce: "public" }))
    .toThrow("did not match");
  expect(() => validateRuntimeDescriptor({ ...descriptor(), readiness: "starting" }))
    .toThrow("did not match");
  expect(() => validateRuntimeDescriptor({ ...descriptor(), desktopStartedAt: "" }))
    .toThrow("did not match");
});

test("invalid agent responses terminate their WebSocket", () => {
  class FakeSocket extends EventEmitter {
    readyState = 1;
    terminated = 0;
    terminate() { this.terminated++; this.readyState = 3; }
    close() { this.readyState = 2; }
    send() {}
  }
  const socket = new FakeSocket();
  const client = new AgentRuntimeClient(socket as any);
  socket.emit("message", Buffer.from("not-json"));
  expect(socket.terminated).toBe(1);
  client.close();
  expect(socket.readyState).toBe(3);
});

test("Windows process identity does not depend on PowerShell modules or PATH", () => {
  expect(windowsProcessIdentityCommand(123, { SYSTEMROOT: "C:\\Windows" } as any)).toEqual({
    executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Diagnostics.Process]::GetProcessById(123).StartTime.ToFileTimeUtc()",
    ],
  });
});

test("runtime descriptor path uses the Tauri application data directory", () => {
  expect(defaultRuntimeDescriptorPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" } as any))
    .toBe(join("C:\\Users\\me\\AppData\\Roaming", "com.aliasmode.desktop", "agent-runtime.json"));
  expect(defaultRuntimeDescriptorPath({
    ALIASMODE_RUNTIME_DESCRIPTOR: "C:\\fixture\\runtime.json",
  } as any)).toBe("C:\\fixture\\runtime.json");
});
