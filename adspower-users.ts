/**
 * AdsPower-compatible PROFILE MANAGEMENT facade (`/api/v1/group/list`,
 * `/api/v1/group/create`, `/api/v1/user/{list,create,delete,update}`).
 *
 * server.ts covers AdsPower's browser-control routes (the only ones automation
 * needs). This module covers the lifecycle routes a full AdsPower REST client
 * uses — e.g. the Python profile-create-login tool — so that tool migrates to
 * aliasmode by repointing its base URL alone, no client rewrite.
 *
 * Served in BOTH modes. Standalone: against the local store. Remote (HUB_URL set):
 * create/list/delete/group route through the hub coordinator — the same central
 * roster the dashboard and automation use — so a hub-connected box stays the single
 * source of truth (creating against the local launch cache would silently diverge).
 *
 * Shapes are dictated by what the Python client (adspower_api.py) parses:
 *   group/list  -> data.list[].{group_id, group_name}
 *   user/list   -> data.list[].{user_id, name, created_time, last_open_time, serial_number}
 *   user/create -> data.id
 *   user/delete -> code === 0
 *   user/update -> code === 0
 */

import type { Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import type { RemoteCoordinator } from "./remote.ts";
import type { Profile } from "./types.ts";
import { buildNewProfile, type NewProfileInput } from "./create.ts";
import { attachTimezones } from "./geoip.ts";
import { isValidProfileName } from "./profile-validation.ts";

/** Best-effort geoip fetch, injectable for tests; defaults to real ip-api.com. */
type GeoipFetch = (url: string, init: RequestInit) => Promise<{ json(): Promise<any> }>;

function ok(data?: unknown) {
  return Response.json({ code: 0, msg: "success", data: data ?? {} });
}
function fail(msg: string) {
  return Response.json({ code: -1, msg, data: {} });
}

/**
 * AdsPower's default/un-grouped bucket is id "0"; aliasmode stores ungrouped
 * profiles with an empty label. Map both "0" and "" to "" on the way in/out so
 * create→list round-trips and group filtering stay symmetric.
 */
function normalizeGroup(g: unknown): string {
  const s = String(g ?? "").trim();
  return s === "0" ? "" : s;
}

function intParam(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** AdsPower account/proxy/fingerprint fields → aliasmode NewProfileInput. */
function inputFromCreateBody(body: any): NewProfileInput {
  const px = body?.user_proxy_config;
  const hasProxy = px && px.proxy_host && String(px.proxy_host).trim();
  // AdsPower screen_resolution is "1920_1080"; aliasmode's create wants "1920x1080".
  const screenRaw = body?.fingerprint_config?.screen_resolution;
  return {
    name: typeof body?.name === "string" ? body.name : "",
    group: normalizeGroup(body?.group_id),
    platform: typeof body?.domain_name === "string" ? body.domain_name : "",
    username: typeof body?.username === "string" ? body.username : "",
    password: typeof body?.password === "string" ? body.password : "",
    email: typeof body?.email === "string" ? body.email : "",
    emailPassword: typeof body?.email_password === "string"
      ? body.email_password
      : (typeof body?.emailPassword === "string" ? body.emailPassword : ""),
    twofa: typeof body?.fakey === "string"
      ? body.fakey
      : (typeof body?.twofa === "string" ? body.twofa : ""),
    proxy: hasProxy
      ? {
          type: String(px.proxy_type || "http"),
          host: String(px.proxy_host).trim(),
          port: String(px.proxy_port ?? ""),
          user: String(px.proxy_user ?? ""),
          pass: String(px.proxy_password ?? ""),
        }
      : null,
    screen: typeof screenRaw === "string" ? screenRaw.replace(/_/g, "x") : "",
  };
}

function hasCredentialUpdate(body: any): boolean {
  return ["username", "password", "email", "email_password", "emailPassword", "fakey", "twofa"]
    .some((field) => typeof body?.[field] === "string");
}

function profileFromUpdateBody(profile: Profile, body: any): Profile {
  const updated = { ...profile, name: body.name };
  if (typeof body?.username === "string") updated.username = body.username;
  if (typeof body?.password === "string") updated.password = body.password;
  if (typeof body?.email === "string") updated.email = body.email;
  if (typeof body?.email_password === "string") updated.emailPassword = body.email_password;
  else if (typeof body?.emailPassword === "string") updated.emailPassword = body.emailPassword;
  if (typeof body?.fakey === "string") updated.twofa = body.fakey;
  else if (typeof body?.twofa === "string") updated.twofa = body.twofa;
  return updated;
}

/**
 * Handle an AdsPower profile-management request. Returns null for any path this
 * module doesn't own, so web.ts falls through to the browser-control handler.
 * When `remote` is set, central edits route through the hub coordinator.
 */
export async function handleUserApi(
  req: Request,
  launcher: Launcher,
  store: ProfileStore,
  remote?: RemoteCoordinator | null,
  geoipFetch?: GeoipFetch,
): Promise<Response | null> {
  const { pathname, searchParams } = new URL(req.url);

  // --- groups: id == name (aliasmode has no group ids) ---
  if (pathname === "/api/v1/group/list" && req.method === "GET") {
    const page = intParam(searchParams.get("page"), 1);
    const pageSize = intParam(searchParams.get("page_size"), 100);
    // Standalone: registry ∪ profile labels (empty folders included, so the client's
    // find_group_id resolves a group before its first profile). Remote: distinct
    // group labels off the hub roster.
    const names = remote
      ? [...new Set((await remote.listProfiles()).map((p) => normalizeGroup(p.group)).filter((g) => g))].sort()
      : store.listGroups();
    const list = names.slice((page - 1) * pageSize, page * pageSize).map((g) => ({ group_id: g, group_name: g }));
    return ok({ list, page, page_size: pageSize });
  }

  // --- create a folder up front (AdsPower group/create); idempotent, id == name ---
  if (pathname === "/api/v1/group/create" && req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return fail("invalid JSON body");
    }
    const name = String(body?.group_name ?? "").trim();
    if (!name) return fail("missing group_name");
    // Remote: the hub has no empty-group registry; the folder materializes when a
    // profile is created/moved into it (id == name, so this is enough for the
    // create flow). Standalone: persist it so empty folders list immediately.
    if (!remote) store.registerGroup(name);
    return ok({ group_id: name });
  }

  // --- list profiles (optionally by group), AdsPower envelope ---
  if (pathname === "/api/v1/user/list" && req.method === "GET") {
    const page = intParam(searchParams.get("page"), 1);
    const pageSize = intParam(searchParams.get("page_size"), 100);
    // Remote: map the hub roster (no timestamps → 0). Standalone: the local store.
    let rows = remote
      ? (await remote.listProfiles()).map((p, i) => ({ id: p.id, name: p.name, group: p.group, createdAt: 0, lastOpenAt: 0, serial: i + 1 }))
      : store.listUserRecords();

    const groupId = searchParams.get("group_id");
    if (groupId != null) {
      const want = normalizeGroup(groupId);
      rows = rows.filter((r) => normalizeGroup(r.group) === want);
    }

    // Honor AdsPower's user_sort={"created_time"|"last_open_time":"asc"|"desc"}.
    // (No-op on the remote roster, which carries no timestamps.)
    const sortRaw = searchParams.get("user_sort");
    if (sortRaw) {
      try {
        const s = JSON.parse(sortRaw) as Record<string, string>;
        if (s.created_time) {
          rows.sort((a, b) => (s.created_time === "asc" ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
        } else if (s.last_open_time) {
          rows.sort((a, b) => (s.last_open_time === "asc" ? a.lastOpenAt - b.lastOpenAt : b.lastOpenAt - a.lastOpenAt));
        }
      } catch {
        /* malformed sort → keep insertion order */
      }
    }

    const list = rows.slice((page - 1) * pageSize, page * pageSize).map((r) => ({
      user_id: r.id,
      name: r.name,
      group_id: normalizeGroup(r.group),
      serial_number: String(r.serial),
      // AdsPower reports Unix SECONDS; our bookkeeping is ms. 0 stays 0 (unknown).
      created_time: r.createdAt ? Math.floor(r.createdAt / 1000) : 0,
      last_open_time: r.lastOpenAt ? Math.floor(r.lastOpenAt / 1000) : 0,
    }));
    return ok({ list, page, page_size: pageSize });
  }

  // --- create: AdsPower payload -> aliasmode profile (fingerprint from seed) ---
  if (pathname === "/api/v1/user/create" && req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return fail("invalid JSON body");
    }
    const input = inputFromCreateBody(body);
    try {
      if (remote) {
        // Hub owns id generation, fingerprint seed, and geoip timezone.
        const { id } = await remote.createProfile(input);
        return ok({ id });
      }
      const profile = buildNewProfile(input, (id) => !!store.getProfile(id));
      // Match the browser clock to the proxy's geo, exactly as /ui/api create and
      // AdsPower's automatic_timezone do. Best-effort: never fail create on geoip.
      if (profile.proxy) await attachTimezones([profile], geoipFetch).catch(() => {});
      store.upsertProfile(profile);
      return ok({ id: profile.id });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  // --- delete ---
  if (pathname === "/api/v1/user/delete" && req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return fail("invalid JSON body");
    }
    const ids = Array.isArray(body?.user_ids) ? body.user_ids.map(String) : [];
    if (remote) {
      const r = await remote.deleteProfiles(ids); // hub deletes centrally (respects locks)
      return ok({ deleted: r.deleted, locked: r.locked });
    }
    // Standalone: stop, remove the persistent user-data dir, drop the row.
    let deleted = 0;
    const locked: string[] = [];
    for (const id of ids) {
      if (!store.getProfile(id)) continue;
      // stop() also waits for an in-flight start that has not recorded its
      // launch row yet, so deletion cannot race a late browser spawn.
      if ((await launcher.stop(id)) !== true) {
        locked.push(id);
        continue;
      }
      // removeUserDataDir refuses any path outside the data root (a crafted or
      // legacy "../" id), so rmSync can't escape; the row is dropped regardless.
      launcher.removeUserDataDir(id);
      store.deleteProfile(id);
      deleted++;
    }
    return ok({ deleted, locked });
  }

  // --- update: browser name + saved account credentials ---
  if (pathname === "/api/v1/user/update" && req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return fail("invalid JSON body");
    }
    const id = typeof body?.user_id === "string" ? body.user_id : "";
    if (!id) return fail("missing user_id");
    if (!isValidProfileName(body?.name)) return fail("name must be a non-empty string");
    if (remote) {
      try {
        if (!hasCredentialUpdate(body)) {
          await remote.renameProfile(id, body.name);
        } else {
          const profile = await remote.getProfile(id);
          await remote.saveProfile(profileFromUpdateBody(profile, body));
        }
        return ok({});
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }
    try {
      const profile = store.getProfile(id);
      if (!profile) return fail(`no such profile: ${id}`);
      store.upsertProfile(profileFromUpdateBody(profile, body));
      return ok({});
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return fail(`failed to persist profile update: ${message}`);
    }
  }

  return null;
}
