import { expect, test } from "bun:test";
import { CloudAuthRuntime } from "./cloud-auth.ts";
import type { SupabaseAuthClient } from "./supabase-auth.ts";

function auth(overrides: Partial<SupabaseAuthClient> = {}): SupabaseAuthClient {
  return {
    async signUp() {
      return { user: { id: "account1", email_confirmed_at: null }, verificationRequired: true };
    },
    async signIn() {
      return {
        accessToken: "access",
        refreshToken: "refresh",
        expiresIn: 60,
        expiresAt: 61_000,
        user: { id: "account1", email: "user@example.com", email_confirmed_at: "verified" },
      };
    },
    async refresh() {
      return {
        accessToken: "restored-access",
        refreshToken: "rotated-refresh",
        expiresIn: 60,
        expiresAt: 61_000,
        user: { id: "account1", email_confirmed_at: "verified" },
      };
    },
    async signOut() {},
    ...overrides,
  } as SupabaseAuthClient;
}

test("Cloud auth keeps access tokens only in runtime state", async () => {
  const runtime = new CloudAuthRuntime(auth(), () => 1_000);
  expect(runtime.state()).toEqual({ authenticated: false });
  expect(await runtime.signIn("user@example.com", "password")).toMatchObject({
    authenticated: true,
    refreshToken: "refresh",
    user: { id: "account1" },
  });
  expect(runtime.accessToken()).toBe("access");
  expect(runtime.state()).toMatchObject({ authenticated: true, expiresAt: 61_000 });
});

test("Cloud auth rejects expired in-memory access tokens", async () => {
  let now = 1_000;
  const runtime = new CloudAuthRuntime(auth(), () => now);
  await runtime.signIn("user@example.com", "password");
  now = 61_000;
  expect(runtime.accessToken()).toBeUndefined();
  expect(runtime.state()).toEqual({ authenticated: false });
});

test("Cloud auth restores rotated sessions into runtime memory", async () => {
  const runtime = new CloudAuthRuntime(auth(), () => 1_000);
  expect(await runtime.restore("stored-refresh")).toMatchObject({
    refreshToken: "rotated-refresh",
    authenticated: true,
  });
  expect(runtime.accessToken()).toBe("restored-access");
});

test("Cloud auth refreshes expired access tokens without a dashboard page", async () => {
  let now = 1_000;
  const rotated: string[] = [];
  const runtime = new CloudAuthRuntime(
    auth({
      async refresh() {
        return {
          accessToken: "restored-access",
          refreshToken: "rotated-refresh",
          expiresIn: 60,
          expiresAt: 121_000,
          user: { id: "account1", email_confirmed_at: "verified" },
        };
      },
    }),
    () => now,
    (refreshToken) => { rotated.push(refreshToken); },
  );
  await runtime.signIn("user@example.com", "password");
  now = 61_000;
  expect(runtime.accessToken()).toBeUndefined();
  expect(await runtime.accessTokenOrRefresh()).toBe("restored-access");
  expect(rotated).toEqual(["refresh", "rotated-refresh"]);
});

test("Cloud restore persists its rotated refresh token before returning", async () => {
  const persisted: string[] = [];
  const runtime = new CloudAuthRuntime(
    auth(),
    () => 1_000,
    async (refreshToken) => { persisted.push(refreshToken); },
  );
  await expect(runtime.restore("stored-refresh")).resolves.toMatchObject({ authenticated: true });
  expect(persisted).toEqual(["rotated-refresh"]);
});

test("Cloud sign-out clears memory and durable credentials even when remote logout fails", async () => {
  let cleared = 0;
  const runtime = new CloudAuthRuntime(auth({
    async signOut() { throw new Error("offline"); },
  }), () => 1_000, undefined, async () => { cleared++; });
  await runtime.signIn("user@example.com", "password");
  await expect(runtime.signOut()).rejects.toThrow("offline");
  expect(runtime.state()).toEqual({ authenticated: false });
  expect(cleared).toBe(1);
});
