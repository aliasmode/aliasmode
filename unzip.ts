/**
 * Minimal, dependency-free ZIP (and Chrome .crx) extractor.
 *
 * Chrome extensions are uploaded as a .zip of the unpacked extension or a .crx
 * (a zip with a signing header). We extract to a directory and load it unpacked
 * with --load-extension. We parse the central directory (authoritative sizes +
 * offsets even when the local headers use streaming data descriptors) and
 * inflate entries with Node's built-in zlib — no external `unzip`.
 */

import { join, normalize } from "node:path";
import { inflateRawSync } from "node:zlib";

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** Strip a CRX (Cr24) wrapper if present, returning the inner ZIP bytes. */
function stripCrx(data: Uint8Array): Uint8Array {
  const isCrx = data.length >= 16 && data[0] === 0x43 && data[1] === 0x72 && data[2] === 0x32 && data[3] === 0x34; // "Cr24"
  if (!isCrx) return data;
  const version = u32(data, 4);
  if (version === 2) {
    const pubKeyLen = u32(data, 8);
    const sigLen = u32(data, 12);
    return data.subarray(16 + pubKeyLen + sigLen);
  }
  // CRX3: 12-byte fixed header (magic, version, headerLen) then the header.
  const headerLen = u32(data, 8);
  return data.subarray(12 + headerLen);
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(inflateRawSync(data));
}

/** True if a zip entry name would escape destDir (path traversal / absolute). */
function unsafe(name: string): boolean {
  if (name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:/.test(name)) return true;
  const norm = normalize(name);
  return norm.startsWith("..") || norm.includes(".." + "/") || norm.includes(".." + "\\");
}

/** Extract a ZIP/CRX to destDir. Returns the number of files written. */
export async function extractZipTo(input: Uint8Array, destDir: string): Promise<number> {
  const data = stripCrx(input);
  // Locate End Of Central Directory (scan back over the optional comment).
  let eocd = -1;
  const minStart = Math.max(0, data.length - 22 - 0xffff);
  for (let i = data.length - 22; i >= minStart; i--) {
    if (u32(data, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a valid zip/crx (no end-of-central-directory record)");

  const total = u16(data, eocd + 10);
  let p = u32(data, eocd + 16); // central directory offset
  let written = 0;
  for (let n = 0; n < total; n++) {
    if (u32(data, p) !== 0x02014b50) break; // central dir header signature
    const method = u16(data, p + 10);
    const compSize = u32(data, p + 20);
    const nameLen = u16(data, p + 28);
    const extraLen = u16(data, p + 30);
    const commentLen = u16(data, p + 32);
    const localOff = u32(data, p + 42);
    const name = new TextDecoder().decode(data.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (!name || name.endsWith("/")) continue; // directory entry
    if (unsafe(name)) continue;

    // Walk the local header to find where the data actually starts.
    const lNameLen = u16(data, localOff + 26);
    const lExtraLen = u16(data, localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const comp = data.subarray(start, start + compSize);
    const content = method === 0 ? comp : await inflateRaw(comp);
    await Bun.write(join(destDir, name), content);
    written++;
  }
  if (written === 0) throw new Error("archive contained no files");
  return written;
}
