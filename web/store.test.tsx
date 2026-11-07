import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { I18nProvider } from "./i18n.tsx";
import { PROXY_SRC, ProxyProviderOffer, ProxyStoreContext } from "./proxy-offer.tsx";
import { storeEvents } from "./store-events.ts";
import { ProxiesPage } from "./proxies.tsx";
import {
  CardPaymentView,
  CryptoPaymentView,
  NobleProxyButton,
  ProxyShop,
  PurchaseAttempts,
  QUANTITY_STEPS,
  WalletPanel,
  buyAfterDeposit,
  catalogSavingPercent,
  loadPendingOrder,
  payPlan,
  resumePendingOrder,
  savePendingOrder,
  clampQuantity,
  quantityStep,
  shopProducts,
  PurchaseResult,
  StorePage,
  assignProxiesToProfiles,
  buyProxies,
  createDeposit,
  depositStatus,
  isNobleProxyHandoffUrl,
  isStripeCheckoutUrl,
  loadStoreState,
  mayStillBeCredited,
  openNobleProxy,
  quoteProxyPrice,
  watchDeposit,
  type ActiveDeposit,
  type PendingOrder,
  type StoreSnapshot,
} from "./store.tsx";
import { qrMatrix } from "./qr.ts";
import { handleUiRequest } from "../ui.ts";
import { CloudClient } from "../cloud-client.ts";
import type { CloudConnectionRuntime } from "../cloud-connection.ts";
import { buildProxyPreview, type ProxyInventoryProfile } from "../proxy-bulk.ts";
import type {
  CloudError,
  CloudProxyOrder,
  CloudPurchasedProxy,
  DepositResponse,
  GetWalletResponse,
  ListPurchasedProxiesResponse,
  NobleProxyHandoffResponse,
  ProxyCatalogResponse,
  ProxyPurchaseResponse,
  SetAutoRenewResponse,
} from "../contracts/cloud-v1.ts";
import ruRU from "./locales/ru-RU.json";
import zhCN from "./locales/zh-CN.json";

const realFetch = globalThis.fetch;
/* A memory localStorage, so the pending order survives "restarts" inside one test. */
const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key), clear: () => memory.clear(), key: () => null, length: 0,
} satisfies Storage });
afterEach(() => { globalThis.fetch = realFetch; memory.clear(); });

const render = (element: ReactElement) => renderToStaticMarkup(<I18nProvider>{element}</I18nProvider>);
const t = (key: string) => key;
const noop = async () => {};

/* Bodies exactly as AliasMode Cloud answers them: the examples in aliasmode-cloud docs/credits-wallet.md,
   with every field that src/services/wallet.ts and proxy-store.ts write. `satisfies` checks them against
   the Cloud contract copied into contracts/cloud-v1.ts. Times are epoch milliseconds. */
const CREATED_AT = 1762400000000;
const LIVE_STRIPE_URL = "https://checkout.stripe.com/g/pay/cs_live_a1jR9tbRvftQTDnmkkEdu4o1ARCgIj9J3DTTo8l00zJaV7fDtKOBAig94s#fidkIqPtHjp%2FJquzcfcZx1PosH%2Bk1gj53e5bB%2FYEU9Qeax5zomqD%2BbPa6YlsAE%2BmL8aLtkhyX%3DK4spAcpw7fMm%2Bbs9vYnQYSD%2FwifHdJs%2BCcwEWQ5Ke%2Bl41LGRZa0Bt1%3DgVgfpLfu%2FzO89tc6XiCHUD%3DS5R5GSWN12T3%2B3Aqr9O%2FIhWPKNwrb%3DiJ2AdzHwM%2FZMNWNVJgF%3Da3J29nmKI%2BWnnH9Xl4iUX5%2BS5tRschFC3YGY%2F6XLgHVx7O5pQeG%2FCB%3D%3D";
const HANDOFF_URL = "https://nobleproxy.com/continue/aliasmode?h=Abc123_-Abc123_-Abc123_-";

const cloudWallet = {
  ok: true, balanceCents: 1250, currency: "USD",
  entries: [
    { id: "0b8f1f6e-2a40-4d43-9c55-2f4c2d0a1b01", amountCents: -600, kind: "purchase", createdAt: CREATED_AT, description: "2 isp proxies (US)" },
    { id: "0b8f1f6e-2a40-4d43-9c55-2f4c2d0a1b02", amountCents: 1850, kind: "deposit", createdAt: CREATED_AT - 3_600_000 },
  ],
  pendingDeposits: [{ depositId: "5d1c7f3a-8f0e-4a5b-9a51-3c2b1a0d9e01", amountCents: 2000, method: "card", status: "pending", expiresAt: 1762403600000 }],
} satisfies GetWalletResponse;

const cloudCatalog = {
  ok: true,
  products: [{ type: "isp", label: "ISP", countries: [{ code: "US", name: "United States" }], tiers: [{ minQty: 1, unitPriceCents: 300 }, { minQty: 10, unitPriceCents: 250 }] }],
} satisfies ProxyCatalogResponse;

const cloudProxy = (index: number, password = "p"): CloudPurchasedProxy =>
  ({ id: `p${index}`, host: `1.2.3.${index}`, port: 8000, username: "u", password, protocol: "http", country: "US" });

const cloudOrder = {
  id: "ord_1", type: "isp", country: "US", quantity: 2, expiresAt: 1765000000000,
  autoRenew: true, renewalStatus: "ok", renewalFailure: null,
  proxies: [cloudProxy(4), cloudProxy(5)],
} satisfies CloudProxyOrder;

const cloudProxies = { ok: true, orders: [cloudOrder], pendingPurchases: [] } satisfies ListPurchasedProxiesResponse;

const cardDeposit = {
  ok: true,
  deposit: {
    id: "5d1c7f3a-8f0e-4a5b-9a51-3c2b1a0d9e01", amountCents: 2000, method: "card", status: "pending",
    createdAt: CREATED_AT, expiresAt: 1762403600000, paidAt: null, card: { checkoutUrl: LIVE_STRIPE_URL },
  },
} satisfies DepositResponse;

const cryptoDeposit = {
  ok: true,
  deposit: {
    id: "5d1c7f3a-8f0e-4a5b-9a51-3c2b1a0d9e02", amountCents: 2000, method: "crypto", status: "pending",
    createdAt: CREATED_AT, expiresAt: 1762403600000, paidAt: null,
    crypto: { methods: [{ id: "usdt_trc20", coin: "USDT", network: "TRC20", label: "USDT (TRC20)", amount: "20.00", address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", paymentUri: "tron:TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf?amount=20.00" }] },
  },
} satisfies DepositResponse;

const purchase = (status: ProxyPurchaseResponse["purchase"]["status"]) => ({
  ok: true,
  purchase: {
    id: "9e2d4c1b-7a6f-4e3d-8c2b-1a0f9e8d7c01", idempotencyKey: "client-uuid", type: "isp", country: "US", quantity: 2, totalCents: 600,
    status, orderId: status === "active" ? "ord_1" : null, failure: status === "failed" ? "out_of_stock" : null, createdAt: CREATED_AT,
  },
  order: status === "active" ? cloudOrder : null,
}) satisfies ProxyPurchaseResponse;

const cloudError = (status: number, code: string, message = "SERVER ENGLISH TEXT") =>
  Response.json({ ok: false, error: { code, message } } as CloudError, { status });
/** Cloud's answer for a route it does not have (app.notFound). */
const noRoute = () => cloudError(404, "profile_not_found", "The route does not exist.");

function snapshot(balanceCents = cloudWallet.balanceCents, proxies: ListPurchasedProxiesResponse = cloudProxies): StoreSnapshot {
  return { available: true, wallet: { ...cloudWallet, balanceCents }, proxies, catalog: cloudCatalog };
}

/** A fake AliasMode Cloud behind the real CloudClient and the real /ui/api/cloud-store route. */
function fakeCloud(routes: (method: string, path: string, body: any) => Response | Promise<Response>) {
  const requests: Array<{ method: string; path: string; body: any }> = [];
  const client = new CloudClient({
    baseUrl: "https://cloud.example.com",
    accessToken: () => "token",
    fetchFn: async (url, init) => {
      const path = new URL(url).pathname.replace(/^\/v1/, "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method ?? "GET", path, body });
      return routes(init?.method ?? "GET", path, body);
    },
  });
  const options = { cloudConnection: { client } as unknown as CloudConnectionRuntime };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const response = await handleUiRequest(new Request(`http://127.0.0.1${url}`, init), {} as any, {} as any, null, options);
    return response ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  return requests;
}

/** The live Cloud's store routes, with one route answered differently. */
function liveCloud(override: (method: string, path: string, body: any) => Response | undefined = () => undefined) {
  return fakeCloud((method, path, body) => {
    const answer = override(method, path, body);
    if (answer) return answer;
    if (method === "GET" && path === "/wallet") return Response.json(cloudWallet);
    if (method === "GET" && path === "/proxies") return Response.json(cloudProxies);
    if (method === "GET" && path === "/proxies/catalog") return Response.json(cloudCatalog);
    return noRoute();
  });
}

test("an older Cloud without the wallet answers 404, so the store stays hidden and offers stay NobleProxy links", async () => {
  fakeCloud(() => new Response("404 Not Found", { status: 404, headers: { "content-type": "text/plain" } }));
  expect(await loadStoreState()).toEqual({ available: false });
  fakeCloud(noRoute);
  expect(await loadStoreState()).toEqual({ available: false });

  globalThis.fetch = (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
  expect(await loadStoreState()).toEqual({ available: false });

  const link = render(<ProxyProviderOffer placement="proxies-check" />);
  expect(link).toContain('href="https://nobleproxy.com/t/aliasmode?src=proxies-check"');
  const opened: number[] = [];
  const inApp = render(<ProxyStoreContext.Provider value={(quantity) => opened.push(quantity)}><ProxyProviderOffer placement="proxies-no-proxy" missing={3} /></ProxyStoreContext.Provider>);
  expect(inApp).not.toContain("nobleproxy.com");
  expect(inApp).toContain("<button");
  expect(inApp).toContain("3 profiles have no proxy");
});

test("the live Cloud bodies reach the page unchanged: balance, owned proxies and catalog", async () => {
  const requests = liveCloud();
  const state = await loadStoreState();
  expect(state).toEqual({ available: true, wallet: cloudWallet, proxies: cloudProxies, catalog: cloudCatalog });
  expect(requests.map((request) => request.path).sort()).toEqual(["/proxies", "/proxies/catalog", "/wallet"]);

  const page = render(<StorePage state={state as StoreSnapshot} role="owner" selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  expect(page).toContain("$12.50");
  expect(page).toContain("2 × ISP");
  expect(page).toContain("1.2.3.4:8000:u:p");
  expect(page).toContain("United States");
  expect(page).toContain(`Expires ${new Date(cloudOrder.expiresAt).toLocaleDateString("en-US")}`);
  // Pending top-ups and the history sit behind the balance link.
  expect(page).not.toContain("2 isp proxies (US)");
  const funds = render(<WalletPanel wallet={cloudWallet} owner onClose={() => {}} onReload={noop} />);
  expect(funds).toContain(">Reopen checkout</button>");
  expect(funds).toContain("2 isp proxies (US)");
  expect(funds).toContain("+$18.50");
});

test("a NobleProxy outage hides only the shop: the wallet and owned proxies still show", async () => {
  const requests = liveCloud((_, path) => path === "/proxies/catalog" ? cloudError(503, "partner_unavailable", "Credits and proxy purchases are not available.") : undefined);
  const state = await loadStoreState();
  expect(state).toEqual({ available: true, wallet: cloudWallet, proxies: cloudProxies, catalog: null });
  expect(requests).toHaveLength(3);

  const page = render(<StorePage state={state as StoreSnapshot} role="owner" selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  expect(page).toContain("Store temporarily unavailable.");
  expect(page).toContain(">Try again</button>");
  expect(page).toContain("$12.50");
  expect(page).toContain(">Add funds</button>");
  expect(page).toContain("1.2.3.4:8000:u:p");
  expect(page).not.toContain("store-cta");

  // A wallet that cannot be read still keeps the outside offer instead of an empty page.
  liveCloud((_, path) => path === "/wallet" ? cloudError(500, "internal_error") : undefined);
  expect(await loadStoreState()).toEqual({ available: false });
});

test("charged purchases that are still settling stay visible as Processing or Being checked by support", () => {
  const pending = purchase("pending").purchase;
  const review = { ...purchase("needs_review").purchase, id: "9e2d4c1b-7a6f-4e3d-8c2b-1a0f9e8d7c02", quantity: 5, totalCents: 1500 };
  const proxies = { ok: true, orders: [], pendingPurchases: [pending, review] } satisfies ListPurchasedProxiesResponse;
  for (const role of ["owner", "member"]) {
    const page = render(<StorePage state={snapshot(0, proxies)} role={role} selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
    expect(page).toContain("2 × ISP");
    expect(page).toContain("Processing…");
    expect(page).toContain("5 × ISP");
    expect(page).toContain("$15.00");
    expect(page).toContain("Being checked by support");
    expect(page).not.toContain("No proxies yet.");
  }
});

test("renewal states each get their own text; only a short balance asks for funds", () => {
  const page = (order: Partial<CloudProxyOrder>) =>
    render(<StorePage state={snapshot(5000, { ...cloudProxies, orders: [{ ...cloudOrder, ...order }] })} role="owner" selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  const addFunds = "Renewal failed. Top up your balance to keep these proxies.";
  expect(page({ renewalStatus: "ok" })).not.toMatch(/Renewal (failed|in progress|could not)|renewal is being checked/);
  expect(page({ renewalStatus: "pending" })).toContain("Renewal in progress…");
  expect(page({ renewalStatus: "needs_review" })).toContain("The renewal is being checked by support.");
  const refused = page({ renewalStatus: "renewal_failed", renewalFailure: "partner_failed" });
  expect(refused).toContain("Renewal could not be completed. You were not charged.");
  expect(refused).not.toContain(addFunds);
  expect(page({ renewalStatus: "renewal_failed", renewalFailure: "insufficient_balance" })).toContain(addFunds);
});

test("the live total follows catalog tiers; one button buys from the balance or pays the shortfall", () => {
  const product = cloudCatalog.products[0]!;
  expect(quoteProxyPrice(product, 1)).toEqual({ unitPriceCents: 300, totalCents: 300 });
  expect(quoteProxyPrice(product, 12)).toEqual({ unitPriceCents: 250, totalCents: 3000 });
  expect(quoteProxyPrice({ ...product, tiers: [{ minQty: 5, unitPriceCents: 100 }] }, 4)).toBeNull();

  const props = { catalog: cloudCatalog, selectedProfileIds: [], onReload: noop, onProfilesChanged: noop };
  const enough = render(<ProxyShop {...props} balanceCents={5000} initialQuantity={12} />);
  expect(enough).toMatch(/<button type="button" class="btn primary store-cta">Buy 12 proxies · \$30\.00<\/button>/);
  expect(enough).toContain("Paid from your balance.");
  expect(render(<ProxyShop {...props} balanceCents={5000} initialQuantity={1} />)).toContain(">Buy 1 proxy · $3.00</button>");

  // Short by $20: the button pays exactly that, then the order is placed by itself.
  const short = render(<ProxyShop {...props} balanceCents={1000} initialQuantity={12} />);
  expect(short).toMatch(/<button type="button" class="btn primary store-cta">Pay \$20\.00<\/button>/);
  expect(short).toContain("Your $10.00 balance is used first.");
  expect(short).not.toContain("added to your balance");
  expect(short).not.toContain("Paid from your balance.");

  // Short by $0.50: the $5 top-up minimum applies, and the extra is named.
  const minimum = render(<ProxyShop {...props} balanceCents={2950} initialQuantity={12} />);
  expect(minimum).toContain(">Pay $5.00</button>");
  expect(minimum).toContain("Includes $4.50 added to your balance.");
  const empty = render(<ProxyShop {...props} balanceCents={0} initialQuantity={1} />);
  expect(empty).toContain(">Pay $5.00</button>");
  expect(empty).toContain("Card or crypto");
  expect(empty).toContain("Includes $2.00 added to your balance.");
});

test("pay-to-buy pays the exact shortfall, at least $5 and at most $10,000", () => {
  expect(payPlan(3000, 5000)).toEqual({ kind: "balance" });
  expect(payPlan(3000, 3000)).toEqual({ kind: "balance" });
  expect(payPlan(4975, 1850)).toEqual({ kind: "pay", payCents: 3125, extraCents: 0 });
  expect(payPlan(1926, 1850)).toEqual({ kind: "pay", payCents: 500, extraCents: 424 });
  expect(payPlan(500, 0)).toEqual({ kind: "pay", payCents: 500, extraCents: 0 });
  expect(payPlan(214, 0)).toEqual({ kind: "pay", payCents: 500, extraCents: 286 });
  // A negative balance is not counted as credit.
  expect(payPlan(214, -300)).toEqual({ kind: "pay", payCents: 500, extraCents: 286 });
  expect(payPlan(1_000_000, 0)).toEqual({ kind: "pay", payCents: 1_000_000, extraCents: 0 });
  expect(payPlan(1_000_001, 0)).toEqual({ kind: "too-large" });
  expect(payPlan(1_000_001, 1)).toEqual({ kind: "pay", payCents: 1_000_000, extraCents: 0 });
});

const pendingOrder: PendingOrder = { type: "isp", country: "US", quantity: 12, totalCents: 3000, idempotencyKey: "order-key-1", depositId: cryptoDeposit.deposit.id };
const paidDeposit = (status: "pending" | "paid" = "paid") => {
  const { crypto: _crypto, ...rest } = cryptoDeposit.deposit;
  return status === "pending" ? cryptoDeposit.deposit : { ...rest, status, paidAt: CREATED_AT + 60_000 };
};

test("a paid top-up places its order once with the key made at Pay; repeated polls and a refresh never buy again", async () => {
  const statuses = ["pending", "paid", "paid", "paid"] as const;
  let polls = 0;
  const requests = liveCloud((method, path) => {
    if (path === `/wallet/deposits/${pendingOrder.depositId}`) return Response.json({ ok: true, deposit: paidDeposit(statuses[Math.min(polls++, statuses.length - 1)]) } satisfies DepositResponse);
    if (method === "POST" && path === "/proxies/purchases") return Response.json(purchase("active"));
    return undefined;
  });
  savePendingOrder(pendingOrder);
  const placed = new Set<string>();
  const outcomes: Array<Promise<unknown>> = [];
  // The watcher stops at paid; the page also reacts to the same paid answer again (a re-render or a second poll).
  const final = await watchDeposit(pendingOrder.depositId, (deposit) => {
    outcomes.push(buyAfterDeposit(pendingOrder, deposit, placed));
    outcomes.push(buyAfterDeposit(pendingOrder, deposit, placed));
  }, new AbortController().signal, 0, 0);
  expect(final?.status).toBe("paid");
  const results = await Promise.all(outcomes);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(results.find(Boolean)).toMatchObject({ kind: "active" });
  const purchases = () => requests.filter((request) => request.path === "/proxies/purchases");
  expect(purchases()).toEqual([{ method: "POST", path: "/proxies/purchases", body: { type: "isp", country: "US", quantity: 12, idempotencyKey: "order-key-1" } }]);
  // Settled: nothing is saved, so a refresh or restart finds no order to finish.
  expect(loadPendingOrder()).toBeNull();
  expect(await resumePendingOrder()).toBeNull();
  // Another poll with the same paid deposit does nothing.
  expect(await buyAfterDeposit(pendingOrder, paidDeposit(), placed)).toBeNull();
  expect(purchases()).toHaveLength(1);
  // A pending deposit never buys.
  expect(await buyAfterDeposit(pendingOrder, paidDeposit("pending"), new Set())).toBeNull();
  expect(purchases()).toHaveLength(1);
});

test("a lost purchase answer keeps the order; the retry sends the same key, so Cloud charges once", async () => {
  let lose = true;
  const requests = fakeCloud((method, path) => {
    if (method === "POST" && path === "/proxies/purchases") { if (lose) throw new TypeError("connection reset"); return Response.json(purchase("active")); }
    return noRoute();
  });
  savePendingOrder(pendingOrder);
  const placed = new Set<string>();
  expect(await buyAfterDeposit(pendingOrder, paidDeposit(), placed)).toMatchObject({ kind: "error", error: { kind: "network" } });
  expect(loadPendingOrder()).toEqual(pendingOrder);
  lose = false;
  expect(await buyAfterDeposit(pendingOrder, paidDeposit(), placed)).toMatchObject({ kind: "active" });
  expect(requests.map((request) => request.body.idempotencyKey)).toEqual(["order-key-1", "order-key-1"]);
  expect(loadPendingOrder()).toBeNull();

  // The same key also goes with the Buy click that finishes an order after a restart.
  await buyProxies(new PurchaseAttempts(() => "fresh"), pendingOrder, pendingOrder.idempotencyKey);
  expect(requests.at(-1)?.body).toEqual({ type: "isp", country: "US", quantity: 12, idempotencyKey: "order-key-1" });
});

test("after a restart a paid top-up asks to finish the order; an open one shows its payment; a dead one is dropped", async () => {
  let deposit = () => Response.json({ ok: true, deposit: paidDeposit() });
  liveCloud((_, path) => path === `/wallet/deposits/${pendingOrder.depositId}` ? deposit() : undefined);
  expect(await resumePendingOrder()).toBeNull();

  savePendingOrder(pendingOrder);
  expect(await resumePendingOrder()).toEqual({ kind: "finish", order: pendingOrder });
  expect(loadPendingOrder()).toEqual(pendingOrder);

  deposit = () => Response.json({ ok: true, deposit: paidDeposit("pending") });
  expect(await resumePendingOrder()).toEqual({ kind: "pay", order: pendingOrder, deposit: cryptoDeposit.deposit });

  // Expired more than 24 hours ago: nothing can arrive any more.
  deposit = () => Response.json({ ok: true, deposit: { ...paidDeposit(), status: "expired", paidAt: null, createdAt: Date.now() - 25 * 3_600_000 } });
  expect(await resumePendingOrder()).toBeNull();
  expect(loadPendingOrder()).toBeNull();

  // Another workspace's deposit is not found: dropped. A network fault keeps it for later.
  savePendingOrder(pendingOrder);
  deposit = () => cloudError(404, "record_not_found");
  expect(await resumePendingOrder()).toBeNull();
  expect(loadPendingOrder()).toBeNull();
  savePendingOrder(pendingOrder);
  deposit = () => { throw new TypeError("offline"); };
  expect(await resumePendingOrder()).toBeNull();
  expect(loadPendingOrder()).toEqual(pendingOrder);
});

test("a card top-up reads the live deposit body and opens its Stripe checkout", async () => {
  const requests = liveCloud((method, path) => method === "POST" && path === "/wallet/deposits" ? Response.json(cardDeposit, { status: 201 }) : undefined);
  const created = await createDeposit(2000, "card");
  expect(created).toEqual(cardDeposit.deposit);
  expect(requests.at(-1)).toEqual({ method: "POST", path: "/wallet/deposits", body: { amountCents: 2000, method: "card" } });
  const html = render(<CardPaymentView deposit={created} />);
  expect(html).toContain(`href="${LIVE_STRIPE_URL}" target="_blank" rel="noreferrer">Open secure checkout ↗</a>`);
  expect(html).toContain("Waiting for your payment");

  // After a restart the pending list reopens the same checkout from GET /v1/wallet/deposits/:id.
  liveCloud((_, path) => path === `/wallet/deposits/${cardDeposit.deposit.id}` ? Response.json(cardDeposit) : undefined);
  const reopened = await depositStatus(cardDeposit.deposit.id);
  expect(render(<CardPaymentView deposit={{ ...reopened, resumed: true }} />)).toContain(`href="${LIVE_STRIPE_URL}" target="_blank" rel="noreferrer">Reopen checkout ↗</a>`);
});

test("a crypto top-up shows the exact amount, copy buttons, a QR code, the fee note and a countdown", async () => {
  liveCloud((method, path) => method === "POST" && path === "/wallet/deposits" ? Response.json(cryptoDeposit, { status: 201 }) : undefined);
  const created = await createDeposit(2000, "crypto");
  expect(created).toEqual(cryptoDeposit.deposit);
  const html = render(<CryptoPaymentView deposit={created} now={cryptoDeposit.deposit.expiresAt - 595_000} />);
  expect(html).toContain("20.00 USDT");
  expect(html).toContain("TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf");
  expect(html).toContain("Pay $20.00 in crypto");
  expect(html).toContain("TRC20");
  expect(html).toContain('aria-label="Copy amount"');
  expect(html).toContain('aria-label="Copy address"');
  expect(html).toContain('class="store-qr"');
  expect(html).toContain("09:55");
  expect(html).toContain("Send exactly this amount in one transfer. If your exchange deducts the withdrawal fee, add it on top.");
});

test("deposit statuses after payment, and a late crypto payment, get their own text", () => {
  const settled = (deposit: ActiveDeposit) => render(<CryptoPaymentView deposit={deposit} />);
  const crypto = { ...cryptoDeposit.deposit, crypto: undefined, createdAt: Date.now() - 3_600_000 };
  const card = { ...cardDeposit.deposit, card: undefined };
  expect(settled({ ...crypto, status: "paid", paidAt: Date.now() })).toContain("Payment received. $20.00 was added to your balance.");
  expect(settled({ ...crypto, status: "expired" })).toContain("Expired — if you already sent the exact amount, it will still be credited.");
  expect(settled({ ...crypto, status: "failed" })).toContain("If you already sent the exact amount, it will still be credited.");
  expect(settled({ ...crypto, status: "expired", createdAt: Date.now() - 25 * 3_600_000 })).toContain("This payment request expired.");
  expect(render(<CardPaymentView deposit={{ ...card, status: "expired" }} />)).toContain("This payment request expired.");
  expect(render(<CardPaymentView deposit={{ ...card, status: "disputed" }} />)).toContain("This payment is disputed. Support is reviewing it");
  expect(render(<CardPaymentView deposit={{ ...card, status: "refunded" }} />)).toContain("This payment was refunded. Support is reviewing it");
  expect(mayStillBeCredited({ ...card, status: "expired", createdAt: Date.now() })).toBe(false);
});

test("a crypto deposit is polled to paid, also after it expired, while it can still be credited", async () => {
  const createdAt = Date.now() - 3_600_000;
  const statuses = ["pending", "expired", "expired", "paid"] as const;
  const requests = liveCloud((_, path) => {
    if (path !== `/wallet/deposits/${cryptoDeposit.deposit.id}`) return undefined;
    const status = statuses[Math.min(requests.length - 1, statuses.length - 1)]!;
    const { crypto: _crypto, ...rest } = cryptoDeposit.deposit;
    return Response.json({ ok: true, deposit: status === "pending" ? { ...cryptoDeposit.deposit, createdAt } : { ...rest, createdAt, status, paidAt: status === "paid" ? Date.now() : null } } satisfies DepositResponse);
  });
  const seen: string[] = [];
  const final = await watchDeposit(cryptoDeposit.deposit.id, (next) => seen.push(next.status), new AbortController().signal, 0, 0);
  expect(final?.status).toBe("paid");
  expect(seen).toEqual(["pending", "expired", "expired", "paid"]);

  // Past 24 hours an expired crypto deposit is no longer watched.
  liveCloud((_, path) => path === `/wallet/deposits/${cryptoDeposit.deposit.id}`
    ? Response.json({ ok: true, deposit: { ...cryptoDeposit.deposit, crypto: undefined, status: "expired", createdAt: Date.now() - 25 * 3_600_000 } })
    : undefined);
  expect((await watchDeposit(cryptoDeposit.deposit.id, () => {}, new AbortController().signal, 0, 0))?.status).toBe("expired");
});

test("top-ups accept $5 to $10,000, and Cloud refusals of a top-up get top-up text", async () => {
  // The balance in the corner keeps the form behind Add funds; opened, it asks for $5 to $10,000.
  const page = render(<StorePage state={snapshot(0)} role="owner" selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  expect(page).toContain('<button type="button" class="store-link" aria-expanded="false">Add funds</button>');
  expect(page).not.toContain('min="5" max="10000"');
  const form = (amount: string) => render(<WalletPanel wallet={{ ...cloudWallet, pendingDeposits: [] }} owner initialAmount={amount} onClose={() => {}} onReload={noop} />);
  const html = form("20");
  expect(html).toContain('value="20"');
  expect(html).toContain('min="5" max="10000" step="0.01"');
  expect(html).toContain('role="radio" aria-checked="true" class="active">Card</button>');
  expect(html).toMatch(/<button type="button" class="btn primary store-topup-go">Add \$20\.00<\/button>/);
  expect(html).not.toContain("Enter an amount from");
  expect(form("4")).toMatch(/<button type="button" class="btn primary store-topup-go" disabled="">Add funds<\/button>/);
  expect(form("4")).toContain("Enter an amount from $5.00 to $10,000.00.");

  const cases: Array<[number, string, string]> = [
    [400, "deposit_amount_out_of_range", "Top-ups must be between $5 and $10,000."],
    [422, "partner_rejected", "NobleProxy did not accept this top-up. Try another amount or payment method."],
    [503, "partner_unavailable", "Top-ups are not available right now. Try again in a few minutes."],
    [403, "owner_only", "Only the workspace owner can do this."],
  ];
  for (const [status, code, message] of cases) {
    const requests = fakeCloud(() => cloudError(status, code));
    const error = await createDeposit(400, "card").catch((value) => value);
    expect(error.message).toBe(message);
    expect(requests[0]).toMatchObject({ method: "POST", path: "/wallet/deposits", body: { amountCents: 400, method: "card" } });
  }
});

test("Cloud error codes on a purchase become translated messages, never the server's English text", async () => {
  const cases: Array<[number, string, string, string]> = [
    [402, "insufficient_balance", "insufficient", "Your balance is too low for this purchase."],
    [403, "owner_only", "forbidden", "Only the workspace owner can do this."],
    [400, "deposit_amount_out_of_range", "other", "Top-ups must be between $5 and $10,000."],
    [503, "partner_unavailable", "other", "Proxies are not available right now. You were not charged. Try again in a few minutes."],
    [422, "partner_rejected", "other", "This order could not be filled. You were not charged. Try another country or a smaller quantity."],
    [404, "record_not_found", "other", "This item was not found. Refresh the page and try again."],
    [400, "something_new", "other", "The request failed. Try again."],
  ];
  for (const [status, code, kind, message] of cases) {
    fakeCloud(() => cloudError(status, code));
    const outcome = await buyProxies(new PurchaseAttempts(), { type: "x-twitter-12", country: "US", quantity: 1 });
    expect(outcome).toMatchObject({ kind: "error", error: { kind, message } });
    expect([ruRU, zhCN].map((catalog) => typeof (catalog as Record<string, string>)[message])).toEqual(["string", "string"]);
  }
});

test("proxy types and countries show their names, never raw ids", () => {
  const anyCountry = { ok: true, products: [{ ...cloudCatalog.products[0]!, type: "x-twitter-12", label: "Static residential for X", countries: [{ code: "ANY", name: "" }, { code: "US", name: "United States" }] }] } satisfies ProxyCatalogResponse;
  const state: StoreSnapshot = { ...snapshot(5000), catalog: anyCountry, proxies: { ...cloudProxies, orders: [
    { ...cloudOrder, type: "x-twitter-12", country: "ANY", proxies: [{ ...cloudProxy(1), country: "DE" }] },
    { ...cloudOrder, id: "ord_2", type: "retired-type-7", country: "FR", proxies: [] },
  ] } };
  const html = render(<StorePage state={state} role="owner" selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  expect(html).toContain("Static residential for X");
  expect(html).toContain("Any country");
  expect(html).toContain("Germany");
  expect(html).toContain("France");
  expect(html).not.toContain("x-twitter-12<");
  expect(html).not.toContain("retired-type-7");
  expect(html).not.toMatch(/>(ANY|DE|FR)</);
});

test("owners can top up, buy and manage on NobleProxy; members see balance and proxies without those buttons", () => {
  const page = (role: string) => render(<StorePage state={snapshot(5000)} role={role} selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  const owner = page("owner");
  expect(owner).toContain("$50.00");
  expect(owner).toContain(">Add funds</button>");
  expect(owner).toContain(">Buy 1 proxy · $3.00</button>");
  expect(owner).toContain(">Manage on NobleProxy ↗</button>");
  expect(owner).toContain('type="checkbox" role="switch" checked=""');

  for (const role of ["member", "admin"]) {
    const member = page(role);
    expect(member).toContain("$50.00");
    expect(member).toContain(">History</button>");
    expect(member).toContain("2 × ISP");
    expect(member).toContain("1.2.3.4:8000:u:p");
    expect(member).toContain("Only the workspace owner can add funds and buy proxies.");
    expect(member).toContain("Auto-renew is on");
    expect(member).not.toContain(">Add funds</button>");
    expect(member).not.toContain("store-cta");
    expect(member).not.toContain("store-shop");
    expect(member).not.toContain("Manage on NobleProxy");
    expect(member).not.toContain('type="checkbox"');
    expect(member).not.toContain("Assign to");
  }
});

test("purchases through the live Cloud bodies show ready proxies, a refund, or a pending order", async () => {
  let answer: Response = Response.json({});
  const requests = fakeCloud((method, path) => method === "POST" && path === "/proxies/purchases" ? answer : noRoute());
  const show = (outcome: Awaited<ReturnType<typeof buyProxies>>, orders?: CloudProxyOrder[]) =>
    render(<PurchaseResult outcome={outcome} orders={orders} selectedProfileIds={["p1", "p2"]} onProfilesChanged={noop} onViewOwned={() => {}} onDone={() => {}} />);
  const order = { type: "isp", country: "US", quantity: 2 };

  answer = Response.json(purchase("active"));
  const active = await buyProxies(new PurchaseAttempts(), order);
  expect(active).toEqual({ kind: "active", result: purchase("active") });
  expect(requests.at(-1)?.body).toEqual({ ...order, idempotencyKey: expect.any(String) });
  const activeHtml = show(active);
  expect(activeHtml).toContain("Your 2 proxies are ready.");
  expect(activeHtml).toContain("1.2.3.5:8000:u:p");
  expect(activeHtml).toContain("Assign to 2 selected profiles");
  expect(activeHtml.indexOf("Assign to 2 selected profiles")).toBeLessThan(activeHtml.indexOf(">View my proxies</button>"));
  expect(activeHtml).toContain(">Buy more</button>");

  answer = Response.json(purchase("failed"));
  const failed = await buyProxies(new PurchaseAttempts(), order);
  expect(failed.kind).toBe("failed");
  expect(show(failed)).toContain("We could not deliver this order. $6.00 was refunded to your balance.");

  answer = Response.json(purchase("pending"), { status: 202 });
  const pending = await buyProxies(new PurchaseAttempts(), order);
  expect(pending.kind).toBe("pending");
  expect(show(pending)).toContain("Your order is being prepared. The proxies appear under My proxies in a few minutes.");
  expect(show(pending)).toContain(">View my proxies</button>");

  answer = Response.json(purchase("needs_review"));
  const review = await buyProxies(new PurchaseAttempts(), order);
  expect(review.kind).toBe("review");
  expect(show(review)).toContain("We&#x27;re checking this order. You&#x27;ll see the proxies or a refund soon.");

  // After a renewal the latest GET /v1/proxies credentials replace the ones in the purchase answer.
  const renewed = show(active, [{ ...cloudOrder, proxies: [cloudProxy(4, "rotated4"), cloudProxy(5, "rotated5")] }]);
  expect(renewed).toContain("1.2.3.4:8000:u:rotated4");
  expect(renewed).not.toContain(":u:p<");

  answer = cloudError(402, "insufficient_balance");
  const short = await buyProxies(new PurchaseAttempts(), order);
  expect(short).toMatchObject({ kind: "error", error: { kind: "insufficient" } });
  expect(show(short)).toContain("Your balance is too low for this purchase.");
  expect(show(short)).not.toContain("<button");

  answer = cloudError(403, "owner_only");
  expect(await buyProxies(new PurchaseAttempts(), order)).toMatchObject({ kind: "error", error: { kind: "forbidden" } });
});

test("a purchase retry after a lost answer reuses its idempotency key; a settled one gets a new key", async () => {
  let lose = true;
  const requests = fakeCloud(() => {
    if (lose) throw new TypeError("connection reset");
    return Response.json(purchase("active"));
  });
  let counter = 0;
  const attempts = new PurchaseAttempts(() => `key-${++counter}`);
  const order = { type: "isp", country: "US", quantity: 1 };
  expect(await buyProxies(attempts, order)).toMatchObject({ kind: "error", error: { kind: "network" } });
  lose = false;
  expect((await buyProxies(attempts, order)).kind).toBe("active");
  await buyProxies(attempts, order);
  await buyProxies(attempts, { ...order, quantity: 2 });
  expect(requests.map((request) => request.body.idempotencyKey)).toEqual(["key-1", "key-1", "key-2", "key-3"]);
});

test("the QR code has the standard size and finder patterns for payment URIs", () => {
  for (const [text, size] of [["A", 21], ["bitcoin:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh?amount=0.00123456", 37]] as const) {
    const matrix = qrMatrix(text);
    expect(matrix).toHaveLength(size);
    for (const [x, y] of [[0, 0], [size - 7, 0], [0, size - 7]] as const) {
      expect(matrix[y]!.slice(x, x + 7)).toEqual([true, true, true, true, true, true, true]);
      expect(matrix[y + 1]!.slice(x, x + 7)).toEqual([true, false, false, false, false, false, true]);
      expect(matrix[y + 3]!.slice(x, x + 7)).toEqual([true, false, true, true, true, false, true]);
    }
  }
  expect(() => qrMatrix("x".repeat(3000))).toThrow();
});

test("card checkout opens only Stripe Checkout, also a live-length URL, and the desktop shell allows exactly that", async () => {
  const shell = await Bun.file(new URL("../src-tauri/src/lib.rs", import.meta.url)).text();
  expect(shell).toContain('url.strip_prefix("https://checkout.stripe.com/")');
  expect(shell).toContain('b"/_-.#%=+~"');
  expect(shell).toContain("|| stripe_checkout_url(url)");
  expect(LIVE_STRIPE_URL.length).toBeGreaterThan(400);
  expect(LIVE_STRIPE_URL).toMatch(/^[A-Za-z0-9#%./:_]+$/);
  const accepted = ["https://checkout.stripe.com/c/pay/cs_test_a1B2c3D4e5#fidkdWxOYHwnPyd1blpxYHZxWjA0SmZ%2FPWBWfQ%3D%3D", LIVE_STRIPE_URL];
  const rejected = [
    "https://checkout.stripe.com/", "http://checkout.stripe.com/c/pay/cs_test_a1", "https://checkout.stripe.com.example.com/c/pay/cs_test_a1",
    "https://checkout.stripe.com@example.com/c/pay/cs_test_a1", "https://checkout.stripe.com/c/pay/cs_test_a1?redirect=https://example.com",
    "https://checkout.stripe.com/c/pay/cs test", "https://checkout.stripe.com/c/pay/cs_test\\@example.com", "https://dashboard.stripe.com/c/pay/cs_test_a1",
    "https://nobleproxy.com/t/aliasmode", "javascript:alert(1)", `${LIVE_STRIPE_URL}?next=https://example.com`,
  ];
  // The same lists are in the Rust test allows_only_explicit_external_pages.
  for (const url of accepted) { expect(isStripeCheckoutUrl(url)).toBe(true); expect(shell).toContain(`"${url}"`); }
  for (const url of rejected) expect(isStripeCheckoutUrl(url)).toBe(false);

  const deposit: ActiveDeposit = cardDeposit.deposit;
  const other = render(<CardPaymentView deposit={{ ...deposit, card: { checkoutUrl: "https://example.com/pay" } }} />);
  expect(other).not.toContain("example.com");
  expect(other).not.toContain("<a ");
});

test("the NobleProxy sign-in link is allowed only in its exact form, by the page and by the desktop shell", async () => {
  const shell = await Bun.file(new URL("../src-tauri/src/lib.rs", import.meta.url)).text();
  expect(shell).toContain('url.strip_prefix("https://nobleproxy.com/continue/aliasmode?h=")');
  expect(shell).toContain("|| nobleproxy_handoff_url(url)");
  const token = "Ab3_x-Yz09Ab3_x-Yz09";
  const accepted = [`https://nobleproxy.com/continue/aliasmode?h=${token}`, "https://nobleproxy.com/continue/aliasmode?h=hJ8kQ2mN5pR7sT9vW1xY3zA6bC8dE0fG"];
  const rejected = [
    "https://nobleproxy.com/continue/aliasmode?h=", `https://nobleproxy.com/continue/aliasmode?h=${token.slice(0, -1)}`,
    `https://nobleproxy.com/continue/aliasmode?h=${token}&next=https://example.com`, `https://nobleproxy.com/continue/aliasmode?h=${token}#fragment`,
    `https://nobleproxy.com/continue/aliasmode?next=x&h=${token}`, `https://nobleproxy.com/continue/aliasmode?h=${token}%2F`,
    "https://nobleproxy.com/continue/aliasmode?h=Ab3_x-Yz09.Ab3_x-Yz09", `https://nobleproxy.com/continue/aliasmode/?h=${token}`,
    `https://nobleproxy.com/continue/other?h=${token}`, `http://nobleproxy.com/continue/aliasmode?h=${token}`,
    `https://nobleproxy.com.example.com/continue/aliasmode?h=${token}`, `https://nobleproxy.com@example.com/continue/aliasmode?h=${token}`,
    `https://app.nobleproxy.com/continue/aliasmode?h=${token}`,
  ];
  // The same lists are in the Rust test allows_only_explicit_external_pages.
  for (const url of accepted) { expect(isNobleProxyHandoffUrl(url)).toBe(true); expect(shell).toContain(`"${url}"`); }
  for (const url of rejected) { expect(isNobleProxyHandoffUrl(url)).toBe(false); expect(shell).toContain(`"${url}"`); }
  expect(isNobleProxyHandoffUrl(HANDOFF_URL)).toBe(true);
});

test("Manage on NobleProxy asks Cloud for the sign-in link and opens it; an older Cloud hides the button", async () => {
  const handoff = { ok: true, url: HANDOFF_URL, expiresAt: Date.now() + 600_000 } satisfies NobleProxyHandoffResponse;
  const requests = liveCloud((method, path) => method === "POST" && path === "/nobleproxy/handoff" ? Response.json(handoff) : undefined);
  const opened: string[] = [];
  const success = await openNobleProxy((url) => opened.push(url));
  expect(opened).toEqual([HANDOFF_URL]);
  expect(success).toEqual({ kind: "opened", url: HANDOFF_URL, expiresAt: handoff.expiresAt });
  expect(requests).toEqual([{ method: "POST", path: "/nobleproxy/handoff", body: undefined }]);
  const after = render(<NobleProxyButton outcome={success} busy={false} onClick={() => {}} />);
  expect(after).toContain(`href="${HANDOFF_URL}" target="_blank" rel="noreferrer"`);

  // The live Cloud today has no such route: 404 and the button goes away.
  fakeCloud(noRoute);
  const missing = await openNobleProxy((url) => opened.push(url));
  expect(missing).toEqual({ kind: "missing" });
  expect(render(<NobleProxyButton outcome={missing} busy={false} onClick={() => {}} />)).toBe("");
  expect(render(<NobleProxyButton outcome={null} busy={false} onClick={() => {}} />)).toContain(">Manage on NobleProxy ↗</button>");

  const failures: Array<[number, string, string]> = [
    [403, "email_not_verified", "Verify your email in AliasMode first."],
    [409, "email_not_verified", "Verify your email in AliasMode first."],
    [403, "owner_only", "Only the workspace owner can do this."],
    [503, "partner_unavailable", "NobleProxy is not available right now. Try again in a few minutes."],
    [502, "partner_unavailable", "NobleProxy is not available right now. Try again in a few minutes."],
    [422, "partner_rejected", "NobleProxy could not open your account. Try again later or contact support."],
  ];
  for (const [status, code, message] of failures) {
    fakeCloud(() => cloudError(status, code));
    const outcome = await openNobleProxy((url) => opened.push(url));
    expect(outcome).toMatchObject({ kind: "error", error: { message } });
    expect(render(<NobleProxyButton outcome={outcome} busy={false} onClick={() => {}} />)).toContain(message);
  }

  // A link that is not the exact NobleProxy form is never opened, even from Cloud.
  fakeCloud(() => Response.json({ ...handoff, url: `${HANDOFF_URL}&next=https://example.com` }));
  expect((await openNobleProxy((url) => opened.push(url))).kind).toBe("error");
  expect(opened).toEqual([HANDOFF_URL]);
});

test("assigning bought proxies uses the bulk preview-and-apply path, one proxy per selected profile in order", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url, body });
    if (url === "/ui/api/proxies/preview") {
      return Response.json({ ok: true, previewId: "pv1", unusedProxies: 0, rows: [
        { index: 0, profileId: "p3", previousProxy: null, proxy: "x", status: "ready" },
        { index: 1, profileId: "p1", previousProxy: null, proxy: "y", status: "skipped", code: "profile_open" },
      ] });
    }
    const lines = [{ type: "replacement", row: { index: 0, profileId: "p3", previousProxy: null, proxy: "x", status: "updated" } }, { type: "done" }];
    return new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
  }) as typeof fetch;
  const proxies = [cloudProxy(1, 'pa,ss"1'), cloudProxy(2, "pass2")];
  const result = await assignProxiesToProfiles(proxies, ["p3", "p1", "p2"], t);
  expect(result).toEqual({ updated: 1, unchanged: 0, skipped: 1 });
  expect(calls.map((call) => call.url)).toEqual(["/ui/api/proxies/preview", "/ui/api/proxies/apply"]);
  expect(calls[0]!.body).toMatchObject({ scope: { all: true, ids: ["p3", "p1"] }, mode: "profileId" });
  expect(calls[1]!.body).toEqual({ previewId: "pv1" });

  // The same input, read by the real bulk preview, pairs proxy 1 with p3 and proxy 2 with p1.
  const profiles: ProxyInventoryProfile[] = ["p1", "p2", "p3"].map((id) => ({ id, name: id, group: "", proxy: null, permission: "edit", running: false }));
  const preview = buildProxyPreview(profiles, calls[0]!.body);
  expect(preview.rows.map((row) => [row.view.profileId, row.next?.host, row.next?.pass, row.view.status])).toEqual([
    ["p3", "1.2.3.1", 'pa,ss"1', "ready"], ["p1", "1.2.3.2", "pass2", "ready"],
  ]);
});

test("auto-renew changes go to the order id, and store changes need a same-origin JSON request", async () => {
  const answer = { ok: true, orderId: "ord 1", autoRenew: false } satisfies SetAutoRenewResponse;
  const requests = fakeCloud((_, path) => path === "/proxies/orders/ord%201/auto-renew" ? Response.json(answer) : noRoute());
  const post = (body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
    fetch("/ui/api/cloud-store", { method: "POST", headers, body: JSON.stringify(body) });
  const changed = await post({ action: "auto-renew", orderId: "ord 1", enabled: false });
  expect(changed.status).toBe(200);
  expect(await changed.json()).toEqual(answer);
  expect(requests).toEqual([{ method: "POST", path: "/proxies/orders/ord%201/auto-renew", body: { enabled: false } }]);
  expect((await post({ action: "auto-renew", orderId: "ord_1", enabled: "no" })).status).toBe(400);
  expect((await post({ action: "purchase", type: "x", country: "US", quantity: 0, idempotencyKey: "k" })).status).toBe(400);
  expect((await post({ action: "auto-renew", orderId: "ord_1", enabled: true }, { "Content-Type": "text/plain" })).status).toBe(415);
  expect((await post({ action: "auto-renew", orderId: "ord_1", enabled: true }, { "Content-Type": "application/json", Origin: "https://evil.example" })).status).toBe(403);
  expect((await post({ action: "nobleproxy-handoff" }, { "Content-Type": "application/json", Origin: "https://evil.example" })).status).toBe(403);
  expect(requests).toHaveLength(1);
});

test("every wallet and store string has Russian and Chinese text", async () => {
  const source = await Bun.file(new URL("./store.tsx", import.meta.url)).text();
  const keys = new Set([
    ...[...source.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]!),
    ...[...source.matchAll(/StoreError\("([^"]+)"/g)].map((match) => match[1]!),
    ...[...source.slice(source.indexOf("const ENTRY_LABELS"), source.indexOf("};", source.indexOf("const ENTRY_LABELS"))).matchAll(/: "([^"]+)"/g)].map((match) => match[1]!),
    "Proxy tools", "Buy proxies", "Buy static residential proxies in the app and give each profile its own IP.",
  ]);
  expect(keys.size).toBeGreaterThan(60);
  for (const catalog of [ruRU, zhCN] as Array<Record<string, string>>) {
    expect([...keys].filter((key) => !catalog[key])).toEqual([]);
  }
});

/* The catalog NobleProxy sends now: most-used purposes first, and tiers with the public price next to the AliasMode price. */
const orderedCatalog = {
  ok: true,
  products: ["Google", "Instagram", "Xreacher outreach", "Facebook", "X (Twitter)"].map((label, index) => ({
    type: `type-${index}`, label, countries: [{ code: "US", name: "United States" }],
    tiers: [{ minQty: 1, unitPriceCents: 300, publicUnitPriceCents: 500 }, { minQty: 10, unitPriceCents: 250, publicUnitPriceCents: 417 }],
  })),
} satisfies ProxyCatalogResponse;
const shopProps = { selectedProfileIds: [], onReload: noop, onProfilesChanged: noop };

test("quantity runs from 1 to 1,000 with a stepped slider, and the total follows the tier price", () => {
  expect(QUANTITY_STEPS[0]).toBe(1);
  expect(QUANTITY_STEPS.at(-1)).toBe(1000);
  expect([...QUANTITY_STEPS].sort((a, b) => a - b)).toEqual(QUANTITY_STEPS);
  expect([0, 1, 7.9, 999, 1000, 5000, Number.NaN].map(clampQuantity)).toEqual([1, 1, 7, 999, 1000, 1000, 1]);
  expect(QUANTITY_STEPS[quantityStep(1)]).toBe(1);
  expect(QUANTITY_STEPS[quantityStep(13)]).toBe(12);
  expect(QUANTITY_STEPS[quantityStep(1000)]).toBe(1000);

  const html = render(<ProxyShop {...shopProps} catalog={cloudCatalog} balanceCents={5000} initialQuantity={12} />);
  expect(html).toContain('type="range"');
  expect(html).toContain(`min="0" max="${QUANTITY_STEPS.length - 1}"`);
  expect(html).toContain(`value="${quantityStep(12)}"`);
  expect(html).toContain('aria-valuetext="12"');
  expect(html).toContain('aria-label="Fewer proxies"');
  expect(html).toContain('aria-label="More proxies"');
  expect(html).toContain('type="number" min="1" max="1000" step="1" aria-label="Number of proxies" value="12"');
  expect(html).toContain("$2.50 per proxy");
  expect(html).toContain("$30.00");
  // No tier chips any more, and the select is named Purpose.
  expect(html).not.toContain("store-tiers");
  expect(html).not.toContain("+: ");
  expect(html).toContain(">Purpose</span>");
  expect(html).not.toContain("Proxy type");
  // An offer for 4,000 profiles still stays within the slider.
  expect(render(<ProxyShop {...shopProps} catalog={cloudCatalog} balanceCents={0} initialQuantity={4000} />)).toContain('value="1000"');
});

test("the saving and the deal percent come from the public price; without it no number is shown", () => {
  const product = orderedCatalog.products[0]!;
  expect(quoteProxyPrice(product, 12)).toEqual({ unitPriceCents: 250, totalCents: 3000, publicTotalCents: 5004, savingPercent: 40 });
  expect(catalogSavingPercent(product)).toBe(40);
  expect(catalogSavingPercent(cloudCatalog.products[0])).toBeNull();
  expect(catalogSavingPercent({ ...product, tiers: [{ minQty: 1, unitPriceCents: 300, publicUnitPriceCents: 300 }] })).toBeNull();

  const withPublic = render(<ProxyShop {...shopProps} catalog={orderedCatalog} balanceCents={5000} initialQuantity={12} />);
  expect(withPublic).toContain("Give every account its own IP");
  expect(withPublic).toContain("40% off via NobleProxy");
  expect(withPublic).toContain("<s>$50.04</s>");
  expect(withPublic).toContain("Save $20.04");
  expect(withPublic).toContain("Powered by NobleProxy");

  const without = render(<ProxyShop {...shopProps} catalog={cloudCatalog} balanceCents={5000} initialQuantity={12} />);
  expect(without).toContain("Static residential IPs");
  expect(without).toContain("Powered by NobleProxy");
  expect(without).not.toMatch(/\d+% off/);
  expect(without).not.toContain("Save $");
  expect(without).not.toContain("<s>");
});

test("purposes keep the server order and never show an Xreacher purpose", () => {
  expect(shopProducts(orderedCatalog).map((product) => product.label)).toEqual(["Google", "Instagram", "Facebook", "X (Twitter)"]);
  expect(shopProducts({ ok: true, products: [{ ...orderedCatalog.products[0]!, label: "XREACHER" }] })).toEqual([]);
  const html = render(<ProxyShop {...shopProps} catalog={orderedCatalog} balanceCents={5000} />);
  expect([...html.matchAll(/<option value="type-\d"(?: selected="")?>([^<]+)<\/option>/g)].map((match) => match[1])).toEqual(["Google", "Instagram", "Facebook", "X (Twitter)"]);
  expect(html.toLowerCase()).not.toContain("xreacher");
  // A catalog with only an Xreacher purpose shows the unavailable card instead of an empty form.
  const only = { ok: true, products: [orderedCatalog.products[2]!] } satisfies ProxyCatalogResponse;
  expect(render(<ProxyShop {...shopProps} catalog={only} balanceCents={5000} />)).toContain("Store temporarily unavailable.");
});

test("one Proxies page with tabs: Buy proxies (owners start here), My proxies (N) and Tools; the balance sits in the corner", async () => {
  liveCloud();
  const state = await loadStoreState() as StoreSnapshot;
  const page = (role: string) => render(<ProxiesPage active groups={["", "Team"]} onChanged={noop}
    store={(tools) => <StorePage state={state} role={role} tools={tools} selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />} />);
  const tabsOf = (html: string) => [...html.matchAll(/role="tab"[^>]*aria-selected="(true|false)"[^>]*>([^<]+)</g)].map((match) => [match[2], match[1]]);
  const owner = page("owner");
  expect(tabsOf(owner)).toEqual([["Buy proxies", "true"], ["My proxies (2)", "false"], ["Tools", "false"]]);
  expect(owner).toContain('class="store-balance">$12.50</strong>');
  expect(owner).toContain(">Add funds</button>");
  expect(owner).toContain('id="store-panel-buy" aria-labelledby="store-tab-buy" class="store-panel">');
  expect(owner).toContain('id="store-panel-owned" aria-labelledby="store-tab-owned" class="store-panel" hidden=""');
  // The tools live, unchanged, in the hidden Tools panel, after the shop and the owned proxies.
  const tools = owner.indexOf('id="store-panel-tools"');
  expect(owner.slice(tools, tools + 120)).toContain('hidden=""');
  expect(owner.indexOf("Check proxies")).toBeGreaterThan(tools);
  expect(owner.indexOf("Replace proxies")).toBeGreaterThan(tools);
  expect(owner.indexOf("store-shop")).toBeLessThan(owner.indexOf("store-orders"));
  // One purchase card and one primary purchase button: no balance card, no extra buy cards, no outside link.
  expect(owner).not.toContain("store-funds");
  expect(owner).not.toContain("proxy-referral");
  expect(owner).not.toContain("nobleproxy.com/t/aliasmode");
  expect(owner).not.toContain("PROXY TOOLS");
  expect(owner.match(/class="btn primary store-cta"/g)).toHaveLength(1);

  // An offer elsewhere asks for a quantity: the Buy tab shows it.
  const offered = render(<StorePage state={state} role="owner" requestedQuantity={7} focusKey={1} selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  expect(offered).toContain('aria-valuetext="7"');

  const member = page("member");
  expect(tabsOf(member)).toEqual([["Buy proxies", "false"], ["My proxies (2)", "true"], ["Tools", "false"]]);
  expect(member).toContain('class="store-balance">$12.50</strong>');
  expect(member).toContain(">History</button>");
  expect(member).toContain("Only the workspace owner can add funds and buy proxies.");
  expect(member).toContain("1.2.3.4:8000:u:p");
  expect(member).toContain("Check proxies");
  expect(member).not.toContain(">Add funds</button>");
  expect(member).not.toContain("store-shop");
  expect(member).not.toContain("Powered by NobleProxy");
});

test("My proxies without any order shows one calm empty state; owners get a Buy proxies button", () => {
  const none = { ok: true, orders: [], pendingPurchases: [] } satisfies ListPurchasedProxiesResponse;
  const owner = render(<StorePage state={snapshot(0, none)} role="owner" initialTab="owned" selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  expect(owner).toContain(">My proxies</button>");
  expect(owner).toContain("No proxies yet");
  expect(owner).toContain('<button type="button" class="btn primary">Buy proxies</button>');
  const member = render(<StorePage state={snapshot(0, none)} role="member" selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  expect(member).toContain("No proxies yet");
  expect(member).not.toContain('class="btn primary">Buy proxies</button>');
});

test("Local mode keeps the Proxies page as before: the tools and the NobleProxy link", () => {
  const local = render(<ProxiesPage active groups={["", "Team"]} onChanged={noop} profilesWithoutProxy={3} />);
  expect(local).toContain("PROXY TOOLS");
  expect(local).toContain("Keep your profiles connected.");
  expect(local).toContain('href="https://nobleproxy.com/t/aliasmode?src=proxies-no-proxy&amp;qty=3"');
  expect(local).toContain("3 profiles have no proxy");
  expect(local).not.toContain("store-page");
  expect(local).not.toContain("Proxy tools<");
  // One NobleProxy card, also with no profile missing a proxy.
  expect(local.match(/class="proxy-referral"/g)).toHaveLength(1);
  const allSet = render(<ProxiesPage active groups={[""]} onChanged={noop} profilesWithoutProxy={0} />);
  expect(allSet.match(/class="proxy-referral"/g)).toHaveLength(1);
  expect(allSet).toContain("src=proxies-check");
});

test("the sidebar has one Proxies item and no Wallet or Logs item; logs open from Settings", async () => {
  const app = await Bun.file(new URL("./app.tsx", import.meta.url)).text();
  const start = app.indexOf('<nav className="sidenav"');
  const sidebar = app.slice(start, app.indexOf("</nav>", start));
  expect(sidebar).toContain('<span className="navlabel">{t("Proxies")}</span>');
  expect(sidebar).not.toContain('t("Wallet")');
  expect(sidebar).not.toContain('t("Logs")');
  expect(sidebar).not.toContain("fetchLogs");
  expect(app).not.toContain('"store"');
  expect(app).toContain('setView("proxies");\n    void cloudStore.reload();');
  // Settings → Advanced keeps the detailed log, in Local and Cloud mode.
  const advanced = app.slice(app.indexOf('settingsTab === "advanced"'));
  expect(advanced).toContain('{t("View detailed logs")}</button>');
  expect(advanced).toContain("fetchLogs().then(setLogView)");
});

/** Runs a component as part of a render and gives back the elements it returned, so a test can call their handlers. */
function capture(make: () => ReactElement | null, wrap: (child: ReactElement) => ReactElement = (child) => child): ReactElement {
  let tree: ReactElement | null = null;
  function Probe() { tree = make(); return null; }
  render(wrap(<Probe />));
  return tree!;
}
function findAll(node: unknown, match: (element: ReactElement<any>) => boolean, found: ReactElement<any>[] = []): ReactElement<any>[] {
  if (Array.isArray(node)) node.forEach((child) => findAll(child, match, found));
  else if (node && typeof node === "object" && "props" in node) {
    if (match(node as ReactElement<any>)) found.push(node as ReactElement<any>);
    findAll((node as ReactElement<any>).props.children, match, found);
  }
  return found;
}
const ctaOf = (tree: ReactElement) => findAll(tree, (element) => element.type === "button" && /store-cta/.test(element.props.className))[0]!;
async function until(check: () => boolean) {
  for (let round = 0; round < 200 && !check(); round++) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(check()).toBe(true);
}
/** The store events Cloud received through the app's /ui/api/cloud-store route. */
const sentEvents = (requests: Array<{ path: string; body: any }>) =>
  requests.filter((request) => request.path === "/store/events").flatMap((request) => request.body.events.map(({ type, src }: any) => `${type}:${src}`));

test("every in-app offer opens the store with the same src slug as its NobleProxy link", () => {
  const placements = ["profile-dialog", "profile-dialog-check-failed", "import-no-proxy", "proxies-no-proxy", "proxies-check", "proxies-check-failed"] as const;
  for (const placement of placements) {
    expect(PROXY_SRC).toContain(placement);
    // Local mode: the link is unchanged.
    expect(render(<ProxyProviderOffer placement={placement} missing={2} />)).toContain(`href="https://nobleproxy.com/t/aliasmode?src=${placement}&amp;qty=2"`);
    // Cloud mode: the button opens the store with that slug.
    const opened: Array<[number, string]> = [];
    const offer = capture(() => ProxyProviderOffer({ placement, missing: 2 }), (child) =>
      <ProxyStoreContext.Provider value={(quantity, src) => opened.push([quantity, src])}>{child}</ProxyStoreContext.Provider>);
    findAll(offer, (element) => element.type === "button")[0]!.props.onClick();
    expect(opened).toEqual([[2, placement]]);
  }
});

test("buttons inside the store open the shop as my-proxies-buy-more and success-buy-more; the shop gets the opening src", () => {
  const entered: string[] = [];
  const page = capture(() => StorePage({ state: snapshot(), role: "owner", selectedProfileIds: [], src: "proxies-tab", entryKey: 3, onReload: noop, onProfilesChanged: noop, onEnter: (src) => entered.push(src) }));
  const shop = findAll(page, (element) => element.type === ProxyShop)[0]!;
  expect(shop.props.src).toBe("proxies-tab");
  findAll(page, (element) => typeof element.type === "function" && element.type.name === "OwnedProxies")[0]!.props.onBuy();
  shop.props.onBuyMore();
  expect(entered).toEqual(["my-proxies-buy-more", "success-buy-more"]);
  // Without an opening src the shop reports "direct".
  expect(findAll(capture(() => StorePage({ state: snapshot(), role: "owner", selectedProfileIds: [], onReload: noop, onProfilesChanged: noop })), (element) => element.type === ProxyShop)[0]!.props.src).toBe("direct");
});

test("the Buy tab view and the app's entry points record their src (wiring in the page and the app)", async () => {
  const store = await Bun.file(new URL("./store.tsx", import.meta.url)).text();
  const app = await Bun.file(new URL("./app.tsx", import.meta.url)).text();
  // store_view: each time the Buy tab is on screen for an owner with a catalog, with the src that opened it.
  expect(store).toContain('const shopShown = active && tab === "buy" && owner && !!state.catalog;');
  expect(store).toContain('useEffect(() => { if (shopShown) trackStoreEvent("store_view", src); }, [shopShown, src, entryKey]);');
  expect(store).toContain("onDone={() => { onBuyMore?.(); setOutcome(null); }}");
  // entry_click: one function records every way in and makes it the store's src.
  expect(app).toContain('trackStoreEvent("entry_click", src);\n    setStoreEntry((current) => ({ src, key: current.key + 1 }));');
  expect(app).toContain("const openStore = useCallback((quantity: number, src: ProxySrc) => {\n    enterStore(src);");
  expect(app).toContain('onClick={() => openStore(0, "sidebar-cart")}><CartIcon /></button>');
  expect(app).toContain('if (storeSnapshot) { enterStore("proxies-tab"); void cloudStore.reload(); }');
  expect(app).toContain('active={view === "proxies"} src={storeEntry.src} entryKey={storeEntry.key}\n            onEnter={enterStore}');
  // Events go to Cloud only while the Cloud store is available; Local mode keeps the NobleProxy link.
  expect(app).toContain("useStoreEvents(!!storeSnapshot);");
  expect(app).toContain('href={proxyOfferUrl("sidebar-cart", language)}');
});

test("Buy records pay_click with the opening src, and the purchase sends that src to Cloud", async () => {
  const requests = liveCloud((method, path) => {
    if (method === "POST" && path === "/proxies/purchases") return Response.json(purchase("active"));
    if (method === "POST" && path === "/store/events") return Response.json({ ok: true });
    return undefined;
  });
  storeEvents.setEnabled(true);
  try {
    const page = capture(() => StorePage({ state: snapshot(5000), role: "owner", selectedProfileIds: [], src: "sidebar-cart", onReload: noop, onProfilesChanged: noop }));
    const props = findAll(page, (element) => element.type === ProxyShop)[0]!.props;
    const shop = capture(() => ProxyShop({ ...props, initialQuantity: 2 }));
    ctaOf(shop).props.onClick();
    ctaOf(shop).props.onClick();
    await until(() => requests.some((request) => request.path === "/proxies/purchases"));
    expect(requests.find((request) => request.path === "/proxies/purchases")!.body).toMatchObject({ type: "isp", country: "US", quantity: 2, src: "sidebar-cart" });
    await storeEvents.flush();
    // The double click counts once.
    expect(sentEvents(requests)).toEqual(["pay_click:sidebar-cart"]);
    const body = requests.find((request) => request.path === "/store/events")!.body;
    expect(Object.keys(body)).toEqual(["events"]);
    expect(Object.keys(body.events[0]).sort()).toEqual(["at", "src", "type"]);
    expect(Math.abs(body.events[0].at - Date.now())).toBeLessThan(10_000);
  } finally { storeEvents.setEnabled(false); }
});

test("Pay records pay_click; the src chosen at Pay is saved with the top-up and sent with the purchase after it is paid", async () => {
  const requests = liveCloud((method, path) => {
    if (path === `/wallet/deposits/${pendingOrder.depositId}`) return Response.json({ ok: true, deposit: paidDeposit("paid") } satisfies DepositResponse);
    if (method === "POST" && path === "/proxies/purchases") return Response.json(purchase("active"));
    if (method === "POST" && path === "/store/events") return Response.json({ ok: true });
    return undefined;
  });
  storeEvents.setEnabled(true);
  try {
    const shop = capture(() => ProxyShop({ catalog: cloudCatalog, balanceCents: 0, src: "profile-dialog", selectedProfileIds: [], onReload: noop, onProfilesChanged: noop }));
    expect(ctaOf(shop).props.children).toBe("Pay $5.00");
    ctaOf(shop).props.onClick();
    await storeEvents.flush();
    expect(sentEvents(requests)).toEqual(["pay_click:profile-dialog"]);
  } finally { storeEvents.setEnabled(false); }

  // The pending pay-to-buy state keeps its src across a restart; the paid deposit buys with it.
  savePendingOrder({ ...pendingOrder, src: "profile-dialog" });
  const saved = loadPendingOrder()!;
  expect(saved.src).toBe("profile-dialog");
  expect(await resumePendingOrder()).toEqual({ kind: "finish", order: saved });
  expect(await buyAfterDeposit(saved, paidDeposit("paid"), new Set())).toMatchObject({ kind: "active" });
  expect(requests.filter((request) => request.path === "/proxies/purchases").map((request) => request.body)).toEqual([
    { type: "isp", country: "US", quantity: 12, idempotencyKey: "order-key-1", src: "profile-dialog" },
  ]);
  // An order saved by an older app has no src and still loads.
  savePendingOrder(pendingOrder);
  expect(loadPendingOrder()).toEqual(pendingOrder);
});

test("the app's Cloud route sends only type, src and time to POST /v1/store/events; an older Cloud's 404 comes back as 404", async () => {
  let supported = true;
  const requests = fakeCloud((method, path) => method === "POST" && path === "/store/events" && supported ? Response.json({ ok: true }) : noRoute());
  const post = (body: unknown) => fetch("/ui/api/cloud-store", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const sent = await post({ action: "store-events", events: [
    { type: "entry_click", src: "sidebar-cart", at: 1762400000000, email: "someone@example.com" },
    { type: "signup", src: "sidebar-cart", at: 1762400000000 },
    { type: "pay_click", src: "Not A Slug", at: 1762400000000 },
    { type: "store_view", src: "sidebar-cart", at: "now" },
  ] });
  expect(sent.status).toBe(200);
  expect(requests).toEqual([{ method: "POST", path: "/store/events", body: { events: [{ type: "entry_click", src: "sidebar-cart", at: 1762400000000 }] } }]);
  expect((await post({ action: "store-events", events: [] })).status).toBe(400);
  supported = false;
  expect((await post({ action: "store-events", events: [{ type: "pay_click", src: "direct", at: 1 }] })).status).toBe(404);
  expect(requests).toHaveLength(2);
});

test("a purchase src reaches Cloud; a Cloud that does not know src yet still gets the order, once, with the same key", async () => {
  let knowsSrc = true;
  const requests = fakeCloud((method, path, body) => {
    if (method !== "POST" || path !== "/proxies/purchases") return noRoute();
    return "src" in body && !knowsSrc ? cloudError(400, "validation_failed", "The request is invalid.") : Response.json(purchase("active"));
  });
  const order = { type: "isp", country: "US", quantity: 2, src: "proxies-tab" };
  expect(await buyProxies(new PurchaseAttempts(() => "key-1"), order)).toMatchObject({ kind: "active" });
  knowsSrc = false;
  expect(await buyProxies(new PurchaseAttempts(() => "key-2"), order)).toMatchObject({ kind: "active" });
  expect(requests.map((request) => request.body)).toEqual([
    { type: "isp", country: "US", quantity: 2, idempotencyKey: "key-1", src: "proxies-tab" },
    { type: "isp", country: "US", quantity: 2, idempotencyKey: "key-2", src: "proxies-tab" },
    { type: "isp", country: "US", quantity: 2, idempotencyKey: "key-2" },
  ]);
  // Other refusals are not retried.
  const refused = fakeCloud(() => cloudError(402, "insufficient_balance"));
  expect(await buyProxies(new PurchaseAttempts(), order)).toMatchObject({ kind: "error" });
  expect(refused).toHaveLength(1);
});

test("Local mode sends no store events: without a Cloud connection the route refuses and nothing reaches Cloud", async () => {
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    (await handleUiRequest(new Request(`http://127.0.0.1${url}`, init), {} as any, {} as any, null, {})) ?? new Response("not found", { status: 404 })) as typeof fetch;
  const response = await fetch("/ui/api/cloud-store", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "store-events", events: [{ type: "entry_click", src: "sidebar-cart", at: 1 }] }) });
  expect(response.status).toBe(503);
  // And the page never sends: the tracker is off unless the Cloud store turned it on.
  const calls: unknown[] = [];
  globalThis.fetch = (async (...args: unknown[]) => { calls.push(args); return new Response("{}"); }) as typeof fetch;
  storeEvents.track("entry_click", "sidebar-cart");
  await storeEvents.flush();
  expect(calls).toEqual([]);
});
