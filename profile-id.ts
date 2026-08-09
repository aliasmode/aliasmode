/**
 * Profile ids become SQLite keys, URL path components, and user-data directory
 * names. Keep one deliberately small positive grammar across all three uses:
 * it must be safe as a path component (no traversal or separators) and as a
 * distinct directory name on every supported host. AdsPower ids and canonical
 * UUIDs fit without escaping. Mixed-case ids the earlier release persisted
 * verbatim stay operable — the grammar is about path safety, not case policy,
 * so an already-stored profile can still be started and stopped after upgrade.
 */
export const MAX_PROFILE_ID_LENGTH = 128;
export const PROFILE_ID_ERROR =
  `invalid profile id: expected 1-${MAX_PROFILE_ID_LENGTH} characters, starting with a letter or digit, containing only a-z, A-Z, 0-9, _ or -, and not a Windows device name`;

// These names alias Windows device handles even when used as directory names.
// AliasMode's target fleet is Windows, so accept no id that cannot safely name a
// distinct user-data directory on every supported host. Matched case-insensitively
// because Windows resolves `CON` and `con` to the same device.
const WINDOWS_DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function isSafeProfileId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_PROFILE_ID_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
    && !WINDOWS_DEVICE_NAMES.test(value);
}

export function assertSafeProfileId(value: unknown): asserts value is string {
  if (!isSafeProfileId(value)) throw new Error(PROFILE_ID_ERROR);
}
