import { expect, test } from "bun:test";
import { HubClient, HubOwnershipLostError, type HubFetch } from "./hub-client.ts";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function queuedFetch(...responses: Response[]): HubFetch {
  return async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected hub request");
    return response;
  };
}

test("client authenticates and reads a compatible roster snapshot", async () => {
  let url = "";
  let auth = "";
  const client = new HubClient("https://cloud.example/", "token", "local-label", async (requestUrl, init) => {
    url = requestUrl;
    auth = new Headers(init?.headers).get("authorization") ?? "";
    return json({ ok: true, owner: "cloud-user", profiles: [{ id: "legacy" }] });
  });

  const snapshot = await client.getRosterSnapshot();
  expect(snapshot.profiles[0]?.id).toBe("legacy");
  expect(snapshot.healthSources).toEqual([]);
  expect(url).toBe("https://cloud.example/hub/profiles");
  expect(auth).toBe("Bearer token");
  expect(client.owner).toBe("cloud-user");
});

test("client publishes health snapshots through its authenticated connection", async () => {
  let request: RequestInit | undefined;
  const client = new HubClient("https://cloud.example", "token", "local-label", async (_url, init) => {
    request = init;
    return json({ ok: true, profiles: 2, alive: 1, suspended: 1 });
  });

  await expect(client.publishAutomationHealthSnapshot([
    { profileId: "a", suspended: false },
    { profileId: "b", suspended: true },
  ])).resolves.toEqual({ profiles: 2, alive: 1, suspended: 1 });
  expect(JSON.parse(String(request?.body))).toEqual({
    profiles: [{ profileId: "a", suspended: false }, { profileId: "b", suspended: true }],
  });
});

test("claim records the cloud owner and lease fence for follow-up operations", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = new HubClient("https://cloud.example", "token", "local-label", async (url, init) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    return requests.length === 1
      ? json({ ok: true, lock: { owner: "cloud-user", fence: 7 } })
      : json({ ok: true });
  });

  expect(await client.claim("profile-1")).toEqual({ ok: true });
  expect(await client.renew("profile-1")).toBe(true);
  expect(requests).toEqual([
    { url: "https://cloud.example/hub/lock/claim", body: { profile_id: "profile-1", owner: "local-label" } },
    { url: "https://cloud.example/hub/lock/renew", body: { profile_id: "profile-1", owner: "cloud-user", fence: 7 } },
  ]);
});

test("claim reports a conflicting holder without throwing", async () => {
  const client = new HubClient("https://cloud.example", "token", "local-label", async () =>
    json({ ok: false, lockedBy: "other-user" }, 409),
  );

  await expect(client.claim("profile-1")).resolves.toEqual({ ok: false, lockedBy: "other-user" });
});

test("session conflicts and ownership loss retain their client semantics", async () => {
  const client = new HubClient("https://cloud.example", "token", "local-label", queuedFetch(
    json({ ok: true, lock: { owner: "cloud-user", fence: 3 } }),
    json({ ok: false, error: "version conflict", currentVersion: 4 }, 409),
    json({ ok: false, error: "active lock" }, 409),
  ));

  await client.claim("profile-1");
  await expect(client.putSession("profile-1", "old", 0)).resolves.toEqual({ version: 4, conflict: true });
  await expect(client.putSession("profile-1", "new")).rejects.toBeInstanceOf(HubOwnershipLostError);
});

test("client rejects malformed and failed hub responses", async () => {
  const malformed = new HubClient("https://cloud.example", "token", "local-label", async () =>
    new Response("<html></html>", { headers: { "content-type": "text/html" } }),
  );
  const unavailable = new HubClient("https://cloud.example", "token", "local-label", async () =>
    json({ ok: false, error: "service unavailable" }, 503),
  );

  await expect(malformed.getRoster()).rejects.toThrow("returned non-JSON");
  await expect(unavailable.release("profile-1")).rejects.toThrow("service unavailable");
});

test("client requests time out when fetch ignores abort", async () => {
  let signal: AbortSignal | null | undefined;
  const client = new HubClient("https://cloud.example", "token", "local-label", async (_url, init) => {
    signal = init?.signal;
    return new Promise<Response>(() => {});
  }, 5);

  await expect(client.getRoster()).rejects.toThrow("hub request /hub/profiles timed out after 5ms");
  expect(signal?.aborted).toBe(true);
});
