import { test, expect } from "bun:test";
import {
  parseBlock,
  splitRecords,
  normalizeCookies,
  parseProxy,
  parseStrictProxy,
  parseStrictResolution,
  recordToProfile,
  parseExport,
  decodeText,
  parseUpdateFile,
  serializeAdsTxt,
  serializeCsv,
} from "./parse.ts";

const SAMPLE = `acc_id=476436
id=k1d0cd11
group=919_2011hotmail_28.05.26
name=sophiaskye852
remark=
tags=
platform=
username=
password=secretpw
fakey=ABCD1234
cookie=[{"name":"auth_token","value":"v1","domain":".x.com","path":"/","httpOnly":true,"secure":true,"sameSite":"no_restriction","session":false,"expires":1788000000},{"name":"ext","value":"x","domain":"browserext.adspower.net","path":"/","session":true}]
proxytype=http
proxy=5.249.176.244:5432:user1:pass1
ua=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36
resolution=1680*1050
******************
acc_id=476433
id=k1d0ccwr
group=919_2011hotmail_28.05.26
name=sofi_z31
password=pw2
fakey=
cookie=[]
proxytype=http
proxy=37.19.65.146:5432:z0zt7:k9i76bob
ua=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36
resolution=1920*1080
******************`;

test("parseBlock splits key=value and keeps '=' in values", () => {
  const m = parseBlock("id=abc\ncookie=[{\"a\":\"b=c\"}]\nempty=");
  expect(m.id).toBe("abc");
  expect(m.cookie).toBe('[{"a":"b=c"}]');
  expect(m.empty).toBe("");
});

test("splitRecords drops blocks without an id", () => {
  const recs = splitRecords(SAMPLE);
  expect(recs.length).toBe(2);
  expect(recs[0]!.id).toBe("k1d0cd11");
  expect(recs[1]!.id).toBe("k1d0ccwr");
});

test("normalizeCookies strips AdsPower extension cookies and normalizes sameSite", () => {
  const { cookies, stripped } = normalizeCookies([
    { name: "auth_token", value: "v", domain: ".x.com", path: "/", sameSite: "no_restriction", secure: false, session: false, expires: 1788000000 },
    { name: "ext", value: "x", domain: "browserext.adspower.net", path: "/", session: true },
    { name: "bad" }, // no domain → dropped
  ]);
  expect(stripped).toBe(1);
  expect(cookies.length).toBe(1);
  const c = cookies[0]!;
  expect(c.name).toBe("auth_token");
  // no_restriction → None, and None forces secure=true
  expect(c.sameSite).toBe("None");
  expect(c.secure).toBe(true);
  expect(c.expires).toBe(1788000000);
});

test("normalizeCookies drops sameSite for unspecified and omits expiry for session cookies", () => {
  const { cookies } = normalizeCookies([
    { name: "a", value: "1", domain: ".x.com", path: "/", sameSite: "unspecified", session: true, expires: 123 },
    { name: "b", value: "2", domain: ".x.com", path: "/", sameSite: "lax", session: false, expires: 999 },
  ]);
  expect(cookies[0]!.sameSite).toBeUndefined();
  expect(cookies[0]!.expires).toBeUndefined(); // session cookie → no expiry
  expect(cookies[1]!.sameSite).toBe("Lax");
  expect(cookies[1]!.expires).toBe(999);
});

test("normalizeCookies preserves valid partition metadata and omits wrong types", () => {
  const { cookies } = normalizeCookies([
    { name: "valid", value: "1", domain: ".x.com", partitionKey: "https://x.com", _crHasCrossSiteAncestor: false },
    { name: "invalid", value: "2", domain: ".x.com", partitionKey: true, _crHasCrossSiteAncestor: "false" },
  ]);
  expect(cookies[0]).toMatchObject({ partitionKey: "https://x.com", _crHasCrossSiteAncestor: false });
  expect(cookies[1]!.partitionKey).toBeUndefined();
  expect(cookies[1]!._crHasCrossSiteAncestor).toBeUndefined();
});

test("parseProxy handles host:port:user:pass and blanks", () => {
  expect(parseProxy("http", "1.2.3.4:8080:u:p")).toEqual({ type: "http", host: "1.2.3.4", port: "8080", user: "u", pass: "p" });
  expect(parseProxy("http", "1.2.3.4:8080")).toEqual({ type: "http", host: "1.2.3.4", port: "8080", user: "", pass: "" });
  expect(parseProxy("http", "")).toBeNull();
  expect(parseProxy("http", "   ")).toBeNull();
});

test("parseProxy canonicalizes SOCKS types and honors an explicit URL scheme", () => {
  expect(parseProxy("SOCKS5", "proxy.example:1080:u:p")).toEqual({
    type: "socks5", host: "proxy.example", port: "1080", user: "u", pass: "p",
  });
  expect(parseProxy("http", "socks5://u:p@proxy.example:1080")).toEqual({
    type: "socks5", host: "proxy.example", port: "1080", user: "u", pass: "p",
  });
  expect(() => parseProxy("ftp", "proxy.example:21:u:p")).toThrow("unsupported proxy type");
});

test("strict proxy validation preserves canonical HTTPS, SOCKS5, IPv6, and URL forms", () => {
  expect(parseStrictProxy("https", "proxy.example:8443:u:p")?.type).toBe("https");
  expect(parseStrictProxy("socks5", "[2001:db8::1]:1080:u:p")).toMatchObject({
    type: "socks5", host: "2001:db8::1", port: "1080",
  });
  expect(parseStrictProxy("http", "socks5://u:p@proxy.example:1080")?.type).toBe("socks5");
  expect(parseStrictProxy("http", "")).toBeNull();
  expect(() => parseStrictProxy("gopher", "proxy.example:70")).toThrow("unsupported proxy type");
  expect(() => parseStrictProxy("http", "bad host:8080")).toThrow("whitespace");
});

test("strict proxy validation rejects an unsupported supplied type even with a blank endpoint", () => {
  expect(() => parseStrictProxy("socks4", "")).toThrow("unsupported proxy type");
  expect(parseStrictProxy("socks5", "")).toBeNull();
});

test("strict resolution validation accepts realistic screens and rejects defaults from malformed input", () => {
  expect(parseStrictResolution("1366x768")).toEqual({ width: 1366, height: 768 });
  expect(parseStrictResolution("1680*1050")).toEqual({ width: 1680, height: 1050 });
  for (const invalid of ["", "0x0", "319x1080", "1920x199", "99999x1080", "1920xnope"]) {
    expect(() => parseStrictResolution(invalid)).toThrow("invalid resolution");
  }
});

test("parsed imports retain exact field presence and validation failures", () => {
  const sparse = parseExport("id=safe-id\nname=renamed\n******************").imports[0]!;
  expect(sparse.presentFields).toEqual(["id", "name"]);
  expect(sparse.sourceFields).toEqual({ id: "safe-id", name: "renamed" });
  expect(sparse.validationErrors).toEqual([]);

  const invalid = parseExport("id=../unsafe\nresolution=0x0\n******************").imports[0]!;
  expect(invalid.validationErrors.some((error) => error.includes("invalid profile id"))).toBe(true);
  expect(invalid.validationErrors.some((error) => error.includes("invalid resolution"))).toBe(true);
});

test("decodeText handles UTF-8, UTF-8 BOM, and UTF-16 LE/BE (BOM and bare)", () => {
  const s = "id=k1d0cd11\nua=Mozilla\nresolution=1680*1050";
  const u8 = (b: Buffer | Uint8Array) => new Uint8Array(b);

  expect(decodeText(u8(Buffer.from(s, "utf8")))).toBe(s);
  expect(decodeText(u8(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, "utf8")])))).toBe(s);
  // UTF-16LE with BOM
  expect(decodeText(u8(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")])))).toBe(s);
  // UTF-16LE without BOM (Windows exports often look like this)
  expect(decodeText(u8(Buffer.from(s, "utf16le")))).toBe(s);
  // UTF-16BE with BOM
  const beBody = Buffer.from(s, "utf16le").swap16();
  expect(decodeText(u8(Buffer.concat([Buffer.from([0xfe, 0xff]), beBody])))).toBe(s);
});

test("a UTF-16-encoded export still imports (regression: Windows AdsPower export)", () => {
  const utf16 = new Uint8Array(Buffer.from(SAMPLE, "utf16le")); // no BOM
  const summary = parseExport(decodeText(utf16));
  expect(summary.profiles.map((p) => p.id)).toEqual(["k1d0cd11", "k1d0ccwr"]);
});

test("parseProxy preserves passwords containing colons", () => {
  expect(parseProxy("http", "host:8080:user:pa:ss:word")).toEqual({
    type: "http",
    host: "host",
    port: "8080",
    user: "user",
    pass: "pa:ss:word",
  });
});

test("recordToProfile maps all fields and derives a deterministic seed", () => {
  const rec = splitRecords(SAMPLE)[0]!;
  const out = recordToProfile(rec)!;
  const p = out.profile;
  expect(p.id).toBe("k1d0cd11");
  expect(p.name).toBe("sophiaskye852");
  expect(p.twofa).toBe("ABCD1234");
  expect(p.password).toBe("secretpw");
  expect(p.proxy).toEqual({ type: "http", host: "5.249.176.244", port: "5432", user: "user1", pass: "pass1" });
  expect(p.screenWidth).toBe(1680);
  expect(p.screenHeight).toBe(1050);
  expect(p.fingerprintSeed).toBeGreaterThan(0);
  expect(p.cookies.length).toBe(1); // ext cookie stripped
  expect(out.cookiesStripped).toBe(1);
  expect(p.seeded).toBe(false);
});

test("parseExport summarizes the whole file", () => {
  const summary = parseExport(SAMPLE);
  expect(summary.recordCount).toBe(2);
  expect(summary.profiles.length).toBe(2);
  expect(summary.cookiesStripped).toBe(1);
  expect(summary.skipped).toBe(0);
});

test("parseExport tolerates blank/garbage trailing blocks", () => {
  const summary = parseExport(SAMPLE + "\n\n******************\n\n");
  expect(summary.profiles.length).toBe(2);
});

test("parseExport quarantines one malformed proxy without aborting valid profiles", () => {
  const text = [
    "id=badproxy\nname=bad\nproxytype=socks4\nproxy=proxy.example:1080:u:p",
    "id=goodproxy\nname=good\nproxytype=socks5\nproxy=proxy.example:1080:u:p",
  ].join("\n******************\n");
  const summary = parseExport(text);
  expect(summary.profiles.map((profile) => profile.id)).toEqual(["badproxy", "goodproxy"]);
  expect(summary.profiles[0]!.proxy).toBeNull();
  expect(summary.profiles[0]!.proxyError).toContain("unsupported proxy type");
  expect(summary.skipped).toBe(0);
  expect(summary.errors).toEqual([{
    id: "badproxy",
    error: expect.stringContaining("unsupported proxy type"),
    quarantined: true,
  }]);
});

test("recordToProfile requires only an id; missing columns fall back to defaults", () => {
  // AdsPower exports vary in which columns are included — a record without
  // ua/resolution is still valid and must import (defaults applied).
  const sparse = recordToProfile({ id: "k1d0cd11", name: "acct", group: "g", proxytype: "http" });
  expect(sparse).not.toBeNull();
  expect(sparse!.profile.id).toBe("k1d0cd11");
  expect(sparse!.profile.ua).toBe("");
  expect(sparse!.profile.screenWidth).toBe(1920); // default resolution
  expect(sparse!.profile.screenHeight).toBe(1080);
  // Only a missing id is rejected.
  expect(recordToProfile({ name: "noid", ua: "Mozilla" })).toBeNull();
});

test("recordToProfile preserves legacy email-as-login imports while storing email separately", () => {
  const parsed = recordToProfile({ id: "legacy-email", email: "account@example.com" })!.profile;
  expect(parsed.username).toBe("account@example.com");
  expect(parsed.email).toBe("account@example.com");
});

test("parseExport imports records regardless of column set, skipping only id-less blocks", () => {
  const extra = SAMPLE + "\nacc_id=999\nid=k1extra\nname=morefields\nproxytype=http\nproxy=9.9.9.9:1:u:p\ncustom_field=x";
  const summary = parseExport(extra);
  expect(summary.profiles.map((p) => p.id)).toEqual(["k1d0cd11", "k1d0ccwr", "k1extra"]);
  expect(summary.skipped).toBe(0);
});

test("parseUpdateFile treats missing trailing CSV cells as omitted, not blank clears", () => {
  const summary = parseUpdateFile([
    "id,name,proxy,proxytype,resolution",
    "safe-id,renamed",
    "safe-id-2,renamed,,http,",
  ].join("\n"));

  expect(summary.updates[0]).toEqual({ id: "safe-id", set: { name: "renamed" } });
  expect(summary.updates[1]).toEqual({
    id: "safe-id-2",
    set: { name: "renamed", proxy: "", proxyType: "http", resolution: "" },
  });
});

test("TXT and CSV exports preserve a bracketed IPv6 proxy", () => {
  const profile = parseExport(SAMPLE).profiles[0]!;
  profile.proxy = { type: "socks5", host: "2001:db8::1", port: "1080", user: "user", pass: "p:ss" };

  expect(parseExport(serializeAdsTxt([profile])).profiles[0]!.proxy).toEqual(profile.proxy);
  const update = parseUpdateFile(serializeCsv([profile])).updates[0]!;
  expect(update.set.proxy).toBe("[2001:db8::1]:1080:user:p:ss");
  expect(parseStrictProxy(update.set.proxyType, update.set.proxy)).toEqual(profile.proxy);
});
