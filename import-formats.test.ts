import { expect, test } from "bun:test";
import { parseImportFile } from "./import-formats.ts";
import { isSafeProfileId } from "./profile-id.ts";
import { writeXlsx } from "./xlsx.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

const COOKIE = [{
  name: "auth_token",
  value: "cookie-value",
  domain: ".x.com",
  path: "/",
  expirationDate: 4_070_908_800,
  http_only: true,
  same_site: "no_restriction",
}];

test("provider parser keeps AdsPower key/value exports compatible", async () => {
  const summary = await parseImportFile("accounts.txt", bytes(
    "id=adspower1\nname=AdsPower\ncookie=[]\nproxytype=http\nproxy=\n******************\n",
  ));

  expect(summary.profiles).toHaveLength(1);
  expect(summary.profiles[0]).toMatchObject({ id: "adspower1", name: "AdsPower" });
});

test("provider parser maps GoLogin-style nested JSON", async () => {
  const summary = await parseImportFile("gologin.json", bytes(JSON.stringify({ profiles: [{
    _id: "gologin-1",
    name: "GoLogin profile",
    folder: "Sales",
    credentials: { login: "account-user", password: "account-pass" },
    proxy: { mode: "http", host: "1.2.3.4", port: 8080, username: "proxy-user", password: "proxy-pass" },
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/143.0.0.0", resolution: "1600x900", platform: "Win32" },
    timezone: { timezone: "Europe/Paris" },
    cookies: COOKIE,
  }] })));

  expect(summary.profiles[0]).toMatchObject({
    id: "gologin-1",
    name: "GoLogin profile",
    group: "Sales",
    username: "account-user",
    password: "account-pass",
    platformOs: "windows",
    timezone: "Europe/Paris",
    screenWidth: 1600,
    screenHeight: 900,
    proxy: { type: "http", host: "1.2.3.4", port: "8080", user: "proxy-user", pass: "proxy-pass" },
  });
  expect(summary.profiles[0]!.cookies[0]).toMatchObject({
    name: "auth_token",
    expires: 4_070_908_800,
    httpOnly: true,
    sameSite: "None",
    secure: true,
  });
});

test("provider parser handles quoted multiline CSV and Base64 cookies", async () => {
  const encodedCookies = Buffer.from(JSON.stringify(COOKIE)).toString("base64");
  const csv = [
    "Profile ID,External ID,Profile Name,Proxy Host,Proxy Port,Proxy Username,Proxy Password,Proxy Type,Cookies,Notes",
    `inc profile/1,account-42,"Incog, One",5.6.7.8,9000,px-user,px-pass,socks5,${encodedCookies},"line one\nline two"`,
  ].join("\n");
  const summary = await parseImportFile("incogniton.csv", bytes(csv));
  const profile = summary.profiles[0]!;

  expect(isSafeProfileId(profile.id)).toBe(true);
  expect(profile.id).not.toBe("inc profile/1");
  expect(profile.accId).toBe("inc profile/1");
  expect(profile.name).toBe("Incog, One");
  expect(profile.proxy).toMatchObject({ type: "socks5", host: "5.6.7.8", port: "9000" });
  expect(profile.cookies[0]!.value).toBe("cookie-value");
  const repeated = await parseImportFile("renamed-incogniton.csv", bytes(csv));
  expect(repeated.profiles[0]!.id).toBe(profile.id);
});

test("provider parser reads Dolphin Anty and HideMyAcc spreadsheet columns", async () => {
  const workbook = await writeXlsx(
    ["Profile ID", "Profile Name", "Folder Name", "Proxy", "User Agent", "Screen", "Cookies", "Operating System", "Tags"],
    [["dolphin1", "Dolphin", "Warmup", "http://user:pass@10.0.0.1:3128", "Mozilla/5.0 (Macintosh)", "1440*900", JSON.stringify(COOKIE), "Mac OS X", "one,two"]],
  );
  const summary = await parseImportFile("profiles.xlsx", workbook);

  expect(summary.profiles[0]).toMatchObject({
    id: "dolphin1",
    name: "Dolphin",
    group: "Warmup",
    platformOs: "macos",
    tags: ["one", "two"],
    proxy: { type: "http", host: "10.0.0.1", port: "3128", user: "user", pass: "pass" },
  });
});

test("provider parser accepts readable Multilogin and Donut-style wrappers", async () => {
  const summary = await parseImportFile("profiles.json", bytes(JSON.stringify({ data: { profiles: [
    {
      profileId: "multilogin1",
      profileName: "Multilogin",
      folderName: "Team A",
      parameters: { proxy: { type: "https", host: "proxy.example", port: 8443 } },
      fingerprint: { navigator: { userAgent: "UA one", resolution: "1366x768", platform: "Linux x86_64" } },
    },
    {
      browserProfileId: "donut1",
      browserName: "Donut",
      proxyUrl: "socks5://proxy.example:1080",
      osType: "Windows 10",
    },
  ] } })));

  expect(summary.profiles.map((profile) => profile.id)).toEqual(["multilogin1", "donut1"]);
  expect(summary.profiles[0]).toMatchObject({
    group: "Team A",
    platformOs: "linux",
    screenWidth: 1366,
    screenHeight: 768,
    proxy: { type: "https", host: "proxy.example", port: "8443" },
  });
  expect(summary.profiles[1]).toMatchObject({
    name: "Donut",
    platformOs: "windows",
    proxy: { type: "socks5", host: "proxy.example", port: "1080" },
  });
});

test("provider parser detects semicolon, tab, and legacy positional rows", async () => {
  const semicolon = await parseImportFile("hide-my-acc.csv", bytes(
    "Profile Name;Profile ID;Proxy;Proxy Username;Proxy Password\nHideMyAcc;hide1;1.2.3.4:8080;proxy-user;proxy-pass\n",
  ));
  const tab = await parseImportFile("profiles.tsv", bytes(
    "Profile Name\tProfile ID\tProxy\nTabbed\ttab1\t1.2.3.5:8081\n",
  ));
  const positional = await parseImportFile("legacy.csv", bytes(
    "Legacy,1.2.3.6:8082,account-user,account-pass,JBSWY3DPEHPK3PXP\n",
  ));

  expect(semicolon.profiles[0]).toMatchObject({
    id: "hide1",
    name: "HideMyAcc",
    proxy: { user: "proxy-user", pass: "proxy-pass" },
  });
  expect(tab.profiles[0]).toMatchObject({ id: "tab1", name: "Tabbed" });
  expect(positional.profiles[0]).toMatchObject({
    name: "Legacy",
    username: "account-user",
    password: "account-pass",
    twofa: "JBSWY3DPEHPK3PXP",
  });
  expect(isSafeProfileId(positional.profiles[0]!.id)).toBe(true);
});

test("provider parser rejects blank, unrelated, and proprietary archive inputs", async () => {
  await expect(parseImportFile("blank.csv", bytes(" \r\n"))).rejects.toThrow("empty");
  await expect(parseImportFile("settings.json", bytes('{"theme":"dark"}'))).rejects.toThrow("profile id or name");
  await expect(parseImportFile("cookies.json", bytes(JSON.stringify(COOKIE)))).rejects.toThrow("profile id or name");
  await expect(parseImportFile("encrypted.zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).rejects.toThrow(
    "encrypted or proprietary",
  );
});
