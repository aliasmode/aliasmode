import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNewProfile, withDefaultBrowser } from "./create.ts";
import { chromiumGpuArgs, deriveFingerprintFlags, hostPlatformOs, newProfileGpuIdentity, normalizeProfileIdentity } from "./fingerprint.ts";
import { createFirefoxProfileConfig } from "./firefox-config.ts";
import { detectHostGpu, linuxGpuVendor, windowsGpuVendor } from "./host-gpu.ts";
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

test("Apple Silicon is Apple, and an Intel Mac reads its vendor from system_profiler", () => {
  const never = () => { throw new Error("no command expected"); };
  expect(detectHostGpu("darwin", "arm64", never)).toBe("apple");
  const report = JSON.stringify({ SPDisplaysDataType: [{ sppci_model: "Intel UHD Graphics 630", spdisplays_vendor: "Intel" }, { sppci_model: "AMD Radeon Pro 5500M" }] });
  expect(detectHostGpu("darwin", "x64", () => report)).toBe("intel");
  expect(detectHostGpu("darwin", "x64", () => "")).toBeUndefined();
  expect(detectHostGpu("freebsd" as NodeJS.Platform, "x64", never)).toBeUndefined();
});

test("a new profile keeps to the host GPU family: the engine's family where it has one, else the host's own GPU on its own system", () => {
  expect(newProfileGpuIdentity("windows", "windows", "nvidia")).toEqual({ vendor: "nvidia", anchor: "windows-d3d11-nvidia" });
  expect(newProfileGpuIdentity("windows", "windows", "intel")).toEqual({ vendor: "intel", anchor: "windows-d3d11-intel" });
  expect(newProfileGpuIdentity("macos", "macos", "apple")).toEqual({ vendor: "apple", anchor: "macos-metal-apple" });
  expect(newProfileGpuIdentity("linux", "linux", "nvidia")).toEqual({ vendor: "nvidia", anchor: "linux-vulkan-nvidia" });
  // No measured family: the host's own GPU, on the host's own system only.
  expect(newProfileGpuIdentity("windows", "windows", "amd")).toEqual({ vendor: "amd" });
  expect(newProfileGpuIdentity("macos", "macos", "intel")).toEqual({ vendor: "intel" });
  // Another system with a family of this vendor (a Windows identity on an Intel Mac, like Boot Camp).
  expect(newProfileGpuIdentity("windows", "macos", "intel")).toEqual({ vendor: "intel", anchor: "windows-d3d11-intel" });
  // No Windows computer has an Apple GPU: the engine keeps its seed draw.
  expect(newProfileGpuIdentity("windows", "macos", "apple")).toBeUndefined();
  expect(newProfileGpuIdentity("linux", "windows", "amd")).toBeUndefined();
  expect(newProfileGpuIdentity("windows", "windows", undefined)).toBeUndefined();
});

test("launch flags: a stored family selects the engine family, and a profile without a stored GPU gets no GPU flag", () => {
  const aliasmode = { chromiumRuntime: "aliasmode" as const, platformOs: "windows" };
  expect(chromiumGpuArgs({ ...aliasmode, identity: { gpu: { vendor: "nvidia", anchor: "windows-d3d11-nvidia" } } }, {}))
    .toEqual(["--fingerprint-anchor=windows-d3d11-nvidia-0947761dfbe9"]);
  expect(chromiumGpuArgs({ ...aliasmode, platformOs: "macos", identity: { gpu: { vendor: "apple", anchor: "macos-metal-apple" } } }, {}))
    .toEqual(["--fingerprint-anchor=macos-metal-apple-850a91233555"]);
  // The 155 build has no host GPU switch yet (TODO-SWITCH), so nothing is sent.
  expect(chromiumGpuArgs({ ...aliasmode, identity: { gpu: { vendor: "amd" } } }, {})).toEqual([]);
  expect(chromiumGpuArgs(aliasmode, {})).toEqual([]);
  expect(chromiumGpuArgs({ identity: { gpu: { vendor: "nvidia", anchor: "windows-d3d11-nvidia" } } }, {})).toEqual([]);
  // A system changed after creation never keeps another system's family: the stored vendor's
  // family of the new system, or none (the seed draw).
  const nvidia = { ...aliasmode, identity: { gpu: { vendor: "nvidia", anchor: "windows-d3d11-nvidia" } } };
  expect(chromiumGpuArgs({ ...nvidia, platformOs: "windows" }, {})).toEqual(["--fingerprint-anchor=windows-d3d11-nvidia-0947761dfbe9"]);
  expect(chromiumGpuArgs({ ...nvidia, platformOs: "linux" }, {})).toEqual(["--fingerprint-anchor=linux-vulkan-nvidia-adf287b8f0ee"]);
  expect(chromiumGpuArgs({ ...nvidia, platformOs: "macos" }, {})).toEqual([]);
  // The internal switch turns the rule off for bisecting a failed gate.
  expect(chromiumGpuArgs({ ...aliasmode, identity: { gpu: { vendor: "nvidia", anchor: "windows-d3d11-nvidia" } } }, { ALIASMODE_SWITCHES_OFF: "x, gpu-family" }))
    .toEqual([]);
});

test("new AliasMode Chromium profiles store the host GPU; CloakBrowser and hosts without a known GPU store none", () => {
  const host = hostPlatformOs();
  const nvidia = buildNewProfile({ chromiumRuntime: "aliasmode", platformOs: "windows" }, () => false, undefined, "nvidia");
  expect(nvidia.identity).toEqual({ gpu: { vendor: "nvidia", anchor: "windows-d3d11-nvidia" } });
  expect(deriveFingerprintFlags(nvidia)).toContain("--fingerprint-anchor=windows-d3d11-nvidia-0947761dfbe9");
  expect(buildNewProfile({ chromiumRuntime: "aliasmode", platformOs: host }, () => false, undefined, "amd").identity).toEqual({ gpu: { vendor: "amd" } });
  expect(buildNewProfile({ chromiumRuntime: "aliasmode", platformOs: "windows" }, () => false, undefined, undefined).identity).toBeUndefined();
  expect(buildNewProfile({ chromiumRuntime: "cloakbrowser", platformOs: "windows" }, () => false, undefined, "nvidia").identity).toBeUndefined();
  expect(buildNewProfile({ engine: "firefox", platformOs: "windows" }, () => false, undefined, "nvidia").identity).toBeUndefined();
  const imported = withDefaultBrowser({ ...buildNewProfile({ chromiumRuntime: "cloakbrowser", platformOs: "windows" }, () => false), engine: undefined, extensions: ["abcdefghijklmnopabcdefghijklmnop"] }, "intel");
  if (imported.chromiumRuntime) expect(imported.identity).toEqual({ gpu: { vendor: "intel", anchor: "windows-d3d11-intel" } });
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
  const profile = buildNewProfile({ chromiumRuntime: "aliasmode", platformOs: "windows" }, () => false, undefined, "intel");
  store.upsertProfile(profile);
  const { identity: _identity, ...edited } = store.getProfile(profile.id)!;
  store.upsertProfile({ ...edited, name: "renamed" });
  expect(store.getProfile(profile.id)).toMatchObject({ name: "renamed", identity: { gpu: { vendor: "intel", anchor: "windows-d3d11-intel" } } });

  const payload = encodePortableProfile(store.getProfile(profile.id)!);
  expect(payload.schemaVersion).toBe(5);
  expect(payload.profile).toMatchObject({ chromiumRuntime: "aliasmode", identity: { gpu: { vendor: "intel", anchor: "windows-d3d11-intel" } } });
  expect(decodePortableProfile(payload).profile.identity).toEqual({ gpu: { vendor: "intel", anchor: "windows-d3d11-intel" } });
  // A newer client's values, and the reserved text bucket, are kept unchanged.
  const newer = { ...payload, profile: { ...payload.profile, identity: { gpu: { vendor: "moore-threads" }, textBucket: "win.smoothing-off" } } };
  expect(encodePortableProfile(decodePortableProfile(newer as any).profile).profile).toMatchObject({ identity: newer.profile.identity });

  for (const invalid of [
    { ...payload, schemaVersion: 3 },
    { ...payload, profile: { ...payload.profile, identity: { gpu: { vendor: "NVIDIA" } } } },
    { ...payload, profile: { ...payload.profile, identity: { gpu: { vendor: "nvidia", model: "x" } } } },
    { ...payload, profile: { ...payload.profile, identity: {} } },
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
