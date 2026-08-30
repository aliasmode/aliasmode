import { expect, test } from "bun:test";
import {
  EmailVerificationRequiredError,
  SupabaseAuthClient,
  SupabaseAuthRequestError,
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

test("Supabase signup uses the production confirmation redirect", async () => {
  let url = "";
  const auth = client(async (nextUrl) => {
    url = String(nextUrl);
    return Response.json({
      user: { id: "account1", email: "user@example.com", email_confirmed_at: null },
      session: null,
    });
  });
  expect(await auth.signUp("user@example.com", "password")).toEqual({
    user: { id: "account1", email: "user@example.com", email_confirmed_at: null },
    verificationRequired: true,
  });
  expect(url).toBe("https://auth.aliasmode.test/auth/v1/signup?redirect_to=https%3A%2F%2Faliasmode.com%2Fauth%2Femail-confirmation");
});

test("Supabase auth resends signup confirmation with the production redirect", async () => {
  let url = "";
  let body: unknown;
  const auth = client(async (nextUrl, init) => {
    url = String(nextUrl);
    body = JSON.parse(String(init?.body));
    return Response.json({});
  });
  await auth.resendSignUpConfirmation("user@example.com");
  expect(url).toBe("https://auth.aliasmode.test/auth/v1/resend?redirect_to=https%3A%2F%2Faliasmode.com%2Fauth%2Femail-confirmation");
  expect(body).toEqual({ type: "signup", email: "user@example.com" });
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

test("Supabase auth signs out only the captured session", async () => {
  let url = "";
  let authorization = "";
  const auth = client(async (nextUrl, init) => {
    url = String(nextUrl);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(null, { status: 204 });
  });

  await auth.signOut("old-access");

  expect(url).toBe("https://auth.aliasmode.test/auth/v1/logout?scope=local");
  expect(authorization).toBe("Bearer old-access");
});

test("Supabase auth preserves permanent refresh failure status", async () => {
  const auth = client(async () => Response.json({ message: "invalid refresh token" }, { status: 401 }));
  await expect(auth.refresh("stored-refresh")).rejects.toMatchObject({
    name: "SupabaseAuthRequestError",
    failure: { kind: "http", status: 401, retryable: false },
  });
});

test("Supabase auth classifies retryable HTTP failures", async () => {
  for (const status of [408, 425, 429, 500, 503]) {
    const auth = client(async () => Response.json({ message: "temporarily unavailable" }, { status }));
    await expect(auth.refresh("stored-refresh")).rejects.toMatchObject({
      name: "SupabaseAuthRequestError",
      failure: { kind: "http", status, retryable: true },
    });
  }
});

test("Supabase auth classifies fetch failures without losing their cause", async () => {
  const failure = new TypeError("fetch failed");
  const auth = client(async () => { throw failure; });
  try {
    await auth.refresh("stored-refresh");
    throw new Error("expected refresh to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SupabaseAuthRequestError);
    expect(error).toMatchObject({ failure: { kind: "transport", retryable: true }, cause: failure });
  }
});

test("Supabase auth keeps HTTP status for non-JSON error responses", async () => {
  const auth = client(async () => new Response("gateway unavailable", { status: 502 }));
  await expect(auth.refresh("stored-refresh")).rejects.toMatchObject({
    failure: { kind: "http", status: 502, retryable: true },
  });
});

test("Supabase auth bounds fetch implementations that ignore abort", async () => {
  const auth = client(() => new Promise<Response>(() => {}), 5);
  await expect(auth.signIn("user@example.com", "password")).rejects.toMatchObject({
    message: expect.stringContaining("timed out after 5ms"),
    failure: { kind: "timeout", retryable: true },
  });
});
