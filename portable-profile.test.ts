import { expect, test } from "bun:test";
import { decodePortableProfile, encodePortableProfile } from "./portable-profile.ts";
import type { Profile } from "./types.ts";

function profile(): Profile {
  return {
    id: "profile1",
    accId: "account-record",
    name: "Profile",
    group: "Team",
    platform: "telegram.org",
    username: "user",
    password: "password",
    email: "mail@example.com",
    emailPassword: "mail-password",
    twofa: "seed",
    proxy: { type: "socks5", host: "proxy.example", port: "1080", user: "proxy-user", pass: "proxy-pass" },
    extensions: ["ext1"],
    tags: ["warm"],
    ua: "ua",
    timezone: "Europe/Prague",
    screenWidth: 1440,
    screenHeight: 900,
    fingerprintSeed: 42,
    cookies: [{ name: "fallback", value: "cookie", domain: ".example.com", path: "/" }],
    seeded: true,
  };
}

test("portable profile codec round-trips profile secrets and normalized session state", () => {
  const source = profile();
  const bundle = JSON.stringify({
    cookies: [{ name: "auth", value: "secret", domain: ".telegram.org", path: "/" }],
    origins: [{ origin: "https://web.telegram.org", localStorage: [{ name: "dc", value: "2" }] }],
    telegramClient: "k",
  });
  const encoded = encodePortableProfile(source, bundle);
  expect(encoded).toMatchObject({
    schemaVersion: 1,
    profile: {
      id: "profile1",
      password: "password",
      proxy: { type: "socks5", pass: "proxy-pass" },
      extensionAssignments: ["ext1"],
    },
    session: {
      cookies: [{ name: "auth", value: "secret" }],
      telegramClient: "k",
    },
  });

  const decoded = decodePortableProfile(encoded);
  expect(decoded.profile).toMatchObject({
    id: "profile1",
    password: "password",
    proxy: { type: "socks5", pass: "proxy-pass" },
    extensions: ["ext1"],
    tags: ["warm"],
    seeded: false,
  });
  expect(JSON.parse(decoded.sessionBundle)).toEqual(encoded.session);
});

test("portable profile codec uses stored cookies when no captured bundle exists", () => {
  expect(encodePortableProfile(profile()).session.cookies[0]).toMatchObject({
    name: "fallback",
    value: "cookie",
  });
});

test("portable profile codec rejects malformed session JSON", () => {
  expect(() => encodePortableProfile(profile(), "not-json")).toThrow("invalid session bundle");
});

test("portable profile codec rejects Cloud payloads without an explicit cookie array", () => {
  const encoded = encodePortableProfile(profile());
  expect(() => decodePortableProfile({
    ...encoded,
    session: {} as any,
  })).toThrow("cookies array");
});

test("portable profile codec rejects unsupported schema versions", () => {
  const encoded = encodePortableProfile(profile());
  expect(() => decodePortableProfile({ ...encoded, schemaVersion: 2 } as any)).toThrow(
    "unsupported portable profile payload",
  );
});
