import { expect, test } from "bun:test";
import {
  EmailVerificationRequiredError,
  SupabaseAuthClient,
  type AuthFetch,
} from "./supabase-auth.ts";

function client(fetchFn: AuthFetch, timeout = 1_000) {
  return new SupabaseAuthClient({
    baseUrl: "https://auth.aliasmode.test/",
    anonKey: "public-anon-key",
    fetchFn,
    requestTimeoutMs: timeout,
    nowMs: () => 1_000,
  });
}

test("Supabase auth rejects insecure non-loopback service URLs", () => {
  expect(() => new SupabaseAuthClient({
    baseUrl: "http://auth.example",
    anonKey: "public-key",
  })).toThrow("AliasMode Auth URL must use HTTPS");
});

test("Supabase auth signs in verified accounts and keeps access tokens in the returned session", async () => {
  let url = "";
  let init: RequestInit | undefined;
  const auth = client(async (nextUrl, nextInit) => {
    url = String(nextUrl);
    init = nextInit;
    return Response.json({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      user: { id: "account1", email: "user@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" },
    });
  });
  expect(await auth.signIn("user@example.com", "password")).toEqual({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresIn: 3600,
    expiresAt: 3_601_000,
    user: { id: "account1", email: "user@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" },
  });
  expect(url).toBe("https://auth.aliasmode.test/auth/v1/token?grant_type=password");
  expect(new Headers(init?.headers).get("apikey")).toBe("public-anon-key");
  expect(JSON.parse(String(init?.body))).toEqual({ email: "user@example.com", password: "password" });
});

test("Supabase auth never accepts an unverified session", async () => {
  const auth = client(async () => Response.json({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_in: 3600,
    user: { id: "account1", email: "user@example.com", email_confirmed_at: null },
  }));
  await expect(auth.signIn("user@example.com", "password")).rejects.toBeInstanceOf(
    EmailVerificationRequiredError,
  );
});

test("Supabase signup reports when email verification is required", async () => {
  const auth = client(async () => Response.json({
    user: { id: "account1", email: "user@example.com", email_confirmed_at: null },
    session: null,
  }));
  expect(await auth.signUp("user@example.com", "password")).toEqual({
    user: { id: "account1", email: "user@example.com", email_confirmed_at: null },
    verificationRequired: true,
  });
});

test("Supabase auth refresh uses only the supplied refresh token", async () => {
  let body: any;
  const auth = client(async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 60,
      user: { id: "account1", email_confirmed_at: "verified" },
    });
  });
  expect((await auth.refresh("stored-refresh")).accessToken).toBe("new-access");
  expect(body).toEqual({ refresh_token: "stored-refresh" });
});

test("Supabase auth bounds fetch implementations that ignore abort", async () => {
  const auth = client(() => new Promise<Response>(() => {}), 5);
  await expect(auth.signIn("user@example.com", "password")).rejects.toThrow("timed out after 5ms");
});
