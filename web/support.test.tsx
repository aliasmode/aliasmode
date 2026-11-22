import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { I18nProvider } from "./i18n.tsx";
import {
  DEFAULT_TIERS,
  PROMPT_GAP_MS,
  PROMPT_KEY,
  PROMPT_MIN_OPENS,
  PROMPT_SNOOZE_MS,
  SUPPORTERS_URL,
  SupportPanel,
  SupportPromptCard,
  SupporterBadge,
  loadPromptState,
  notePromptEvent,
  snoozePrompt,
  tierProgress,
  usd,
  type PromptState,
} from "./support.tsx";
import { createSupport, fetchSupport, SupportRequestError } from "./api.ts";
import type { Supporter } from "../contracts/cloud-v1.ts";

const realFetch = globalThis.fetch;
const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key), clear: () => memory.clear(), key: () => null, length: 0,
} satisfies Storage });
afterEach(() => { globalThis.fetch = realFetch; memory.clear(); });

const render = (element: ReactElement) => renderToStaticMarkup(<I18nProvider>{element}</I18nProvider>);
const noop = async () => {};
const backer: Supporter = { tier: "backer", totalCents: 3500, displayName: "Dana", public: true, telegram: "", linkUrl: "", logoUrl: "", logoApproved: false, since: 1 };

test("tier progress finds the current tier, the next one and the share of the way there", () => {
  expect(tierProgress(DEFAULT_TIERS, 0)).toEqual({ current: null, next: DEFAULT_TIERS[0]!, remainingCents: 500, percent: 0 });
  expect(tierProgress(DEFAULT_TIERS, 250)).toMatchObject({ current: null, percent: 50 });
  expect(tierProgress(DEFAULT_TIERS, 3500)).toEqual({ current: DEFAULT_TIERS[1]!, next: DEFAULT_TIERS[2]!, remainingCents: 6500, percent: 13 });
  expect(tierProgress(DEFAULT_TIERS, 10000)).toMatchObject({ current: { id: "sponsor" }, next: { id: "partner" }, percent: 0 });
  expect(tierProgress(DEFAULT_TIERS, 75000)).toEqual({ current: DEFAULT_TIERS[3]!, next: null, remainingCents: 0, percent: 100 });
  // Cloud may send the tiers in any order.
  expect(tierProgress([...DEFAULT_TIERS].reverse(), 2500).current?.id).toBe("backer");
});

test("whole dollar amounts drop the zero cents", () => {
  expect(usd(1000)).toBe("$10");
  expect(usd(1250)).toBe("$12.50");
  expect(usd(1000, "ru-RU")).not.toContain(",00");
});

const fresh: PromptState = { opens: 0, shownAt: 0, snoozedUntil: 0, updateVersion: "" };
const cloud = { eligible: true, supporter: false };
const NOW = 1_800_000_000_000;

test("the prompt card shows at the 20th profile open, then waits 30 days", () => {
  let state = fresh;
  for (let open = 1; open < PROMPT_MIN_OPENS; open++) {
    const result = notePromptEvent(state, { kind: "open" }, NOW, cloud);
    expect(result.show).toBe(false);
    state = result.state;
  }
  const shown = notePromptEvent(state, { kind: "open" }, NOW, cloud);
  expect(shown).toEqual({ show: true, state: { ...state, opens: PROMPT_MIN_OPENS, shownAt: NOW } });
  expect(notePromptEvent(shown.state, { kind: "open" }, NOW + PROMPT_GAP_MS - 1, cloud).show).toBe(false);
  expect(notePromptEvent(shown.state, { kind: "open" }, NOW + PROMPT_GAP_MS, cloud).show).toBe(true);
});

test("a new installed version is a success moment once per version", () => {
  const first = notePromptEvent(fresh, { kind: "update", version: "0.1.0-beta.76" }, NOW, cloud);
  expect(first.show).toBe(true);
  expect(first.state.updateVersion).toBe("0.1.0-beta.76");
  // The same stored result on the next start is not a new moment, even after 30 days.
  expect(notePromptEvent(first.state, { kind: "update", version: "0.1.0-beta.76" }, NOW + PROMPT_GAP_MS * 2, cloud)).toEqual({ state: first.state, show: false });
  expect(notePromptEvent(first.state, { kind: "update", version: "0.1.0-beta.77" }, NOW + PROMPT_GAP_MS, cloud).show).toBe(true);
});

test("the prompt card never shows outside Cloud, to supporters, or while snoozed", () => {
  const ready: PromptState = { ...fresh, opens: 40 };
  expect(notePromptEvent(ready, { kind: "open" }, NOW, { eligible: false, supporter: false }).show).toBe(false);
  expect(notePromptEvent(ready, { kind: "open" }, NOW, { eligible: true, supporter: true }).show).toBe(false);
  const snoozed = snoozePrompt(ready, NOW);
  expect(snoozed.snoozedUntil).toBe(NOW + PROMPT_SNOOZE_MS);
  expect(notePromptEvent(snoozed, { kind: "open" }, NOW + PROMPT_SNOOZE_MS - 1, cloud).show).toBe(false);
  expect(notePromptEvent(snoozed, { kind: "open" }, NOW + PROMPT_SNOOZE_MS, cloud).show).toBe(true);
  // Opens still count while it cannot show.
  expect(notePromptEvent(ready, { kind: "open" }, NOW, { eligible: false, supporter: false }).state.opens).toBe(41);
});

test("a damaged saved prompt state starts fresh", () => {
  memory.set(PROMPT_KEY, "{not json");
  expect(loadPromptState()).toEqual(fresh);
  memory.set(PROMPT_KEY, JSON.stringify({ opens: -3, shownAt: "x", snoozedUntil: 5, updateVersion: 7 }));
  expect(loadPromptState()).toEqual({ ...fresh, snoozedUntil: 5 });
});

test("Local mode explains the Cloud account and links to the website", () => {
  const html = render(<SupportPanel source="sidebar" mode="local" state={null} balanceCents={null} onClose={() => {}} onReload={noop} onUseCloud={() => {}} />);
  expect(html).toContain("Support needs an AliasMode Cloud account");
  expect(html).toContain(`href="${SUPPORTERS_URL}"`);
  expect(html).toContain('target="_blank"');
  expect(html).not.toContain("support-amounts");
  for (const tier of ["Supporter", "Backer", "Sponsor", "Partner"]) expect(html).toContain(tier);
});

test("an older Cloud keeps the website link", () => {
  const html = render(<SupportPanel source="settings" mode="cloud" state={{ available: false }} balanceCents={2000} onClose={() => {}} onReload={noop} onUseCloud={() => {}} />);
  expect(html).toContain("Support in the app is not available on your AliasMode Cloud yet.");
  expect(html).toContain(`href="${SUPPORTERS_URL}"`);
});

test("Cloud mode preselects $10 and offers the balance only when it covers the amount", () => {
  const state = { available: true as const, tiers: DEFAULT_TIERS, supporter: null };
  const rich = render(<SupportPanel source="sidebar" mode="cloud" state={state} balanceCents={1250} onClose={() => {}} onReload={noop} onUseCloud={() => {}} />);
  expect(rich).toMatch(/aria-checked="true" class="active">\$10</);
  expect(rich).toContain("Balance");
  expect(rich).toContain("Support with $10");
  expect(rich).toContain("This makes you an AliasMode Supporter.");
  expect(rich).not.toContain("Logo URL");
  const poor = render(<SupportPanel source="sidebar" mode="cloud" state={state} balanceCents={900} onClose={() => {}} onReload={noop} onUseCloud={() => {}} />);
  expect(poor).not.toContain(">Balance");
  expect(poor).toContain("One-time payment. AliasMode stays free for everyone.");
});

test("a supporter sees the tier, the progress and, from Sponsor, the link and logo fields", () => {
  const state = { available: true as const, tiers: DEFAULT_TIERS, supporter: backer };
  const html = render(<SupportPanel source="sidebar" mode="cloud" state={state} balanceCents={0} onClose={() => {}} onReload={noop} onUseCloud={() => {}} />);
  expect(html).toContain("Your tier");
  expect(html).toContain("$65 more to Sponsor");
  expect(html).toContain('aria-valuenow="13"');
  const sponsor = render(<SupportPanel source="sidebar" mode="cloud" state={{ ...state, supporter: { ...backer, tier: "sponsor", totalCents: 12000, logoUrl: "https://example.com/l.svg" } }} balanceCents={0} onClose={() => {}} onReload={noop} onUseCloud={() => {}} />);
  expect(sponsor).toContain("Logo URL");
  expect(sponsor).toContain("Waiting for review.");
});

test("the badge and the prompt card render their text", () => {
  expect(render(<SupporterBadge tier="partner" />)).toContain("tier-partner");
  const card = render(<SupportPromptCard onSupport={() => {}} onSnooze={() => {}} />);
  expect(card).toContain("Enjoying AliasMode?");
  expect(card).toContain("Not now");
});

test("support requests go to the sidecar route and keep the Cloud error code", async () => {
  const requests: Array<[string, string | undefined, unknown]> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push([String(url), init?.method, init?.body ? JSON.parse(String(init.body)) : undefined]);
    if (init?.method === "POST") return Response.json({ ok: false, error: "short", code: "insufficient_balance" }, { status: 402 });
    return Response.json({ ok: true, available: false });
  }) as typeof fetch;
  expect(await fetchSupport()).toEqual({ available: false });
  const failure = await createSupport({ amountCents: 2500, method: "balance", source: "wallet" }).catch((error) => error);
  expect(failure).toBeInstanceOf(SupportRequestError);
  expect(failure).toMatchObject({ code: "insufficient_balance", status: 402 });
  expect(requests).toEqual([
    ["/ui/api/cloud-support", undefined, undefined],
    ["/ui/api/cloud-support", "POST", { amountCents: 2500, method: "balance", source: "wallet" }],
  ]);
});
