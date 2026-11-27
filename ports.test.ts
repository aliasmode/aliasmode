import { test, expect } from "bun:test";
import { allocatePort, closedLoopbackPorts, probePortFree } from "./ports.ts";

function canBindLoopback(): boolean {
  try {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

test("allocatePort returns the first free port", () => {
  const port = allocatePort({ start: 40000, end: 40010, probe: (p) => p === 40003 });
  expect(port).toBe(40003);
});

test("allocatePort skips in-use ports", () => {
  const inUse = new Set([40000, 40001]);
  const port = allocatePort({ start: 40000, end: 40010, inUse, probe: () => true });
  expect(port).toBe(40002);
});

test("allocatePort throws when range is exhausted", () => {
  expect(() => allocatePort({ start: 40000, end: 40002, probe: () => false })).toThrow(/No free debug port/);
});

const bindTest = canBindLoopback() ? test : test.skip;

bindTest("probePortFree reports a bound port as not free", () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {}, error() {} },
  });
  const used = server.port;
  try {
    expect(probePortFree(used)).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("closedLoopbackPorts lists the Local API, the debug range, this launch's relay and autofill ports, and remote desktops", () => {
  expect(closedLoopbackPorts({ apiPort: 50400, debugPorts: { start: 9333, end: 9999 }, relayPort: 61234, autofillPort: 61235 }))
    .toBe("50400,9333-9999,61234,61235,3389,5900-5903,5938-5939,7070");
  expect(closedLoopbackPorts({ apiPort: 50400, debugPorts: { start: 9333, end: 9999 }, autofillPort: 0 }))
    .toBe("50400,9333-9999,3389,5900-5903,5938-5939,7070");
  expect(closedLoopbackPorts({ apiPort: 50400, relayPort: 61234 })).toBe("50400,61234,3389,5900-5903,5938-5939,7070");
});
