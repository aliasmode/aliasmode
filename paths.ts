import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export interface StatePaths {
  root: string;
  database: string;
  profiles: string;
  cloudDatabase: string;
  cloudProfiles: string;
  extensions: string;
  inbox: string;
  reports: string;
  browser: string;
  config: string;
  operatorId: string;
  pendingSync: string;
  pendingSyncKey: string;
  migration: string;
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

export function resolveStateRoot(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  return resolve(cwd, flag(args, "state-root") ?? env.ALIASMODE_STATE_ROOT ?? ".");
}

export function statePaths(root: string): StatePaths {
  const absolute = resolve(root);
  return {
    root: absolute,
    database: resolve(absolute, "profiles.sqlite"),
    profiles: resolve(absolute, "profiles"),
    cloudDatabase: resolve(absolute, "cloud-cache", "profiles.sqlite"),
    cloudProfiles: resolve(absolute, "cloud-cache", "profiles"),
    extensions: resolve(absolute, "extensions"),
    inbox: resolve(absolute, "inbox"),
    reports: resolve(absolute, "reports"),
    browser: resolve(absolute, "browser"),
    config: resolve(absolute, "config.json"),
    operatorId: resolve(absolute, ".operator-id"),
    pendingSync: resolve(absolute, "pending-sync.sqlite"),
    pendingSyncKey: resolve(absolute, "pending-sync.key"),
    migration: resolve(absolute, "migration.json"),
  };
}

export function profileDataPaths(
  paths: StatePaths,
  cloud: boolean,
  explicitDatabase?: string,
  explicitProfiles?: string,
): { database: string; profiles: string } {
  const local = {
    database: explicitDatabase ? resolve(explicitDatabase) : paths.database,
    profiles: explicitProfiles ? resolve(explicitProfiles) : paths.profiles,
  };
  return cloud
    ? {
        database: explicitDatabase ? `${local.database}.cloud-cache` : paths.cloudDatabase,
        profiles: explicitProfiles ? resolve(local.profiles, "cloud-cache") : paths.cloudProfiles,
      }
    : local;
}

export function ensureStateDirectories(paths: StatePaths): void {
  for (const path of [paths.root, paths.profiles, paths.cloudProfiles, paths.extensions, paths.inbox, paths.reports, paths.browser]) {
    mkdirSync(path, { recursive: true });
  }
}
