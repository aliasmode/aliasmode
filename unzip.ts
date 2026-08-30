/**
 * Minimal, dependency-free ZIP (and Chrome .crx) extractor.
 *
 * Chrome extensions are uploaded as a .zip of the unpacked extension or a .crx
 * (a zip with a signing header). We extract to a directory and load it unpacked
 * with --load-extension. We parse the central directory (authoritative sizes +
 * offsets even when the local headers use streaming data descriptors) and
 * inflate entries with Node's built-in zlib — no external `unzip`.
 */

import { createHash } from "node:crypto";
import { join, normalize } from "node:path";
import { inflateRawSync } from "node:zlib";

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

export interface ParsedArchive {
  zip: Uint8Array;
  crxVersion?: 2 | 3;
  publicKey?: Uint8Array;
  extensionId?: string;
  manifestKey?: string;
}

function extensionId(publicKey: Uint8Array): string {
  const digest = createHash("sha256").update(publicKey).digest();
  return [...digest.subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
}

function readVarint(data: Uint8Array, position: { value: number }): number {
  let value = 0;
  let scale = 1;
  for (;;) {
    if (position.value >= data.length) throw new Error("truncated protobuf varint");
    const byte = data[position.value++]!;
    value += (byte & 0x7f) * scale;
    if (!Number.isSafeInteger(value)) throw new Error("protobuf varint is too large");
    if ((byte & 0x80) === 0) return value;
    scale *= 128;
    if (!Number.isSafeInteger(scale)) throw new Error("protobuf varint is too large");
  }
}

function lengthDelimitedFields(data: Uint8Array): Array<{ number: number; bytes: Uint8Array }> {
  const fields: Array<{ number: number; bytes: Uint8Array }> = [];
  const position = { value: 0 };
  while (position.value < data.length) {
    const tag = readVarint(data, position);
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number === 0 || wire !== 2) throw new Error("unsupported CRX3 protobuf field");
    const length = readVarint(data, position);
    const end = position.value + length;
    if (!Number.isSafeInteger(end) || end > data.length) throw new Error("truncated CRX3 protobuf field");
    fields.push({ number, bytes: data.subarray(position.value, end) });
    position.value = end;
  }
  return fields;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Parse a ZIP or signed Chrome extension archive without inflating its payload. */
export function parseArchive(input: Uint8Array): ParsedArchive {
  const isCrx = input.length >= 4 && input[0] === 0x43 && input[1] === 0x72 && input[2] === 0x32 && input[3] === 0x34; // "Cr24"
  if (!isCrx) return { zip: input };
  if (input.length < 8) throw new Error("truncated CRX header");

  const version = u32(input, 4);
  if (version === 2) {
    if (input.length < 16) throw new Error("truncated CRX2 header");
    const publicKeyLength = u32(input, 8);
    const signatureLength = u32(input, 12);
    const keyEnd = 16 + publicKeyLength;
    const zipOffset = keyEnd + signatureLength;
    if (publicKeyLength === 0 || keyEnd > input.length || zipOffset > input.length) {
      throw new Error("truncated CRX2 header");
    }
    const publicKey = input.subarray(16, keyEnd);
    return {
      zip: input.subarray(zipOffset),
      crxVersion: 2,
      publicKey,
      extensionId: extensionId(publicKey),
      manifestKey: Buffer.from(publicKey).toString("base64"),
    };
  }

  if (version === 3) {
    if (input.length < 12) throw new Error("truncated CRX3 header");
    const headerLength = u32(input, 8);
    const zipOffset = 12 + headerLength;
    if (zipOffset > input.length) throw new Error("truncated CRX3 header");

    const header = lengthDelimitedFields(input.subarray(12, zipOffset));
    const signedData = header.find((field) => field.number === 10000)?.bytes;
    if (!signedData) throw new Error("CRX3 has no signed extension id");
    const crxId = lengthDelimitedFields(signedData).find((field) => field.number === 1)?.bytes;
    if (!crxId || crxId.length !== 16) throw new Error("CRX3 has an invalid signed extension id");

    const publicKeys = header
      .filter((field) => field.number === 2 || field.number === 3)
      .map((field) => lengthDelimitedFields(field.bytes).find((proofField) => proofField.number === 1)?.bytes)
      .filter((key): key is Uint8Array => !!key);
    const publicKey = publicKeys.find((key) => sameBytes(createHash("sha256").update(key).digest().subarray(0, 16), crxId));
    if (!publicKey) throw new Error("CRX3 has no public key matching its signed extension id");

    return {
      zip: input.subarray(zipOffset),
      crxVersion: 3,
      publicKey,
      extensionId: extensionId(publicKey),
      manifestKey: Buffer.from(publicKey).toString("base64"),
    };
  }

  throw new Error(`unsupported CRX version ${version}`);
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

export interface ZipEntry {
  /** Entry path as stored in the archive (never a directory, never unsafe). */
  name: string;
  /** Decompress this entry's bytes. Deferred so a caller can skip entries cheaply. */
  bytes(): Promise<Uint8Array>;
}

/**
 * Walk a ZIP/CRX central directory, yielding one entry at a time. Lazy on
 * purpose: callers that only want a couple of members (xlsx.ts reads two XML
 * parts out of a workbook) never pay to inflate the rest, and extractZipTo
 * keeps its original one-entry-at-a-time memory profile.
 */
export async function* zipEntries(input: Uint8Array): AsyncGenerator<ZipEntry> {
  const data = parseArchive(input).zip;
  // Locate End Of Central Directory (scan back over the optional comment).
  let eocd = -1;
  const minStart = Math.max(0, data.length - 22 - 0xffff);
  for (let i = data.length - 22; i >= minStart; i--) {
    if (u32(data, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a valid zip/crx (no end-of-central-directory record)");

  const total = u16(data, eocd + 10);
  let p = u32(data, eocd + 16); // central directory offset
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
    yield { name, bytes: async () => (method === 0 ? comp : await inflateRaw(comp)) };
  }
}

/** Extract a ZIP/CRX to destDir. Returns the number of files written. */
export async function extractZipTo(input: Uint8Array, destDir: string): Promise<number> {
  let written = 0;
  for await (const entry of zipEntries(input)) {
    await Bun.write(join(destDir, entry.name), await entry.bytes());
    written++;
  }
  if (written === 0) throw new Error("archive contained no files");
  return written;
}
