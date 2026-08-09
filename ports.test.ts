import { test, expect } from "bun:test";
import { allocatePort, probePortFree } from "./ports.ts";

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
