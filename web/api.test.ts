import { afterEach, expect, test } from "bun:test";
import { fetchProfiles, openProfile } from "./api.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("dashboard API reports an HTML/version mismatch instead of a JSON SyntaxError", async () => {
  globalThis.fetch = (async () => new Response("<!doctype html><title>AliasMode</title>", {
    status: 200,
    headers: { "content-type": "text/html" },
  })) as unknown as typeof fetch;

  await expect(fetchProfiles()).rejects.toThrow("dashboard and local server may be on different versions");
  await expect(openProfile("profile1")).rejects.toThrow("returned non-JSON");
});

test("dashboard API distinguishes an HTML server crash from a version mismatch", async () => {
  globalThis.fetch = (async () => new Response("<!doctype html><title>Internal Server Error</title>", {
    status: 500,
    headers: { "content-type": "text/html" },
  })) as unknown as typeof fetch;

  await expect(fetchProfiles()).rejects.toThrow("local server failed before it could return JSON");
});

test("dashboard profile roster rejects malformed JSON shape explicitly", async () => {
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
  await expect(fetchProfiles()).rejects.toThrow("no profile roster");
});

test("dashboard roster carries health metadata and tolerates an older local server", async () => {
  globalThis.fetch = (async () => Response.json({
    profiles: [{ id: "p1", healthStatus: "suspended", healthObservedAt: 1_000 }],
    healthSources: [{ sourceId: "node-a", lastSnapshotAt: 1_000, stale: false }],
  })) as unknown as typeof fetch;
  const roster = await fetchProfiles();
  expect(roster.profiles[0]).toMatchObject({ id: "p1", healthStatus: "suspended", healthObservedAt: 1_000 });
  expect(roster.healthSources).toEqual([{ sourceId: "node-a", lastSnapshotAt: 1_000, stale: false }]);

  globalThis.fetch = (async () => Response.json({ profiles: [{ id: "legacy" }] })) as unknown as typeof fetch;
  const legacy = await fetchProfiles();
  expect(legacy.profiles[0]).toMatchObject({ id: "legacy" });
  expect(legacy.healthSources).toEqual([]);
});
