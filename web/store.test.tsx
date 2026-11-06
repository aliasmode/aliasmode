import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { I18nProvider } from "./i18n.tsx";
import { ProxyProviderOffer, ProxyStoreContext } from "./proxy-offer.tsx";
import {
  CardPaymentView,
  CryptoPaymentView,
  NobleProxyButton,
  ProxyShop,
  PurchaseAttempts,
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
afterEach(() => { globalThis.fetch = realFetch; });

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

  const page = render(<StorePage active state={state as StoreSnapshot} role="owner" selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  expect(page).toContain("$12.50");
  expect(page).toContain("2 × ISP");
  expect(page).toContain("1.2.3.4:8000:u:p");
  expect(page).toContain("United States");
  expect(page).toContain(`Expires ${new Date(cloudOrder.expiresAt).toLocaleDateString("en-US")}`);
  expect(page).toContain(">Reopen checkout</button>");
  expect(page).toContain("2 isp proxies (US)");
  expect(page).toContain("+$18.50");
});

test("a NobleProxy outage hides only the shop: the wallet and owned proxies still show", async () => {
  const requests = liveCloud((_, path) => path === "/proxies/catalog" ? cloudError(503, "partner_unavailable", "Credits and proxy purchases are not available.") : undefined);
  const state = await loadStoreState();
  expect(state).toEqual({ available: true, wallet: cloudWallet, proxies: cloudProxies, catalog: null });
  expect(requests).toHaveLength(3);

  const page = render(<StorePage active state={state as StoreSnapshot} role="owner" selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  expect(page).toContain("Store temporarily unavailable.");
  expect(page).toContain(">Try again</button>");
  expect(page).toContain("$12.50");
  expect(page).toContain(">Top up</button>");
  expect(page).toContain("1.2.3.4:8000:u:p");
  expect(page).not.toContain(">Buy</button>");

  // A wallet that cannot be read still keeps the outside offer instead of an empty page.
  liveCloud((_, path) => path === "/wallet" ? cloudError(500, "internal_error") : undefined);
  expect(await loadStoreState()).toEqual({ available: false });
});

test("charged purchases that are still settling stay visible as Processing or Being checked by support", () => {
  const pending = purchase("pending").purchase;
  const review = { ...purchase("needs_review").purchase, id: "9e2d4c1b-7a6f-4e3d-8c2b-1a0f9e8d7c02", quantity: 5, totalCents: 1500 };
  const proxies = { ok: true, orders: [], pendingPurchases: [pending, review] } satisfies ListPurchasedProxiesResponse;
  for (const role of ["owner", "member"]) {
    const page = render(<StorePage active state={snapshot(0, proxies)} role={role} selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
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
    render(<StorePage active state={snapshot(5000, { ...cloudProxies, orders: [{ ...cloudOrder, ...order }] })} role="owner" selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  const addFunds = "Renewal failed. Add funds to your wallet to keep these proxies.";
  expect(page({ renewalStatus: "ok" })).not.toMatch(/Renewal (failed|in progress|could not)|renewal is being checked/);
  expect(page({ renewalStatus: "pending" })).toContain("Renewal in progress…");
  expect(page({ renewalStatus: "needs_review" })).toContain("The renewal is being checked by support.");
  const refused = page({ renewalStatus: "renewal_failed", renewalFailure: "partner_failed" });
  expect(refused).toContain("Renewal could not be completed. You were not charged.");
  expect(refused).not.toContain(addFunds);
  expect(page({ renewalStatus: "renewal_failed", renewalFailure: "insufficient_balance" })).toContain(addFunds);
});

test("the live total follows catalog tiers and Buy is disabled with a Top up offer when the balance is short", () => {
  const product = cloudCatalog.products[0]!;
  expect(quoteProxyPrice(product, 1)).toEqual({ unitPriceCents: 300, totalCents: 300 });
  expect(quoteProxyPrice(product, 12)).toEqual({ unitPriceCents: 250, totalCents: 3000 });
  expect(quoteProxyPrice({ ...product, tiers: [{ minQty: 5, unitPriceCents: 100 }] }, 4)).toBeNull();

  const props = { catalog: cloudCatalog, selectedProfileIds: [], onTopUp: () => {}, onReload: noop, onProfilesChanged: noop };
  const short = render(<ProxyShop {...props} balanceCents={1000} initialQuantity={12} />);
  expect(short).toMatch(/<button type="button" class="btn primary" disabled="">Buy<\/button>/);
  expect(short).toContain("$30.00");
  expect(short).toContain("Add $20.00 to buy this order.");
  expect(short).toContain(">Top up</button>");

  const enough = render(<ProxyShop {...props} balanceCents={5000} initialQuantity={12} />);
  expect(enough).toMatch(/<button type="button" class="btn primary">Buy<\/button>/);
  expect(enough).not.toContain(">Top up</button>");
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
  expect(html).toContain("USDT (TRC20)");
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
  const html = render(<StorePage active state={snapshot(0)} role="owner" selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  expect(html).toContain('value="20"');
  expect(html).toContain('min="5" max="10000" step="0.01"');
  expect(html).toMatch(/<button type="button" class="btn primary">Top up<\/button>/);
  expect(html).not.toContain("Enter an amount from");

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
  const html = render(<StorePage active state={state} role="owner" selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  expect(html).toContain("Static residential for X");
  expect(html).toContain("Any country");
  expect(html).toContain("Germany");
  expect(html).toContain("France");
  expect(html).not.toContain("x-twitter-12<");
  expect(html).not.toContain("retired-type-7");
  expect(html).not.toMatch(/>(ANY|DE|FR)</);
});

test("owners can top up, buy and manage on NobleProxy; members see balance and proxies without those buttons", () => {
  const page = (role: string) => render(<StorePage active state={snapshot(5000)} role={role} selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  const owner = page("owner");
  expect(owner).toContain("$50.00");
  expect(owner).toContain(">Top up</button>");
  expect(owner).toContain(">Buy</button>");
  expect(owner).toContain(">Manage on NobleProxy ↗</button>");
  expect(owner).toContain('type="checkbox" checked=""');

  for (const role of ["member", "admin"]) {
    const member = page(role);
    expect(member).toContain("$50.00");
    expect(member).toContain("2 × ISP");
    expect(member).toContain("1.2.3.4:8000:u:p");
    expect(member).toContain("Only the workspace owner can add funds and buy proxies.");
    expect(member).toContain("Auto-renew is on");
    expect(member).not.toContain(">Top up</button>");
    expect(member).not.toContain(">Buy</button>");
    expect(member).not.toContain("Manage on NobleProxy");
    expect(member).not.toContain('type="checkbox"');
    expect(member).not.toContain("Assign to");
  }
});

test("purchases through the live Cloud bodies show ready proxies, a refund, or a pending order", async () => {
  let answer: Response = Response.json({});
  const requests = fakeCloud((method, path) => method === "POST" && path === "/proxies/purchases" ? answer : noRoute());
  const show = (outcome: Awaited<ReturnType<typeof buyProxies>>, orders?: CloudProxyOrder[]) =>
    render(<PurchaseResult outcome={outcome} orders={orders} selectedProfileIds={["p1", "p2"]} onProfilesChanged={noop} onTopUp={() => {}} />);
  const order = { type: "isp", country: "US", quantity: 2 };

  answer = Response.json(purchase("active"));
  const active = await buyProxies(new PurchaseAttempts(), order);
  expect(active).toEqual({ kind: "active", result: purchase("active") });
  expect(requests.at(-1)?.body).toEqual({ ...order, idempotencyKey: expect.any(String) });
  const activeHtml = show(active);
  expect(activeHtml).toContain("Your 2 proxies are ready.");
  expect(activeHtml).toContain("1.2.3.5:8000:u:p");
  expect(activeHtml).toContain("Assign to 2 selected profiles");

  answer = Response.json(purchase("failed"));
  const failed = await buyProxies(new PurchaseAttempts(), order);
  expect(failed.kind).toBe("failed");
  expect(show(failed)).toContain("We could not deliver this order. $6.00 was refunded to your balance.");

  answer = Response.json(purchase("pending"), { status: 202 });
  const pending = await buyProxies(new PurchaseAttempts(), order);
  expect(pending.kind).toBe("pending");
  expect(show(pending)).toContain("Your order is being prepared.");

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
  expect(show(short)).toContain(">Top up</button>");

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
    "Wallet & proxies", "Wallet", "Buy proxies", "Buy static residential proxies in the app and give each profile its own IP.",
  ]);
  expect(keys.size).toBeGreaterThan(60);
  for (const catalog of [ruRU, zhCN] as Array<Record<string, string>>) {
    expect([...keys].filter((key) => !catalog[key])).toEqual([]);
  }
});
