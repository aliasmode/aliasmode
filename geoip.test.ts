import { test, expect } from "bun:test";
import { lookupTimezones, attachTimezones } from "./geoip.ts";

function fakeFetch(byIp: Record<string, string>) {
  return async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Array<{ query: string }>;
    return {
      json: async () =>
        body.map(({ query }) =>
          byIp[query]
            ? { query, status: "success", timezone: byIp[query] }
            : { query, status: "fail" },
        ),
    };
  };
}

test("lookupTimezones maps resolved IPs and skips failures", async () => {
  const tz = await lookupTimezones(
    ["1.2.3.4", "5.6.7.8", "9.9.9.9"],
    fakeFetch({ "1.2.3.4": "America/New_York", "5.6.7.8": "Europe/London" }),
  );
  expect(tz.get("1.2.3.4")).toBe("America/New_York");
  expect(tz.get("5.6.7.8")).toBe("Europe/London");
  expect(tz.has("9.9.9.9")).toBe(false);
});

test("lookupTimezones returns empty when the lookup throws (offline)", async () => {
  const tz = await lookupTimezones(["1.2.3.4"], async () => {
    throw new Error("network down");
  });
  expect(tz.size).toBe(0);
});

test("attachTimezones sets timezone from each profile's proxy host", async () => {
  const profiles = [
    { proxy: { host: "1.2.3.4" }, timezone: "" },
    { proxy: { host: "5.6.7.8" }, timezone: "" },
    { proxy: null, timezone: "" },
  ];
  const { resolved } = await attachTimezones(profiles, fakeFetch({ "1.2.3.4": "America/New_York", "5.6.7.8": "Europe/London" }));
  expect(resolved).toBe(2);
  expect(profiles[0]!.timezone).toBe("America/New_York");
  expect(profiles[1]!.timezone).toBe("Europe/London");
  expect(profiles[2]!.timezone).toBe(""); // no proxy → unchanged
});
