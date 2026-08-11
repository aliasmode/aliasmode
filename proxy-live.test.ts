import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildNewProfile } from "./create.ts";
import { CloudBrowserCoordinator } from "./cloud-browser.ts";
import { Launcher } from "./launcher.ts";
import { PendingSyncQueue } from "./pending-sync.ts";
import { encodePortableProfile } from "./portable-profile.ts";
import { readSession, writeSession } from "./session.ts";
import { verifyBrowserProxy } from "./egress.ts";
import { ProfileStore } from "./store.ts";
import type { ProxyType } from "./types.ts";

const binary = process.env.ALIASMODE_LIVE_BROWSER?.trim() ?? "";
const binarySha256 = process.env.ALIASMODE_LIVE_BROWSER_SHA256?.trim() ?? "";
const proxyHost = process.env.ALIASMODE_LIVE_PROXY_HOST?.trim() ?? "";
const proxyPort = process.env.ALIASMODE_LIVE_PROXY_PORT?.trim() ?? "";
const proxyUser = process.env.ALIASMODE_LIVE_PROXY_USER ?? "";
const proxyPass = process.env.ALIASMODE_LIVE_PROXY_PASS ?? "";
const expectedIp = process.env.ALIASMODE_LIVE_PROXY_IP?.trim() ?? "";
const configured = Boolean(binary && binarySha256 && proxyHost && proxyPort && proxyUser && proxyPass && expectedIp);
const liveTest = configured ? test : test.skip;
const cloudLiveTest = configured ? test : test.skip;

async function launchThrough(type: ProxyType, pass = proxyPass): Promise<{
  ip: string;
  launcher: Launcher;
  store: ProfileStore;
  profileId: string;
  root: string;
}> {
  const root = join(tmpdir(), `aliasmode-live-proxy-${type}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const store = new ProfileStore(join(root, "profiles.sqlite"));
  const profile = buildNewProfile({
    name: `live-${type}`,
    proxy: { type, host: proxyHost, port: proxyPort, user: proxyUser, pass },
    screen: "1280x800",
  }, () => false);
  store.upsertProfile(profile);
  const launcher = new Launcher({
    store,
    binaryPath: binary,
    expectedBinarySha256: binarySha256,
    dataRoot: join(root, "profiles"),
    headless: true,
    portRange: { start: 9700, end: 9799 },
    baseArgs: ["--no-sandbox", "--disable-dev-shm-usage"],
    labelWindow: async () => {},
    cdpReadyTimeoutMs: 45_000,
  });
  try {
    const launched = await launcher.start(profile.id, [], { autoNavigate: false });
    const verified = await verifyBrowserProxy(launched.ws);
    return { ip: verified.ip, launcher, store, profileId: profile.id, root };
  } catch (error) {
    await launcher.stop(profile.id).catch(() => {});
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw error;
  }
}

async function cleanup(run: Awaited<ReturnType<typeof launchThrough>>): Promise<void> {
  await run.launcher.stop(run.profileId).catch(() => {});
  run.store.close();
  rmSync(run.root, { recursive: true, force: true });
}

async function expectWrongCredentialsToFail(type: "http" | "socks5"): Promise<void> {
  const root = join(tmpdir(), `aliasmode-live-proxy-wrong-${type}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const store = new ProfileStore(join(root, "profiles.sqlite"));
  const profile = buildNewProfile({
    name: `live-${type}-wrong-password`,
    proxy: { type, host: proxyHost, port: proxyPort, user: proxyUser, pass: `${proxyPass}-wrong` },
    screen: "1280x800",
  }, () => false);
  store.upsertProfile(profile);
  const launcher = new Launcher({
    store,
    binaryPath: binary,
    expectedBinarySha256: binarySha256,
    dataRoot: join(root, "profiles"),
    headless: true,
    portRange: { start: 9700, end: 9799 },
    baseArgs: ["--no-sandbox", "--disable-dev-shm-usage"],
    labelWindow: async () => {},
    cdpReadyTimeoutMs: 45_000,
  });
  try {
    await expect(launcher.start(profile.id, [], { autoNavigate: false })).rejects.toThrow(
      "Proxy verification failed before account traffic",
    );
    expect(store.getLaunch(profile.id)).toBeNull();
  } finally {
    await launcher.stop(profile.id).catch(() => {});
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function exerciseCloudThrough(type: "http" | "socks5"): Promise<void> {
  const root = join(tmpdir(), `aliasmode-live-cloud-proxy-${type}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const store = new ProfileStore(join(root, "profiles.sqlite"));
  const queue = new PendingSyncQueue(join(root, "pending.sqlite"), new Uint8Array(32).fill(1));
  const profile = buildNewProfile({
    name: `live-cloud-${type}`,
    proxy: { type, host: proxyHost, port: proxyPort, user: proxyUser, pass: proxyPass },
    screen: "1280x800",
  }, () => false);
  const launcher = new Launcher({
    store,
    binaryPath: binary,
    expectedBinarySha256: binarySha256,
    dataRoot: join(root, "profiles"),
    headless: true,
    portRange: type === "http" ? { start: 9700, end: 9799 } : { start: 9800, end: 9899 },
    baseArgs: ["--no-sandbox", "--disable-dev-shm-usage"],
    labelWindow: async () => {},
    cdpReadyTimeoutMs: 45_000,
  });
  let payload = encodePortableProfile(profile, JSON.stringify({ cookies: [] }));
  let version = 1;
  let registration = 0;
  const cloud = {
    async openProfile() {
      registration++;
      return {
        ok: true as const,
        registrationId: `live-registration-${registration}`,
        baseVersion: version,
        payload,
        activeOpens: [],
      };
    },
    async heartbeat() { return { ok: true as const, revoked: false as const, activeOpens: [] }; },
    async closeOpen(_registrationId: string, request: { expectedVersion: number; payload: typeof payload }) {
      if (request.expectedVersion !== version) throw new Error("live Cloud proxy smoke received a stale close");
      payload = request.payload;
      version++;
      return { ok: true as const, status: "accepted" as const, version };
    },
    async abandon() { return { ok: true as const, status: "abandoned" as const }; },
  };
  const coordinator = new CloudBrowserCoordinator({
    cloud: cloud as any,
    launcher,
    store,
    queue: () => queue,
    accountId: () => "live-account",
    deviceId: () => "live-device",
    readSession,
    writeSession,
    heartbeatMs: 0,
  });

  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      const opened = await coordinator.open(profile.id);
      expect(opened.ok).toBe(true);
      if (!opened.ok || !opened.ws) throw new Error(opened.error ?? "live Cloud proxy smoke could not open");
      expect(store.getProfile(profile.id)?.proxy).toEqual(profile.proxy);
      expect(store.getLaunch(profile.id)?.relayPort).toBeNumber();
      expect((await verifyBrowserProxy(opened.ws)).ip).toBe(expectedIp);
      expect(await launcher.active(profile.id)).toBe(true);
      expect(await coordinator.close(profile.id)).toBe(true);
      expect(await launcher.active(profile.id)).toBe(false);
      expect(store.getLaunch(profile.id)).toBeNull();
    }
  } finally {
    await coordinator.releaseAll(true).catch(() => false);
    await launcher.stop(profile.id).catch(() => false);
    queue.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

cloudLiveTest("real Cloud lifecycle restores through authenticated HTTP", async () => {
  await exerciseCloudThrough("http");
}, 240_000);

cloudLiveTest("real Cloud lifecycle restores through authenticated SOCKS5", async () => {
  await exerciseCloudThrough("socks5");
}, 240_000);

liveTest("real AliasMode launch authenticates and browses through SOCKS5", async () => {
  const run = await launchThrough("socks5");
  try {
    expect(run.ip).toBe(expectedIp);
  } finally {
    await cleanup(run);
  }
}, 120_000);

liveTest("real AliasMode launch authenticates and browses through HTTP", async () => {
  const run = await launchThrough("http");
  try {
    expect(run.ip).toBe(expectedIp);
  } finally {
    await cleanup(run);
  }
}, 120_000);

liveTest("wrong SOCKS5 credentials fail before AliasMode records a launch", async () => {
  await expectWrongCredentialsToFail("socks5");
}, 120_000);

liveTest("wrong HTTP credentials fail before AliasMode records a launch", async () => {
  await expectWrongCredentialsToFail("http");
}, 120_000);
