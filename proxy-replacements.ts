import { parse } from "csv-parse/sync";
import type { CloudClient } from "./cloud-client.ts";
import type {
  ProxyReplacementRequestRow,
  ProxyReplacementResult,
  ProxyReplacementsRequest,
  ProxyReplacementsResponse,
} from "./contracts/cloud-v1.ts";

const INPUT_KEYS = new Set(["csv", "dryRun", "replacements"]);
const REPLACEMENT_STATUSES = new Set(["ready", "updated", "unchanged", "missing", "skipped"]);
const REPLACEMENT_CODES = new Set([
  "invalid_row",
  "invalid_proxy",
  "expected_version_required",
  "duplicate_selector",
  "no_editable_match",
  "ambiguous_username",
  "duplicate_target",
  "profile_trashed",
  "profile_open",
  "version_conflict",
]);
const CSV_PROXY_COLUMNS = ["type", "host", "port", "user", "pass"] as const;
const CSV_OPTIONAL_COLUMNS = new Set(["expectedVersion"]);
const CSV_SELECTORS = ["profileId", "username"] as const;

export class ProxyReplacementInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyReplacementInputError";
  }
}

interface ProxyReplacementCloudClient {
  replaceProfileProxies(request: ProxyReplacementsRequest): Promise<ProxyReplacementsResponse>;
}

function inputError(message: string): never {
  throw new ProxyReplacementInputError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function parseProxyReplacementCsv(csv: string): ProxyReplacementRequestRow[] {
  let records: string[][];
  try {
    records = parse(csv, {
      bom: true,
      relax_column_count: false,
      skip_empty_lines: true,
    }) as string[][];
  } catch {
    inputError("CSV input is invalid");
  }
  if (records.length < 2) inputError("CSV input must contain a header and at least one row");

  const headers = records[0]!.map((header) => header.trim());
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    inputError("CSV headers must be unique and non-empty");
  }
  const selectors = CSV_SELECTORS.filter((selector) => headers.includes(selector));
  if (selectors.length !== 1) inputError("CSV must contain exactly one selector header: username or profileId");
  if (CSV_PROXY_COLUMNS.some((column) => !headers.includes(column))) {
    inputError("CSV must contain type, host, port, user, and pass headers");
  }
  const allowed = new Set<string>([...CSV_SELECTORS, ...CSV_PROXY_COLUMNS, ...CSV_OPTIONAL_COLUMNS]);
  if (headers.some((header) => !allowed.has(header))) inputError("CSV contains an unsupported header");

  const selector = selectors[0]!;
  return records.slice(1).map((record) => {
    const values = Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""]));
    const replacement: Record<string, unknown> = {
      [selector]: values[selector]!,
      proxy: {
        type: values.type!,
        host: values.host!,
        port: values.port!,
        user: values.user!,
        pass: values.pass!,
      },
    };
    const rawVersion = values.expectedVersion;
    if (rawVersion !== undefined && rawVersion !== "") {
      const normalized = rawVersion.trim();
      const version = Number(normalized);
      replacement.expectedVersion = /^\d+$/.test(normalized) && Number.isSafeInteger(version) && version > 0
        ? version
        : rawVersion;
    }
    return replacement as unknown as ProxyReplacementRequestRow;
  });
}

function normalizeInput(input: unknown): { dryRun: boolean; replacements: ProxyReplacementRequestRow[] } {
  if (!isObject(input)) inputError("request parameters must be an object");
  if (Object.keys(input).some((key) => !INPUT_KEYS.has(key))) inputError("request parameters contain an unsupported field");
  if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") inputError("dryRun must be boolean");

  const hasReplacements = hasOwn(input, "replacements");
  const hasCsv = hasOwn(input, "csv");
  if (hasReplacements === hasCsv) inputError("provide exactly one of replacements or csv");

  if (hasCsv) {
    if (typeof input.csv !== "string" || !input.csv) inputError("csv must be a non-empty string");
    return { dryRun: input.dryRun ?? true, replacements: parseProxyReplacementCsv(input.csv) };
  }
  if (!Array.isArray(input.replacements) || input.replacements.length === 0) {
    inputError("replacements must be a non-empty array");
  }
  return {
    dryRun: input.dryRun ?? true,
    replacements: input.replacements as ProxyReplacementRequestRow[],
  };
}

function invalidCloudResponse(): never {
  throw new Error("AliasMode Cloud returned an invalid proxy replacement response");
}

function orderedResults(
  response: ProxyReplacementsResponse,
  expectedDryRun: boolean,
  expectedLength: number,
): ProxyReplacementResult[] {
  if (response.dryRun !== expectedDryRun || !Array.isArray(response.results) || response.results.length !== expectedLength ||
      !Array.isArray(response.missingUsernames) || response.missingUsernames.some((value) => typeof value !== "string")) {
    invalidCloudResponse();
  }
  const ordered = new Array<ProxyReplacementResult>(expectedLength);
  for (const value of response.results) {
    const result = value as unknown;
    if (!isObject(result) || !Number.isSafeInteger(result.index) || Number(result.index) < 0 ||
        Number(result.index) >= expectedLength || ordered[Number(result.index)]) {
      invalidCloudResponse();
    }
    if (typeof result.status !== "string" || !REPLACEMENT_STATUSES.has(result.status)) invalidCloudResponse();
    if (result.code !== undefined && (typeof result.code !== "string" || !REPLACEMENT_CODES.has(result.code))) {
      invalidCloudResponse();
    }
    if (result.profileId !== undefined && (typeof result.profileId !== "string" || !result.profileId)) invalidCloudResponse();
    for (const key of ["currentVersion", "previousVersion", "version"] as const) {
      if (result[key] !== undefined && (!Number.isSafeInteger(result[key]) || Number(result[key]) < 1)) {
        invalidCloudResponse();
      }
    }
    const safe: ProxyReplacementResult = {
      index: Number(result.index),
      status: result.status as ProxyReplacementResult["status"],
      ...(result.code === undefined ? {} : { code: result.code as ProxyReplacementResult["code"] }),
      ...(result.profileId === undefined ? {} : { profileId: result.profileId }),
      ...(result.currentVersion === undefined ? {} : { currentVersion: Number(result.currentVersion) }),
      ...(result.previousVersion === undefined ? {} : { previousVersion: Number(result.previousVersion) }),
      ...(result.version === undefined ? {} : { version: Number(result.version) }),
    };
    ordered[safe.index] = safe;
  }
  if (ordered.some((result) => !result)) invalidCloudResponse();
  return ordered;
}

function missingUsernamesFor(
  results: ProxyReplacementResult[],
  replacements: ProxyReplacementRequestRow[],
): string[] {
  const missing: string[] = [];
  for (let index = 0; index < results.length; index++) {
    const replacement = replacements[index] as unknown;
    if (results[index]!.status === "missing" && isObject(replacement) && typeof replacement.username === "string") {
      missing.push(replacement.username);
    }
  }
  return missing;
}

function mergedResponse(
  dryRun: boolean,
  results: ProxyReplacementResult[],
  missingUsernames: string[],
): ProxyReplacementsResponse {
  return {
    ok: true,
    dryRun,
    counts: {
      received: results.length,
      matched: results.filter((result) => !!result.profileId).length,
      ready: results.filter((result) => result.status === "ready").length,
      updated: results.filter((result) => result.status === "updated").length,
      unchanged: results.filter((result) => result.status === "unchanged").length,
      missing: results.filter((result) => result.status === "missing").length,
      skipped: results.filter((result) => result.status === "skipped").length,
    },
    results,
    missingUsernames,
  };
}

export async function runProxyReplacements(
  client: ProxyReplacementCloudClient | Pick<CloudClient, "replaceProfileProxies">,
  input: unknown,
): Promise<ProxyReplacementsResponse> {
  const { dryRun, replacements } = normalizeInput(input);
  const preflight = await client.replaceProfileProxies({ dryRun: true, replacements });
  const preflightResults = orderedResults(preflight, true, replacements.length);
  if (dryRun) return mergedResponse(true, preflightResults, missingUsernamesFor(preflightResults, replacements));

  const ready = preflightResults.filter((result) => result.status === "ready");
  if (ready.length === 0) {
    return mergedResponse(false, preflightResults, missingUsernamesFor(preflightResults, replacements));
  }

  const applyReplacements = ready.map((result) => {
    if (!result.profileId || !Number.isSafeInteger(result.currentVersion) || result.currentVersion! < 1) {
      invalidCloudResponse();
    }
    const original = replacements[result.index];
    if (!original || !isObject(original) || !isObject(original.proxy)) invalidCloudResponse();
    return {
      profileId: result.profileId,
      expectedVersion: result.currentVersion!,
      proxy: original.proxy,
    } as ProxyReplacementRequestRow;
  });
  const applied = await client.replaceProfileProxies({ dryRun: false, replacements: applyReplacements });
  const appliedResults = orderedResults(applied, false, applyReplacements.length);
  const finalResults = [...preflightResults];
  for (let index = 0; index < ready.length; index++) {
    const originalIndex = ready[index]!.index;
    finalResults[originalIndex] = { ...appliedResults[index]!, index: originalIndex };
  }
  return mergedResponse(false, finalResults, missingUsernamesFor(finalResults, replacements));
}
