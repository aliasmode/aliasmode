import bundled from "./services-directory.json";

/** The list behind the Services page. The admin page on aliasmode.com edits it, so it changes without an app release. */
export const SERVICES_URL = "https://aliasmode.com/_am/services";
const CACHE_MS = 15 * 60_000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ServiceListing {
  slug: string;
  name: string;
  category: string;
  description: string;
  deal?: string;
  code?: string;
  badge: "pick" | "sponsored" | null;
  logo?: string;
}

export interface ServicesResult {
  services: ServiceListing[];
  source: "live" | "bundled";
}

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Keeps only well-formed entries. Logos must be inline images, so the app never loads a picture from another server. */
export function parseServices(value: unknown): ServiceListing[] | null {
  const services = (value as { services?: unknown } | null)?.services;
  if (!Array.isArray(services)) return null;
  return services.flatMap((raw): ServiceListing[] => {
    const entry = raw as Record<string, unknown> | null;
    const slug = text(entry?.slug);
    const name = text(entry?.name);
    const category = text(entry?.category);
    const description = text(entry?.description);
    if (!slug || !SLUG.test(slug) || !name || !category || !description) return [];
    const deal = text(entry?.deal);
    const code = text(entry?.code);
    const logo = text(entry?.logo);
    return [{
      slug, name, category, description,
      ...(deal ? { deal } : {}),
      ...(code ? { code } : {}),
      badge: entry?.badge === "pick" || entry?.badge === "sponsored" ? entry.badge : null,
      ...(logo?.startsWith("data:image/") ? { logo } : {}),
    }];
  });
}

const BUNDLED = parseServices(bundled) ?? [];
let cached: { services: ServiceListing[]; at: number } | null = null;

/** Fetches the list when the Services page opens: no cookies, no parameters, no user data.
 *  Falls back to the copy shipped with this version when aliasmode.com cannot be reached. */
export async function loadServices(fetchFn: typeof fetch = fetch, now = Date.now()): Promise<ServicesResult> {
  if (cached && now - cached.at < CACHE_MS) return { services: cached.services, source: "live" };
  try {
    const response = await fetchFn(SERVICES_URL, { credentials: "omit", signal: AbortSignal.timeout(5_000) });
    const services = response.ok ? parseServices(await response.json()) : null;
    if (services) {
      cached = { services, at: now };
      return { services, source: "live" };
    }
  } catch {
    // Offline or blocked: show the bundled copy.
  }
  return { services: BUNDLED, source: "bundled" };
}

export function resetServicesCache(): void {
  cached = null;
}
