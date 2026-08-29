import { test, expect } from "bun:test";
import { buildNewProfile, generateId } from "./create.ts";
import { deterministicSeed } from "./fingerprint.ts";

test("buildNewProfile makes a unique id with a seed-derived fingerprint and no forced UA", () => {
  const p = buildNewProfile({ name: "sophia", group: "va1" }, () => false);
  expect(p.id).toMatch(/^[a-z0-9]{8}$/);
  expect(p.name).toBe("sophia");
  expect(p.group).toBe("va1");
  expect(p.fingerprintSeed).toBe(deterministicSeed(p.id)); // unique fingerprint from the id
  expect(p.ua).toBe(""); // UA comes from the seed at launch, never forced
  expect(p.cookies).toEqual([]);
  expect(p.seeded).toBe(false);
  expect(p.screenWidth).toBeGreaterThan(0);
});

test("buildNewProfile stores account credentials for the Edit view", () => {
  const p = buildNewProfile({
    platform: "x.com",
    username: " alice ",
    password: "x-password",
    email: " alice@example.com ",
    emailPassword: "mail-password",
    twofa: " M4YHM7YCL73FLIEV ",
  }, () => false);

  expect(p.platform).toBe("x.com");
  expect(p.username).toBe("alice");
  expect(p.password).toBe("x-password");
  expect(p.email).toBe("alice@example.com");
  expect(p.emailPassword).toBe("mail-password");
  expect(p.twofa).toBe("M4YHM7YCL73FLIEV");
});

test("buildNewProfile parses an http/socks5 proxy and defaults type to http", () => {
  const a = buildNewProfile({ proxy: { type: "socks5", host: "1.2.3.4", port: "1080", user: "u", pass: "p:x" } }, () => false);
  expect(a.proxy).toEqual({ type: "socks5", host: "1.2.3.4", port: "1080", user: "u", pass: "p:x" });

  const b = buildNewProfile({ proxy: { host: "5.6.7.8", port: "8080" } }, () => false);
  expect(b.proxy!.type).toBe("http");

  const uppercase = buildNewProfile({ proxy: { type: "SOCKS5", host: "proxy.example", port: "1080" } }, () => false);
  expect(uppercase.proxy!.type).toBe("socks5");

  const none = buildNewProfile({ proxy: { host: "", port: "" } }, () => false);
  expect(none.proxy).toBeNull();
});

test("buildNewProfile honors an explicit screen, else picks a realistic one", () => {
  const explicit = buildNewProfile({ screen: "1366x768" }, () => false);
  expect([explicit.screenWidth, explicit.screenHeight]).toEqual([1366, 768]);

  const auto = buildNewProfile({}, () => false);
  expect(auto.screenWidth).toBeGreaterThanOrEqual(1000);
  expect(auto.screenHeight).toBeGreaterThanOrEqual(700);
});

test("buildNewProfile rejects a malformed or impossible explicit screen", () => {
  for (const screen of ["nope", "0x0", "319x1080", "1920x199", "99999x1080"]) {
    expect(() => buildNewProfile({ screen }, () => false)).toThrow("invalid resolution");
  }
});

test("buildNewProfile rejects an invalid port or unsupported proxy type", () => {
  expect(() => buildNewProfile({ proxy: { host: "1.2.3.4", port: "abc" } }, () => false)).toThrow(/invalid proxy port/);
  expect(() => buildNewProfile({ proxy: { host: "1.2.3.4", port: "99999" } }, () => false)).toThrow(/invalid proxy port/);
  expect(() => buildNewProfile({ proxy: { type: "ftp", host: "1.2.3.4", port: "8080" } }, () => false)).toThrow(/unsupported proxy type/);
});

test("buildNewProfile accepts an uppercase X in the screen", () => {
  const p = buildNewProfile({ screen: "1920X1080" }, () => false);
  expect([p.screenWidth, p.screenHeight]).toEqual([1920, 1080]);
});

test("blank name falls back to the generated id", () => {
  const p = buildNewProfile({ name: "  " }, () => false);
  expect(p.name).toBe(p.id);
});

test("generateId retries past collisions and never returns an existing id", () => {
  const taken = new Set<string>();
  let calls = 0;
  const exists = (id: string) => {
    calls++;
    if (calls <= 3) { taken.add(id); return true; } // first 3 collide
    return taken.has(id);
  };
  const id = generateId(exists);
  expect(taken.has(id)).toBe(false);
});

test("a new profile records the host platform explicitly", () => {
  // A blank UA used to mean no --fingerprint-platform flag at all, which let
  // the browser inherit whatever host it ran on. Pin it at creation instead.
  const p = buildNewProfile({ name: "n", group: "g" }, () => false);
  expect(["windows", "macos", "linux"]).toContain(p.platformOs!);
});
