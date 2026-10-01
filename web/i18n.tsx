import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchShellLanguage, saveShellLanguage } from "./api.ts";
import { catalogs } from "./locales/registry.ts";
// ── Adding a new language ─────────────────────────────────────────────
// Drop `<bcp47>.json` into `web/locales/` (copy `en-US.json` as a template;
// keep the same keys — English is the automatic fallback for missing keys),
// then run `bun run i18n:locales` to regenerate the registry. That's it.
// (Static imports are required: the desktop app compiles to a binary, so the
// bundler must see every locale at build time — runtime glob/discovery is
// not available in this stack. The registry is auto-generated, so translators
// never touch TypeScript.)

export type Language = string;

const LANGUAGE_KEY = "aliasmode.shell.language";
const FALLBACK_LANGUAGE = "en-US";

function isKnownLanguage(value: unknown): value is string {
  return typeof value === "string" && Object.hasOwn(catalogs, value);
}

export function readLanguage(): string {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (isKnownLanguage(saved)) return saved;
  } catch {}
  return FALLBACK_LANGUAGE;
}

type TranslationValues = Record<string, string | number>;
type TranslationContextValue = {
  language: string;
  setLanguage: (language: string) => void;
  /** Translate `source`. Missing keys fall back to the English catalog, then
   *  to the key itself. Supports `{name}` / `{{name}}` placeholders. */
  t: (source: string, values?: TranslationValues) => string;
};

const I18nContext = createContext<TranslationContextValue | null>(null);

function format(source: string, values?: TranslationValues): string {
  if (!values) return source;
  return source.replace(/\{\{?(\w+)\}?\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match
  );
}

/** Pure translation lookup: current language → English fallback → key itself.
 *  Exported for unit tests. */
export function translate(
  tables: Record<string, Record<string, string>>,
  language: string,
  source: string,
  values?: TranslationValues,
): string {
  const catalog = tables[language] ?? tables[FALLBACK_LANGUAGE]!;
  const translated = catalog[source] ?? tables[FALLBACK_LANGUAGE]![source] ?? source;
  return format(translated, values);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<string>(readLanguage);
  // The desktop shell serves the UI from a random loopback port each launch,
  // and localStorage is origin-scoped, so a saved language never survives a
  // restart in localStorage alone. Hydrate from the server-persisted value.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    fetchShellLanguage()
      .then((saved) => {
        if (isKnownLanguage(saved) && saved !== readLanguage()) {
          setLanguageState(saved);
          try {
            localStorage.setItem(LANGUAGE_KEY, saved);
            document.documentElement.lang = saved;
          } catch {}
        }
      })
      .catch(() => {});
  }, []);

  const setLanguage = (lang: string) => {
    if (!isKnownLanguage(lang)) return;
    setLanguageState(lang);
    try {
      localStorage.setItem(LANGUAGE_KEY, lang);
      document.documentElement.lang = lang;
    } catch {}
    // Persist server-side so the choice survives restarts (fire-and-forget).
    saveShellLanguage(lang).catch(() => {});
  };

  useEffect(() => {
    try {
      document.documentElement.lang = language;
      localStorage.setItem(LANGUAGE_KEY, language);
    } catch {}
  }, [language]);

  const value = useMemo<TranslationContextValue>(() => ({
    language,
    setLanguage,
    t: (source, values) => translate(catalogs, language, source, values),
  }), [language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation(): TranslationContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useTranslation must be used inside I18nProvider");
  return value;
}

/** BCP47 codes of every bundled locale, for the language setting UI. */
export function availableLanguages(): string[] {
  return Object.keys(catalogs);
}

/** The language's own native name (e.g. "Русский"), for the language picker.
 *  Read from that locale's own catalog so it never needs code changes. */
export function languageNativeName(lang: string): string {
  return catalogs[lang]?.["language.nativeName"] ?? lang;
}
