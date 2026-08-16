import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractZipTo } from "./unzip.ts";

/** Build a minimal STORED (uncompressed) ZIP — enough to exercise the central-
 *  directory parser and path-safety without needing a deflate fixture. */
function storedZip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const entries: { name: Uint8Array; len: number; off: number }[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const n = enc.encode(name);
    const d = enc.encode(content);
    const lh = new Uint8Array(30 + n.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(8, 0, true); // method: stored
    dv.setUint32(18, d.length, true);
    dv.setUint32(22, d.length, true);
    dv.setUint16(26, n.length, true);
    lh.set(n, 30);
    entries.push({ name: n, len: d.length, off: offset });
    chunks.push(lh, d);
    offset += lh.length + d.length;
  }
  const cdStart = offset;
  for (const e of entries) {
    const ch = new Uint8Array(46 + e.name.length);
    const dv = new DataView(ch.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(10, 0, true);
    dv.setUint32(20, e.len, true);
    dv.setUint32(24, e.len, true);
    dv.setUint16(28, e.name.length, true);
    dv.setUint32(42, e.off, true);
    ch.set(e.name, 46);
    chunks.push(ch);
    offset += ch.length;
  }
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, entries.length, true);
  dv.setUint16(10, entries.length, true);
  dv.setUint32(12, offset - cdStart, true);
  dv.setUint32(16, cdStart, true);
  chunks.push(eocd);
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

test("extracts files (incl. nested) from a zip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-unzip-"));
  const n = await extractZipTo(storedZip({ "manifest.json": '{"name":"X"}', "js/bg.js": "hi" }), dir);
  expect(n).toBe(2);
  expect(readFileSync(join(dir, "manifest.json"), "utf8")).toBe('{"name":"X"}');
  expect(readFileSync(join(dir, "js/bg.js"), "utf8")).toBe("hi");
});

test("extracts raw-deflate entries without DecompressionStream", async () => {
  const zip = Buffer.from(
    "UEsDBBQAAAAIAJNrEF0kGtjVFAAAABIAAAAOAAAAY29tcHJlc3NlZC50eHRLzs8tKEotLk5NUShIrMzJT0wBAFBLAQIUAxQAAAAIAJNrEF0kGtjVFAAAABIAAAAOAAAAAAAAAAAAAACAAQAAAABjb21wcmVzc2VkLnR4dFBLBQYAAAAAAQABADwAAABAAAAAAAA=",
    "base64",
  );
  const dir = mkdtempSync(join(tmpdir(), "cp-unzip-"));
  expect(await extractZipTo(zip, dir)).toBe(1);
  expect(readFileSync(join(dir, "compressed.txt"), "utf8")).toBe("compressed payload");
});

test("refuses path-traversal entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-unzip-"));
  await extractZipTo(storedZip({ "../evil.txt": "x", "ok.txt": "y" }), dir);
  expect(existsSync(join(dir, "ok.txt"))).toBe(true);
  expect(existsSync(join(dir, "..", "evil.txt"))).toBe(false);
});

test("rejects non-zip input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-unzip-"));
  await expect(extractZipTo(new TextEncoder().encode("not a zip at all"), dir)).rejects.toThrow();
});
