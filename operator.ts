/**
 * The hub lock owner (operator identity) — must be UNIQUE per box yet STABLE across restarts.
 *
 * An explicit OPERATOR_NAME always wins. Otherwise we persist a RANDOM id in a `.operator-id` file next
 * to the store, generated on first run.
 *
 * Why random-and-persisted rather than derived from hostname/path: identical VPS clones share a hostname
 * AND an install path, so a hostname+path derivation produced the SAME owner on every clone — the hub
 * then treated them as one operator, the per-profile lock couldn't serialize them, and the lock churn +
 * concurrent-use logouts came back. A random id generated independently on each box's first run cannot
 * collide, and persisting it keeps the owner stable so a box still reclaims its own locks across restarts.
 *
 * Caveat: if you image a box AFTER it has already run (so `.operator-id` is copied into the clone),
 * delete that file on the clone — or set OPERATOR_NAME — so it regenerates a fresh id.
 */
import { hostname } from "node:os";
import { resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

function sanitizeHost(h: string): string {
  return (h || "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 24) || "box";
}

export function defaultOperatorName(dbPath: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPERATOR_NAME) return env.OPERATOR_NAME;
  const idFile = resolve(dirname(resolve(dbPath)), ".operator-id");
  try {
    if (existsSync(idFile)) {
      const saved = readFileSync(idFile, "utf8").trim();
      if (saved) return saved;
    }
  } catch {
    /* unreadable → fall through and mint a fresh one */
  }
  const id = `${sanitizeHost(hostname())}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(idFile, id);
  } catch {
    /* couldn't persist (read-only fs, etc.) — still return a usable id for this run */
  }
  return id;
}
