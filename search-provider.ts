import { runPlaywrightWorker } from "./playwright-runtime.ts";

export type SearchProviderSetupResult = {
  status: "already-default" | "configured";
  engine: string;
};

export type SearchProviderBootstrapOptions = {
  executablePath: string;
  executableSha256: string;
  userDataDir: string;
  endpoint: string;
};

type SearchEngineSummary = {
  default?: boolean;
  displayName?: string;
  keyword?: string;
  name?: string;
  url?: string;
};

const CONFIGURE_TIMEOUT_MS = 20_000;

/** Return the no-op result only when DuckDuckGo is already the default. */
export function existingSearchProvider(
  engines: SearchEngineSummary[],
): SearchProviderSetupResult | null {
  const current = engines.find((engine) => engine.default);
  if (!current || !isDuckDuckGo(current)) return null;

  return {
    status: "already-default",
    engine: current.displayName || current.name || current.keyword || "DuckDuckGo",
  };
}

/** Configure DuckDuckGo through a temporary page in the running managed browser. */
export async function ensureDuckDuckGoDefault(
  options: SearchProviderBootstrapOptions,
): Promise<SearchProviderSetupResult> {
  return runPlaywrightWorker<SearchProviderSetupResult>("search-provider", {
    executablePath: options.executablePath,
    executableSha256: options.executableSha256,
    userDataDir: options.userDataDir,
    endpoint: options.endpoint,
    connectTimeoutMs: CONFIGURE_TIMEOUT_MS,
  }, { timeoutMs: CONFIGURE_TIMEOUT_MS + 15_000 });
}

function isDuckDuckGo(engine: SearchEngineSummary): boolean {
  if (typeof engine.url !== "string") return false;
  try {
    const url = new URL(engine.url);
    return url.protocol === "https:"
      && (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com"));
  } catch {
    return false;
  }
}
