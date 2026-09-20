import { useEffect, useRef, useState } from "react";
import type {
  ProxyCheckView,
  ProxyPreview,
  ProxyPreviewInput,
  ProxyProgressEvent,
  ProxyReplacementMode,
  ProxyReplacementView,
  ProxyScope,
} from "../proxy-tools-types.ts";

class ProxyToolsError extends Error {}

const PAGE_SIZE = 50;
const CHECK_LABELS: Record<ProxyCheckView["status"], string> = {
  working: "Alive", failed: "Dead", unstable: "Unstable", unavailable: "Unknown",
  missing: "Missing proxy", invalid: "Invalid proxy", unsupported: "Unsupported",
};
const REASONS: Record<string, string> = {
  authentication_failed: "Authentication failed", timeout: "Timed out", dns_failed: "DNS lookup failed",
  unreachable: "Cannot connect", connection_failed: "Connection failed", intermittent: "Intermittent connection",
  proxy_bypassed: "Connection bypassed the proxy", check_unavailable: "Check service unavailable",
  profile_open: "Close this profile before replacing its proxy", version_conflict: "Profile changed; preview again",
  profile_trashed: "Profile is in Trash", invalid_row: "Invalid input row", invalid_proxy: "Invalid proxy",
  duplicate_selector: "Duplicate input selector", duplicate_target: "Conflicting assignments",
  no_editable_match: "No editable profile matched", ambiguous_username: "More than one profile matched",
  expected_version_required: "Preview this profile again", unsupported: "This proxy type cannot be checked",
  cancelled: "Not completed", folder_access_denied: "Folder access denied",
};

export function proxyScope(all: boolean, groups: string[], ids?: string[]): ProxyScope {
  return { ...(all ? { all: true } : { groups: [...new Set(groups)] }), ...(ids ? { ids: [...new Set(ids)] } : {}) };
}

export function proxyResultPage<T>(rows: T[], requestedPage: number) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), pages - 1);
  return { items: rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), page, pages, total: rows.length };
}

function checkNeedsRetry(row: ProxyCheckView): boolean {
  return row.status === "failed" || row.status === "unstable" || row.status === "unavailable";
}

export function failedProxyProfileIds(rows: ProxyCheckView[]): string[] {
  return [...new Set(rows.filter(checkNeedsRetry).flatMap((row) => row.profiles.map((profile) => profile.id)))];
}

export function mergeProxyCheckResult(rows: ProxyCheckView[], next: ProxyCheckView): ProxyCheckView[] {
  const updatedIds = new Set(next.profiles.map((profile) => profile.id));
  const remaining = rows.flatMap((row) => {
    const profiles = row.profiles.filter((profile) => !updatedIds.has(profile.id));
    return profiles.length ? [{ ...row, profiles }] : [];
  });
  return [...remaining, next];
}

export function retryProxyProfileIds(rows: ProxyReplacementView[]): string[] {
  return [...new Set(rows.filter((row) => row.status === "failed" || row.status === "skipped")
    .flatMap((row) => row.profileId ? [row.profileId] : []))];
}

function proxyRequest(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`/ui/api/proxies/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
}

async function previewResponse(response: Response): Promise<ProxyPreview> {
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new ProxyToolsError("You do not have access to this proxy operation.");
    if (response.status === 404 || response.status === 501 || response.status === 503) throw new ProxyToolsError("Bulk proxy tools are not available on this server.");
    throw new ProxyToolsError("Could not preview replacements. Check the input format and selected folders.");
  }
  let body: ProxyPreview;
  try { body = await response.json(); } catch { throw new ProxyToolsError("The proxy preview returned invalid data."); }
  if (body?.ok !== true || typeof body.previewId !== "string" || !Array.isArray(body.rows) || !Number.isInteger(body.unusedProxies)) {
    throw new ProxyToolsError("The proxy preview returned invalid data.");
  }
  return body;
}

export async function requestProxyPreview(input: ProxyPreviewInput, signal?: AbortSignal): Promise<ProxyPreview> {
  return previewResponse(await proxyRequest("preview", input, signal));
}

export async function readProxyProgress(
  response: Response, onEvent: (event: ProxyProgressEvent) => void, signal?: AbortSignal,
): Promise<void> {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("application/x-ndjson")) {
    throw new ProxyToolsError("The proxy operation could not start. Check your connection and server version.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let done = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  const accept = (line: string) => {
    if (!line.trim()) return;
    let event: ProxyProgressEvent;
    try { event = JSON.parse(line); } catch { throw new ProxyToolsError("The proxy operation returned incomplete data."); }
    if (!event || typeof event !== "object" || done) throw new ProxyToolsError("The proxy operation returned invalid data.");
    switch (event.type) {
      case "progress":
        if (!["loading", "checking", "applying"].includes(event.phase) || !Number.isFinite(event.completed) || !Number.isFinite(event.total)) throw new ProxyToolsError("Invalid proxy progress.");
        break;
      case "summary":
        if (![event.selectedProfiles, event.uniqueProxies, event.duplicatesSkipped].every(Number.isFinite)) throw new ProxyToolsError("Invalid proxy summary.");
        break;
      case "check":
        if (!event.row || !Object.hasOwn(CHECK_LABELS, event.row.status) || !Array.isArray(event.row.profiles)) throw new ProxyToolsError("Invalid proxy check result.");
        break;
      case "replacement":
        if (!event.row || !Number.isInteger(event.row.index) || !["ready", "updated", "unchanged", "missing", "skipped", "failed"].includes(event.row.status)) throw new ProxyToolsError("Invalid proxy replacement result.");
        break;
      case "done": done = true; break;
      case "error": throw new ProxyToolsError("The proxy operation failed. Completed results remain available.");
      default: throw new ProxyToolsError("The proxy operation returned invalid data.");
    }
    onEvent(event);
  };
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const chunk = await reader.read();
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        accept(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) accept(pending);
    if (!done) throw new ProxyToolsError("The proxy operation was interrupted. Some rows were not completed.");
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (page: number) => void }) {
  return <div className="proxy-pager">
    <span>{total.toLocaleString()} rows</span>
    <button type="button" className="btn" disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</button>
    <span>Page {page + 1} / {pages}</span>
    <button type="button" className="btn" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>Next</button>
  </div>;
}

function AffectedProfiles({ profiles }: { profiles: ProxyCheckView["profiles"] }) {
  const [page, setPage] = useState(0);
  const result = proxyResultPage(profiles, page);
  const folders = [...new Set(profiles.map((profile) => profile.group || "Ungrouped"))];
  return <details className="proxy-affected">
    <summary>{profiles.length.toLocaleString()} profiles · {folders.length} folders</summary>
    <div>{folders.join(", ")}</div>
    <ul>{result.items.map((profile) => <li key={profile.id}>{profile.name || profile.id} · {profile.group || "Ungrouped"}</li>)}</ul>
    {result.pages > 1 && <Pager {...result} onPage={setPage} />}
  </details>;
}

export function ProxiesPage({ groups, onChanged, active }: {
  groups: string[];
  onChanged: () => Promise<void>;
  active: boolean;
}) {
  const [all, setAll] = useState(true);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [mode, setMode] = useState<ProxyReplacementMode>("profileId");
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<ProxyPreview | null>(null);
  const [checks, setChecks] = useState<ProxyCheckView[]>([]);
  const [checkSummary, setCheckSummary] = useState<Extract<ProxyProgressEvent, { type: "summary" }> | null>(null);
  const [progress, setProgress] = useState<Extract<ProxyProgressEvent, { type: "progress" }> | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | "check" | "file" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [replacementPage, setReplacementPage] = useState(0);
  const [checkPage, setCheckPage] = useState(0);
  const [replacementFailures, setReplacementFailures] = useState(false);
  const [checkFailures, setCheckFailures] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const scope = proxyScope(all, selectedGroups);
  const scopeReady = all || selectedGroups.length > 0;
  const folderNames = [...new Set(groups)];
  const retries = retryProxyProfileIds(preview?.rows ?? []);
  const failedChecks = failedProxyProfileIds(checks);
  const replacements = proxyResultPage((preview?.rows ?? []).filter((row) => !replacementFailures || ["failed", "skipped", "missing"].includes(row.status)), replacementPage);
  const checkResults = proxyResultPage(checks.filter((row) => !checkFailures || row.status !== "working"), checkPage);
  const ready = preview?.rows.filter((row) => row.status === "ready").length ?? 0;

  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);

  const invalidatePreview = () => {
    setPreview(null); setReplacementPage(0); setError(null); setNotice(null);
  };
  const invalidateScope = () => {
    invalidatePreview(); setChecks([]); setCheckSummary(null); setCheckPage(0); setProgress(null);
  };
  const start = (operation: NonNullable<typeof busy>) => {
    if (controller.current) return null;
    const current = new AbortController();
    controller.current = current;
    setBusy(operation); setError(null); setNotice(null); setProgress(null);
    return current;
  };
  const finish = (current: AbortController) => {
    if (controller.current !== current) return;
    controller.current = null; setBusy(null);
  };
  const failed = (current: AbortController, operation: string, failure: unknown) => {
    if (controller.current !== current) return;
    // Raw fetch errors can include URLs. Only fixed client messages reach the page.
    if (current.signal.aborted) setNotice("Cancelled. Completed results remain saved; some rows may be incomplete.");
    else if (failure instanceof ProxyToolsError) setError(failure.message);
    else setError(`${operation} failed. Check the input, folder access, and connection, then try again.`);
  };

  const makePreview = async (retry = false) => {
    const current = start("preview");
    if (!current) return;
    try {
      const next = retry && preview
        ? await previewResponse(await proxyRequest("retry-preview", { previewId: preview.previewId, ids: retries }, current.signal))
        : await requestProxyPreview({ scope, mode, input }, current.signal);
      if (controller.current !== current || current.signal.aborted) return;
      setPreview(next); setReplacementPage(0); setReplacementFailures(false);
      setNotice("Review these assignments before applying. Open profiles are skipped.");
    } catch (failure) { failed(current, "Preview", failure); }
    finally { finish(current); }
  };

  const apply = async () => {
    if (!preview || !ready) return;
    const current = start("apply");
    if (!current) return;
    setChecks([]); setCheckSummary(null); setCheckPage(0);
    try {
      await readProxyProgress(await proxyRequest("apply", { previewId: preview.previewId }, current.signal), (event) => {
        if (controller.current !== current) return;
        if (event.type === "progress") setProgress(event);
        if (event.type === "replacement") setPreview((previous) => previous && ({
          ...previous, rows: previous.rows.map((row) => row.index === event.row.index ? event.row : row),
        }));
      }, current.signal);
      if (controller.current === current) setNotice("Replacement run finished. Review the results for skipped or failed profiles.");
    } catch (failure) { failed(current, "Replacement", failure); }
    finally {
      if (controller.current === current) {
        try { await onChanged(); } catch { setError("Results are saved, but the profile list could not refresh."); }
      }
      finish(current);
    }
  };

  const runChecks = async (retry = false) => {
    const current = start("check");
    if (!current) return;
    if (!retry) setChecks([]);
    setCheckSummary(null); setCheckPage(0);
    try {
      await readProxyProgress(await proxyRequest("check", {
        scope: proxyScope(all, selectedGroups, retry ? failedChecks : undefined),
      }, current.signal), (event) => {
        if (controller.current !== current) return;
        if (event.type === "progress") setProgress(event);
        if (event.type === "summary") setCheckSummary(event);
        if (event.type === "check") setChecks((rows) => retry ? mergeProxyCheckResult(rows, event.row) : [...rows, event.row]);
      }, current.signal);
      if (controller.current === current) setNotice("Proxy checks finished. Unknown means the check could not establish a result.");
    } catch (failure) { failed(current, "Proxy check", failure); }
    finally { finish(current); }
  };

  const loadFile = async (file: File) => {
    const current = start("file");
    if (!current) return;
    invalidatePreview();
    try {
      const text = await file.text();
      if (controller.current === current && !current.signal.aborted) setInput(text);
    } catch { if (controller.current === current) setError("The selected file could not be read."); }
    finally { finish(current); }
  };

  return <div className="workspace proxy-page" hidden={!active}>
    <h2 className="sect-title">Proxies</h2>
    <p className="cardnote">Replace or check proxies across complete folders. Shared proxies are checked once, including their login settings.</p>
    <section className="settings-card">
      <header><h2>Folders</h2></header>
      <div className="card-body">
        <label className="proxy-choice"><input type="checkbox" checked={all} disabled={!!busy} onChange={(event) => { setAll(event.target.checked); invalidateScope(); }} />All folders</label>
        <div className="proxy-folder-list">
          {folderNames.map((name) => <label className="proxy-choice" key={name}>
            <input type="checkbox" checked={all || selectedGroups.includes(name)} disabled={!!busy || all} onChange={(event) => {
              setSelectedGroups((previous) => event.target.checked ? [...previous, name] : previous.filter((group) => group !== name));
              invalidateScope();
            }} />{name || "Ungrouped"}
          </label>)}
        </div>
        <p className="cardnote">{all ? "All accessible profiles are included, not just the current table page." : `${selectedGroups.length} folders selected.`}</p>
      </div>
    </section>
    {error && <div className="modal-err" role="alert">{error}</div>}
    {notice && <p className="formnote" role="status">{notice}</p>}
    {busy && <div className="proxy-actions" role="status">
      <span>{progress ? `${progress.phase === "loading" ? "Loading profiles" : progress.phase === "checking" ? "Checking proxies" : "Applying replacements"}: ${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}` : "Preparing…"}</span>
      <button type="button" className="btn" onClick={() => controller.current?.abort()}>Cancel</button>
    </div>}
    <section className="settings-card">
      <header><h2>Bulk replacement</h2></header>
      <div className="card-body">
        <label className="fld"><span>Match replacements</span>
          <select value={mode} disabled={!!busy} onChange={(event) => { setMode(event.target.value as ProxyReplacementMode); invalidatePreview(); }}>
            <option value="profileId">By profile ID</option><option value="oldProxy">By old proxy</option><option value="list">Assign a proxy list</option>
          </select>
        </label>
        <p className="cardnote">{mode === "profileId" ? <>CSV headers: <code>profileId,type,host,port,user,pass</code>.</>
          : mode === "oldProxy" ? <>CSV headers: <code>oldProxy,newProxy</code>. Use full proxy URLs or <code>host:port:user:password</code>.</>
          : "One proxy per line. Profiles are matched in profile-ID order. Review the exact assignments before applying."}</p>
        <label className="fld"><span>Replacement input</span><textarea rows={5} value={input} disabled={!!busy} spellCheck={false} autoComplete="off" onChange={(event) => { setInput(event.target.value); invalidatePreview(); }} /></label>
        <div className="proxy-actions">
          <label className="proxy-upload">Upload a CSV or text file<input type="file" accept=".csv,.txt,text/csv,text/plain" disabled={!!busy} onChange={(event) => {
            const file = event.target.files?.[0]; event.target.value = ""; if (file) void loadFile(file);
          }} /></label>
          <button type="button" className="btn" disabled={!!busy || !scopeReady || !input.trim()} onClick={() => void makePreview()}>Preview replacements</button>
          <button type="button" className="btn primary" disabled={!!busy || !ready} onClick={() => void apply()}>Apply {ready.toLocaleString()} ready replacements</button>
        </div>
        {preview && <>
          <div className="proxy-actions">
            <span>{preview.rows.length.toLocaleString()} assignments · {preview.unusedProxies.toLocaleString()} unused proxies</span>
            <label className="proxy-choice"><input type="checkbox" checked={replacementFailures} onChange={(event) => { setReplacementFailures(event.target.checked); setReplacementPage(0); }} />Only problems</label>
            <button type="button" className="btn" disabled={!!busy || !retries.length} onClick={() => void makePreview(true)}>Preview failed rows again</button>
          </div>
          <div className="proxy-table-wrap"><table className="profile-table proxy-table"><thead><tr><th>Profile</th><th>Folder</th><th>Current proxy</th><th>Replacement</th><th>Result</th></tr></thead>
            <tbody>{replacements.items.map((row) => <tr key={row.index}>
              <td>{row.name || row.profileId || `Input row ${row.index + 1}`}<small>{row.name ? row.profileId : ""}</small></td>
              <td>{row.group === undefined ? "—" : row.group || "Ungrouped"}</td><td>{row.previousProxy || "—"}</td><td>{row.proxy || "—"}</td>
              <td>{row.status}<small>{row.code ? REASONS[row.code] || "Could not apply this row" : ""}</small></td>
            </tr>)}</tbody></table></div>
          <Pager {...replacements} onPage={setReplacementPage} />
        </>}
      </div>
    </section>
    <section className="settings-card">
      <header><h2>Bulk proxy check</h2></header>
      <div className="card-body">
        <p className="cardnote">Checks saved HTTP and SOCKS5 proxies without opening browsers. HTTPS checks are unsupported. This does not change assignments.</p>
        <div className="proxy-actions">
          <button type="button" className="btn primary" disabled={!!busy || !scopeReady} onClick={() => void runChecks()}>Check selected folders</button>
          <button type="button" className="btn" disabled={!!busy || !failedChecks.length} onClick={() => void runChecks(true)}>Retry failed checks</button>
          <label className="proxy-choice"><input type="checkbox" checked={checkFailures} onChange={(event) => { setCheckFailures(event.target.checked); setCheckPage(0); }} />Only problems</label>
        </div>
        {checkSummary && <p className="cardnote">Last check batch: {checkSummary.selectedProfiles.toLocaleString()} profiles · {checkSummary.uniqueProxies.toLocaleString()} unique proxies · {checkSummary.duplicatesSkipped.toLocaleString()} duplicates skipped</p>}
        {!!checks.length && <>
          <div className="proxy-table-wrap"><table className="profile-table proxy-table"><thead><tr><th>Proxy</th><th>Result</th><th>Exit IP</th><th>Profiles</th><th>Checked</th></tr></thead>
            <tbody>{checkResults.items.map((row) => <tr key={`${row.key}-${row.profiles[0]?.id}`}>
              <td>{row.proxy || "—"}</td><td>{CHECK_LABELS[row.status]}<small>{row.reason ? REASONS[row.reason] || "Check could not complete" : ""}</small></td>
              <td>{row.ip || "—"}{row.country && <small>{row.country}</small>}</td><td><AffectedProfiles profiles={row.profiles} /></td>
              <td>{new Date(row.checkedAt).toLocaleString()}</td>
            </tr>)}</tbody></table></div>
          <Pager {...checkResults} onPage={setCheckPage} />
        </>}
      </div>
    </section>
  </div>;
}
