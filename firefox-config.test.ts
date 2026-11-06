import { expect, test } from "bun:test";
import {
  completeProfileFingerprint, createFirefoxProfileConfig, firefoxGraphicsRenderer, firefoxLaunchConfig, firefoxStartupPrefs, fitFirefoxWindow, graphicsIdentity,
  intelMacGraphicsVendor, setFirefoxScreen,
} from "./firefox-config.ts";
import macVoiceLists from "./firefox-data/mac-voices.json";
import { encodePortableProfile, decodePortableProfile } from "./portable-profile.ts";
import type { FirefoxProfileConfig, JsonValue, Profile } from "./types.ts";

function profile(fingerprintSeed: number, config: Record<string, JsonValue> = {}, runtimeVersion = "156.0.1-beta.36"): Profile {
  return {
    id: `firefox-${fingerprintSeed}`, accId: "", name: "", group: "", username: "", password: "", twofa: "",
    proxy: null, ua: "", timezone: "", screenWidth: 1920, screenHeight: 1080, fingerprintSeed,
    cookies: [], seeded: false, engine: "firefox",
    firefox: { version: 1, runtimeVersion, config: { "navigator.platform": "Win32", ...config } },
  };
}

const isUint = (value: JsonValue | undefined) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
const isStrings = (value: JsonValue | undefined) => Array.isArray(value) && value.every((item) => typeof item === "string");

/** The engine crashes on a value of the wrong type (settings/properties.json of the 156 engine). */
function expectEngineTypes(config: Record<string, JsonValue>) {
  for (const key of ["aliasmode:canvasSeed", "aliasmode:textSeed"]) expect(isUint(config[key])).toBe(true);
  expect(config["voices:blockIfNotDefined"]).toBeBoolean();
  expect(config["mediaDevices:enabled"]).toBeBoolean();
  for (const kind of ["micros", "webcams", "speakers"]) expect(isUint(config[`mediaDevices:${kind}`])).toBe(true);
  for (const [count, list] of [["micros", "microphone"], ["webcams", "webcam"], ["speakers", "speaker"]]) {
    for (const suffix of ["Labels", "Groups"]) {
      const values = config[`mediaDevices:${list}${suffix}`];
      expect(isStrings(values)).toBe(true);
      expect((values as string[]).length).toBe(config[`mediaDevices:${count}`] as number);
    }
  }
  expect(Array.isArray(config.voices)).toBe(true);
  for (const voice of config.voices as Record<string, JsonValue>[]) {
    expect(Object.keys(voice).sort()).toEqual(["isDefault", "isLocalService", "lang", "name", "voiceUri"]);
    for (const key of ["lang", "name", "voiceUri"]) expect(voice[key]).toBeString();
    for (const key of ["isDefault", "isLocalService"]) expect(voice[key]).toBeBoolean();
  }
}

test("each Firefox launch gets canvas and text seeds, voices and media devices from its profile seed, never stored, and no audio seed", () => {
  const one = profile(3983315515, { "navigator.globalPrivacyControl": true, "canvas:seed": 7, "fonts:spacing_seed": 8, "audio:seed": 9 });
  const saved = structuredClone(one.firefox);
  const first = firefoxLaunchConfig(one);
  expectEngineTypes(first);
  expect((first.voices as JsonValue[]).length).toBeGreaterThan(0);
  expect(first["voices:blockIfNotDefined"]).toBe(true);
  expect(first["mediaDevices:enabled"]).toBe(true);
  // 156 ignores the canvas and font seeds; privacy control without its Sec-GPC header is a tell. Stock
  // Firefox renders audio the same on every OS, and an audio seed only added noise to exact signals.
  for (const key of ["canvas:seed", "fonts:spacing_seed", "navigator.globalPrivacyControl", "aliasmode:windowLabel", "audio:seed"]) {
    expect(first).not.toHaveProperty(key);
  }
  expect(firefoxLaunchConfig(structuredClone(one))).toEqual(first);
  expect(one.firefox).toEqual(saved);
  const other = firefoxLaunchConfig(profile(2354318635));
  for (const key of ["aliasmode:canvasSeed", "aliasmode:textSeed"]) expect(other[key]).not.toBe(first[key]);
});

test("a Firefox launch keeps a seed, voice list or media device set that the profile stores", () => {
  const config = firefoxLaunchConfig(profile(7, { "aliasmode:canvasSeed": 42, voices: [], "voices:blockIfNotDefined": false, "mediaDevices:enabled": false }));
  expect(config).toMatchObject({ "aliasmode:canvasSeed": 42, voices: [], "voices:blockIfNotDefined": false, "mediaDevices:enabled": false });
  expect(Object.keys(config).filter((key) => key.startsWith("mediaDevices:"))).toEqual(["mediaDevices:enabled"]);
});

test.each([
  ["Win32", "de-DE", /^urn:moz-tts:sapi:Microsoft [A-Za-z]+ - German \(Germany\)\?de-DE$/],
  ["MacIntel", "en-US", /^urn:moz-tts:osx:com\.apple\./],
  ["Linux x86_64", "en-US", /^urn:moz-tts:speechd:[^ ]+\?[a-z]/],
] as const)("Firefox voices and media devices follow the %s persona and %s locale", (platform, locale, uri) => {
  const config = firefoxLaunchConfig({ ...profile(11, { "navigator.platform": platform, "navigator.language": locale }), locale });
  expectEngineTypes(config);
  const voices = config.voices as Array<{ voiceUri: string; isDefault: boolean }>;
  expect(voices.some((voice) => uri.test(voice.voiceUri))).toBe(true);
  // Stock Firefox marks the system voice of the display language as the default on macOS only.
  expect(voices.filter((voice) => voice.isDefault).map((voice) => voice.voiceUri))
    .toEqual(platform === "MacIntel" ? [expect.stringMatching(/^urn:moz-tts:osx:com\.apple\.voice\.(super-)?compact\.en-US\.Samantha$/)] : []);
  if (platform === "Linux x86_64") expect(config["mediaDevices:microphoneLabels"]).toContainEqual(expect.stringMatching(/^Monitor of /));
});

test("a proxied Firefox launch shows the proxy exit IP as WebRTC's public address in its own family", () => {
  const proxy = { type: "http" as const, host: "gate.example.net", port: "8080", user: "", pass: "" };
  const proxied = { ...profile(9, { "webrtc:ipv4": "198.51.100.1" }), proxy };
  const v4 = firefoxLaunchConfig(proxied, undefined, undefined, "203.0.113.7");
  expect(v4["webrtc:ipv4"]).toBe("203.0.113.7");
  expect(v4).not.toHaveProperty("webrtc:ipv6");
  const v6 = firefoxLaunchConfig({ ...profile(9), proxy }, undefined, undefined, "2001:db8::7");
  expect(v6["webrtc:ipv6"]).toBe("2001:db8::7");
  expect(v6).not.toHaveProperty("webrtc:ipv4");
  // Without an exit IP, or without a proxy, the launch config stays as before.
  expect(firefoxLaunchConfig({ ...profile(9), proxy })).not.toHaveProperty("webrtc:ipv4");
  expect(firefoxLaunchConfig(profile(9), undefined, undefined, "203.0.113.7")).not.toHaveProperty("webrtc:ipv4");
  expect(proxied.firefox!.config["webrtc:ipv4"]).toBe("198.51.100.1");
});

test("a Firefox launch without a proxy keeps the computer's IPv6 address from pages", () => {
  const proxy = { type: "http" as const, host: "gate.example.net", port: "8080", user: "", pass: "" };
  expect(firefoxLaunchConfig(profile(9))["network:ipv4Only"]).toBe(true);
  expect(firefoxLaunchConfig({ ...profile(9), proxy })).not.toHaveProperty("network:ipv4Only");
});

test("a Firefox launch shows the window label in the native title and starts in the profile's language", () => {
  const german = { ...profile(5, { "locale:language": "de", "locale:region": "DE", "navigator.language": "de-DE" }), locale: "de-DE" };
  expect(firefoxLaunchConfig(german, "Shop · #3 — ")["aliasmode:windowLabel"]).toBe("Shop · #3 — ");
  expect(firefoxStartupPrefs(german)).toEqual({
    "intl.locale.requested": "de-DE", "dom.webgpu.enabled": true, "dom.webgpu.service-workers.enabled": true, "gfx.blacklist.webgpu": 4, "browser.startup.couldRestoreSession.count": -1,
    "gfx.font_rendering.fallback.async": false,
    "browser.newtabpage.enabled": true,
    // Site caches stay across closes, up to 35 MB.
    "browser.cache.disk.smart_size.enabled": false,
    "browser.cache.disk.capacity": 35 * 1024,
  });
  expect(firefoxStartupPrefs(profile(5))["intl.locale.requested"]).toBe("en-US");
});

test("WebGPU shows where stock Firefox 156 has it, with this computer's adapter only for a macOS profile on an Apple Silicon Mac", () => {
  const macos = (config: Record<string, JsonValue> = {}) => ({ ...profile(5, { "navigator.platform": "MacIntel", ...config }), platformOs: "macos" as const });
  const webgpu = (persona: Profile, platform?: NodeJS.Platform, arch?: string) => {
    const prefs = firefoxStartupPrefs(persona, platform, arch);
    // WebGPU in service workers comes with WebGPU, as in stock Firefox.
    expect(prefs["dom.webgpu.service-workers.enabled"]).toBe(prefs["dom.webgpu.enabled"]!);
    return [prefs["dom.webgpu.enabled"], prefs["gfx.blacklist.webgpu"] === 4];
  };
  const intelCard = { "webGl:vendor": "Intel Inc.", "webGl:renderer": "Intel(R) HD Graphics 400, or similar" };
  // On an Apple Silicon Mac a macOS profile claims that Mac's card family: its adapter is shown.
  expect(webgpu(macos(), "darwin", "arm64")).toEqual([true, false]);
  expect(webgpu(macos(intelCard), "darwin", "arm64")).toEqual([true, false]);
  // Elsewhere an Apple profile has navigator.gpu without an adapter; without a stored card it shows the computer's.
  expect(webgpu(macos(graphicsIdentity("macos", 1)), "win32", "x64")).toEqual([true, true]);
  expect(webgpu(macos(intelCard), "linux", "x64")).toEqual([true, true]);
  expect(webgpu(macos(), "win32", "x64")).toEqual([false, true]);
  expect(webgpu(macos(), "darwin", "x64")).toEqual([false, true]);
  // On an Intel Mac a macOS profile shows an Intel or AMD card, and stock Firefox there has no WebGPU.
  expect(webgpu(macos(graphicsIdentity("macos", 1)), "darwin", "x64")).toEqual([false, true]);
  expect(webgpu(macos(intelCard), "darwin", "x64")).toEqual([false, true]);
  // Windows always has navigator.gpu, and the app does not know the computer's card; Linux has none.
  for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"], [undefined, undefined]] as const) {
    expect(webgpu(profile(5), platform, arch)).toEqual([true, true]);
    expect(webgpu(profile(5, { "navigator.platform": "Linux x86_64" }), platform, arch)).toEqual([false, true]);
  }
});

test("a profile of another OS gets that OS's stock fonts and Windows colours; a profile of this computer's OS keeps its own", () => {
  const windows = profile(5);
  const macos = { ...profile(5, { "navigator.platform": "MacIntel" }), platformOs: "macos" as const };
  const linux = profile(5, { "navigator.platform": "Linux x86_64" });
  const crossOs = (prefs: Record<string, JsonValue>) => Object.keys(prefs).filter((key) => /^(font\.|ui\.)/.test(key));
  const onLinux = firefoxStartupPrefs(windows, "linux", "x64");
  expect(onLinux).toMatchObject({
    "font.name-list.serif.x-western": "Times New Roman", "font.name-list.sans-serif.x-western": "Arial",
    "font.name-list.monospace.x-western": "Consolas", "font.name-list.cursive.x-western": "Comic Sans MS",
    "font.name-list.fantasy.x-western": "Arial", "font.name-list.emoji": "Segoe UI Emoji, Twemoji Mozilla",
    "font.name-list.sans-serif.zh-CN": "Microsoft YaHei, SimHei, Noto Sans CJK SC, Noto Sans SC",
    "font.size.monospace.x-western": 13, "font.minimum-size.th": 10,
    "ui.highlight": "#0078d7", "ui.selecteditem": "#0078d7", "ui.accentcolor": "#0060df",
    "ui.-moz-dialog": "#ffffff", "ui.-moz-dialogtext": "#000000", "ui.-moz_menuhover": "#e0e0e6",
  });
  // Windows has no fantasy default but in x-western, where stock Firefox draws it in Arial.
  expect(crossOs(onLinux).filter((key) => key.startsWith("font.name-list.fantasy."))).toEqual(["font.name-list.fantasy.x-western"]);
  expect(firefoxStartupPrefs(windows, "darwin", "arm64")).toMatchObject({ "font.name-list.emoji": "Segoe UI Emoji, Twemoji Mozilla", "ui.highlight": "#0078d7" });
  const macOnWindows = firefoxStartupPrefs(macos, "win32", "x64");
  expect(macOnWindows).toMatchObject({
    "font.name-list.serif.x-western": "Times, Times New Roman", "font.name-list.sans-serif.x-western": "Helvetica, Arial",
    "font.name-list.monospace.x-western": "Menlo", "font.name-list.cursive.x-western": "Apple Chancery",
    "font.name-list.fantasy.x-western": "Papyrus", "font.name-list.emoji": "Apple Color Emoji",
  });
  // Stock macOS colours are not measured yet: a macOS profile keeps the computer's.
  expect(crossOs(macOnWindows).some((key) => key.startsWith("ui."))).toBe(false);
  for (const [persona, platform] of [[windows, "win32"], [macos, "darwin"], [linux, "linux"], [linux, undefined], [windows, undefined]] as const) {
    expect(crossOs(firefoxStartupPrefs(persona, platform, "x64"))).toEqual([]);
  }
});

test("a Linux profile on another computer gets Linux's stock fonts, GTK colours and overlay scrollbars", () => {
  const linux = { ...profile(5, { "navigator.platform": "Linux x86_64" }), platformOs: "linux" as const };
  const onWindows = firefoxStartupPrefs(linux, "win32", "x64");
  expect(onWindows).toMatchObject({
    // The font pack's metric-compatible families stand in for fontconfig's serif, sans-serif and monospace.
    "font.name-list.serif.x-western": "Tinos", "font.name-list.sans-serif.x-western": "Arimo",
    "font.name-list.monospace.x-western": "Cousine", "font.name-list.cursive.x-western": "Arimo",
    "font.name-list.fantasy.x-western": "Arimo", "font.name-list.emoji": "Noto Color Emoji, Twemoji Mozilla",
    "font.size.monospace.x-western": 12, "font.minimum-size.th": 13,
    "font.name-list.sans-serif.ja": "Noto Sans JP", "font.name-list.serif.zh-CN": "Noto Sans SC", "font.name-list.monospace.zh-HK": "Noto Sans TC",
    "ui.highlight": "#3584e4", "ui.selecteditem": "#3584e4", "ui.accentcolor": "#3584e4",
    "ui.-moz-dialog": "#fafafb", "ui.-moz-dialogtext": "#323237", "ui.-moz_menuhover": "#3584e4", "ui.-moz_menuhovertext": "#ffffff",
    "ui.-moz_menubarhovertext": "#000000", "ui.-moz-cellhighlight": "#e1e1e1", "ui.-moz_oddtreerow": "rgba(1, 0, 0, 0)",
    "ui.useOverlayScrollbars": 1,
  });
  // Every generic family names a font the Linux font pack holds.
  const pack = new Set(["Tinos", "Arimo", "Cousine", "Noto Sans JP", "Noto Sans KR", "Noto Sans SC", "Noto Sans TC"]);
  for (const [key, value] of Object.entries(onWindows)) if (/^font\.name-list\.(?!emoji)/.test(key)) expect(pack.has(String(value))).toBe(true);
  // No Windows font or colour is left in place of a Linux one.
  expect(Object.values(onWindows).some((value) => /Segoe|Times New Roman|Consolas|#0078d7/.test(String(value)))).toBe(false);
  expect(firefoxStartupPrefs(linux, "darwin", "arm64")).toMatchObject({ "font.name-list.emoji": "Noto Color Emoji, Twemoji Mozilla", "ui.useOverlayScrollbars": 1 });
});

test("a Firefox profile's processor count fits its graphics card class, at launch and when generated", () => {
  const card = (renderer: string) => ({ "webGl:vendor": "Google Inc. (NVIDIA)", "webGl:renderer": renderer });
  // On a 64-thread computer, so no count is capped to the computer's own.
  const threadsAt = (renderer: string, threads: number, seed = 5) =>
    firefoxLaunchConfig(profile(seed, { ...card(renderer), "navigator.hardwareConcurrency": threads }), undefined, undefined, undefined, undefined, undefined, 64)["navigator.hardwareConcurrency"];
  // Stock Firefox names every GeForce from the 900 series on as a GTX 980, so a 32-thread one is real.
  expect(threadsAt("ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar", 32)).toBe(32);
  expect(threadsAt("ANGLE (Intel, Intel(R) HD Graphics Direct3D11 vs_5_0 ps_5_0), or similar", 16)).toBe(16);
  // A Fermi or Kepler GeForce (GTX 480 class) came with 2 to 12 threads, a Tesla one with 2 or 4.
  for (let seed = 1; seed <= 30; seed++) {
    expect([2, 4, 8, 12]).toContain(threadsAt("ANGLE (NVIDIA, NVIDIA GeForce GTX 480 Direct3D11 vs_5_0 ps_5_0), or similar", 32, seed) as number);
    expect([2, 4]).toContain(threadsAt("ANGLE (NVIDIA, NVIDIA GeForce 8800 GTX Direct3D11 vs_4_0 ps_4_0)", 16, seed) as number);
    expect([4, 6, 8, 12, 16]).toContain(threadsAt("ANGLE (AMD, Radeon HD 3200 Graphics Direct3D11 vs_5_0 ps_5_0), or similar", 32, seed) as number);
  }
  // The stored count is kept, and a launch picks the same count each time.
  const old = profile(7, { ...card("ANGLE (NVIDIA, NVIDIA GeForce GTX 480 Direct3D11 vs_5_0 ps_5_0), or similar"), "navigator.hardwareConcurrency": 32 });
  expect(firefoxLaunchConfig(old)["navigator.hardwareConcurrency"]).toBe(firefoxLaunchConfig(structuredClone(old))["navigator.hardwareConcurrency"]!);
  expect(old.firefox!.config["navigator.hardwareConcurrency"]).toBe(32);
  // A computer with fewer threads than the count shows its own, as Chromium 155 does; the saved count stays.
  const big = profile(5, { ...card("ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar"), "navigator.hardwareConcurrency": 24 });
  expect(firefoxLaunchConfig(big, undefined, undefined, undefined, undefined, undefined, 8)["navigator.hardwareConcurrency"]).toBe(8);
  expect(firefoxLaunchConfig({ ...big, hardware: { cores: 16 } }, undefined, undefined, undefined, undefined, undefined, 12)["navigator.hardwareConcurrency"]).toBe(12);
  expect(firefoxLaunchConfig(big, undefined, undefined, undefined, undefined, undefined, 24)["navigator.hardwareConcurrency"]).toBe(24);
  expect(big.firefox!.config["navigator.hardwareConcurrency"]).toBe(24);
  // Generated profiles already have a fitting count, the one their launch shows.
  for (let seed = 1; seed <= 60; seed++) {
    const generated = createFirefoxProfileConfig(1920, 1080, "windows", seed).config;
    const launched = firefoxLaunchConfig({ ...profile(seed, generated), fingerprintSeed: seed }, undefined, undefined, undefined, undefined, undefined, 64);
    expect(launched["navigator.hardwareConcurrency"]).toBe(generated["navigator.hardwareConcurrency"]!);
    if (/GTX 480|8800 GTX|HD 3200|Intel\(R\) HD Graphics Direct/.test(String(generated["webGl:renderer"]))) {
      expect(Number(generated["navigator.hardwareConcurrency"])).toBeLessThanOrEqual(20);
    }
  }
});

test("a Firefox launch names the font pack folder of this computer only, never a saved one", () => {
  const saved = profile(5, { "aliasmode:fontsDir": "C:\\Users\\old\\fonts" });
  expect(firefoxLaunchConfig(saved)).not.toHaveProperty("aliasmode:fontsDir");
  expect(firefoxLaunchConfig(saved, undefined, "/data/runtimes/firefox-fonts/macos-1/fonts")["aliasmode:fontsDir"])
    .toBe("/data/runtimes/firefox-fonts/macos-1/fonts");
});

test("a Firefox profile saved for engine 152 moves to 156 like a browser update, everywhere it is completed", () => {
  const ua = (version: string) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${version}) Gecko/20100101 Firefox/${version}`;
  const legacy: Profile = {
    ...profile(9, { "navigator.userAgent": ua("152.0"), "headers.User-Agent": ua("152.0"), "navigator.appVersion": "5.0 (Windows)", fonts: ["Arial"] }, "152.0.4-beta.30"),
    ua: ua("152.0"), locale: "en-US", timezone: "UTC",
  };
  const current = completeProfileFingerprint(legacy);
  expect(current.firefox!.runtimeVersion).toBe("156.0.1-beta.36");
  expect(current.ua).toBe(ua("156.0"));
  expect(current.firefox!.config).toMatchObject({ "navigator.userAgent": ua("156.0"), "headers.User-Agent": ua("156.0") });
  // Nothing else of the identity changes.
  const unchanged = completeProfileFingerprint({ ...legacy, firefox: { ...legacy.firefox!, runtimeVersion: "156.0.1-beta.36" } });
  expect({ ...current.firefox!.config, "navigator.userAgent": "", "headers.User-Agent": "" })
    .toEqual({ ...unchanged.firefox!.config, "navigator.userAgent": "", "headers.User-Agent": "" });
  expect({ ...current, ua: "", firefox: undefined }).toEqual({ ...unchanged, ua: "", firefox: undefined });
  expect(completeProfileFingerprint(current)).toEqual(current);
  // Cloud and export payloads carry the same shape with the new runtime.
  const payload = encodePortableProfile(completeProfileFingerprint(legacy) as Profile & { engine: "firefox"; firefox: FirefoxProfileConfig });
  expect(payload.schemaVersion).toBe(2);
  expect(Object.keys(payload.profile.firefox).sort()).toEqual(["config", "runtimeVersion", "version"]);
  expect(payload.profile.firefox.runtimeVersion).toBe("156.0.1-beta.36");
  expect(decodePortableProfile(payload).profile.firefox).toEqual(current.firefox);
  // A profile from a newer engine is left for the launcher to refuse.
  const newer = { ...legacy, firefox: { ...legacy.firefox!, runtimeVersion: "157.0-beta.1" } };
  expect(completeProfileFingerprint(newer).firefox!.runtimeVersion).toBe("157.0-beta.1");
  expect(completeProfileFingerprint(newer).ua).toBe(ua("152.0"));
});

test("an existing Firefox window never exceeds its available screen", () => {
  // Stored before the fix: a full-screen window taller than the taskbar-free area, placed above the screen.
  const tall = firefoxLaunchConfig(profile(1, {
    "screen.availLeft": 1920, "window.screenX": 1912, "window.screenY": -46,
    "screen.width": 1920, "screen.height": 1080, "screen.availWidth": 1920, "screen.availHeight": 1032,
    "window.outerWidth": 1920, "window.outerHeight": 1080,
  }));
  expect(tall).toMatchObject({
    "screen.width": 1920, "screen.height": 1080, "screen.availHeight": 1032, "screen.availLeft": 0,
    "window.outerWidth": 1920, "window.outerHeight": 1032,
  });
  // The 156 engine shows pages the real window position, so the stored one is not sent.
  expect(tall).not.toHaveProperty("window.screenX");
  expect(tall).not.toHaveProperty("window.screenY");
  // A wide screen keeps its stored size and window.
  const wide = firefoxLaunchConfig(profile(2, {
    "window.screenX": 3307, "window.screenY": 180,
    "screen.width": 5120, "screen.height": 1440, "screen.availWidth": 5120, "screen.availHeight": 1400,
    "window.outerWidth": 1920, "window.outerHeight": 1080,
  }));
  expect(wide).toMatchObject({ "screen.width": 5120, "screen.height": 1440, "window.outerWidth": 1920, "window.outerHeight": 1080 });
});

test("a Firefox window on a second monitor stays on that monitor's available area", () => {
  const monitor = {
    "screen.width": 1920, "screen.height": 1080, "screen.availWidth": 1920, "screen.availHeight": 1040,
    "screen.availLeft": 2176, "screen.availTop": 40, "window.outerWidth": 1248, "window.outerHeight": 972,
  };
  const at = (screenX: number, screenY: number) => {
    const config: Record<string, JsonValue> = { ...monitor, "window.screenX": screenX, "window.screenY": screenY };
    fitFirefoxWindow(config);
    return [config["window.screenX"], config["window.screenY"]];
  };
  expect(at(2297, 60)).toEqual([2297, 60]);
  expect(at(3000, 200)).toEqual([2848, 108]);
  expect(at(100, 0)).toEqual([2176, 40]);
});

test("fitting a Firefox window keeps the browser frame between outer and inner sizes", () => {
  const config: Record<string, JsonValue> = {
    "screen.width": 1366, "screen.height": 768, "screen.availWidth": 1400, "screen.availHeight": 728,
    "window.outerWidth": 1400, "window.outerHeight": 800, "window.innerWidth": 1380, "window.innerHeight": 700,
  };
  fitFirefoxWindow(config);
  expect(config).toMatchObject({
    "screen.availWidth": 1366, "window.outerWidth": 1366, "window.innerWidth": 1346,
    "window.outerHeight": 728, "window.innerHeight": 628,
  });
});

test.each([
  // A 1366x768 laptop at 100% with a 40 px taskbar, 1920x1080 at 125% with a 48 px one, and a 1440x900 Mac with its Dock.
  ["1366x768 at 100%", { width: 1366, height: 728 }, [1366, 728], [1350, 622]],
  ["1920x1080 at 125%", { width: 1536, height: 816 }, [1536, 816], [1520, 710]],
  ["a 1440x900 Mac", { width: 1440, height: 801 }, [1440, 801], [1424, 695]],
] as const)("on %s a Firefox window opens inside the display and the larger screen stays as stored", (_display, hostAvail, outer, inner) => {
  const stored = profile(6, {
    "screen.width": 2560, "screen.height": 1440, "screen.availWidth": 2560, "screen.availHeight": 1392,
    "window.outerWidth": 1664, "window.outerHeight": 1296, "window.innerWidth": 1648, "window.innerHeight": 1190,
  });
  const saved = structuredClone(stored.firefox);
  const config = firefoxLaunchConfig(stored, undefined, undefined, undefined, undefined, hostAvail);
  expect(config).toMatchObject({
    "screen.width": 2560, "screen.height": 1440, "screen.availWidth": 2560, "screen.availHeight": 1392,
    "window.outerWidth": outer[0], "window.outerHeight": outer[1], "window.innerWidth": inner[0], "window.innerHeight": inner[1],
  });
  expect(stored.firefox).toEqual(saved);
  // A window that already fits the display keeps its size.
  const small = profile(7, { "screen.width": 1920, "screen.height": 1080, "window.outerWidth": 1200, "window.outerHeight": 700 });
  expect(firefoxLaunchConfig(small, undefined, undefined, undefined, undefined, { width: 1366, height: 728 }))
    .toMatchObject({ "window.outerWidth": 1200, "window.outerHeight": 700 });
});

test("a Firefox profile's new screen brings its usable area and a window inside it, keeping the browser frame", () => {
  const windows = profile(8, {
    "screen.width": 2560, "screen.height": 1440, "screen.availWidth": 2560, "screen.availHeight": 1392,
    "window.outerWidth": 1664, "window.outerHeight": 1296, "window.innerWidth": 1648, "window.innerHeight": 1190,
    "window.screenX": 448, "window.screenY": 72, "navigator.hardwareConcurrency": 8,
  });
  setFirefoxScreen(windows, 1536, 864);
  expect([windows.screenWidth, windows.screenHeight]).toEqual([1536, 864]);
  expect(windows.firefox!.config).toMatchObject({
    "screen.width": 1536, "screen.height": 864, "screen.availLeft": 0, "screen.availTop": 0, "screen.availWidth": 1536, "screen.availHeight": 816,
    "window.outerWidth": 998, "window.outerHeight": 778, "window.innerWidth": 982, "window.innerHeight": 672,
    "window.screenX": 448, "window.screenY": 38, "navigator.hardwareConcurrency": 8,
  });
  const mac = profile(9, {
    "navigator.platform": "MacIntel", "screen.width": 1920, "screen.height": 1080,
    "window.outerWidth": 1248, "window.outerHeight": 972, "window.innerWidth": 1248, "window.innerHeight": 880,
  });
  setFirefoxScreen(mac, 1440, 900);
  expect(mac.firefox!.config).toMatchObject({
    "screen.width": 1440, "screen.height": 900, "screen.availTop": 25, "screen.availWidth": 1440, "screen.availHeight": 824,
    "window.outerWidth": 936, "window.outerHeight": 810, "window.innerWidth": 936, "window.innerHeight": 718,
  });
});

test.each([
  ["windows", 1920, 1080], ["windows", 1536, 864], ["windows", 2560, 1440], ["macos", 1440, 900], ["linux", 1366, 768],
] as const)("a new %s Firefox profile uses the chosen %ix%i screen and a window inside it", (os, width, height) => {
  const config = createFirefoxProfileConfig(width, height, os, 99).config as Record<string, number>;
  expect([config["screen.width"], config["screen.height"]]).toEqual([width, height]);
  expect(config["screen.availWidth"]).toBeLessThanOrEqual(width);
  expect(config["screen.availHeight"]).toBeLessThanOrEqual(height);
  // Stock Firefox's baseline protection shows the whole screen on Linux, less a taskbar or menu bar elsewhere.
  expect(config["screen.availHeight"]! < height).toBe(os !== "linux");
  expect(config["window.outerWidth"]).toBeLessThanOrEqual(config["screen.availWidth"]!);
  expect(config["window.outerHeight"]).toBeLessThanOrEqual(config["screen.availHeight"]!);
  const left = config["screen.availLeft"] ?? 0;
  const top = config["screen.availTop"] ?? 0;
  expect(config["window.screenX"]).toBeGreaterThanOrEqual(left);
  expect(config["window.screenY"]).toBeGreaterThanOrEqual(top);
  expect(config["window.screenX"]! + config["window.outerWidth"]!).toBeLessThanOrEqual(left + config["screen.availWidth"]!);
  expect(config["window.screenY"]! + config["window.outerHeight"]!).toBeLessThanOrEqual(top + config["screen.availHeight"]!);
});

test("a new Firefox profile always keeps a taskbar, also where the generator drew none", () => {
  // Every drawn Windows 2560x1440 sample reported avail == screen before upstream's taskbar fix.
  for (let seed = 1; seed <= 6; seed++) {
    const config = createFirefoxProfileConfig(2560, 1440, "windows", seed).config as Record<string, number>;
    expect(config["screen.availWidth"]! < 2560 || config["screen.availHeight"]! < 1440).toBe(true);
    expect(config["window.outerHeight"]).toBeLessThanOrEqual(config["screen.availHeight"]!);
  }
});

test("a Firefox launch shows its own subset of the stock font list, the same on every launch", () => {
  const stocked = (seed: number, platform: string) => completeProfileFingerprint(profile(seed, { "navigator.platform": platform }));
  const core: Record<string, string[]> = {
    Win32: ["Arial", "Times New Roman", "Segoe UI", "Calibri", "Tahoma", "Verdana", "Courier New", "Microsoft YaHei", "SimSun",
      "Segoe Fluent Icons", "Ink Free", "Bahnschrift", "Gadugi", "Myanmar Text", "Javanese Text", "HoloLens MDL2 Assets"],
    MacIntel: ["Helvetica", "Helvetica Neue", "Geneva", "Luminari", "Galvji", "STIX Two Math", "Noto Sans Gunjala Gondi", "Noto Serif Yezidi"],
    "Linux x86_64": ["Arimo", "Tinos", "Cousine", "Noto Sans SC", "Noto Serif Yezidi", "Twemoji Mozilla"],
  };
  for (const [platform, kept] of Object.entries(core)) {
    if (platform === "Win32") continue;
    const stock = stocked(1, platform).firefox!.config.fonts as string[];
    const lists = Array.from({ length: 12 }, (_, i) => firefoxLaunchConfig(stocked(i + 1, platform)).fonts as string[]);
    expect(new Set(lists.map((list) => list.join("|"))).size).toBeGreaterThan(3);
    expect(lists.some((list) => list.length < stock.length)).toBe(true);
    for (const list of lists) {
      for (const font of kept) expect(list).toContain(font);
      expect(list.every((font) => stock.includes(font))).toBe(true);
    }
    expect(firefoxLaunchConfig(stocked(1, platform)).fonts).toEqual(lists[0]!);
  }
  // Every Windows profile shows the whole stock list, on Windows with the named styles of Sitka:
  // Pixelscan treats the handwriting, supplemental, historic and CJK Extension B families as core fonts.
  const windowsStock = stocked(1, "Win32").firefox!.config.fonts as string[];
  const sitka = ["Sitka Small", "Sitka Text", "Sitka Subheading", "Sitka Heading", "Sitka Display", "Sitka Banner"];
  for (let seed = 1; seed <= 40; seed++) {
    const list = firefoxLaunchConfig(stocked(seed, "Win32")).fonts as string[];
    expect(new Set(list)).toEqual(new Set([...windowsStock, ...sitka]));
    // With the font pack on another OS only Sitka Text of SitkaVF loads.
    expect(firefoxLaunchConfig(stocked(seed, "Win32"), undefined, "/data/runtimes/firefox-fonts/windows-1/fonts").fonts).toEqual(windowsStock);
    for (const font of [...core.Win32!, "Gabriola", "Segoe Print", "Microsoft Himalaya", "Mongolian Baiti", "Ebrima", "Segoe UI Historic", "Sylfaen", "SimSun-ExtB", "MingLiU-ExtB"]) {
      expect(list).toContain(font);
    }
  }
  // A Linux profile on another computer also shows what fontconfig's metric aliases answer on Linux.
  const linuxStock = stocked(1, "Linux x86_64").firefox!.config.fonts as string[];
  const aliased = ["Arial", "Courier New", "Times New Roman"];
  for (let seed = 1; seed <= 12; seed++) {
    const own = firefoxLaunchConfig(stocked(seed, "Linux x86_64")).fonts as string[];
    const other = firefoxLaunchConfig(stocked(seed, "Linux x86_64"), undefined, "/data/runtimes/firefox-fonts/linux-1/fonts").fonts as string[];
    expect(other).toEqual([...own, ...aliased]);
    expect(own.some((font) => aliased.includes(font))).toBe(false);
    expect(other.every((font) => linuxStock.includes(font) || aliased.includes(font))).toBe(true);
  }
  // The stored list is unchanged, and a list the user changed is shown as stored.
  const one = stocked(5, "Win32");
  const saved = structuredClone(one.firefox!.config.fonts);
  firefoxLaunchConfig(one);
  expect(one.firefox!.config.fonts).toEqual(saved);
  expect(firefoxLaunchConfig(profile(5, { fonts: ["Arial", "Gabriola"] })).fonts).toEqual(["Arial", "Gabriola"]);
});

test("most Windows Firefox profiles list voices beyond the stock set, macOS profiles a stock set, each the same on every launch", () => {
  const lists = (platform: string) => Array.from({ length: 200 }, (_, i) => firefoxLaunchConfig(profile(i + 1, { "navigator.platform": platform })).voices as Array<{ voiceUri: string }>);
  const windows = lists("Win32");
  const share = windows.filter((list) => list.length > Math.min(...windows.map((other) => other.length))).length / windows.length;
  expect(share).toBeGreaterThan(0.5);
  expect(share).toBeLessThan(0.75);
  // No downloaded MacinTalk voice: macOS 26 does not offer Bruce or Vicki.
  for (const list of lists("MacIntel")) {
    expect(list.some((voice) => /speech\.synthesis\.voice\.(Agnes|Alex|Bruce|Vicki)$/.test(voice.voiceUri))).toBe(false);
  }
  expect(firefoxLaunchConfig(profile(9)).voices).toEqual(firefoxLaunchConfig(profile(9)).voices!);
});

test("a macOS profile on another computer lists only the Hiragino faces its font pack holds", () => {
  const stockMac = ["Helvetica", "Hiragino Sans", "Hiragino Mincho ProN W3", "ヒラギノ角ゴシック W3", ".Hiragino Kaku Gothic Interface",
    "Hiragino Sans GB", "Hiragino Sans GB W3", "ヒラギノ角ゴ 簡体中文", "冬青黑体简体中文"];
  const mac = { ...profile(5, { "navigator.platform": "MacIntel", fonts: stockMac }), platformOs: "macos" as const };
  expect(firefoxLaunchConfig(mac, undefined, "/runtimes/firefox-fonts/macos").fonts)
    .toEqual(["Helvetica", "Hiragino Sans GB", "Hiragino Sans GB W3", "ヒラギノ角ゴ 簡体中文", "冬青黑体简体中文"]);
  // On a Mac the profile uses the Mac's own fonts, so the list stays.
  expect(firefoxLaunchConfig(mac).fonts).toEqual(stockMac);
});

test("a macOS profile shows Apple graphics only, with the texture limits stock Firefox reports on a Mac", () => {
  for (let seed = 1; seed <= 500; seed++) {
    const keys = graphicsIdentity("macos", seed);
    expect(keys).toMatchObject({ "webGl:vendor": "Apple", "webGl:renderer": "Apple M1, or similar" });
    // GLContext.cpp limits textures and renderbuffers to 8192 on every Mac; the viewport stays 16384.
    for (const block of ["webGl:parameters", "webGl2:parameters"]) {
      expect(keys[block]).toMatchObject({ 3379: 8192, 34024: 8192, 34076: 8192, 3386: [16384, 16384] });
    }
  }
  // A macOS profile stored with an Intel Mac's or a Windows Direct3D card opens with Apple's; the stored one stays.
  const apple = graphicsIdentity("macos", 1);
  const intel = { "webGl:vendor": "Intel Inc.", "webGl:renderer": "Intel(R) HD Graphics 400, or similar", "webGl:parameters": { 3379: 16384 } };
  for (const card of [graphicsIdentity("windows", 7), intel]) {
    const stored = profile(8, { "navigator.platform": "MacIntel", ...card });
    const saved = structuredClone(stored.firefox);
    expect(firefoxLaunchConfig(stored)).toMatchObject(apple);
    expect(firefoxGraphicsRenderer(stored)).toBe("Apple M1, or similar");
    expect(stored.firefox).toEqual(saved);
  }
  // A Windows profile keeps its card, and a profile without a stored card gets none.
  const windows = profile(8, graphicsIdentity("windows", 7));
  expect(firefoxLaunchConfig(windows)).toMatchObject(graphicsIdentity("windows", 7));
  expect(firefoxGraphicsRenderer(windows)).toBe(graphicsIdentity("windows", 7)["webGl:renderer"]!);
  expect(firefoxLaunchConfig(profile(8, { "navigator.platform": "MacIntel" }))).not.toHaveProperty("webGl:vendor");
  expect(firefoxGraphicsRenderer(profile(8, { "navigator.platform": "MacIntel" }))).toBeUndefined();
});

test("on an Intel Mac a macOS profile shows an Intel or AMD Mac card of that Mac's GPU vendor", () => {
  const apple = graphicsIdentity("macos", 1);
  const vendors = new Set<unknown>();
  for (let seed = 1; seed <= 200; seed++) {
    const stored = profile(seed, { "navigator.platform": "MacIntel", ...apple });
    const saved = structuredClone(stored.firefox);
    const any = firefoxLaunchConfig(stored, undefined, undefined, undefined, {});
    vendors.add(any["webGl:vendor"]);
    expect(String(any["webGl:renderer"])).toMatch(/^(Intel\(R\) HD Graphics|Radeon R9 200 Series)/);
    expect(firefoxLaunchConfig(stored, undefined, undefined, undefined, { vendor: "intel" })["webGl:vendor"]).toBe("Intel Inc.");
    expect(firefoxLaunchConfig(stored, undefined, undefined, undefined, { vendor: "amd" })).toMatchObject({
      "webGl:vendor": "ATI Technologies Inc.", "webGl:parameters": { 3379: 8192 },
    });
    expect(stored.firefox).toEqual(saved);
  }
  expect(vendors).toEqual(new Set(["Intel Inc.", "ATI Technologies Inc."]));
  // The processor count fits the card's class of Intel Mac; a fitting stored count stays.
  for (let seed = 1; seed <= 50; seed++) {
    for (const cores of [8, 14]) {
      const stored = profile(seed, { "navigator.platform": "MacIntel", ...apple, "navigator.hardwareConcurrency": cores });
      const intel = firefoxLaunchConfig(stored, undefined, undefined, undefined, { vendor: "intel" }, undefined, 64)["navigator.hardwareConcurrency"];
      const amd = firefoxLaunchConfig(stored, undefined, undefined, undefined, { vendor: "amd" }, undefined, 64)["navigator.hardwareConcurrency"];
      expect([4, 8]).toContain(intel as number);
      expect([8, 12, 16]).toContain(amd as number);
      if (cores === 8) expect([intel, amd]).toEqual([8, 8]);
      expect(firefoxLaunchConfig(stored, undefined, undefined, undefined, undefined, undefined, 64)["navigator.hardwareConcurrency"]).toBe(cores);
    }
  }
  // A card of the Mac's vendor stays; a Windows profile keeps its own card.
  const radeon = firefoxLaunchConfig(profile(3, { "navigator.platform": "MacIntel", ...apple }), undefined, undefined, undefined, { vendor: "amd" });
  const kept = profile(4, { "navigator.platform": "MacIntel", ...Object.fromEntries(Object.entries(radeon).filter(([key]) => /^webGl2?:/.test(key))) });
  expect(firefoxLaunchConfig(kept, undefined, undefined, undefined, { vendor: "amd" })).toMatchObject({ "webGl:renderer": radeon["webGl:renderer"] });
  expect(firefoxGraphicsRenderer(profile(3, { "navigator.platform": "MacIntel", ...apple }), { vendor: "amd" })).toBe(radeon["webGl:renderer"]);
  expect(firefoxLaunchConfig(profile(8, graphicsIdentity("windows", 7)), undefined, undefined, undefined, {})).toMatchObject(graphicsIdentity("windows", 7));
});

test("the Intel Mac GPU vendor comes from system_profiler, Intel first on a Mac with both", () => {
  const report = (...cards: object[]) => JSON.stringify({ SPDisplaysDataType: cards });
  expect(intelMacGraphicsVendor(report({ _name: "Intel Iris Plus Graphics", spdisplays_vendor: "sppci_vendor_intel" }))).toBe("intel");
  expect(intelMacGraphicsVendor(report({ _name: "Radeon Pro 5500M", spdisplays_vendor: "sppci_vendor_amd" }))).toBe("amd");
  expect(intelMacGraphicsVendor(report(
    { _name: "AMD Radeon Pro 5500M", sppci_vendor: "AMD (0x1002)" }, { _name: "Intel UHD Graphics 630", sppci_vendor: "Intel" },
  ))).toBe("intel");
  expect(intelMacGraphicsVendor(report({ _name: "Display", sppci_model: "VMware SVGA II" }))).toBeUndefined();
  expect(intelMacGraphicsVendor("not json")).toBeUndefined();
});

/** The usable area stock Firefox 156 reports with its baseline protection (GetSpoofedScreenAvailSize). */
const baseline = { windows: [0, 48], macos: [25, 76], linux: [0, 0] } as const;

test.each([
  ["windows", 1920, 1080], ["windows", 1536, 864], ["macos", 1440, 900], ["macos", 1512, 982], ["linux", 1366, 768],
] as const)("new %s profiles at %ix%i show stock Firefox's usable area and no touch points", (os, width, height) => {
  // Each draw is a new generator sample; most Windows ones put the area beside the screen or have touch points.
  for (let seed = 1; seed <= 25; seed++) {
    const config = createFirefoxProfileConfig(width, height, os, seed).config as Record<string, number>;
    const [top, less] = baseline[os];
    expect(config).toMatchObject({
      "screen.availLeft": 0, "screen.availTop": top, "screen.availWidth": width, "screen.availHeight": height - less, "navigator.maxTouchPoints": 0,
    });
    // The window stays on its screen.
    expect(config["window.screenX"]! + config["window.outerWidth"]!).toBeLessThanOrEqual(width);
    expect(config["window.screenY"]).toBeGreaterThanOrEqual(top);
    expect(config["window.screenY"]! + config["window.outerHeight"]!).toBeLessThanOrEqual(height);
  }
});

test("an existing profile opens with stock Firefox's usable area and no touch points, its stored values unchanged", () => {
  const windows = profile(3, {
    "screen.width": 1920, "screen.height": 1080, "screen.availWidth": 1920, "screen.availHeight": 1040,
    "screen.availLeft": 1920, "screen.availTop": 40, "navigator.maxTouchPoints": 2,
    "window.outerWidth": 1248, "window.outerHeight": 1040,
  });
  const saved = structuredClone(windows.firefox);
  expect(firefoxLaunchConfig(windows)).toMatchObject({
    "screen.availLeft": 0, "screen.availTop": 0, "screen.availWidth": 1920, "screen.availHeight": 1032, "navigator.maxTouchPoints": 0,
    "window.outerHeight": 1032,
  });
  expect(windows.firefox).toEqual(saved);
  // Whatever a macOS profile stored, it opens with the menu bar and dock stock Firefox reports.
  const mac = (config: Record<string, JsonValue>) => firefoxLaunchConfig(profile(4, {
    "navigator.platform": "MacIntel", "screen.width": 1440, "screen.height": 900, "screen.availWidth": 1440, ...config,
  }));
  const storedAreas: Array<Record<string, JsonValue>> = [
    { "screen.availHeight": 744 }, { "screen.availWidth": 1380, "screen.availHeight": 900 }, { "screen.availTop": 33, "screen.availHeight": 860 },
  ];
  for (const stored of storedAreas) {
    expect(mac(stored)).toMatchObject({ "screen.availLeft": 0, "screen.availTop": 25, "screen.availWidth": 1440, "screen.availHeight": 824 });
  }
  const linux = firefoxLaunchConfig(profile(5, { "navigator.platform": "Linux x86_64", "screen.width": 1366, "screen.height": 768, "screen.availHeight": 741 }));
  expect(linux).toMatchObject({ "screen.availTop": 0, "screen.availHeight": 768 });
});

test("a macOS profile lists one macOS version's stock voices in stock order, and the system voice of its locale is the default", () => {
  const voices = (locale: string, seed: number, platform = "MacIntel") => firefoxLaunchConfig({ ...profile(seed, { "navigator.platform": platform }), locale })
    .voices as Array<{ name: string; lang: string; voiceUri: string; isDefault: boolean; isLocalService: boolean }>;
  const defaults = (locale: string, seed: number, platform = "MacIntel") =>
    voices(locale, seed, platform).filter((voice) => voice.isDefault).map((voice) => `${voice.name} ${voice.lang}`);
  const entry = (voice: { name: string; lang: string; voiceUri: string }) => `${voice.name}|${voice.lang}|${voice.voiceUri}`;
  const stock = (macos: string) => macVoiceLists.find((list) => list.macos === macos)!.voices
    .map(([name, lang, id]) => `${name}|${lang}|urn:moz-tts:osx:${id}`);
  // Stock Firefox 156.0.1 on macOS 15.7.9 (Apple Silicon and Intel) and on 14.8.9, by AVSpeechSynthesisVoice order.
  expect(stock("15.7.9")).toHaveLength(64);
  expect(stock("15.7.9").slice(0, 8)).toEqual([
    "Majed|ar-001|urn:moz-tts:osx:com.apple.voice.compact.ar-001.Maged", "Daria|bg-BG|urn:moz-tts:osx:com.apple.voice.compact.bg-BG.Daria",
    "Montse|ca-ES|urn:moz-tts:osx:com.apple.voice.compact.ca-ES.Montserrat", "Zuzana|cs-CZ|urn:moz-tts:osx:com.apple.voice.compact.cs-CZ.Zuzana",
    "Sara|da-DK|urn:moz-tts:osx:com.apple.voice.compact.da-DK.Sara", "Helena|de-DE|urn:moz-tts:osx:com.apple.ttsbundle.siri_helena_de-DE_compact",
    "Anna|de-DE|urn:moz-tts:osx:com.apple.voice.compact.de-DE.Anna", "Martin|de-DE|urn:moz-tts:osx:com.apple.ttsbundle.siri_martin_de-DE_compact",
  ]);
  expect(stock("14.8.9")).toHaveLength(62);
  expect(stock("14.8.9")[5]).toBe("Helena|de-DE|urn:moz-tts:osx:com.apple.ttsbundle.siri_Helena_de-DE_compact");
  // macOS 26.6 orders its 53 voices by the system language: these are the en-US and de-DE captures.
  const mac26 = {
    "en-US": ["Samantha", "Fred", "Junior", "Kathy", "Ralph", "Daniel", "Karen", "Moira", "Rishi", "Tessa", "Alice", "Alva", "Amélie",
      "Amira", "Anna", "Carmit", "Damayanti", "Daria", "Ellen", "Ioana", "Joana", "Kanya", "Kyoko", "Lana", "Laura", "Lekha", "Lesya", "Linh",
      "Luciana", "Majed", "Tünde", "Meijia", "Melina", "Milena", "Mónica", "Montse", "Nora", "Paulina", "Sara", "Satu", "Sinji", "Thomas",
      "Tina", "Tingting", "Xander", "Yelda", "Yuna", "Zosia", "Zuzana", "Vani", "Soumya", "Geeta", "Piya"],
    "de-DE": ["Anna", "Alice", "Alva", "Amélie", "Amira", "Carmit", "Damayanti", "Daniel", "Daria", "Ellen", "Ioana", "Joana", "Kanya",
      "Karen", "Kyoko", "Lana", "Laura", "Lekha", "Lesya", "Linh", "Luciana", "Majed", "Tünde", "Meijia", "Melina", "Milena", "Moira",
      "Mónica", "Montse", "Nora", "Paulina", "Rishi", "Samantha", "Sara", "Satu", "Sinji", "Tessa", "Thomas", "Tina", "Tingting", "Xander",
      "Yelda", "Yuna", "Zosia", "Zuzana", "Vani", "Soumya", "Fred", "Geeta", "Junior", "Kathy", "Piya", "Ralph"],
  };
  expect(stock("26.6.2")).toHaveLength(53);
  expect(stock("26.6.2")).toContain("Samantha|en-US|urn:moz-tts:osx:com.apple.voice.super-compact.en-US.Samantha");
  const downloaded = (voice: { voiceUri: string }) => /speech\.synthesis\.voice\.(Agnes|Alex|Bruce|Vicki)$/.test(voice.voiceUri);
  const versions = new Set<string>();
  for (let seed = 1; seed <= 100; seed++) {
    const list = voices("en-US", seed);
    // Without its downloaded extras, the list is one version's stock list in stock order, the same on every launch.
    const base = { "en-US": list, "de-DE": voices("de-DE", seed) };
    const [english, german] = (["en-US", "de-DE"] as const).map((locale) => base[locale].filter((voice) => !downloaded(voice)));
    const version = ["15.7.9", "14.8.9"].find((macos) => JSON.stringify(stock(macos)) === JSON.stringify(english!.map(entry)))
      ?? (english!.map(entry).sort().join() === [...stock("26.6.2")].sort().join() ? "26.6.2" : undefined);
    expect(version).toBeDefined();
    versions.add(version!);
    if (version === "26.6.2") {
      expect(english!.map((voice) => voice.name)).toEqual(mac26["en-US"]);
      expect(german!.map((voice) => voice.name)).toEqual(mac26["de-DE"]);
      // Other locales are assumed to follow the same rule: Thomas, then the other French voice.
      expect(voices("fr-FR", seed).slice(0, 2).map((voice) => voice.name)).toEqual(["Thomas", "Amélie"]);
    } else {
      // Before macOS 26 the system language changes only the default.
      expect(german!.map(entry)).toEqual(english!.map(entry));
    }
    expect(voices("en-US", seed)).toEqual(list);
    expect(list.every((voice) => voice.isLocalService)).toBe(true);
    // A downloaded voice joins its language.
    for (const locale of ["en-US", "de-DE"] as const) {
      base[locale].forEach((voice, at) => { if (downloaded(voice)) expect(base[locale][at - 1]!.lang).toBe("en-US"); });
    }
    expect(defaults("en-US", seed)).toEqual(["Samantha en-US"]);
    expect(defaults("de-DE", seed)).toEqual(["Anna de-DE"]);
    expect(defaults("en-GB", seed)).toEqual(["Daniel en-GB"]);
    expect(defaults("en-US", seed, "Win32")).toEqual([]);
  }
  expect([...versions].sort()).toEqual(["14.8.9", "15.7.9", "26.6.2"]);
  for (const [locale, voice] of [
    ["fr-CA", "Amélie fr-CA"], ["en-CA", "Samantha en-US"], ["es-AR", "Mónica es-ES"], ["de-AT", "Anna de-DE"],
    ["zh-Hant-TW", "Meijia zh-TW"], ["ar-SA", "Majed ar-001"], ["ja-JP", "Kyoko ja-JP"],
  ] as const) {
    expect(defaults(locale, 1)).toEqual([voice]);
  }
  // macOS has no Lithuanian voice, so it gives none for that language.
  expect(defaults("lt-LT", 1)).toEqual([]);
});
