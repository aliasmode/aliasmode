import { expect, test } from "bun:test";
import { canonicalIp, sameIp } from "./ip.ts";

test("canonicalIp normalizes equivalent IPv6 spellings", () => {
  expect(canonicalIp("2001:0DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
  expect(canonicalIp("[2001:db8::1]")).toBe("2001:db8::1");
  expect(sameIp("2001:0db8:0:0::1", "2001:db8::1")).toBe(true);
});

test("canonicalIp folds IPv4-mapped IPv6 to IPv4", () => {
  expect(canonicalIp("::ffff:192.0.2.128")).toBe("192.0.2.128");
  expect(sameIp("0:0:0:0:0:ffff:c000:0280", "192.0.2.128")).toBe(true);
});

test("canonicalIp rejects non-address input", () => {
  expect(canonicalIp("proxy.example")).toBeNull();
  expect(sameIp("not-an-ip", "not-an-ip")).toBe(false);
});
