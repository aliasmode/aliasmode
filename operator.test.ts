import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultOperatorName } from "./operator.ts";

const noOverride = { ...process.env, OPERATOR_NAME: undefined } as NodeJS.ProcessEnv;

function tempDb(): { db: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cloak-op-"));
  return { db: join(dir, "profiles.sqlite"), dir };
}

test("owner is minted once and stays stable across restarts (persisted next to the store)", () => {
  const { db, dir } = tempDb();
  try {
    const first = defaultOperatorName(db, noOverride);
    expect(existsSync(join(dir, ".operator-id"))).toBe(true);
    expect(first).toMatch(/-[0-9a-f]{8}$/); // random suffix, not a deterministic hash
    const second = defaultOperatorName(db, noOverride); // "restart" → reads the persisted file
    expect(second).toBe(first);
    expect(readFileSync(join(dir, ".operator-id"), "utf8").trim()).toBe(first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two boxes each mint a DIFFERENT owner — clones can't collide", () => {
  const a = tempDb();
  const b = tempDb();
  try {
    expect(defaultOperatorName(a.db, noOverride)).not.toBe(defaultOperatorName(b.db, noOverride));
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("an explicit OPERATOR_NAME always wins and is not persisted", () => {
  const { db, dir } = tempDb();
  try {
    const env = { ...process.env, OPERATOR_NAME: "automation-7" } as NodeJS.ProcessEnv;
    expect(defaultOperatorName(db, env)).toBe("automation-7");
    expect(existsSync(join(dir, ".operator-id"))).toBe(false); // override writes nothing
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
