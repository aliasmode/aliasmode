import { parse } from "csv-parse/sync";
import { checkProxy, type ProxyCheckOptions, type ProxyCheckResult } from "./proxy-check.ts";
import { fetchDirectEgress, type EgressInfo } from "./egress.ts";
import { normalizeProxySpec, parseProxySpec, proxyHostPort, proxyIdentityKey } from "./proxy.ts";
import { parseProxyReplacementCsv } from "./proxy-replacements.ts";
import type { ProxySpec } from "./types.ts";
import type { ProxyCheckView, ProxyPreviewInput, ProxyProgressEvent, ProxyReplacementView, ProxyScope } from "./proxy-tools-types.ts";

export interface ProxyInventoryProfile {
  id: string;
  name: string;
  group: string;
  proxy: ProxySpec | null;
  proxyError?: string;
  version?: number;
  permission: "view" | "edit";
  running: boolean;
}

export interface PlannedProxyReplacement {
  view: ProxyReplacementView;
  next?: ProxySpec;
  originalKey: string;
  expectedVersion?: number;
}

export class ProxyToolsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function selectProxyProfiles(profiles: ProxyInventoryProfile[], scope: ProxyScope): ProxyInventoryProfile[] {
  if (!scope || typeof scope !== "object" ||
      (scope.all !== undefined && typeof scope.all !== "boolean") ||
      (scope.groups !== undefined && (!Array.isArray(scope.groups) || scope.groups.some((x) => typeof x !== "string"))) ||
      (scope.ids !== undefined && (!Array.isArray(scope.ids) || scope.ids.some((x) => typeof x !== "string")))) {
    throw new ProxyToolsError("Invalid folder selection");
  }
  const groups = new Set(scope.groups ?? []), ids = scope.ids ? new Set(scope.ids) : null;
  return profiles.filter((p) => (scope.all || groups.has(p.group)) && (!ids || ids.has(p.id)));
}

export function replacementState(profile: ProxyInventoryProfile | undefined, next: ProxySpec): Pick<ProxyReplacementView, "status" | "code"> {
  if (!profile || profile.permission !== "edit") return { status: "skipped", code: "no_editable_match" };
  if (profile.running) return { status: "skipped", code: "profile_open" };
  if (!profile.proxyError && proxyIdentityKey(profile.proxy) === proxyIdentityKey(next)) return { status: "unchanged" };
  return { status: "ready" };
}

export function buildProxyPreview(profiles: ProxyInventoryProfile[], input: ProxyPreviewInput): { rows: PlannedProxyReplacement[]; unusedProxies: number } {
  if (!input || typeof input.input !== "string" || !input.input.trim()) throw new ProxyToolsError("Paste or upload replacement proxies");
  const selected = selectProxyProfiles(profiles, input.scope).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byId = new Map(selected.map((p) => [p.id, p]));
  const rows: PlannedProxyReplacement[] = [];
  let unusedProxies = 0;
  const add = (profile: ProxyInventoryProfile | undefined, next?: ProxySpec, code?: string) => {
    rows.push({
      view: {
        index: rows.length,
        ...(profile ? { profileId: profile.id, name: profile.name, group: profile.group } : {}),
        previousProxy: profile?.proxy ? `${profile.proxy.type}://${proxyHostPort(profile.proxy)}` : null,
        proxy: next ? `${next.type}://${proxyHostPort(next)}` : null,
        ...(code ? { status: "skipped" as const, code } : next ? replacementState(profile, next) : { status: "skipped" as const, code: "no_replacement" }),
      },
      next,
      originalKey: proxyIdentityKey(profile?.proxy ?? null),
      expectedVersion: profile?.version,
    });
  };
  try {
    if (input.mode === "profileId") {
      for (const row of parseProxyReplacementCsv(input.input)) {
        const profile = row.profileId ? byId.get(row.profileId) : undefined;
        const next = normalizeProxySpec(row.proxy);
        add(profile, next ?? undefined, row.profileId ? undefined : "invalid_row");
      }
    } else if (input.mode === "oldProxy") {
      const records: string[][] = parse(input.input, { bom: true, skip_empty_lines: true });
      if (records.length < 2 || records[0]?.join(",") !== "oldProxy,newProxy") throw new Error("headers");
      const byProxy = new Map<string, ProxyInventoryProfile[]>();
      for (const profile of selected) {
        const key = proxyIdentityKey(profile.proxy);
        const group = byProxy.get(key) ?? [];
        group.push(profile); byProxy.set(key, group);
      }
      for (const values of records.slice(1)) {
        if (values.length !== 2) throw new Error("columns");
        const old = parseProxySpec("http", values[0]), next = parseProxySpec("http", values[1]);
        if (!old || !next) throw new Error("empty");
        const matches = byProxy.get(proxyIdentityKey(old)) ?? [];
        if (!matches.length) add(undefined, next, "no_editable_match");
        else for (const profile of matches) add(profile, next);
      }
    } else if (input.mode === "list") {
      const proxies = input.input.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
        const proxy = parseProxySpec("http", line);
        if (!proxy) throw new Error("empty");
        return proxy;
      });
      selected.forEach((profile, index) => add(profile, proxies[index]));
      unusedProxies = Math.max(0, proxies.length - selected.length);
    } else throw new Error("mode");
  } catch {
    throw new ProxyToolsError("Invalid proxy input. Check the selected format and proxy settings.");
  }
  const targets = new Map<string, number>();
  for (const row of rows) if (row.view.profileId) targets.set(row.view.profileId, (targets.get(row.view.profileId) ?? 0) + 1);
  for (const row of rows) if (row.view.profileId && targets.get(row.view.profileId)! > 1) {
    row.view.status = "skipped"; row.view.code = "duplicate_target";
  }
  return { rows, unusedProxies };
}

export async function checkProfileProxies(
  profiles: ProxyInventoryProfile[],
  send: (event: ProxyProgressEvent) => void,
  cancelled: () => boolean,
  deps: {
    direct?: () => Promise<EgressInfo | null>;
    check?: (proxy: ProxySpec, options: ProxyCheckOptions) => Promise<ProxyCheckResult>;
  } = {},
): Promise<void> {
  const unique = new Map<string, { proxy: ProxySpec; row: ProxyCheckView }>();
  const excluded: ProxyCheckView[] = [];
  for (const profile of profiles) {
    const ref = { id: profile.id, name: profile.name, group: profile.group };
    const base = { key: crypto.randomUUID(), proxy: profile.proxy ? `${profile.proxy.type}://${proxyHostPort(profile.proxy)}` : null, profiles: [ref], checkedAt: Date.now() };
    if (profile.proxyError || !profile.proxy) {
      excluded.push({ ...base, status: profile.proxyError ? "invalid" : "missing" });
      continue;
    }
    const key = proxyIdentityKey(profile.proxy);
    const group = unique.get(key);
    if (group) group.row.profiles.push(ref);
    else unique.set(key, { proxy: profile.proxy, row: { ...base, status: profile.proxy.type === "https" ? "unsupported" : "unavailable" } });
  }
  send({ type: "summary", selectedProfiles: profiles.length, uniqueProxies: unique.size, duplicatesSkipped: profiles.length - excluded.length - unique.size });
  for (const row of excluded) send({ type: "check", row });
  const items = [...unique.values()];
  const direct = items.some((item) => item.row.status !== "unsupported") && !cancelled()
    ? await (deps.direct ?? (() => fetchDirectEgress()))().catch(() => null) : null;
  let index = 0, completed = 0;
  send({ type: "progress", phase: "checking", completed, total: items.length });
  const worker = async () => {
    while (!cancelled() && index < items.length) {
      const item = items[index++]!;
      if (item.row.status !== "unsupported") {
        try {
          const result = await (deps.check ?? checkProxy)(item.proxy, { direct });
          item.row = { ...item.row, status: result.status, reason: result.reason, ip: result.ip, country: result.country, checkedAt: Date.now() };
        } catch { item.row = { ...item.row, status: "unavailable", reason: "check_unavailable", checkedAt: Date.now() }; }
      }
      send({ type: "check", row: item.row });
      send({ type: "progress", phase: "checking", completed: ++completed, total: items.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
}
