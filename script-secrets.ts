/**
 * Masking of saved login values in script logs, status and history for AI clients.
 * No imports: agent-control.ts and scheduler.ts use these, and scripts.ts imports agent-control.ts,
 * so taking them from scripts.ts makes an import cycle that hangs the compiled sidecar at startup.
 */

export const CREDENTIAL_FIELDS = ["username", "password", "email", "emailPassword", "twofa"] as const;
/** The most bytes one log read returns. */
export const LOG_READ_BYTES = 64 * 1024;

/** The saved login values worth masking (4+ characters), longest first, so a value inside another is not left half shown. */
export function maskableSecrets(values: Iterable<string>): string[] {
  return [...new Set(values)].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length);
}

/** Replaces each saved login value in `text` with ***. */
export function maskSecrets(text: string, values: Iterable<string>): string {
  return maskableSecrets(values).reduce((masked, secret) => masked.split(secret).join("***"), text);
}

export function maskProfiles<T extends { error?: string; warning?: string }>(profiles: T[], values: Iterable<string>): T[] {
  const secrets = maskableSecrets(values);
  return profiles.map(({ error, warning, ...item }) => ({
    ...item,
    ...(error === undefined ? {} : { error: maskSecrets(error, secrets) }),
    ...(warning === undefined ? {} : { warning: maskSecrets(warning, secrets) }),
  }) as T);
}
