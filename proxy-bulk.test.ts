import { expect, test } from "bun:test";
import { proxyIdentityKey } from "./proxy.ts";
import { buildProxyPreview, checkProfileProxies, selectProxyProfiles, type ProxyInventoryProfile } from "./proxy-bulk.ts";
import type { ProxyProgressEvent } from "./proxy-tools-types.ts";

const proxy = { type: "http" as const, host: "proxy.example", port: "8080", user: "account", pass: "private-value" };
function profile(id: string, group = "one", overrides: Partial<ProxyInventoryProfile> = {}): ProxyInventoryProfile {
  return { id, name: id, group, permission: "edit", running: false, proxy: { ...proxy }, ...overrides };
}

test("proxy identity canonicalizes endpoints but preserves credential distinctions", () => {
  expect(proxyIdentityKey(proxy)).toBe(proxyIdentityKey({ ...proxy, host: "PROXY.EXAMPLE", port: "08080" }));
  expect(proxyIdentityKey({ ...proxy, user: "other" })).not.toBe(proxyIdentityKey(proxy));
  expect(proxyIdentityKey({ ...proxy, pass: "other" })).not.toBe(proxyIdentityKey(proxy));
  expect(proxyIdentityKey({ ...proxy, type: "https" })).not.toBe(proxyIdentityKey(proxy));
  expect(proxyIdentityKey({ ...proxy, host: "[2001:0db8::1]" })).toBe(proxyIdentityKey({ ...proxy, host: "2001:db8::1" }));
  expect(proxyIdentityKey({ ...proxy, user: "a|b", pass: "c" })).not.toBe(proxyIdentityKey({ ...proxy, user: "a", pass: "b|c" }));
});

test("folder selection covers the full inventory and retry IDs intersect its scope", () => {
  const profiles = Array.from({ length: 8000 }, (_, index) => profile(`p${index}`, `folder${index % 9}`));
  expect(selectProxyProfiles(profiles, { all: true })).toHaveLength(8000);
  const selected = selectProxyProfiles(profiles, { groups: ["folder1", "folder8"] });
  expect(selected).toHaveLength(profiles.filter((p) => ["folder1", "folder8"].includes(p.group)).length);
  expect(selectProxyProfiles(profiles, { groups: ["folder1"], ids: ["p1", "p8"] }).map((p) => p.id)).toEqual(["p1"]);
  expect(selectProxyProfiles(profiles, { groups: [] })).toEqual([]);
});

test("8,000 profiles across nine folders check each unique proxy once with four workers", async () => {
  const profiles = Array.from({ length: 8000 }, (_, index) => profile(`p${index}`, `folder${index % 9}`, {
    proxy: { ...proxy, user: `user${index % 80}` },
  }));
  const events: ProxyProgressEvent[] = [];
  let calls = 0, directCalls = 0, active = 0, peak = 0;
  await checkProfileProxies(profiles, (event) => events.push(event), () => false, {
    direct: async () => { directCalls++; return null; },
    check: async (_proxy, options) => {
      expect(options.direct).toBeNull();
      calls++; active++; peak = Math.max(peak, active);
      await Bun.sleep(1); active--;
      return { status: "working", attempts: 3, successes: 3, ip: "203.0.113.8" };
    },
  });
  expect(calls).toBe(80);
  expect(directCalls).toBe(1);
  expect(peak).toBe(4);
  expect(events).toContainEqual({ type: "summary", selectedProfiles: 8000, uniqueProxies: 80, duplicatesSkipped: 7920 });
  const results = events.filter((e) => e.type === "check");
  expect(results).toHaveLength(80);
  expect(results.flatMap((e) => e.row.profiles)).toHaveLength(8000);
  expect(JSON.stringify(events)).not.toContain("private-value");
  expect(JSON.stringify(events)).not.toContain('"user":');
});

test("missing, invalid and unsupported proxies are not reported dead", async () => {
  const events: ProxyProgressEvent[] = [];
  await checkProfileProxies([
    profile("missing", "one", { proxy: null }),
    profile("invalid", "one", { proxy: null, proxyError: "old invalid value" }),
    profile("https", "one", { proxy: { ...proxy, type: "https" } }),
  ], (e) => events.push(e), () => false, {
    direct: async () => { throw new Error("not needed"); },
    check: async () => { throw new Error("must not check"); },
  });
  expect(events.filter((e) => e.type === "check").map((e) => e.row.status)).toEqual(["missing", "invalid", "unsupported"]);
});

test("lookup failures remain unknown and cancellation stops scheduling", async () => {
  let cancelled = false, calls = 0;
  const events: ProxyProgressEvent[] = [];
  await checkProfileProxies(Array.from({ length: 20 }, (_, i) => profile(String(i), "one", { proxy: { ...proxy, user: String(i) } })),
    (e) => events.push(e), () => cancelled, {
      direct: async () => null,
      check: async () => { calls++; cancelled = true; return { status: "unavailable", reason: "check_unavailable", attempts: 3, successes: 0 }; },
    });
  expect(calls).toBeLessThanOrEqual(4);
  expect(events.filter((e) => e.type === "check").every((e) => e.row.status === "unavailable")).toBe(true);
});

test("profile replacement preview is read-only and rejects duplicate targets", () => {
  const profiles = [profile("a"), profile("b", "one", { running: true }), profile("c", "one", { permission: "view" })];
  const before = JSON.stringify(profiles);
  const result = buildProxyPreview(profiles, {
    scope: { all: true }, mode: "profileId",
    input: "profileId,type,host,port,user,pass\na,http,new.example,9000,u,p\na,http,other.example,9000,u,p\nb,http,new.example,9000,u,p\nc,http,new.example,9000,u,p\nx,http,new.example,9000,u,p",
  });
  expect(result.rows.map((r) => r.view.code)).toEqual(["duplicate_target", "duplicate_target", "profile_open", "no_editable_match", "no_editable_match"]);
  expect(JSON.stringify(profiles)).toBe(before);
});

test("old proxy mappings match credentials and only selected folders", () => {
  const result = buildProxyPreview([
    profile("a"), profile("b", "two"), profile("c", "one", { proxy: { ...proxy, user: "different" } }),
  ], {
    scope: { groups: ["one"] }, mode: "oldProxy",
    input: "oldProxy,newProxy\nhttp://account:private-value@proxy.example:8080,http://u:p@new.example:9000",
  });
  expect(result.rows.map((r) => r.view.profileId)).toEqual(["a"]);
  expect(result.rows[0]!.view.status).toBe("ready");
  expect(JSON.stringify(result.rows.map((r) => r.view))).not.toContain("private-value");
});

test("list assignment is stable, reports unmatched rows, and never reuses a proxy", () => {
  const result = buildProxyPreview([profile("c"), profile("a"), profile("b")], {
    scope: { all: true }, mode: "list", input: "one.example:8000\ntwo.example:8000",
  });
  expect(result.rows.map((r) => r.view.profileId)).toEqual(["a", "b", "c"]);
  expect(result.rows.map((r) => r.view.status)).toEqual(["ready", "ready", "skipped"]);
  expect(result.rows[2]!.view.code).toBe("no_replacement");
  expect(buildProxyPreview([profile("a")], { scope: { all: true }, mode: "list", input: "a.example:80\nb.example:80" }).unusedProxies).toBe(1);
});

test("invalid input errors do not expose pasted credentials", () => {
  expect(() => buildProxyPreview([profile("a")], { scope: { all: true }, mode: "list", input: "bad://sensitive-user:sensitive-pass@host:90" })).toThrow("Invalid proxy input");
});
