import { runPlaywrightWorker } from "./playwright-runtime.ts";

export type SearchProviderSetupResult = {
  status: "already-default" | "configured" | "kept-existing";
  engine: string;
};

export type SearchProviderBootstrapOptions = {
  executablePath: string;
  executableSha256: string;
  userDataDir: string;
};

type SearchEngineSummary = {
  default?: boolean;
  displayName?: string;
  keyword?: string;
  name?: string;
  url?: string;
};

const CONFIGURE_TIMEOUT_MS = 20_000;

/**
 * Return the no-op result for a usable current default, or null when AliasMode
 * should repair the profile. Keeping a real provider protects an operator's
 * explicit choice; only Chromium's missing/"No Search" default is replaced.
 */
export function existingSearchProvider(
  engines: SearchEngineSummary[],
): SearchProviderSetupResult | null {
  const current = engines.find((engine) => engine.default);
  if (!current || isNoSearchProvider(current)) return null;

  const engine = current.displayName || current.name || current.keyword || "Current search provider";
  return {
    status: isDuckDuckGo(current) ? "already-default" : "kept-existing",
    engine,
  };
}

/**
 * Configure the persistent profile in a separate headless CloakBrowser before
 * its managed, visible generation starts. This never opens or navigates a user tab.
 */
export async function ensureDuckDuckGoDefault(
  options: SearchProviderBootstrapOptions,
): Promise<SearchProviderSetupResult> {
  return runPlaywrightWorker<SearchProviderSetupResult>("search-provider", {
    executablePath: options.executablePath,
    executableSha256: options.executableSha256,
    userDataDir: options.userDataDir,
    launchTimeoutMs: CONFIGURE_TIMEOUT_MS,
  }, { timeoutMs: CONFIGURE_TIMEOUT_MS + 15_000 });
}

function isDuckDuckGo(engine: SearchEngineSummary): boolean {
  return [engine.keyword, engine.name, engine.displayName, engine.url]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes("duckduckgo");
}

function isNoSearchProvider(engine: SearchEngineSummary): boolean {
  const identity = [engine.keyword, engine.name, engine.displayName, engine.url]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const url = String(engine.url || "").trim().toLowerCase();
  return identity.includes("no search") || /^https?:\/\/%s\/?$/.test(url);
}
