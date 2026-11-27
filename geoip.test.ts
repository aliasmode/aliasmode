import { test, expect, spyOn } from "bun:test";
import { lookupExitLocation, lookupExitTimezone, attachTimezones, lookupProxyExitLocation } from "./geoip.ts";

const GEOJS = "https://get.geojs.io/v1/ip/geo.json";
const IP_API = "http://ip-api.com/json/?fields=status,timezone,countryCode,query";
const IPINFO = "https://v6.ipinfo.io/json";

/** Answers per service: GeoJS (MaxMind data), ip-api.com and v6.ipinfo.io. A service without a row fails. */
function services(rows: { geojs?: object; ipApi?: object; ipinfo?: object }, calls: string[] = []) {
  return async (url: string, init: RequestInit) => {
    calls.push(`${url} via ${(init as { proxy?: string }).proxy ?? "direct"}`);
    init.signal?.throwIfAborted();
    const row = url === GEOJS ? rows.geojs : url === IP_API ? rows.ipApi : url === IPINFO ? rows.ipinfo : undefined;
    if (!row) throw new Error("unavailable");
    return { json: async () => row };
  };
}

test("location lookup carries country through the MaxMind, IPv4 and IPv6 responses", async () => {
  for (const rows of [
    { geojs: { timezone: "America/Mexico_City", country_code: "MX" } },
    { ipApi: { status: "success", timezone: "America/Mexico_City", countryCode: "MX" } },
    { ipinfo: { timezone: "America/Mexico_City", country: "MX" } },
  ]) {
    expect(await lookupExitLocation(null, services(rows))).toEqual({ timezone: "America/Mexico_City", country: "MX" });
  }
});

test("GeoJS's MaxMind zone wins over ip-api.com's, and both are asked through the same proxy", async () => {
  const calls: string[] = [];
  const location = await lookupExitLocation(proxy("gate.example.net"), services({
    geojs: { timezone: "America/New_York", country_code: "US", ip: "203.0.113.7" },
    ipApi: { status: "success", timezone: "America/Chicago", countryCode: "US", query: "203.0.113.7" },
  }, calls));
  expect(location).toEqual({ timezone: "America/New_York", country: "US", ip: "203.0.113.7" });
  expect(calls.map((call) => call.split(" via ")[0])).toEqual([GEOJS, IP_API]);
  expect(new Set(calls.map((call) => call.split(" via ")[1]))).toEqual(new Set([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/)]));
});

test("a hanging GeoJS gives way to ip-api.com's answer within a launch's wait", async () => {
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms: number) =>
    ms === 4_000 ? AbortSignal.abort(new DOMException("Timed out", "TimeoutError")) : new AbortController().signal,
  );
  try {
    const location = await lookupExitLocation(null, services({
      geojs: { timezone: "America/New_York", country_code: "US" },
      ipApi: { status: "success", timezone: "America/Chicago", countryCode: "US" },
    }));
    expect(location).toEqual({ timezone: "America/Chicago", country: "US" });
  } finally {
    timeout.mockRestore();
  }
});

test("country defaults fill missing locales but never replace saved choices without refresh", async () => {
  const profiles = [
    { proxy: proxy("gate.example.net"), timezone: "", locale: undefined as string | undefined },
    { proxy: proxy("gate.example.net"), timezone: "", locale: "fr-CA" },
  ];
  const fetch = services({ geojs: { timezone: "America/New_York", country_code: "MX" } });
  await attachTimezones(profiles, fetch);
  expect(profiles.map((p) => p.locale)).toEqual(["es-MX", "fr-CA"]);
  await attachTimezones(profiles, fetch, true);
  expect(profiles.map((p) => p.locale)).toEqual(["es-MX", "es-MX"]);
  await attachTimezones(profiles, async () => { throw new Error("offline"); }, true);
  expect(profiles.map((p) => [p.timezone, p.locale])).toEqual([
    ["America/New_York", "es-MX"], ["America/New_York", "es-MX"],
  ]);
});

const proxy = (host: string) => ({ type: "http" as const, host, port: "8080", user: "", pass: "" });

test("connection timezone lookup follows the current connection without a profile proxy", async () => {
  const calls: string[] = [];
  const timezone = await lookupExitTimezone(null, services({ geojs: { timezone: "Europe/Paris" } }, calls));
  expect(timezone).toBe("Europe/Paris");
  expect(calls).toEqual([`${GEOJS} via direct`, `${IP_API} via direct`]);
});

test("connection timezone lookup supports IPv6-only direct connections", async () => {
  const calls: string[] = [];
  const timezone = await lookupExitTimezone(null, services({ ipinfo: { timezone: "Europe/Berlin" } }, calls));
  expect(timezone).toBe("Europe/Berlin");
  expect(calls).toEqual([`${GEOJS} via direct`, `${IP_API} via direct`, `${IPINFO} via direct`]);
});

test("IPv6 fallback gets a fresh timeout after the IPv4 requests time out", async () => {
  let attempts = 0;
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() =>
    ++attempts <= 2 ? AbortSignal.abort(new DOMException("Timed out", "TimeoutError")) : new AbortController().signal,
  );
  try {
    const rows = { timezone: "Europe/Berlin" };
    const timezone = await lookupExitTimezone(null, services({ geojs: rows, ipApi: { status: "success", ...rows }, ipinfo: rows }));
    expect(timezone).toBe("Europe/Berlin");
    expect(attempts).toBe(3);
  } finally {
    timeout.mockRestore();
  }
});

test("attachTimezones preserves saved settings instead of guessing from a proxy gateway", async () => {
  const profiles = [
    { proxy: proxy("gate.example.net"), timezone: "America/Toronto" },
    { proxy: null, timezone: "Europe/Paris" },
  ];
  const calls: string[] = [];
  const { resolved } = await attachTimezones(profiles, async (url, init) => {
    calls.push(url);
    // A gateway lookup would return a valid but unrelated location.
    if (init.body) return { json: async () => [{ query: "gate.example.net", status: "success", timezone: "Asia/Tokyo" }] };
    throw new Error("exit lookup unavailable");
  });
  expect(resolved).toBe(0);
  expect(profiles.map((profile) => profile.timezone)).toEqual(["America/Toronto", "Europe/Paris"]);
  expect(calls).toEqual([GEOJS, IP_API, IPINFO]);
});

test("failed direct lookup reports no timezone", async () => {
  expect(await lookupExitTimezone(null, async () => { throw new Error("offline"); })).toBeNull();
});

test("attachTimezones prefers the timezone of the proxy's exit IP over its host", async () => {
  const profiles = [{ proxy: proxy("gate.example.net"), timezone: "" }];
  const calls: string[] = [];
  const { resolved } = await attachTimezones(profiles, services({ ipApi: { status: "success", timezone: "America/Toronto" } }, calls));
  expect(resolved).toBe(1);
  expect(profiles[0]!.timezone).toBe("America/Toronto");
  expect(calls).toHaveLength(2);
  for (const call of calls) expect(call).toMatch(/ via http:\/\/127\.0\.0\.1:\d+$/);
});

test("attachTimezones asks an IPv6 service when the IPv4-only exit lookups fail", async () => {
  const profiles = [{ proxy: proxy("gate.example.net"), timezone: "" }];
  const calls: string[] = [];
  const { resolved } = await attachTimezones(profiles, services({ ipinfo: { ip: "2001:db8::1", timezone: "Europe/Berlin" } }, calls));
  expect(resolved).toBe(1);
  expect(profiles[0]!.timezone).toBe("Europe/Berlin");
  expect(calls[2]).toStartWith(`${IPINFO} via `);
});

test("exit location carries the exit IP from the MaxMind, IPv4 and IPv6 services", async () => {
  for (const [rows, ip] of [
    [{ geojs: { ip: "203.0.113.8", timezone: "Europe/Berlin", country_code: "DE" } }, "203.0.113.8"],
    [{ ipApi: { status: "success", timezone: "Europe/Berlin", countryCode: "DE", query: "203.0.113.7" } }, "203.0.113.7"],
    [{ ipinfo: { ip: "2001:DB8:0:0::7", timezone: "Europe/Berlin", country: "DE" } }, "2001:db8::7"],
  ] as const) {
    expect(await lookupExitLocation(null, services(rows))).toEqual({ timezone: "Europe/Berlin", country: "DE", ip });
  }
  const unparsable = await lookupExitLocation(null, services({ ipApi: { status: "success", timezone: "Europe/Berlin", query: "gate" } }));
  expect(unparsable).toStrictEqual({ timezone: "Europe/Berlin", country: undefined });
});

test("proxy exit location is asked through the proxy and reused per proxy for a minute", async () => {
  let clock = 0;
  const calls: string[] = [];
  let lookups = 0;
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push(`${url} via ${(init as { proxy?: string }).proxy ?? "direct"}`);
    if (url !== GEOJS) throw new Error("unavailable");
    lookups++;
    return { json: async () => ({ timezone: `Etc/GMT-${lookups}`, country_code: "DE", ip: `203.0.113.${lookups}` }) };
  };
  const opts = { fetchFn, now: () => clock };
  const gateway = { ...proxy("reuse.example.net"), user: "session-a", pass: "p" };
  const first = { timezone: "Etc/GMT-1", country: "DE", ip: "203.0.113.1" };
  expect(await lookupProxyExitLocation(gateway, opts)).toEqual(first);
  expect(calls[0]).toMatch(/^https:\/\/get\.geojs\.io\/v1\/ip\/geo\.json via http:\/\/127\.0\.0\.1:\d+$/);
  clock = 59_000;
  // The reused answer carries the exit's timezone with its address.
  expect(await lookupProxyExitLocation({ ...gateway }, opts)).toEqual(first);
  // A changed login, such as a new sticky session, is another exit.
  expect(await lookupProxyExitLocation({ ...gateway, user: "session-b" }, opts))
    .toEqual({ timezone: "Etc/GMT-2", country: "DE", ip: "203.0.113.2" });
  clock = 60_000;
  expect((await lookupProxyExitLocation(gateway, opts))?.ip).toBe("203.0.113.3");
  expect(lookups).toBe(3);
});

test("a failed proxy exit lookup reports none for a minute and is then asked again", async () => {
  let clock = 0;
  let fail = true;
  let calls = 0;
  const answer = services({ ipApi: { status: "success", timezone: "Europe/Berlin", query: "203.0.113.9" } });
  const fetchFn = async (url: string, init: RequestInit) => {
    calls++;
    if (fail) throw new Error("proxy down");
    return answer(url, init);
  };
  const opts = { fetchFn, now: () => clock };
  const gateway = proxy("down.example.net");
  expect(await lookupProxyExitLocation(gateway, opts)).toBeNull();
  const failedCalls = calls;
  fail = false;
  clock = 59_000;
  // A dead lookup service does not make every open wait again.
  expect(await lookupProxyExitLocation(gateway, opts)).toBeNull();
  expect(calls).toBe(failedCalls);
  clock = 60_000;
  expect((await lookupProxyExitLocation(gateway, opts))?.ip).toBe("203.0.113.9");
});

test("a slow proxy exit lookup stops waiting and its late answer serves the next launch", async () => {
  let answer!: () => void;
  let calls = 0;
  const fetchFn = async (url: string) => {
    if (url !== GEOJS) throw new Error("unavailable");
    calls++;
    await new Promise<void>((resolve) => { answer = resolve; });
    return { json: async () => ({ timezone: "Europe/Berlin", ip: "203.0.113.10" }) };
  };
  const gateway = proxy("slow.example.net");
  expect(await lookupProxyExitLocation(gateway, { fetchFn, waitMs: 20 })).toBeNull();
  while (!calls) await Bun.sleep(1);
  answer();
  expect((await lookupProxyExitLocation(gateway, { fetchFn, waitMs: 1_000 }))?.ip).toBe("203.0.113.10");
  expect(calls).toBe(1);
});
