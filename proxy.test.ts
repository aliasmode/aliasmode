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
