import { useEffect, useRef, useState } from "react";
import { useTranslation } from "./i18n.tsx";
import { folderScope, type FolderInfo } from "../folders.ts";
import type { TrashMutationResult, TrashProfileView } from "../proxy-tools-types.ts";
import { proxyResultPage } from "./proxies.tsx";

export function filterTrash(profiles: TrashProfileView[], groups: string[] | null, search: string): TrashProfileView[] {
  const query = search.trim().toLowerCase();
  return profiles.filter((profile) => (groups === null || groups.includes(profile.group)) &&
    (!query || [profile.id, profile.name, profile.group].some((value) => value.toLowerCase().includes(query))));
}

async function trashJson(response: Response): Promise<any> {
  if (!response.ok) throw new Error("Trash could not be loaded or updated. Refresh and try again.");
  const body = await response.json();
  if (!body || body.ok !== true) throw new Error("Trash returned an incomplete response.");
  return body;
}

export function TrashPage({ active, onChanged, folderTree = [] }: { active: boolean; onChanged: () => Promise<void>; folderTree?: FolderInfo[] }) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<TrashProfileView[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState<"load" | "restore" | "purge" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const folderProfiles = filterTrash(profiles, folders, "");
  const filtered = filterTrash(profiles, folders.length ? folders : null, search);
  const paged = proxyResultPage(filtered, page);
  const chosen = profiles.filter((profile) => selected.has(profile.id));
  const folderScopes = new Map(folderTree.map((folder) => [folder.name, folderScope(folderTree, folder.name)]));
  const groups = [...new Set([
    ...profiles.map((profile) => profile.group),
    ...folderTree.filter((folder) => profiles.some((profile) => folderScopes.get(folder.name)!.has(profile.group))).map((folder) => folder.name),
  ])].sort();
  const pageSelected = paged.items.filter((profile) => selected.has(profile.id)).length;
  const allResultsSelected = filtered.length > 0 && filtered.every((profile) => selected.has(profile.id));
  const restoreDenied = chosen.some((profile) => !profile.canRestore);
  const purgeDenied = chosen.some((profile) => !profile.canPurge);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);

  const load = async (signal: AbortSignal) => {
    const body = await trashJson(await fetch("/ui/api/trash", { signal, cache: "no-store" }));
    if (!Array.isArray(body.profiles)) throw new Error(t("Trash returned an incomplete response."));
    if (!signal.aborted) {
      setProfiles(body.profiles);
      const ids = new Set(body.profiles.map((profile: TrashProfileView) => profile.id));
      const remainingFolders = new Set(body.profiles.map((profile: TrashProfileView) => profile.group));
      setFolders((previous) => previous.filter((name) => remainingFolders.has(name) || [...(folderScopes.get(name) ?? [])].some((group) => remainingFolders.has(group))));
      setSelected((previous) => new Set([...previous].filter((id) => ids.has(id))));
    }
  };
  const refresh = async () => {
    if (controller.current) return;
    const current = new AbortController(); controller.current = current;
    setBusy("load"); setError("");
    try { await load(current.signal); }
    catch { if (!current.signal.aborted) setError(t("Trash could not be loaded. Check your connection and try again.")); }
    finally { if (controller.current === current) { controller.current = null; setBusy(null); } }
  };
  useEffect(() => { if (active) void refresh(); }, [active]);

  const mutate = async (action: "restore" | "purge", targets = chosen) => {
    if (controller.current || !targets.length) return;
    if (action === "purge" && !confirm(t("Permanently delete {count} profiles and their saved data? This cannot be undone.", { count: targets.length }))) return;
    const current = new AbortController(); controller.current = current;
    setBusy(action); setError("");
    setNotice(t(action === "restore" ? "Restoring {count} profiles…" : "Permanently deleting {count} profiles…", { count: targets.length.toLocaleString() }));
    try {
      const result = await trashJson(await fetch(`/ui/api/trash/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: current.signal,
        body: JSON.stringify({ ids: targets.map((profile) => profile.id) }),
      })) as TrashMutationResult;
      if (current.signal.aborted) return;
      if (!Array.isArray(result.results) || result.results.length !== targets.length) throw new Error(t("Incomplete result"));
      const failed = result.results.filter((row) => row.status === "failed");
      setSelected(new Set(failed.map((row) => row.id)));
      if (failed.length) { setSearch(""); setPage(0); }
      setNotice(t(action === "restore" ? "{count} profiles restored to their original folders." : "{count} profiles permanently deleted.", { count: (targets.length - failed.length).toLocaleString() }));
      if (failed.length) setError(t(action === "restore" ? "{count} profiles could not be restored. They remain selected. Check folder permissions and close open profiles before retrying." : "{count} profiles could not be deleted. They remain selected. Check folder permissions and close open profiles before retrying.", { count: failed.length.toLocaleString() }));
      await load(current.signal);
      await onChanged();
    } catch {
      if (!current.signal.aborted) {
        setNotice("");
        setError(t("The operation stopped. Some profiles may already be updated. Refresh Trash before retrying."));
        await load(current.signal).catch(() => {});
      }
    } finally { if (controller.current === current) { controller.current = null; setBusy(null); } }
  };

  const changeFolders = (next: string[]) => {
    setFolders(next); setSelected(new Set()); setPage(0); setNotice("");
  };

  return <div className="workspace proxy-page trash-page" hidden={!active}>
    <div className="tools-intro">
      <div><span className="tools-eyebrow">{t("PROFILE RECOVERY")}</span><h2>{t("Pick up where you left off.")}</h2>
        <p>{t("Restore profiles with their saved identity and session, right back to their original folders.")}</p></div>
      <span className="tools-count"><strong>{profiles.length.toLocaleString()}</strong> {t("profiles in Trash")}</span>
    </div>
    {error && <div className="tools-alert" role="alert">{error}</div>}
    {notice && <div className="tools-notice" role="status">{notice}</div>}
    <div className="trash-layout">
      <aside className="tools-panel trash-folders" aria-label={t("Trash folders")}>
        <div className="tools-panel-head"><h3>{t("Restore by folder")}</h3><span>{groups.length}</span></div>
        <p className="tools-hint">{t("Choose folders to restore all their profiles at once.")}</p>
        <button className={`folder-all${!folders.length ? " selected" : ""}`} disabled={!!busy} onClick={() => changeFolders([])}>
          {t("All deleted profiles")} <span>{profiles.length.toLocaleString()}</span>
        </button>
        <div className="trash-folder-list">
          {groups.map((name) => <label className={`folder-choice${folders.includes(name) ? " selected" : ""}`} key={name}>
            <input type="checkbox" aria-label={t("Folder {name}", { name: name || t("Ungrouped") })} disabled={!!busy} checked={folders.includes(name)} onChange={(event) => {
              const branch = new Set([name, ...folderScope(folderTree, name)]);
              changeFolders(event.target.checked ? [...new Set([...folders, ...branch])] : folders.filter((group) => !branch.has(group)));
            }} />
            <span>{name || t("Ungrouped")}</span><small>{profiles.filter((profile) => profile.group === name || folderScopes.get(name)?.has(profile.group)).length.toLocaleString()}</small>
          </label>)}
          {!groups.length && <p className="tools-hint">{t("Deleted folders appear here.")}</p>}
        </div>
        <div className="trash-folder-action">
          <button className="btn primary" disabled={!!busy || !folderProfiles.length || folderProfiles.some((profile) => !profile.canRestore)} onClick={() => void mutate("restore", folderProfiles)}>
            {folders.length ? t("Restore all {count} profiles", { count: folderProfiles.length.toLocaleString() }) : t("Restore selected folders")}
          </button>
          <p className="tools-hint">{folders.length ? (folders.length === 1 ? t("Includes every profile in 1 selected folder, even outside the search results.") : t("Includes every profile in {count} selected folders, even outside the search results.", { count: folders.length })) : t("Select one or more folders above.")}</p>
          {folderProfiles.some((profile) => !profile.canRestore) && <p className="tools-hint">{t("You need edit access to all selected folders.")}</p>}
        </div>
      </aside>
      <section className="tools-panel trash-results" aria-label={t("Deleted profiles")}>
        <div className="tools-panel-head"><div><h3>{folders.length ? t("Selected folders") : t("All deleted profiles")}</h3><p>{filtered.length.toLocaleString()} {search ? t("matching ") : ""}{t("profiles")}</p></div>
          <button className="btn ghost" disabled={!!busy} onClick={() => void refresh()}>{busy === "load" ? t("Loading…") : t("Refresh")}</button></div>
        <div className="trash-search">
          <input className="input" aria-label={t("Search Trash")} type="search" placeholder={t("Search by name, ID, or folder…")} value={search} disabled={!!busy} onChange={(event) => { setSearch(event.target.value); setPage(0); setSelected(new Set()); }} />
          <button className="btn" disabled={!!busy || !filtered.length || allResultsSelected} onClick={() => setSelected(new Set(filtered.map((profile) => profile.id)))}>
            {allResultsSelected ? t("All {count} selected", { count: filtered.length.toLocaleString() }) : t("Select all {count} results", { count: filtered.length.toLocaleString() })}
          </button>
        </div>
        {!!chosen.length && <div className="trash-selection">
          <div className="proxy-actions"><strong>{chosen.length.toLocaleString()} {t("selected")}</strong><button className="tlink" disabled={!!busy} onClick={() => setSelected(new Set())}>{t("Clear")}</button></div>
          <div className="proxy-actions">
            <button className="btn primary" disabled={!!busy || restoreDenied} onClick={() => void mutate("restore")}>{busy === "restore" ? t("Restoring…") : t("Restore {count} profiles", { count: chosen.length.toLocaleString() })}</button>
            <button className="btn ghost trash-purge" disabled={!!busy || purgeDenied} onClick={() => void mutate("purge")}>{t("Delete permanently")}</button>
          </div>
          {(restoreDenied || purgeDenied) && <p className="tools-hint">{restoreDenied ? t("Restore requires edit access to every selected folder. ") : ""}{purgeDenied ? t("Only the workspace owner can permanently delete profiles.") : ""}</p>}
        </div>}
        {filtered.length > 0 ? <>
          <div className="proxy-table-wrap"><table className="profile-table proxy-table trash-table"><thead><tr>
            <th className="tools-checkbox"><input type="checkbox" aria-label={t("Select this page")} disabled={!!busy} checked={pageSelected === paged.items.length} ref={(input) => { if (input) input.indeterminate = pageSelected > 0 && pageSelected < paged.items.length; }} onChange={(event) => {
              const checked = event.target.checked;
              setSelected((previous) => { const next = new Set(previous); for (const profile of paged.items) checked ? next.add(profile.id) : next.delete(profile.id); return next; });
            }} /></th><th>{t("Profile")}</th><th>{t("Original folder")}</th><th>{t("Deleted")}</th></tr></thead>
            <tbody>{paged.items.map((profile) => <tr key={profile.id} className={selected.has(profile.id) ? "is-selected" : ""}>
              <td className="tools-checkbox"><input type="checkbox" aria-label={t("Select {name}", { name: profile.name || profile.id })} disabled={!!busy} checked={selected.has(profile.id)} onChange={(event) => { const checked = event.target.checked; setSelected((previous) => { const next = new Set(previous); checked ? next.add(profile.id) : next.delete(profile.id); return next; }); }} /></td>
              <td><strong>{profile.name || profile.id}</strong><small className="tools-mono">{profile.id}</small></td>
              <td><span className="tools-folder-tag">{profile.group || t("Ungrouped")}</span></td>
              <td><time dateTime={new Date(profile.trashedAt).toISOString()} title={new Date(profile.trashedAt).toLocaleString()}>{new Date(profile.trashedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</time><small>{new Date(profile.trashedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</small></td>
            </tr>)}</tbody></table></div>
          <div className="proxy-pager"><span>{(paged.page * 50 + 1).toLocaleString()}–{Math.min((paged.page + 1) * 50, filtered.length).toLocaleString()} of {filtered.length.toLocaleString()}</span>
            <button className="btn" disabled={paged.page === 0} onClick={() => setPage(paged.page - 1)}>{t("Previous")}</button>
            <span>{paged.page + 1} / {paged.pages}</span>
            <button className="btn" disabled={paged.page + 1 >= paged.pages} onClick={() => setPage(paged.page + 1)}>{t("Next")}</button>
          </div>
        </> : <div className="tools-empty"><span className="tools-empty-symbol" aria-hidden="true">↶</span><h3>{busy === "load" ? t("Loading Trash…") : profiles.length ? t("No matching profiles") : t("Trash is empty")}</h3><p>{profiles.length ? t("Try another folder or search term.") : t("Profiles you move to Trash will appear here. You can restore them at any time.")}</p></div>}
      </section>
    </div>
    <p className="tools-footnote">{t("Restoring keeps saved profile data. Permanent deletion removes it and cannot be undone.")}</p>
  </div>;
}
