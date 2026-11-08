import { beforeEach, describe, expect, test } from "bun:test";
import bundled from "./services-directory.json";
import { SERVICES_URL, loadServices, parseServices, resetServicesCache } from "./services-directory.ts";

const listing = {
  slug: "smspool",
  name: "SMSPool",
  category: "sms",
  description: "Phone numbers for account checks.",
  deal: "10% off",
  code: "ALIAS10",
  badge: "sponsored",
  logo: "data:image/png;base64,iVBORw0KGgo=",
};

describe("services list", () => {
  beforeEach(() => resetServicesCache());

  test("keeps well-formed entries and drops remote logos and unknown fields", () => {
    expect(parseServices({ services: [
      { ...listing, url: "https://smspool.example/?ref=1" },
      { ...listing, slug: "remote-logo", badge: "featured", logo: "https://tracker.example/logo.png", deal: " " },
      { ...listing, slug: "Bad Slug" },
      { ...listing, slug: "no-name", name: "" },
      null,
    ] })).toEqual([
      { slug: "smspool", name: "SMSPool", category: "sms", description: "Phone numbers for account checks.", deal: "10% off", code: "ALIAS10", badge: "sponsored", logo: listing.logo },
      { slug: "remote-logo", name: "SMSPool", category: "sms", description: "Phone numbers for account checks.", code: "ALIAS10", badge: null },
    ]);
    expect(parseServices({ services: "x" })).toBeNull();
    expect(parseServices(null)).toBeNull();
  });

  test("fetches the live list without credentials and keeps it for a while", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ version: 1, services: [listing] });
    }) as unknown as typeof fetch;
    const first = await loadServices(fetchFn, 1_000);
    expect(first.source).toBe("live");
    expect(first.services.map((service) => service.slug)).toEqual(["smspool"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://aliasmode.com/_am/services");
    expect(calls[0]!.url).toBe(SERVICES_URL);
    expect(calls[0]!.init?.credentials).toBe("omit");
    expect(calls[0]!.init?.headers).toBeUndefined();
    expect((await loadServices(fetchFn, 1_000 + 14 * 60_000)).source).toBe("live");
    expect(calls).toHaveLength(1);
    await loadServices(fetchFn, 1_000 + 16 * 60_000);
    expect(calls).toHaveLength(2);
  });

  test("falls back to the bundled copy when aliasmode.com fails", async () => {
    const bundledSlugs = bundled.services.map((service) => service.slug);
    expect(bundledSlugs).toEqual(["nobleproxy", "xreacher"]);
    for (const fetchFn of [
      (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
      (async () => new Response("down", { status: 502 })) as unknown as typeof fetch,
      (async () => Response.json({ error: "nope" })) as unknown as typeof fetch,
    ]) {
      const result = await loadServices(fetchFn);
      expect(result.source).toBe("bundled");
      expect(result.services.map((service) => service.slug)).toEqual(bundledSlugs);
    }
    for (const service of bundled.services) expect(service.logo.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });
});
