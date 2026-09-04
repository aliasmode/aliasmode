import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { generateId } from "./create.ts";
import { FP_BLOCK_KEYS } from "./fingerprint-attestation.ts";
import { isSafeProfileId } from "./profile-id.ts";
import {
  decodeText,
  parseExport,
  recordsToImportSummary,
  type ImportSummary,
} from "./parse.ts";
import { readXlsx } from "./xlsx.ts";

type SourceRecord = Record<string, unknown>;
type IndexedRecord = Map<string, unknown>;

const JSON_CONTAINERS = new Set(["profiles", "browsers", "items", "data", "results", "profile", "browser"]);
const NESTED_ROOTS = new Set([
  "profile", "browser", "browserprofile", "account", "credentials", "auth", "proxy", "network",
  "navigator", "fingerprint", "timezone", "screen", "display", "os", "parameters", "email",
]);

const ID_ALIASES = ["id", "profileid", "browserprofileid", "browserid", "profileuuid", "uuid"];
const NAME_ALIASES = ["name", "profilename", "browsername", "title", "profile"];

const STRING_FIELDS: Array<[string, string[]]> = [
  ["acc_id", ["accid", "externalid", "accountid", "sourceid"]],
  ["name", NAME_ALIASES],
  ["group", ["group", "groupname", "folder", "foldername", "folderid", "profilegroup", "profilefolder"]],
  ["platform", ["site", "website", "mainwebsite", "targetwebsite", "targetplatform", "profileplatform", "platform"]],
  ["username", ["username", "user", "login", "accountusername", "accountlogin", "credentialsusername", "credentialslogin", "accountcredentialsusername", "accountcredentialslogin"]],
  ["password", ["password", "pass", "pwd", "accountpassword", "credentialspassword", "accountcredentialspassword"]],
  ["email", ["email", "mail", "accountemail", "credentialsemail", "accountcredentialsemail"]],
  ["emailpassword", ["emailpassword", "mailpassword", "mailboxpassword", "credentialsemailpassword", "emailcredentialspassword"]],
  ["fakey", ["fakey", "twofa", "2fa", "totp", "otp", "totpsecret", "otpsecret", "twofasecret", "accounttwofa"]],
  ["ua", ["ua", "useragent", "useragentstring", "browseruseragent", "profileuseragent", "navigatoruseragent", "fingerprintnavigatoruseragent"]],
  ["seed", ["seed", "fingerprintseed", "profileseed"]],
];

const PROXY_VALUE_ALIASES = [
  "proxy", "proxyurl", "proxyserver", "proxyaddress", "proxystring", "proxyconnectionstring",
  "networkproxyserver", "parametersproxyserver", "browserproxyserver", "profileproxyserver",
];
const PROXY_TYPE_ALIASES = [
  "proxytype", "proxyprotocol", "proxyscheme", "proxymode", "networkproxytype", "parametersproxytype",
  "parametersproxymode", "browserproxytype", "profileproxytype",
];
const PROXY_HOST_ALIASES = [
  "proxyhost", "networkproxyhost", "parametersproxyhost", "browserproxyhost", "profileproxyhost",
];
const PROXY_PORT_ALIASES = [
  "proxyport", "networkproxyport", "parametersproxyport", "browserproxyport", "profileproxyport",
];
const PROXY_USER_ALIASES = [
  "proxyuser", "proxyusername", "proxylogin", "networkproxyusername", "parametersproxyuser",
  "parametersproxyusername", "browserproxyusername", "profileproxyusername",
];
const PROXY_PASS_ALIASES = [
  "proxypass", "proxypassword", "networkproxypassword", "parametersproxypass", "parametersproxypassword",
  "browserproxypassword", "profileproxypassword",
];
const COOKIE_ALIASES = ["cookie", "cookies", "cookiejson", "cookiesjson", "cookiedata", "cookiesdata", "sessioncookies", "browsercookies", "profilecookies"];
const RESOLUTION_ALIASES = [
  "resolution", "screen", "screensize", "screenresolution", "displayresolution", "viewport",
  "navigatorresolution", "fingerprintnavigatorresolution",
];
const SCREEN_WIDTH_ALIASES = ["screenwidth", "displaywidth", "viewportwidth", "navigatorscreenwidth"];
const SCREEN_HEIGHT_ALIASES = ["screenheight", "displayheight", "viewportheight", "navigatorscreenheight"];
const TIMEZONE_ALIASES = [
  "timezoneid", "timezonename", "timezonevalue", "timezonetimezone", "fingerprinttimezoneid",
  "fingerprinttimezone", "profiletimezone", "timezone",
];
const OS_ALIASES = [
  "platformos", "ostype", "operatingsystem", "operatingsystemtype", "profileos", "navigatorplatform",
  "fingerprintnavigatorplatform", "os",
];
const TAG_ALIASES = ["tags", "tag", "labels", "profiletags"];
const EXTENSION_ALIASES = ["extensions", "extensionids", "browserextensions", "profileextensions"];

function normalizedKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function importedProfileId(externalId: string): string {
  const slug = externalId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 108);
  const digest = createHash("sha256").update(externalId).digest("hex").slice(0, 12);
  return slug ? `import-${slug}-${digest}` : `import-${digest}`;
}

function isObject(value: unknown): value is SourceRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function indexRecord(record: SourceRecord): IndexedRecord {
  const index = new Map<string, unknown>();
  const walk = (value: SourceRecord, prefix: string, depth: number) => {
    for (const [rawKey, child] of Object.entries(value)) {
      const key = normalizedKey(rawKey);
      if (!key) continue;
      const path = `${prefix}${key}`;
      if (!index.has(path)) index.set(path, child);
      if (isObject(child) && depth < 3) walk(child, path, depth + 1);
    }
  };
  for (const [rawKey, value] of Object.entries(record)) {
    const key = normalizedKey(rawKey);
    if (!key) continue;
    if (!index.has(key)) index.set(key, value);
    if (isObject(value) && NESTED_ROOTS.has(key)) walk(value, key, 1);
  }
  return index;
}

interface FoundValue {
  present: boolean;
  value?: unknown;
}

function find(index: IndexedRecord, aliases: readonly string[]): FoundValue {
  for (const alias of aliases) {
    if (index.has(alias)) return { present: true, value: index.get(alias) };
  }
  return { present: false };
}

function scalar(value: unknown): string | undefined {
  if (value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function list(value: unknown): string | undefined {
  if (value === null) return "";
  let items = value;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("[")) return value;
    try { items = JSON.parse(text); } catch { return value; }
  }
  if (!Array.isArray(items)) return scalar(items);
  return items.map((item) => {
    if (isObject(item)) return scalar(item.id) ?? scalar(item.name) ?? "";
    return scalar(item) ?? "";
  }).filter(Boolean).join(",");
}

function cookieArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (normalizedKey(key) === "cookies" && Array.isArray(child)) return child;
  }
  return null;
}

function decodeBase64Json(value: string): unknown | undefined {
  const compact = value.replace(/\s+/g, "");
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return undefined;
  try {
    const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64");
    if (decoded.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) return undefined;
    return JSON.parse(decoded.toString("utf8"));
  } catch {
    return undefined;
  }
}

function cookies(value: unknown): string {
  const direct = cookieArray(value);
  if (direct) return JSON.stringify(direct);
  if (typeof value !== "string") return value === null ? "" : JSON.stringify(value);
  const text = value.trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(cookieArray(parsed) ?? parsed);
  } catch {
    const decoded = decodeBase64Json(text);
    return decoded === undefined ? value : JSON.stringify(cookieArray(decoded) ?? decoded);
  }
}

function platformOs(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (/^(?:win|windows)$/.test(normalized) || normalized.includes("windows") || normalized.includes("win32") || normalized.includes("win64")) return "windows";
  if (/^(?:mac|macos|os x)$/.test(normalized) || normalized.includes("mac os") || normalized.includes("macintosh") || normalized.includes("darwin")) return "macos";
  if (normalized.includes("linux")) return "linux";
  return undefined;
}

function proxyValue(index: IndexedRecord, output: Record<string, string>): void {
  const combined = find(index, PROXY_VALUE_ALIASES);
  const combinedText = scalar(combined.value)?.trim();
  const host = scalar(find(index, PROXY_HOST_ALIASES).value)?.trim() ?? "";
  const port = scalar(find(index, PROXY_PORT_ALIASES).value)?.trim() ?? "";
  const user = scalar(find(index, PROXY_USER_ALIASES).value)?.trim() ?? "";
  const pass = scalar(find(index, PROXY_PASS_ALIASES).value) ?? "";
  if (combined.present && !isObject(combined.value)) {
    output.proxy = /^(?:none|direct|no\s*proxy)$/i.test(combinedText ?? "") ? "" : combinedText ?? "";
    if (output.proxy && (user || pass)) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(output.proxy)) {
        try {
          const url = new URL(output.proxy);
          if (!url.username && !url.password) {
            url.username = user;
            url.password = pass;
            output.proxy = url.toString();
          }
        } catch {
          // recordToProfile reports the invalid combined proxy.
        }
      } else if (/^(?:\[[^\]]+]|[^:]+):\d+$/.test(output.proxy)) {
        output.proxy += `:${user}:${pass}`;
      }
    }
  } else if (host || port) {
    const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    output.proxy = `${authority}:${port}${user || pass ? `:${user}:${pass}` : ""}`;
  } else if (combined.present) {
    output.proxy = "";
  } else {
    return;
  }

  const type = scalar(find(index, PROXY_TYPE_ALIASES).value)?.trim();
  if (output.proxy && type && !/^(?:none|direct|no\s*proxy)$/i.test(type)) output.proxytype = type;
}

function normalizeRecord(
  source: SourceRecord,
  reserved: Set<string>,
  generated: Set<string>,
  exists: (id: string) => boolean,
): Record<string, string> {
  const index = indexRecord(source);
  const sourceId = scalar(find(index, ID_ALIASES).value)?.trim() ?? "";
  const sourceName = scalar(find(index, NAME_ALIASES).value)?.trim() ?? "";
  if (!sourceId && !sourceName) throw new Error("profile row has no recognized profile id or name");

  const output: Record<string, string> = {};
  for (const [target, aliases] of STRING_FIELDS) {
    const found = find(index, aliases);
    if (!found.present) continue;
    const value = scalar(found.value);
    if (value !== undefined) output[target] = value;
  }

  if (sourceId && isSafeProfileId(sourceId)) {
    output.id = sourceId;
  } else if (sourceId) {
    output.id = importedProfileId(sourceId);
    output.acc_id = sourceId;
    generated.add(output.id);
  } else {
    output.id = generateId((id) => reserved.has(id) || generated.has(id) || exists(id));
    generated.add(output.id);
  }

  proxyValue(index, output);

  const cookie = find(index, COOKIE_ALIASES);
  if (cookie.present) output.cookie = cookies(cookie.value);

  const resolution = find(index, RESOLUTION_ALIASES);
  const resolutionText = scalar(resolution.value);
  if (resolution.present && resolutionText !== undefined) {
    output.resolution = resolutionText;
  } else {
    const width = scalar(find(index, SCREEN_WIDTH_ALIASES).value)?.trim();
    const height = scalar(find(index, SCREEN_HEIGHT_ALIASES).value)?.trim();
    if (width || height) output.resolution = `${width ?? ""}x${height ?? ""}`;
  }

  const timezone = find(index, TIMEZONE_ALIASES);
  const timezoneText = scalar(timezone.value);
  if (timezone.present && timezoneText !== undefined) output.timezone = timezoneText;

  const os = scalar(find(index, OS_ALIASES).value);
  const normalizedOs = os === undefined ? undefined : platformOs(os);
  if (normalizedOs) output.platform_os = normalizedOs;

  const tags = find(index, TAG_ALIASES);
  const tagText = list(tags.value);
  if (tags.present && tagText !== undefined) output.tags = tagText;
  const extensions = find(index, EXTENSION_ALIASES);
  const extensionText = list(extensions.value);
  if (extensions.present && extensionText !== undefined) output.extensions = extensionText;

  for (const field of FP_BLOCK_KEYS) {
    const found = find(index, [normalizedKey(field)]);
    const value = scalar(found.value);
    if (found.present && value !== undefined) output[field] = value;
  }
  return output;
}

function looksLikeProfile(record: SourceRecord): boolean {
  const index = indexRecord(record);
  const id = scalar(find(index, ID_ALIASES).value)?.trim();
  const name = scalar(find(index, NAME_ALIASES).value)?.trim();
  if (id) return true;
  if (!name) return false;
  return !(index.has("domain") && index.has("value") && !index.has("proxy") && !index.has("useragent"));
}

function jsonRecords(value: unknown): SourceRecord[] {
  if (Array.isArray(value)) {
    if (value.some((row) => !isObject(row))) throw new Error("profile array must contain objects");
    if (value.some((row) => !looksLikeProfile(row as SourceRecord))) {
      throw new Error("JSON export has a row without a recognized profile id or name");
    }
    return value as SourceRecord[];
  }
  if (!isObject(value)) throw new Error("JSON export must contain a profile object or array");

  for (const [key, child] of Object.entries(value)) {
    if (!JSON_CONTAINERS.has(normalizedKey(key))) continue;
    if (Array.isArray(child)) return jsonRecords(child);
  }
  for (const [key, child] of Object.entries(value)) {
    if (!JSON_CONTAINERS.has(normalizedKey(key)) || !isObject(child)) continue;
    return jsonRecords(child);
  }
  if (looksLikeProfile(value)) return [value];
  throw new Error("JSON export has no recognized profile id or name");
}

const HEADER_ALIASES = new Set([
  ...ID_ALIASES,
  ...STRING_FIELDS.flatMap(([, aliases]) => aliases),
  ...PROXY_VALUE_ALIASES, ...PROXY_TYPE_ALIASES, ...PROXY_HOST_ALIASES, ...PROXY_PORT_ALIASES,
  ...PROXY_USER_ALIASES, ...PROXY_PASS_ALIASES, ...COOKIE_ALIASES, ...RESOLUTION_ALIASES,
  ...SCREEN_WIDTH_ALIASES, ...SCREEN_HEIGHT_ALIASES, ...TIMEZONE_ALIASES, ...OS_ALIASES,
  ...TAG_ALIASES, ...EXTENSION_ALIASES, ...FP_BLOCK_KEYS.map(normalizedKey),
]);

function tableRecords(text: string): SourceRecord[] {
  let selected: string[][] | null = null;
  let selectedWidth = 0;
  let selectedHeaderScore = 0;
  for (const delimiter of [",", ";", "\t"]) {
    let rows: string[][];
    try {
      rows = parse(text, {
        bom: true,
        delimiter,
        relax_column_count: false,
        skip_empty_lines: true,
      }) as string[][];
    } catch {
      continue;
    }
    if (rows.length === 0) continue;
    const width = rows[0]!.length;
    const headerScore = rows[0]!.filter((cell) => HEADER_ALIASES.has(normalizedKey(cell))).length;
    if ((width > 1 || headerScore > 0) && (width > selectedWidth || (width === selectedWidth && headerScore > selectedHeaderScore))) {
      selected = rows;
      selectedWidth = width;
      selectedHeaderScore = headerScore;
    }
  }
  if (!selected) throw new Error("unsupported text export; upload TXT, CSV, JSON, or XLSX profile data");

  if (selectedHeaderScore > 0) {
    const headers = selected[0]!.map((header) => header.trim());
    return selected.slice(1).filter((row) => row.some((cell) => cell.trim())).map((row) => {
      const record: SourceRecord = {};
      for (let i = 0; i < headers.length && i < row.length; i++) record[headers[i]!] = row[i]!;
      return record;
    });
  }

  const columns = ["name", "proxy", "username", "password", "fakey"];
  return selected.filter((row) => row.some((cell) => cell.trim())).map((row) =>
    Object.fromEntries(columns.slice(0, row.length).map((column, index) => [column, row[index] ?? ""])),
  );
}

function normalizedSummary(
  records: SourceRecord[],
  exists: (id: string) => boolean,
): ImportSummary {
  const reserved = new Set<string>();
  for (const record of records) {
    const id = scalar(find(indexRecord(record), ID_ALIASES).value)?.trim() ?? "";
    if (isSafeProfileId(id)) reserved.add(id);
  }
  const generated = new Set<string>();
  return recordsToImportSummary(records.map((record) => normalizeRecord(record, reserved, generated, exists)));
}

function requireProfiles(summary: ImportSummary, name: string): ImportSummary {
  if (summary.recordCount === 0 || summary.profiles.length === 0) {
    throw new Error(`${name}: no profiles found in the export`);
  }
  return summary;
}

/** Parse one readable profile export without provider-specific client conversion. */
export async function parseImportFile(
  name: string,
  bytes: Uint8Array,
  exists: (id: string) => boolean = () => false,
): Promise<ImportSummary> {
  if (bytes.length === 0) throw new Error(`${name}: export file is empty`);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let rows: Record<string, string>[];
    try {
      rows = await readXlsx(bytes);
    } catch {
      throw new Error(
        `${name}: unsupported encrypted or proprietary profile archive; upload a readable TXT, CSV, JSON, or XLSX export`,
      );
    }
    return requireProfiles(normalizedSummary(rows, exists), name);
  }

  const text = decodeText(bytes);
  if (!text.trim()) throw new Error(`${name}: export file is empty`);
  const first = text.trimStart()[0];
  if (first === "{" || first === "[") {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (error) {
      throw new Error(`${name}: invalid JSON export (${error instanceof Error ? error.message : String(error)})`);
    }
    return requireProfiles(normalizedSummary(jsonRecords(parsed), exists), name);
  }
  if (/(?:^|\r?\n)id=/.test(text)) return requireProfiles(parseExport(text), name);
  return requireProfiles(normalizedSummary(tableRecords(text), exists), name);
}
