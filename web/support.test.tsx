import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactElement } from "react";
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
  isActiveSupporter,
  loadPromptState,
  monthlyAvailability,
  notePromptEvent,
  snoozePrompt,
  supportBonusCents,
  tierProgress,
  usd,
  type PromptState,
} from "./support.tsx";
import { cancelSupportMonthly, createSupport, fetchSupport, SupportRequestError } from "./api.ts";
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
const ACTIVE_UNTIL = Date.UTC(2026, 11, 22, 12);
const backer: Supporter = {
  tier: "backer", activeUntil: ACTIVE_UNTIL, last30Cents: 7500, lifetimeCents: 12000, totalCents: 12000,
  displayName: "Dana", public: true, telegram: "", linkUrl: "", logoUrl: "", logoApproved: false, since: 1, monthly: null, directory: null,
};
const cloudState = (supporter: Supporter | null) => ({ available: true as const, tiers: DEFAULT_TIERS, supporter });
const panel = (props: Partial<ComponentProps<typeof SupportPanel>>) => render(<SupportPanel source="sidebar" mode="cloud" owner state={cloudState(null)}
  balanceCents={0} onClose={() => {}} onReload={noop} onUseCloud={() => {}} {...props} />);

test("bonus credits come from the tier the payment reaches on its own, in whole cents", () => {
  expect(supportBonusCents(DEFAULT_TIERS, 999)).toBe(0);
  expect(supportBonusCents(DEFAULT_TIERS, 1000)).toBe(300);
  expect(supportBonusCents(DEFAULT_TIERS, 2500)).toBe(750);
  expect(supportBonusCents(DEFAULT_TIERS, 5000)).toBe(2000);
  expect(supportBonusCents(DEFAULT_TIERS, 20000)).toBe(10000);
  expect(supportBonusCents(DEFAULT_TIERS, 100000)).toBe(50000);
  expect(supportBonusCents(DEFAULT_TIERS, 1333)).toBe(399);
});

test("tier progress follows the last 30 days", () => {
  expect(tierProgress(DEFAULT_TIERS, 0)).toEqual({ current: null, next: DEFAULT_TIERS[0]!, remainingCents: 1000, percent: 0 });
  expect(tierProgress(DEFAULT_TIERS, 7500)).toEqual({ current: DEFAULT_TIERS[1]!, next: DEFAULT_TIERS[2]!, remainingCents: 12500, percent: 17 });
  expect(tierProgress(DEFAULT_TIERS, 150000)).toMatchObject({ current: { id: "partner" }, next: null, percent: 100 });
  expect(tierProgress([...DEFAULT_TIERS].reverse(), 5000).current?.id).toBe("backer");
});

test("monthly support is card only, for the owner, and once at a time", () => {
  expect(monthlyAvailability("card", true, null)).toEqual({ allowed: true, reason: null });
  expect(monthlyAvailability("crypto", true, null).allowed).toBe(false);
  expect(monthlyAvailability("balance", true, null).allowed).toBe(false);
  expect(monthlyAvailability("card", false, null)).toEqual({ allowed: false, reason: "Only the workspace owner can set up monthly support." });
  const pledged = { ...backer, monthly: { amountCents: 2500, status: "active" as const, nextChargeAt: ACTIVE_UNTIL } };
  expect(monthlyAvailability("card", true, pledged).allowed).toBe(false);
  expect(monthlyAvailability("card", true, { ...pledged, monthly: { ...pledged.monthly, status: "canceled" } }).allowed).toBe(true);
  expect(isActiveSupporter(pledged)).toBe(true);
  expect(isActiveSupporter({ ...backer, tier: null })).toBe(false);
});

test("whole dollar amounts drop the zero cents", () => {
  expect(usd(1000)).toBe("$10");
  expect(usd(750)).toBe("$7.50");
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
  expect(notePromptEvent(ready, { kind: "open" }, NOW, { eligible: false, supporter: false }).state.opens).toBe(41);
});

test("a damaged saved prompt state starts fresh", () => {
  memory.set(PROMPT_KEY, "{not json");
  expect(loadPromptState()).toEqual(fresh);
  memory.set(PROMPT_KEY, JSON.stringify({ opens: -3, shownAt: "x", snoozedUntil: 5, updateVersion: 7 }));
  expect(loadPromptState()).toEqual({ ...fresh, snoozedUntil: 5 });
});

test("Local mode explains the Cloud account with the bonus and links to the website", () => {
  const html = panel({ mode: "local", state: null, balanceCents: null });
  expect(html).toContain("Support needs an AliasMode Cloud account");
  expect(html).toContain("Sign in to get +$7.50 bonus credits on $25 and your badge.");
  expect(html).toContain(`href="${SUPPORTERS_URL}"`);
  expect(html).not.toContain("support-amounts");
  expect(html).toContain("Other antidetect browsers charge $10–$300 a month for what you run here free.");
});

test("tier cards show perks, the 30-day rule and bonus examples in dollars, never percent", () => {
  const html = panel({ mode: "local", state: null });
  for (const text of ["Your feature votes count ×2", "Listing in the agency directory with a backlink", "Your feature votes count ×5",
    "e.g. $50 → +$20 bonus credits", "e.g. $200 → +$100 bonus credits", "e.g. $1,000 → +$500 bonus credits", "Perks last 30 days. Monthly support keeps them on."]) {
    expect(html).toContain(text);
  }
  expect(html).not.toMatch(/\d+ ?%/);
});

test("an older Cloud keeps the website link", () => {
  const html = panel({ source: "settings", state: { available: false }, balanceCents: 2000 });
  expect(html).toContain("Support in the app is not available on your AliasMode Cloud yet.");
  expect(html).toContain(`href="${SUPPORTERS_URL}"`);
});

test("an owner starts on $25 by card with Monthly on and the exact bonus on the button", () => {
  const html = panel({ balanceCents: 1250 });
  expect(html).toMatch(/aria-checked="true" class="active">\$25</);
  expect(html).toMatch(/role="switch" checked=""/);
  expect(html).toContain("Support with $25 a month");
  expect(html).toContain("· +$7.50 bonus credits");
  expect(html).toContain("Charged every 30 days. Cancel any time.");
  expect(html).not.toContain(">Balance");
  expect(html).not.toMatch(/\d+ ?%/);
});

test("a member pays once, from the balance when it covers the amount", () => {
  const html = panel({ owner: false, balanceCents: 3000 });
  expect(html).toContain(">Balance");
  expect(html).toMatch(/role="switch" disabled=""/);
  expect(html).toContain("Monthly support works with a card.");
  expect(html).toContain("Support with $25<");
  expect(html).toContain("One-time payment from your workspace balance.");
});

test("a supporter sees the tier with its end date, monthly status and, from Sponsor, the directory fields", () => {
  const monthly = { amountCents: 2500, status: "past_due" as const, nextChargeAt: ACTIVE_UNTIL };
  const html = panel({ state: cloudState({ ...backer, monthly }) });
  expect(html).toContain("Backer until Dec 22");
  expect(html).toContain("$75 in the last 30 days");
  expect(html).toContain("$125 more to Sponsor");
  expect(html).toContain("Monthly: $25");
  expect(html).toContain("Next charge Dec 22");
  expect(html).toContain("The last monthly charge did not go through.");
  expect(html).toContain("Cancel monthly");
  expect(html).toContain("You already support monthly.");
  expect(html).not.toContain("Agency name");
  const sponsor = panel({ state: cloudState({ ...backer, tier: "sponsor", last30Cents: 20000, directory: { name: "Acme", description: "Growth", url: "https://acme.example", approved: false } }) });
  expect(sponsor).toContain("Agency name");
  expect(sponsor).toContain('value="Acme"');
  expect(sponsor).toContain("Waiting for review. Listed in the agency directory after the team approves it.");
});

test("the prompt card leads with the bonus and the badge shows the tier", () => {
  expect(render(<SupporterBadge tier="partner" />)).toContain("tier-partner");
  const card = render(<SupportPromptCard bonusCents={750} onSupport={() => {}} onSnooze={() => {}} />);
  expect(card).toContain("Support AliasMode and get +$7.50 bonus credits");
  expect(card).toContain("Not now");
});

test("support requests go to the sidecar routes and keep the Cloud error code", async () => {
  const requests: Array<[string, string | undefined, unknown]> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push([String(url), init?.method, init?.body ? JSON.parse(String(init.body)) : undefined]);
    if (init?.method === "POST") return Response.json({ ok: false, error: "no", code: "monthly_unavailable" }, { status: 400 });
    if (init?.method === "DELETE") return Response.json({ ok: true, supporter: backer });
    return Response.json({ ok: true, available: false });
  }) as typeof fetch;
  expect(await fetchSupport()).toEqual({ available: false });
  const failure = await createSupport({ amountCents: 2500, method: "card", source: "wallet", monthly: true }).catch((error) => error);
  expect(failure).toBeInstanceOf(SupportRequestError);
  expect(failure).toMatchObject({ code: "monthly_unavailable", status: 400 });
  expect(await cancelSupportMonthly()).toEqual(backer);
  expect(requests).toEqual([
    ["/ui/api/cloud-support", undefined, undefined],
    ["/ui/api/cloud-support", "POST", { amountCents: 2500, method: "card", source: "wallet", monthly: true }],
    ["/ui/api/cloud-support/monthly", "DELETE", {}],
  ]);
});
