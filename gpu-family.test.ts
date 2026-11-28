import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNewProfile, freshIdentity, withDefaultBrowser } from "./create.ts";
import { chromiumGpuArgs, chromiumMediaArgs, deriveFingerprintFlags, hostPlatformOs, newProfileGpuIdentity, normalizeProfileIdentity } from "./fingerprint.ts";
import { createFirefoxProfileConfig } from "./firefox-config.ts";
import { detectHostGpu, hostGpuVendor, linuxGpuVendor, resetHostGpuForTest, spawnText, waitForHostGpu, windowsGpuVendor } from "./host-gpu.ts";
import { parseExport, serializeAdsTxt, serializeXlsxRows } from "./parse.ts";
import { decodePortableProfile, encodePortableProfile } from "./portable-profile.ts";
import { ProfileStore } from "./store.ts";

test("Windows takes the GPU that drives a display, and skips virtual adapters", () => {
  const nvidia = { PNPDeviceID: "PCI\\VEN_10DE&DEV_2482&SUBSYS_00000000&REV_A1\\4&1", CurrentHorizontalResolution: 2560 };
  const intel = { PNPDeviceID: "PCI\\VEN_8086&DEV_9A49&SUBSYS_0A1C1028&REV_01\\3&1", CurrentHorizontalResolution: null };
  const hyperV = { PNPDeviceID: "VMBUS\\{DA0A7802-E377-4AAC-8E77-0558EB1073F8}\\{5620E0C7}", CurrentHorizontalResolution: 1024 };
  expect(windowsGpuVendor(JSON.stringify([intel, nvidia]))).toBe("nvidia");
  // A laptop: the integrated GPU drives the screen, and the browser draws on it.
  expect(windowsGpuVendor(JSON.stringify([{ ...intel, CurrentHorizontalResolution: 1920 }, { ...nvidia, CurrentHorizontalResolution: null }]))).toBe("intel");
  expect(windowsGpuVendor(JSON.stringify({ PNPDeviceID: "PCI\\VEN_1002&DEV_73BF&SUBSYS_0E3A1002", CurrentHorizontalResolution: 1920 }))).toBe("amd");
  expect(windowsGpuVendor(JSON.stringify({ PNPDeviceID: "ACPI\\QCOM0C36\\2&DABA3FF&0" }))).toBe("qualcomm");
  expect(windowsGpuVendor(JSON.stringify([hyperV, { PNPDeviceID: "PCI\\VEN_1414&DEV_008E" }]))).toBeUndefined();
  expect(windowsGpuVendor("")).toBeUndefined();
});

test("Linux takes the boot display GPU from /sys/class/drm", () => {
  const drm = mkdtempSync(join(tmpdir(), "aliasmode-drm-"));
  const card = (name: string, vendor: string, bootVga?: string) => {
    mkdirSync(join(drm, name, "device"), { recursive: true });
    writeFileSync(join(drm, name, "device", "vendor"), `${vendor}\n`);
    if (bootVga !== undefined) writeFileSync(join(drm, name, "device", "boot_vga"), `${bootVga}\n`);
  };
  expect(linuxGpuVendor(drm)).toBeUndefined();
  card("card0", "0x1af4");
  expect(linuxGpuVendor(drm)).toBeUndefined();
  card("card1", "0x8086", "0");
  card("card2", "0x10de", "1");
  mkdirSync(join(drm, "card2-HDMI-A-1"));
  expect(linuxGpuVendor(drm)).toBe("nvidia");
  expect(linuxGpuVendor(join(drm, "missing"))).toBeUndefined();
});

test("Apple Silicon is Apple, and an Intel Mac reads its vendor from system_profiler", async () => {
  const never = async () => { throw new Error("no command expected"); };
  expect(await detectHostGpu("darwin", "arm64", never)).toBe("apple");
  const report = JSON.stringify({ SPDisplaysDataType: [{ sppci_model: "Intel UHD Graphics 630", spdisplays_vendor: "Intel" }, { sppci_model: "AMD Radeon Pro 5500M" }] });
  expect(await detectHostGpu("darwin", "x64", async () => report)).toBe("intel");
  expect(await detectHostGpu("darwin", "x64", async () => "")).toBeUndefined();
  expect(await detectHostGpu("freebsd" as NodeJS.Platform, "x64", never)).toBeUndefined();
});

test("the host GPU is read once without blocking, and a timed-out read is not kept", async () => {
  resetHostGpuForTest();
  let calls = 0;
  const timedOut = async () => { calls++; throw new Error("GPU detection timed out"); };
  const [first, second] = await Promise.all([waitForHostGpu(timedOut), waitForHostGpu(timedOut)]);
  expect([first, second, calls]).toEqual([undefined, undefined, 1]);
  expect(await waitForHostGpu(async () => "amd")).toBe("amd");
  expect(await waitForHostGpu(async () => "nvidia")).toBe("amd");
  expect(hostGpuVendor()).toBe("amd");
  // While the read is pending, a profile made without waiting stores no GPU decision.
  resetHostGpuForTest();
  let finish!: (vendor: "intel") => void;
  const pending = waitForHostGpu(() => new Promise((resolve) => { finish = resolve; }));
  expect(hostGpuVendor()).toBeUndefined();
  finish("intel");
  expect(await pending).toBe("intel");
  expect(hostGpuVendor()).toBe("intel");
  resetHostGpuForTest();
});

test("a detection command that exits with an error is a failed read, never 'no GPU'", async () => {
  expect(await spawnText([process.execPath, "-e", "process.stdout.write('ok')"])).toBe("ok");
  await expect(spawnText([process.execPath, "-e", "process.exit(3)"])).rejects.toThrow("code 3");
  const failing = () => spawnText([process.execPath, "-e", "process.exit(1)"]);
  await expect(detectHostGpu("win32", "x64", failing)).rejects.toThrow();
  await expect(detectHostGpu("darwin", "x64", failing)).rejects.toThrow();
  resetHostGpuForTest();
  let calls = 0;
  const failedRead = () => { calls++; return detectHostGpu("win32", "x64", failing); };
  expect(await waitForHostGpu(failedRead)).toBeUndefined();
  expect(await waitForHostGpu(failedRead)).toBeUndefined();
  expect(calls).toBe(2);
  expect(await waitForHostGpu(async () => "intel")).toBe("intel");
  resetHostGpuForTest();
});

test("New identity makes the GPU decision again on this computer and drops the old identity", () => {
  const host = hostPlatformOs();
  const old = {
    ...buildNewProfile({ engine: "chromium", chromiumRuntime: "aliasmode", platformOs: host }, () => false, undefined, undefined),
    identity: { gpu: { vendor: "intel", anchor: `${host}-other-computer-dead` }, mediaCatalogue: 2 },
  };
  const expected = newProfileGpuIdentity(host, host, "nvidia");
  // A new identity is a new profile: it also takes the second media device table.
  const fresh = { ...(expected ? { gpu: expected } : {}), mediaCatalogue: 2 };
  expect(freshIdentity(old, () => false, "nvidia").identity).toEqual(fresh);
  // This computer's GPU is not read: the profile stores no decision, not the old one.
  expect(freshIdentity(old, () => false, undefined).identity).toEqual({ mediaCatalogue: 2 });
  // A profile made before identities existed gets this computer's decision.
  const { identity: _identity, ...older } = old;
  expect(freshIdentity(older, () => false, "nvidia").identity).toEqual(fresh);
  // The store forgets the old decision too, here and on every computer that applies the new identity.
  const store = new ProfileStore(":memory:");
  store.upsertProfile(old);
  store.resetIdentity(freshIdentity(store.getProfile(old.id)!, () => false, undefined));
  expect(store.getProfile(old.id)?.identity).toEqual({ mediaCatalogue: 2 });
  store.resetIdentity(freshIdentity(store.getProfile(old.id)!, () => false, "nvidia"));
  expect(store.getProfile(old.id)?.identity).toEqual(fresh);
  // CloakBrowser stores no GPU decision.
  const cloak = { ...buildNewProfile({ engine: "chromium", chromiumRuntime: "cloakbrowser", platformOs: host }, () => false), identity: old.identity };
  expect(freshIdentity(cloak, () => false, "nvidia")).not.toHaveProperty("identity");
});

test("a new profile stores its GPU decision: the engine's family where it has one, else the host GPU switch, on the host's own system only", () => {
  expect(newProfileGpuIdentity("windows", "windows", "intel")).toEqual({ vendor: "intel", anchor: "windows-d3d11-intel-79dfeb5b4f99" });
  expect(newProfileGpuIdentity("windows", "windows", "nvidia")).toEqual({ vendor: "nvidia", anchor: "windows-d3d11-nvidia-0947761dfbe9" });
  expect(newProfileGpuIdentity("windows", "windows", "qualcomm")).toEqual({ vendor: "qualcomm", anchor: "windows-d3d11-qualcomm-6388f9914f3f" });
  expect(newProfileGpuIdentity("macos", "macos", "apple")).toEqual({ vendor: "apple", anchor: "macos-metal-apple-850a91233555" });
  expect(newProfileGpuIdentity("linux", "linux", "nvidia")).toEqual({ vendor: "nvidia", anchor: "linux-vulkan-nvidia-adf287b8f0ee" });
  // No measured family: the engine's host-GPU switch.
  for (const [os, vendor] of [["windows", "amd"], ["linux", "intel"], ["linux", "amd"], ["macos", "intel"], ["macos", "amd"]]) {
    expect(newProfileGpuIdentity(os!, os!, vendor)).toEqual({ vendor: vendor!, anchor: "host" });
  }
  // Another system, a computer without a known GPU, or a vendor with neither: no decision (the seed draw).
  expect(newProfileGpuIdentity("windows", "macos", "intel")).toBeUndefined();
  expect(newProfileGpuIdentity("linux", "windows", "nvidia")).toBeUndefined();
  expect(newProfileGpuIdentity("windows", "windows", undefined)).toBeUndefined();
  expect(newProfileGpuIdentity("linux", "linux", "qualcomm")).toBeUndefined();
});

test("launch flags come only from the stored decision, never from the vendor", () => {
  const aliasmode = { chromiumRuntime: "aliasmode" as const, platformOs: "windows" };
  const nvidia = { ...aliasmode, identity: { gpu: { vendor: "nvidia", anchor: "windows-d3d11-nvidia-0947761dfbe9" } } };
  expect(chromiumGpuArgs(nvidia, {}, "windows")).toEqual(["--fingerprint-anchor=windows-d3d11-nvidia-0947761dfbe9"]);
  // A stored id is sent as stored, also one this version's table does not list.
  expect(chromiumGpuArgs({ ...aliasmode, identity: { gpu: { vendor: "amd", anchor: "windows-d3d11-amd-0123456789ab" } } }, {}, "windows"))
    .toEqual(["--fingerprint-anchor=windows-d3d11-amd-0123456789ab"]);
  // A vendor without a stored anchor gets nothing, whatever the tables hold.
  expect(chromiumGpuArgs({ ...aliasmode, identity: { gpu: { vendor: "nvidia" } } }, {}, "windows")).toEqual([]);
  expect(chromiumGpuArgs({ ...aliasmode, identity: { gpu: { vendor: "amd" } } }, {}, "windows")).toEqual([]);
  expect(chromiumGpuArgs(aliasmode, {}, "windows")).toEqual([]);
  expect(chromiumGpuArgs({ identity: nvidia.identity }, {}, "windows")).toEqual([]);
  // The host switch, only on a computer of the profile's system.
  const host = { ...aliasmode, identity: { gpu: { vendor: "amd", anchor: "host" } } };
  expect(chromiumGpuArgs(host, {}, "windows")).toEqual(["--fingerprint-gpu-host"]);
  expect(chromiumGpuArgs(host, {}, "macos")).toEqual([]);
  expect(chromiumGpuArgs({ ...host, platformOs: "macos" }, {}, "macos")).toEqual(["--fingerprint-gpu-host"]);
  // A system changed after creation never shows another system's family.
  expect(chromiumGpuArgs({ ...nvidia, platformOs: "linux" }, {}, "linux")).toEqual([]);
  expect(chromiumGpuArgs({ ...nvidia, platformOs: "macos" }, {}, "macos")).toEqual([]);
  // The internal switch turns the rule off for bisecting a failed gate.
  expect(chromiumGpuArgs(nvidia, { ALIASMODE_SWITCHES_OFF: "x, gpu-family" }, "windows")).toEqual([]);
  expect(chromiumGpuArgs(host, { ALIASMODE_SWITCHES_OFF: "gpu-family" }, "windows")).toEqual([]);
});

test("new AliasMode Chromium profiles store the host GPU; CloakBrowser and hosts without a known GPU store none", () => {
  const host = hostPlatformOs();
  const nvidia = buildNewProfile({ chromiumRuntime: "aliasmode", platformOs: host }, () => false, undefined, "nvidia");
  const nvidiaAnchor = { windows: "windows-d3d11-nvidia-0947761dfbe9", linux: "linux-vulkan-nvidia-adf287b8f0ee" }[host as "windows" | "linux"];
  if (nvidiaAnchor) {
    expect(nvidia.identity).toEqual({ gpu: { vendor: "nvidia", anchor: nvidiaAnchor }, mediaCatalogue: 2 });
    expect(deriveFingerprintFlags(nvidia)).toContain(`--fingerprint-anchor=${nvidiaAnchor}`);
  }
  expect(buildNewProfile({ chromiumRuntime: "aliasmode", platformOs: host }, () => false, undefined, "amd").identity).toEqual({ gpu: { vendor: "amd", anchor: "host" }, mediaCatalogue: 2 });
  expect(buildNewProfile({ chromiumRuntime: "aliasmode", platformOs: host }, () => false, undefined, "").identity).toEqual({ mediaCatalogue: 2 });
  expect(buildNewProfile({ chromiumRuntime: "aliasmode", platformOs: host === "windows" ? "linux" : "windows" }, () => false, undefined, "nvidia").identity).toEqual({ mediaCatalogue: 2 });
  expect(buildNewProfile({ chromiumRuntime: "cloakbrowser", platformOs: host }, () => false, undefined, "nvidia").identity).toBeUndefined();
  expect(buildNewProfile({ engine: "firefox", platformOs: host }, () => false, undefined, "nvidia").identity).toBeUndefined();
  const imported = withDefaultBrowser({ ...buildNewProfile({ chromiumRuntime: "cloakbrowser", platformOs: host }, () => false), engine: undefined, extensions: ["abcdefghijklmnopabcdefghijklmnop"] }, "amd");
  if (imported.chromiumRuntime) expect(imported.identity).toEqual({ gpu: { vendor: "amd", anchor: "host" }, mediaCatalogue: 2 });
});

test("new Firefox profiles get a card of the host GPU vendor where their system has one", () => {
  const vendorOf = (config: Record<string, unknown>) => `${config["webGl:vendor"]} ${config["webGl:renderer"]}`;
  for (let seed = 1; seed <= 40; seed++) {
    expect(vendorOf(createFirefoxProfileConfig(1920, 1080, "windows", seed, "nvidia").config)).toMatch(/NVIDIA/);
    expect(vendorOf(createFirefoxProfileConfig(1920, 1080, "windows", seed, "intel").config)).toMatch(/Intel/);
    expect(vendorOf(createFirefoxProfileConfig(1920, 1080, "windows", seed, "amd").config)).toMatch(/AMD|Radeon/);
    expect(vendorOf(createFirefoxProfileConfig(1920, 1080, "linux", seed, "intel").config)).toMatch(/Intel/);
  }
  // No Windows computer has an Apple GPU: the whole Windows set stays, as before the rule.
  const seed = 7;
  expect(createFirefoxProfileConfig(1920, 1080, "windows", seed, "apple").config["webGl:renderer"])
    .toBe(createFirefoxProfileConfig(1920, 1080, "windows", seed).config["webGl:renderer"]);
});

test("a stored identity stays through edits, travels in Cloud schema V5, and older payloads must not carry one", () => {
  const store = new ProfileStore(":memory:");
  const identity = { gpu: { vendor: "intel", anchor: "windows-d3d11-intel-79dfeb5b4f99" }, mediaCatalogue: 2 };
  const profile = { ...buildNewProfile({ chromiumRuntime: "aliasmode", platformOs: "windows" }, () => false, undefined, ""), identity };
  store.upsertProfile(profile);
  const { identity: _identity, ...edited } = store.getProfile(profile.id)!;
  store.upsertProfile({ ...edited, name: "renamed" });
  expect(store.getProfile(profile.id)).toMatchObject({ name: "renamed", identity });

  const payload = encodePortableProfile(store.getProfile(profile.id)!);
  expect(payload.schemaVersion).toBe(5);
  expect(payload.profile).toMatchObject({ chromiumRuntime: "aliasmode", identity });
  expect(decodePortableProfile(payload).profile.identity).toEqual(identity);
  // A newer client's values, and the reserved text bucket, are kept unchanged.
  const newer = { ...payload, profile: { ...payload.profile, identity: { gpu: { vendor: "moore-threads" }, textBucket: "win.smoothing-off" } } };
  expect(encodePortableProfile(decodePortableProfile(newer as any).profile).profile).toMatchObject({ identity: newer.profile.identity });

  for (const invalid of [
    { ...payload, schemaVersion: 3 },
    { ...payload, profile: { ...payload.profile, identity: { gpu: { vendor: "NVIDIA" } } } },
    { ...payload, profile: { ...payload.profile, identity: { gpu: { vendor: "nvidia", model: "x" } } } },
    { ...payload, profile: { ...payload.profile, identity: {} } },
    { ...payload, profile: { ...payload.profile, identity: { mediaCatalogue: 0 } } },
    { ...payload, profile: { ...payload.profile, identity: { mediaCatalogue: 2.5 } } },
    { ...payload, profile: { ...payload.profile, identity: { mediaCatalogue: "2" } } },
  ]) {
    expect(() => decodePortableProfile(invalid as any)).toThrow("unsupported portable profile payload");
  }
  const { identity: _dropped, ...v3 } = payload.profile as any;
  expect(() => decodePortableProfile({ ...payload, profile: v3 } as any)).toThrow("unsupported portable profile payload");
  expect(() => normalizeProfileIdentity({ gpu: { vendor: "nvidia" }, noise: true })).toThrow("unsupported profile identity");
  expect(() => store.upsertProfile({ ...buildNewProfile({ chromiumRuntime: "cloakbrowser" }, () => false), identity: { gpu: { vendor: "nvidia" } } }))
    .toThrow("only AliasMode Chromium profiles store an identity");
  store.close();
});

test("export and import keep the stored identity", () => {
  const identity = { gpu: { vendor: "nvidia", anchor: "windows-d3d11-nvidia-0947761dfbe9" }, mediaCatalogue: 2 };
  const profile = { ...buildNewProfile({ chromiumRuntime: "aliasmode", platformOs: "windows" }, () => false, undefined, ""), identity };
  const { identity: _none, ...legacy } = buildNewProfile({ chromiumRuntime: "aliasmode", platformOs: "windows" }, () => false, undefined, "");
  const text = serializeAdsTxt([profile, legacy]);
  expect(text.match(/^identity=.*$/gm)).toEqual([`identity=${JSON.stringify(identity)}`]);
  const imported = parseExport(text);
  expect(imported.imports.every((item) => item.validationErrors.length === 0)).toBe(true);
  expect(imported.profiles.find((item) => item.id === profile.id)?.identity).toEqual(identity);
  expect(imported.profiles.find((item) => item.id === legacy.id)?.identity).toBeUndefined();
  const sheet = serializeXlsxRows([profile]);
  expect(sheet.rows[0]![sheet.headers.indexOf("identity")]).toBe(JSON.stringify(identity));
  expect(serializeXlsxRows([legacy]).headers).not.toContain("identity");

  const store = new ProfileStore(":memory:");
  store.upsertProfile(imported.profiles.find((item) => item.id === profile.id)!);
  expect(store.getProfile(profile.id)?.identity).toEqual(identity);
  store.close();

  // An invalid identity, or one on a browser that has none, is refused rather than dropped.
  const invalid = (value: string, runtime = "aliasmode") =>
    parseExport(text.split("\n").map((line) => line.startsWith("identity=") ? `identity=${value}` : line.startsWith("chromium_runtime=") ? `chromium_runtime=${runtime}` : line).join("\n"))
      .imports.find((item) => item.profile.id === profile.id)!.validationErrors;
  expect(invalid("{}")).toEqual([]);
  expect(invalid("{not json")[0]).toStartWith("invalid identity");
  expect(invalid(JSON.stringify({ gpu: { vendor: "NVIDIA" } }))[0]).toStartWith("invalid identity");
  expect(invalid(JSON.stringify(identity), "cloakbrowser")).toContain("invalid identity: only AliasMode Chromium profiles store an identity");
});

test("only AliasMode Chromium profiles made with the second media table launch with it", () => {
  expect(chromiumMediaArgs({ chromiumRuntime: "aliasmode", identity: { mediaCatalogue: 2 } })).toEqual(["--fingerprint-media-catalogue=2"]);
  expect(chromiumMediaArgs({ chromiumRuntime: "aliasmode", identity: { gpu: { vendor: "intel" } } })).toEqual([]);
  expect(chromiumMediaArgs({ chromiumRuntime: "aliasmode", identity: { mediaCatalogue: 3 } })).toEqual([]);
  expect(chromiumMediaArgs({ identity: { mediaCatalogue: 2 } })).toEqual([]);
  expect(chromiumMediaArgs(buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false))).toEqual(["--fingerprint-media-catalogue=2"]);
});
