import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "./i18n.tsx";
import { ProxyToolsError, proxyRequest, readProxyProgress, requestProxyPreview } from "./proxies.tsx";
import { qrMatrix, qrSvgPath } from "./qr.ts";
import type {
  CreateDepositResponse,
  CryptoPaymentMethod,
  DepositStatus,
  DepositStatusResponse,
  ProxyCatalogProduct,
  ProxyCatalogResponse,
  ProxyOrder,
  ProxyPurchaseResponse,
  PurchasedProxy,
  WalletEntry,
  WalletResponse,
} from "../contracts/cloud-v1.ts";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface StoreSnapshot {
  available: true;
  wallet: WalletResponse;
  catalog: ProxyCatalogResponse;
  orders: ProxyOrder[];
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

async function storeRequest<T>(body?: Record<string, unknown>): Promise<T> {
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
    case "deposit_amount_out_of_range": throw new StoreError("Top-ups must be between $5 and $10,000.", "other");
    case "partner_unavailable": throw new StoreError("Proxies are not available right now. You were not charged. Try again in a few minutes.", "other");
    case "partner_rejected": throw new StoreError("This order could not be filled. You were not charged. Try another country or a smaller quantity.", "other");
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
    const data = await storeRequest<{ available: boolean; wallet?: WalletResponse; catalog?: ProxyCatalogResponse; orders?: ProxyOrder[] }>();
    if (!data.available || !data.wallet || !data.catalog) return { available: false };
    return { available: true, wallet: data.wallet, catalog: data.catalog, orders: data.orders ?? [] };
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
  return { state: enabled ? state : null, reload };
}

export function quoteProxyPrice(product: ProxyCatalogProduct | undefined, quantity: number): { unitPriceCents: number; totalCents: number } | null {
  if (!product || !Number.isSafeInteger(quantity) || quantity < 1) return null;
  const tier = [...product.tiers].sort((a, b) => b.minQty - a.minQty).find((candidate) => quantity >= candidate.minQty);
  return tier ? { unitPriceCents: tier.unitPriceCents, totalCents: tier.unitPriceCents * quantity } : null;
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
  | { kind: "active"; purchase: ProxyPurchaseResponse }
  | { kind: "pending"; purchase: ProxyPurchaseResponse }
  | { kind: "review"; purchase: ProxyPurchaseResponse }
  | { kind: "failed"; purchase: ProxyPurchaseResponse }
  | { kind: "error"; error: StoreError };

export async function buyProxies(
  attempts: PurchaseAttempts,
  order: { type: string; country: string; quantity: number },
): Promise<PurchaseOutcome> {
  const idempotencyKey = attempts.keyFor(`${order.type}|${order.country}|${order.quantity}`);
  try {
    const { purchase } = await storeRequest<{ purchase: ProxyPurchaseResponse }>({ action: "purchase", ...order, idempotencyKey });
    attempts.settle();
    const kind = purchase.status === "active" ? "active" : purchase.status === "failed" ? "failed" : purchase.status === "needs_review" ? "review" : "pending";
    return { kind, purchase };
  } catch (error) {
    const failure = error instanceof StoreError ? error : new StoreError("The request failed. Try again.", "other");
    if (failure.kind !== "network") attempts.settle();
    return { kind: "error", error: failure };
  }
}

export async function createDeposit(amountCents: number, method: "card" | "crypto"): Promise<CreateDepositResponse> {
  return (await storeRequest<{ deposit: CreateDepositResponse }>({ action: "deposit", amountCents, method })).deposit;
}

export async function depositStatus(depositId: string): Promise<DepositStatusResponse> {
  return (await storeRequest<{ deposit: DepositStatusResponse }>({ action: "deposit-status", depositId })).deposit;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** Polls a deposit until it is paid, expired or failed. Short network faults do not stop it. */
export async function watchDeposit(
  depositId: string,
  onUpdate: (deposit: DepositStatusResponse) => void,
  signal: AbortSignal,
  intervalMs = 4000,
): Promise<DepositStatusResponse | null> {
  while (!signal.aborted) {
    await sleep(intervalMs, signal);
    if (signal.aborted) break;
    try {
      const deposit = await depositStatus(depositId);
      if (signal.aborted) break;
      onUpdate(deposit);
      if (deposit.status !== "pending") return deposit;
    } catch {}
  }
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
  proxies: PurchasedProxy[], profileIds: string[], t: Translate, signal?: AbortSignal,
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

export function proxyLine(proxy: PurchasedProxy): string {
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

function countdown(expiresAt: string | undefined, now: number): string | null {
  const end = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(end)) return null;
  const seconds = Math.max(0, Math.floor((end - now) / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60), rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
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

export interface ActiveDeposit {
  depositId: string;
  amountCents: number;
  method: "card" | "crypto";
  status: DepositStatus;
  expiresAt?: string;
  checkoutUrl?: string;
  methods?: CryptoPaymentMethod[];
  /** Reopened from the pending list, for example after an app restart. */
  resumed?: boolean;
}

function DepositStatusLine({ deposit }: { deposit: ActiveDeposit }) {
  const { t, language } = useTranslation();
  if (deposit.status === "paid") return <div className="tools-notice store-paid" role="status">{t("Payment received. {amount} was added to your balance.", { amount: formatUsd(deposit.amountCents, language) })}</div>;
  if (deposit.status === "expired") return <div className="tools-alert" role="alert">{t("This payment request expired. Start a new top-up if you still want to add funds.")}</div>;
  if (deposit.status === "failed") return <div className="tools-alert" role="alert">{t("The payment failed. You were not charged. Try again or choose another method.")}</div>;
  return <p className="store-waiting" role="status"><span className="store-dot" aria-hidden="true" />{t("Waiting for your payment… This page updates by itself.")}</p>;
}

export function CardPaymentView({ deposit }: { deposit: ActiveDeposit }) {
  const { t, language } = useTranslation();
  return <div className="store-payment">
    <h4>{t("Pay {amount} by card", { amount: formatUsd(deposit.amountCents, language) })}</h4>
    {deposit.status === "pending" && (isStripeCheckoutUrl(deposit.checkoutUrl)
      ? <>
        <p className="tools-hint">{t("Checkout opens in your browser on Stripe's secure page. Come back here when you are done.")}</p>
        <a className="btn primary" href={deposit.checkoutUrl} target="_blank" rel="noreferrer">{deposit.resumed ? t("Reopen checkout ↗") : t("Open secure checkout ↗")}</a>
      </>
      : <p className="tools-hint">{t("Finish the card payment in your browser. This page updates when it arrives.")}</p>)}
    <DepositStatusLine deposit={deposit} />
  </div>;
}

export function CryptoPaymentView({ deposit, now = Date.now() }: { deposit: ActiveDeposit; now?: number }) {
  const { t } = useTranslation();
  const methods = deposit.methods ?? [];
  const [methodId, setMethodId] = useState(methods[0]?.id ?? "");
  const method = methods.find((candidate) => candidate.id === methodId) ?? methods[0];
  const left = countdown(deposit.expiresAt, now);
  if (!method) return <div className="store-payment"><DepositStatusLine deposit={deposit} /></div>;
  return <div className="store-payment">
    {deposit.status === "pending" && <>
      <label className="fld"><span>{t("Coin and network")}</span>
        <select value={method.id} onChange={(event) => setMethodId(event.target.value)}>
          {methods.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
        </select>
      </label>
      <div className="store-crypto">
        <QrCode value={method.paymentUri || method.address} label={t("QR code for the payment")} />
        <div className="store-crypto-fields">
          <div className="store-field"><span>{t("Send exactly")}</span>
            <div><strong className="tools-mono store-amount">{method.amount} {method.coin}</strong><CopyButton value={method.amount} label={t("Copy amount")} /></div>
          </div>
          <div className="store-field"><span>{t("Network")}</span><div><strong>{method.network}</strong></div></div>
          <div className="store-field"><span>{t("To this address")}</span>
            <div><code className="tools-mono store-address">{method.address}</code><CopyButton value={method.address} label={t("Copy address")} /></div>
          </div>
          {left && <div className="store-field"><span>{t("Time left")}</span><div><strong className="tools-mono">{left}</strong></div></div>}
        </div>
      </div>
      <p className="tools-hint store-note">{t("Send exactly this amount in one transfer. If your exchange deducts the withdrawal fee, add it on top.")}</p>
    </>}
    <DepositStatusLine deposit={deposit} />
  </div>;
}

const ENTRY_LABELS: Record<WalletEntry["kind"], string> = {
  deposit: "Top-up", purchase: "Proxy purchase", renewal: "Proxy renewal", refund: "Refund", adjustment: "Adjustment",
};

function WalletPanel({ wallet, owner, amount, setAmount, amountRef, onReload }: {
  wallet: WalletResponse;
  owner: boolean;
  amount: string;
  setAmount: (value: string) => void;
  amountRef: React.RefObject<HTMLInputElement | null>;
  onReload: () => Promise<void>;
}) {
  const { t, language } = useTranslation();
  const [method, setMethod] = useState<"card" | "crypto">("card");
  const [deposit, setDeposit] = useState<ActiveDeposit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(deposit?.status === "pending" && deposit.method === "crypto");
  const amountCents = Math.round(Number(amount) * 100);
  const validAmount = Number.isSafeInteger(amountCents) && amountCents >= MIN_DEPOSIT_CENTS && amountCents <= MAX_DEPOSIT_CENTS;

  useEffect(() => {
    if (!deposit || deposit.status !== "pending") return;
    const controller = new AbortController();
    void watchDeposit(deposit.depositId, (next) => {
      setDeposit((current) => current && current.depositId === next.depositId ? { ...current, status: next.status, ...(next.crypto?.methods ? { methods: next.crypto.methods } : {}) } : current);
      if (next.status === "paid") void onReload();
    }, controller.signal);
    return () => controller.abort();
  }, [deposit?.depositId, deposit?.status === "pending"]);

  const start = async () => {
    if (!validAmount || busy) return;
    setBusy(true); setError(null);
    try {
      const created = await createDeposit(amountCents, method);
      setDeposit({
        depositId: created.depositId, amountCents: created.amountCents, method: created.method, status: created.status,
        expiresAt: created.expiresAt, checkoutUrl: created.card?.checkoutUrl, methods: created.crypto?.methods,
      });
      if (created.method === "card" && !isStripeCheckoutUrl(created.card?.checkoutUrl)) setError(t("The checkout link is not valid. Try again."));
    } catch (failure) {
      setError(t(failure instanceof StoreError ? failure.message : "The request failed. Try again."));
    } finally { setBusy(false); }
  };

  const resume = async (depositId: string) => {
    setError(null);
    try {
      const found = await depositStatus(depositId);
      setDeposit({ depositId: found.depositId, amountCents: found.amountCents, method: found.method, status: found.status, expiresAt: found.expiresAt, checkoutUrl: found.card?.checkoutUrl, methods: found.crypto?.methods, resumed: true });
    } catch (failure) {
      setError(t(failure instanceof StoreError ? failure.message : "The request failed. Try again."));
    }
  };

  return <section className="tools-panel store-wallet" aria-labelledby="store-wallet-title">
    <div className="tools-panel-head"><div><h3 id="store-wallet-title">{t("Wallet")}</h3><p>{t("Your workspace balance pays for proxies and renewals.")}</p></div>
      <div className="tools-count"><strong className="store-balance">{formatUsd(wallet.balanceCents, language)}</strong>{t("Balance")}</div></div>
    <div className="tools-panel-body">
      {owner ? <>
        {(!deposit || deposit.status !== "pending") && <div className="store-topup">
          <label className="fld"><span>{t("Amount (USD)")}</span>
            <input ref={amountRef} type="number" min={MIN_DEPOSIT_CENTS / 100} max={MAX_DEPOSIT_CENTS / 100} step="0.01" inputMode="decimal" aria-label={t("Top-up amount in US dollars")} value={amount} onChange={(event) => setAmount(event.target.value)} />
          </label>
          <div className="segmented" role="radiogroup" aria-label={t("Payment method")}>
            {(["card", "crypto"] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={method === value} className={method === value ? "active" : ""} onClick={() => setMethod(value)}>{value === "card" ? t("Card") : t("Crypto")}</button>)}
          </div>
          <button type="button" className="btn primary" disabled={!validAmount || busy} onClick={() => void start()}>{busy ? t("Preparing…") : t("Top up")}</button>
        </div>}
        {(!deposit || deposit.status !== "pending") && !validAmount && <p className="tools-hint">{t("Enter an amount from {min} to {max}.", { min: formatUsd(MIN_DEPOSIT_CENTS, language), max: formatUsd(MAX_DEPOSIT_CENTS, language) })}</p>}
        {deposit && (deposit.method === "card" ? <CardPaymentView deposit={deposit} /> : <CryptoPaymentView deposit={deposit} now={now} />)}
        {deposit && deposit.status !== "pending" && <button type="button" className="btn ghost" onClick={() => setDeposit(null)}>{t("Close")}</button>}
        {wallet.pendingDeposits.length > 0 && !deposit && <div className="store-pending">
          <h4>{t("Waiting for payment")}</h4>
          {wallet.pendingDeposits.map((pending) => <div className="store-row" key={pending.depositId}>
            <span>{formatUsd(pending.amountCents, language)} · {pending.method === "card" ? t("Card") : t("Crypto")}</span>
            <button type="button" className="btn xs" onClick={() => void resume(pending.depositId)}>{pending.method === "card" ? t("Reopen checkout") : t("Show payment")}</button>
          </div>)}
        </div>}
      </> : <p className="tools-hint">{t("Only the workspace owner can add funds and buy proxies.")}</p>}
      {error && <div className="tools-alert" role="alert">{error}</div>}
      <details className="store-history">
        <summary>{t("History")}</summary>
        {wallet.entries.length ? <table className="profile-table proxy-table"><tbody>
          {wallet.entries.map((entry) => <tr key={entry.id}>
            <td>{new Date(entry.createdAt).toLocaleDateString(language)}</td>
            <td>{t(ENTRY_LABELS[entry.kind] ?? "Adjustment")}{entry.description && <small>{entry.description}</small>}</td>
            <td className={`tools-mono store-entry ${entry.amountCents < 0 ? "minus" : "plus"}`}>{entry.amountCents > 0 ? "+" : ""}{formatUsd(entry.amountCents, language)}</td>
          </tr>)}
        </tbody></table> : <p className="tools-hint">{t("No transactions yet.")}</p>}
      </details>
    </div>
  </section>;
}

function ProxyAssign({ proxies, selectedProfileIds, onProfilesChanged }: {
  proxies: PurchasedProxy[];
  selectedProfileIds: string[];
  onProfilesChanged: () => Promise<void>;
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
      <CopyButton value={proxies.map(proxyLine).join("\n")} label={t("Copy all proxies")} />
      <button type="button" className="btn primary" disabled={busy || !count} onClick={() => void assign()}>
        {busy ? t("Assigning…") : t("Assign to {count} selected profiles", { count })}
      </button>
    </div>
    {!selectedProfileIds.length && <p className="tools-hint">{t("Select profiles on the profile list first. Each selected profile gets one proxy, in list order.")}</p>}
    {result && <div className="tools-notice" role="status">{result}</div>}
    {error && <div className="tools-alert" role="alert">{error}</div>}
  </div>;
}

function ProxyList({ proxies, countryLabel }: { proxies: PurchasedProxy[]; countryLabel: (code: string) => string }) {
  return <ul className="store-proxies">{proxies.map((proxy) => <li key={proxy.id} className="tools-mono">{proxyLine(proxy)}<small>{countryLabel(proxy.country)}</small></li>)}</ul>;
}

export function PurchaseResult({ outcome, orders = [], countryLabel = (code) => code, selectedProfileIds, onProfilesChanged, onTopUp }: {
  outcome: PurchaseOutcome;
  /** Latest owned orders. Their credentials win: a renewal can change them. */
  orders?: ProxyOrder[];
  countryLabel?: (code: string) => string;
  selectedProfileIds: string[];
  onProfilesChanged: () => Promise<void>;
  onTopUp: () => void;
}) {
  const { t, language } = useTranslation();
  if (outcome.kind === "error") {
    return <div className="tools-alert" role="alert">
      {t(outcome.error.message)}
      {outcome.error.kind === "insufficient" && <> <button type="button" className="btn xs" onClick={onTopUp}>{t("Top up")}</button></>}
    </div>;
  }
  const { purchase } = outcome;
  if (outcome.kind === "failed") {
    return <div className="tools-alert" role="alert">{purchase.chargedCents > 0
      ? t("We could not deliver this order. {amount} was refunded to your balance.", { amount: formatUsd(purchase.chargedCents, language) })
      : t("We could not deliver this order. You were not charged.")}</div>;
  }
  if (outcome.kind === "review") {
    return <div className="tools-notice" role="status">{t("We're checking this order. You'll see the proxies or a refund soon.")}</div>;
  }
  if (outcome.kind === "pending") {
    return <div className="tools-notice" role="status">{t("Your order is being prepared. The proxies appear under Your proxies in a few minutes.")}</div>;
  }
  const proxies = orders.find((order) => purchase.orderId && order.orderId === purchase.orderId)?.proxies ?? purchase.proxies ?? [];
  return <div className="store-result">
    <div className="tools-notice" role="status">{t("Your {count} proxies are ready.", { count: proxies.length })}</div>
    <ProxyList proxies={proxies} countryLabel={countryLabel} />
    {proxies.length > 0 && <ProxyAssign proxies={proxies} selectedProfileIds={selectedProfileIds} onProfilesChanged={onProfilesChanged} />}
  </div>;
}

export function ProxyShop({ catalog, orders = [], balanceCents, initialQuantity = 1, selectedProfileIds, onTopUp, onReload, onProfilesChanged }: {
  catalog: ProxyCatalogResponse;
  orders?: ProxyOrder[];
  balanceCents: number;
  initialQuantity?: number;
  selectedProfileIds: string[];
  onTopUp: (shortfallCents: number) => void;
  onReload: () => Promise<void>;
  onProfilesChanged: () => Promise<void>;
}) {
  const { t, language } = useTranslation();
  const [type, setType] = useState(catalog.products[0]?.type ?? "");
  const product = catalog.products.find((candidate) => candidate.type === type) ?? catalog.products[0];
  const [country, setCountry] = useState(product?.countries[0]?.code ?? "");
  const [quantity, setQuantity] = useState(Math.max(1, initialQuantity));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<PurchaseOutcome | null>(null);
  const attempts = useRef(new PurchaseAttempts());
  useEffect(() => { if (initialQuantity > 0) setQuantity(initialQuantity); }, [initialQuantity]);
  if (!product) return null;
  const countryCode = product.countries.some((candidate) => candidate.code === country) ? country : product.countries[0]?.code ?? "";
  const quote = quoteProxyPrice(product, quantity);
  const minimum = Math.min(...product.tiers.map((tier) => tier.minQty));
  const shortfall = quote ? quote.totalCents - balanceCents : 0;
  const buy = async () => {
    if (!quote || shortfall > 0 || busy) return;
    setBusy(true); setOutcome(null);
    const next = await buyProxies(attempts.current, { type: product.type, country: countryCode, quantity });
    setOutcome(next); setBusy(false);
    if (next.kind !== "error" || next.error.kind === "insufficient") await onReload();
  };
  return <section className="tools-panel store-shop" aria-labelledby="store-shop-title">
    <div className="tools-panel-head"><div><h3 id="store-shop-title">{t("Buy proxies")}</h3><p>{t("Static residential IPs that stay the same, so every account keeps its own location.")}</p></div></div>
    <div className="tools-panel-body">
      <div className="store-form">
        <label className="fld"><span>{t("Proxy type")}</span>
          <select value={product.type} disabled={busy} onChange={(event) => { setType(event.target.value); setOutcome(null); }}>
            {catalog.products.map((candidate) => <option key={candidate.type} value={candidate.type}>{candidate.label}</option>)}
          </select>
        </label>
        <label className="fld"><span>{t("Country")}</span>
          <select value={countryCode} disabled={busy} onChange={(event) => { setCountry(event.target.value); setOutcome(null); }}>
            {product.countries.map((candidate) => <option key={candidate.code} value={candidate.code}>{countryName(candidate.code, candidate.name, t, language)}</option>)}
          </select>
        </label>
        <label className="fld"><span>{t("Quantity")}</span>
          <input type="number" min={1} step={1} value={quantity} disabled={busy} aria-label={t("Number of proxies")} onChange={(event) => { setQuantity(Math.max(1, Math.floor(Number(event.target.value)) || 1)); setOutcome(null); }} />
        </label>
      </div>
      <div className="store-tiers">{[...product.tiers].sort((a, b) => a.minQty - b.minQty).map((tier) => <span key={tier.minQty} className={quote?.unitPriceCents === tier.unitPriceCents ? "active" : ""}>
        {t("{count}+: {price} each", { count: tier.minQty, price: formatUsd(tier.unitPriceCents, language) })}
      </span>)}</div>
      <div className="tools-result-bar">
        <div className="store-total">{quote
          ? <><span>{t("Total")}</span><strong>{formatUsd(quote.totalCents, language)}</strong><small>{t("{price} each", { price: formatUsd(quote.unitPriceCents, language) })}</small></>
          : <span>{t("Order at least {count} proxies.", { count: minimum })}</span>}</div>
        <button type="button" className="btn primary" disabled={!quote || shortfall > 0 || busy} onClick={() => void buy()}>{busy ? t("Buying…") : t("Buy")}</button>
      </div>
      {quote && shortfall > 0 && <div className="tools-alert store-short" role="status">
        {t("Your balance is {balance}. Add {amount} to buy this order.", { balance: formatUsd(balanceCents, language), amount: formatUsd(shortfall, language) })}
        {" "}<button type="button" className="btn xs primary" onClick={() => onTopUp(shortfall)}>{t("Top up")}</button>
      </div>}
      {outcome && <PurchaseResult outcome={outcome} orders={orders} countryLabel={(code) => countryName(code, product.countries.find((item) => item.code === code)?.name, t, language)} selectedProfileIds={selectedProfileIds} onProfilesChanged={onProfilesChanged} onTopUp={() => onTopUp(shortfall)} />}
    </div>
  </section>;
}

function OwnedProxies({ orders, catalog, owner, selectedProfileIds, onReload, onProfilesChanged }: {
  orders: ProxyOrder[];
  catalog: ProxyCatalogResponse;
  owner: boolean;
  selectedProfileIds: string[];
  onReload: () => Promise<void>;
  onProfilesChanged: () => Promise<void>;
}) {
  const { t, language } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = (type: string) => catalog.products.find((product) => product.type === type)?.label ?? t("Proxies");
  const country = (type: string, code: string) => countryName(code, catalog.products.find((product) => product.type === type)?.countries.find((item) => item.code === code)?.name, t, language);
  const toggle = async (order: ProxyOrder) => {
    setBusy(order.orderId); setError(null);
    try {
      await storeRequest({ action: "auto-renew", orderId: order.orderId, enabled: !order.autoRenew });
      await onReload();
    } catch (failure) {
      setError(t(failure instanceof StoreError ? failure.message : "The request failed. Try again."));
    } finally { setBusy(null); }
  };
  return <section className="tools-panel store-orders" aria-labelledby="store-orders-title">
    <div className="tools-panel-head"><div><h3 id="store-orders-title">{t("Your proxies")}</h3><p>{t("Proxies bought for this workspace. Renewals are paid from the wallet.")}</p></div>
      <button type="button" className="btn" onClick={() => void onReload()}>{t("Refresh")}</button></div>
    <div className="tools-panel-body">
      {error && <div className="tools-alert" role="alert">{error}</div>}
      {orders.length ? orders.map((order) => <div className="store-order" key={order.orderId}>
        <div className="store-order-head">
          <div><strong>{t("{count} × {type}", { count: order.quantity, type: label(order.type) })}</strong>
            <small>{country(order.type, order.country)} · {t("Expires {date}", { date: new Date(order.expiresAt).toLocaleDateString(language) })}</small></div>
          {owner
            ? <label className="proxy-choice"><input type="checkbox" checked={order.autoRenew} disabled={busy === order.orderId} onChange={() => void toggle(order)} />{t("Auto-renew")}</label>
            : <span className="tools-hint">{order.autoRenew ? t("Auto-renew is on") : t("Auto-renew is off")}</span>}
        </div>
        {order.renewalStatus === "renewal_failed" && <div className="tools-alert" role="alert">{t("Renewal failed. Add funds to your wallet to keep these proxies.")}</div>}
        <details><summary>{t("Show {count} proxies", { count: order.proxies.length })}</summary>
          <ProxyList proxies={order.proxies} countryLabel={(code) => country(order.type, code)} />
          {owner && order.proxies.length > 0 && <ProxyAssign proxies={order.proxies} selectedProfileIds={selectedProfileIds} onProfilesChanged={onProfilesChanged} />}
        </details>
      </div>) : <p className="tools-hint">{t("No proxies yet. Proxies you buy appear here.")}</p>}
    </div>
  </section>;
}

export function StorePage({ active, state, role, selectedProfileIds, requestedQuantity = 0, onReload, onProfilesChanged }: {
  active: boolean;
  state: StoreSnapshot;
  role?: string;
  selectedProfileIds: string[];
  requestedQuantity?: number;
  onReload: () => Promise<void>;
  onProfilesChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const owner = role === "owner";
  const [amount, setAmount] = useState("20");
  const amountRef = useRef<HTMLInputElement | null>(null);
  const topUp = (shortfallCents: number) => {
    setAmount(String(Math.min(MAX_DEPOSIT_CENTS, Math.max(MIN_DEPOSIT_CENTS, Math.ceil(shortfallCents / 100) * 100)) / 100));
    amountRef.current?.scrollIntoView?.({ block: "center" });
    amountRef.current?.focus();
  };
  return <div className="workspace proxy-page store-page" hidden={!active}>
    <div className="tools-intro"><div><span className="tools-eyebrow">{t("WALLET & PROXIES")}</span><h2>{t("Give every account its own IP.")}</h2>
      <p>{t("Add funds once, then buy static residential proxies and assign them to your profiles in a few clicks.")}</p></div></div>
    <WalletPanel wallet={state.wallet} owner={owner} amount={amount} setAmount={setAmount} amountRef={amountRef} onReload={onReload} />
    {owner && <ProxyShop catalog={state.catalog} orders={state.orders} balanceCents={state.wallet.balanceCents} initialQuantity={requestedQuantity} selectedProfileIds={selectedProfileIds} onTopUp={topUp} onReload={onReload} onProfilesChanged={onProfilesChanged} />}
    <OwnedProxies orders={state.orders} catalog={state.catalog} owner={owner} selectedProfileIds={selectedProfileIds} onReload={onReload} onProfilesChanged={onProfilesChanged} />
  </div>;
}
