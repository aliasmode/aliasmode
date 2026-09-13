import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platformHomeUrl } from "./launcher.ts";
import { AUTOFILL_BACKGROUND, AUTOFILL_CONTENT, AUTOFILL_MANIFEST, autofillExtensionDir } from "./autofill-extension.ts";
import type { ProfileStore } from "./store.ts";
import { generateTotp } from "./totp.ts";
import type { LaunchInfo } from "./types.ts";

type Generation = Pick<LaunchInfo, "debugPort" | "startedAt">;
type Binding = Generation & { profileId: string; token: string; directory: string };
const FIELDS = ["username", "email", "password", "totp"] as const;

export function matchesAutofillSite(platform: string | undefined, pageUrl: string): boolean {
  const raw = platform?.trim().toLowerCase();
  if (!raw) return false;
  try {
    const site = new URL(platformHomeUrl(raw) ?? (raw.includes("://") ? raw : `https://${raw}`));
    const page = new URL(pageUrl);
    if (!["http:", "https:"].includes(site.protocol) || !["http:", "https:"].includes(page.protocol)) return false;
    const host = site.hostname.replace(/^www\./, "").replace(/\.$/, "");
    if (!host.includes(".")) return false;
    const hosts = ["x.com", "twitter.com"].includes(host) ? ["x.com", "twitter.com"] : [host];
    const actual = page.hostname.replace(/\.$/, "");
    return hosts.some((allowed) => actual === allowed || actual.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

function json(body: object, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** Tokens belong to one live generation, never to exported profile or launch records. */
export class AutofillBridge {
  private server?: ReturnType<typeof Bun.serve>;
  private profiles = new Map<string, Binding>();
  private tokens = new Map<string, Binding>();

  constructor(private store: ProfileStore) {}

  get port(): number {
    return this.server?.port ?? 0;
  }

  listen(): void {
    if (this.server) return;
    this.server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (request) => this.handle(request),
      error: () => json({ ok: false, error: "Autofill is unavailable." }, 500),
    });
    this.server.unref();
    // Surviving workers reread bind.json, so both the port and token may change.
    for (const launch of this.store.listLaunches()) {
      if (launch.userDataDir && existsSync(join(autofillExtensionDir(launch.userDataDir), "manifest.json"))) {
        try { this.install(launch); } catch {
          console.warn(`[aliasmode] autofill unavailable for ${launch.profileId}; close and reopen the profile to retry`);
        }
      }
    }
  }

  install(launch: LaunchInfo): void {
    if (!this.port || !launch.userDataDir) throw new Error("autofill bridge or profile directory is unavailable");
    const directory = autofillExtensionDir(launch.userDataDir);
    const binding: Binding = {
      profileId: launch.profileId, debugPort: launch.debugPort, startedAt: launch.startedAt,
      directory, token: randomBytes(32).toString("base64url"),
    };
    const previous = this.profiles.get(launch.profileId);
    if (previous) this.tokens.delete(previous.token);
    this.profiles.set(launch.profileId, binding);
    this.tokens.set(binding.token, binding);
    const temporary = join(directory, "bind.json.tmp");
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, "manifest.json"), JSON.stringify(AUTOFILL_MANIFEST));
      writeFileSync(join(directory, "background.js"), AUTOFILL_BACKGROUND);
      writeFileSync(join(directory, "content.js"), AUTOFILL_CONTENT);
      writeFileSync(temporary, JSON.stringify({ port: this.port, token: binding.token }), { mode: 0o600 });
      renameSync(temporary, join(directory, "bind.json"));
    } catch {
      this.retire(launch.profileId, launch);
      try { rmSync(temporary, { force: true }); } catch {}
      throw new Error("could not prepare the profile autofill extension");
    }
  }

  retire(profileId: string, generation: Generation): void {
    const binding = this.profiles.get(profileId);
    if (!binding || binding.debugPort !== generation.debugPort || binding.startedAt !== generation.startedAt) return;
    this.profiles.delete(profileId);
    this.tokens.delete(binding.token);
    try { rmSync(join(binding.directory, "bind.json"), { force: true }); } catch {}
  }

  close(): void {
    // Leave files for surviving browsers; a new manager refreshes their binding.
    this.tokens.clear();
    this.profiles.clear();
    this.server?.stop(true);
    this.server = undefined;
  }

  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== "/v1/fields" && path !== "/v1/fill") return json({ ok: false }, 404);
    if (request.method !== "POST") return json({ ok: false }, 405);
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!this.tokens.has(token)) return json({ ok: false, error: "Open AliasMode to use autofill." }, 401);
    let body: { url?: unknown; field?: unknown } | null;
    try { body = await request.json(); } catch { return json({ ok: false }, 400); }
    // Recheck after reading the body: a stop or replacement may have happened meanwhile.
    const binding = this.tokens.get(token);
    const launch = binding && this.store.getLaunch(binding.profileId);
    if (!binding || !launch || launch.debugPort !== binding.debugPort || launch.startedAt !== binding.startedAt) {
      return json({ ok: false, error: "Reopen this profile to use autofill." }, 401);
    }
    const profile = this.store.getProfile(binding.profileId);
    if (!profile || typeof body?.url !== "string" || !matchesAutofillSite(profile.platform, body.url)) {
      return json({ ok: false, error: "This site does not match the profile's platform." }, 403);
    }
    if (path === "/v1/fields") {
      const fields = FIELDS.filter((field) => field === "totp" ? !!generateTotp(profile.twofa) : !!profile[field]);
      return json({ ok: true, name: profile.name || profile.id, fields });
    }
    if (!FIELDS.includes(body.field as typeof FIELDS[number])) return json({ ok: false }, 400);
    const field = body.field as typeof FIELDS[number];
    const value = field === "totp" ? generateTotp(profile.twofa)?.code : profile[field];
    if (!value) return json({ ok: false, error: "No saved value for this field. Edit the profile in AliasMode." }, 404);
    return json({ ok: true, value });
  }
}
