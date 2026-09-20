import { useEffect, useRef, useState } from "react";
import type { TrashMutationResult, TrashProfileView } from "../proxy-tools-types.ts";
import { proxyResultPage } from "./proxies.tsx";

export function filterTrash(profiles: TrashProfileView[], group: string | null, search: string): TrashProfileView[] {
  const query = search.trim().toLowerCase();
  return profiles.filter((profile) => (group === null || profile.group === group) &&
    (!query || [profile.id, profile.name, profile.group].some((value) => value.toLowerCase().includes(query))));
}

async function trashJson(response: Response): Promise<any> {
  if (!response.ok) throw new Error("Trash could not be loaded or updated. Refresh and try again.");
  const body = await response.json();
  if (!body || body.ok !== true) throw new Error("Trash returned an incomplete response.");
  return body;
}

export function TrashPage({ active, onChanged }: { active: boolean; onChanged: () => Promise<void> }) {
  const [profiles, setProfiles] = useState<TrashProfileView[]>([]);
  const [group, setGroup] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const filtered = filterTrash(profiles, group, search);
  const paged = proxyResultPage(filtered, page);
  const chosen = profiles.filter((profile) => selected.has(profile.id));
  const groups = [...new Set(profiles.map((profile) => profile.group))].sort();
  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);

  const load = async (signal: AbortSignal) => {
    const body = await trashJson(await fetch("/ui/api/trash", { signal, cache: "no-store" }));
    if (!Array.isArray(body.profiles)) throw new Error("Trash returned an incomplete response.");
    if (!signal.aborted) setProfiles(body.profiles);
  };
  const refresh = async () => {
    if (controller.current) return;
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError("");
    try { await load(current.signal); }
    catch { if (!current.signal.aborted) setError("Trash could not be loaded. Check your connection and try again."); }
    finally { if (controller.current === current) { controller.current = null; setBusy(false); } }
  };
  useEffect(() => { if (active) void refresh(); }, [active]);

  const mutate = async (action: "restore" | "purge") => {
    if (controller.current || !chosen.length) return;
    if (action === "purge" && !confirm(`Permanently delete ${chosen.length} profiles and their saved data? This cannot be undone.`)) return;
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError(""); setProgress("");
    const failed: string[] = [];
    let completed = 0;
    try {
      // Keep each request short while allowing a selection of any size.
      for (let offset = 0; offset < chosen.length; offset += 16) {
        if (current.signal.aborted) break;
        const batch = chosen.slice(offset, offset + 16);
        const result = await trashJson(await fetch(`/ui/api/trash/${action}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: current.signal,
          body: JSON.stringify({ ids: batch.map((profile) => profile.id) }),
        })) as TrashMutationResult;
        if (!Array.isArray(result.results) || result.results.length !== batch.length) throw new Error("Incomplete result");
        for (const row of result.results) if (row.status === "failed") failed.push(row.id);
        completed += batch.length;
        if (!current.signal.aborted) setProgress(`${completed.toLocaleString()} / ${chosen.length.toLocaleString()} processed`);
      }
      if (current.signal.aborted) return;
      setSelected(new Set(failed));
      if (failed.length) setError(`${failed.length} profiles could not be ${action === "restore" ? "restored" : "deleted"}. Check folder permissions and close open profiles before retrying.`);
      await load(current.signal);
      await onChanged();
    } catch {
      if (!current.signal.aborted) {
        setError("The operation stopped. Some profiles may already be updated. Refresh Trash before retrying.");
        await load(current.signal).catch(() => {});
      }
    } finally { if (controller.current === current) { controller.current = null; setBusy(false); } }
  };

  return <div className="workspace proxy-page" hidden={!active}>
    <h2 className="sect-title">Trash</h2>
    <p className="cardnote">Restore deleted profiles with their saved identity and session. Permanent deletion cannot be undone.</p>
    <section className="settings-card"><div className="card-body">
      <div className="proxy-actions">
        <label className="fld"><span>Folder</span><select value={group === null ? "all" : `group:${group}`} disabled={busy} onChange={(event) => { setGroup(event.target.value === "all" ? null : event.target.value.slice(6)); setPage(0); setSelected(new Set()); }}>
          <option value="all">All folders</option>{groups.map((name) => <option key={name} value={`group:${name}`}>{name || "Ungrouped"}</option>)}
        </select></label>
        <label className="fld"><span>Search</span><input value={search} disabled={busy} onChange={(event) => { setSearch(event.target.value); setPage(0); setSelected(new Set()); }} /></label>
        <button className="btn" disabled={busy} onClick={() => void refresh()}>Refresh</button>
      </div>
      {error && <p className="modal-err" role="alert">{error}</p>}
      {progress && <p role="status">{progress}</p>}
      <div className="proxy-actions">
        <span>{chosen.length.toLocaleString()} selected</span>
        <button className="btn" disabled={busy || !filtered.length} onClick={() => setSelected(new Set(filtered.map((p) => p.id)))}>Select all results</button>
        <button className="btn" disabled={busy || !selected.size} onClick={() => setSelected(new Set())}>Clear selection</button>
        <button className="btn primary" disabled={busy || !chosen.length || chosen.some((p) => !p.canRestore)} onClick={() => void mutate("restore")}>Restore selected</button>
        <button className="btn danger" disabled={busy || !chosen.length || chosen.some((p) => !p.canPurge)} onClick={() => void mutate("purge")}>Delete permanently</button>
      </div>
      <div className="proxy-table-wrap"><table className="profile-table proxy-table"><thead><tr><th>Select</th><th>Profile</th><th>Folder</th><th>Deleted</th></tr></thead>
        <tbody>{paged.items.map((profile) => <tr key={profile.id}>
          <td><input type="checkbox" aria-label={`Select ${profile.name || profile.id}`} disabled={busy} checked={selected.has(profile.id)} onChange={(event) => setSelected((previous) => { const next = new Set(previous); event.target.checked ? next.add(profile.id) : next.delete(profile.id); return next; })} /></td>
          <td>{profile.name || profile.id}<small>{profile.id}</small></td><td>{profile.group || "Ungrouped"}</td><td>{new Date(profile.trashedAt).toLocaleString()}</td>
        </tr>)}</tbody></table></div>
      {!profiles.length && !busy && <p className="cardnote">Trash is empty.</p>}
      <div className="proxy-pager"><span>{filtered.length.toLocaleString()} profiles</span>
        <button className="btn" disabled={paged.page === 0} onClick={() => setPage(paged.page - 1)}>Previous</button>
        <span>Page {paged.page + 1} / {paged.pages}</span>
        <button className="btn" disabled={paged.page + 1 >= paged.pages} onClick={() => setPage(paged.page + 1)}>Next</button>
      </div>
    </div></section>
  </div>;
}
