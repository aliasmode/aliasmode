import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "./i18n.tsx";
import { ScriptRunPanel } from "./scripts.tsx";

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
