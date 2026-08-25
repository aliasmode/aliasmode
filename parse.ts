/**
 * Importer for the AdsPower "Export accounts" text format.
 *
 * The export is a sequence of `key=value` blocks separated by a line of
 * asterisks. Example (one record):
 *
 *   acc_id=476436
 *   id=k1d0cd11
 *   group=919_2011hotmail_28.05.26
 *   name=sophiaskye852
 *   password=...
 *   fakey=
 *   cookie=[{"name":"...","value":"...","domain":".x.com",...}, ...]
 *   proxytype=http
 *   proxy=5.249.176.244:5432:user:pass
 *   ua=Mozilla/5.0 (Windows NT 10.0; ...) Chrome/143.0.0.0 Safari/537.36
 *   resolution=1680*1050
 *   ******************
 *
 * We parse each block into a Profile, normalizing cookies to Playwright shape
 * and dropping AdsPower's own extension cookies.
 */

import type { CookieRecord, Profile, ProxySpec } from "./types.ts";
import { deterministicSeed, parseResolution } from "./fingerprint.ts";
import { normalizeProxyType, parseProxySpec, proxyLegacyString } from "./proxy.ts";
import { isSafeProfileId, PROFILE_ID_ERROR } from "./profile-id.ts";

/** Cookies on these domains belong to AdsPower's browser extension, not the account. */
const EXTENSION_COOKIE_DOMAINS = ["adspower.net", "browserext.adspower.net"];

const RECORD_SEPARATOR = /^\*{3,}\s*$/m;

/**
 * Decode raw export bytes to text, handling the encodings AdsPower/Windows
 * actually emit: UTF-8 (with or without BOM) and UTF-16 LE/BE (BOM-marked or
 * detected by NUL-byte pattern). This matters because reading a UTF-16 export
 * as UTF-8 interleaves NULs into every key, so `id=`/`ua=` never match and
 * every record is silently dropped — the file imports as "0 profiles".
 */
export function decodeText(bytes: Uint8Array): string {
  let out: string;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    out = new TextDecoder("utf-8").decode(bytes.subarray(3));
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    out = new TextDecoder("utf-16le").decode(bytes.subarray(2));
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    out = new TextDecoder("utf-16be").decode(bytes.subarray(2));
  } else {
    // No BOM. ASCII text in UTF-16LE puts NULs at odd byte offsets, UTF-16BE at
    // even ones; plain UTF-8 export text has essentially none. Sample the head.
    const n = Math.min(bytes.length, 512);
    let evenNul = 0;
    let oddNul = 0;
    for (let i = 0; i < n; i++) if (bytes[i] === 0) (i % 2 === 0 ? evenNul++ : oddNul++);
    if (evenNul + oddNul > n / 4) {
      out = new TextDecoder(oddNul >= evenNul ? "utf-16le" : "utf-16be").decode(bytes);
    } else {
      out = new TextDecoder("utf-8").decode(bytes);
    }
  }
  return out.replace(/^\uFEFF/, "");
}

/** Parse a single `key=value` block into a flat string map. */
export function parseBlock(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    // Values can themselves contain "=" (cookie JSON, base64) — split on first only.
    out[key] = line.slice(eq + 1);
  }
  return out;
}

/** Split the export into raw records. Empty trailing/leading blocks are dropped. */
export function splitRecords(text: string): Record<string, string>[] {
  return text
    .split(RECORD_SEPARATOR)
    .map((b) => parseBlock(b))
    .filter((m) => m.id && m.id.trim().length > 0);
}

/** Map AdsPower sameSite spellings onto the three Playwright accepts. */
function normalizeSameSite(raw: unknown): "Strict" | "Lax" | "None" | undefined {
  const s = String(raw ?? "").toLowerCase();
  if (s === "strict") return "Strict";
  if (s === "lax") return "Lax";
  if (s === "no_restriction" || s === "none") return "None";
  // "unspecified" / unknown: let the browser default apply.
  return undefined;
}

/**
 * Normalize an AdsPower cookie array into Playwright cookie records.
 * Strips AdsPower extension cookies and any malformed entries. SameSite=None
 * cookies are forced `secure` because Playwright/Chromium reject the pair
 * (`None` without `secure`).
 */
export function normalizeCookies(raw: unknown): { cookies: CookieRecord[]; stripped: number } {
  if (!Array.isArray(raw)) return { cookies: [], stripped: 0 };
  const cookies: CookieRecord[] = [];
  let stripped = 0;
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const name = String((c as any).name ?? "");
    const domain = String((c as any).domain ?? "");
    if (!name || !domain) continue;
    if (EXTENSION_COOKIE_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`) || domain.includes("adspower"))) {
      stripped++;
      continue;
    }
    const sameSite = normalizeSameSite((c as any).sameSite);
    const secureRaw = Boolean((c as any).secure);
    const rec: CookieRecord = {
      name,
      value: String((c as any).value ?? ""),
      domain,
      path: String((c as any).path ?? "/"),
      httpOnly: Boolean((c as any).httpOnly),
      secure: sameSite === "None" ? true : secureRaw,
    };
    if (sameSite) rec.sameSite = sameSite;
    if (typeof (c as any).partitionKey === "string") rec.partitionKey = (c as any).partitionKey;
    if (typeof (c as any)._crHasCrossSiteAncestor === "boolean") rec._crHasCrossSiteAncestor = (c as any)._crHasCrossSiteAncestor;
    // Session cookies carry no expiry; persisted cookies keep their unix-seconds expiry.
    const isSession = (c as any).session === true;
    const expires = Number((c as any).expires);
    if (!isSession && Number.isFinite(expires) && expires > 0) rec.expires = expires;
    cookies.push(rec);
  }
  return { cookies, stripped };
}

/** Parse AdsPower's `host:port:user:pass` proxy string. Empty/blank → null. */
export function parseProxy(type: string, proxy: string): ProxySpec | null {
  return parseProxySpec(type, proxy);
}

/** Shared identity-input policy for both explicit edits and AdsPower imports. */
export const MIN_SCREEN_WIDTH = 320;
export const MIN_SCREEN_HEIGHT = 200;
export const MAX_SCREEN_DIMENSION = 16_384;

export function parseStrictResolution(value: unknown): { width: number; height: number } {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d+)\s*[*x×]\s*(\d+)$/i);
  if (!match) throw new Error("invalid resolution: expected WIDTHxHEIGHT");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("invalid resolution: dimensions must be positive integers");
  }
  if (
    width < MIN_SCREEN_WIDTH || height < MIN_SCREEN_HEIGHT
    || width > MAX_SCREEN_DIMENSION || height > MAX_SCREEN_DIMENSION
  ) {
    throw new Error(
      `invalid resolution: width must be ${MIN_SCREEN_WIDTH}-${MAX_SCREEN_DIMENSION} and height must be ${MIN_SCREEN_HEIGHT}-${MAX_SCREEN_DIMENSION}`,
    );
  }
  return { width, height };
}

/** Parse a proxy edit/import strictly while retaining main's URL/IPv6/SOCKS5 support. */
export function parseStrictProxy(type: unknown, value: unknown): ProxySpec | null {
  const raw = String(value ?? "").trim();
  // An explicit blank is the supported representation for no proxy. Import
  // persistence separately prevents it from erasing an existing proxy.
  if (!raw) {
    // A supplied type is still operator input. Reject an unsupported protocol
    // instead of silently accepting it as a direct profile.
    normalizeProxyType(type);
    return null;
  }
  return parseProxySpec(type, raw);
}

/**
 * Convert one parsed record map into a Profile. Returns null only if the
 * record has no id.
 *
 * We intentionally do NOT require specific columns like ua/resolution here:
 * AdsPower's "Export accounts" lets the operator choose which fields to
 * include. Missing fields get defaults for a genuinely new profile; the
 * field-presence metadata below lets persistence preserve stored values when
 * this is a sparse re-import of an existing id.
 */
export interface ParsedProfileImport {
  profile: Profile;
  cookiesStripped: number;
  /** Exact source keys present in this record. Used to merge safe re-imports. */
  presentFields: string[];
  /** Raw values for presence-sensitive safety checks; never persisted or logged. */
  sourceFields: Record<string, string>;
  /** Explicit fields that were present but could not be parsed safely. */
  validationErrors: string[];
}

export function recordToProfile(
  rec: Record<string, string>,
): ParsedProfileImport | null {
  const id = (rec.id ?? "").trim();
  if (!id) return null;

  let cookieJson: unknown = [];
  const validationErrors: string[] = [];
  if (!isSafeProfileId(id)) validationErrors.push(PROFILE_ID_ERROR);
  const rawCookie = rec.cookie ?? "";
  if (rawCookie.trim()) {
    try {
      cookieJson = JSON.parse(rawCookie);
    } catch {
      cookieJson = [];
      validationErrors.push("cookie is not valid JSON");
    }
  }
  if (rawCookie.trim() && !Array.isArray(cookieJson)) {
    validationErrors.push("cookie must be a JSON array");
  }
  if (Array.isArray(cookieJson)) {
    const malformed = cookieJson.filter((c) => {
      if (!c || typeof c !== "object") return true;
      return !String((c as any).name ?? "") || !String((c as any).domain ?? "");
    }).length;
    if (malformed) validationErrors.push(`cookie contains ${malformed} malformed entr${malformed === 1 ? "y" : "ies"}`);
  }
  const { cookies, stripped } = normalizeCookies(cookieJson);
  const rawResolution = rec.resolution ?? "";
  let { width, height } = parseResolution(rawResolution);
  if (Object.hasOwn(rec, "resolution") && rawResolution.trim()) {
    try {
      ({ width, height } = parseStrictResolution(rawResolution));
    } catch (error) {
      validationErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  let proxy: ProxySpec | null = null;
  let proxyError: string | undefined;
  try {
    proxy = parseStrictProxy(rec.proxytype ?? "", rec.proxy ?? "");
  } catch (error) {
    proxyError = error instanceof Error ? error.message : String(error);
    validationErrors.push(proxyError);
  }

  const profile: Profile = {
    id,
    accId: (rec.acc_id ?? "").trim(),
    name: (rec.name ?? "").trim(),
    group: (rec.group ?? "").trim(),
    platform: (rec.platform ?? "").trim(),
    // Older account CSV/txt exports often used `email` as the login column.
    // Keep that import behavior while also retaining it in the new email field.
    username: (rec.username ?? rec.email ?? "").trim(),
    password: rec.password ?? "",
    email: (rec.email ?? "").trim(),
    emailPassword: rec.emailpassword ?? rec.email_password ?? "",
    twofa: (rec.fakey ?? "").trim(),
    proxy,
    ...(proxyError ? { proxyError } : {}),
    ua: (rec.ua ?? "").trim(),
    timezone: "", // resolved by geoip at import (see geoip.ts)
    screenWidth: width,
    screenHeight: height,
    fingerprintSeed: deterministicSeed(id),
    cookies,
    seeded: false,
  };
  return {
    profile,
    cookiesStripped: stripped,
    presentFields: Object.keys(rec),
    sourceFields: { ...rec },
    validationErrors,
  };
}

export interface ImportSummary {
  profiles: Profile[];
  /** Profiles plus field-presence and validation metadata for safe persistence. */
  imports: ParsedProfileImport[];
  recordCount: number;
  cookiesStripped: number;
  skipped: number;
  /** Invalid records reported without aborting the rest of the export. */
  errors: Array<{ id: string; error: string; quarantined?: boolean }>;
}

/** Parse a full export into profiles plus an import summary. Pure; no I/O. */
export function parseExport(text: string): ImportSummary {
  const records = splitRecords(text);
  const profiles: Profile[] = [];
  const imports: ParsedProfileImport[] = [];
  let cookiesStripped = 0;
  let skipped = 0;
  const errors: ImportSummary["errors"] = [];
  for (const rec of records) {
    let out: ReturnType<typeof recordToProfile>;
    try {
      out = recordToProfile(rec);
    } catch (error) {
      skipped++;
      errors.push({
        id: (rec.id ?? "").trim(),
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!out) {
      skipped++;
      continue;
    }
    if (out.profile.proxyError) {
      errors.push({ id: out.profile.id, error: out.profile.proxyError, quarantined: true });
    }
    profiles.push(out.profile);
    imports.push(out);
    cookiesStripped += out.cookiesStripped;
  }
  return { profiles, imports, recordCount: records.length, cookiesStripped, skipped, errors };
}

// ===========================================================================
// File-based bulk UPDATE (AdsPower "Update profile" flow).
//
// Unlike parseExport — which builds whole Profiles, defaulting every absent
// field — an update must be PARTIAL: only the fields actually present in the
// file may change, so cookies/fingerprint/untouched columns survive. So this
// returns per-id field maps (not Profiles) that the caller feeds to applyEdits,
// which writes only the keys present. The file is matched to existing profiles
// by `id`; an id with no matching profile is reported, never created.
// ===========================================================================

export interface ProfileUpdate {
  id: string;
  /** Only the editable fields present in the file. Keys match applyEdits(). */
  set: Record<string, string>;
}
export interface UpdateFileSummary {
  updates: ProfileUpdate[];
  skipped: number; // rows/blocks with no usable id
}

// Source field name (txt key / csv header alias) -> applyEdits set key.
const UPDATE_KEYMAP: Record<string, string> = {
  name: "name",
  group: "group",
  platform: "platform",
  site: "platform",
  username: "username",
  user: "username",
  login: "username",
  email: "email",
  mail: "email",
  password: "password",
  pass: "password",
  pwd: "password",
  emailpassword: "emailPassword",
  email_password: "emailPassword",
  mailpassword: "emailPassword",
  mail_password: "emailPassword",
  twofa: "twofa",
  "2fa": "twofa",
  fakey: "twofa",
  otp: "twofa",
  proxy: "proxy",
  proxytype: "proxyType",
  "proxy type": "proxyType",
  resolution: "resolution",
  screen: "resolution",
};

/**
 * Parse an uploaded update file. Accepts the same two shapes the importer does:
 * an AdsPower `.txt` export (key=value blocks) or a CSV with a header row. Either
 * way every record MUST carry an `id`. Detection: a comma-bearing first line with
 * an `id` column is CSV; anything else is treated as key=value blocks.
 */
export function parseUpdateFile(text: string): UpdateFileSummary {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const looksCsv = firstLine.includes(",") && /(^|,)\s*"?id"?\s*(,|$)/i.test(firstLine);
  return looksCsv ? parseCsvUpdates(text) : parseTxtUpdates(text);
}

/**
 * Turn already-tabulated rows into profile updates. Shared by the CSV reader
 * below and by the .xlsx reader in ui.ts so a spreadsheet re-upload obeys the
 * same UPDATE_KEYMAP, the same id matching, and the same "identity columns are
 * inert" rule as every other update file.
 */
export function rowsToUpdates(rows: Record<string, string>[]): UpdateFileSummary {
  const updates: ProfileUpdate[] = [];
  let skipped = 0;
  for (const row of rows) {
    const id = (row.id ?? "").trim();
    if (!id) {
      // A wholly blank row is padding (Excel emits plenty); only a row that
      // carried data but no id is a row the operator will want to hear about.
      if (Object.values(row).some((v) => (v ?? "").trim() !== "")) skipped++;
      continue;
    }
    updates.push({ id, set: mapPresentFields(row) });
  }
  return { updates, skipped };
}

function mapPresentFields(src: Record<string, string>): Record<string, string> {
  const set: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    const target = UPDATE_KEYMAP[k.toLowerCase().trim()];
    if (target) set[target] = v;
  }
  return set;
}

function parseTxtUpdates(text: string): UpdateFileSummary {
  const updates: ProfileUpdate[] = [];
  let skipped = 0;
  for (const block of text.split(RECORD_SEPARATOR)) {
    const map = parseBlock(block);
    const id = (map.id ?? "").trim();
    if (!id) {
      if (Object.keys(map).length) skipped++;
      continue;
    }
    updates.push({ id, set: mapPresentFields(map) });
  }
  return { updates, skipped };
}

/** Minimal CSV row splitter: handles double-quoted cells (incl. commas + "" escapes). */
function splitCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ",") {
      out.push(cur); cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function parseCsvUpdates(text: string): UpdateFileSummary {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { updates: [], skipped: 0 };
  const header = splitCsvRow(lines[0]!).map((h) => h.toLowerCase());
  if (!header.includes("id")) return { updates: [], skipped: lines.length - 1 };
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvRow(line);
    const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      // A short row omits trailing fields; it does not explicitly clear them.
      // A present trailing comma still creates an empty cell and remains the
      // intentional-clear representation.
      if (c < cells.length) row[header[c]!] = cells[c]!;
    }
    return row;
  });
  return rowsToUpdates(rows);
}

// ===========================================================================
// Export serializers — hand profiles back out for offline editing (then
// re-uploaded through parseUpdateFile). Both include `id` so the update can
// match rows; the .txt form is a faithful AdsPower export (re-importable as new
// profiles too), the .csv form is a trimmed, spreadsheet-friendly view.
// ===========================================================================

function proxyToString(p: Profile): string {
  const px = p.proxy;
  if (!px) return "";
  return proxyLegacyString(px);
}

/**
 * One profile as the flat `key=value` field map both full-fidelity exports are
 * built from. Kept in one place so the .txt block and the .xlsx sheet cannot
 * drift into encoding the same profile two different ways.
 */
function profileFields(p: Profile): Record<string, string> {
  return {
    acc_id: p.accId,
    id: p.id,
    group: p.group,
    platform: p.platform ?? "",
    name: p.name,
    username: p.username,
    password: p.password,
    email: p.email ?? "",
    emailpassword: p.emailPassword ?? "",
    fakey: p.twofa,
    cookie: JSON.stringify(p.cookies),
    proxytype: p.proxy?.type ?? "",
    proxy: proxyToString(p),
    ua: p.ua,
    resolution: `${p.screenWidth}*${p.screenHeight}`,
  };
}

/** Field order of the `key=value` block export. */
const TXT_KEYS = [
  "acc_id", "id", "group", "platform", "name", "username", "password",
  "email", "emailpassword", "fakey", "cookie", "proxytype", "proxy", "ua", "resolution",
] as const;

/**
 * Columns of the Excel export. Same fields as the .txt block, but with `id`
 * first: it is the column a re-upload matches rows on, so it belongs where a
 * human editing the sheet will see it without scrolling.
 */
export const XLSX_COLUMNS = [
  "id", "acc_id", "group", "platform", "name", "username", "password",
  "email", "emailpassword", "fakey", "cookie", "proxytype", "proxy", "ua", "resolution",
] as const;

/** Serialize profiles to the AdsPower `key=value` export format. */
export function serializeAdsTxt(profiles: Profile[]): string {
  const blocks = profiles.map((p) => {
    const f = profileFields(p);
    return [...TXT_KEYS.map((k) => `${k}=${f[k]}`), "******************"].join("\n");
  });
  return blocks.join("\n") + (blocks.length ? "\n" : "");
}

/**
 * Serialize profiles to the header + rows of a single spreadsheet sheet. The
 * caller turns these into a workbook (xlsx.ts); keeping the shaping here means
 * the sheet and the .txt block stay one decision, not two.
 */
export function serializeXlsxRows(profiles: Profile[]): { headers: string[]; rows: string[][] } {
  return {
    headers: [...XLSX_COLUMNS],
    rows: profiles.map((p) => {
      const f = profileFields(p);
      return XLSX_COLUMNS.map((k) => f[k]!);
    }),
  };
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Serialize profiles to a credential-editing CSV. The `id` column is first and
 * must be kept for the update to match. Cookies/UA/fingerprint are deliberately
 * omitted — this view is for editing groups, proxies, and account credentials.
 */
export function serializeCsv(profiles: Profile[]): string {
  const cols = ["id", "name", "group", "platform", "proxy", "proxytype", "username", "password", "email", "emailpassword", "twofa", "resolution"];
  const rows = profiles.map((p) => [
    p.id, p.name, p.group, p.platform ?? "", proxyToString(p), p.proxy?.type ?? "",
    p.username, p.password, p.email ?? "", p.emailPassword ?? "", p.twofa, `${p.screenWidth}*${p.screenHeight}`,
  ].map((c) => csvCell(String(c ?? ""))).join(","));
  return [cols.join(","), ...rows].join("\n") + "\n";
}
