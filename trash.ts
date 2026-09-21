import { CloudApiError } from "./cloud-client.ts";
import { isSafeProfileId } from "./profile-id.ts";
import type { Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import type { UiRuntimeOptions } from "./ui.ts";
import type { TrashMutationResult, TrashProfileView } from "./proxy-tools-types.ts";

export async function handleTrashRequest(req: Request, store: ProfileStore, launcher: Launcher, options: UiRuntimeOptions): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  const cloud = options.cloudBrowser ? options.cloudConnection?.client : undefined;
  const transition = cloud && req.method !== "GET" ? await options.cloudAuth?.acquireTransition() : undefined;
  const accountId = cloud ? options.cloudConnection!.accountId() : undefined;
  try {
    const status = cloud ? await cloud.status() : undefined;
    const current = () => !req.signal.aborted && (!transition || options.cloudAuth!.isTransitionCurrent(transition)) &&
      (!status || (options.cloudConnection?.accountId() === accountId && status.account.id === accountId));
    if (!current()) return json({ ok: false, error: "Account changed; reload Trash" }, 409);
    const profiles: TrashProfileView[] = cloud
      ? (await cloud.listProfiles()).profiles.filter((p) => p.trashedAt !== null).map((p) => ({
        id: p.id, name: p.name, group: p.group, trashedAt: p.trashedAt!, version: p.version,
        canRestore: p.permission === "edit", canPurge: status!.workspace.role === "owner",
      }))
      : store.listTrashed().map((p) => ({ ...p, canRestore: true, canPurge: true }));
    if (!current()) return json({ ok: false, error: "Account changed; reload Trash" }, 409);
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/ui/api/trash") return json({ ok: true, profiles });
    if (req.method !== "POST" || !["/ui/api/trash/restore", "/ui/api/trash/purge"].includes(path)) return json({ ok: false, error: "Unknown Trash operation" }, 404);
    const body = await req.json();
    if (!Array.isArray(body?.ids) || !body.ids.length || body.ids.some((id: unknown) => typeof id !== "string" || !isSafeProfileId(id))) return json({ ok: false, error: "Select profiles in Trash" }, 400);
    const purge = path.endsWith("/purge");
    const byId = new Map(profiles.map((p) => [p.id, p]));
    const ids = [...new Set<string>(body.ids)];
    const results: TrashMutationResult["results"] = [];
    const mutate = async (id: string): Promise<TrashMutationResult["results"][number]> => {
      if (!current()) return { id, status: "failed", code: "cancelled" };
      const profile = byId.get(id);
      if (!profile) return { id, status: "failed", code: "not_in_trash" };
      if (purge ? !profile.canPurge : !profile.canRestore) return { id, status: "failed", code: "permission_denied" };
      if (launcher.profileDeletionBlocked(id)) return { id, status: "failed", code: "profile_open" };
      try {
        if (cloud) {
          if (purge) await cloud.purgeProfile(id, profile.version!);
          else await cloud.restoreProfile(id, { expectedVersion: profile.version! });
        } else if (purge) {
          if (!store.isTrashed(id)) return { id, status: "failed", code: "not_in_trash" };
          if (!launcher.removeUserDataDir(id)) throw new Error("cleanup refused");
          store.deleteProfile(id);
        } else if (!store.restoreProfile(id)) {
          return { id, status: "failed", code: "not_in_trash" };
        }
        return { id, status: purge ? "purged" : "restored" };
      } catch (error) {
        return { id, status: "failed", code: error instanceof CloudApiError ? error.code : "operation_failed" };
      }
    };
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const index = cursor++;
        results[index] = await mutate(ids[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(cloud ? 4 : 1, ids.length) }, worker));
    if (!current()) return json({ ok: false, error: "Account changed; reload Trash" }, 409);
    return json({ ok: true, results } satisfies TrashMutationResult);
  } catch {
    return json({ ok: false, error: "Trash could not be updated. Refresh and try again." }, 500);
  } finally { transition?.release(); }
}
