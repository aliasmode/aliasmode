import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export interface StatePaths {
  root: string;
  database: string;
  profiles: string;
  extensions: string;
  inbox: string;
  reports: string;
  browser: string;
  config: string;
  operatorId: string;
  pendingSync: string;
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
    extensions: resolve(absolute, "extensions"),
    inbox: resolve(absolute, "inbox"),
    reports: resolve(absolute, "reports"),
    browser: resolve(absolute, "browser"),
    config: resolve(absolute, "config.json"),
    operatorId: resolve(absolute, ".operator-id"),
    pendingSync: resolve(absolute, "pending-sync.sqlite"),
    migration: resolve(absolute, "migration.json"),
  };
}

export function ensureStateDirectories(paths: StatePaths): void {
  for (const path of [paths.root, paths.profiles, paths.extensions, paths.inbox, paths.reports, paths.browser]) {
    mkdirSync(path, { recursive: true });
  }
}
