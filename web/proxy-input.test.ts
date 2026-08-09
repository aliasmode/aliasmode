import { expect, test } from "bun:test";
import { parsePastedProxy } from "./proxy-input.ts";

test("proxy paste splits host:port:username:password and preserves password colons", () => {
  expect(parsePastedProxy("1.2.3.4:1080:user:pa:ss", "socks5")).toEqual({
    type: "socks5",
    host: "1.2.3.4",
    port: "1080",
    user: "user",
    pass: "pa:ss",
  });
});

test("an explicit proxy URL selects its type and decodes credentials", () => {
  expect(parsePastedProxy("socks5://user:p%40ss@proxy.example:1080", "http")).toEqual({
    type: "socks5",
    host: "proxy.example",
    port: "1080",
    user: "user",
    pass: "p@ss",
  });
});

test("proxy paste supports bracketed IPv6 and rejects malformed input", () => {
  expect(parsePastedProxy("[2001:db8::1]:1080:user:pass", "socks5")).toMatchObject({
    host: "2001:db8::1",
    port: "1080",
  });
  expect(() => parsePastedProxy("not-a-proxy", "http")).toThrow("host:port");
  expect(() => parsePastedProxy("proxy.example:not-a-port:user:pass", "http")).toThrow("invalid proxy port");
  expect(() => parsePastedProxy("https://u:p@proxy.example:8443", "http")).toThrow("unsupported proxy type");
});
