import { useEffect, useRef, useState } from "react";
import type {
  PublishedScript,
  PublishedScriptSummary,
  ScriptLanguage,
  ScriptRecord,
  ScriptSummary,
} from "../contracts/cloud-v1.ts";
import type { ScriptRun } from "../scripts.ts";
import type { PythonRuntimeStatus } from "../python-runtime.ts";
import type { UiProfile } from "./api.ts";
import { useTranslation } from "./i18n.tsx";
import {
  createScript,
  deleteScript,
  downloadPythonRuntime,
  fetchPublishedScript,
  fetchPublishedScripts,
  fetchPythonRuntime,
  fetchScript,
  fetchScriptLibraryInfo,
  fetchScripts,
  fetchScriptLog,
  fetchScriptRun,
  importPublishedScript,
  publishScript,
  scriptsDesktopAvailable,
  startScriptRun,
  stopScriptRun,
  unpublishScript,
  updateScript,
} from "./api.ts";

function languageFor(file: File): ScriptLanguage | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".js") || name.endsWith(".mjs")) return "javascript";
  if (name.endsWith(".py")) return "python";
  return null;
}

function fileTitle(file: File): string {
  return file.name.replace(/\.(?:mjs|js|py)$/i, "") || file.name;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ScriptsTab = "mine" | "library";

function languageName(language: ScriptLanguage): string {
  return language === "python" ? "Python" : "JavaScript";
}

function publicationPending(script: ScriptRecord): boolean {
  return script.publishedRevision !== null && script.publishedRevision !== undefined && script.publishedRevision !== script.revision;
}

/** The Python runtime status while `active`; polls while it downloads. */
function usePythonRuntime(active: boolean): [PythonRuntimeStatus | null, () => void] {
  const [status, setStatus] = useState<PythonRuntimeStatus | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: number | undefined;
    const poll = () => {
      void fetchPythonRuntime().then((next) => {
        if (!live) return;
        setStatus(next);
        if (next?.state === "downloading") timer = window.setTimeout(poll, 1000);
      }).catch(() => {});
    };
    poll();
    return () => { live = false; window.clearTimeout(timer); };
  }, [active, round]);
  const download = () => {
    void downloadPythonRuntime().then(() => setRound((value) => value + 1)).catch(() => {});
  };
  return [active ? status : null, download];
}

function PythonRuntimeNote({ status, onDownload }: { status: PythonRuntimeStatus | null; onDownload: () => void }) {
  const { t } = useTranslation();
  if (!status || status.state === "ready") return null;
  const size = `${Math.round(status.totalBytes / 1e6)} MB`;
  if (status.state === "downloading") {
    const percent = Math.floor(status.receivedBytes * 100 / status.totalBytes);
    return <p className="formnote" role="status">{percent >= 100
      ? t("Installing the Python runtime for Python scripts…")
      : t("Downloading the Python runtime for Python scripts: {percent}% of {size}.", { percent: String(percent), size })}</p>;
  }
  if (status.state === "failed") {
    return <div className="modal-err" role="alert">{t("The Python runtime for Python scripts could not be downloaded: {error}. Check your internet connection.", { error: status.error ?? "" })} <button className="btn" type="button" onClick={onDownload}>{t("Try again")}</button></div>;
  }
  return <p className="formnote">{t("Python scripts need the Python runtime ({size}). It downloads once, before the first Python script runs.", { size })} <button className="btn" type="button" onClick={onDownload}>{t("Download now")}</button></p>;
}

export function ScriptsPage({ onViewRun }: { onViewRun: () => void }) {
  const { t } = useTranslation();
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [script, setScript] = useState<ScriptRecord | null>(null);
  const [tab, setTab] = useState<ScriptsTab>("mine");
  const [canPublish, setCanPublish] = useState(false);
  const [publicationDefaultName, setPublicationDefaultName] = useState("");
  const [publicationOpen, setPublicationOpen] = useState(false);
  const [authorName, setAuthorName] = useState("");
  const [showEmail, setShowEmail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [currentRun, setCurrentRun] = useState<ScriptRun | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const selectionRequest = useRef(0);
  const desktop = scriptsDesktopAvailable();
  const [python, downloadPython] = usePythonRuntime(desktop && scripts.some((item) => item.language === "python"));

  const reload = async () => {
    const [info, nextRun] = await Promise.all([fetchScriptLibraryInfo(), fetchScriptRun()]);
    setScripts(info.scripts);
    setCanPublish(info.canPublish);
    setPublicationDefaultName(info.publicationDefaults?.authorName ?? "");
    if (nextRun) setCurrentRun(nextRun);
  };

  useEffect(() => {
    if (!desktop) return;
    void reload().catch((nextError) => setError(errorText(nextError)));
  }, [desktop]);

  useEffect(() => {
    if (!desktop || (currentRun?.status !== "running" && currentRun?.status !== "stopping")) return;
    const timer = window.setInterval(() => {
      void fetchScriptRun().then((nextRun) => {
        if (nextRun) setCurrentRun(nextRun);
      }).catch(() => {});
    }, 1000);
    return () => window.clearInterval(timer);
  }, [desktop, currentRun?.status]);

  const select = async (id: string) => {
    const request = ++selectionRequest.current;
    setBusy(true);
    setError(null);
    setScript(null);
    setPublicationOpen(false);
    try {
      const nextScript = await fetchScript(id);
      if (request === selectionRequest.current) setScript(nextScript);
    } catch (nextError) {
      if (request === selectionRequest.current) setError(errorText(nextError));
    } finally {
      if (request === selectionRequest.current) setBusy(false);
    }
  };

  const importFile = async (file: File) => {
    const language = languageFor(file);
    if (!language) { setError(t("Choose a .js, .mjs, or .py file.")); return; }
    setBusy(true);
    setError(null);
    try {
      const created = await createScript({ name: fileTitle(file), description: "", language, source: await file.text() });
      setScript(created);
      await reload();
    } catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  };

  const replaceFile = async (file: File) => {
    if (!script) return;
    const language = languageFor(file);
    if (!language) { setError(t("Choose a .js, .mjs, or .py file.")); return; }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateScript(script.id, { ...script, language, source: await file.text() });
      setScript(updated);
      await reload();
    } catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  };

  const saveDetails = async () => {
    if (!script) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateScript(script.id, script);
      setScript(updated);
      await reload();
    } catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!script) return;
    const alsoUnpublishes = script.publishedRevision !== null && script.publishedRevision !== undefined;
    if (!window.confirm(t("Delete {name}?", { name: script.name }) + (alsoUnpublishes ? t(" This also removes its public listing.") : ""))) return;
    setBusy(true);
    setError(null);
    try {
      await deleteScript(script.id, script.revision);
      setScript(null);
      setPublicationOpen(false);
      await reload();
    } catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  };

  const openPublication = () => {
    setAuthorName(publicationDefaultName);
    setShowEmail(false);
    setPublicationOpen(true);
  };

  const publish = async () => {
    if (!script) return;
    setBusy(true);
    setError(null);
    try {
      await publishScript(script.id, { expectedRevision: script.revision, authorName, showEmail });
      setPublicationOpen(false);
      await reload();
      await select(script.id);
    } catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  };

  const unpublish = async () => {
    if (!script) return;
    setBusy(true);
    setError(null);
    try {
      await unpublishScript(script.id);
      setPublicationOpen(false);
      await reload();
      await select(script.id);
    } catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  };

  const imported = async (created: ScriptRecord) => {
    ++selectionRequest.current;
    setTab("mine");
    setScript(created);
    setPublicationOpen(false);
    setError(null);
    try { await reload(); }
    catch (nextError) { setError(errorText(nextError)); }
  };

  if (!desktop) {
    return <div className="workspace scripts-page"><div className="emptystate"><b>{t("Scripts require the desktop app.")}</b><p>{t("Open AliasMode in the desktop app to manage local scripts.")}</p></div></div>;
  }

  const isPublished = script?.publishedRevision !== null && script?.publishedRevision !== undefined;
  const savedScript = scripts.find((item) => item.id === script?.id);
  const detailsChanged = !!script && (script.name !== savedScript?.name || script.description !== savedScript?.description);
  return (
    <div className="workspace scripts-page">
      <div className="scripts-head">
        <div><h2 className="sect-title">{t("Scripts")}</h2><p className="formnote">{t("Private scripts sync with your account in Cloud mode. Runs and logs stay on this computer.")}</p></div>
        {tab === "mine" && <button className="btn primary" type="button" disabled={busy} onClick={() => importRef.current?.click()}>{t("Import script")}</button>}
      </div>
      <div className="tabs scripts-tabs" role="tablist" aria-label={t("Script library")}>
        <button className={`tab${tab === "mine" ? " active" : ""}`} role="tab" aria-selected={tab === "mine"} type="button" onClick={() => setTab("mine")}>{t("My scripts")}</button>
        <button className={`tab${tab === "library" ? " active" : ""}`} role="tab" aria-selected={tab === "library"} type="button" onClick={() => setTab("library")}>{t("Public library")}</button>
      </div>
      {error && <div className="modal-err" role="alert">{error}</div>}
      {tab === "library" ? <PublicLibrary onImported={imported} /> : <>
        {currentRun && <button className="scripts-run-note" type="button" onClick={onViewRun}>{t("{scriptName}: {status}. View run", { scriptName: currentRun.scriptName, status: currentRun.status })}</button>}
        <PythonRuntimeNote status={python} onDownload={downloadPython} />
        <div className="scripts-layout">
          <div className="scripts-list" aria-label={t("Saved scripts")}>
            {scripts.length === 0 ? <p className="formnote">{t("No scripts yet.")}</p> : scripts.map((item) => (
              <button className={`script-row${script?.id === item.id ? " active" : ""}`} type="button" key={item.id} disabled={busy} onClick={() => void select(item.id)}>
                <b>{item.name}</b><span>{languageName(item.language)}</span>
                {item.description && <small>{item.description}</small>}
              </button>
            ))}
          </div>
          {script ? (
            <section className="settings-card script-detail">
              <header><h2>{script.name}</h2><span className="chip">{languageName(script.language)}</span>{isPublished && <span className="chip">{publicationPending(script) ? t("Published, private changes pending") : t("Published")}</span>}</header>
              <div className="card-body">
                <label className="fld"><span>{t("Title")}</span><input className="input" value={script.name} onChange={(event) => setScript({ ...script, name: event.target.value })} /></label>
                <label className="fld"><span>{t("Description")}</span><input className="input" value={script.description} onChange={(event) => setScript({ ...script, description: event.target.value })} /></label>
                <div className="script-actions">
                  <button className="btn primary" type="button" disabled={busy} onClick={() => void saveDetails()}>{busy ? t("Saving…") : t("Save details")}</button>
                  <button className="btn" type="button" disabled={busy} onClick={() => replaceRef.current?.click()}>{t("Replace file")}</button>
                  <button className="btn danger" type="button" disabled={busy} onClick={() => void remove()}>{t("Delete")}</button>
                </div>
                <div className="script-actions">
                  <button className="btn" type="button" disabled={busy || !canPublish || detailsChanged} onClick={openPublication}>{isPublished ? t("Update publication") : t("Publish")}</button>
                  {isPublished && <button className="btn danger" type="button" disabled={busy || !canPublish} onClick={() => void unpublish()}>{t("Unpublish")}</button>}
                </div>
                {canPublish && detailsChanged && <p className="formnote">{t("Save details before publishing.")}</p>}
                {!canPublish && <p className="formnote">{t("Publishing is available after you sign in to Cloud mode.")}</p>}
                {publicationOpen && <form className="script-publication" onSubmit={(event) => { event.preventDefault(); void publish(); }}>
                  <label className="fld"><span>{t("Author name")}</span><input className="input" value={authorName} onChange={(event) => setAuthorName(event.target.value)} disabled={busy} /></label>
                  <label className="script-credentials"><input type="checkbox" checked={showEmail} onChange={(event) => setShowEmail(event.target.checked)} disabled={busy} />{t("Show my account email")}</label>
                  <div className="script-publication-preview"><b>{script.name}</b><span>{script.description || t("No description")}</span><span>{languageName(script.language)}</span></div>
                  <div className="script-actions"><button className="btn primary" type="submit" disabled={busy || detailsChanged}>{busy ? t("Publishing…") : isPublished ? t("Update publication") : t("Publish")}</button><button className="btn" type="button" disabled={busy} onClick={() => setPublicationOpen(false)}>{t("Cancel")}</button></div>
                </form>}
                <label className="fld"><span>{t("Source")}</span><pre className="script-source">{script.source}</pre></label>
              </div>
            </section>
          ) : <div className="emptystate"><b>{t("Select a script")}</b><p>{t("Import a .js, .mjs, or .py file to begin.")}</p></div>}
        </div>
      </>}
      <input ref={importRef} type="file" accept=".js,.mjs,.py,text/javascript,text/x-python" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ""; }} />
      <input ref={replaceRef} type="file" accept=".js,.mjs,.py,text/javascript,text/x-python" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void replaceFile(file); event.target.value = ""; }} />
    </div>
  );
}

function PublicLibrary({ onImported }: { onImported: (script: ScriptRecord) => Promise<void> }) {
  const { t } = useTranslation();
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState<ScriptLanguage | "">("");
  const [offset, setOffset] = useState(0);
  const [scripts, setScripts] = useState<PublishedScriptSummary[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [script, setScript] = useState<PublishedScript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const searchRequest = useRef(0);
  const detailRequest = useRef(0);

  useEffect(() => {
    let active = true;
    const request = ++searchRequest.current;
    ++detailRequest.current;
    setBusy(true);
    setError(null);
    setScripts([]);
    setNextOffset(null);
    setScript(null);
    void fetchPublishedScripts({ q: query, ...(language ? { language } : {}), offset }).then((result) => {
      if (!active || request !== searchRequest.current) return;
      setScripts(result.scripts);
      setNextOffset(result.nextOffset);
    }).catch((nextError) => {
      if (active && request === searchRequest.current) setError(errorText(nextError));
    }).finally(() => {
      if (active && request === searchRequest.current) setBusy(false);
    });
    return () => { active = false; };
  }, [query, language, offset]);

  const search = () => {
    setOffset(0);
    setQuery(queryInput);
  };

  const select = async (id: string) => {
    const request = ++detailRequest.current;
    setBusy(true);
    setError(null);
    setScript(null);
    try {
      const nextScript = await fetchPublishedScript(id);
      if (request === detailRequest.current) setScript(nextScript);
    } catch (nextError) {
      if (request === detailRequest.current) setError(errorText(nextError));
    } finally {
      if (request === detailRequest.current) setBusy(false);
    }
  };

  const importScript = async () => {
    if (!script) return;
    setBusy(true);
    setError(null);
    try {
      const created = await importPublishedScript(script.id);
      await onImported(created);
    } catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  };

  return <div className="scripts-library">
    <form className="scripts-library-search" onSubmit={(event) => { event.preventDefault(); search(); }}>
      <input className="input" aria-label={t("Search public scripts")} placeholder={t("Search scripts")} value={queryInput} onChange={(event) => setQueryInput(event.target.value)} />
      <select className="select" aria-label={t("Script language")} value={language} onChange={(event) => { setOffset(0); setLanguage(event.target.value as ScriptLanguage | ""); }}>
        <option value="">{t("All languages")}</option><option value="javascript">JavaScript</option><option value="python">Python</option>
      </select>
      <button className="btn primary" type="submit" disabled={busy}>{t("Search")}</button>
    </form>
    {error && <div className="modal-err" role="alert">{error}</div>}
    <div className="scripts-layout">
      <div className="scripts-list" aria-label={t("Public scripts")}>
        {busy && scripts.length === 0 ? <p className="formnote">{t("Loading scripts…")}</p> : scripts.length === 0 ? <p className="formnote">{t("No public scripts found.")}</p> : scripts.map((item) => (
          <button className={`script-row${script?.id === item.id ? " active" : ""}`} type="button" key={item.id} disabled={busy} onClick={() => void select(item.id)}>
            <b>{item.name}</b><span>{item.authorName} · {languageName(item.language)} · {new Date(item.updatedAt).toLocaleDateString()}</span>
            {item.description && <small>{item.description}</small>}
          </button>
        ))}
        <div className="script-library-pager"><button className="btn" type="button" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>{t("Previous")}</button><button className="btn" type="button" disabled={busy || nextOffset === null} onClick={() => setOffset(nextOffset ?? offset)}>{t("Next")}</button></div>
      </div>
      {script ? <section className="settings-card script-detail">
        <header><h2>{script.name}</h2><span className="chip">{languageName(script.language)}</span></header>
        <div className="card-body">
          <p>{script.description || t("No description")}</p>
          <p className="formnote">{t("By {authorName}", { authorName: script.authorName })}{script.authorEmail && <> · {script.authorEmail}</>} · {new Date(script.updatedAt).toLocaleDateString()}</p>
          <button className="btn primary" type="button" disabled={busy} onClick={() => void importScript()}>{t("Add to my scripts")}</button>
          <label className="fld"><span>{t("Source")}</span><pre className="script-source">{script.source}</pre></label>
        </div>
      </section> : <div className="emptystate"><b>{t("Select a public script")}</b><p>{t("Choose a script to view its details and source.")}</p></div>}
    </div>
  </div>;
}

export function ScriptRunPanel({ open, selectedProfiles, onClose }: {
  open: boolean;
  selectedProfiles: UiProfile[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [scriptId, setScriptId] = useState("");
  const [inputs, setInputs] = useState("{}");
  const [useCredentials, setUseCredentials] = useState(false);
  const [concurrency, setConcurrency] = useState("10");
  const [run, setRun] = useState<ScriptRun | null>(null);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const offset = useRef(0);
  const desktop = scriptsDesktopAvailable();
  const runActive = run?.status === "running" || run?.status === "stopping";
  const [python, downloadPython] = usePythonRuntime(open && desktop && scripts.find((script) => script.id === scriptId)?.language === "python");

  useEffect(() => {
    if (!open || !desktop) return;
    setError(null);
    void Promise.all([fetchScripts(), fetchScriptRun()]).then(([nextScripts, nextRun]) => {
      setScripts(nextScripts);
      if (nextRun) setRun(nextRun);
    }).catch((nextError) => setError(errorText(nextError)));
  }, [open, desktop]);

  useEffect(() => {
    if (!open || !run) return;
    let active = true;
    let timer: number | undefined;
    offset.current = 0;
    setLog("");
    const poll = async () => {
      try {
        const nextRun = await fetchScriptRun();
        const before = offset.current;
        const nextLog = await fetchScriptLog(run.id, before);
        if (!active) return;
        if (nextRun) setRun(nextRun);
        else setRun((current) => current?.id === run.id ? { ...current, status: "finished" } : current);
        if (nextLog.text) setLog((current) => current + nextLog.text);
        offset.current = nextLog.nextOffset;
        const stillRunning = nextRun?.id === run.id && nextRun.status !== "finished";
        if (stillRunning || nextLog.nextOffset !== before) timer = window.setTimeout(() => { void poll(); }, 1000);
      } catch (nextError) {
        if (!active) return;
        setError(errorText(nextError));
        timer = window.setTimeout(() => { void poll(); }, 1000);
      }
    };
    void poll();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [open, run?.id]);

  const start = async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(inputs); }
    catch { setError(t("Inputs must be valid JSON.")); return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { setError(t("Inputs must be a JSON object.")); return; }
    if (!scriptId || selectedProfiles.length === 0) return;
    const parallel = Number(concurrency);
    if (!Number.isSafeInteger(parallel) || parallel < 1) { setError(t("Parallel browsers must be a positive whole number.")); return; }
    setBusy(true);
    setError(null);
    try {
      offset.current = 0;
      setLog("");
      setRun(await startScriptRun({ scriptId, profileIds: selectedProfiles.map((profile) => profile.id), inputs: parsed, useCredentials, concurrency: parallel }));
    } catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  };

  const stop = async () => {
    setBusy(true);
    setError(null);
    try { setRun(await stopScriptRun()); }
    catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  };

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal script-run-modal" role="dialog" aria-modal="true" aria-labelledby="script-run-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head" id="script-run-title">{t("Run script")}<button type="button" className="modal-close" aria-label={t("Close")} onClick={onClose}>×</button></div>
        <div className="modal-body">
          {!desktop ? <div className="modal-err">{t("Scripts require the desktop app.")}</div> : <>
            <p className="formnote">{t("Scripts run locally with your computer permissions.")}</p>
            {error && <div className="modal-err" role="alert">{error}</div>}
            <PythonRuntimeNote status={python} onDownload={downloadPython} />
            <label className="fld"><span>{t("Script")}</span><select className="select" value={scriptId} onChange={(event) => setScriptId(event.target.value)} disabled={busy || runActive}><option value="">{t("Choose a script…")}</option>{scripts.map((script) => <option key={script.id} value={script.id}>{script.name}</option>)}</select></label>
            <label className="fld"><span>{t("JSON inputs")}</span><textarea className="input script-inputs" value={inputs} onChange={(event) => setInputs(event.target.value)} disabled={busy || runActive} /></label>
            <label className="script-credentials"><input type="checkbox" checked={useCredentials} onChange={(event) => setUseCredentials(event.target.checked)} disabled={busy || runActive} />{t("Use saved profile login details")}</label>
            <label className="fld"><span>{t("Parallel browsers")}</span><input className="input" type="number" min={1} step={1} value={concurrency} onChange={(event) => setConcurrency(event.target.value)} disabled={busy || runActive} /></label>
            <p className="formnote">{t("{n} selected profiles. Run up to this many at a time; the rest wait for a free slot. Browser startup may be staggered. Parallel runs share the log below.", { n: String(selectedProfiles.length) })}</p>
            {run && <div className="script-progress"><b>{run.scriptName} · {run.status}</b>{run.profiles.map((profile) => <div key={profile.id} className={`script-profile ${profile.status}`}><span>{profile.name}</span><span>{profile.status}</span>{profile.error && <small>{profile.error}</small>}{profile.warning && <small className="warning">{profile.warning}</small>}</div>)}</div>}
            {run && <pre className="script-log" aria-label={t("Script log")}>{log || t("Waiting for log output…")}</pre>}
          </>}
        </div>
        <div className="modal-foot"><button className="btn ghost" type="button" onClick={onClose}>{t("Close")}</button>{desktop && !runActive && <button className="btn primary" type="button" disabled={busy || !scriptId || selectedProfiles.length === 0} onClick={() => void start()}>{busy ? t("Starting…") : t("Run script")}</button>}{desktop && runActive && <button className="btn solid-danger" type="button" disabled={busy || run?.status === "stopping"} onClick={() => void stop()}>{run?.status === "stopping" ? t("Stopping…") : busy ? t("Stopping…") : t("Stop")}</button>}</div>
      </div>
    </div>
  );
}
