import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { I18nProvider } from "./i18n.tsx";
import { ProxyProviderOffer, ProxyStoreContext } from "./proxy-offer.tsx";
import {
  CardPaymentView,
  CryptoPaymentView,
  ProxyShop,
  PurchaseAttempts,
  PurchaseResult,
  StorePage,
  assignProxiesToProfiles,
  buyProxies,
  createDeposit,
  isStripeCheckoutUrl,
  loadStoreState,
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
import type { ProxyCatalogResponse, PurchasedProxy } from "../contracts/cloud-v1.ts";
import ruRU from "./locales/ru-RU.json";
import zhCN from "./locales/zh-CN.json";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const render = (element: ReactElement) => renderToStaticMarkup(<I18nProvider>{element}</I18nProvider>);
const t = (key: string) => key;
const noop = async () => {};

const catalog: ProxyCatalogResponse = {
  products: [{
    type: "static_residential", label: "Static residential",
    countries: [{ code: "US", name: "United States" }, { code: "DE", name: "Germany" }],
    tiers: [{ minQty: 1, unitPriceCents: 300 }, { minQty: 10, unitPriceCents: 250 }],
  }],
};

function proxy(index: number, password = `pass${index}`): PurchasedProxy {
  return { id: `px${index}`, host: `10.0.0.${index}`, port: 8000 + index, username: `user${index}`, password, protocol: "http", country: "US" };
}

function snapshot(balanceCents: number): StoreSnapshot {
  return {
    available: true,
    wallet: { balanceCents, entries: [{ id: "e1", amountCents: 2000, kind: "deposit", createdAt: "2026-11-01T10:00:00Z" }], pendingDeposits: [] },
    catalog,
    orders: [{ orderId: "o1", type: "static_residential", country: "US", quantity: 2, expiresAt: "2026-12-01T00:00:00Z", autoRenew: true, renewalStatus: "renewal_failed", proxies: [proxy(1), proxy(2)] }],
  };
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

const cloudError = (status: number, code: string) => Response.json({ ok: false, error: { code, message: code } }, { status });

test("an older Cloud without the wallet answers 404, so the store stays hidden and offers stay NobleProxy links", async () => {
  fakeCloud(() => new Response("404 Not Found", { status: 404, headers: { "content-type": "text/plain" } }));
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

test("a Cloud with the wallet returns balance, catalog and owned proxies in one snapshot", async () => {
  const requests = fakeCloud((_, path) => {
    if (path === "/wallet") return Response.json({ balanceCents: 1234, entries: [], pendingDeposits: [] });
    if (path === "/proxies/catalog") return Response.json(catalog);
    if (path === "/proxies") return Response.json({ orders: [] });
    return cloudError(404, "not_found");
  });
  const state = await loadStoreState();
  expect(state).toMatchObject({ available: true, wallet: { balanceCents: 1234 }, catalog, orders: [] });
  expect(requests.map((request) => request.path).sort()).toEqual(["/proxies", "/proxies/catalog", "/wallet"]);
});

test("the live total follows catalog tiers and Buy is disabled with a Top up offer when the balance is short", () => {
  const product = catalog.products[0]!;
  expect(quoteProxyPrice(product, 1)).toEqual({ unitPriceCents: 300, totalCents: 300 });
  expect(quoteProxyPrice(product, 12)).toEqual({ unitPriceCents: 250, totalCents: 3000 });
  expect(quoteProxyPrice({ ...product, tiers: [{ minQty: 5, unitPriceCents: 100 }] }, 4)).toBeNull();

  const props = { catalog, selectedProfileIds: [], onTopUp: () => {}, onReload: noop, onProfilesChanged: noop };
  const short = render(<ProxyShop {...props} balanceCents={1000} initialQuantity={12} />);
  expect(short).toMatch(/<button type="button" class="btn primary" disabled="">Buy<\/button>/);
  expect(short).toContain("$30.00");
  expect(short).toContain("Add $20.00 to buy this order.");
  expect(short).toContain(">Top up</button>");

  const enough = render(<ProxyShop {...props} balanceCents={5000} initialQuantity={12} />);
  expect(enough).toMatch(/<button type="button" class="btn primary">Buy<\/button>/);
  expect(enough).not.toContain(">Top up</button>");
});

test("top-ups accept $5 to $10,000, and Cloud's own words explain a rejected amount", async () => {
  const html = render(<StorePage active state={snapshot(0)} role="owner" selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  expect(html).toContain('value="20"');
  expect(html).toContain('min="5" max="10000" step="0.01"');
  expect(html).toMatch(/<button type="button" class="btn primary">Top up<\/button>/);
  expect(html).not.toContain("Enter an amount from");

  const requests = fakeCloud(() => cloudError(400, "validation_failed"));
  const error = await createDeposit(400, "card").catch((value) => value);
  expect(error.message).toBe("validation_failed");
  expect(requests[0]).toMatchObject({ method: "POST", path: "/wallet/deposits", body: { amountCents: 400, method: "card" } });
});

test("proxy types and countries show their names, never raw ids", () => {
  const anyCountry: ProxyCatalogResponse = { products: [{ ...catalog.products[0]!, type: "x-twitter-12", label: "Static residential for X", countries: [{ code: "ANY", name: "" }, { code: "US", name: "United States" }] }] };
  const state: StoreSnapshot = { ...snapshot(5000), catalog: anyCountry, orders: [
    { ...snapshot(0).orders[0]!, type: "x-twitter-12", country: "ANY", proxies: [{ ...proxy(1), country: "DE" }] },
    { ...snapshot(0).orders[0]!, orderId: "o2", type: "retired-type-7", country: "FR", proxies: [] },
  ] };
  const html = render(<StorePage active state={state} role="owner" selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  expect(html).toContain("Static residential for X");
  expect(html).toContain("Any country");
  expect(html).toContain("Germany");
  expect(html).toContain("France");
  expect(html).not.toContain("x-twitter-12<");
  expect(html).not.toContain("retired-type-7");
  expect(html).not.toMatch(/>(ANY|DE|FR)</);
});

test("owners can top up and buy; members see balance and proxies without payment buttons", () => {
  const page = (role: string) => render(<StorePage active state={snapshot(5000)} role={role} selectedProfileIds={[]} onReload={noop} onProfilesChanged={noop} />);
  const owner = page("owner");
  expect(owner).toContain("$50.00");
  expect(owner).toContain(">Top up</button>");
  expect(owner).toContain(">Buy</button>");
  expect(owner).toContain('type="checkbox" checked=""');
  expect(owner).toContain("Renewal failed. Add funds to your wallet to keep these proxies.");

  for (const role of ["member", "admin"]) {
    const member = page(role);
    expect(member).toContain("$50.00");
    expect(member).toContain("2 × Static residential");
    expect(member).toContain("10.0.0.1:8001:user1:pass1");
    expect(member).toContain("Only the workspace owner can add funds and buy proxies.");
    expect(member).toContain("Auto-renew is on");
    expect(member).not.toContain(">Top up</button>");
    expect(member).not.toContain(">Buy</button>");
    expect(member).not.toContain('type="checkbox"');
    expect(member).not.toContain("Assign to");
  }
});

test("purchases through a fake Cloud show ready proxies, a refund, or a pending order", async () => {
  let answer: Response = Response.json({});
  const requests = fakeCloud((method, path) => method === "POST" && path === "/proxies/purchases" ? answer : cloudError(404, "not_found"));
  const show = (outcome: Awaited<ReturnType<typeof buyProxies>>) => render(<PurchaseResult outcome={outcome} selectedProfileIds={["p1", "p2"]} onProfilesChanged={noop} onTopUp={() => {}} />);
  const order = { type: "static_residential", country: "US", quantity: 2 };

  answer = Response.json({ purchaseId: "pu1", status: "active", chargedCents: 600, orderId: "o1", proxies: [proxy(1), proxy(2)] });
  const active = await buyProxies(new PurchaseAttempts(), order);
  expect(active.kind).toBe("active");
  expect(requests.at(-1)?.body).toMatchObject({ ...order, idempotencyKey: expect.any(String) });
  const activeHtml = show(active);
  expect(activeHtml).toContain("Your 2 proxies are ready.");
  expect(activeHtml).toContain("10.0.0.2:8002:user2:pass2");
  expect(activeHtml).toContain("Assign to 2 selected profiles");

  answer = Response.json({ purchaseId: "pu2", status: "failed", chargedCents: 600 });
  const failed = await buyProxies(new PurchaseAttempts(), order);
  expect(failed.kind).toBe("failed");
  expect(show(failed)).toContain("We could not deliver this order. $6.00 was refunded to your balance.");

  answer = Response.json({ purchaseId: "pu3", status: "pending", chargedCents: 600 });
  const pending = await buyProxies(new PurchaseAttempts(), order);
  expect(pending.kind).toBe("pending");
  expect(show(pending)).toContain("Your order is being prepared.");

  answer = Response.json({ purchaseId: "pu4", status: "needs_review", chargedCents: 600 });
  const review = await buyProxies(new PurchaseAttempts(), order);
  expect(review.kind).toBe("review");
  expect(show(review)).toContain("We&#x27;re checking this order. You&#x27;ll see the proxies or a refund soon.");

  // After a renewal the latest GET /v1/proxies credentials replace the ones in the purchase answer.
  const renewed = render(<PurchaseResult outcome={active} orders={[{ ...snapshot(0).orders[0]!, orderId: "o1", proxies: [proxy(1, "rotated1"), proxy(2, "rotated2")] }]} selectedProfileIds={[]} onProfilesChanged={noop} onTopUp={() => {}} />);
  expect(renewed).toContain("10.0.0.1:8001:user1:rotated1");
  expect(renewed).not.toContain("pass1");

  answer = cloudError(402, "insufficient_balance");
  const short = await buyProxies(new PurchaseAttempts(), order);
  expect(short).toMatchObject({ kind: "error", error: { kind: "insufficient" } });
  expect(show(short)).toContain(">Top up</button>");

  answer = cloudError(403, "validation_failed");
  expect(await buyProxies(new PurchaseAttempts(), order)).toMatchObject({ kind: "error", error: { kind: "forbidden" } });
});

test("a purchase retry after a lost answer reuses its idempotency key; a settled one gets a new key", async () => {
  let lose = true;
  const requests = fakeCloud(() => {
    if (lose) throw new TypeError("connection reset");
    return Response.json({ purchaseId: "pu1", status: "active", chargedCents: 300, proxies: [proxy(1)] });
  });
  let counter = 0;
  const attempts = new PurchaseAttempts(() => `key-${++counter}`);
  const order = { type: "static_residential", country: "US", quantity: 1 };
  expect(await buyProxies(attempts, order)).toMatchObject({ kind: "error", error: { kind: "network" } });
  lose = false;
  expect((await buyProxies(attempts, order)).kind).toBe("active");
  await buyProxies(attempts, order);
  await buyProxies(attempts, { ...order, quantity: 2 });
  expect(requests.map((request) => request.body.idempotencyKey)).toEqual(["key-1", "key-1", "key-2", "key-3"]);
});

test("the crypto payment view shows the exact amount, copy buttons, a QR code and the fee note, then polls to paid", async () => {
  const deposit: ActiveDeposit = {
    depositId: "d1", amountCents: 2500, method: "crypto", status: "pending", expiresAt: "2026-11-06T12:30:00Z",
    methods: [{ id: "usdt-trc20", coin: "USDT", network: "Tron (TRC-20)", label: "USDT · Tron", amount: "25.004817", address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", paymentUri: "tron:TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf?amount=25.004817" }],
  };
  const html = render(<CryptoPaymentView deposit={deposit} now={Date.parse("2026-11-06T12:20:05Z")} />);
  expect(html).toContain("25.004817 USDT");
  expect(html).toContain("TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf");
  expect(html).toContain('aria-label="Copy amount"');
  expect(html).toContain('aria-label="Copy address"');
  expect(html).toContain('class="store-qr"');
  expect(html).toContain("09:55");
  expect(html).toContain("Send exactly this amount in one transfer. If your exchange deducts the withdrawal fee, add it on top.");
  expect(render(<CryptoPaymentView deposit={{ ...deposit, status: "paid" }} />)).toContain("Payment received. $25.00 was added to your balance.");

  const statuses = ["pending", "pending", "paid"];
  const requests = fakeCloud((_, path) => path === "/wallet/deposits/d1"
    ? Response.json({ depositId: "d1", amountCents: 2500, method: "crypto", status: statuses.shift() })
    : cloudError(404, "not_found"));
  const seen: string[] = [];
  const final = await watchDeposit("d1", (next) => seen.push(next.status), new AbortController().signal, 0);
  expect(final?.status).toBe("paid");
  expect(seen).toEqual(["pending", "pending", "paid"]);
  expect(requests).toHaveLength(3);
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

test("card checkout opens only Stripe Checkout, and the desktop shell allows exactly that address", async () => {
  const shell = await Bun.file(new URL("../src-tauri/src/lib.rs", import.meta.url)).text();
  expect(shell).toContain('url.strip_prefix("https://checkout.stripe.com/")');
  expect(shell).toContain('b"/_-.#%=+~"');
  expect(shell).toContain("proxy_offer_url(url) || stripe_checkout_url(url)");
  const accepted = ["https://checkout.stripe.com/c/pay/cs_test_a1B2c3D4e5#fidkdWxOYHwnPyd1blpxYHZxWjA0SmZ%2FPWBWfQ%3D%3D"];
  const rejected = [
    "https://checkout.stripe.com/", "http://checkout.stripe.com/c/pay/cs_test_a1", "https://checkout.stripe.com.example.com/c/pay/cs_test_a1",
    "https://checkout.stripe.com@example.com/c/pay/cs_test_a1", "https://checkout.stripe.com/c/pay/cs_test_a1?redirect=https://example.com",
    "https://checkout.stripe.com/c/pay/cs test", "https://checkout.stripe.com/c/pay/cs_test\\@example.com", "https://dashboard.stripe.com/c/pay/cs_test_a1",
    "https://nobleproxy.com/t/aliasmode", "javascript:alert(1)",
  ];
  // The same lists are in the Rust test allows_only_explicit_external_pages.
  for (const url of accepted) { expect(isStripeCheckoutUrl(url)).toBe(true); expect(shell).toContain(`"${url}"`); }
  for (const url of rejected) expect(isStripeCheckoutUrl(url)).toBe(false);

  const deposit: ActiveDeposit = { depositId: "d1", amountCents: 2000, method: "card", status: "pending", checkoutUrl: accepted[0] };
  const html = render(<CardPaymentView deposit={deposit} />);
  expect(html).toContain(`href="${accepted[0]}" target="_blank" rel="noreferrer"`);
  expect(html).toContain("Waiting for your payment");
  const other = render(<CardPaymentView deposit={{ ...deposit, checkoutUrl: "https://example.com/pay" }} />);
  expect(other).not.toContain("example.com");
  expect(other).not.toContain("<a ");
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
  const proxies = [proxy(1, 'pa,ss"1'), proxy(2)];
  const result = await assignProxiesToProfiles(proxies, ["p3", "p1", "p2"], t);
  expect(result).toEqual({ updated: 1, unchanged: 0, skipped: 1 });
  expect(calls.map((call) => call.url)).toEqual(["/ui/api/proxies/preview", "/ui/api/proxies/apply"]);
  expect(calls[0]!.body).toMatchObject({ scope: { all: true, ids: ["p3", "p1"] }, mode: "profileId" });
  expect(calls[1]!.body).toEqual({ previewId: "pv1" });

  // The same input, read by the real bulk preview, pairs proxy 1 with p3 and proxy 2 with p1.
  const profiles: ProxyInventoryProfile[] = ["p1", "p2", "p3"].map((id) => ({ id, name: id, group: "", proxy: null, permission: "edit", running: false }));
  const preview = buildProxyPreview(profiles, calls[0]!.body);
  expect(preview.rows.map((row) => [row.view.profileId, row.next?.host, row.next?.pass, row.view.status])).toEqual([
    ["p3", "10.0.0.1", 'pa,ss"1', "ready"], ["p1", "10.0.0.2", "pass2", "ready"],
  ]);
});

test("auto-renew changes go to the order, and store changes need a same-origin JSON request", async () => {
  const requests = fakeCloud((_, path) => path === "/proxies/orders/o%201/auto-renew" ? Response.json({ ok: true }) : cloudError(404, "not_found"));
  const post = (body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
    fetch("/ui/api/cloud-store", { method: "POST", headers, body: JSON.stringify(body) });
  expect((await post({ action: "auto-renew", orderId: "o 1", enabled: false })).status).toBe(200);
  expect(requests).toEqual([{ method: "POST", path: "/proxies/orders/o%201/auto-renew", body: { enabled: false } }]);
  expect((await post({ action: "auto-renew", orderId: "o1", enabled: "no" })).status).toBe(400);
  expect((await post({ action: "purchase", type: "x", country: "US", quantity: 0, idempotencyKey: "k" })).status).toBe(400);
  expect((await post({ action: "auto-renew", orderId: "o1", enabled: true }, { "Content-Type": "text/plain" })).status).toBe(415);
  expect((await post({ action: "auto-renew", orderId: "o1", enabled: true }, { "Content-Type": "application/json", Origin: "https://evil.example" })).status).toBe(403);
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
