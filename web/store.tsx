import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "./i18n.tsx";
import { ProxyToolsError, proxyRequest, readProxyProgress, requestProxyPreview } from "./proxies.tsx";
import { qrMatrix, qrSvgPath } from "./qr.ts";
import type { ProxySrc } from "./proxy-offer.tsx";
import { trackStoreEvent } from "./store-events.ts";
import type {
  CloudProxyOrder,
  CloudProxyProduct,
  CloudProxyPurchase,
  CloudPurchasedProxy,
  CloudWalletDeposit,
  CloudWalletEntry,
  DepositResponse,
  GetWalletResponse,
  ListPurchasedProxiesResponse,
  NobleProxyHandoffResponse,
  ProxyCatalogResponse,
  ProxyPurchaseResponse,
} from "../contracts/cloud-v1.ts";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The Cloud bodies of GET /v1/wallet, GET /v1/proxies and GET /v1/proxies/catalog, unchanged. */
export interface StoreSnapshot {
  available: true;
  wallet: GetWalletResponse;
  proxies: ListPurchasedProxiesResponse;
  /** null while NobleProxy's catalog is down; the wallet and the owned proxies still show. */
  catalog: ProxyCatalogResponse | null;
}
/** null while loading. `available: false` keeps the outside NobleProxy offer. */
export type StoreState = null | { available: false } | StoreSnapshot;

export class StoreError extends Error {
  constructor(message: string, readonly kind: "insufficient" | "forbidden" | "unavailable" | "network" | "other") { super(message); }
}

export function formatUsd(cents: number, language = "en-US"): string {
  return new Intl.NumberFormat(language, { style: "currency", currency: "USD" }).format(cents / 100);
}

export const MIN_DEPOSIT_CENTS = 500;
export const MAX_DEPOSIT_CENTS = 1_000_000;

/** Display name for a proxy country. `ANY` means Cloud picks the country. */
export function countryName(code: string, catalogName: string | undefined, t: Translate, language: string): string {
  if (catalogName) return catalogName;
  if (code === "ANY") return t("Any country");
  try { return new Intl.DisplayNames([language], { type: "region" }).of(code) ?? t("Unknown country"); } catch { return t("Unknown country"); }
}

export function isStripeCheckoutUrl(url: unknown): url is string {
  return typeof url === "string" && /^https:\/\/checkout\.stripe\.com\/[A-Za-z0-9/_\-.#%=+~]{1,2000}$/.test(url);
}

/** The NobleProxy sign-in link from Cloud: exactly this form, with no other parameter or fragment. */
export function isNobleProxyHandoffUrl(url: unknown): url is string {
  return typeof url === "string" && /^https:\/\/nobleproxy\.com\/continue\/aliasmode\?h=[A-Za-z0-9_-]{20,}$/.test(url);
}

/** Which request failed, so a NobleProxy refusal gets the text for that request. */
type StoreContext = "deposit" | "purchase" | "handoff" | "other";

async function storeRequest<T>(body?: Record<string, unknown>, context: StoreContext = "other"): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/ui/api/cloud-store", body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : { cache: "no-store" });
  } catch {
    throw new StoreError("AliasMode Cloud could not be reached. Check your connection and try again.", "network");
  }
  let data: any = null;
  try { data = await response.json(); } catch {}
  if (response.ok && data?.ok === true) return data as T;
  // Known Cloud codes get our own translated text; the server's English text is never shown.
  switch (data?.code) {
    case "insufficient_balance": throw new StoreError("Your balance is too low for this purchase.", "insufficient");
    case "owner_only": throw new StoreError("Only the workspace owner can do this.", "forbidden");
    case "email_not_verified": throw new StoreError("Verify your email in AliasMode first.", "forbidden");
    case "deposit_amount_out_of_range": throw new StoreError("Top-ups must be between $5 and $10,000.", "other");
    case "partner_unavailable":
      if (context === "deposit") throw new StoreError("Top-ups are not available right now. Try again in a few minutes.", "other");
      if (context === "handoff") throw new StoreError("NobleProxy is not available right now. Try again in a few minutes.", "other");
      throw new StoreError("Proxies are not available right now. You were not charged. Try again in a few minutes.", "other");
    case "partner_rejected":
      if (context === "deposit") throw new StoreError("NobleProxy did not accept this top-up. Try another amount or payment method.", "other");
      if (context === "handoff") throw new StoreError("NobleProxy could not open your account. Try again later or contact support.", "other");
      throw new StoreError("This order could not be filled. You were not charged. Try another country or a smaller quantity.", "other");
    case "record_not_found": throw new StoreError("This item was not found. Refresh the page and try again.", "other");
  }
  if (response.status === 402) throw new StoreError("Your balance is too low for this purchase.", "insufficient");
  if (response.status === 403) throw new StoreError("Only the workspace owner can do this.", "forbidden");
  if (response.status === 404) throw new StoreError("This is not available on your AliasMode Cloud yet.", "unavailable");
  if (response.status === 502 || response.status === 503 || response.status === 504) throw new StoreError("AliasMode Cloud could not be reached. Check your connection and try again.", "network");
  throw new StoreError("The request failed. Try again.", "other");
}

export async function loadStoreState(): Promise<StoreState> {
  try {
    const data = await storeRequest<{ available: boolean; wallet?: GetWalletResponse; proxies?: ListPurchasedProxiesResponse; catalog?: ProxyCatalogResponse | null }>();
    if (!data.available || !data.wallet || !data.proxies) return { available: false };
    return { available: true, wallet: data.wallet, proxies: data.proxies, catalog: data.catalog ?? null };
  } catch {
    return { available: false };
  }
}

/** Loads the wallet and store once Cloud is ready. Reload keeps the last good data on a failure. */
export function useCloudStore(enabled: boolean, key: string) {
  const [state, setState] = useState<StoreState>(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    const next = await loadStoreState();
    if (current !== generation.current) return;
    setState((previous) => next?.available === false && previous?.available === true ? previous : next);
  }, []);
  useEffect(() => {
    generation.current++;
    setState(null);
    if (enabled) void reload();
  }, [enabled, key, reload]);
  // While the shop is down, try again each time the window comes back to the front.
  const catalogMissing = state?.available === true && !state.catalog;
  useEffect(() => {
    if (!enabled || !catalogMissing) return;
    const retry = () => void reload();
    window.addEventListener("focus", retry);
    return () => window.removeEventListener("focus", retry);
  }, [enabled, catalogMissing, reload]);
  return { state: enabled ? state : null, reload };
}

export interface ProxyQuote {
  unitPriceCents: number;
  totalCents: number;
  /** Only when the catalog sends NobleProxy's public price for this tier and it is higher. */
  publicTotalCents?: number;
  savingPercent?: number;
}

/** Display only: Cloud prices the order itself from the same catalog tiers. */
export function quoteProxyPrice(product: CloudProxyProduct | undefined, quantity: number): ProxyQuote | null {
  if (!product || !Number.isSafeInteger(quantity) || quantity < 1) return null;
  const tier = [...product.tiers].sort((a, b) => b.minQty - a.minQty).find((candidate) => quantity >= candidate.minQty);
  if (!tier) return null;
  const quote: ProxyQuote = { unitPriceCents: tier.unitPriceCents, totalCents: tier.unitPriceCents * quantity };
  const percent = savingPercent(tier);
  if (percent) { quote.publicTotalCents = tier.publicUnitPriceCents! * quantity; quote.savingPercent = percent; }
  return quote;
}

function savingPercent(tier: CloudProxyProduct["tiers"][number] | undefined): number | null {
  const publicPrice = tier?.publicUnitPriceCents;
  if (!tier || typeof publicPrice !== "number" || !(publicPrice > tier.unitPriceCents)) return null;
  return Math.round((1 - tier.unitPriceCents / publicPrice) * 100) || null;
}

/** The discount on the smallest order, for the provider line. null when the catalog has no public price. */
export function catalogSavingPercent(product: CloudProxyProduct | undefined): number | null {
  return savingPercent(product && [...product.tiers].sort((a, b) => a.minQty - b.minQty)[0]);
}

/** Purposes in the order NobleProxy sends them, without any Xreacher purpose an older server may still list. */
export function shopProducts(catalog: ProxyCatalogResponse): CloudProxyProduct[] {
  return catalog.products.filter((product) => !/xreacher/i.test(product.label));
}

export const MAX_QUANTITY = 1000;
/** Slider stops from 1 to 1,000: single steps first, then wider ones. The number field takes any value. */
export const QUANTITY_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600, 750, 1000];

export function clampQuantity(value: number): number {
  return Math.min(MAX_QUANTITY, Math.max(1, Math.floor(value) || 1));
}

/** The slider stop closest to a quantity. */
export function quantityStep(quantity: number): number {
  let best = 0;
  QUANTITY_STEPS.forEach((step, index) => { if (Math.abs(step - quantity) < Math.abs(QUANTITY_STEPS[best]! - quantity)) best = index; });
  return best;
}

/**
 * One idempotency key per purchase attempt. A retry after a lost answer reuses
 * the key, so Cloud charges once; a new order or a settled answer gets a new key.
 */
export class PurchaseAttempts {
  private current: { order: string; key: string } | null = null;
  constructor(private readonly newKey: () => string = () => crypto.randomUUID()) {}
  keyFor(order: string): string {
    if (!this.current || this.current.order !== order) this.current = { order, key: this.newKey() };
    return this.current.key;
  }
  settle(): void { this.current = null; }
}

export type PurchaseOutcome =
  | { kind: "active" | "pending" | "review" | "failed"; result: ProxyPurchaseResponse }
  | { kind: "error"; error: StoreError };

/** `src` is the placement that opened the store; Cloud keeps it with the purchase. */
export interface ProxyOrder { type: string; country: string; quantity: number; src?: string }

/** `key` is a key chosen earlier (pay-then-buy): every retry of that order sends the same one. */
export async function buyProxies(attempts: PurchaseAttempts, order: ProxyOrder, key?: string): Promise<PurchaseOutcome> {
  const { type, country, quantity, src } = order;
  const idempotencyKey = key ?? attempts.keyFor(`${type}|${country}|${quantity}`);
  try {
    const result = await storeRequest<ProxyPurchaseResponse>({ action: "purchase", type, country, quantity, idempotencyKey, ...(src ? { src } : {}) }, "purchase");
    attempts.settle();
    const { status } = result.purchase;
    const kind = status === "active" ? "active" : status === "failed" ? "failed" : status === "needs_review" ? "review" : "pending";
    return { kind, result };
  } catch (error) {
    const failure = error instanceof StoreError ? error : new StoreError("The request failed. Try again.", "other");
    if (failure.kind !== "network") attempts.settle();
    return { kind: "error", error: failure };
  }
}

export async function createDeposit(amountCents: number, method: "card" | "crypto"): Promise<CloudWalletDeposit> {
  return (await storeRequest<DepositResponse>({ action: "deposit", amountCents, method }, "deposit")).deposit;
}

export async function depositStatus(depositId: string): Promise<CloudWalletDeposit> {
  return (await storeRequest<DepositResponse>({ action: "deposit-status", depositId }, "deposit")).deposit;
}

const LATE_CREDIT_MS = 24 * 60 * 60 * 1000;

/** An expired or failed crypto deposit is still credited if the exact payment arrives within 24 hours. */
export function mayStillBeCredited(deposit: CloudWalletDeposit, now = Date.now()): boolean {
  return deposit.method === "crypto" && (deposit.status === "expired" || deposit.status === "failed") && now < deposit.createdAt + LATE_CREDIT_MS;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * Polls a deposit until it settles. A crypto deposit that expired or failed is
 * still checked lightly (every 30 seconds) while it can be credited late.
 * Short network faults do not stop it.
 */
export async function watchDeposit(
  depositId: string,
  onUpdate: (deposit: CloudWalletDeposit) => void,
  signal: AbortSignal,
  intervalMs = 4000,
  lateIntervalMs = 30_000,
): Promise<CloudWalletDeposit | null> {
  let wait = intervalMs;
  while (!signal.aborted) {
    await sleep(wait, signal);
    if (signal.aborted) break;
    try {
      const deposit = await depositStatus(depositId);
      if (signal.aborted) break;
      onUpdate(deposit);
      if (deposit.status === "pending") wait = intervalMs;
      else if (mayStillBeCredited(deposit)) wait = lateIntervalMs;
      else return deposit;
    } catch {}
  }
  return null;
}

export type PayPlan =
  | { kind: "balance" }
  /** Pay `payCents` now. `extraCents` is what the $5 top-up minimum adds beyond the order. */
  | { kind: "pay"; payCents: number; extraCents: number }
  /** The shortfall is above the $10,000 top-up maximum. */
  | { kind: "too-large" };

/** How an order is paid: from the balance, or with one top-up of exactly the shortfall (at least $5). */
export function payPlan(totalCents: number, balanceCents: number): PayPlan {
  const shortfall = totalCents - Math.max(0, balanceCents);
  if (shortfall <= 0) return { kind: "balance" };
  if (shortfall > MAX_DEPOSIT_CENTS) return { kind: "too-large" };
  const payCents = Math.max(MIN_DEPOSIT_CENTS, shortfall);
  return { kind: "pay", payCents, extraCents: payCents - shortfall };
}

/** An order waiting for its top-up. The purchase key and `src` are fixed when the user clicks Pay. */
export interface PendingOrder extends ProxyOrder { totalCents: number; idempotencyKey: string; depositId: string }

const PENDING_ORDER_KEY = "aliasmode.store.pending-order";

function browserStorage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** Kept across restarts, so a top-up paid while the app was closed can finish its order with the same key. */
export function savePendingOrder(order: PendingOrder | null): void {
  try {
    if (order) browserStorage()?.setItem(PENDING_ORDER_KEY, JSON.stringify(order));
    else browserStorage()?.removeItem(PENDING_ORDER_KEY);
  } catch {}
}

export function loadPendingOrder(): PendingOrder | null {
  try {
    const value = JSON.parse(browserStorage()?.getItem(PENDING_ORDER_KEY) ?? "null");
    const valid = value && typeof value.type === "string" && typeof value.country === "string" && Number.isSafeInteger(value.quantity)
      && Number.isSafeInteger(value.totalCents) && typeof value.idempotencyKey === "string" && typeof value.depositId === "string"
      && (value.src === undefined || typeof value.src === "string");
    return valid ? value : null;
  } catch { return null; }
}

export function sameOrder(a: ProxyOrder, b: ProxyOrder): boolean {
  return a.type === b.type && a.country === b.country && a.quantity === b.quantity;
}

/** Deposits whose order this window has placed or is placing. */
const placedDeposits = new Set<string>();

/**
 * Places the order of a paid top-up, once. Repeated polls and a second page
 * do nothing; a retry after a lost answer sends the same key, so Cloud charges once.
 */
export async function buyAfterDeposit(order: PendingOrder, deposit: CloudWalletDeposit, placed = placedDeposits): Promise<PurchaseOutcome | null> {
  if (deposit.id !== order.depositId || deposit.status !== "paid" || placed.has(deposit.id)) return null;
  placed.add(deposit.id);
  const outcome = await buyProxies(new PurchaseAttempts(), order, order.idempotencyKey);
  if (outcome.kind === "error" && outcome.error.kind === "network") placed.delete(deposit.id);
  else if (loadPendingOrder()?.depositId === deposit.id) savePendingOrder(null);
  return outcome;
}

export type ResumedOrder =
  /** The top-up was paid while the app was closed: the credit is in the balance and the order waits for one click. */
  | { kind: "finish"; order: PendingOrder }
  /** The top-up is still open: show its payment again and buy when it arrives. */
  | { kind: "pay"; order: PendingOrder; deposit: CloudWalletDeposit };

/** Reads the order saved before a restart and drops it once nothing more can happen to its top-up. */
export async function resumePendingOrder(): Promise<ResumedOrder | null> {
  const order = loadPendingOrder();
  if (!order) return null;
  try {
    const deposit = await depositStatus(order.depositId);
    if (deposit.status === "paid") return { kind: "finish", order };
    if (deposit.status === "pending" || mayStillBeCredited(deposit)) return { kind: "pay", order, deposit };
  } catch (error) {
    if (error instanceof StoreError && error.kind === "network") return null;
  }
  savePendingOrder(null);
  return null;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * Gives one proxy to each selected profile, in order, through the same
 * preview-and-apply path as Proxies → Replace proxies. Open profiles are skipped.
 */
export async function assignProxiesToProfiles(
  proxies: CloudPurchasedProxy[], profileIds: string[], t: Translate, signal?: AbortSignal,
): Promise<{ updated: number; unchanged: number; skipped: number }> {
  const ids = profileIds.slice(0, proxies.length);
  if (!ids.length) return { updated: 0, unchanged: 0, skipped: 0 };
  const csv = ["profileId,type,host,port,user,pass", ...ids.map((id, index) => {
    const proxy = proxies[index]!;
    return [id, proxy.protocol, proxy.host, String(proxy.port), proxy.username, proxy.password].map(csvField).join(",");
  })].join("\n");
  const preview = await requestProxyPreview({ scope: { all: true, ids }, mode: "profileId", input: csv }, t, signal);
  const unchanged = preview.rows.filter((row) => row.status === "unchanged").length;
  let updated = 0;
  if (preview.rows.some((row) => row.status === "ready")) {
    await readProxyProgress(await proxyRequest("apply", { previewId: preview.previewId }, signal), (event) => {
      if (event.type === "replacement" && event.row.status === "updated") updated++;
    }, t, signal);
  }
  return { updated, unchanged, skipped: ids.length - updated - unchanged };
}

export function proxyLine(proxy: CloudPurchasedProxy): string {
  const auth = proxy.username ? `:${proxy.username}:${proxy.password}` : "";
  return proxy.protocol === "http" ? `${proxy.host}:${proxy.port}${auth}` : `${proxy.protocol}://${proxy.host}:${proxy.port}${auth}`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function countdown(expiresAt: number | null | undefined, now: number): string | null {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  const seconds = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60), rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

const GLYPHS = {
  check: "M5 12.5l4.2 4.2L19 7",
  shield: "M12 3l7 2.8v5.7c0 4.3-2.9 7.6-7 9.5-4.1-1.9-7-5.2-7-9.5V5.8L12 3z",
  bolt: "M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z",
  infinity: "M7.5 15.5c-2 0-3.5-1.6-3.5-3.5s1.5-3.5 3.5-3.5c3.5 0 5.5 7 9 7 2 0 3.5-1.6 3.5-3.5s-1.5-3.5-3.5-3.5c-3.5 0-5.5 7-9 7z",
  tag: "M3.5 12.2V4.5a1 1 0 011-1h7.7l8.3 8.3-8.7 8.7-8.3-8.3zM8 8h.01",
  card: "M3 6.5A1.5 1.5 0 014.5 5h15A1.5 1.5 0 0121 6.5v11a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5v-11zM3 10h18M7 15h3",
  coin: "M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 8.5h4a2 2 0 010 4h-4m0 0h4.5a2 2 0 010 4H9.5m0-8v8m1.5-10v2m0 8v2",
  back: "M15 18l-6-6 6-6",
  close: "M6 6l12 12M18 6L6 18",
  refresh: "M20 11a8 8 0 00-14.6-4.5M4 4v4h4M4 13a8 8 0 0014.6 4.5M20 20v-4h-4",
  lock: "M7 11V8a5 5 0 0110 0v3M5.5 11h13a.5.5 0 01.5.5v8a.5.5 0 01-.5.5h-13a.5.5 0 01-.5-.5v-8a.5.5 0 01.5-.5z",
  box: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM4 7.5l8 4.5 8-4.5M12 12v9",
} as const;

function Glyph({ name, className = "" }: { name: keyof typeof GLYPHS; className?: string }) {
  return <svg className={`store-glyph ${className}`} viewBox="0 0 24 24" aria-hidden="true"><path d={GLYPHS[name]} /></svg>;
}

/** NobleProxy's shield mark (from nobleproxy.com, the AliasMode team's own proxy brand), drawn without its glow. */
function NobleProxyMark() {
  return <svg className="store-np-mark" viewBox="0 0 32 32" aria-hidden="true">
    <path d="M16 6l8 3v9q0 4.5-8 9-8-4.5-8-9V9z" />
    <path d="M16 8l6.4 2.6V18q0 3.4-6.4 6.8-6.4-3.4-6.4-6.8v-7.4z" />
  </svg>;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return <button type="button" className="btn xs" aria-label={label} onClick={() => {
    void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  }}>{copied ? t("Copied") : t("Copy")}</button>;
}

export function QrCode({ value, label }: { value: string; label: string }) {
  const path = useMemo(() => {
    try { return { matrix: qrMatrix(value) }; } catch { return null; }
  }, [value]);
  if (!path) return null;
  const size = path.matrix.length + 8;
  return <svg className="store-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
    <rect width={size} height={size} fill="#fff" />
    <path d={qrSvgPath(path.matrix)} fill="#000" />
  </svg>;
}

/** The deposit as Cloud returns it, plus whether its checkout was already opened (reopened from the pending list, or opened for the user). */
export type ActiveDeposit = CloudWalletDeposit & { resumed?: boolean };

function DepositStatusLine({ deposit }: { deposit: ActiveDeposit }) {
  const { t, language } = useTranslation();
  const late = mayStillBeCredited(deposit);
  if (deposit.status === "paid") return <div className="tools-notice store-paid" role="status">{t("Payment received. {amount} was added to your balance.", { amount: formatUsd(deposit.amountCents, language) })}</div>;
  if (deposit.status === "expired") return late
    ? <div className="tools-notice" role="status">{t("Expired — if you already sent the exact amount, it will still be credited.")}</div>
    : <div className="tools-alert" role="alert">{t("This payment request expired. Start a new top-up if you still want to add funds.")}</div>;
  if (deposit.status === "failed") return late
    ? <div className="tools-notice" role="status">{t("The payment failed. If you already sent the exact amount, it will still be credited.")}</div>
    : <div className="tools-alert" role="alert">{t("The payment failed. You were not charged. Try again or choose another method.")}</div>;
  if (deposit.status === "disputed") return <div className="tools-alert" role="alert">{t("This payment is disputed. Support is reviewing it; your balance stays as it is until then.")}</div>;
  if (deposit.status === "refunded") return <div className="tools-alert" role="alert">{t("This payment was refunded. Support is reviewing it; your balance stays as it is until then.")}</div>;
  return <p className="store-waiting" role="status"><span className="store-dot" aria-hidden="true" />{t("Waiting for your payment… This page updates by itself.")}</p>;
}

export function CardPaymentView({ deposit }: { deposit: ActiveDeposit }) {
  const { t, language } = useTranslation();
  return <div className="store-payment">
    <div className="store-payment-head"><Glyph name="card" /><h4>{t("Pay {amount} by card", { amount: formatUsd(deposit.amountCents, language) })}</h4></div>
    {deposit.status === "pending" && (isStripeCheckoutUrl(deposit.card?.checkoutUrl)
      ? <>
        <p className="tools-hint">{t("Checkout opens in your browser on Stripe's secure page. Come back here when you are done.")}</p>
        <a className="btn primary store-payment-cta" href={deposit.card.checkoutUrl} target="_blank" rel="noreferrer">{deposit.resumed ? t("Reopen checkout ↗") : t("Open secure checkout ↗")}</a>
      </>
      : <p className="tools-hint">{t("Finish the card payment in your browser. This page updates when it arrives.")}</p>)}
    <DepositStatusLine deposit={deposit} />
  </div>;
}

export function CryptoPaymentView({ deposit, now = Date.now() }: { deposit: ActiveDeposit; now?: number }) {
  const { t, language } = useTranslation();
  const methods = deposit.crypto?.methods ?? [];
  const [methodId, setMethodId] = useState(methods[0]?.id ?? "");
  const method = methods.find((candidate) => candidate.id === methodId) ?? methods[0];
  const left = countdown(deposit.expiresAt, now);
  const head = <div className="store-payment-head"><Glyph name="coin" /><h4>{t("Pay {amount} in crypto", { amount: formatUsd(deposit.amountCents, language) })}</h4>
    {deposit.status === "pending" && left && <span className="store-timer tools-mono" title={t("Time left")}>{left}</span>}</div>;
  if (!method) return <div className="store-payment">{head}<DepositStatusLine deposit={deposit} /></div>;
  return <div className="store-payment">
    {head}
    {deposit.status === "pending" && <>
      {methods.length > 1 && <div className="segmented store-coins" role="radiogroup" aria-label={t("Coin and network")}>
        {methods.map((candidate) => <button key={candidate.id} type="button" role="radio" aria-checked={candidate.id === method.id} className={candidate.id === method.id ? "active" : ""} onClick={() => setMethodId(candidate.id)}>{candidate.label}</button>)}
      </div>}
      <div className="store-crypto">
        <QrCode value={method.paymentUri || method.address} label={t("QR code for the payment")} />
        <dl className="store-crypto-fields">
          <div className="store-field"><dt>{t("Send exactly")}</dt>
            <dd><strong className="tools-mono store-amount">{method.amount} {method.coin}</strong><CopyButton value={method.amount} label={t("Copy amount")} /></dd>
          </div>
          <div className="store-field"><dt>{t("Network")}</dt><dd><strong>{method.network}</strong></dd></div>
          <div className="store-field"><dt>{t("To this address")}</dt>
            <dd><code className="tools-mono store-address">{method.address}</code><CopyButton value={method.address} label={t("Copy address")} /></dd>
          </div>
        </dl>
      </div>
      <p className="store-note">{t("Send exactly this amount in one transfer. If your exchange deducts the withdrawal fee, add it on top.")}</p>
    </>}
    <DepositStatusLine deposit={deposit} />
  </div>;
}

const ENTRY_LABELS: Record<CloudWalletEntry["kind"], string> = {
  deposit: "Top-up", purchase: "Proxy purchase", renewal: "Proxy renewal", refund: "Refund", adjustment: "Adjustment",
};

/** Balance, top-ups and history. Opens from the balance link at the top of the page. */
export function WalletPanel({ wallet, owner, initialAmount = "20", onClose, onReload }: {
  wallet: GetWalletResponse;
  owner: boolean;
  initialAmount?: string;
  onClose: () => void;
  onReload: () => Promise<void>;
}) {
  const { t, language } = useTranslation();
  const [amount, setAmount] = useState(initialAmount);
  const [method, setMethod] = useState<"card" | "crypto">("card");
  const [deposit, setDeposit] = useState<ActiveDeposit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(deposit?.status === "pending" && deposit.method === "crypto");
  const amountCents = Math.round(Number(amount) * 100);
  const validAmount = Number.isSafeInteger(amountCents) && amountCents >= MIN_DEPOSIT_CENTS && amountCents <= MAX_DEPOSIT_CENTS;

  const watching = !!deposit && (deposit.status === "pending" || mayStillBeCredited(deposit));
  useEffect(() => {
    if (!deposit || !watching) return;
    const controller = new AbortController();
    void watchDeposit(deposit.id, (next) => {
      setDeposit((current) => current && current.id === next.id ? { ...next, resumed: current.resumed } : current);
      if (next.status === "paid") void onReload();
    }, controller.signal);
    return () => controller.abort();
  }, [deposit?.id, watching]);

  const start = async () => {
    if (!validAmount || busy) return;
    setBusy(true); setError(null);
    try {
      const created = await createDeposit(amountCents, method);
      setDeposit(created);
      if (created.method === "card" && !isStripeCheckoutUrl(created.card?.checkoutUrl)) setError(t("The checkout link is not valid. Try again."));
    } catch (failure) {
      setError(t(failure instanceof StoreError ? failure.message : "The request failed. Try again."));
    } finally { setBusy(false); }
  };

  const resume = async (depositId: string) => {
    setError(null);
    try {
      setDeposit({ ...await depositStatus(depositId), resumed: true });
    } catch (failure) {
      setError(t(failure instanceof StoreError ? failure.message : "The request failed. Try again."));
    }
  };

  const showForm = owner && (!deposit || deposit.status !== "pending");
  return <section className="tools-panel store-funds store-enter" aria-labelledby="store-funds-title">
    <div className="store-funds-head">
      <div className="store-funds-balance">
        <span id="store-funds-title" className="store-label">{t("Balance")}</span>
        <strong>{formatUsd(wallet.balanceCents, language)}</strong>
      </div>
      <p className="store-funds-note">{owner ? t("Pays for proxies and renewals in this workspace.") : t("Only the workspace owner can add funds and buy proxies.")}</p>
      <button type="button" className="iconbtn store-close" aria-label={t("Close")} onClick={onClose}><Glyph name="close" /></button>
    </div>
    {owner && <div className="store-funds-body">
      {showForm && <div className="store-topup">
        <label className="fld store-amount-field"><span>{t("Amount (USD)")}</span>
          <span className="store-money"><span aria-hidden="true">$</span>
            <input type="number" min={MIN_DEPOSIT_CENTS / 100} max={MAX_DEPOSIT_CENTS / 100} step="0.01" inputMode="decimal" aria-label={t("Top-up amount in US dollars")} value={amount} onChange={(event) => setAmount(event.target.value)} />
          </span>
        </label>
        <div className="fld"><span>{t("Payment method")}</span>
          <div className="segmented" role="radiogroup" aria-label={t("Payment method")}>
            {(["card", "crypto"] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={method === value} className={method === value ? "active" : ""} onClick={() => setMethod(value)}>{value === "card" ? t("Card") : t("Crypto")}</button>)}
          </div>
        </div>
        <button type="button" className="btn primary store-topup-go" disabled={!validAmount || busy} onClick={() => void start()}>
          {busy ? t("Preparing…") : validAmount ? t("Add {amount}", { amount: formatUsd(amountCents, language) }) : t("Add funds")}
        </button>
      </div>}
      {showForm && !validAmount && <p className="tools-hint">{t("Enter an amount from {min} to {max}.", { min: formatUsd(MIN_DEPOSIT_CENTS, language), max: formatUsd(MAX_DEPOSIT_CENTS, language) })}</p>}
      {deposit && (deposit.method === "card" ? <CardPaymentView deposit={deposit} /> : <CryptoPaymentView deposit={deposit} now={now} />)}
      {deposit && deposit.status !== "pending" && <button type="button" className="btn ghost sm store-done" onClick={() => setDeposit(null)}>{t("Close")}</button>}
      {wallet.pendingDeposits.length > 0 && !deposit && <div className="store-pending">
        <h4>{t("Waiting for payment")}</h4>
        {wallet.pendingDeposits.map((pending) => <div className="store-row" key={pending.depositId}>
          <span>{formatUsd(pending.amountCents, language)} · {pending.method === "card" ? t("Card") : t("Crypto")}</span>
          <button type="button" className="btn xs" onClick={() => void resume(pending.depositId)}>{pending.method === "card" ? t("Reopen checkout") : t("Show payment")}</button>
        </div>)}
      </div>}
      {error && <div className="tools-alert" role="alert">{error}</div>}
    </div>}
    <div className="store-history">
      <h4>{t("History")}</h4>
      {wallet.entries.length ? <table className="store-history-table"><tbody>
        {wallet.entries.map((entry) => <tr key={entry.id}>
          <td>{new Date(entry.createdAt).toLocaleDateString(language)}</td>
          <td>{t(ENTRY_LABELS[entry.kind] ?? "Adjustment")}{entry.description && <small>{entry.description}</small>}</td>
          <td className={`tools-mono store-entry ${entry.amountCents < 0 ? "minus" : "plus"}`}>{entry.amountCents > 0 ? "+" : ""}{formatUsd(entry.amountCents, language)}</td>
        </tr>)}
      </tbody></table> : <p className="tools-hint">{t("No transactions yet.")}</p>}
    </div>
  </section>;
}

function ProxyAssign({ proxies, selectedProfileIds, onProfilesChanged, children }: {
  proxies: CloudPurchasedProxy[];
  selectedProfileIds: string[];
  onProfilesChanged: () => Promise<void>;
  /** More buttons after Assign, for example View my proxies. */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const count = Math.min(proxies.length, selectedProfileIds.length);
  const assign = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const done = await assignProxiesToProfiles(proxies, selectedProfileIds, t);
      setResult(t("{updated} profiles got a new proxy. {skipped} were skipped (open profiles are skipped).", { updated: done.updated, skipped: done.skipped }));
      await onProfilesChanged().catch(() => {});
    } catch (failure) {
      setError(failure instanceof ProxyToolsError ? failure.message : t("The proxies could not be assigned. Try again."));
    } finally { setBusy(false); }
  };
  return <div className="store-assign">
    <div className="proxy-actions">
      <button type="button" className="btn primary" disabled={busy || !count} onClick={() => void assign()}>
        {busy ? t("Assigning…") : t("Assign to {count} selected profiles", { count })}
      </button>
      {children}
      <CopyButton value={proxies.map(proxyLine).join("\n")} label={t("Copy all proxies")} />
    </div>
    {!selectedProfileIds.length && <p className="tools-hint">{t("Select profiles on the profile list first. Each selected profile gets one proxy, in list order.")}</p>}
    {result && <div className="tools-notice" role="status">{result}</div>}
    {error && <div className="tools-alert" role="alert">{error}</div>}
  </div>;
}

function ProxyList({ proxies, countryLabel }: { proxies: CloudPurchasedProxy[]; countryLabel: (code: string) => string }) {
  return <ul className="store-proxies">{proxies.map((proxy) => <li key={proxy.id}><span className="tools-mono">{proxyLine(proxy)}</span><small>{countryLabel(proxy.country)}</small></li>)}</ul>;
}

/** What happened to a purchase. A delivered order shows its proxies and one main action: assign them. */
export function PurchaseResult({ outcome, orders = [], countryLabel = (code) => code, selectedProfileIds, onProfilesChanged, onViewOwned, onDone }: {
  outcome: PurchaseOutcome;
  /** Latest owned orders. Their credentials win: a renewal can change them. */
  orders?: CloudProxyOrder[];
  countryLabel?: (code: string) => string;
  selectedProfileIds: string[];
  onProfilesChanged: () => Promise<void>;
  onViewOwned?: () => void;
  /** Back to the order form. */
  onDone?: () => void;
}) {
  const { t, language } = useTranslation();
  if (outcome.kind === "error") return <div className="tools-alert" role="alert">{t(outcome.error.message)}</div>;
  const { purchase, order } = outcome.result;
  const view = onViewOwned && <button type="button" className="btn" onClick={onViewOwned}>{t("View my proxies")}</button>;
  const back = onDone && <button type="button" className="btn ghost" onClick={onDone}>{t("Buy more")}</button>;
  if (outcome.kind !== "active") {
    const failed = outcome.kind === "failed";
    return <div className="store-result store-enter">
      <span className={`store-result-icon${failed ? " failed" : " waiting"}`}><Glyph name={failed ? "close" : "box"} /></span>
      <p className="store-result-text" role={failed ? "alert" : "status"}>{failed
        ? t("We could not deliver this order. {amount} was refunded to your balance.", { amount: formatUsd(purchase.totalCents, language) })
        : outcome.kind === "review" ? t("We're checking this order. You'll see the proxies or a refund soon.")
        : t("Your order is being prepared. The proxies appear under My proxies in a few minutes.")}</p>
      <div className="proxy-actions">{view}{back}</div>
    </div>;
  }
  const proxies = orders.find((item) => purchase.orderId && item.id === purchase.orderId)?.proxies ?? order?.proxies ?? [];
  return <div className="store-result store-enter">
    <span className="store-result-icon"><Glyph name="check" /></span>
    <h3 role="status">{t("Your {count} proxies are ready.", { count: proxies.length })}</h3>
    <ProxyList proxies={proxies} countryLabel={countryLabel} />
    {proxies.length > 0
      ? <ProxyAssign proxies={proxies} selectedProfileIds={selectedProfileIds} onProfilesChanged={onProfilesChanged}>{view}</ProxyAssign>
      : view && <div className="proxy-actions">{view}</div>}
    {back && <div className="store-result-more">{back}</div>}
  </div>;
}

/** −/+ buttons, a number field and a slider for 1 to 1,000 proxies. */
export function QuantityPicker({ value, disabled, onChange }: { value: number; disabled?: boolean; onChange: (value: number) => void }) {
  const { t, language } = useTranslation();
  return <div className="fld store-quantity">
    <span>{t("Quantity")}</span>
    <div className="store-quantity-row">
      <div className="store-stepper">
        <button type="button" aria-label={t("Fewer proxies")} disabled={disabled || value <= 1} onClick={() => onChange(clampQuantity(value - 1))}>−</button>
        <input type="number" min={1} max={MAX_QUANTITY} step={1} value={value} disabled={disabled} aria-label={t("Number of proxies")} onChange={(event) => onChange(clampQuantity(Number(event.target.value)))} />
        <button type="button" aria-label={t("More proxies")} disabled={disabled || value >= MAX_QUANTITY} onClick={() => onChange(clampQuantity(value + 1))}>+</button>
      </div>
      <div className="store-slider-wrap">
        <input type="range" className="store-slider" min={0} max={QUANTITY_STEPS.length - 1} step={1} value={quantityStep(value)} disabled={disabled}
          style={{ "--fill": `${(quantityStep(value) / (QUANTITY_STEPS.length - 1)) * 100}%` } as CSSProperties}
          aria-label={t("Number of proxies")} aria-valuetext={String(value)} onChange={(event) => onChange(QUANTITY_STEPS[Number(event.target.value)] ?? 1)} />
        <div className="store-slider-scale" aria-hidden="true"><span>1</span><span>{MAX_QUANTITY.toLocaleString(language)}</span></div>
      </div>
    </div>
  </div>;
}

/** The benefits that are true for every NobleProxy proxy, plus the AliasMode discount when the catalog sends the public price. */
export function TrustPoints({ percent }: { percent: number | null }) {
  const { t } = useTranslation();
  return <ul className="store-trust">
    <li><Glyph name="shield" />{t("Static residential IPs")}</li>
    <li><Glyph name="infinity" />{t("Unlimited bandwidth")}</li>
    <li><Glyph name="bolt" />{t("Instant activation")}</li>
    {percent ? <li className="store-trust-deal"><Glyph name="tag" />{t("{percent}% off via NobleProxy", { percent })}</li> : null}
  </ul>;
}

function PoweredBy() {
  const { t } = useTranslation();
  return <p className="store-powered"><NobleProxyMark /><span>{t("Powered by NobleProxy")}</span></p>;
}

type Checkout =
  /** The user clicked Pay: the purchase key exists, the payment method is not chosen yet. */
  | { step: "choose"; order: Omit<PendingOrder, "depositId">; payCents: number; extraCents: number }
  | { step: "pay"; order: PendingOrder; deposit: ActiveDeposit };

/**
 * The purchase card. One button: it buys from the balance when the balance
 * covers the order, or takes the missing amount by card or crypto and then
 * buys by itself when the payment arrives.
 */
export function ProxyShop({ catalog, orders = [], balanceCents, initialQuantity = 1, focusKey = 0, src = "direct", selectedProfileIds, onReload, onProfilesChanged, onViewOwned, onBuyMore }: {
  catalog: ProxyCatalogResponse;
  orders?: CloudProxyOrder[];
  balanceCents: number;
  initialQuantity?: number;
  /** Changes when an offer elsewhere opens the shop: it scrolls into view with the asked quantity. */
  focusKey?: number;
  /** The placement that opened the store. */
  src?: ProxySrc;
  selectedProfileIds: string[];
  onReload: () => Promise<void>;
  onProfilesChanged: () => Promise<void>;
  onViewOwned?: () => void;
  /** Buy more, after a purchase. */
  onBuyMore?: () => void;
}) {
  const { t, language } = useTranslation();
  const products = shopProducts(catalog);
  const [type, setType] = useState(products[0]?.type ?? "");
  const product = products.find((candidate) => candidate.type === type) ?? products[0];
  const [country, setCountry] = useState(product?.countries[0]?.code ?? "");
  const [quantity, setQuantity] = useState(clampQuantity(initialQuantity));
  const [busy, setBusy] = useState<"buy" | "deposit" | null>(null);
  const [outcome, setOutcome] = useState<PurchaseOutcome | null>(null);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  /** A top-up from an earlier session that was paid: its order waits for one click, with its own key. */
  const [finish, setFinish] = useState<PendingOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempts = useRef(new PurchaseAttempts());
  const ref = useRef<HTMLElement | null>(null);
  const paying = checkout?.step === "pay" ? checkout : null;
  const now = useNow(paying?.deposit.status === "pending" && paying.deposit.method === "crypto");

  useEffect(() => {
    if (initialQuantity > 0) setQuantity(clampQuantity(initialQuantity));
    if (focusKey) ref.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [initialQuantity, focusKey]);

  useEffect(() => {
    let live = true;
    void resumePendingOrder().then((resumed) => {
      if (!live || !resumed) return;
      setType(resumed.order.type); setCountry(resumed.order.country); setQuantity(clampQuantity(resumed.order.quantity));
      if (resumed.kind === "finish") setFinish(resumed.order);
      else setCheckout({ step: "pay", order: resumed.order, deposit: { ...resumed.deposit, resumed: true } });
    });
    return () => { live = false; };
  }, []);

  const place = async (order: PendingOrder, deposit: CloudWalletDeposit) => {
    setBusy("buy"); setError(null);
    const next = await buyAfterDeposit(order, deposit);
    setBusy(null);
    if (!next) return;
    if (next.kind === "error" && next.error.kind === "network") setError(t(next.error.message));
    else { setCheckout(null); setOutcome(next); }
    await onReload();
  };

  const watching = !!paying && (paying.deposit.status === "pending" || mayStillBeCredited(paying.deposit));
  useEffect(() => {
    if (!paying || !watching) return;
    const controller = new AbortController();
    const order = paying.order;
    void watchDeposit(paying.deposit.id, (next) => {
      setCheckout((current) => current?.step === "pay" && current.deposit.id === next.id ? { ...current, deposit: { ...next, resumed: current.deposit.resumed } } : current);
      if (next.status === "paid") void place(order, next);
    }, controller.signal);
    return () => controller.abort();
  }, [paying?.deposit.id, watching]);

  if (!product) return <ShopUnavailable onReload={onReload} />;
  const countryCode = product.countries.some((candidate) => candidate.code === country) ? country : product.countries[0]?.code ?? "";
  const countryLabel = (code: string) => countryName(code, product.countries.find((item) => item.code === code)?.name, t, language);
  const order: ProxyOrder = { type: product.type, country: countryCode, quantity, src };
  const quote = quoteProxyPrice(product, quantity);
  const minimum = Math.min(...product.tiers.map((tier) => tier.minQty));
  const plan = quote ? payPlan(quote.totalCents, balanceCents) : null;
  const edit = (apply: () => void) => { apply(); setOutcome(null); setError(null); };
  const describe = (item: ProxyOrder) => `${t("{count} × {type}", { count: item.quantity, type: products.find((candidate) => candidate.type === item.type)?.label ?? t("Proxies") })} · ${countryLabel(item.country)}`;

  const buy = async () => {
    if (!quote || plan?.kind !== "balance" || busy) return;
    trackStoreEvent("pay_click", src);
    setBusy("buy"); setOutcome(null); setError(null);
    // A paid top-up's order keeps the key and the src chosen at Pay.
    const paid = finish && sameOrder(finish, order) ? finish : null;
    const next = await buyProxies(attempts.current, paid ? { ...order, src: paid.src } : order, paid?.idempotencyKey);
    if (!(next.kind === "error" && next.error.kind === "network")) { setFinish(null); savePendingOrder(null); }
    setOutcome(next); setBusy(null);
    if (next.kind !== "error" || next.error.kind === "insufficient") await onReload();
  };
  const startPay = () => {
    if (!quote || plan?.kind !== "pay" || busy) return;
    trackStoreEvent("pay_click", src);
    setOutcome(null); setError(null);
    setCheckout({ step: "choose", order: { ...order, totalCents: quote.totalCents, idempotencyKey: crypto.randomUUID() }, payCents: plan.payCents, extraCents: plan.extraCents });
  };
  const pay = async (method: "card" | "crypto") => {
    if (checkout?.step !== "choose" || busy) return;
    setBusy("deposit"); setError(null);
    try {
      const deposit = await createDeposit(checkout.payCents, method);
      const pending: PendingOrder = { ...checkout.order, depositId: deposit.id };
      savePendingOrder(pending);
      const link = deposit.method === "card" && isStripeCheckoutUrl(deposit.card?.checkoutUrl) ? deposit.card.checkoutUrl : null;
      setCheckout({ step: "pay", order: pending, deposit: { ...deposit, resumed: !!link } });
      if (link && ref.current) openOutsideLink(link, ref.current);
      else if (deposit.method === "card") setError(t("The checkout link is not valid. Try again."));
    } catch (failure) {
      setError(t(failure instanceof StoreError ? failure.message : "The request failed. Try again."));
    } finally { setBusy(null); }
  };
  const leave = () => {
    if (checkout?.step === "pay") savePendingOrder(null);
    setCheckout(null); setError(null);
  };

  let body: ReactNode;
  if (checkout) {
    const pendingOrder = checkout.order;
    const paid = paying?.deposit.status === "paid";
    body = <div className="store-checkout store-enter" key={checkout.step}>
      <div className="store-checkout-head">
        {!paid && <button type="button" className="btn ghost sm store-back" disabled={busy === "deposit"} onClick={leave}><Glyph name="back" />{t("Back")}</button>}
        <p className="store-checkout-order">{describe(pendingOrder)} <span>·</span> <strong>{formatUsd(pendingOrder.totalCents, language)}</strong></p>
      </div>
      {checkout.step === "choose" ? <>
        <div className="store-checkout-title">
          <h3>{t("Pay {amount}", { amount: formatUsd(checkout.payCents, language) })}</h3>
          {checkout.extraCents > 0 && <p>{t("Includes {amount} added to your balance.", { amount: formatUsd(checkout.extraCents, language) })}</p>}
        </div>
        <div className="store-methods" role="group" aria-label={t("Payment method")}>
          <button type="button" className="store-method" disabled={!!busy} onClick={() => void pay("card")}>
            <Glyph name="card" /><span><strong>{t("Card")}</strong><small>{t("Secure checkout by Stripe")}</small></span>
          </button>
          <button type="button" className="store-method" disabled={!!busy} onClick={() => void pay("crypto")}>
            <Glyph name="coin" /><span><strong>{t("Crypto")}</strong><small>{t("Pay from any wallet or exchange")}</small></span>
          </button>
        </div>
        {busy === "deposit" && <p className="store-waiting" role="status"><span className="store-dot" aria-hidden="true" />{t("Preparing…")}</p>}
      </> : paying && (paying.deposit.method === "card" ? <CardPaymentView deposit={paying.deposit} /> : <CryptoPaymentView deposit={paying.deposit} now={now} />)}
      {error && <div className="tools-alert" role="alert">{error}
        {paid && paying && busy !== "buy" && <> <button type="button" className="btn xs" onClick={() => void place(paying.order, paying.deposit)}>{t("Try again")}</button></>}
      </div>}
      {paid
        ? busy === "buy" && <p className="store-waiting" role="status"><span className="store-dot" aria-hidden="true" />{t("Placing your order…")}</p>
        : <p className="store-checkout-foot"><Glyph name="lock" />{t("Your order is placed by itself once the payment arrives.")}</p>}
    </div>;
  } else if (outcome && outcome.kind !== "error") {
    body = <PurchaseResult outcome={outcome} orders={orders} countryLabel={countryLabel} selectedProfileIds={selectedProfileIds} onProfilesChanged={onProfilesChanged} onViewOwned={onViewOwned} onDone={() => { onBuyMore?.(); setOutcome(null); }} />;
  } else {
    body = <div className="store-hero-grid">
      <div className="store-hero-main">
        <div className="store-hero-head">
          <h2 id="store-shop-title">{t("Give every account its own IP")}</h2>
          <TrustPoints percent={catalogSavingPercent(product)} />
        </div>
        {finish && <div className="store-finish" role="status">
          <span>{t("Your balance was topped up — finish your order.")}</span>
          <button type="button" className="iconbtn" aria-label={t("Close")} onClick={() => { setFinish(null); savePendingOrder(null); }}><Glyph name="close" /></button>
        </div>}
        <div className="store-form">
          <label className="fld"><span>{t("Purpose")}</span>
            <select value={product.type} disabled={!!busy} onChange={(event) => edit(() => setType(event.target.value))}>
              {products.map((candidate) => <option key={candidate.type} value={candidate.type}>{candidate.label}</option>)}
            </select>
          </label>
          <label className="fld"><span>{t("Country")}</span>
            <select value={countryCode} disabled={!!busy} onChange={(event) => edit(() => setCountry(event.target.value))}>
              {product.countries.map((candidate) => <option key={candidate.code} value={candidate.code}>{countryName(candidate.code, candidate.name, t, language)}</option>)}
            </select>
          </label>
          <QuantityPicker value={quantity} disabled={!!busy} onChange={(next) => edit(() => setQuantity(next))} />
        </div>
      </div>
      <div className="store-price" aria-live="polite">
        {quote && plan ? <>
          <span className="store-label">{t("Total")}</span>
          <strong className="store-price-total">{formatUsd(quote.totalCents, language)}</strong>
          <span className="store-price-unit">{t("{price} per proxy", { price: formatUsd(quote.unitPriceCents, language) })}</span>
          {quote.publicTotalCents !== undefined && <span className="store-price-save">
            <s>{formatUsd(quote.publicTotalCents, language)}</s>
            <span className="store-save">{t("Save {amount}", { amount: formatUsd(quote.publicTotalCents - quote.totalCents, language) })}</span>
          </span>}
          <span className="store-cta-gap" aria-hidden="true" />
          {plan.kind === "balance"
            ? <button type="button" className="btn primary store-cta" disabled={!!busy} onClick={() => void buy()}>
              {busy === "buy" ? t("Buying…") : quantity === 1 ? t("Buy 1 proxy · {amount}", { amount: formatUsd(quote.totalCents, language) }) : t("Buy {count} proxies · {amount}", { count: quantity, amount: formatUsd(quote.totalCents, language) })}</button>
            : <button type="button" className="btn primary store-cta" disabled={plan.kind !== "pay" || !!busy} onClick={startPay}>
              {plan.kind === "pay" ? t("Pay {amount}", { amount: formatUsd(plan.payCents, language) }) : t("Add funds")}</button>}
          <div className="store-cta-note">
            {plan.kind === "balance" && <span>{t("Paid from your balance.")}</span>}
            {plan.kind === "pay" && <span>{balanceCents > 0 ? t("Your {balance} balance is used first.", { balance: formatUsd(balanceCents, language) }) : t("Card or crypto")}</span>}
            {plan.kind === "pay" && plan.extraCents > 0 && <span>{t("Includes {amount} added to your balance.", { amount: formatUsd(plan.extraCents, language) })}</span>}
            {plan.kind === "too-large" && <span>{t("This order is above the $10,000 top-up limit. Add funds first.")}</span>}
          </div>
        </> : <p className="tools-hint">{t("Order at least {count} proxies.", { count: minimum })}</p>}
        {outcome?.kind === "error" && <PurchaseResult outcome={outcome} selectedProfileIds={selectedProfileIds} onProfilesChanged={onProfilesChanged} />}
      </div>
    </div>;
  }

  return <section ref={ref} className="tools-panel store-shop" aria-labelledby="store-shop-title">
    {body}
    <footer className="store-hero-foot"><PoweredBy /></footer>
  </section>;
}

/** Shown instead of the shop while NobleProxy's catalog cannot be read. The balance and owned proxies stay. */
function ShopUnavailable({ onReload }: { onReload: () => Promise<void> }) {
  const { t } = useTranslation();
  return <section className="tools-panel store-shop store-empty-card" aria-labelledby="store-shop-title">
    <span className="store-empty-icon"><Glyph name="box" /></span>
    <h3 id="store-shop-title">{t("Buy proxies")}</h3>
    <p role="status">{t("Store temporarily unavailable. Your balance and proxies are not affected.")}</p>
    <button type="button" className="btn" onClick={() => void onReload()}>{t("Try again")}</button>
  </section>;
}

function RenewalStatus({ order }: { order: CloudProxyOrder }) {
  const { t } = useTranslation();
  if (order.renewalStatus === "pending") return <div className="tools-notice" role="status">{t("Renewal in progress…")}</div>;
  if (order.renewalStatus === "needs_review") return <div className="tools-notice" role="status">{t("The renewal is being checked by support. These proxies keep working.")}</div>;
  if (order.renewalStatus !== "renewal_failed") return null;
  return <div className="tools-alert" role="alert">{order.renewalFailure === "partner_failed"
    ? t("Renewal could not be completed. You were not charged. It is tried again before these proxies expire.")
    : t("Renewal failed. Top up your balance to keep these proxies.")}</div>;
}

function OwnedProxies({ orders, pendingPurchases, catalog, owner, selectedProfileIds, onReload, onProfilesChanged, onBuy }: {
  orders: CloudProxyOrder[];
  pendingPurchases: CloudProxyPurchase[];
  catalog: ProxyCatalogResponse | null;
  owner: boolean;
  selectedProfileIds: string[];
  onReload: () => Promise<void>;
  onProfilesChanged: () => Promise<void>;
  onBuy?: () => void;
}) {
  const { t, language } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const product = (type: string) => catalog?.products.find((item) => item.type === type);
  const label = (type: string) => product(type)?.label ?? t("Proxies");
  const country = (type: string, code: string) => countryName(code, product(type)?.countries.find((item) => item.code === code)?.name, t, language);
  const date = (value: number) => new Date(value).toLocaleDateString(language);
  const toggle = async (order: CloudProxyOrder) => {
    setBusy(order.id); setError(null);
    try {
      await storeRequest({ action: "auto-renew", orderId: order.id, enabled: !order.autoRenew });
      await onReload();
    } catch (failure) {
      setError(t(failure instanceof StoreError ? failure.message : "The request failed. Try again."));
    } finally { setBusy(null); }
  };
  const empty = !orders.length && !pendingPurchases.length;
  return <section className="tools-panel store-orders" aria-labelledby="store-orders-title">
    <div className="store-section-head">
      <div><h3 id="store-orders-title">{t("My proxies")}</h3><p>{t("Renewals are paid from your balance.")}</p></div>
      <div className="proxy-actions">
        <button type="button" className="iconbtn" aria-label={t("Refresh")} title={t("Refresh")} onClick={() => void onReload()}><Glyph name="refresh" /></button>
        {owner && <ManageOnNobleProxy />}
      </div>
    </div>
    {error && <div className="store-orders-alert tools-alert" role="alert">{error}</div>}
    {empty ? <div className="store-empty">
      <span className="store-empty-icon"><Glyph name="box" /></span>
      <h3>{t("No proxies yet")}</h3>
      <p>{t("Proxies you buy appear here, ready to assign to your profiles.")}</p>
      {onBuy && <button type="button" className="btn primary" onClick={onBuy}>{t("Buy proxies")}</button>}
    </div> : <ul className="store-order-list">
      {pendingPurchases.map((purchase) => <li className="store-order" key={purchase.id}>
        <div className="store-order-head">
          <div><strong>{t("{count} × {type}", { count: purchase.quantity, type: label(purchase.type) })}</strong>
            <small>{country(purchase.type, purchase.country)} · {formatUsd(purchase.totalCents, language)}</small></div>
          <span className="store-waiting" role="status"><span className="store-dot" aria-hidden="true" />
            {purchase.status === "needs_review" ? t("Being checked by support") : t("Processing…")}</span>
        </div>
      </li>)}
      {orders.map((order) => <li className="store-order" key={order.id}>
        <div className="store-order-head">
          <div><strong>{t("{count} × {type}", { count: order.quantity, type: label(order.type) })}</strong>
            <small>{country(order.type, order.country)} · {t("Expires {date}", { date: date(order.expiresAt) })}</small></div>
          {owner
            ? <label className="store-switch"><input type="checkbox" role="switch" checked={order.autoRenew} disabled={busy === order.id} onChange={() => void toggle(order)} /><span>{t("Auto-renew")}</span></label>
            : <span className="tools-hint">{order.autoRenew ? t("Auto-renew is on") : t("Auto-renew is off")}</span>}
        </div>
        <RenewalStatus order={order} />
        <details className="store-order-details"><summary>{t("Show {count} proxies", { count: order.proxies.length })}</summary>
          <ProxyList proxies={order.proxies} countryLabel={(code) => country(order.type, code)} />
          {owner && order.proxies.length > 0 && <ProxyAssign proxies={order.proxies} selectedProfileIds={selectedProfileIds} onProfilesChanged={onProfilesChanged} />}
        </details>
      </li>)}
    </ul>}
  </section>;
}

export type HandoffOutcome =
  | { kind: "opened"; url: string; expiresAt: number }
  /** This Cloud has no handoff route yet (404): the button goes away. */
  | { kind: "missing" }
  | { kind: "error"; error: StoreError };

/** Asks Cloud for a short-lived NobleProxy sign-in link and opens it, only if it has the exact expected form. */
export async function openNobleProxy(open: (url: string) => void): Promise<HandoffOutcome> {
  try {
    const handoff = await storeRequest<NobleProxyHandoffResponse>({ action: "nobleproxy-handoff" }, "handoff");
    if (!isNobleProxyHandoffUrl(handoff.url)) return { kind: "error", error: new StoreError("NobleProxy returned a link that is not valid. Try again.", "other") };
    open(handoff.url);
    return { kind: "opened", url: handoff.url, expiresAt: handoff.expiresAt };
  } catch (error) {
    const failure = error instanceof StoreError ? error : new StoreError("The request failed. Try again.", "other");
    return failure.kind === "unavailable" ? { kind: "missing" } : { kind: "error", error: failure };
  }
}

/**
 * Opens an outside link the same way as a click on a normal `target="_blank"` link,
 * so the desktop shell's allowlist decides. The link is placed inside the app root,
 * where the click guard keeps the shell plugin from cancelling it.
 */
function openOutsideLink(url: string, container: HTMLElement) {
  const link = document.createElement("a");
  link.href = url; link.target = "_blank"; link.rel = "noreferrer"; link.hidden = true;
  container.append(link);
  link.click();
  link.remove();
}

export function NobleProxyButton({ outcome, busy, onClick }: { outcome: HandoffOutcome | null; busy: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  if (outcome?.kind === "missing") return null;
  return <div className="store-manage">
    <button type="button" className="btn sm" disabled={busy} onClick={onClick}>{busy ? t("Opening…") : t("Manage on NobleProxy ↗")}</button>
    {outcome?.kind === "opened" && outcome.expiresAt > Date.now() && <small className="tools-hint">
      {t("NobleProxy opens in your browser.")} <a href={outcome.url} target="_blank" rel="noreferrer">{t("Not opened? Open NobleProxy")}</a>
    </small>}
    {outcome?.kind === "error" && <div className="tools-alert" role="alert">{t(outcome.error.message)}</div>}
  </div>;
}

function ManageOnNobleProxy() {
  const [outcome, setOutcome] = useState<HandoffOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const open = async () => {
    if (busy) return;
    setBusy(true); setOutcome(null);
    const next = await openNobleProxy((url) => { if (ref.current) openOutsideLink(url, ref.current); });
    setOutcome(next); setBusy(false);
  };
  return <div ref={ref}><NobleProxyButton outcome={outcome} busy={busy} onClick={() => void open()} /></div>;
}

export type StoreTab = "buy" | "owned" | "tools";

/** The Cloud Proxies page: Buy proxies, My proxies and the proxy tools as tabs, with the balance in the corner. */
export function StorePage({ state, role, selectedProfileIds, requestedQuantity = 0, focusKey = 0, active = true, src = "direct", entryKey = 0, tools, initialTab, onReload, onProfilesChanged, onEnter }: {
  state: StoreSnapshot;
  role?: string;
  selectedProfileIds: string[];
  requestedQuantity?: number;
  focusKey?: number;
  /** The Proxies page is on screen. */
  active?: boolean;
  /** The placement that opened the store, and a number that changes with each opening. */
  src?: ProxySrc;
  entryKey?: number;
  /** The Check and Replace proxy tools. */
  tools?: ReactNode;
  initialTab?: StoreTab;
  onReload: () => Promise<void>;
  onProfilesChanged: () => Promise<void>;
  /** A button on this page opens the shop: records the entry and makes `src` its placement. */
  onEnter?: (src: ProxySrc) => void;
}) {
  const { t, language } = useTranslation();
  const owner = role === "owner";
  // Only owners can buy, so others start on their proxies.
  const [tab, setTab] = useState<StoreTab>(initialTab ?? (owner ? "buy" : "owned"));
  const [funds, setFunds] = useState(false);
  useEffect(() => { if (focusKey) setTab("buy"); }, [focusKey]);
  const shopShown = active && tab === "buy" && owner && !!state.catalog;
  useEffect(() => { if (shopShown) trackStoreEvent("store_view", src); }, [shopShown, src, entryKey]);
  const owned = state.proxies.orders.reduce((total, order) => total + order.quantity, 0);
  const tabs: Array<[StoreTab, string]> = [["buy", t("Buy proxies")], ["owned", owned ? t("My proxies ({count})", { count: owned }) : t("My proxies")], ["tools", t("Tools")]];
  return <div className="store-page">
    <div className="store-bar">
      <div className="store-tabs" role="tablist" aria-label={t("Proxies")}>
        {tabs.map(([value, label]) => <button key={value} type="button" role="tab" id={`store-tab-${value}`} aria-selected={tab === value} aria-controls={`store-panel-${value}`}
          className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{label}</button>)}
      </div>
      <div className="store-balance-chip">
        <span className="store-label">{t("Balance")}</span>
        <strong className="store-balance">{formatUsd(state.wallet.balanceCents, language)}</strong>
        <button type="button" className="store-link" aria-expanded={funds} onClick={() => setFunds((open) => !open)}>{owner ? t("Add funds") : t("History")}</button>
      </div>
    </div>
    {funds && <WalletPanel wallet={state.wallet} owner={owner} onClose={() => setFunds(false)} onReload={onReload} />}
    <div role="tabpanel" id="store-panel-buy" aria-labelledby="store-tab-buy" className="store-panel" hidden={tab !== "buy"}>
      {owner
        ? state.catalog
          ? <ProxyShop catalog={state.catalog} orders={state.proxies.orders} balanceCents={state.wallet.balanceCents} initialQuantity={requestedQuantity} focusKey={focusKey} src={src}
            selectedProfileIds={selectedProfileIds} onReload={onReload} onProfilesChanged={onProfilesChanged} onViewOwned={() => setTab("owned")} onBuyMore={() => onEnter?.("success-buy-more")} />
          : <ShopUnavailable onReload={onReload} />
        : <section className="tools-panel store-empty-card">
          <span className="store-empty-icon"><Glyph name="lock" /></span>
          <p>{t("Only the workspace owner can add funds and buy proxies.")}</p>
        </section>}
    </div>
    <div role="tabpanel" id="store-panel-owned" aria-labelledby="store-tab-owned" className="store-panel" hidden={tab !== "owned"}>
      <OwnedProxies orders={state.proxies.orders} pendingPurchases={state.proxies.pendingPurchases} catalog={state.catalog} owner={owner} selectedProfileIds={selectedProfileIds}
        onReload={onReload} onProfilesChanged={onProfilesChanged} onBuy={owner && state.catalog ? () => { onEnter?.("my-proxies-buy-more"); setTab("buy"); } : undefined} />
    </div>
    <div role="tabpanel" id="store-panel-tools" aria-labelledby="store-tab-tools" className="store-panel store-tools" hidden={tab !== "tools"}>{tools}</div>
  </div>;
}
