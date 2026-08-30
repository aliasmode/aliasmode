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

test("Cloud auth refuses to replace an active account session", async () => {
  let signInCalls = 0;
  const runtime = new CloudAuthRuntime(auth({
    async signIn() {
      signInCalls++;
      return {
        accessToken: `access-${signInCalls}`,
        refreshToken: `refresh-${signInCalls}`,
        expiresIn: 60,
        expiresAt: 61_000,
        user: { id: `account${signInCalls}`, email_confirmed_at: "verified" },
      };
    },
  }), () => 1_000);
  await runtime.signIn("first@example.com", "password");

  await expect(runtime.signIn("second@example.com", "password")).rejects.toThrow(
    "Sign out before signing in to another Cloud account",
  );
  await expect(runtime.restore("replacement-refresh")).rejects.toThrow(
    "Sign out before restoring another Cloud account",
  );
  await expect(runtime.restore("refresh-1")).resolves.toMatchObject({
    authenticated: true,
    user: { id: "account1" },
  });
  expect(signInCalls).toBe(1);
  expect(runtime.state()).toMatchObject({
    authenticated: true,
    user: { id: "account1" },
  });
});

test("Cloud auth admits only one initial sign-in", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let finishSignIn!: (session: any) => void;
  const remote = new Promise<any>((resolve) => { finishSignIn = resolve; });
  let signInCalls = 0;
  const runtime = new CloudAuthRuntime(auth({
    async signIn() {
      signInCalls++;
      markStarted();
      return remote;
    },
  }), () => 1_000);

  const first = runtime.signIn("first@example.com", "password");
  await started;
  await expect(runtime.signIn("second@example.com", "password")).rejects.toThrow(
    "Cloud authentication is already in progress",
  );
  finishSignIn({
    accessToken: "access",
    refreshToken: "refresh",
    expiresIn: 60,
    expiresAt: 61_000,
    user: { id: "account1", email_confirmed_at: "verified" },
  });

  await expect(first).resolves.toMatchObject({ authenticated: true, user: { id: "account1" } });
  expect(signInCalls).toBe(1);
  expect(runtime.state()).toMatchObject({ authenticated: true, user: { id: "account1" } });
});

test("Cloud sign-out cancels a pending sign-in without blocking the next account", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let finishFirst!: (session: any) => void;
  const firstRemote = new Promise<any>((resolve) => { finishFirst = resolve; });
  const runtime = new CloudAuthRuntime(auth({
    async signIn(email) {
      if (email === "first@example.com") {
        markStarted();
        return firstRemote;
      }
      return {
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresIn: 60,
        expiresAt: 61_000,
        user: { id: "account2", email_confirmed_at: "verified" },
      };
    },
  }), () => 1_000);

  const first = runtime.signIn("first@example.com", "password");
  await started;
  await runtime.signOut();
  await expect(runtime.signIn("second@example.com", "password")).resolves.toMatchObject({
    user: { id: "account2" },
  });
  finishFirst({
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresIn: 60,
    expiresAt: 61_000,
    user: { id: "account1", email_confirmed_at: "verified" },
  });

  await expect(first).rejects.toThrow("cancelled");
  expect(runtime.state()).toMatchObject({ authenticated: true, user: { id: "account2" } });
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

test("Cloud sign-out detaches an old refresh from the next account", async () => {
  let now = 1_000;
  let markOldRefreshStarted!: () => void;
  const oldRefreshStarted = new Promise<void>((resolve) => { markOldRefreshStarted = resolve; });
  let finishOldRefresh!: (session: any) => void;
  const oldRefresh = new Promise<any>((resolve) => { finishOldRefresh = resolve; });
  let account = 1;
  const runtime = new CloudAuthRuntime(auth({
    async signIn() {
      return {
        accessToken: `access-${account}`,
        refreshToken: `refresh-${account}`,
        expiresIn: 60,
        expiresAt: account === 1 ? 61_000 : 121_000,
        user: { id: `account${account++}`, email_confirmed_at: "verified" },
      };
    },
    async refresh(refreshToken) {
      if (refreshToken === "refresh-1") {
        markOldRefreshStarted();
        return oldRefresh;
      }
      return {
        accessToken: "access-2-refreshed",
        refreshToken: "refresh-2-rotated",
        expiresIn: 60,
        expiresAt: 181_000,
        user: { id: "account2", email_confirmed_at: "verified" },
      };
    },
  }), () => now);

  await runtime.signIn("first@example.com", "password");
  now = 61_000;
  const stale = runtime.accessTokenOrRefresh();
  await oldRefreshStarted;
  await runtime.signOut();
  await runtime.signIn("second@example.com", "password");
  now = 121_000;
  const current = runtime.accessTokenOrRefresh();

  await expect(current).resolves.toBe("access-2-refreshed");
  finishOldRefresh({
    accessToken: "stale-access",
    refreshToken: "stale-refresh",
    expiresIn: 60,
    expiresAt: 181_000,
    user: { id: "account1", email_confirmed_at: "verified" },
  });
  await expect(stale).resolves.toBeUndefined();
  expect(runtime.state()).toMatchObject({ authenticated: true, user: { id: "account2" } });
});

test("Cloud restore can retry after a rotated credential write fails", async () => {
  let refreshCalls = 0;
  let rejectCredentialWrite = true;
  const runtime = new CloudAuthRuntime(
    auth({
      async refresh() {
        refreshCalls++;
        return {
          accessToken: `access-${refreshCalls}`,
          refreshToken: `rotated-${refreshCalls}`,
          expiresIn: 60,
          expiresAt: 61_000,
          user: { id: "account1", email_confirmed_at: "verified" },
        };
      },
    }),
    () => 1_000,
    async () => {
      if (rejectCredentialWrite) throw new Error("credential write failed");
    },
  );

  await expect(runtime.restore("stored-refresh")).rejects.toThrow("credential write failed");
  expect(runtime.canRestore("stored-refresh")).toBe(true);

  rejectCredentialWrite = false;
  await expect(runtime.restore("stored-refresh")).resolves.toMatchObject({
    authenticated: true,
    refreshToken: "rotated-2",
  });
  expect(refreshCalls).toBe(2);
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

test("Cloud auth forgets stored session credentials without a remote request", async () => {
  let remoteSignOuts = 0;
  let credentialClears = 0;
  const runtime = new CloudAuthRuntime(auth({
    async signOut() { remoteSignOuts++; },
  }), () => 1_000, undefined, async () => { credentialClears++; });
  await runtime.signIn("user@example.com", "password");

  await runtime.clearStoredSession();

  expect(runtime.state()).toEqual({ authenticated: false });
  expect(remoteSignOuts).toBe(0);
  expect(credentialClears).toBe(1);
});

test("Cloud auth forget fences a restore started while credentials are clearing", async () => {
  let markClearStarted!: () => void;
  const clearStarted = new Promise<void>((resolve) => { markClearStarted = resolve; });
  let finishClear!: () => void;
  const clearPending = new Promise<void>((resolve) => { finishClear = resolve; });
  const credentialEvents: string[] = [];
  const runtime = new CloudAuthRuntime(
    auth(),
    () => 1_000,
    async (token) => { credentialEvents.push(`persist:${token}`); },
    async () => {
      credentialEvents.push("clear:start");
      markClearStarted();
      await clearPending;
      credentialEvents.push("clear:done");
    },
  );

  const forgetting = runtime.clearStoredSession();
  await clearStarted;
  const restoring = runtime.restore("stale-refresh");
  await Promise.resolve();
  await Promise.resolve();
  finishClear();

  await forgetting;
  await expect(restoring).rejects.toThrow("cancelled");
  expect(runtime.state()).toEqual({ authenticated: false });
  expect(credentialEvents).toEqual(["clear:start", "clear:done"]);
});

test("Cloud sign-out fences a late restore and clears credentials last", async () => {
  let finishRestore!: (session: any) => void;
  const restore = new Promise<any>((resolve) => { finishRestore = resolve; });
  const credentialEvents: string[] = [];
  const runtime = new CloudAuthRuntime(
    auth({ async refresh() { return restore; } }),
    () => 1_000,
    async (token) => { credentialEvents.push(`persist:${token}`); },
    async () => { credentialEvents.push("clear"); },
  );

  const pending = runtime.restore("stored-refresh");
  const signedOut = runtime.signOut();
  finishRestore({
    accessToken: "late-access",
    refreshToken: "late-refresh",
    expiresIn: 60,
    expiresAt: 61_000,
    user: { id: "account1", email_confirmed_at: "verified" },
  });

  await expect(pending).rejects.toThrow("cancelled");
  await signedOut;
  expect(runtime.state()).toEqual({ authenticated: false });
  expect(credentialEvents).toEqual(["clear"]);
});

test("Cloud sign-out waits for an accepted refresh write before clearing credentials", async () => {
  let markPersistStarted!: () => void;
  const persistStarted = new Promise<void>((resolve) => { markPersistStarted = resolve; });
  let finishPersist!: () => void;
  const persisted = new Promise<void>((resolve) => { finishPersist = resolve; });
  const credentialEvents: string[] = [];
  const runtime = new CloudAuthRuntime(
    auth(),
    () => 1_000,
    async (token) => {
      credentialEvents.push(`persist:${token}:start`);
      markPersistStarted();
      await persisted;
      credentialEvents.push(`persist:${token}:done`);
    },
    async () => { credentialEvents.push("clear"); },
  );

  const restoring = runtime.restore("stored-refresh");
  await persistStarted;
  const signedOut = runtime.signOut();
  finishPersist();

  await expect(restoring).rejects.toThrow("cancelled");
  await signedOut;
  expect(runtime.state()).toEqual({ authenticated: false });
  expect(credentialEvents).toEqual([
    "persist:rotated-refresh:start",
    "persist:rotated-refresh:done",
    "clear",
  ]);
});

test("Cloud sign-out succeeds locally when remote logout fails", async () => {
  let cleared = 0;
  const runtime = new CloudAuthRuntime(auth({
    async signOut() { throw new Error("offline"); },
  }), () => 1_000, undefined, async () => { cleared++; });
  await runtime.signIn("user@example.com", "password");

  await expect(runtime.signOut()).resolves.toBeUndefined();

  expect(runtime.state()).toEqual({ authenticated: false });
  expect(cleared).toBe(1);
});

test("Cloud sign-out clears durable credentials without waiting for remote logout", async () => {
  let markRemoteStarted!: () => void;
  const remoteStarted = new Promise<void>((resolve) => { markRemoteStarted = resolve; });
  let finishRemote!: () => void;
  const remotePending = new Promise<void>((resolve) => { finishRemote = resolve; });
  let cleared = 0;
  const runtime = new CloudAuthRuntime(auth({
    async signOut() {
      markRemoteStarted();
      await remotePending;
    },
  }), () => 1_000, undefined, async () => { cleared++; });
  await runtime.signIn("user@example.com", "password");

  const signedOut = runtime.signOut();
  let settled = false;
  void signedOut.then(() => { settled = true; });
  await remoteStarted;
  try {
    await Bun.sleep(0);
    expect(cleared).toBe(1);
    expect(settled).toBe(true);
  } finally {
    finishRemote();
    await signedOut;
  }
  expect(runtime.state()).toEqual({ authenticated: false });
});

test("Cloud sign-out still rejects a durable credential clear failure", async () => {
  const runtime = new CloudAuthRuntime(
    auth({ async signOut() { throw new Error("offline"); } }),
    () => 1_000,
    undefined,
    async () => { throw new Error("credential clear failed"); },
  );
  await runtime.signIn("user@example.com", "password");

  await expect(runtime.signOut()).rejects.toThrow("credential clear failed");
  expect(runtime.state()).toEqual({ authenticated: false });
});
