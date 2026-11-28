import { expect, test } from "bun:test";
import {
  isHttpProxyType,
  isSocksProxyType,
  normalizeProxySpec,
  normalizeProxyType,
  parseProxySpec,
  proxyHostPort,
  proxyLegacyString,
  proxyUrl,
} from "./proxy.ts";

test("normalizes supported proxy types and rejects unknown protocols", () => {
  expect(normalizeProxyType(" SOCKS5 ")).toBe("socks5");
  expect(normalizeProxyType("socks")).toBe("socks5");
  expect(normalizeProxyType("")).toBe("http");
  expect(() => normalizeProxyType("ftp")).toThrow("unsupported proxy type");
  expect(isSocksProxyType("socks5")).toBe(true);
  expect(isHttpProxyType("http")).toBe(true);
});

test("parses legacy proxy fields without truncating colon passwords", () => {
  expect(parseProxySpec("SOCKS5", "proxy.example:1080:user:pa:ss")).toEqual({
    type: "socks5",
    host: "proxy.example",
    port: "1080",
    user: "user",
    pass: "pa:ss",
  });
});

test("an explicit proxy URL overrides the default type and decodes credentials", () => {
  expect(parseProxySpec("http", "socks5://user:p%40ss@proxy.example:1080")).toEqual({
    type: "socks5",
    host: "proxy.example",
    port: "1080",
    user: "user",
    pass: "p@ss",
  });
});

test("supports bracketed IPv6 and renders safe CloakBrowser URLs", () => {
  const parsed = parseProxySpec("socks5", "[2001:db8::1]:1080:user:p@ss")!;
  expect(parsed.host).toBe("2001:db8::1");
  expect(proxyHostPort(parsed)).toBe("[2001:db8::1]:1080");
  expect(proxyLegacyString(parsed)).toBe("[2001:db8::1]:1080:user:p@ss");
  expect(parseProxySpec(parsed.type, proxyLegacyString(parsed))).toEqual(parsed);
  expect(proxyUrl(parsed)).toBe("socks5://user:p%40ss@[2001:db8::1]:1080");
});

test("parses unbracketed IPv6 hosts from seller strings", () => {
  expect(parseProxySpec("http", "2a01:4f8::2:1080:5555:9999")).toMatchObject({ host: "2a01:4f8::2", port: "1080", user: "5555", pass: "9999" });
  expect(parseProxySpec("http", "2001:db8::1:2:1080")).toMatchObject({ host: "2001:db8::1:2", port: "1080", user: "", pass: "" });
  expect(parseProxySpec("http", "1.2.3.4:1080:user:pa:ss")).toMatchObject({ host: "1.2.3.4", port: "1080", user: "user", pass: "pa:ss" });
});

test("common proxy pastes parse, and strict forms keep their meaning", () => {
  const full = { type: "http" as const, host: "1.2.3.4", port: "8080", user: "user", pass: "pass" };
  for (const pasted of [
    "1.2.3.4 8080 user pass",
    "1.2.3.4\t8080\tuser\tpass",
    "1.2.3.4:8080 user:pass",
    "1.2.3.4:8080 user pass",
    "user:pass@1.2.3.4:8080",
    "http 1.2.3.4:8080:user:pass",
    "\u200b1.2.3.4:8080:user:pass\ufeff",
    "1.2.3.4\u00a08080\u00a0user\u00a0pass",
  ]) {
    expect(parseProxySpec("http", pasted)).toEqual(full);
  }
  expect(parseProxySpec("http", "socks5 proxy.example:1080")).toMatchObject({ type: "socks5", host: "proxy.example", port: "1080" });
  expect(parseProxySpec("http", "SOCKS user:p@ss@proxy.example:1080")).toMatchObject({ type: "socks5", user: "user", pass: "p@ss" });
  // Valid strict forms never change: spaces and @ stay inside the password.
  expect(parseProxySpec("http", "1.2.3.4:8080:user:pa ss")).toMatchObject({ user: "user", pass: "pa ss" });
  expect(parseProxySpec("http", "1.2.3.4:8080:user:p@ss")).toMatchObject({ user: "user", pass: "p@ss" });
  expect(() => parseProxySpec("http", "geo .proxy.example:8080")).toThrow('proxy host "geo .proxy.example" contains whitespace');
});

test("object normalization validates incomplete and invalid proxies", () => {
  expect(normalizeProxySpec({ host: "", port: "" })).toBeNull();
  expect(() => normalizeProxySpec({ host: "proxy.example", port: "" })).toThrow("invalid proxy port");
  expect(() => normalizeProxySpec({ host: "proxy.example", port: "70000" })).toThrow("invalid proxy port");
  expect(() => parseProxySpec("http", "proxy.example:not-a-port:u:p")).toThrow("invalid proxy port");
  for (const host of [
    "good.example@evil.example",
    "good.example/path",
    "good.example\\evil",
    "good.example?target=evil",
    "[proxy.example]",
    "2001:db8::not-ip",
  ]) {
    expect(() => normalizeProxySpec({ host, port: "8080" })).toThrow();
  }
  expect(() => normalizeProxySpec({ host: "proxy.example", port: "8080", pass: "secret" }))
    .toThrow("password requires a non-empty username");
});
