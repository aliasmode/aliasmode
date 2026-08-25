/**
 * Shared types for the CloakBrowser manager.
 *
 * The manager owns all CloakBrowser-specific launch detail (persistent
 * user-data dir, proxy, fingerprint seed, UA, screen, debug port, CDP ws).
 * `automation` keeps launching with `profileId + baseUrl` only, exactly as it
 * does against AdsPower today.
 */

/** A browser cookie in Playwright/CDP shape, after normalization. */
export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds. Omitted for session cookies. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  partitionKey?: string;
  _crHasCrossSiteAncestor?: boolean;
}

export type ProxyType = "http" | "https" | "socks5";

export interface ProxySpec {
  /** Canonical lowercase proxy protocol. */
  type: ProxyType;
  host: string;
  port: string;
  user: string;
  pass: string;
}

/**
 * A fully-resolved profile. Every field that affects the browser identity
 * (proxy, fingerprintSeed, ua, screen) is fixed once at import time and read
 * verbatim on every launch. The launcher must never recompute or rotate any
 * of these — that mirrors the AdsPower launch invariant: launch uses stored
 * state, it does not mutate it.
 */
export interface Profile {
  /** AdsPower profile id, e.g. "k1d0cd11". Stays the same after migration. */
  id: string;
  accId: string;
  name: string;
  group: string;
  /**
   * Account platform this profile is for: "x.com", "telegram.org", or "" (none).
   * Drives the home page opened on launch (see platformHomeUrl in launcher.ts).
   * Optional so existing Profile literals/fixtures stay valid; treated as "".
   */
  platform?: string;
  username: string;
  password: string;
  /** Recovery/contact email associated with the account; empty when none. */
  email?: string;
  /** Password for the associated email inbox; empty when none. */
  emailPassword?: string;
  /** 2FA seed (AdsPower "fakey"); empty when none. */
  twofa: string;
  proxy: ProxySpec | null;
  /**
   * A legacy persisted proxy that failed current validation. Quarantined
   * profiles remain visible/editable but the launcher must refuse them until
   * the proxy is replaced or explicitly cleared.
   */
  proxyError?: string;
  /**
   * Ids of extensions assigned to this profile (see the `extensions` registry in
   * store.ts). Loaded unpacked via --load-extension at launch. Optional so older
   * Profile literals/fixtures stay valid; treated as [].
   */
  extensions?: string[];
  /** Free-form custom tags/labels for this profile. Optional so older literals stay valid; treated as []. */
  tags?: string[];
  ua: string;
  /**
   * IANA timezone matching the proxy's geolocation (e.g. "America/New_York"),
   * resolved by geoip at import. Empty when unknown — the launcher then omits
   * the timezone flag and CloakBrowser falls back to its default.
   */
  timezone: string;
  screenWidth: number;
  screenHeight: number;
  /** Deterministic per-profile CloakBrowser fingerprint seed. */
  fingerprintSeed: number;
  cookies: CookieRecord[];
  /**
   * Legacy bookkeeping flag: set true the first time cookies were injected.
   * NOTE: injection is NOT gated on this. The real gate is hasUsableAuthToken()
   * plus the live-session probe in launcher.ts. Do NOT add an
   * `if (profile.seeded) return` short-circuit — that would break cookie
   * (re)injection for accounts whose session legitimately needs it.
   */
  seeded: boolean;
}

/** What a launched browser exposes back to automation. Mirrors AdsPower. */
export interface LaunchInfo {
  profileId: string;
  pid: number;
  debugPort: number;
  ws: string;
  startedAt: number;
  /** Loopback port of the auth-injecting proxy relay for this launch, if it has an authed proxy.
   *  Persisted so a manager restart can re-bind the relay on the same port the browser points at. */
  relayPort?: number;
  /** Hub session version this live browser was opened from or last successfully pushed to. */
  sessionBaseVersion?: number;
  /** Exact executable and profile directory used by this launch generation. */
  binaryPath?: string;
  userDataDir?: string;
  /** SHA-256 of the verified CloakBrowser kernel used for this generation. */
  binarySha256?: string;
  /** Hash of every launch-time fingerprint input, kernel, extension and mode. */
  personaDigest?: string;
  /** Explicit mode for this launch generation. Missing only on legacy rows. */
  headless?: boolean;
  /** Search bootstrap attempted before this browser generation was spawned. */
  searchBootstrapRevision?: number;
  /** Linux-only ownership proof for a dedicated browser process group. */
  processGroupId?: number;
  /** Linux /proc start-time token for the exact browser root PID. */
  rootStartTime?: string;
}
