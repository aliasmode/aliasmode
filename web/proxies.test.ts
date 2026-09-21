import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  ProxiesPage,
  failedProxyProfileIds,
  mergeProxyCheckResult,
  proxyResultPage,
  proxyScope,
  readProxyProgress,
  requestProxyPreview,
  retryProxyProfileIds,
} from "./proxies.tsx";
import type { ProxyCheckView, ProxyProgressEvent, ProxyReplacementView } from "../proxy-tools-types.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function check(status: ProxyCheckView["status"], ids: string[]): ProxyCheckView {
  return { key: ids.join("-"), proxy: "proxy.example:8080", profiles: ids.map((id) => ({ id, name: id, group: "Sales" })), status, checkedAt: 1 };
}

function replacement(status: ProxyReplacementView["status"], profileId?: string): ProxyReplacementView {
  return { index: 0, profileId, previousProxy: null, proxy: "proxy.example:8080", status };
}

function stream(records: unknown[], chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
    controller.close();
  } }), { headers: { "content-type": "application/x-ndjson" } });
}

test("proxy scope selects complete folders, including ungrouped, independently of paging", () => {
  const groups = ["Sales", "", "Support", "Sales"];
  expect(proxyScope(false, groups)).toEqual({ groups: ["Sales", "", "Support"] });
  expect(proxyScope(true, groups)).toEqual({ all: true });
  expect(proxyScope(false, groups, ["p1", "p1", "p2"])).toEqual({ groups: ["Sales", "", "Support"], ids: ["p1", "p2"] });
  expect(groups).toEqual(["Sales", "", "Support", "Sales"]);
});

test("proxy result paging renders 50 of 8000 rows and clamps a stale page", () => {
  const rows = Array.from({ length: 8000 }, (_, id) => id);
  expect(proxyResultPage(rows, 0)).toMatchObject({ items: rows.slice(0, 50), page: 0, pages: 160, total: 8000 });
  expect(proxyResultPage(rows, 159).items).toEqual(rows.slice(7950));
  expect(proxyResultPage(rows.slice(0, 3), 159)).toMatchObject({ items: [0, 1, 2], page: 0, pages: 1 });
  expect(proxyResultPage([], 9)).toMatchObject({ items: [], page: 0, pages: 1, total: 0 });
});

test("failed check retry uses all affected profiles once, not just the displayed page", () => {
  const rows = [check("working", ["healthy"]), check("failed", ["p1", "p2"]), check("unstable", ["p2", "p3"]), check("unavailable", ["p4"]), check("missing", ["p5"]), check("invalid", ["p6"]), check("unsupported", ["p7"])];
  expect(failedProxyProfileIds(rows)).toEqual(["p1", "p2", "p3", "p4"]);
});

test("retry results preserve profiles whose retry has not finished", () => {
  const original = [check("working", ["healthy"]), check("failed", ["p1", "p2"])];
  const next = mergeProxyCheckResult(original, check("working", ["p1"]));
  expect(next.map((row) => [row.status, row.profiles.map((profile) => profile.id)])).toEqual([
    ["working", ["healthy"]], ["failed", ["p2"]], ["working", ["p1"]],
  ]);
  expect(failedProxyProfileIds(next)).toEqual(["p2"]);
  expect(original[1]?.profiles.map((profile) => profile.id)).toEqual(["p1", "p2"]);
});

test("replacement retry excludes successful, unchanged, and unmatched rows", () => {
  expect(retryProxyProfileIds([
    replacement("updated", "p1"), replacement("unchanged", "p2"), replacement("ready", "p3"),
    replacement("skipped", "p4"), replacement("failed", "p5"), replacement("failed", "p4"), replacement("missing"),
  ])).toEqual(["p4", "p5"]);
});

test("proxy preview sends a same-origin JSON request and preserves its abort signal", async () => {
  let request: { url: unknown; init?: RequestInit } | undefined;
  globalThis.fetch = (async (url, init) => {
    request = { url, init };
    return Response.json({ ok: true, previewId: "preview-1", rows: [], unusedProxies: 0 });
  }) as typeof fetch;
  const controller = new AbortController();
  const input = { scope: { groups: ["Sales"] }, mode: "list" as const, input: "proxy.example:8080:user:private" };
  expect(await requestProxyPreview(input, controller.signal)).toMatchObject({ previewId: "preview-1" });
  expect(request?.url).toBe("/ui/api/proxies/preview");
  expect(request?.init?.method).toBe("POST");
  expect(request?.init?.signal).toBe(controller.signal);
  expect(new Headers(request?.init?.headers).get("Content-Type")).toBe("application/json");
  expect(JSON.parse(String(request?.init?.body))).toEqual(input);
});

test("preview errors and malformed results never repeat input credentials", async () => {
  for (const response of [
    Response.json({ error: "private-password" }, { status: 400 }),
    Response.json({ ok: true, rows: [], unusedProxies: 0 }),
    new Response("private-password", { headers: { "content-type": "text/html" } }),
  ]) {
    globalThis.fetch = (async () => response) as unknown as typeof fetch;
    const error = await requestProxyPreview({ scope: { all: true }, mode: "list", input: "private-password" }).catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("private-password");
  }
});

test("proxy progress reads split UTF-8 records and requires a completed stream", async () => {
  const records: ProxyProgressEvent[] = [
    { type: "progress", phase: "checking", completed: 0, total: 1 },
    { type: "summary", selectedProfiles: 2, uniqueProxies: 1, duplicatesSkipped: 1 },
    { type: "check", row: { ...check("working", ["p1", "p2"]), profiles: [{ id: "p1", name: "例", group: "Sales" }] } },
    { type: "done" },
  ];
  const seen: ProxyProgressEvent[] = [];
  await readProxyProgress(stream(records, 1), (record) => seen.push(record));
  expect(seen).toEqual(records);
});

test("proxy progress rejects missing completion, broken JSON, wrong types, and server errors", async () => {
  const responses = [
    stream([{ type: "progress", phase: "checking", completed: 1, total: 2 }]),
    new Response('{"type":"check"', { headers: { "content-type": "application/x-ndjson" } }),
    stream([{ type: "unknown" }, { type: "done" }]),
    stream([{ type: "check" }, { type: "done" }]),
    stream([{ type: "error", error: "user:private-password@proxy.example" }]),
    new Response("private-password", { status: 503 }),
    Response.json({ ok: true }),
  ];
  for (const response of responses) {
    const error = await readProxyProgress(response, () => {}).catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("private-password");
  }
});

test("cancelling progress cancels the reader and cannot report completion", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/x-ndjson" } });
  const pending = readProxyProgress(response, () => {}, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(cancelled).toBe(true);
});

test("the proxy page remains mounted but hidden when navigation changes", () => {
  const html = renderToStaticMarkup(createElement(ProxiesPage, { active: false, groups: ["Sales", ""], onChanged: async () => {} }));
  expect(html).toContain('hidden=""');
  expect(html).toContain('aria-pressed="true">Check proxies');
  expect(html).toContain('aria-pressed="false">Replace proxies');
  expect(html).not.toContain('type="file"');
});
