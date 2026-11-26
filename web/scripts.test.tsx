import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "./i18n.tsx";
import { RunOnOpenField, ScriptRunPanel, ScriptsPage } from "./scripts.tsx";

test("script run panel defaults to 10 parallel browsers without an upper limit", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true, value: { __TAURI_INTERNALS__: { invoke: async () => "test-capability" } },
  });
  try {
    const html = renderToStaticMarkup(<I18nProvider><ScriptRunPanel open selectedProfiles={[]} onClose={() => {}} /></I18nProvider>);
    const field = html.match(/<input[^>]*type="number"[^>]*>/)?.[0];
    expect(field).toBeDefined();
    expect(field).toContain('value="10"');
    expect(field).toContain('min="1"');
    expect(field).toContain('step="1"');
    expect(field).not.toContain('max=');
    expect(field).not.toContain('disabled=');
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("the scripts page has a Schedules tab and the profile editor defaults run-on-open to None", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true, value: { __TAURI_INTERNALS__: { invoke: async () => "test-capability" } },
  });
  try {
    const page = renderToStaticMarkup(<I18nProvider><ScriptsPage onViewRun={() => {}} onAskAgent={() => {}} profiles={[]} /></I18nProvider>);
    expect(page).toContain("Schedules");
    const field = renderToStaticMarkup(<I18nProvider><RunOnOpenField profileId="p1" /></I18nProvider>);
    expect(field).toContain("Run a script on open");
    expect(field).toMatch(/<option value="" selected="">None<\/option>|<option value="">None<\/option>/);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
