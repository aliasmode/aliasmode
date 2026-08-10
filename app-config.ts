import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export type AppMode = "unconfigured" | "local" | "cloud";

export interface AppConfig {
  version: 1;
  mode: AppMode;
  cloudUrl?: string;
  localAnalytics: boolean;
}

const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  mode: "unconfigured",
  localAnalytics: false,
};

export function normalizeSecureServiceUrl(value: string, label: string): string {
  const parsed = new URL(value.trim());
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !loopback) throw new Error(`${label} URL must use HTTPS`);
  return parsed.toString().replace(/\/$/, "");
}

function normalizeCloudUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return normalizeSecureServiceUrl(value, "Cloud");
}

export function parseAppConfig(value: unknown): AppConfig {
  if (!value || typeof value !== "object") throw new Error("AliasMode config must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error("unsupported AliasMode config version");
  if (raw.mode !== "unconfigured" && raw.mode !== "local" && raw.mode !== "cloud") {
    throw new Error("invalid AliasMode mode");
  }
  const cloudUrl = normalizeCloudUrl(raw.cloudUrl);
  if (raw.mode === "cloud" && !cloudUrl) throw new Error("Cloud mode requires a Cloud URL");
  return {
    version: 1,
    mode: raw.mode,
    ...(cloudUrl ? { cloudUrl } : {}),
    localAnalytics: raw.localAnalytics === true,
  };
}

export function legacyHubUrl(
  config: AppConfig,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return config.mode === "unconfigured" ? env.HUB_URL : undefined;
}

export class AppConfigStore {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  read(): AppConfig {
    if (!existsSync(this.path)) return { ...DEFAULT_CONFIG };
    return parseAppConfig(JSON.parse(readFileSync(this.path, "utf8")));
  }

  write(config: AppConfig): AppConfig {
    const normalized = parseAppConfig(config);
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    return normalized;
  }

  setMode(mode: Exclude<AppMode, "unconfigured">, cloudUrl?: string): AppConfig {
    const current = this.read();
    return this.write({ ...current, mode, ...(mode === "cloud" ? { cloudUrl } : { cloudUrl: undefined }) });
  }
}
