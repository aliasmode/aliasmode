import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installWebStoreExtension,
  parseWebStoreExtensionId,
  readManifestName,
} from "./extensions.ts";

function concat(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function storedZip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const entries: { name: Uint8Array; len: number; off: number }[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const encodedName = enc.encode(name);
    const data = enc.encode(content);
    const local = new Uint8Array(30 + encodedName.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, encodedName.length, true);
    local.set(encodedName, 30);
    entries.push({ name: encodedName, len: data.length, off: offset });
    chunks.push(local, data);
    offset += local.length + data.length;
  }
  const centralStart = offset;
  for (const entry of entries) {
    const central = new Uint8Array(46 + entry.name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint32(20, entry.len, true);
    centralView.setUint32(24, entry.len, true);
    centralView.setUint16(28, entry.name.length, true);
    centralView.setUint32(42, entry.off, true);
    central.set(entry.name, 46);
    chunks.push(central);
    offset += central.length;
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, offset - centralStart, true);
  endView.setUint32(16, centralStart, true);
  return concat(...chunks, end);
}

function extensionId(publicKey: Uint8Array): string {
  const digest = createHash("sha256").update(publicKey).digest();
  return [...digest.subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
}

const fixtureKeys = generateKeyPairSync("rsa", { modulusLength: 1024 });
const fixturePublicKey = new Uint8Array(
  fixtureKeys.publicKey.export({ format: "der", type: "spki" }),
);

function crx2(zip: Uint8Array): Uint8Array {
  const signature = new Uint8Array(sign("sha1", zip, fixtureKeys.privateKey));
  return concat(
    new TextEncoder().encode("Cr24"),
    uint32(2),
    uint32(fixturePublicKey.length),
    uint32(signature.length),
    fixturePublicKey,
    signature,
    zip,
  );
}

test("accepts extension IDs and official current or legacy Store URLs", () => {
  const id = "aapbdbdomjkkjkaonfhkkikfgjllcleb";
  expect(parseWebStoreExtensionId(id)).toBe(id);
  expect(parseWebStoreExtensionId(`https://chromewebstore.google.com/detail/google-translate/${id}?hl=en`)).toBe(id);
  expect(parseWebStoreExtensionId(`https://chrome.google.com/webstore/detail/google-translate/${id}`)).toBe(id);
});

test("rejects malformed IDs and non-Store hosts", () => {
  for (const source of [
    "not-an-extension",
    "https://example.com/detail/aapbdbdomjkkjkaonfhkkikfgjllcleb",
    "https://chromewebstore.google.com.evil.example/detail/x/aapbdbdomjkkjkaonfhkkikfgjllcleb",
    "http://chromewebstore.google.com/detail/x/aapbdbdomjkkjkaonfhkkikfgjllcleb",
  ]) expect(() => parseWebStoreExtensionId(source)).toThrow("Chrome Web Store");
});

test("downloads an official CRX, preserves its ID, and resolves its localized name", async () => {
  const id = extensionId(fixturePublicKey);
  const bytes = crx2(storedZip({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "__MSG_extensionName__", version: "1", default_locale: "en" }),
    "_locales/en/messages.json": JSON.stringify({ extensionName: { message: "Fixture Extension" } }),
  }));
  const root = mkdtempSync(join(tmpdir(), "aliasmode-extension-"));
  let requested = "";

  const installed = await installWebStoreExtension(id, root, async (input) => {
    requested = String(input);
    return new Response(bytes.buffer as ArrayBuffer, { status: 200 });
  });

  const url = new URL(requested);
  expect(url.origin + url.pathname).toBe("https://clients2.google.com/service/update2/crx");
  expect(url.searchParams.get("response")).toBe("redirect");
  expect(url.searchParams.get("acceptformat")).toBe("crx2,crx3");
  expect(url.searchParams.get("x")).toBe(`id=${id}&uc`);
  expect(installed).toMatchObject({ id, name: "Fixture Extension" });
  expect(JSON.parse(readFileSync(join(installed.loadDir, "manifest.json"), "utf8")).key)
    .toBe(Buffer.from(fixturePublicKey).toString("base64"));
});

test("rejects a downloaded CRX with a different identity and removes its files", async () => {
  const requestedId = "a".repeat(32);
  expect(requestedId).not.toBe(extensionId(fixturePublicKey));
  const bytes = crx2(storedZip({ "manifest.json": '{"manifest_version":3,"name":"Wrong","version":"1"}' }));
  const root = mkdtempSync(join(tmpdir(), "aliasmode-extension-"));

  await expect(installWebStoreExtension(requestedId, root, async () => new Response(bytes.buffer as ArrayBuffer)))
    .rejects.toThrow("does not match");
  expect(existsSync(join(root, requestedId))).toBe(false);
});

test("does not read localized names outside the extension directory", () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-extension-locale-"));
  const dir = join(root, "installed");
  mkdirSync(dir);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    name: "__MSG_extensionName__",
    default_locale: "../..",
  }));
  writeFileSync(join(root, "messages.json"), JSON.stringify({
    extensionName: { message: "Outside Name" },
  }));

  expect(readManifestName(dir, "Fallback Name")).toBe("Fallback Name");
});
