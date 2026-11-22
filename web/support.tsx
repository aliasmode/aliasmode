import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "./i18n.tsx";
import { CardPaymentView, CryptoPaymentView, formatUsd, isStripeCheckoutUrl, mayStillBeCredited, useNow, watchDeposit, type ActiveDeposit } from "./store.tsx";
import { SupportRequestError, createSupport, fetchSupport, updateSupportProfile, type SupportStatus } from "./api.ts";
import type { Supporter, SupportTier, SupportTierId } from "../contracts/cloud-v1.ts";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Where Support AliasMode was opened; Cloud records it with the payment. */
export type SupportSource = "sidebar" | "wallet" | "prompt-card" | "settings";

export const SUPPORTERS_URL = "https://aliasmode.com/supporters/";
export const SUPPORT_PRESETS = [500, 1000, 2500, 5000, 10000];
export const DEFAULT_SUPPORT_CENTS = 1000;
const MIN_BALANCE_CENTS = 100;
const MIN_PAYMENT_CENTS = 500;
const MAX_PAYMENT_CENTS = 1_000_000;

/** The tiers of the v1 contract, shown before Cloud answers and in Local mode. */
export const DEFAULT_TIERS: SupportTier[] = [
  { id: "supporter", minCents: 500, name: "Supporter" },
  { id: "backer", minCents: 2500, name: "Backer" },
  { id: "sponsor", minCents: 10000, name: "Sponsor" },
  { id: "partner", minCents: 50000, name: "Partner" },
];

const TIER_LABELS: Record<SupportTierId, string> = { supporter: "Supporter", backer: "Backer", sponsor: "Sponsor", partner: "Partner" };

/** Each tier adds these perks to the ones below it. */
const TIER_PERKS: Record<SupportTierId, string[]> = {
  supporter: ["Supporter badge in the app and the forum", "Your name on the supporters page"],
  backer: ["Everything in Supporter", "Backer title in the AliasMode Telegram group"],
  sponsor: ["Everything in Backer", "Your logo and link on the supporters page", "Sponsor title in Telegram"],
  partner: ["Everything in Sponsor", "Your logo in the GitHub README", "Partner title in Telegram"],
};

const SPONSOR_TIERS = new Set<SupportTierId | null>(["sponsor", "partner"]);

/** A dollar amount without zero cents: "$10", "$12.50". */
export function usd(cents: number, language = "en-US"): string {
  return formatUsd(cents, language).replace(/[.,]00(?!\d)/, "");
}

export function tierLabel(id: SupportTierId, t: Translate): string {
  return t(TIER_LABELS[id] ?? "Supporter");
}

export interface TierProgress {
  /** The highest tier the total reaches, or null below the first tier. */
  current: SupportTier | null;
  next: SupportTier | null;
  remainingCents: number;
  /** 0..100 from the current tier to the next one; 100 at the top tier. */
  percent: number;
}

export function tierProgress(tiers: SupportTier[], totalCents: number): TierProgress {
  const sorted = [...tiers].sort((a, b) => a.minCents - b.minCents);
  const current = sorted.filter((tier) => totalCents >= tier.minCents).at(-1) ?? null;
  const next = sorted.find((tier) => tier.minCents > totalCents) ?? null;
  if (!next) return { current, next, remainingCents: 0, percent: 100 };
  const floor = current?.minCents ?? 0;
  const percent = Math.round(Math.min(1, Math.max(0, (totalCents - floor) / (next.minCents - floor))) * 100);
  return { current, next, remainingCents: next.minCents - totalCents, percent };
}

/* The prompt card: shown in Cloud mode right after a success moment (20+ profile opens, or a new version installed),
   at most once in 30 days, hidden for 90 days by "Not now", never to someone who already supports. */
export const PROMPT_KEY = "aliasmode.support.prompt";
export const PROMPT_MIN_OPENS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
export const PROMPT_GAP_MS = 30 * DAY_MS;
export const PROMPT_SNOOZE_MS = 90 * DAY_MS;

export interface PromptState {
  opens: number;
  shownAt: number;
  snoozedUntil: number;
  /** The installed version the update moment was last counted for. */
  updateVersion: string;
}

export interface PromptContext {
  /** Cloud mode, signed in, and this Cloud has support. */
  eligible: boolean;
  /** The account already gave something. */
  supporter: boolean;
}

export type PromptEvent = { kind: "open" } | { kind: "update"; version: string };

const EMPTY_PROMPT: PromptState = { opens: 0, shownAt: 0, snoozedUntil: 0, updateVersion: "" };

/** Records one success moment and says whether the card shows now. */
export function notePromptEvent(state: PromptState, event: PromptEvent, now: number, context: PromptContext): { state: PromptState; show: boolean } {
  let next = state;
  if (event.kind === "open") next = { ...next, opens: next.opens + 1 };
  else if (event.version && event.version !== next.updateVersion) next = { ...next, updateVersion: event.version };
  else return { state, show: false };
  const show = context.eligible && !context.supporter
    && now >= next.snoozedUntil && now - next.shownAt >= PROMPT_GAP_MS
    && (event.kind === "update" || next.opens >= PROMPT_MIN_OPENS);
  return { state: show ? { ...next, shownAt: now } : next, show };
}

export function snoozePrompt(state: PromptState, now: number): PromptState {
  return { ...state, snoozedUntil: now + PROMPT_SNOOZE_MS };
}

export function loadPromptState(): PromptState {
  try {
    const saved = JSON.parse(localStorage.getItem(PROMPT_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return EMPTY_PROMPT;
    const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
    return {
      opens: count(saved.opens), shownAt: count(saved.shownAt), snoozedUntil: count(saved.snoozedUntil),
      updateVersion: typeof saved.updateVersion === "string" ? saved.updateVersion : "",
    };
  } catch { return EMPTY_PROMPT; }
}

function savePromptState(state: PromptState): void {
  try { localStorage.setItem(PROMPT_KEY, JSON.stringify(state)); } catch {}
}

/** The prompt card's visibility. `note` records a success moment; the context is read when it happens. */
export function useSupportPrompt(context: PromptContext) {
  const [visible, setVisible] = useState(false);
  const contextRef = useRef(context);
  contextRef.current = context;
  const note = useCallback((event: PromptEvent) => {
    const { state, show } = notePromptEvent(loadPromptState(), event, Date.now(), contextRef.current);
    savePromptState(state);
    if (show) setVisible(true);
  }, []);
  const snooze = useCallback(() => {
    savePromptState(snoozePrompt(loadPromptState(), Date.now()));
    setVisible(false);
  }, []);
  const hide = useCallback(() => setVisible(false), []);
  return { visible: visible && context.eligible && !context.supporter, note, snooze, hide };
}

/** null while loading; `failed` when the request did not work. */
export type SupportState = null | SupportStatus | { available: false; failed: true };

/** Loads the support tiers and this account's supporter record once Cloud is ready. */
export function useSupportStatus(enabled: boolean, key: string) {
  const [state, setState] = useState<SupportState>(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    let next: SupportState;
    try { next = await fetchSupport(); } catch { next = { available: false, failed: true }; }
    if (current !== generation.current) return;
    // A failed reload keeps the last good answer.
    setState((previous) => "failed" in next && previous?.available === true ? previous : next);
  }, []);
  useEffect(() => {
    generation.current++;
    setState(null);
    if (enabled) void reload();
  }, [enabled, key, reload]);
  return { state: enabled ? state : null, reload };
}

export function supporterOf(state: SupportState): Supporter | null {
  return state?.available === true ? state.supporter : null;
}

function supportErrorText(error: unknown, t: Translate): string {
  const code = error instanceof SupportRequestError ? error.code : undefined;
  const status = error instanceof SupportRequestError ? error.status : 0;
  if (code === "insufficient_balance" || status === 402) return t("Your balance is too low for this amount.");
  if (code === "deposit_amount_out_of_range") return t("Card and crypto payments must be between $5 and $10,000.");
  if (code === "validation_failed") return t("Check the amount and your profile, then try again.");
  if (code === "partner_unavailable" || code === "partner_rejected") return t("Card and crypto payments are not available right now. Try again in a few minutes.");
  if (code === "email_not_verified") return t("Verify your email in AliasMode first.");
  if (code === "network" || status === 502 || status === 503 || status === 504) return t("AliasMode Cloud could not be reached. Check your connection and try again.");
  if (status === 404) return t("Support is not available on your AliasMode Cloud yet.");
  return t("The request failed. Try again.");
}

const HEART_PATH = "M12 20.5s-8-4.9-8-10.9A4.6 4.6 0 0112 6.6a4.6 4.6 0 018 3c0 6-8 10.9-8 10.9z";

export function HeartIcon({ className = "", filled = false }: { className?: string; filled?: boolean }) {
  return <svg className={`icon support-heart${filled ? " filled" : ""}${className ? ` ${className}` : ""}`} viewBox="0 0 24 24" aria-hidden="true"><path d={HEART_PATH} /></svg>;
}

export function SupporterBadge({ tier, className = "" }: { tier: SupportTierId; className?: string }) {
  const { t } = useTranslation();
  return <span className={`support-badge tier-${tier}${className ? ` ${className}` : ""}`} title={t("AliasMode {tier}", { tier: tierLabel(tier, t) })}>
    <HeartIcon filled />{tierLabel(tier, t)}
  </span>;
}

function TierCards({ tiers, current }: { tiers: SupportTier[]; current: SupportTierId | null }) {
  const { t, language } = useTranslation();
  return <ol className="support-tiers" aria-label={t("Supporter tiers")}>
    {[...tiers].sort((a, b) => a.minCents - b.minCents).map((tier) => <li key={tier.id} className={`support-tier tier-${tier.id}${tier.id === current ? " current" : ""}`}
      aria-current={tier.id === current ? "true" : undefined}>
      <div className="support-tier-head">
        <span className="support-tier-mark"><HeartIcon filled /></span>
        <strong>{tierLabel(tier.id, t)}</strong>
        {tier.id === current
          ? <span className="support-tier-you">{t("Your tier")}</span>
          : <span className="support-tier-min">{t("{amount}+", { amount: usd(tier.minCents, language) })}</span>}
      </div>
      <ul>{(TIER_PERKS[tier.id] ?? []).map((perk) => <li key={perk}>{t(perk)}</li>)}</ul>
    </li>)}
  </ol>;
}

function SupporterStatus({ supporter, tiers }: { supporter: Supporter; tiers: SupportTier[] }) {
  const { t, language } = useTranslation();
  const progress = tierProgress(tiers, supporter.totalCents);
  return <section className="support-status" aria-label={t("Your support")}>
    <div className="support-status-row">
      {supporter.tier ? <SupporterBadge tier={supporter.tier} /> : <span className="support-badge tier-none"><HeartIcon />{t("Thank you")}</span>}
      <span className="support-status-total">{t("{amount} given in total", { amount: usd(supporter.totalCents, language) })}</span>
    </div>
    {progress.next && <>
      <div className="support-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}
        aria-label={t("Progress to {tier}", { tier: tierLabel(progress.next.id, t) })}>
        <span style={{ width: `${Math.max(progress.percent, 3)}%` }} />
      </div>
      <p className="support-status-next">{t("{amount} more to {tier}", { amount: usd(progress.remainingCents, language), tier: tierLabel(progress.next.id, t) })}</p>
    </>}
    {!progress.next && <p className="support-status-next">{t("You are at the top tier. Thank you for backing AliasMode.")}</p>}
  </section>;
}

const validHttps = (value: string) => !value || /^https:\/\/[^\s/$.?#][^\s]*$/i.test(value);

interface ProfileDraft { displayName: string; public: boolean; telegram: string; linkUrl: string; logoUrl: string }

function draftOf(supporter: Supporter | null): ProfileDraft {
  return {
    displayName: supporter?.displayName ?? "", public: supporter?.public ?? true, telegram: supporter?.telegram ?? "",
    linkUrl: supporter?.linkUrl ?? "", logoUrl: supporter?.logoUrl ?? "",
  };
}

/** The panel: tiers, amount, method, the supporter profile, the card or crypto payment, and the thank-you. */
export function SupportPanel({ source, mode, state, balanceCents, onClose, onReload, onUseCloud }: {
  source: SupportSource;
  /** cloud: signed in to a Cloud workspace. local: Local mode. */
  mode: "cloud" | "local";
  state: SupportState;
  /** The wallet balance when this Cloud has the wallet; null otherwise. */
  balanceCents: number | null;
  onClose: () => void;
  /** Reloads the supporter record and the wallet. */
  onReload: () => Promise<void>;
  onUseCloud: () => void;
}) {
  const { t, language } = useTranslation();
  const tiers = state?.available === true && state.tiers.length ? state.tiers : DEFAULT_TIERS;
  const supporter = supporterOf(state);
  const ready = mode === "cloud" && state?.available === true;
  const [preset, setPreset] = useState<number | "custom">(DEFAULT_SUPPORT_CENTS);
  const [custom, setCustom] = useState("");
  const amountCents = preset === "custom" ? Math.round(Number(custom) * 100) : preset;
  const canUseBalance = balanceCents !== null && balanceCents >= Math.max(amountCents || 0, MIN_BALANCE_CENTS);
  const [chosenMethod, setMethod] = useState<"balance" | "card" | "crypto">("balance");
  const method = chosenMethod === "balance" && !canUseBalance ? "card" : chosenMethod;
  const [draft, setDraft] = useState<ProfileDraft>(() => draftOf(supporter));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deposit, setDeposit] = useState<ActiveDeposit | null>(null);
  const [thanks, setThanks] = useState<Supporter | null>(null);
  const now = useNow(deposit?.status === "pending" && deposit.method === "crypto");
  const closeRef = useRef<HTMLButtonElement>(null);
  const supporterKey = supporter ? `${supporter.since}:${supporter.totalCents}` : "";
  useEffect(() => { setDraft(draftOf(supporter)); }, [supporterKey]);
  useEffect(() => { closeRef.current?.focus(); }, []);

  const minCents = method === "balance" ? MIN_BALANCE_CENTS : MIN_PAYMENT_CENTS;
  const maxCents = method === "balance" ? balanceCents ?? 0 : MAX_PAYMENT_CENTS;
  const validAmount = Number.isSafeInteger(amountCents) && amountCents >= minCents && amountCents <= maxCents;
  const after = tierProgress(tiers, (supporter?.totalCents ?? 0) + (validAmount ? amountCents : 0)).current;
  const sponsorFields = SPONSOR_TIERS.has(supporter?.tier ?? null) || SPONSOR_TIERS.has(after?.id ?? null);
  const urlsValid = validHttps(draft.linkUrl.trim()) && validHttps(draft.logoUrl.trim());
  const profileFields = () => ({
    displayName: draft.displayName.trim(), public: draft.public, telegram: draft.telegram.trim(),
    ...(sponsorFields || supporter?.linkUrl ? { linkUrl: draft.linkUrl.trim() } : {}),
    ...(sponsorFields || supporter?.logoUrl ? { logoUrl: draft.logoUrl.trim() } : {}),
  });
  const dirty = !!supporter && JSON.stringify(draftOf(supporter)) !== JSON.stringify({ ...draft, displayName: draft.displayName.trim(), telegram: draft.telegram.trim(), linkUrl: draft.linkUrl.trim(), logoUrl: draft.logoUrl.trim() });

  const watching = !!deposit && (deposit.status === "pending" || mayStillBeCredited(deposit));
  useEffect(() => {
    if (!deposit || !watching) return;
    const controller = new AbortController();
    void watchDeposit(deposit.id, (next) => {
      setDeposit((current) => current && current.id === next.id ? { ...next, resumed: current.resumed } : current);
      if (next.status !== "paid") return;
      void fetchSupport().then((status) => { if (status.available) setThanks(status.supporter); }, () => {}).finally(() => void onReload());
    }, controller.signal);
    return () => controller.abort();
  }, [deposit?.id, watching]);

  const pay = async () => {
    if (!validAmount || !urlsValid || busy) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const result = await createSupport({ amountCents, method, source, ...profileFields() });
      if ("supporter" in result) { setThanks(result.supporter); void onReload(); return; }
      setDeposit(result.deposit);
      if (result.deposit.method === "card" && !isStripeCheckoutUrl(result.deposit.card?.checkoutUrl)) setError(t("The checkout link is not valid. Try again."));
    } catch (failure) {
      setError(supportErrorText(failure, t));
    } finally { setBusy(false); }
  };

  const saveProfile = async () => {
    if (!urlsValid || busy) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      await updateSupportProfile(profileFields());
      setSaved(true);
      await onReload();
    } catch (failure) {
      setError(supportErrorText(failure, t));
    } finally { setBusy(false); }
  };

  const set = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => { setDraft((current) => ({ ...current, [key]: value })); setSaved(false); };
  const websiteLink = <a className="btn support-site" href={SUPPORTERS_URL} target="_blank" rel="noreferrer">{t("Support on aliasmode.com ↗")}</a>;

  let body;
  if (thanks) {
    const tier = thanks.tier;
    body = <div className="support-thanks" role="status">
      <span className={`support-thanks-mark${tier ? ` tier-${tier}` : ""}`}><HeartIcon filled /></span>
      <h3>{t("Thank you!")}</h3>
      <p>{tier ? t("You are now an AliasMode {tier}.", { tier: tierLabel(tier, t) }) : t("Your support arrived.")} {t("It pays for servers and engine builds.")}</p>
      {tier && <SupporterBadge tier={tier} className="lg" />}
      {tier && ["backer", "sponsor", "partner"].includes(tier) && !thanks.telegram && <p className="support-note">{t("Add your Telegram @username in your profile to get your title in the AliasMode group.")}</p>}
      <div className="support-thanks-actions">
        <a className="btn" href={SUPPORTERS_URL} target="_blank" rel="noreferrer">{t("See the supporters page ↗")}</a>
        <button type="button" className="btn primary" onClick={onClose}>{t("Done")}</button>
      </div>
    </div>;
  } else if (deposit) {
    body = <div className="support-pay">
      {deposit.method === "card" ? <CardPaymentView deposit={deposit} /> : <CryptoPaymentView deposit={deposit} now={now} />}
      {error && <div className="tools-alert" role="alert">{error}</div>}
      <button type="button" className="btn ghost sm support-back" onClick={() => { setDeposit(null); setError(null); }}>{t("Back")}</button>
    </div>;
  } else {
    body = <>
      {supporter && supporter.totalCents > 0 && <SupporterStatus supporter={supporter} tiers={tiers} />}
      <TierCards tiers={tiers} current={supporter?.tier ?? null} />
      {!ready && <section className="support-callout">
        {mode === "local" ? <>
          <h3>{t("Support needs an AliasMode Cloud account")}</h3>
          <p>{t("Your badge and perks belong to your account, so they follow you to every device.")}</p>
          <button type="button" className="btn primary" onClick={onUseCloud}>{t("Switch to Cloud")}</button>
        </> : state === null ? <p className="support-loading" role="status">{t("Loading…")}</p>
          : "failed" in state ? <>
            <p>{t("Support could not be loaded. Check your connection and try again.")}</p>
            <button type="button" className="btn" onClick={() => void onReload()}>{t("Try again")}</button>
          </> : <p>{t("Support in the app is not available on your AliasMode Cloud yet.")}</p>}
        {state === null && mode === "cloud" ? null : <div className="support-anon">
          <p>{t("You can also support without an account on aliasmode.com, by card or crypto.")}</p>
          {websiteLink}
        </div>}
      </section>}
      {ready && <>
        <section className="support-form" aria-label={t("Your support")}>
          <div className="fld"><span>{t("Amount")}</span>
            <div className="support-amounts" role="radiogroup" aria-label={t("Amount")}>
              {SUPPORT_PRESETS.map((cents) => <button key={cents} type="button" role="radio" aria-checked={preset === cents} className={preset === cents ? "active" : ""}
                onClick={() => setPreset(cents)}>{usd(cents, language)}</button>)}
              <button type="button" role="radio" aria-checked={preset === "custom"} className={preset === "custom" ? "active" : ""} onClick={() => setPreset("custom")}>{t("Custom")}</button>
            </div>
          </div>
          {preset === "custom" && <label className="fld support-custom"><span>{t("Amount (USD)")}</span>
            <span className="store-money"><span aria-hidden="true">$</span>
              <input type="number" autoFocus min={minCents / 100} max={maxCents / 100} step="1" inputMode="decimal" aria-label={t("Support amount in US dollars")} value={custom} onChange={(event) => setCustom(event.target.value)} />
            </span>
          </label>}
          {preset === "custom" && custom && !validAmount && <p className="support-hint">{t("Enter an amount from {min} to {max}.", { min: formatUsd(minCents, language), max: formatUsd(maxCents, language) })}</p>}
          {validAmount && after && after.id !== supporter?.tier && <p className="support-unlock"><HeartIcon filled />{t("This makes you an AliasMode {tier}.", { tier: tierLabel(after.id, t) })}</p>}
          <div className="fld"><span>{t("Pay with")}</span>
            <div className="segmented support-methods" role="radiogroup" aria-label={t("Payment method")}>
              {canUseBalance && <button type="button" role="radio" aria-checked={method === "balance"} className={method === "balance" ? "active" : ""} onClick={() => setMethod("balance")}>
                {t("Balance")} <small>{formatUsd(balanceCents ?? 0, language)}</small>
              </button>}
              <button type="button" role="radio" aria-checked={method === "card"} className={method === "card" ? "active" : ""} onClick={() => setMethod("card")}>{t("Card")}</button>
              <button type="button" role="radio" aria-checked={method === "crypto"} className={method === "crypto" ? "active" : ""} onClick={() => setMethod("crypto")}>{t("Crypto")}</button>
            </div>
          </div>
        </section>
        <section className="support-profile" aria-labelledby="support-profile-title">
          <h3 id="support-profile-title">{t("How you appear")}</h3>
          <label className="fld"><span>{t("Display name")}</span>
            <input value={draft.displayName} maxLength={40} placeholder={t("Your name or company")} onChange={(event) => set("displayName", event.target.value)} />
          </label>
          <label className="extchk support-check">
            <input type="checkbox" checked={draft.public} onChange={(event) => set("public", event.target.checked)} />
            <span>{t("Show my name on the supporters page")}</span>
          </label>
          <label className="fld"><span>{t("Telegram username")} <span className="muted">{t("optional")}</span></span>
            <input value={draft.telegram} maxLength={33} placeholder="@username" onChange={(event) => set("telegram", event.target.value)} />
            <small>{t("From Backer up, the AliasMode team gives you a title in the Telegram group. The owner sets it by hand.")}</small>
          </label>
          {sponsorFields && <>
            <label className="fld"><span>{t("Link")}</span>
              <input value={draft.linkUrl} type="url" placeholder="https://" onChange={(event) => set("linkUrl", event.target.value)} />
            </label>
            <label className="fld"><span>{t("Logo URL")}</span>
              <input value={draft.logoUrl} type="url" placeholder="https://…/logo.svg" onChange={(event) => set("logoUrl", event.target.value)} />
              <small>{supporter?.logoUrl && !supporter.logoApproved ? t("Waiting for review. Your logo shows after the team approves it.") : t("Your logo shows on the supporters page after a review.")}</small>
            </label>
            {!urlsValid && <p className="support-hint">{t("Links must start with https://.")}</p>}
          </>}
          {dirty && <button type="button" className="btn sm support-save" disabled={busy || !urlsValid} onClick={() => void saveProfile()}>{t("Save profile")}</button>}
          {saved && <p className="support-saved" role="status">{t("Profile saved.")}</p>}
        </section>
      </>}
    </>;
  }

  return <div className="support-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <aside className="support-sheet proxy-page" role="dialog" aria-modal="true" aria-labelledby="support-title">
      <header className="support-head">
        <span className="support-head-mark"><HeartIcon filled /></span>
        <h2 id="support-title">{t("Support AliasMode")}</h2>
        <button ref={closeRef} type="button" className="support-close" aria-label={t("Close")} onClick={onClose}>
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </header>
      <div className="support-body">
        {!thanks && !deposit && <p className="support-lead">{t("AliasMode is free and open source. Supporters pay for servers and engine builds.")}</p>}
        {body}
      </div>
      {ready && !thanks && !deposit && <footer className="support-foot">
        {error && <div className="tools-alert" role="alert">{error}</div>}
        <button type="button" className="btn primary support-go" disabled={!validAmount || !urlsValid || busy} onClick={() => void pay()}>
          <HeartIcon filled />
          {busy ? t("Preparing…") : validAmount ? t("Support with {amount}", { amount: usd(amountCents, language) }) : t("Support AliasMode")}
        </button>
        <p className="support-fine">{method === "balance" ? t("One-time payment from your workspace balance.") : t("One-time payment. AliasMode stays free for everyone.")}</p>
      </footer>}
    </aside>
  </div>;
}

/** The small card after a success moment. */
export function SupportPromptCard({ onSupport, onSnooze }: { onSupport: () => void; onSnooze: () => void }) {
  const { t } = useTranslation();
  return <aside className="support-prompt" role="dialog" aria-labelledby="support-prompt-title">
    <span className="support-prompt-mark"><HeartIcon filled /></span>
    <div className="support-prompt-copy">
      <strong id="support-prompt-title">{t("Enjoying AliasMode?")}</strong>
      <p>{t("AliasMode is free and open source. Supporters pay for servers and engine builds.")}</p>
      <div className="support-prompt-actions">
        <button type="button" className="btn primary sm" onClick={onSupport}>{t("Support AliasMode")}</button>
        <button type="button" className="btn ghost sm" onClick={onSnooze}>{t("Not now")}</button>
      </div>
    </div>
    <button type="button" className="support-prompt-close" aria-label={t("Not now")} onClick={onSnooze}>
      <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
    </button>
  </aside>;
}
