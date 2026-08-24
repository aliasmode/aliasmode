type BrowserContext = any;
import { runPlaywrightWorker } from "./playwright-runtime.ts";

export type SearchProviderSetupResult = {
  status: "already-default" | "configured" | "kept-existing";
  engine: string;
};

type SearchEngineSummary = {
  default?: boolean;
  displayName?: string;
  keyword?: string;
  name?: string;
  url?: string;
};

const SETTINGS_URL = "chrome://settings/searchEngines";
const CONFIGURE_TIMEOUT_MS = 15_000;

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
 * Configure a persistent CloakBrowser profile over its existing CDP endpoint.
 * The connection is detached after the settings change; the browser stays open.
 */
export async function ensureDuckDuckGoDefault(
  ws: string,
): Promise<SearchProviderSetupResult> {
  return runPlaywrightWorker<SearchProviderSetupResult>("search-provider", {
    endpoint: ws,
    connectTimeoutMs: 10_000,
  }, { timeoutMs: CONFIGURE_TIMEOUT_MS + 15_000 });
}

/**
 * Use Chromium's real search settings UI so the change is written to the
 * profile's search-engine database and survives restarts. Directly editing
 * Preferences is insufficient, and direct custom-engine WebUI messages crash
 * the current CloakBrowser 146 build when invoked over CDP.
 */
export async function configureDuckDuckGo(
  context: BrowserContext,
): Promise<SearchProviderSetupResult> {
  const settingsPage = await context.newPage();
  try {
    await settingsPage.goto(SETTINGS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    });

    // Inspect first so a working operator-selected provider is never replaced.
    const initial = await settingsPage.evaluate(async () => {
      const chromiumBridge = "chrome://resources/js/cr.js";
      const crModule: any = await import(chromiumBridge);
      const lists = await crModule.sendWithPromise("getSearchEnginesList");
      return (Object.values(lists).filter(Array.isArray).flat() as any[]).map((engine) => ({
        default: !!engine.default,
        displayName: engine.displayName,
        keyword: engine.keyword,
        name: engine.name,
        url: engine.url,
      }));
    });
    const existing = existingSearchProvider(initial);
    if (existing) return existing;

    const result = await settingsPage.evaluate(async () => {
      let crModule: any;
      try {
        const chromiumBridge = "chrome://resources/js/cr.js";
        crModule = await import(chromiumBridge);
      } catch (error) {
        return {
          ok: false as const,
          error: `could not load Chromium settings bridge: ${String(error)}`,
        };
      }

      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const engines = async (): Promise<any[]> => {
        const lists = await crModule.sendWithPromise("getSearchEnginesList");
        return Object.values(lists).filter(Array.isArray).flat() as any[];
      };
      const identity = (engine: any) => [
        engine.keyword,
        engine.name,
        engine.displayName,
        engine.url,
      ].filter(Boolean).join(" ").toLowerCase();
      const findDuckDuckGo = (items: any[]) => items.find((engine) =>
        identity(engine).includes("duckduckgo")
      );
      const isNoSearch = (engine: any) => {
        const value = identity(engine);
        const url = String(engine.url || "").trim().toLowerCase();
        return value.includes("no search") || /^https?:\/\/%s\/?$/.test(url);
      };
      const referenceFor = (engine: any): number =>
        typeof engine.modelIndex === "number" ? engine.modelIndex : engine.id;

      const initialEngines = await engines();
      // Recheck inside the mutation transaction in case the operator changed
      // the provider after the first read and before this evaluation began.
      const current = initialEngines.find((engine) => engine.default);
      if (current && !isNoSearch(current)) {
        return {
          ok: true as const,
          status: identity(current).includes("duckduckgo")
            ? "already-default" as const
            : "kept-existing" as const,
          engine: current.displayName || current.name || current.keyword || "Current search provider",
        };
      }

      let duckDuckGo = findDuckDuckGo(initialEngines);

      if (!duckDuckGo) {
        // Use the actual settings dialog for creation. Its stable internal IDs
        // are locale-independent, unlike visible button/field labels.
        const deepAll = (root: any, selector: string): any[] => {
          const matches: any[] = [];
          if (root.shadowRoot) matches.push(...deepAll(root.shadowRoot, selector));
          matches.push(...root.querySelectorAll(selector));
          for (const element of root.querySelectorAll("*")) {
            if (element.shadowRoot) matches.push(...deepAll(element.shadowRoot, selector));
          }
          return [...new Set(matches)];
        };

        let addButton: any;
        for (let attempt = 0; attempt < 30 && !addButton; attempt += 1) {
          addButton = deepAll(document, "#addSearchEngine")[0];
          if (!addButton) await wait(100);
        }
        if (!addButton) {
          return { ok: false as const, error: "Chromium search Add button was not available" };
        }
        addButton.click();

        let dialog: any;
        for (let attempt = 0; attempt < 20 && !dialog; attempt += 1) {
          await wait(100);
          dialog = deepAll(document, "settings-search-engine-edit-dialog")[0];
        }
        if (!dialog) {
          return { ok: false as const, error: "Chromium search dialog did not open" };
        }

        const setInput = (id: string, value: string) => {
          const host = deepAll(dialog, `cr-input#${id}`)[0];
          const input = host?.shadowRoot?.querySelector("input");
          if (!input) throw new Error(`Chromium search input ${id} was not available`);
          const valueSetter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )?.set;
          valueSetter?.call(input, value);
          input.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            composed: true,
            inputType: "insertText",
            data: value,
          }));
          input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        };
        setInput("searchEngine", "DuckDuckGo");
        setInput("keyword", "duckduckgo.com");
        setInput("queryUrl", "https://duckduckgo.com/?q=%s");

        let saveButton: any;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          await wait(100);
          saveButton = deepAll(dialog, "#actionButton")[0];
          if (saveButton && !saveButton.disabled && !saveButton.hasAttribute("disabled")) break;
        }
        if (!saveButton || saveButton.disabled || saveButton.hasAttribute("disabled")) {
          return { ok: false as const, error: "Chromium rejected DuckDuckGo settings" };
        }
        saveButton.click();

        for (let attempt = 0; attempt < 20 && !duckDuckGo; attempt += 1) {
          await wait(100);
          duckDuckGo = findDuckDuckGo(await engines());
        }
      }

      if (!duckDuckGo) {
        return { ok: false as const, error: "Chromium did not save DuckDuckGo" };
      }

      if (duckDuckGo.canBeActivated) {
        (globalThis as any).chrome.send(
          "setIsActiveSearchEngine",
          [referenceFor(duckDuckGo), true],
        );
        await wait(100);
        duckDuckGo = findDuckDuckGo(await engines()) || duckDuckGo;
      }

      if (!duckDuckGo.canBeDefault) {
        return { ok: false as const, error: "Chromium will not allow DuckDuckGo as default" };
      }

      const usesModelIndex = typeof duckDuckGo.modelIndex === "number";
      (globalThis as any).chrome.send("setDefaultSearchEngine", [
        referenceFor(duckDuckGo),
        // Chromium changed from mutable model indexes to stable engine ids;
        // SearchSettings is 0 for the former and 1 for the latter.
        usesModelIndex ? 0 : 1,
        null,
      ]);

      for (let attempt = 0; attempt < 20; attempt += 1) {
        await wait(100);
        const saved = findDuckDuckGo(await engines());
        if (saved?.default) {
          return {
            ok: true as const,
            status: "configured" as const,
            engine: saved.displayName || saved.name || "DuckDuckGo",
          };
        }
      }

      return { ok: false as const, error: "DuckDuckGo was not persisted as default" };
    });

    if (!result.ok) throw new Error(result.error);
    return { status: result.status, engine: result.engine };
  } finally {
    await settingsPage.close().catch(() => {});
  }
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
