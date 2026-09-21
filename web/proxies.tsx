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
const REPLACEMENT_LABELS: Record<ProxyReplacementView["status"], string> = {
  ready: "Ready", updated: "Updated", unchanged: "No change", missing: "No match", skipped: "Skipped", failed: "Failed",
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
  const [task, setTask] = useState<"check" | "replace">("check");
  const [mode, setMode] = useState<ProxyReplacementMode>("list");
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
    <div className="tools-intro"><div><span className="tools-eyebrow">PROXY TOOLS</span><h2>Keep your profiles connected.</h2><p>Check saved connections or replace proxies across entire folders.</p></div></div>
    <div className="tools-tabs" aria-label="Proxy tools">
      <button className={task === "check" ? "selected" : ""} aria-pressed={task === "check"} onClick={() => setTask("check")}>Check proxies <small>Find connection problems</small></button>
      <button className={task === "replace" ? "selected" : ""} aria-pressed={task === "replace"} onClick={() => setTask("replace")}>Replace proxies <small>Assign new connections</small></button>
    </div>
    <section className="tools-panel proxy-scope">
      <div className="tools-panel-head"><div><h3>{task === "replace" && <span className="tools-step">1</span>}Choose folders</h3><p>Includes every profile in these folders, across all pages.</p></div><span className="tools-folder-tag">{all ? "All folders" : `${selectedGroups.length} selected`}</span></div>
      <div className="proxy-folder-list">
        <label className={`folder-chip${all ? " selected" : ""}`}><input type="checkbox" checked={all} disabled={!!busy} onChange={(event) => { setAll(event.target.checked); setSelectedGroups([]); invalidateScope(); }} />All folders</label>
        {folderNames.map((name) => <label className={`folder-chip${!all && selectedGroups.includes(name) ? " selected" : ""}`} key={name}>
          <input type="checkbox" checked={all || selectedGroups.includes(name)} disabled={!!busy} onChange={(event) => {
            setSelectedGroups(all ? folderNames.filter((group) => group !== name) : event.target.checked ? [...selectedGroups, name] : selectedGroups.filter((group) => group !== name));
            setAll(false); invalidateScope();
          }} />{name || "Ungrouped"}
        </label>)}
      </div>
      {!scopeReady && <p className="tools-hint">Select at least one folder to continue.</p>}
    </section>
    {error && <div className="tools-alert" role="alert">{error}</div>}
    {notice && <div className="tools-notice" role="status">{notice}</div>}
    {busy && <div className="tools-progress" role="status">
      <div className="proxy-actions"><strong>{progress ? `${progress.phase === "loading" ? "Loading profiles" : progress.phase === "checking" ? "Checking proxies" : "Applying changes"}: ${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}` : "Preparing…"}</strong>
        <button type="button" className="btn" onClick={() => controller.current?.abort()}>Cancel</button></div>
      <progress aria-label="Proxy operation progress" {...(progress && progress.total > 0 ? { value: progress.completed, max: progress.total } : {})} />
    </div>}
    {task === "check" ? <>
      <section className="tools-panel">
        <div className="tools-panel-head"><div><h3>Check your connections</h3><p>Shared proxies are checked once. No browsers open and no settings change.</p></div>
          <button type="button" className="btn primary" disabled={!!busy || !scopeReady} onClick={() => void runChecks()}>{busy === "check" ? "Checking…" : "Check proxies"}</button></div>
        {checkSummary && <div className="tools-stats">
          <div><strong>{checkSummary.selectedProfiles.toLocaleString()}</strong><span>Profiles included</span></div>
          <div><strong>{checkSummary.uniqueProxies.toLocaleString()}</strong><span>Unique proxies</span></div>
          <div><strong>{checkSummary.duplicatesSkipped.toLocaleString()}</strong><span>Duplicate checks avoided</span></div>
          <div><strong>{checks.filter((row) => row.status === "working").length.toLocaleString()}</strong><span>Alive</span></div>
        </div>}
        {checks.length > 0 ? <>
          <div className="tools-result-bar"><h3>Check results</h3><div className="proxy-actions">
            <label className="proxy-choice"><input type="checkbox" checked={checkFailures} onChange={(event) => { setCheckFailures(event.target.checked); setCheckPage(0); }} />Only problems</label>
            <button type="button" className="btn" disabled={!!busy || !failedChecks.length} onClick={() => void runChecks(true)}>Retry failed checks</button>
          </div></div>
          <div className="proxy-table-wrap"><table className="profile-table proxy-table"><thead><tr><th>Proxy address</th><th>Connection</th><th>Exit IP</th><th>Used by</th><th>Checked</th></tr></thead>
            <tbody>{checkResults.items.map((row) => <tr key={`${row.key}-${row.profiles[0]?.id}`}>
              <td className="tools-mono">{row.proxy || "No proxy assigned"}</td><td><span className={`tools-status ${row.status}`}>{CHECK_LABELS[row.status]}</span><small>{row.reason ? REASONS[row.reason] || "Check could not complete" : ""}</small></td>
              <td className="tools-mono">{row.ip || "—"}{row.country && <small>{row.country}</small>}</td><td><AffectedProfiles profiles={row.profiles} /></td>
              <td>{new Date(row.checkedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</td>
            </tr>)}</tbody></table></div>
          {!checkResults.total && <p className="tools-hint tools-result-empty">No problems found in the completed checks.</p>}
          <Pager {...checkResults} onPage={setCheckPage} />
        </> : <div className="tools-empty"><span className="tools-empty-symbol" aria-hidden="true">↗</span><h3>{busy === "check" ? "Checking selected folders…" : "Ready when you are"}</h3><p>Choose your folders above, then check which proxies are alive, dead, or need attention.</p></div>}
      </section>
      <p className="tools-footnote">Supports HTTP and SOCKS5. HTTPS checks are not supported. Unknown means a result could not be confirmed.</p>
    </> : <>
      <section className="tools-panel proxy-input-panel">
        <div className="tools-panel-head"><div><h3><span className="tools-step">2</span>Add replacement proxies</h3><p>Nothing changes until you review and apply the assignments.</p></div></div>
        <div className="tools-panel-body">
          <label className="fld"><span>Assignment method</span><select value={mode} disabled={!!busy} onChange={(event) => { setMode(event.target.value as ProxyReplacementMode); invalidatePreview(); }}>
            <option value="list">One proxy per profile — paste a list</option><option value="profileId">Match specific profile IDs — CSV</option><option value="oldProxy">Replace matching old proxies — CSV</option>
          </select></label>
          <p className="tools-hint">{mode === "profileId" ? <>Include a header row: <code>profileId,type,host,port,user,pass</code>.</>
            : mode === "oldProxy" ? <>Include a header row: <code>oldProxy,newProxy</code>. Each old proxy is replaced wherever it appears in the selected folders.</>
            : "Paste one proxy per line. We match them to profiles in profile-ID order, without reusing entries. You will see every assignment next."}</p>
          <label className="fld"><span>{mode === "list" ? "Your new proxy list" : "Your replacement CSV"}</span><textarea aria-label="Replacement input" rows={5} value={input} disabled={!!busy} spellCheck={false} autoComplete="off" placeholder={mode === "list" ? "proxy.example.com:8080:username:password\nsocks5://username:password@proxy.example.com:1080" : mode === "profileId" ? "profileId,type,host,port,user,pass" : "oldProxy,newProxy"} onChange={(event) => { setInput(event.target.value); invalidatePreview(); }} /></label>
          <div className="tools-result-bar"><label className="proxy-upload">Or upload a file<input type="file" accept=".csv,.txt,text/csv,text/plain" disabled={!!busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void loadFile(file); }} /></label>
            <button type="button" className="btn primary" disabled={!!busy || !scopeReady || !input.trim()} onClick={() => void makePreview()}>{busy === "preview" ? "Preparing preview…" : "Preview changes"}</button></div>
        </div>
      </section>
      <section className="tools-panel">
        <div className="tools-panel-head"><div><h3><span className="tools-step">3</span>Review changes</h3><p>Check the old and new proxy for each profile. Open profiles are skipped.</p></div>
          {preview && <button type="button" className="btn primary" disabled={!!busy || !ready} onClick={() => void apply()}>{busy === "apply" ? "Applying…" : `Apply ${ready.toLocaleString()} changes`}</button>}</div>
        {preview ? <>
          <div className="tools-stats">
            <div><strong>{ready.toLocaleString()}</strong><span>Ready to apply</span></div>
            <div><strong>{preview.rows.filter((row) => row.status === "updated").length.toLocaleString()}</strong><span>Updated</span></div>
            <div><strong>{preview.rows.filter((row) => ["skipped", "failed", "missing"].includes(row.status)).length.toLocaleString()}</strong><span>Need attention</span></div>
            <div><strong>{preview.rows.filter((row) => row.status === "unchanged").length.toLocaleString()}</strong><span>Unchanged</span></div>
          </div>
          <div className="tools-result-bar"><span className="tools-hint">{preview.rows.length.toLocaleString()} assignments · {preview.unusedProxies.toLocaleString()} unused proxies</span><div className="proxy-actions">
            <label className="proxy-choice"><input type="checkbox" checked={replacementFailures} onChange={(event) => { setReplacementFailures(event.target.checked); setReplacementPage(0); }} />Only problems</label>
            <button type="button" className="btn" disabled={!!busy || !retries.length} onClick={() => void makePreview(true)}>Preview failed rows again</button>
          </div></div>
          <div className="proxy-table-wrap"><table className="profile-table proxy-table"><thead><tr><th>Profile</th><th>Folder</th><th>Current proxy</th><th>New proxy</th><th>Status</th></tr></thead>
            <tbody>{replacements.items.map((row) => <tr key={row.index}>
              <td><strong>{row.name || row.profileId || `Input row ${row.index + 1}`}</strong><small className="tools-mono">{row.name ? row.profileId : ""}</small></td>
              <td>{row.group === undefined ? "—" : row.group || "Ungrouped"}</td><td className="tools-mono">{row.previousProxy || "—"}</td><td className="tools-mono">{row.proxy || "—"}</td>
              <td><span className={`tools-status ${row.status}`}>{REPLACEMENT_LABELS[row.status]}</span><small>{row.code ? REASONS[row.code] || "Could not apply this row" : ""}</small></td>
            </tr>)}</tbody></table></div>
          <Pager {...replacements} onPage={setReplacementPage} />
        </> : <div className="tools-empty compact"><p>Your preview will appear here. Saved sessions and fingerprints stay unchanged.</p></div>}
      </section>
    </>}
  </div>;
}
