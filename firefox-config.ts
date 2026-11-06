// @ts-expect-error Bun embeds this package data in compiled sidecars.
import fingerprintNetworkDefinitionPath from "./node_modules/fingerprint-generator/data_files/fingerprint-network-definition.zip" with { type: "file" };
// @ts-expect-error Bun embeds this package data in compiled sidecars.
import inputNetworkDefinitionPath from "./node_modules/header-generator/data_files/input-network-definition.zip" with { type: "file" };
// @ts-expect-error Bun embeds this package data in compiled sidecars.
import headerNetworkDefinitionPath from "./node_modules/header-generator/data_files/header-network-definition.zip" with { type: "file" };
// @ts-expect-error Bun embeds this package data in compiled sidecars.
import webglDataPath from "./node_modules/camoufox-js/dist/data-files/webgl_data.db" with { type: "file" };
import { Database } from "bun:sqlite";
import { isIP } from "node:net";
import { availableParallelism } from "node:os";
import type { ChromiumRuntime, FirefoxProfileConfig, JsonValue, Profile, ProfileEngine } from "./types.ts";
import fonts from "camoufox-js/dist/mappings/fonts.config.js";
import { deterministicSeed, launchWindowSize, platformFromUA, seedFraction } from "./fingerprint.ts";
import { localeForTimezone, normalizeProfileLocale } from "./profile-locale.ts";
import { firefoxMediaDevices, firefoxVoices, type PersonaOs } from "./firefox-media.ts";

const generatorAssetInputs = [
  ["fingerprint-network-definition.zip", fingerprintNetworkDefinitionPath],
  ["input-network-definition.zip", inputNetworkDefinitionPath],
  ["header-network-definition.zip", headerNetworkDefinitionPath],
] as const;
const generatorAssets = Object.fromEntries(await Promise.all(generatorAssetInputs.map(async ([name, source]) => {
  return [name, Buffer.from(await Bun.file(source).arrayBuffer())] as const;
})));
(globalThis as typeof globalThis & { __aliasmodeGeneratorAssets?: Record<string, Buffer> }).__aliasmodeGeneratorAssets = generatorAssets;
const { fromBrowserforge, generateFingerprint } = await import("camoufox-js/dist/fingerprints.js");

interface GraphicsIdentity {
  weight: number;
  keys: Record<string, JsonValue>;
}

export type MacGraphicsVendor = "intel" | "amd";
const INTEL_MAC_VENDORS: Record<MacGraphicsVendor, string> = { intel: "Intel Inc.", amd: "ATI Technologies Inc." };
/**
 * Logical processors of Intel Macs per card class: Intel graphics only (MacBook Air, 13-inch
 * MacBook Pro, Mac mini) or an AMD card (15- and 16-inch MacBook Pro, 27-inch iMac).
 */
const INTEL_MAC_THREADS: Record<MacGraphicsVendor, number[]> = { intel: [4, 8], amd: [8, 12, 16] };

/**
 * Logical processors of computers per graphics class that stock Firefox reports. Its
 * SanitizeRenderer.cpp names a range of cards by one model: "GeForce GTX 980" is every GeForce from
 * the 900 series to today's RTX cards, "Radeon R9 200 Series" every newer Radeon, "Intel(R) HD
 * Graphics 400" Intel's UHD and numbered HD graphics since 2015, "Intel(R) HD Graphics" Iris Xe and
 * HD 2000 to 4600, "Radeon HD 3200 Graphics" Radeon graphics without a model number (most Ryzen
 * laptops). The older classes come with the processors of their years.
 */
const GRAPHICS_THREADS: Array<[RegExp, number[]]> = [
  [/GeForce GTX 980|Radeon R9 200|HD Graphics 400|Arc\(TM\)/, [4, 6, 8, 12, 16, 20, 24, 32]],
  [/Intel\(R\) HD Graphics/, [4, 8, 12, 16, 20]],
  [/Radeon HD 3200/, [4, 6, 8, 12, 16]],
  [/GeForce GTX 480|Radeon HD 5850/, [2, 4, 8, 12]],
  [/GeForce 8800 GTX|Intel 945GM/, [2, 4]],
];

/**
 * Keep the processor count to one a computer with the profile's graphics card has. A macOS profile
 * on an Intel Mac reports a count of its card's class of Mac; one with Apple graphics keeps its own.
 */
function fitThreads(config: Record<string, JsonValue>, os: PersonaOs, intelMac: boolean, fraction: (key: string) => number): void {
  if (!storesGraphics(config)) return;
  const threads = os === "macos"
    ? intelMac ? INTEL_MAC_THREADS[config["webGl:vendor"] === INTEL_MAC_VENDORS.amd ? "amd" : "intel"] : undefined
    : GRAPHICS_THREADS.find(([pattern]) => pattern.test(String(config["webGl:renderer"])))?.[1];
  if (threads && !threads.includes(Number(config["navigator.hardwareConcurrency"]))) {
    config["navigator.hardwareConcurrency"] = threads[Math.floor(fraction(os === "macos" ? "intelMac:threads" : "threads") * threads.length)]!;
  }
}

/**
 * Real graphics identities per system from the engine's data set, weighted by how
 * common they are. Each has the vendor, the renderer and the matching WebGL limits.
 * Software renderers are left out: they are no device identity. On macOS only Apple's:
 * stock Firefox names every Apple Silicon GPU "Apple M1, or similar" (SanitizeRenderer.cpp),
 * and the set's Intel, AMD and Direct3D rows are no current Mac. Its 8192 texture limits are
 * the ones stock Firefox reports and enforces on every Mac (GLContext.cpp, bug 1544446).
 * An Intel Mac shows its own Intel or AMD card instead (intelMac).
 */
const graphicsIdentities = await (async (): Promise<Record<PersonaOs | "intelMac", GraphicsIdentity[]>> => {
  const database = Database.deserialize(new Uint8Array(await Bun.file(webglDataPath).arrayBuffer()));
  const rows = database
    .prepare("SELECT renderer, data, win, mac, lin FROM webgl_fingerprints ORDER BY vendor, renderer, data")
    .all() as Array<{ renderer: string; data: string; win: number; mac: number; lin: number }>;
  database.close();
  const forSystem = (column: "win" | "mac" | "lin", accept = (_keys: Record<string, JsonValue>) => true) => rows.flatMap((row) => {
    const { webGl2Enabled, ...keys } = JSON.parse(row.data) as Record<string, JsonValue>;
    return row[column] > 0 && webGl2Enabled === true && !/SwiftShader|Basic Render/i.test(row.renderer) && accept(keys)
      ? [{ weight: row[column], keys }]
      : [];
  });
  return {
    windows: forSystem("win"),
    macos: forSystem("mac", isAppleGraphics),
    linux: forSystem("lin"),
    intelMac: forSystem("mac", (keys) => isIntelMacGraphics(keys)),
  };
})();

/** Choose the graphics identity of a profile. The same seed always gives the same one. */
export function graphicsIdentity(platformOs: PersonaOs, seed: number): Record<string, JsonValue> {
  return pickGraphics(graphicsIdentities[platformOs], seed);
}

/** The card of a macOS profile on an Intel Mac: one of that Mac's GPU vendor when it is known. */
function intelMacGraphicsIdentity(seed: number, vendor?: MacGraphicsVendor): Record<string, JsonValue> {
  const options = graphicsIdentities.intelMac.filter((option) => isIntelMacGraphics(option.keys, vendor));
  return pickGraphics(options.length ? options : graphicsIdentities.intelMac, seed);
}

function pickGraphics(options: GraphicsIdentity[], seed: number): Record<string, JsonValue> {
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let remaining = seedFraction(seed) * total;
  for (const option of options) {
    remaining -= option.weight;
    if (remaining < 0) return structuredClone(option.keys);
  }
  return structuredClone(options.at(-1)!.keys);
}

function isAppleGraphics(config: Record<string, JsonValue>): boolean {
  return config["webGl:vendor"] === "Apple" && String(config["webGl:renderer"]).startsWith("Apple");
}

const storesGraphics = (config: Record<string, JsonValue>) => config["webGl:vendor"] !== undefined || config["webGl:renderer"] !== undefined;

/**
 * The card for a macOS profile saved with another kind (a Windows Direct3D one, say): Apple's,
 * and on an Intel Mac an Intel or AMD one of that Mac's vendor, because pages draw on the real GPU.
 */
function replacedGraphics(
  profile: Profile, config: Record<string, JsonValue>, intelMac?: { vendor?: MacGraphicsVendor },
): Record<string, JsonValue> | undefined {
  if (!storesGraphics(config) || firefoxPersonaOs(profile, config) !== "macos") return undefined;
  if (intelMac) {
    return isIntelMacGraphics(config, intelMac.vendor) ? undefined : intelMacGraphicsIdentity(profile.fingerprintSeed, intelMac.vendor);
  }
  return isAppleGraphics(config) ? undefined : graphicsIdentity("macos", profile.fingerprintSeed);
}

/** The graphics card a launch of this profile shows, when the profile stores one (firefoxLaunchConfig). */
export function firefoxGraphicsRenderer(profile: Profile, intelMac?: { vendor?: MacGraphicsVendor }): JsonValue | undefined {
  const config = profile.firefox?.config ?? {};
  return (replacedGraphics(profile, config, intelMac) ?? config)["webGl:renderer"];
}

function isIntelMacGraphics(config: Record<string, JsonValue>, vendor?: MacGraphicsVendor): boolean {
  const vendors = vendor ? [INTEL_MAC_VENDORS[vendor]] : Object.values(INTEL_MAC_VENDORS);
  return vendors.includes(String(config["webGl:vendor"]));
}

/**
 * The GPU vendor of an Intel Mac, from `system_profiler SPDisplaysDataType -json`. A Mac with
 * both draws WebGL on its integrated Intel GPU unless a page asks for high performance.
 */
export function intelMacGraphicsVendor(report: string): MacGraphicsVendor | undefined {
  let cards: unknown;
  try {
    cards = (JSON.parse(report) as { SPDisplaysDataType?: unknown }).SPDisplaysDataType;
  } catch {
    return undefined;
  }
  if (!Array.isArray(cards)) return undefined;
  const names = cards.map((card) => ["spdisplays_vendor", "sppci_vendor", "sppci_model", "_name"]
    .map((key) => String(card?.[key] ?? "")).join(" ").toLowerCase());
  if (names.some((name) => name.includes("intel"))) return "intel";
  if (names.some((name) => /amd|radeon|vendor_ati|\bati\b/.test(name))) return "amd";
  return undefined;
}

export const FIREFOX_RUNTIME_VERSION = "156.0.1-beta.36";
const FIREFOX_UA_MAJOR_VERSION = "156";

/**
 * Generate an OS-matched identity once, for durable profile storage. With a seed the
 * identity also has its own graphics card, so the profile shows the same hardware on
 * every computer instead of the graphics card of the computer that opens it.
 */
export function createFirefoxProfileConfig(
  screenWidth: number,
  screenHeight: number,
  platformOs: PersonaOs = "windows",
  seed?: number,
): FirefoxProfileConfig {
  // The chosen size is the screen. The window opens at the app's usual fraction of it.
  const windowSize = launchWindowSize(screenWidth, screenHeight);
  const options = { browsers: ["firefox" as const], operatingSystems: [platformOs] };
  let fingerprint;
  try {
    fingerprint = generateFingerprint(windowSize, {
      ...options,
      screen: { minWidth: screenWidth, maxWidth: screenWidth, minHeight: screenHeight, maxHeight: screenHeight },
    });
  } catch {
    // No Firefox sample has this screen size. The size is set below instead.
    fingerprint = generateFingerprint(windowSize, options);
  }
  const config = fromBrowserforge(fingerprint, FIREFOX_UA_MAJOR_VERSION);
  // The generator can also drop a screen it cannot match: the chosen size is the screen.
  config["screen.width"] = screenWidth;
  config["screen.height"] = screenHeight;
  fitDesktopPersona(config, platformOs);
  fitFirefoxWindow(config);
  if (typeof config.timezone !== "string" || !config.timezone.trim()) {
    config.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  if (seed !== undefined) {
    Object.assign(config, graphicsIdentity(platformOs, seed));
    // The same count a launch would pick for this card (firefoxLaunchConfig).
    fitThreads(config, platformOs, false, (key) => seedFraction(deterministicSeed(`${seed}:${key}`)));
  }
  return normalizeFirefoxProfileConfig({
    version: 1,
    runtimeVersion: FIREFOX_RUNTIME_VERSION,
    config,
  });
}

/** The usable area's top and the height it leaves out, per system (see fitDesktopPersona). */
const BASELINE_AVAIL: Record<PersonaOs, { top: number; less: number }> = {
  windows: { top: 0, less: 48 }, macos: { top: 25, less: 76 }, linux: { top: 0, less: 0 },
};

/**
 * The usable screen area stock Firefox 156 reports with its default baseline fingerprinting
 * protection (ScreenAvailToResolution, nsRFPService::GetSpoofedScreenAvailSize): the full width
 * from 0, and the height less 48 on Windows, less 76 from top 25 on macOS, and all of it on Linux.
 * The generator's own values put the area beside its screen on most Windows samples (availLeft
 * 1920 with screen.left 0). Touch points are 0, a desktop without a touch screen; the baseline
 * shows only 0, 1 or 5 (MaxTouchPointsCollapse), and the generator gave some 1 or 2 without
 * touch events.
 */
function fitDesktopPersona(config: Record<string, JsonValue>, os: PersonaOs): void {
  const width = config["screen.width"];
  const height = config["screen.height"];
  if (typeof width === "number" && typeof height === "number") {
    const { top, less } = BASELINE_AVAIL[os];
    Object.assign(config, {
      "screen.availLeft": 0, "screen.availTop": top, "screen.availWidth": width, "screen.availHeight": Math.max(1, height - less),
    });
  }
  config["navigator.maxTouchPoints"] = 0;
}

/**
 * Keep inner <= outer <= available <= screen and the window inside the available area, as
 * upstream Camoufox does (clamp_window_dimensions/clamp_window_position). The engine sizes the
 * real window from these values, so a window larger than its own screen is an impossible geometry.
 * The window also stays inside `display`, the real display's available area, when it is given.
 */
export function fitFirefoxWindow(config: Record<string, JsonValue>, display?: { width: number; height: number }): void {
  const value = (key: string) => typeof config[key] === "number" ? config[key] as number : undefined;
  for (const [axis, position] of [["Width", "window.screenX"], ["Height", "window.screenY"]] as const) {
    const screen = value(`screen.${axis.toLowerCase()}`);
    const avail = value(`screen.avail${axis}`);
    if (screen && avail && avail > screen) config[`screen.avail${axis}`] = screen;
    const claimed = value(`screen.avail${axis}`) ?? screen;
    const cap = claimed && display ? Math.min(claimed, axis === "Width" ? display.width : display.height) : claimed;
    const outer = value(`window.outer${axis}`);
    const inner = value(`window.inner${axis}`);
    if (outer && cap && outer > cap) {
      config[`window.outer${axis}`] = cap;
      if (inner) config[`window.inner${axis}`] = Math.max(1, cap - Math.max(0, outer - inner));
    }
    const fittedOuter = value(`window.outer${axis}`);
    const fittedInner = value(`window.inner${axis}`);
    if (fittedInner && fittedOuter && fittedInner > fittedOuter) config[`window.inner${axis}`] = fittedOuter;
    // The position is page-visible only. It stays inside the available area of the window's own
    // screen, which a multi-monitor layout places at availLeft/availTop.
    const at = value(position);
    const origin = value(axis === "Width" ? "screen.availLeft" : "screen.availTop") ?? 0;
    if (at !== undefined && cap && fittedOuter) {
      config[position] = Math.max(origin, Math.min(at, origin + cap - fittedOuter));
    }
  }
}

/**
 * Keys the 156 engine ignores (canvas:seed, fonts:spacing_seed; window.screenX/Y, as pages see the
 * real window position) or that are a tell: navigator.globalPrivacyControl is true without the
 * Sec-GPC header stock Firefox sends with it, and audio:seed adds noise to audio that stock Firefox
 * renders the same on every computer and OS, so it changed signals that must stay exact (a constant
 * 0.5 signal, silence) and gave sums no stock Firefox gives.
 */
const DROPPED_LAUNCH_KEYS = [
  "canvas:seed", "fonts:spacing_seed", "window.screenX", "window.screenY", "navigator.globalPrivacyControl", "audio:seed",
];

/**
 * The config one launch sends to the engine. Seeds, voices, media devices, the window label and
 * the window fit are derived here and never stored, so saved Local and Cloud profiles keep their
 * exact shape. A value the profile stores itself is kept, unless no real desktop of its system
 * shows it (fitDesktopPersona, a macOS card that is not Apple's). On a display smaller than the
 * profile's screen the window fits `hostAvail`, the display's available area, and the screen keeps
 * its size: a window smaller than its screen is normal.
 */
export function firefoxLaunchConfig(
  profile: Profile, windowLabel?: string, fontsDir?: string, webRtcIp?: string, intelMac?: { vendor?: MacGraphicsVendor },
  hostAvail?: { width: number; height: number }, hostCores = availableParallelism(),
): Record<string, JsonValue> {
  const config = { ...profile.firefox!.config };
  for (const key of DROPPED_LAUNCH_KEYS) delete config[key];
  // The font pack of the profile's OS, when it is not this computer's OS (firefox-fonts.ts).
  if (fontsDir) config["aliasmode:fontsDir"] = fontsDir;
  else delete config["aliasmode:fontsDir"];
  const seed = (key: string) => deterministicSeed(`${profile.fingerprintSeed}:${key}`);
  // Without these, profiles on one computer read back the same canvas and WebGL pixels and
  // measure the same text widths.
  config["aliasmode:canvasSeed"] ??= seed("aliasmode:canvasSeed");
  config["aliasmode:textSeed"] ??= seed("aliasmode:textSeed");
  const os = firefoxPersonaOs(profile, config);
  const graphics = replacedGraphics(profile, config, intelMac);
  if (graphics) {
    for (const key of Object.keys(config)) if (/^webGl2?:/.test(key)) delete config[key];
    Object.assign(config, graphics);
  }
  fitThreads(config, os, !!intelMac, (key) => seedFraction(seed(key)));
  // A count the user set wins, even one no real desktop of this card shows.
  if (profile.hardware) config["navigator.hardwareConcurrency"] = profile.hardware.cores;
  // Pages that run workers in parallel measure this computer's count, so more is a tell. Chromium 155 caps it the same way.
  if (Number(config["navigator.hardwareConcurrency"]) > hostCores) config["navigator.hardwareConcurrency"] = hostCores;
  // With the stock list every profile of one OS shows the same fonts.
  if (isStrings(config.fonts)) config.fonts = firefoxProfileFonts(os, config.fonts, (group) => seedFraction(seed(`fonts:${group}`)), !fontsDir);
  // Of the Hiragino faces the macOS font pack holds only Hiragino Sans GB, so on another computer
  // the others cannot load, and a listed font that never loads is a tell.
  if (fontsDir && os === "macos" && isStrings(config.fonts)) {
    config.fonts = config.fonts.filter((font) => !/^\.?(Hiragino|ヒラギノ)/.test(font) || /Sans GB|^ヒラギノ角ゴ 簡体中文/.test(font));
  }
  // Without its own list the engine shows this computer's voices.
  config.voices ??= firefoxVoices(os, firefoxStartupLocale(profile), seed("voices"));
  config["voices:blockIfNotDefined"] ??= true;
  if (!Object.keys(config).some((key) => key.startsWith("mediaDevices:"))) {
    Object.assign(config, firefoxMediaDevices(os, seed("mediaDevices")));
  }
  // The engine shows the label in the native window title only, adding its own separator.
  if (windowLabel) config["aliasmode:windowLabel"] = windowLabel;
  // Behind a proxy the engine shows the proxy's exit IP as WebRTC's public address, as a browser
  // at that exit would, in place of no address. The current exit replaces any stored one.
  if (profile.proxy && webRtcIp) config[isIP(webRtcIp) === 6 ? "webrtc:ipv6" : "webrtc:ipv4"] = webRtcIp;
  // Without a proxy, the computer's IPv6 address is the same for every profile on it.
  if (!profile.proxy) config["network:ipv4Only"] ??= true;
  fitDesktopPersona(config, os);
  fitFirefoxWindow(config, hostAvail);
  return config;
}

/**
 * Give a Firefox profile another screen with the values that follow from it, as creation sets
 * them: the available area (fitDesktopPersona) and a window at the usual fraction of the screen
 * (launchWindowSize) with the same frame around the page.
 */
export function setFirefoxScreen(profile: Profile, width: number, height: number): void {
  if (!profile.firefox) throw new Error("Firefox profile is missing its saved configuration");
  const config: Record<string, JsonValue> = { ...profile.firefox.config, "screen.width": width, "screen.height": height };
  const [outerWidth, outerHeight] = launchWindowSize(width, height);
  for (const [axis, outer] of [["Width", outerWidth], ["Height", outerHeight]] as const) {
    const frame = Number(config[`window.outer${axis}`]) - Number(config[`window.inner${axis}`]);
    if (frame >= 0) config[`window.inner${axis}`] = Math.max(1, outer - frame);
    config[`window.outer${axis}`] = outer;
  }
  fitDesktopPersona(config, firefoxPersonaOs(profile, config));
  fitFirefoxWindow(config);
  profile.firefox = { ...profile.firefox, config };
  profile.screenWidth = width;
  profile.screenHeight = height;
}

const OS_FONT_KEYS: Record<PersonaOs, "win" | "mac" | "lin"> = { windows: "win", macos: "mac", linux: "lin" };

/** Noto families for historic scripts; a name ending in "*" matches every name it starts. */
const HISTORIC_NOTO = [
  "Avestan", "Bhaiksuki", "Brahmi", "Carian", "Cauc*", "Cuneiform", "Cypriot", "Duployan", "Egypt*", "Elbasan",
  "Glagolitic", "Gothic", "Grantha", "Hatran", "Imp*", "Ins*", "Kaithi", "Kharoshthi", "Khojki", "Khudawadi",
  "Linear*", "Lycian", "Lydian", "Mahajani", "Manichaean", "Marchen", "Meroitic", "Modi", "Multani", "Nabataean",
  "Old*", "Palmyrene", "Phoenician", "Psa*", "Runic", "Sharada", "Siddham", "Takri", "Tirhuta", "Ugaritic",
].map((script) => `Noto Sans ${script}`);

/**
 * Groups of rarely used families a stock install has, each shown by `presence` of profiles. Core
 * families and the families detectors use to tell the OS version (FONT_VERSION_MARKERS) are never
 * in a group. Windows has none: every Windows 10 and 11 has its handwriting, supplemental-script,
 * historic-script and CJK Extension B families, and Pixelscan treats a missing one as a tell. The
 * fonts real Windows computers differ by (Microsoft Office, optional language features) are not in
 * the Windows font pack, so Windows profiles show the same list.
 */
const OPTIONAL_FONT_GROUPS: Record<PersonaOs, Array<{ id: string; presence: number; fonts: string[] }>> = {
  windows: [],
  macos: [
    { id: "decorative", presence: 0.7, fonts: ["Academy Engraved LET", "Bodoni Ornaments", "Chalkduster", "Herculanum", "Hoefler Text Ornaments", "Party LET", "Phosphate", "Savoye LET", "Trattatello", "Zapfino"] },
    { id: "pt", presence: 0.7, fonts: ["PT *"] },
    { id: "stix-legacy", presence: 0.75, fonts: ["STIX*"] },
    { id: "historic-scripts", presence: 0.7, fonts: HISTORIC_NOTO },
  ],
  linux: [
    { id: "noto-serif", presence: 0.7, fonts: ["Noto Serif *"] },
    { id: "tifinagh-variants", presence: 0.75, fonts: ["Noto Sans Tifinagh *"] },
    { id: "historic-scripts", presence: 0.7, fonts: HISTORIC_NOTO },
    { id: "minority-scripts", presence: 0.75, fonts: [
      "Adlam", "Bamum", "Bassa Vah", "Batak", "Buginese", "Buhid", "Chakma", "Cham", "Deseret", "Hanifi*", "Hanunoo",
      "Kayah Li", "Lepcha", "Limbu", "Lisu", "Mandaic", "Medefaidrin", "Meetei Mayek", "Mende Kikakui", "Miao", "Mro",
      "NKo", "Newa", "Ol Chiki", "Osage", "Osmanya", "Pahawh Hmong", "Pau Cin Hau", "Rejang", "Samaritan", "Saurashtra",
      "Shavian", "Sora*", "Soyombo", "Sundanese", "Syloti Nagri", "Tagalog", "Tagbanwa", "Tai Le", "Tai Tham", "Tai Viet",
      "Vai", "Wancho", "Warang Citi", "Yi", "Zanabazar Square",
    ].map((script) => `Noto Sans ${script}`) },
  ],
};

/** Families CreepJS reads the macOS version from; a group pattern never hides them. */
const FONT_VERSION_MARKERS = new Set(["Noto Sans Canadian Aboriginal", "Noto Sans Gunjala Gondi", "Noto Sans Masaram Gondi", "Noto Serif Yezidi", "STIX Two Math", "STIX Two Text"]);

const isStrings = (value: JsonValue | undefined): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Families of a stock install that the engine's stock list lacks: Windows 10 and 11 name the styles
 * of Sitka as families of their own. On another OS only Sitka Text of the font pack's SitkaVF loads
 * (Linux names a variable font by its default style), and a listed font that never loads is a tell.
 */
const MISSING_STOCK_FONTS: Partial<Record<PersonaOs, string[]>> = {
  windows: ["Sitka Small", "Sitka Text", "Sitka Subheading", "Sitka Heading", "Sitka Display", "Sitka Banner"],
};

/**
 * Families a Linux computer with the Linux font pack's fonts shows that the pack lacks: fontconfig's
 * standard metric aliases answer Arial, Courier New and Times New Roman with Arimo, Cousine and Tinos
 * (measured in stock Firefox on Linux). On another OS they are that computer's own, with the same metrics.
 */
const ALIASED_PACK_FONTS: Partial<Record<PersonaOs, string[]>> = { linux: ["Arial", "Courier New", "Times New Roman"] };

/**
 * The fonts one launch shows: a stored list that is the stock list of the profile's OS, with the
 * stock families that list lacks on that OS itself (on another OS, the font pack's aliased families),
 * less the optional groups this profile does not draw. A list the user changed is shown as stored.
 */
function firefoxProfileFonts(os: PersonaOs, stored: string[], fraction: (group: string) => number, ownOs: boolean): string[] {
  const stock = fonts[OS_FONT_KEYS[os]] as string[];
  if (stored.length !== stock.length || !stock.every((font) => stored.includes(font))) return stored;
  const hidden = OPTIONAL_FONT_GROUPS[os].filter((group) => fraction(group.id) >= group.presence).flatMap((group) => group.fonts);
  const inHidden = (font: string) => !FONT_VERSION_MARKERS.has(font)
    && hidden.some((pattern) => pattern.endsWith("*") ? font.startsWith(pattern.slice(0, -1)) : font === pattern);
  return [...new Set([...stored, ...(ownOs ? MISSING_STOCK_FONTS : ALIASED_PACK_FONTS)[os] ?? []])].filter((font) => !inHidden(font));
}

/** The profile's language for the browser interface, Intl and form messages (as upstream Camoufox sets it). */
function firefoxStartupLocale(profile: Profile): string {
  return configuredFirefoxLocale(profile.firefox!.config) ?? normalizeProfileLocale(profile.locale) ?? "en-US";
}

/**
 * Preferences the engine applies at startup (CAMOU_PREFS_n). Without intl.locale.requested the
 * 156 engine keeps an English interface and Intl locale whatever the profile's language.
 * navigator.gpu shows where stock Firefox 156 has it: Windows and Apple graphics on macOS
 * (dom.webgpu.enabled; upstream Camoufox's set_webgpu). The WebGPU block keeps the computer's
 * real graphics card from showing through requestAdapter(), except for a macOS profile on an
 * Apple Silicon Mac: it claims that Mac's own card family. The app does not know a Windows
 * computer's card, so Windows profiles keep the block. The app restores sessions itself, so
 * Firefox's "Open previous tabs?" bar stays off. When the
 * profile's font list hides the font the system picks for a character (CJK text with a Windows
 * font list on Linux), Firefox searches the listed fonts instead; asynchronous fallback skips
 * the ones whose character maps are still loading, so text measured in the first seconds after
 * startup differs from the same text measured later. Synchronous fallback gives one result.
 * The engine turns the new tab page off, so a new tab was blank; Firefox's own page (logo and a
 * search box that uses the default search engine) is local, makes no requests and adds nothing
 * a site can see. WebGPU in service workers follows WebGPU, as in stock Firefox. A profile of
 * another OS than this computer's gets that OS's stock fonts and colours (personaOsPrefs).
 */
/**
 * Site caches (HTTP and compiled-script caches) stay across closes up to this total per profile
 * (the user's choice, 2026-11-03), so a reopen does not download every site again through the
 * proxy. Chromium's HTTP cache is capped at 20 MB by --disk-cache-size, Firefox's whole cache at
 * this total by its cache prefs; the launcher trims what is over it after a stop.
 */
export const SITE_CACHE_CAP_BYTES = 35 * 1024 * 1024;

export function firefoxStartupPrefs(profile: Profile, hostPlatform?: NodeJS.Platform, hostArch?: string): Record<string, JsonValue> {
  const os = firefoxPersonaOs(profile);
  const appleSilicon = hostPlatform === "darwin" && hostArch === "arm64";
  // A profile without a stored card shows this computer's; on an Intel Mac a macOS one shows an Intel or AMD card.
  const renderer = firefoxGraphicsRenderer(profile, hostPlatform === "darwin" && hostArch === "x64" ? {} : undefined);
  const appleGraphics = renderer === undefined ? appleSilicon : String(renderer).startsWith("Apple");
  const webGpu = os === "windows" || (os === "macos" && appleGraphics);
  const host = hostPlatform === "win32" ? "windows" : hostPlatform === "darwin" ? "macos" : hostPlatform === "linux" ? "linux" : undefined;
  return {
    "intl.locale.requested": firefoxStartupLocale(profile),
    "dom.webgpu.enabled": webGpu,
    "dom.webgpu.service-workers.enabled": webGpu,
    ...(os === "macos" && appleSilicon ? {} : { "gfx.blacklist.webgpu": 4 }),
    "browser.startup.couldRestoreSession.count": -1,
    "gfx.font_rendering.fallback.async": false,
    "browser.newtabpage.enabled": true,
    // A fixed cache size (in KB) instead of one sized from free disk; pages cannot read it.
    "browser.cache.disk.smart_size.enabled": false,
    "browser.cache.disk.capacity": SITE_CACHE_CAP_BYTES / 1024,
    ...(host && host !== os ? personaOsPrefs(os) : {}),
  };
}

const GENERIC_FAMILIES = ["serif", "sans-serif", "monospace", "cursive", "fantasy"] as const;

/**
 * Linux's generic families in the Linux font pack. Stock Firefox on Linux names fontconfig's serif,
 * sans-serif, monospace and cursive, which no other OS resolves: a Linux profile on Windows drew all
 * five (monospace too) in one Arial-wide fallback (measured). These are the pack's serif, sans-serif
 * and monospace faces, metric-compatible with the Liberation fonts most Linux desktops resolve to;
 * cursive and fantasy fall back to sans-serif, as on a Linux desktop without such fonts.
 */
const LINUX_LATIN = ["Tinos", "Arimo", "Cousine", "Arimo", "Arimo"];

/**
 * The fonts stock Firefox 156 names for the generic families (in GENERIC_FAMILIES order) of each
 * language group, and for emoji, on Windows and macOS (font.name-list.* in modules/libpref/init/
 * all.js of FIREFOX_156_0_RELEASE; font.name.* are empty). Windows sets no fantasy family, and
 * stock Firefox there draws it in Arial (measured). Linux: its stock emoji list, LINUX_LATIN, and
 * for Chinese, Japanese and Korean the pack's Noto Sans face of the language, as fontconfig picks.
 */
const PERSONA_FONTS: Record<PersonaOs, { emoji: string; groups: Record<string, string[]> }> = {
  linux: {
    emoji: "Noto Color Emoji, Twemoji Mozilla",
    groups: {
      "x-western": LINUX_LATIN, "x-unicode": LINUX_LATIN, "x-cyrillic": LINUX_LATIN, el: LINUX_LATIN, ar: LINUX_LATIN, he: LINUX_LATIN, th: LINUX_LATIN,
      ja: Array(4).fill("Noto Sans JP"), ko: Array(4).fill("Noto Sans KR"), "zh-CN": Array(4).fill("Noto Sans SC"),
      "zh-TW": Array(4).fill("Noto Sans TC"), "zh-HK": Array(4).fill("Noto Sans TC"),
    },
  },
  windows: {
    emoji: "Segoe UI Emoji, Twemoji Mozilla",
    groups: {
      "x-western": ["Times New Roman", "Arial", "Consolas", "Comic Sans MS", "Arial"],
      "x-unicode": ["Times New Roman", "Arial", "Consolas", "Comic Sans MS"],
      "x-cyrillic": ["Times New Roman", "Arial", "Consolas", "Comic Sans MS"],
      el: ["Times New Roman", "Arial", "Consolas", "Comic Sans MS"],
      ar: ["Times New Roman", "Segoe UI, Tahoma, Arial", "Consolas", "Comic Sans MS"],
      he: ["Narkisim, David", "Arial", "Fixed Miriam Transparent, Miriam Fixed, Rod, Consolas, Courier New", "Guttman Yad, Ktav, Arial"],
      th: ["Tahoma", "Tahoma", "Tahoma", "Tahoma"],
      ja: [
        "Yu Mincho, MS PMincho, MS Mincho, Noto Serif CJK JP, Noto Serif JP, Meiryo, Yu Gothic, MS PGothic, MS Gothic",
        "Meiryo, Yu Gothic, MS PGothic, MS Gothic, Noto Sans CJK JP, Noto Sans JP",
        "BIZ UDGothic, MS Gothic, MS Mincho, Meiryo, Yu Gothic, Yu Mincho",
      ],
      ko: ["Batang, Noto Serif CJK KR, Noto Serif KR, Gulim", "Malgun Gothic, Gulim, Noto Sans CJK KR, Noto Sans KR", "GulimChe", "Gungsuh"],
      "zh-CN": [
        "SimSun, MS Song, SimSun-ExtB, Noto Serif CJK SC, Noto Serif SC", "Microsoft YaHei, SimHei, Noto Sans CJK SC, Noto Sans SC",
        "NSimSun, SimSun, MS Song, SimSun-ExtB", "KaiTi, KaiTi_GB2312",
      ],
      "zh-TW": [
        "Times New Roman, PMingLiu, MingLiU, MingLiU-ExtB, Noto Serif CJK TC, Noto Serif TC",
        "Arial, Microsoft JhengHei, PMingLiU, MingLiU, MingLiU-ExtB, Noto Sans CJK TC, Noto Sans TC", "MingLiU, MingLiU-ExtB", "DFKai-SB",
      ],
      "zh-HK": [
        "Times New Roman, MingLiu_HKSCS, Ming(for ISO10646), MingLiU, MingLiU_HKSCS-ExtB, Noto Serif CJK HK, Noto Serif HK, Microsoft JhengHei",
        "Arial, MingLiU_HKSCS, Ming(for ISO10646), MingLiU, MingLiU_HKSCS-ExtB, Microsoft JhengHei, Noto Sans CJK HK, Noto Sans HK",
        "MingLiU_HKSCS, Ming(for ISO10646), MingLiU, MingLiU_HKSCS-ExtB, Microsoft JhengHei", "DFKai-SB",
      ],
    },
  },
  macos: {
    emoji: "Apple Color Emoji",
    groups: {
      "x-western": ["Times, Times New Roman", "Helvetica, Arial", "Menlo", "Apple Chancery", "Papyrus"],
      "x-unicode": ["Times", "Helvetica", "Menlo", "Apple Chancery", "Papyrus"],
      "x-cyrillic": ["Times, Times New Roman", "Helvetica, Arial", "Menlo", "Geneva", "Charcoal CY"],
      el: ["Times, Times New Roman", "Helvetica, Lucida Grande", "Menlo", "Lucida Grande, Times", "Lucida Grande, Times"],
      ar: ["Al Bayan", "Geeza Pro", "Menlo, Geeza Pro", "DecoType Naskh", "KufiStandardGK"],
      he: ["Times New Roman", "Arial", "Menlo, Courier New", "Times New Roman", "Times New Roman"],
      th: ["Thonburi", "Thonburi", "Menlo, Ayuthaya"],
      ja: [
        "Hiragino Mincho ProN, Hiragino Mincho Pro", "Hiragino Kaku Gothic ProN, Hiragino Kaku Gothic Pro, Hiragino Sans",
        "Osaka-Mono, Menlo, Hiragino Kaku Gothic ProN, Hiragino Sans",
      ],
      ko: ["AppleMyungjo", "Apple SD Gothic Neo, AppleGothic", "Menlo, Apple SD Gothic Neo, AppleGothic"],
      "zh-CN": ["Times New Roman, Songti SC, STSong, Heiti SC", "Arial, PingFang SC, STHeiti, Heiti SC", "Menlo, PingFang SC, STHeiti, Heiti SC", "Kaiti SC"],
      "zh-TW": ["Times New Roman, Songti TC, LiSong Pro, Heiti TC", "Arial, PingFang TC, Heiti TC, LiHei Pro", "Menlo, PingFang TC, Heiti TC, LiHei Pro", "Kaiti TC"],
      "zh-HK": ["Times New Roman, Songti TC, LiSong Pro, Heiti TC", "Arial, PingFang TC, Heiti TC, LiHei Pro", "Menlo, PingFang TC, Heiti TC, LiHei Pro", "Kaiti TC"],
    },
  },
};

/**
 * The system colours stock Firefox 156 on Windows shows pages where Linux and macOS show their own
 * (measured: Highlight, SelectedItem, AccentColor, -moz-Dialog, -moz-DialogText, -moz-MenuHover;
 * pref names from widget/nsXPLookAndFeel.cpp). Stock macOS values are not measured yet, so a macOS
 * profile keeps this computer's.
 */
const WINDOWS_COLORS = {
  "ui.highlight": "#0078d7", "ui.selecteditem": "#0078d7", "ui.accentcolor": "#0060df",
  "ui.-moz-dialog": "#ffffff", "ui.-moz-dialogtext": "#000000", "ui.-moz_menuhover": "#e0e0e6",
};

/**
 * The look stock Firefox 156 on Linux (GTK's default Adwaita theme) shows pages where a Linux
 * profile on Windows showed Windows' (measured): system colours, -moz-OddTreeRow's transparent
 * (Gecko's NS_TRANSPARENT), and overlay scrollbars that take no room in the page. AccentColor
 * follows the theme's accent on Linux; Windows shows Firefox's own unless use-theme-accent is on.
 */
const LINUX_LOOK = {
  "widget.non-native-theme.use-theme-accent": true,
  "ui.highlight": "#3584e4", "ui.selecteditem": "#3584e4", "ui.accentcolor": "#3584e4",
  "ui.-moz-dialog": "#fafafb", "ui.-moz-dialogtext": "#323237", "ui.-moz_menuhover": "#3584e4", "ui.-moz_menuhovertext": "#ffffff",
  "ui.-moz_menubarhovertext": "#000000", "ui.-moz-cellhighlight": "#e1e1e1", "ui.-moz_oddtreerow": "rgba(1, 0, 0, 0)",
  "ui.useOverlayScrollbars": 1,
};

/**
 * Stock defaults of a profile's OS that a computer of another OS would replace with its own:
 * generic and emoji fonts, the monospace size and Thai minimum size, and on Windows and Linux the
 * system colours (and Linux's overlay scrollbars).
 */
function personaOsPrefs(os: PersonaOs): Record<string, JsonValue> {
  const { emoji, groups } = PERSONA_FONTS[os];
  const linux = os === "linux";
  const prefs: Record<string, JsonValue> = { "font.name-list.emoji": emoji, "font.minimum-size.th": linux ? 13 : 10 };
  for (const [group, families] of Object.entries(groups)) {
    families.forEach((family, index) => { prefs[`font.name-list.${GENERIC_FAMILIES[index]}.${group}`] = family; });
  }
  for (const group of ["ar", "el", "he", "x-cyrillic", "x-unicode", "x-western"]) prefs[`font.size.monospace.${group}`] = linux ? 12 : 13;
  return { ...prefs, ...os === "windows" ? WINDOWS_COLORS : linux ? LINUX_LOOK : {} };
}

export function firefoxPersonaOs(profile: Profile, config: Record<string, JsonValue> = profile.firefox?.config ?? {}): PersonaOs {
  const ua = typeof config["navigator.userAgent"] === "string" ? config["navigator.userAgent"] : "";
  const os = profile.platformOs || platformFromUA(profile.ua) || platformFromUA(ua);
  if (os === "windows" || os === "macos" || os === "linux") return os;
  return config["navigator.platform"] === "MacIntel" ? "macos"
    : String(config["navigator.platform"] ?? "").startsWith("Linux") ? "linux" : "windows";
}

/**
 * A profile saved for an older AliasMode Firefox moves to the current engine, as a normal browser
 * update would: the runtime and the Firefox version in its user agent change, nothing else.
 * A newer runtime is left alone, and the launcher then refuses it.
 */
function updateFirefoxRuntime(profile: Profile): Profile {
  const firefox = profile.firefox!;
  const major = Number.parseInt(firefox.runtimeVersion, 10);
  if (firefox.runtimeVersion === FIREFOX_RUNTIME_VERSION || !(major < Number(FIREFOX_UA_MAJOR_VERSION))) return profile;
  const update = (ua: string) => ua
    .replace(/\brv:\d+\.\d+/, `rv:${FIREFOX_UA_MAJOR_VERSION}.0`)
    .replace(/\bFirefox\/\d+\.\d+/, `Firefox/${FIREFOX_UA_MAJOR_VERSION}.0`);
  const config = { ...firefox.config };
  for (const key of ["navigator.userAgent", "headers.User-Agent"]) {
    if (typeof config[key] === "string") config[key] = update(config[key]);
  }
  return {
    ...profile,
    ua: update(profile.ua),
    firefox: { ...firefox, runtimeVersion: FIREFOX_RUNTIME_VERSION, config },
  };
}

function configuredFirefoxLocale(config: Record<string, JsonValue>): string | undefined {
  const language = config["locale:language"];
  const region = config["locale:region"];
  const explicit = config["locale:all"] || config["navigator.language"];
  const value = typeof explicit === "string" ? explicit.split(",")[0]?.trim()
    : typeof language === "string" ? [language, config["locale:script"], region].filter(Boolean).join("-")
    : undefined;
  return normalizeProfileLocale(value);
}

/** Complete missing identity only at creation or closed-profile persistence boundaries. */
export function completeProfileFingerprint(profile: Profile): Profile {
  const saved = profile.firefox?.config;
  const locale = normalizeProfileLocale(profile.locale)
    ?? (saved ? configuredFirefoxLocale(saved) : undefined)
    ?? localeForTimezone(profile.timezone);
  if (profile.engine !== "firefox" || !profile.firefox) return { ...profile, locale };

  profile = updateFirefoxRuntime(profile);
  const config = { ...profile.firefox!.config };
  const tag = new Intl.Locale(locale);
  const previousLocale = configuredFirefoxLocale(config);
  config["locale:language"] = tag.language;
  if (tag.region) config["locale:region"] = tag.region;
  else delete config["locale:region"];
  if (tag.script) config["locale:script"] = tag.script;
  else delete config["locale:script"];
  config["navigator.language"] = locale;
  if (!config["locale:all"] || previousLocale !== locale) {
    config["locale:all"] = [...new Set([locale, tag.language])].join(", ");
  }
  if (config["navigator.languages"] !== undefined && previousLocale !== locale) {
    config["navigator.languages"] = [...new Set([locale, tag.language])];
  }
  if (config.fonts === undefined) {
    const platform = firefoxPersonaOs(profile, config);
    config.fonts = [...fonts[platform === "macos" ? "mac" : platform === "linux" ? "lin" : "win"]];
  }
  return { ...profile, locale, firefox: { ...profile.firefox!, config } };
}

export function syncFirefoxTimezone(profile: Profile): void {
  if (profile.engine !== "firefox") return;
  if (!profile.firefox) throw new Error("Firefox profile is missing its saved configuration");
  const { timezone: _timezone, ...config } = profile.firefox.config;
  profile.firefox = {
    ...profile.firefox,
    config: { ...config, ...(profile.timezone ? { timezone: profile.timezone } : {}) },
  };
}

/** Normalize and validate the persisted Camoufox identity at every boundary. */
export function normalizeFirefoxProfileConfig(value: unknown): FirefoxProfileConfig {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "runtimeVersion", "config"])) {
    throw new Error("invalid Firefox profile config");
  }
  if (value.version !== 1) throw new Error("unsupported Firefox profile config version");
  if (typeof value.runtimeVersion !== "string" || !value.runtimeVersion.trim()) {
    throw new Error("Firefox profile config runtimeVersion must be a non-empty string");
  }
  if (!isRecord(value.config)) throw new Error("Firefox profile config must include a config object");
  return {
    version: 1,
    runtimeVersion: value.runtimeVersion.trim(),
    config: normalizeJsonRecord(value.config),
  };
}

/** Treat a missing legacy engine as Chromium and reject malformed combinations. */
export function normalizeProfileEngine(value: unknown, firefox: unknown): {
  engine: ProfileEngine;
  firefox?: FirefoxProfileConfig;
} {
  const engine = value === undefined ? "chromium" : value;
  if (engine !== "chromium" && engine !== "firefox") throw new Error("unsupported profile engine");
  if (engine === "firefox") {
    if (firefox === undefined) throw new Error("Firefox profiles require a Firefox config");
    return { engine, firefox: normalizeFirefoxProfileConfig(firefox) };
  }
  if (firefox !== undefined) throw new Error("Chromium profiles cannot include a Firefox config");
  return { engine };
}

/** Absent, empty, or "cloakbrowser" means the CloakBrowser runtime, which is stored as no runtime. */
export function normalizeChromiumRuntime(value: unknown, engine: ProfileEngine): ChromiumRuntime | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value !== "aliasmode" && value !== "cloakbrowser") throw new Error("unsupported Chromium runtime");
  if (engine !== "chromium") throw new Error("only Chromium profiles can choose a Chromium runtime");
  return value === "aliasmode" ? value : undefined;
}

function normalizeJsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeJson(item)]));
}

function normalizeJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Firefox profile config must contain JSON values");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (isRecord(value)) return normalizeJsonRecord(value);
  throw new Error("Firefox profile config must contain JSON values");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
