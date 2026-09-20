import { useEffect, useRef, useState } from "react";
import type { ScriptLanguage, ScriptRecord, ScriptSummary } from "../contracts/cloud-v1.ts";
import type { ScriptRun } from "../scripts.ts";
import type { UiProfile } from "./api.ts";
import {
  createScript,
  deleteScript,
  fetchScript,
  fetchScriptLog,
  fetchScriptRun,
  fetchScripts,
  scriptsDesktopAvailable,
  startScriptRun,
  stopScriptRun,
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

export function ScriptsPage({ onViewRun }: { onViewRun: () => void }) {
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [script, setScript] = useState<ScriptRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [currentRun, setCurrentRun] = useState<ScriptRun | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const desktop = scriptsDesktopAvailable();

  const reload = async () => {
    const [nextScripts, nextRun] = await Promise.all([fetchScripts(), fetchScriptRun()]);
    setScripts(nextScripts);
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
    setBusy(true);
    setError(null);
    try { setScript(await fetchScript(id)); }
    catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  };

  const importFile = async (file: File) => {
    const language = languageFor(file);
    if (!language) { setError("Choose a .js, .mjs, or .py file."); return; }
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
    if (!language) { setError("Choose a .js, .mjs, or .py file."); return; }
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
    if (!script || !window.confirm(`Delete ${script.name}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteScript(script.id, script.revision);
      setScript(null);
      await reload();
    } catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  };

  if (!desktop) {
    return <div className="workspace scripts-page"><div className="emptystate"><b>Scripts require the desktop app.</b><p>Open AliasMode in the desktop app to manage local scripts.</p></div></div>;
  }

  return (
    <div className="workspace scripts-page">
      <div className="scripts-head">
        <div><h2 className="sect-title">Scripts</h2><p className="formnote">Private scripts sync with your account in Cloud mode. Runs and logs stay on this computer.</p></div>
        <button className="btn primary" type="button" disabled={busy} onClick={() => importRef.current?.click()}>Import script</button>
      </div>
      {error && <div className="modal-err" role="alert">{error}</div>}
      {currentRun && <button className="scripts-run-note" type="button" onClick={onViewRun}>{currentRun.scriptName}: {currentRun.status}. View run</button>}
      <div className="scripts-layout">
        <div className="scripts-list" aria-label="Saved scripts">
          {scripts.length === 0 ? <p className="formnote">No scripts yet.</p> : scripts.map((item) => (
            <button className={`script-row${script?.id === item.id ? " active" : ""}`} type="button" key={item.id} disabled={busy} onClick={() => void select(item.id)}>
              <b>{item.name}</b><span>{item.language === "python" ? "Python" : "JavaScript"}</span>
              {item.description && <small>{item.description}</small>}
            </button>
          ))}
        </div>
        {script ? (
          <section className="settings-card script-detail">
            <header><h2>{script.name}</h2><span className="chip">{script.language === "python" ? "Python" : "JavaScript"}</span></header>
            <div className="card-body">
              <label className="fld"><span>Title</span><input className="input" value={script.name} onChange={(event) => setScript({ ...script, name: event.target.value })} /></label>
              <label className="fld"><span>Description</span><input className="input" value={script.description} onChange={(event) => setScript({ ...script, description: event.target.value })} /></label>
              <div className="script-actions">
                <button className="btn primary" type="button" disabled={busy} onClick={() => void saveDetails()}>{busy ? "Saving…" : "Save details"}</button>
                <button className="btn" type="button" disabled={busy} onClick={() => replaceRef.current?.click()}>Replace file</button>
                <button className="btn danger" type="button" disabled={busy} onClick={() => void remove()}>Delete</button>
              </div>
              <label className="fld"><span>Source</span><pre className="script-source">{script.source}</pre></label>
            </div>
          </section>
        ) : <div className="emptystate"><b>Select a script</b><p>Import a .js, .mjs, or .py file to begin.</p></div>}
      </div>
      <input ref={importRef} type="file" accept=".js,.mjs,.py,text/javascript,text/x-python" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ""; }} />
      <input ref={replaceRef} type="file" accept=".js,.mjs,.py,text/javascript,text/x-python" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void replaceFile(file); event.target.value = ""; }} />
    </div>
  );
}

export function ScriptRunPanel({ open, selectedProfiles, onClose }: {
  open: boolean;
  selectedProfiles: UiProfile[];
  onClose: () => void;
}) {
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [scriptId, setScriptId] = useState("");
  const [inputs, setInputs] = useState("{}");
  const [useCredentials, setUseCredentials] = useState(false);
  const [run, setRun] = useState<ScriptRun | null>(null);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const offset = useRef(0);
  const desktop = scriptsDesktopAvailable();
  const runActive = run?.status === "running" || run?.status === "stopping";

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
    catch { setError("Inputs must be valid JSON."); return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { setError("Inputs must be a JSON object."); return; }
    if (!scriptId || selectedProfiles.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      offset.current = 0;
      setLog("");
      setRun(await startScriptRun({ scriptId, profileIds: selectedProfiles.map((profile) => profile.id), inputs: parsed, useCredentials }));
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
        <div className="modal-head" id="script-run-title">Run script<button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="modal-body">
          {!desktop ? <div className="modal-err">Scripts require the desktop app.</div> : <>
            <p className="formnote">Scripts run locally with your computer permissions.</p>
            {error && <div className="modal-err" role="alert">{error}</div>}
            <label className="fld"><span>Script</span><select className="select" value={scriptId} onChange={(event) => setScriptId(event.target.value)} disabled={busy || runActive}><option value="">Choose a script…</option>{scripts.map((script) => <option key={script.id} value={script.id}>{script.name}</option>)}</select></label>
            <label className="fld"><span>JSON inputs</span><textarea className="input script-inputs" value={inputs} onChange={(event) => setInputs(event.target.value)} disabled={busy || runActive} /></label>
            <label className="script-credentials"><input type="checkbox" checked={useCredentials} onChange={(event) => setUseCredentials(event.target.checked)} disabled={busy || runActive} />Use saved profile login details</label>
            <p className="formnote">{selectedProfiles.length} selected profile{selectedProfiles.length === 1 ? "" : "s"} will run sequentially.</p>
            {run && <div className="script-progress"><b>{run.scriptName} · {run.status}</b>{run.profiles.map((profile) => <div key={profile.id} className={`script-profile ${profile.status}`}><span>{profile.name}</span><span>{profile.status}</span>{profile.error && <small>{profile.error}</small>}{profile.warning && <small className="warning">{profile.warning}</small>}</div>)}</div>}
            {run && <pre className="script-log" aria-label="Script log">{log || "Waiting for log output…"}</pre>}
          </>}
        </div>
        <div className="modal-foot"><button className="btn ghost" type="button" onClick={onClose}>Close</button>{desktop && !runActive && <button className="btn primary" type="button" disabled={busy || !scriptId || selectedProfiles.length === 0} onClick={() => void start()}>{busy ? "Starting…" : "Run script"}</button>}{desktop && runActive && <button className="btn solid-danger" type="button" disabled={busy || run?.status === "stopping"} onClick={() => void stop()}>{run?.status === "stopping" ? "Stopping…" : busy ? "Stopping…" : "Stop"}</button>}</div>
      </div>
    </div>
  );
}
