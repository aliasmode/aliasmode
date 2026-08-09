/**
 * TOTP (RFC 6238) generator for the per-profile 2FA authenticator — the same
 * live 6-digit code AdsPower shows. The 2FA secret (AdsPower "fakey") is a
 * base32 string stored on the profile; we derive the current code from it.
 *
 * Kept server-side so the dashboard's redacted list never has to ship the
 * secret just to show a code (the row's quick-copy hits /ui/api/profiles/:id/totp).
 */

import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode an RFC 4648 base32 secret (padding/whitespace/case tolerant). */
export function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/[\s=]/g, "").toUpperCase();
  let bits = "";
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) continue; // skip stray non-base32 chars
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Uint8Array.from(bytes);
}

export interface TotpResult {
  code: string;
  /** Seconds until the current code rolls over. */
  secondsRemaining: number;
  period: number;
}

/**
 * Current TOTP for a base32 secret. Returns null when the secret is empty or
 * not decodable. `nowMs` is injectable for tests.
 */
export function generateTotp(secret: string, nowMs = Date.now(), period = 30, digits = 6): TotpResult | null {
  const key = base32Decode(secret ?? "");
  if (key.length === 0) return null;
  const seconds = Math.floor(nowMs / 1000);
  const counter = Math.floor(seconds / period);

  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", Buffer.from(key)).update(buf).digest();

  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const code = (bin % 10 ** digits).toString().padStart(digits, "0");
  return { code, secondsRemaining: period - (seconds % period), period };
}
