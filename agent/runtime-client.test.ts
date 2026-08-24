import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  AgentRuntimeClient,
  RUNTIME_PROTOCOL,
  defaultRuntimeDescriptorPath,
  validateRuntimeDescriptor,
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

test("runtime descriptor path uses the Tauri application data directory", () => {
  expect(defaultRuntimeDescriptorPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" } as any))
    .toBe("C:\\Users\\me\\AppData\\Roaming/com.aliasmode.desktop/agent-runtime.json");
  expect(defaultRuntimeDescriptorPath({
    ALIASMODE_RUNTIME_DESCRIPTOR: "C:\\fixture\\runtime.json",
  } as any)).toBe("C:\\fixture\\runtime.json");
});
