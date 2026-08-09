import { test, expect } from "bun:test";
import { generateTotp, base32Decode } from "./totp.ts";

// RFC 6238 Appendix B (SHA1) — secret is base32("12345678901234567890").
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("RFC 6238 SHA1 vectors (6-digit)", () => {
  expect(generateTotp(SECRET, 59_000)?.code).toBe("287082");
  expect(generateTotp(SECRET, 1111111109_000)?.code).toBe("081804");
  expect(generateTotp(SECRET, 1234567890_000)?.code).toBe("005924");
  expect(generateTotp(SECRET, 2000000000_000)?.code).toBe("279037");
});

test("secondsRemaining counts down within the 30s window", () => {
  expect(generateTotp(SECRET, 0)?.secondsRemaining).toBe(30);
  expect(generateTotp(SECRET, 10_000)?.secondsRemaining).toBe(20);
  expect(generateTotp(SECRET, 29_000)?.secondsRemaining).toBe(1);
});

test("blank / undecodable secret → null", () => {
  expect(generateTotp("")).toBeNull();
  expect(generateTotp("   ")).toBeNull();
});

test("base32 decode is padding/case/space tolerant", () => {
  expect([...base32Decode("jbsw y3dp")]).toEqual([...base32Decode("JBSWY3DP")]);
});
