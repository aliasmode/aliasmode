import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "./i18n.tsx";
import { OfficialBadge, RunOnOpenField, ScriptAiCard, ScriptRunPanel, ScriptsPage, fixScriptPrompt } from "./scripts.tsx";

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

test("the fix prompt names the script and keeps the last 40 lines of the failed profile's part of the log", () => {
  const lines = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");
  const log = `Python runtime ready\n\n--- Shop A ---\n${lines("a", 5)}\n\n--- Shop B ---\n${lines("b", 50)}\n${"x".repeat(400)}\n\n--- Shop C ---\n${lines("c", 3)}\n`;
  const prompt = fixScriptPrompt({ id: "s1", name: "Visit feed" }, { id: "b", name: "Shop B", error: "Script exited with code 1; see its log" }, log);
  expect(prompt.startsWith('Fix my script "Visit feed" (id s1). It failed on profile "Shop B": Script exited with code 1; see its log')).toBe(true);
  const tail = prompt.split("Last lines of its log:\n")[1]!.split("\n");
  expect(tail).toHaveLength(40);
  expect(tail[0]).toBe("b 12");
  expect(tail.at(-1)).toBe(`${"x".repeat(300)}…`);
  expect(prompt).not.toContain("a 1");
  expect(prompt).not.toContain("c 1");
  // A profile that failed before its browser opened gets the lines written before any profile.
  expect(fixScriptPrompt({ name: "Visit feed" }, { id: "d", name: "d", error: "Profile edit access is required" }, log))
    .toBe('Fix my script "Visit feed". It failed on profile "d": Profile edit access is required\n\nLast lines of its log:\nPython runtime ready');
  expect(fixScriptPrompt({ name: "Visit feed" }, { id: "d", name: "" }, "")).toBe('Fix my script "Visit feed". It failed on profile "d".');
});

test("the AI card shows the credits hint", () => {
  const card = renderToStaticMarkup(<I18nProvider><ScriptAiCard busy={false} onAsk={() => {}} /></I18nProvider>);
  expect(card).toContain("Customize with AI");
  expect(card).toContain("Ask the agent");
  expect(card).toContain("Uses your free monthly credits, then your workspace balance.");
});

test("official public scripts get a badge with a check icon", () => {
  const badge = renderToStaticMarkup(<I18nProvider><OfficialBadge /></I18nProvider>);
  expect(badge).toContain("Official");
  expect(badge).toContain("<svg");
});
