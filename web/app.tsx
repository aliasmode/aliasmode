import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import aliasLoopUrl from "./alias-loop.svg";
import { parsePastedProxy } from "./proxy-input.ts";
import {
  type UiProfile,
  type HealthSource,
  type HealthStatus,
  type DiagnoseReport,
  type EditProfile,
  type Extension,
  type AppModeConfig,
  type CloudAuthState,
  CloudSessionRestoreError,
  type CloudDiagnosticEvent,
  type CloudTeamState,
  acceptCloudInvitation,
  acceptCloudLegal,
  cloudSessionContextReady,
  cloudWorkspaceReady,
  fetchAppMode,
  fetchCloudAuth,
  fetchCloudEvents,
  fetchCloudTeam,
  cloudWorkspaceAction,
  forgetCloudSession,
  signInCloud,
  signOutCloud,
  signUpCloud,
  restoreCloudSession,
  resendCloudSignUp,
  selectAppMode,
  fetchProfiles,
  fetchHealth,
  fetchLogs,
  fetchDiagnose,
  openProfile,
  closeProfile,
  raiseProfile,
  fetchExtensions,
  uploadExtensions,
  removeExtension,
  assignExtensionBulk,
  uploadExports,
  moveProfiles,
  deleteProfiles,
  createProfile,
  fetchProfileEdit,
  updateProfile,
  convertMobileProfile,
  exportProfiles,
  type ExportFormat,
  updateFromFile,
  createGroup,
  renameGroup,
  deleteGroup,
  fetchTotp,
} from "./api.ts";

/** Run async tasks with bounded concurrency (so "Open 50" isn't 50 at once). */
async function runPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]!); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// ---- CSV / AdsPower-txt import helpers (ported from the old dashboard) -------
const genId = () => "cp" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const oneLine = (s: unknown) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();

/** Build one AdsPower `key=value` record block — the format the importer reads. */
function adsBlock(f: Record<string, string>): string {
  return [
    `id=${f.id || genId()}`,
    `group=${oneLine(f.group)}`,
    `platform=${oneLine(f.platform)}`,
    `name=${oneLine(f.name)}`,
    `username=${oneLine(f.username)}`,
    `password=${oneLine(f.password)}`,
    `email=${oneLine(f.email)}`,
    `emailpassword=${oneLine(f.emailPassword)}`,
    `fakey=${oneLine(f.twofa)}`,
    `cookie=${f.cookie && f.cookie.trim() ? oneLine(f.cookie) : "[]"}`,
    `proxytype=${f.proxyType || "http"}`,
    `proxy=${oneLine(f.proxy)}`,
    `ua=${oneLine(f.ua)}`,
    `resolution=${f.resolution || "1920*1080"}`,
    "******************",
  ].join("\n");
}

/**
 * CSV → AdsPower record blocks. Columns map onto AdsPower fields (header aliases
 * tolerated); group/platform fall back to the dialog pickers when a row leaves
 * them blank. A header-less file is read positionally as name,proxy,user,pass,2fa.
 */
function csvToBlocks(text: string, defaultGroup: string, defaultPlatform: string): string[] {
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!rows.length) return [];
  const cells = (l: string) => l.split(",").map((c) => c.trim());
  const headerish = /\b(name|group|platform|user(name)?|email|proxy|pass(word)?|2fa|twofa|fakey|ua|resolution|screen)\b/i.test(rows[0]!);
  let cols: string[] | null = null, start = 0;
  if (headerish) { cols = cells(rows[0]!).map((c) => c.toLowerCase()); start = 1; }
  const find = (...names: string[]) => (cols ? cols.findIndex((c) => names.includes(c)) : -1);
  const ix = cols ? {
    name: find("name", "profile", "profile name"), group: find("group"),
    platform: find("platform", "site"), proxy: find("proxy"), proxyType: find("proxytype", "proxy type"),
    username: find("username", "user", "login"), password: find("password", "pass", "pwd"),
    email: find("email", "mail"), emailPassword: find("emailpassword", "email_password", "mailpassword", "mail_password"),
    twofa: find("twofa", "2fa", "fakey", "otp"), ua: find("ua", "user-agent", "useragent"),
    resolution: find("resolution", "screen"),
  } : null;
  const get = (c: string[], k: keyof NonNullable<typeof ix>) => (ix && ix[k] >= 0 ? (c[ix[k]] || "") : "");
  const blocks: string[] = [];
  for (let i = start; i < rows.length; i++) {
    const c = cells(rows[i]!);
    const f = cols
      ? {
          name: get(c, "name"), proxy: get(c, "proxy"), proxyType: get(c, "proxyType") || "http",
          username: get(c, "username") || get(c, "email"), password: get(c, "password"),
          email: get(c, "email"), emailPassword: get(c, "emailPassword"), twofa: get(c, "twofa"),
          ua: get(c, "ua"), resolution: get(c, "resolution"),
          group: get(c, "group") || defaultGroup, platform: get(c, "platform") || defaultPlatform,
        }
      : {
          name: c[0] || "", proxy: c[1] || "", proxyType: "http",
          username: c[2] || "", password: c[3] || "", email: "", emailPassword: "", twofa: c[4] || "", ua: "", resolution: "",
          group: defaultGroup, platform: defaultPlatform,
        };
    (f as any).id = genId();
    blocks.push(adsBlock(f as any));
  }
  return blocks;
}

/** Turn a picked file list into upload-ready Files (CSV → AdsPower .txt; .txt passthrough). */
async function prepUploads(files: FileList | File[], defaultGroup = "", defaultPlatform = ""): Promise<File[]> {
  const out: File[] = [];
  for (const f of Array.from(files)) {
    if (/\.csv$/i.test(f.name)) {
      const blocks = csvToBlocks(await f.text(), defaultGroup, defaultPlatform);
      if (blocks.length) out.push(new File([blocks.join("\n")], f.name.replace(/\.csv$/i, ".txt"), { type: "text/plain" }));
    } else {
      out.push(f);
    }
  }
  return out;
}

const CSV_TEMPLATE =
  "name,group,platform,proxy,username,password,email,emailpassword,twofa\n" +
  "alice_warmup,Warmup,x.com,1.2.3.4:8080:proxyuser:proxypass,alice_user,SuperSecret1,alice@example.com,MailboxSecret1,JBSWY3DPEHPK3PXP\n" +
  "bob_eu,EU,telegram.org,,bob_user,SuperSecret2,bob@example.com,MailboxSecret2,\n" +
  "carol_noproxy,Warmup,,,carol_user,SuperSecret3,carol@example.com,MailboxSecret3,KRSXG5CTMVRXEZLU\n";

const TXT_EXAMPLE =
  "id=k1example01\ngroup=Warmup\nplatform=x.com\nname=alice_warmup\nusername=alice@example.com\n" +
  "password=SuperSecret1\nemail=mailbox@example.com\nemailpassword=MailboxSecret1\nfakey=JBSWY3DPEHPK3PXP\ncookie=[]\nproxytype=http\n" +
  "proxy=1.2.3.4:8080:proxyuser:proxypass\nua=\nresolution=1920*1080\n******************\n";

// Example sheet for the Update-from-file flow. The FIRST column (id) is what
// matches each row to an existing profile — keep it. Edit the other columns;
// delete any column you don't want to change.
const UPDATE_TEMPLATE_CSV =
  "id,name,group,platform,proxy,proxytype,username,password,twofa,resolution\n" +
  "<paste-the-profile-id-here>,New name,Warmup,x.com,1.2.3.4:8080:user:pass,http,new@example.com,NewPass1,JBSWY3DPEHPK3PXP,1920*1080\n";

function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

const REFRESH_MS = 3000;
const PROFILE_PAGE_SIZE = 200;

const CLOUD_DIAGNOSTIC_LABELS: Record<CloudDiagnosticEvent["type"], string> = {
  open_started: "Cloud open started",
  cloud_registered: "Cloud session registered",
  browser_started: "CloakBrowser started",
  browser_launch_preflight_failed: "Browser profile preparation failed",
  browser_launch_relay_setup_failed: "Proxy relay setup failed",
  browser_launch_process_spawn_failed: "CloakBrowser process could not start",
  browser_launch_cdp_readiness_failed: "CloakBrowser debugging connection was not ready",
  session_restore_started: "Session restore started",
  session_restore_completed: "Session restore completed",
  session_restore_unclassified_failed: "Session restore failed before classification",
  session_restore_invalid_bundle_failed: "Session data was invalid",
  session_restore_invalid_bundle_timeout: "Session data validation timed out",
  session_restore_connect_failed: "Browser connection failed",
  session_restore_connect_timeout: "Browser connection timed out",
  session_restore_context_failed: "Persistent browser context was unavailable",
  session_restore_context_timeout: "Persistent browser context timed out",
  session_restore_origin_storage_failed: "Website storage restore failed",
  session_restore_origin_storage_timeout: "Website storage restore timed out",
  session_restore_cookie_clear_failed: "Cookie clear failed",
  session_restore_cookie_clear_timeout: "Cookie clear timed out",
  session_restore_cookie_add_failed: "Cookie restore failed",
  session_restore_cookie_add_timeout: "Cookie restore timed out",
  session_restore_navigation_failed: "Startup navigation failed",
  session_restore_navigation_timeout: "Startup navigation timed out",
  session_restore_disconnect_failed: "Browser connection cleanup failed",
  session_restore_disconnect_timeout: "Browser connection cleanup timed out",
  open_running: "Cloud profile is running",
  open_failed: "Cloud profile open failed",
  close_started: "Cloud close started",
  session_captured: "Session captured",
  browser_stopped: "CloakBrowser stopped",
  session_synced: "Session synchronized",
  checkpoint_saved: "Session checkpoint saved",
  checkpoint_unchanged: "Session checkpoint unchanged",
  checkpoint_capture_failed: "Session checkpoint capture failed",
  checkpoint_invalid: "Session checkpoint was invalid",
  manual_stop_detected: "Manual browser close detected",
  session_sync_pending: "Session synchronization is pending",
  dirty_monitor_unavailable: "Fast session monitoring is unavailable",
  cloud_registration_released: "Cloud session registration released",
  cleanup_retained: "Browser or recovery state was retained",
  heartbeat_failed: "Cloud heartbeat failed",
  access_ended: "Cloud access ended",
};

function cloudDiagnosticFailed(type: CloudDiagnosticEvent["type"]): boolean {
  return type.includes("failed") || type.includes("timeout") || type === "checkpoint_invalid"
    || type === "session_sync_pending" || type === "cleanup_retained" || type === "access_ended";
}

function StatusDot({ running }: { running: boolean }) {
  return <span className={`dot ${running ? "on" : ""}`} title={running ? "running" : "stopped"} />;
}

function HealthBadge({ profile }: { profile: UiProfile }) {
  const status = profile.healthStatus ?? "no_data";
  const labels: Record<HealthStatus, string> = {
    suspended: "Suspended",
    alive: "Alive",
    no_data: "No data",
  };
  const observed = profile.healthObservedAt
    ? `Observed ${new Date(profile.healthObservedAt).toLocaleString()}`
    : "No fresh automation observation";
  return <span className={`health-badge ${status}`} title={observed}>{labels[status]}</span>;
}

function HealthSources({ sources }: { sources: HealthSource[] }) {
  if (sources.length === 0) return <span className="health-sources none">No health nodes</span>;
  return (
    <div className="health-sources" aria-label="Automation node freshness">
      {sources.map((source) => (
        <span
          key={source.sourceId}
          className={`health-source${source.stale ? " stale" : ""}`}
          title={`Last snapshot ${new Date(source.lastSnapshotAt).toLocaleString()}`}
        >
          {source.sourceId} · {source.stale ? "stale" : "fresh"} · {new Date(source.lastSnapshotAt).toLocaleTimeString()}
        </span>
      ))}
    </div>
  );
}

const KNOWN_PLATFORMS: { value: string; label: string }[] = [
  { value: "", label: "(none)" },
  { value: "x.com", label: "Twitter / X" },
  { value: "instagram.com", label: "Instagram" },
  { value: "facebook.com", label: "Facebook" },
  { value: "tiktok.com", label: "TikTok" },
  { value: "linkedin.com", label: "LinkedIn" },
  { value: "reddit.com", label: "Reddit" },
  { value: "telegram.org", label: "Telegram" },
];

function PlatformPill({ platform }: { platform: string }) {
  const known = KNOWN_PLATFORMS.find((candidate) => candidate.value === platform);
  if (known?.value) return <span className="chip">{known.label}</span>;
  if (platform) return <span className="chip">{platform}</span>;
  return <span className="muted">—</span>;
}

/**
 * Group selector used in every dialog: a styled <select> of existing groups
 * plus "➕ New group…", which flips to an inline text field so you can create a
 * group on the fly. Consistent with the other modal selects (no native datalist).
 */
function GroupPicker({ value, onChange, groups, allowCreate = true }: { value: string; onChange: (v: string) => void; groups: string[]; allowCreate?: boolean }) {
  const [creating, setCreating] = useState(false);
  if (creating) {
    return (
      <div className="grouppick">
        <input autoFocus placeholder="new group name" value={value} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="gp-back" title="Pick an existing group" onClick={() => { setCreating(false); onChange(""); }}>↩</button>
      </div>
    );
  }
  return (
    <select
      value={groups.includes(value) ? value : ""}
      onChange={(e) => {
        if (e.target.value === "__new__") { setCreating(true); onChange(""); }
        else onChange(e.target.value);
      }}
    >
      <option value="">(ungrouped)</option>
      {groups.map((g) => <option key={g} value={g}>{g}</option>)}
      {allowCreate && <option value="__new__">➕ New group…</option>}
    </select>
  );
}

function PlatformPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const known = KNOWN_PLATFORMS.some((p) => p.value === value);
  const [creating, setCreating] = useState(false);
  if (creating || (!!value && !known)) {
    return (
      <div className="grouppick">
        <input autoFocus placeholder="new platform (e.g. linkedin.com)" value={value} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="gp-back" title="Pick a known platform" onClick={() => { setCreating(false); onChange(""); }}>↩</button>
      </div>
    );
  }
  return (
    <select value={value} onChange={(e) => { if (e.target.value === "__new__") { setCreating(true); onChange(""); } else onChange(e.target.value); }}>
      {KNOWN_PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
      <option value="__new__">➕ New platform…</option>
    </select>
  );
}

function ModeSwitchConfirmation({
  mode,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  mode: "local" | "cloud";
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const toLocal = mode === "local";
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal mode-confirm" role="dialog" aria-modal="true" aria-labelledby="mode-confirm-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head" id="mode-confirm-title">Switch to {toLocal ? "Local" : "Cloud"}?</div>
        <div className="modal-body">
          <p>
            {toLocal
              ? "Cloud profiles will not appear until you switch back. Local mode does not contact AliasMode Cloud."
              : "Your Local profiles stay on this computer. AliasMode does not upload them to Cloud automatically."}
          </p>
          <p className="hint">AliasMode saves and closes active browsers, then restarts automatically.</p>
          {error && <div className="modal-err" role="alert">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="link" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="primary" type="button" disabled={busy} onClick={onConfirm}>
            {busy ? "Switching…" : `Switch to ${toLocal ? "Local" : "Cloud"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

async function copyPlainText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy failed");
}

function CopyField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyPlainText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="fld grow">
      <span>{label}</span>
      <div className="copyfield">
        <input value={value} onChange={(event) => onChange(event.target.value)} />
        <button type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>
    </div>
  );
}

const AUTOMATIC_FINGERPRINT_FIELDS = [
  ["User agent", "Automatic"],
  ["Browser version", "Automatic · latest installed"],
  ["Operating system", "Automatic"],
  ["GPU", "Automatic"],
  ["CPU", "Automatic"],
  ["RAM", "Automatic"],
  ["Fingerprint seed", "Automatic · unique and stable"],
  ["Timezone", "Automatic · from proxy"],
  ["Canvas / WebGL / audio", "Automatic"],
  ["WebRTC", "Automatic · proxy-aware"],
] as const;

function FingerprintSettings({
  screen,
  onScreenChange,
}: {
  screen: string;
  onScreenChange: (value: string) => void;
}) {
  return (
    <details className="fingerprint-settings">
      <summary>
        <span>Fingerprint settings</span>
        <span className="automatic-badge">Automatic</span>
      </summary>
      <div className="fingerprint-grid">
        <label className="fld">
          <span>Screen</span>
          <input value={screen} placeholder="Automatic · e.g. 1920x1080" onChange={(event) => onScreenChange(event.target.value)} />
        </label>
        {AUTOMATIC_FINGERPRINT_FIELDS.map(([label, value]) => (
          <label className="fld" key={label}>
            <span>{label}</span>
            <input value={value} readOnly tabIndex={-1} className="ro" />
          </label>
        ))}
        <div className="hint">CloakBrowser keeps the locked values coordinated. Screen is the only fingerprint setting you can override.</div>
      </div>
    </details>
  );
}

type DesktopInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type DesktopUpdateStatus =
  | { state: "upToDate"; currentVersion: string }
  | { state: "available"; currentVersion: string; version: string };
type SavedSessionPhase = "restoring" | "manual-signin" | "retryable-failure";

function parseDesktopUpdateStatus(value: unknown): DesktopUpdateStatus {
  if (!value || typeof value !== "object") throw new Error("AliasMode returned an invalid update status.");
  const status = value as Record<string, unknown>;
  if (status.state === "upToDate" && typeof status.currentVersion === "string") {
    return { state: "upToDate", currentVersion: status.currentVersion };
  }
  if (status.state === "available" && typeof status.currentVersion === "string" && typeof status.version === "string") {
    return { state: "available", currentVersion: status.currentVersion, version: status.version };
  }
  throw new Error("AliasMode returned an invalid update status.");
}

function desktopInvoke(): DesktopInvoke | undefined {
  return (window as any).__TAURI_INTERNALS__?.invoke as DesktopInvoke | undefined;
}

async function readDesktopCloudCredentials(): Promise<{
  refreshToken?: string;
  deviceCredential?: string;
  queueKey?: string;
} | null> {
  const invoke = desktopInvoke();
  if (!invoke) return null;
  const [refreshToken, deviceCredential, queueKey] = await Promise.all([
    invoke("credential_get", { key: "refresh_token" }),
    invoke("credential_get", { key: "device_credential" }),
    invoke("credential_get", { key: "queue_encryption_key" }),
  ]);
  return {
    ...(typeof refreshToken === "string" && refreshToken ? { refreshToken } : {}),
    ...(typeof deviceCredential === "string" && deviceCredential ? { deviceCredential } : {}),
    ...(typeof queueKey === "string" && queueKey ? { queueKey } : {}),
  };
}

async function storeDesktopCloudCredentials(
  refreshToken: string,
  deviceCredential: string,
  createdQueueKey?: string,
): Promise<boolean> {
  const invoke = desktopInvoke();
  if (!invoke) return false;
  if (createdQueueKey) {
    await invoke("credential_set", { key: "queue_encryption_key", secret: createdQueueKey });
  }
  await invoke("credential_set", { key: "device_credential", secret: deviceCredential });
  await invoke("credential_set", { key: "refresh_token", secret: refreshToken });
  return true;
}

const BLANK_FORM = { name: "", group: "", platform: "", proxyType: "http", host: "", port: "", user: "", pass: "", screen: "" };

function App() {
  const [profiles, setProfiles] = useState<UiProfile[]>([]);
  const [registeredGroups, setRegisteredGroups] = useState<string[]>([]);
  const [appMode, setAppMode] = useState<AppModeConfig | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [modeErr, setModeErr] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [cloudEvents, setCloudEvents] = useState<CloudDiagnosticEvent[]>([]);
  const [cloudEventsBusy, setCloudEventsBusy] = useState(false);
  const [cloudEventsErr, setCloudEventsErr] = useState<string | null>(null);
  const [pendingMode, setPendingMode] = useState<"local" | "cloud" | null>(null);
  const [cloudAuth, setCloudAuth] = useState<CloudAuthState | null>(null);
  const [savedSessionPhase, setSavedSessionPhase] = useState<SavedSessionPhase>("restoring");
  const [scheduledRefreshPending, setScheduledRefreshPending] = useState(false);
  const [authView, setAuthView] = useState<"signin" | "signup">("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [confirmationEmail, setConfirmationEmail] = useState("");
  const [invitationCode, setInvitationCode] = useState("");
  const [team, setTeam] = useState<CloudTeamState | null>(null);
  const [teamEmail, setTeamEmail] = useState("");
  const [teamRole, setTeamRole] = useState<"admin" | "member">("member");
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamErr, setTeamErr] = useState<string | null>(null);
  const [healthSources, setHealthSources] = useState<HealthSource[]>([]);
  const [healthFilter, setHealthFilter] = useState<"all" | HealthStatus>("all");
  const [appVersion, setAppVersion] = useState("");
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateStatus | null>(null);
  const [desktopUpdateChecking, setDesktopUpdateChecking] = useState(false);
  const [desktopUpdateInstalling, setDesktopUpdateInstalling] = useState(false);
  const [desktopUpdateErr, setDesktopUpdateErr] = useState<string | null>(null);
  const [logDir, setLogDir] = useState<string | undefined>(undefined);
  const [logView, setLogView] = useState<{ file: string; content: string } | null>(null);
  const [logErr, setLogErr] = useState<string | null>(null);
  const [diag, setDiag] = useState<DiagnoseReport | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("all");
  const [profilePage, setProfilePage] = useState(0);
  const [groupsOpen, setGroupsOpen] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  // Two error slots so an auto-refresh can't silently wipe why an action failed:
  // actionErr is sticky (Open/Close/move/import), connErr tracks load() only.
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [connErr, setConnErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null); // transient success banner
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveTarget, setMoveTarget] = useState("");
  const [newMode, setNewMode] = useState(false);
  const [newGroup, setNewGroup] = useState("");
  const [dragging, setDragging] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [form, setForm] = useState(BLANK_FORM);
  const [proxyPaste, setProxyPaste] = useState("");
  const [proxyPasteOk, setProxyPasteOk] = useState<string | null>(null);
  // Edit modal + bulk export/update + group rename
  const [editId, setEditId] = useState<string | null>(null);
  const [editExpectedVersion, setEditExpectedVersion] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editErr, setEditErr] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editMobile, setEditMobile] = useState<NonNullable<EditProfile["desktopConversion"]> | null>(null);
  const [editTotp, setEditTotp] = useState<{ code: string; secs: number } | null>(null);
  const [twoFaFlash, setTwoFaFlash] = useState<{ id: string; code: string } | null>(null);
  const [editExts, setEditExts] = useState<string[]>([]);
  // Extensions registry + manager modal
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [showExts, setShowExts] = useState(false);
  const [extBusy, setExtBusy] = useState(false);
  const [extErr, setExtErr] = useState<string | null>(null);
  const extFileRef = useRef<HTMLInputElement>(null);
  const [bulkExt, setBulkExt] = useState(""); // extension chosen for bulk assign
  // Update-from-file modal (export → edit → re-upload, matched by id)
  const [showUpdate, setShowUpdate] = useState(false);
  const [updateFile, setUpdateFile] = useState<File | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateErr, setUpdateErr] = useState<string | null>(null);
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  const [updateOver, setUpdateOver] = useState(false);
  const updateFileRef = useRef<HTMLInputElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [addingGroup, setAddingGroup] = useState(false);
  const [sidebarGroupName, setSidebarGroupName] = useState("");
  // Bulk add accounts (CSV / AdsPower .txt with group + platform assignment)
  const [showBulk, setShowBulk] = useState(false);
  const [bulkFiles, setBulkFiles] = useState<File[]>([]);
  const [bulkText, setBulkText] = useState("");
  const [bulkGroup, setBulkGroup] = useState("");
  const [bulkPlatform, setBulkPlatform] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkErr, setBulkErr] = useState<string | null>(null);
  const [bulkOver, setBulkOver] = useState(false);
  const bulkFileRef = useRef<HTMLInputElement>(null);
  const authGeneration = useRef(0);
  const publishedRuntimeReadiness = useRef<string | null>(null);
  const [runtimeReadinessAttempt, setRuntimeReadinessAttempt] = useState(0);
  const restoreInFlight = useRef(false);
  const savedSessionRestoreEnabled = useRef(true);
  const desktopUpdateCheckStarted = useRef(false);
  const isCloudMode = appMode?.mode === "cloud";
  const workspaceReady = appMode?.mode === "local" || (isCloudMode && cloudWorkspaceReady(cloudAuth));
  const canEditCloud = !isCloudMode || cloudAuth?.workspace?.role === "owner" || cloudAuth?.workspace?.role === "admin" ||
    profiles.some((profile) => profile.permission === "edit") || team?.folders.some((folder) => folder.permission === "edit") === true;
  const canManageCloudFolders = cloudAuth?.workspace?.role === "owner" || cloudAuth?.workspace?.role === "admin";

  const load = async () => {
    try {
      const roster = await fetchProfiles();
      setProfiles(roster.profiles);
      setRegisteredGroups(roster.groups);
      setHealthSources(roster.healthSources);
      setConnErr(null); // manages connectivity only; never clears an action error
    } catch (e) {
      setConnErr(String(e));
    } finally {
      setLoaded(true);
    }
  };

  const loadCloudEvents = async () => {
    if (!isCloudMode) {
      setCloudEvents([]);
      setCloudEventsErr(null);
      return;
    }
    setCloudEventsBusy(true);
    setCloudEventsErr(null);
    try {
      setCloudEvents((await fetchCloudEvents()).slice().reverse());
    } catch {
      setCloudEventsErr("Recent diagnostics could not be loaded.");
    } finally {
      setCloudEventsBusy(false);
    }
  };

  const loadTeam = async () => {
    if (!isCloudMode) return;
    setTeamBusy(true);
    setTeamErr(null);
    try { setTeam(await fetchCloudTeam()); }
    catch (error) { setTeamErr(error instanceof Error ? error.message : String(error)); }
    finally { setTeamBusy(false); }
  };

  const runTeamAction = async (action: string, input: Record<string, string>, done?: string): Promise<boolean> => {
    setTeamBusy(true);
    setTeamErr(null);
    try {
      await cloudWorkspaceAction(action, input);
      await loadTeam();
      if (done) flash(done);
      return true;
    } catch (error) {
      setTeamErr(error instanceof Error ? error.message : String(error));
      setTeamBusy(false);
      return false;
    }
  };

  const inviteTeamMember = async () => {
    const email = teamEmail.trim();
    const ok = await runTeamAction("invite", { email, role: teamRole }, `Invitation sent to ${email}`);
    if (ok) setTeamEmail("");
  };

  const checkDesktopUpdate = async (manual: boolean) => {
    const invoke = desktopInvoke();
    if (!invoke) {
      if (manual) setDesktopUpdateErr("Updates are available only in the Windows desktop app.");
      return;
    }
    setDesktopUpdateChecking(true);
    if (manual) setDesktopUpdateErr(null);
    try {
      setDesktopUpdate(parseDesktopUpdateStatus(await invoke("check_for_updates")));
    } catch (error) {
      if (manual) setDesktopUpdateErr(error instanceof Error ? error.message : String(error));
    } finally {
      setDesktopUpdateChecking(false);
    }
  };

  const installDesktopUpdate = async () => {
    const invoke = desktopInvoke();
    if (!invoke || desktopUpdate?.state !== "available") return;
    setDesktopUpdateInstalling(true);
    setDesktopUpdateErr(null);
    try {
      await invoke("update_now");
      setDesktopUpdateInstalling(false);
    } catch (error) {
      setDesktopUpdateErr(error instanceof Error ? error.message : String(error));
      setDesktopUpdateInstalling(false);
    }
  };

  const openAccountSettings = () => {
    setModeErr(null);
    setShowAccount(true);
    void loadCloudEvents();
    void loadTeam();
  };

  const chooseMode = async (mode: "local" | "cloud"): Promise<boolean> => {
    setModeBusy(true);
    setModeErr(null);
    try {
      const result = await selectAppMode(mode);
      setAppMode(result.config);
      const needsRestart = result.restartRequired === true;
      setRestartRequired(needsRestart);
      const invoke = desktopInvoke();
      if (needsRestart && invoke) await invoke("restart_after_mode_change");
      return true;
    } catch (error) {
      setModeErr(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setModeBusy(false);
    }
  };

  const requestModeSwitch = (mode: "local" | "cloud") => {
    setModeErr(null);
    setPendingMode(mode);
  };

  const confirmModeSwitch = async () => {
    if (!pendingMode) return;
    if (await chooseMode(pendingMode)) {
      setPendingMode(null);
      setShowAccount(false);
    }
  };

  const restoreSavedSession = async (startup: boolean) => {
    if (!savedSessionRestoreEnabled.current || restoreInFlight.current) return;
    restoreInFlight.current = true;
    const generation = authGeneration.current;
    if (startup) {
      setSavedSessionPhase("restoring");
      setAuthBusy(true);
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const stored = await readDesktopCloudCredentials();
          if (generation !== authGeneration.current || !savedSessionRestoreEnabled.current) return;
          if (!stored?.refreshToken || !stored.deviceCredential || !stored.queueKey) {
            setCloudAuth({ authenticated: false });
            setSavedSessionPhase("manual-signin");
            setScheduledRefreshPending(false);
            setAuthErr(null);
            return;
          }
          const result = await restoreCloudSession(
            stored.refreshToken,
            stored.deviceCredential,
            stored.queueKey,
            startup,
          );
          if (generation !== authGeneration.current || !savedSessionRestoreEnabled.current) return;
          if (typeof result.refreshToken !== "string" || !result.refreshToken) {
            throw new Error("Cloud did not return a refresh token");
          }
          await storeDesktopCloudCredentials(result.refreshToken, stored.deviceCredential);
          if (generation !== authGeneration.current || !savedSessionRestoreEnabled.current) return;
          setCloudAuth({
            authenticated: true,
            expiresAt: result.expiresAt,
            user: result.user,
            workspace: result.workspace,
            legal: result.legal,
          });
          setSavedSessionPhase("manual-signin");
          setScheduledRefreshPending(false);
          setAuthErr(null);
          return;
        } catch (error) {
          if (generation !== authGeneration.current || !savedSessionRestoreEnabled.current) return;
          if (error instanceof CloudSessionRestoreError && !error.retryable) {
            setCloudAuth({ authenticated: false });
            setSavedSessionPhase("manual-signin");
            setScheduledRefreshPending(false);
            setAuthErr(error.message);
            return;
          }
          if (attempt === 0) continue;
          const message = error instanceof CloudSessionRestoreError
            ? error.message
            : "Saved Cloud session could not be restored. Try again when the connection is available.";
          setAuthErr(message);
          if (startup) setSavedSessionPhase("retryable-failure");
          else setScheduledRefreshPending(true);
        }
      }
    } finally {
      restoreInFlight.current = false;
      if (startup && generation === authGeneration.current) setAuthBusy(false);
    }
  };

  const signInInstead = async () => {
    savedSessionRestoreEnabled.current = false;
    const generation = ++authGeneration.current;
    setAuthBusy(true);
    setAuthErr(null);
    try {
      await forgetCloudSession();
      if (generation !== authGeneration.current) return;
      setCloudAuth({ authenticated: false });
      setSavedSessionPhase("manual-signin");
      setScheduledRefreshPending(false);
      setProfiles([]);
      setHealthSources([]);
      setSelected(new Set());
      setTeam(null);
      setCloudEvents([]);
      setAuthPassword("");
      setAuthNotice(null);
    } catch (error) {
      if (generation === authGeneration.current) {
        savedSessionRestoreEnabled.current = true;
        setAuthErr(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (generation === authGeneration.current) setAuthBusy(false);
    }
  };

  const submitCloudAuth = async () => {
    const generation = authGeneration.current;
    setAuthBusy(true);
    setAuthErr(null);
    setAuthNotice(null);
    try {
      if (authView === "signup") {
        const result = await signUpCloud(authEmail, authPassword);
        setAuthNotice(result.verificationRequired
          ? "Check your email, verify the account, then sign in."
          : "Account created. You can sign in now.");
        setConfirmationEmail(result.verificationRequired ? authEmail : "");
        setAuthView("signin");
      } else {
        const stored = await readDesktopCloudCredentials();
        const result = await signInCloud(authEmail, authPassword, stored?.queueKey);
        if (generation !== authGeneration.current) return;
        if (typeof result.refreshToken !== "string" || !result.refreshToken) {
          throw new Error("Cloud did not return a refresh token");
        }
        if (typeof result.deviceCredential !== "string" || !result.deviceCredential) {
          throw new Error("Cloud did not return a device credential");
        }
        if (!stored?.queueKey && (typeof result.queueKey !== "string" || !result.queueKey)) {
          throw new Error("Cloud did not initialize encrypted pending sync");
        }
        const persisted = await storeDesktopCloudCredentials(
          result.refreshToken,
          result.deviceCredential,
          typeof result.queueKey === "string" ? result.queueKey : undefined,
        );
        if (generation !== authGeneration.current) return;
        savedSessionRestoreEnabled.current = true;
        setCloudAuth({
          authenticated: true,
          expiresAt: result.expiresAt,
          user: result.user,
          workspace: result.workspace,
          legal: result.legal,
        });
        setSavedSessionPhase("manual-signin");
        setScheduledRefreshPending(false);
        setAuthPassword("");
        if (!persisted) setAuthNotice("Signed in for this run; desktop credential storage is unavailable.");
      }
    } catch (error) {
      if (generation === authGeneration.current) {
        setAuthErr(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (generation === authGeneration.current) setAuthBusy(false);
    }
  };

  const signOut = async () => {
    setAuthBusy(true);
    setAuthErr(null);
    try {
      await signOutCloud();
      authGeneration.current++;
      setCloudAuth({ authenticated: false });
      setSavedSessionPhase("manual-signin");
      setScheduledRefreshPending(false);
      setProfiles([]);
      setHealthSources([]);
      setSelected(new Set());
      setTeam(null);
      setCloudEvents([]);
      setAuthPassword("");
      setAuthNotice(null);
      setShowAccount(false);
    } catch (error) {
      setAuthErr(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const resendConfirmation = async () => {
    setAuthBusy(true);
    setAuthErr(null);
    try {
      await resendCloudSignUp(confirmationEmail);
      setAuthNotice("Confirmation email sent again.");
    } catch (error) {
      setAuthErr(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const acceptInvitation = async () => {
    setAuthBusy(true);
    setAuthErr(null);
    try {
      await acceptCloudInvitation(invitationCode);
      setInvitationCode("");
      setAuthNotice("Invitation accepted.");
      setCloudAuth(await fetchCloudAuth());
      await Promise.all([load(), loadTeam()]);
    } catch (error) {
      setAuthErr(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const acceptCurrentLegal = async () => {
    setAuthBusy(true);
    setAuthErr(null);
    try {
      const result = await acceptCloudLegal();
      setCloudAuth((state) => state ? { ...state, legal: result.legal } : state);
    } catch (error) {
      setAuthErr(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthBusy(false);
    }
  };

  useEffect(() => {
    fetchAppMode().then((config) => {
      setAppMode(config);
      setRestartRequired(config.restartRequired === true);
    }).catch((error) => {
      setConnErr(String(error));
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (restartRequired) return;
    const readiness = appMode?.mode === "local"
      ? "local"
      : appMode?.mode === "cloud" && cloudAuth !== null
        ? cloudAuth.authenticated ? "cloud_authenticated" : "sign_in_required"
        : null;
    const invoke = desktopInvoke();
    if (!readiness || !invoke || publishedRuntimeReadiness.current === readiness) return;
    let active = true;
    let retry: number | undefined;
    publishedRuntimeReadiness.current = readiness;
    void invoke("agent_runtime_ready", { readiness }).catch(() => {
      if (!active || publishedRuntimeReadiness.current !== readiness) return;
      publishedRuntimeReadiness.current = null;
      retry = window.setTimeout(() => {
        if (active) setRuntimeReadinessAttempt((attempt) => attempt + 1);
      }, 500);
    });
    return () => {
      active = false;
      if (retry !== undefined) window.clearTimeout(retry);
    };
  }, [appMode?.mode, cloudAuth?.authenticated, restartRequired, runtimeReadinessAttempt]);

  useEffect(() => {
    if (!appMode || restartRequired || desktopUpdateCheckStarted.current) return;
    desktopUpdateCheckStarted.current = true;
    void checkDesktopUpdate(false);
  }, [appMode?.mode, restartRequired]);

  useEffect(() => {
    if (appMode?.mode !== "cloud" || restartRequired) return;
    let active = true;
    const generation = authGeneration.current;
    setSavedSessionPhase("restoring");
    const restore = async () => {
      try {
        const state = await fetchCloudAuth();
        if (cloudSessionContextReady(state)) {
          if (active && generation === authGeneration.current) {
            setCloudAuth(state);
            setSavedSessionPhase("manual-signin");
            setAuthErr(null);
          }
          return;
        }
      } catch {
        // A saved session can still recover when the first status probe fails.
      }
      if (active && generation === authGeneration.current) await restoreSavedSession(true);
    };
    void restore();
    return () => { active = false; };
  }, [appMode?.mode, restartRequired]);

  useEffect(() => {
    if (
      appMode?.mode !== "cloud" ||
      restartRequired ||
      !cloudAuth?.authenticated ||
      !cloudAuth.expiresAt
    ) return;
    const delay = Math.max(1_000, cloudAuth.expiresAt - Date.now() - 60_000);
    const timer = window.setTimeout(() => { void restoreSavedSession(false); }, delay);
    return () => window.clearTimeout(timer);
  }, [appMode?.mode, restartRequired, cloudAuth?.authenticated, cloudAuth?.expiresAt]);

  useEffect(() => {
    if (appMode?.mode !== "cloud" || restartRequired) return;
    const retryWhenOnline = () => {
      if (savedSessionPhase === "retryable-failure") void restoreSavedSession(true);
      else if (scheduledRefreshPending) void restoreSavedSession(false);
    };
    window.addEventListener("online", retryWhenOnline);
    return () => window.removeEventListener("online", retryWhenOnline);
  }, [appMode?.mode, restartRequired, savedSessionPhase, scheduledRefreshPending]);

  useEffect(() => {
    if (!isCloudMode || !workspaceReady || restartRequired) return;
    void loadTeam();
  }, [isCloudMode, restartRequired, workspaceReady]);

  useEffect(() => {
    if (!appMode || !workspaceReady || restartRequired) return;
    load();
    fetchHealth().then((health) => { setAppVersion(health.version); setLogDir(health.logDir); }).catch(() => {});
    if (appMode.mode === "local") {
      fetchDiagnose().then(setDiag).catch(() => {});
      fetchExtensions().then(setExtensions).catch(() => {});
    }
  }, [appMode?.mode, restartRequired, workspaceReady]);

  useEffect(() => {
    if (!appMode || !workspaceReady || restartRequired) return;
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [appMode?.mode, restartRequired, workspaceReady]);

  // Live 2FA code in the Edit modal: fetch the current TOTP, count it down
  // locally, and refetch when the window rolls over.
  useEffect(() => {
    if (!editId || isCloudMode) { setEditTotp(null); return; }
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetchTotp(editId);
        if (alive) setEditTotp(r.code ? { code: r.code, secs: r.secondsRemaining ?? 30 } : null);
      } catch { if (alive) setEditTotp(null); }
    };
    tick();
    const timer = setInterval(() => {
      setEditTotp((t) => {
        if (!t) return t;
        if (t.secs <= 1) { tick(); return t; }
        return { ...t, secs: t.secs - 1 };
      });
    }, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [editId, isCloudMode]);

  const groups = useMemo(
    () => ["all", ...Array.from(new Set([
      ...profiles.map((profile) => profile.group).filter(Boolean),
      ...(isCloudMode
        ? (team?.folders.filter((folder) => !folder.archivedAt).map((folder) => folder.name) ?? [])
        : registeredGroups),
    ])).sort()],
    [profiles, isCloudMode, registeredGroups, team?.folders],
  );

  const filtered = profiles.filter((p) => {
    if (group !== "all" && p.group !== group) return false;
    if (healthFilter !== "all" && (p.healthStatus ?? "no_data") !== healthFilter) return false;
    if (q) {
      const s = q.toLowerCase();
      if (!p.id.toLowerCase().includes(s) && !p.name.toLowerCase().includes(s)) return false;
    }
    return true;
  });

  const profilePageCount = Math.max(1, Math.ceil(filtered.length / PROFILE_PAGE_SIZE));
  const visibleProfilePage = Math.min(profilePage, profilePageCount - 1);
  const visibleProfiles = filtered.slice(
    visibleProfilePage * PROFILE_PAGE_SIZE,
    (visibleProfilePage + 1) * PROFILE_PAGE_SIZE,
  );
  useEffect(() => setProfilePage(0), [q, group, healthFilter]);
  useEffect(() => {
    if (profilePage !== visibleProfilePage) setProfilePage(visibleProfilePage);
  }, [profilePage, visibleProfilePage]);

  const runningCount = profiles.filter((p) => p.running).length;
  const selectedMobileCount = profiles.filter((p) => selected.has(p.id) && p.mobilePersona).length;
  const existingGroups = groups.slice(1); // drop the "all" pseudo-group
  const editableGroups = isCloudMode
    ? (team?.folders.filter((folder) => folder.permission === "edit" && !folder.archivedAt).map((folder) => folder.name) ??
      existingGroups.filter((name) => profiles.some((profile) => profile.group === name && profile.permission === "edit")))
    : existingGroups;
  const selectedEditable = [...selected].every((id) => profiles.find((profile) => profile.id === id)?.permission === "edit");
  const countFor = (g: string) => profiles.filter((p) => p.group === g).length;
  const canEditGroup = (name: string) => !isCloudMode ||
    team?.folders.some((folder) => folder.name === name && folder.permission === "edit" && !folder.archivedAt) === true ||
    profiles.some((profile) => profile.group === name && profile.permission === "edit");

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allVisibleSelected = visibleProfiles.length > 0 && visibleProfiles.every((p) => selected.has(p.id));
  const toggleAll = () =>
    setSelected((s) => {
      const n = new Set(s);
      if (allVisibleSelected) visibleProfiles.forEach((p) => n.delete(p.id));
      else visibleProfiles.forEach((p) => n.add(p.id));
      return n;
    });

  const moveSelected = async () => {
    const ids = [...selected];
    const group = newMode ? newGroup.trim() : moveTarget;
    if (ids.length === 0 || !group) return;
    setActionErr(null);
    try {
      if (isCloudMode && newMode) await cloudWorkspaceAction("create-folder", { name: group });
      const r = await moveProfiles(ids, group);
      if (r.ok === false) {
        setActionErr(r.error || "move failed");
        return;
      }
      setSelected(new Set());
      setNewMode(false);
      setNewGroup("");
      setMoveTarget("");
      await load();
    } catch (e) {
      setActionErr(String(e));
    }
  };

  const deleteSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} profile(s)? This removes them from the roster (and any saved session). This can't be undone.`)) return;
    setActionErr(null);
    try {
      const r = await deleteProfiles(ids);
      if (r.ok === false) {
        setActionErr(r.error || "delete failed");
        return;
      }
      const problems = [
        r.locked?.length && `${r.locked.length} in use, not deleted: ${r.locked.join(", ")}`,
        r.failed?.length && `${r.failed.length} failed: ${r.failed.join(", ")}`,
      ].filter(Boolean);
      if (problems.length) setActionErr(problems.join("; "));
      setSelected(new Set());
      await load();
    } catch (e) {
      setActionErr(String(e));
    }
  };

  const act = async (id: string, fn: (id: string) => Promise<any>) => {
    setActionErr(null);
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const r = await fn(id);
      await load(); // refresh first; load() no longer clears action errors
      if (r && r.ok === false) setActionErr(r.error || "action failed");
      else if (r && r.warning) setActionErr(`Opened — ${r.warning}`);
    } catch (e) {
      await load().catch(() => {});
      setActionErr(String(e));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const doUpload = async (files: FileList | File[]) => {
    setActionErr(null);
    try {
      const list = await prepUploads(files); // CSV → AdsPower .txt; .txt passthrough
      if (list.length === 0) return;
      const r = await uploadExports(list);
      await load();
      if (r.ok) {
        const issues = r.errors?.length ? ` Reported ${r.errors.length} invalid record(s); invalid proxies were quarantined for repair.` : "";
        alert(`Imported ${r.profiles} profile(s) from ${r.files} file(s).${issues}`);
      }
      else setActionErr(r.error || "import failed");
    } catch (e) {
      setActionErr(String(e));
    }
  };

  // ---- Bulk add accounts (CSV / .txt with group + platform assignment) ----
  const openBulk = () => {
    setBulkFiles([]);
    setBulkText("");
    setBulkGroup(group !== "all" && (!isCloudMode || editableGroups.includes(group)) ? group : "");
    setBulkPlatform("");
    setBulkErr(null);
    setShowBulk(true);
  };
  const closeBulk = () => {
    setShowBulk(false);
    setBulkFiles([]);
    setBulkText("");
    setBulkErr(null);
  };
  const submitBulk = async () => {
    if ((!bulkFiles.length && !bulkText.trim()) || (isCloudMode && !bulkGroup.trim())) return;
    setBulkBusy(true);
    setBulkErr(null);
    try {
      const uploads = [...bulkFiles];
      if (bulkText.trim()) uploads.push(new File([bulkText], "pasted-adspower.txt", { type: "text/plain" }));
      const list = await prepUploads(uploads, bulkGroup.trim(), bulkPlatform);
      if (!list.length) throw new Error("no rows found in the file(s)");
      const r = await uploadExports(list, { group: bulkGroup.trim(), platform: bulkPlatform });
      if (r.ok) {
        closeBulk();
        await load();
        const issues = r.errors?.length ? ` Reported ${r.errors.length} invalid record(s); invalid proxies were quarantined for repair.` : "";
        alert(`Imported ${r.profiles} profile(s) from ${r.files} file(s).${issues}`);
      }
      else setBulkErr(r.error || "import failed");
    } catch (e) {
      setBulkErr(String(e));
    } finally {
      setBulkBusy(false);
    }
  };

  const setF = (k: keyof typeof BLANK_FORM, v: string) => setForm((f) => ({ ...f, [k]: v }));
  // Open prefilled with the folder you're browsing; close always resets so a
  // cancelled draft never leaks into the next open.
  const openCreate = () => {
    setForm({ ...BLANK_FORM, group: group !== "all" && (!isCloudMode || editableGroups.includes(group)) ? group : "" });
    setProxyPaste("");
    setProxyPasteOk(null);
    setCreateErr(null);
    setShowCreate(true);
  };
  const closeCreate = () => {
    setShowCreate(false);
    setForm(BLANK_FORM);
    setProxyPaste("");
    setProxyPasteOk(null);
    setCreateErr(null);
  };
  const applyProxyPaste = (raw: string) => {
    try {
      const parsed = parsePastedProxy(raw, form.proxyType === "socks5" ? "socks5" : "http");
      setForm((current) => ({
        ...current,
        proxyType: parsed.type,
        host: parsed.host,
        port: parsed.port,
        user: parsed.user,
        pass: parsed.pass,
      }));
      setProxyPaste("");
      setProxyPasteOk(`✓ ${parsed.type.toUpperCase()} proxy fields filled`);
      setCreateErr(null);
    } catch (error) {
      setProxyPasteOk(null);
      setCreateErr(error instanceof Error ? error.message : String(error));
    }
  };
  const submitCreate = async () => {
    setCreating(true);
    setCreateErr(null);
    try {
      const r = await createProfile({
        name: form.name,
        group: form.group,
        platform: form.platform,
        screen: form.screen,
        proxy: form.host.trim() ? { type: form.proxyType, host: form.host, port: form.port, user: form.user, pass: form.pass } : null,
      });
      if (r.ok) {
        closeCreate();
        await load();
      } else {
        setCreateErr(r.error || "create failed"); // shown inside the modal
      }
    } catch (e) {
      setCreateErr(String(e));
    } finally {
      setCreating(false);
    }
  };

  // ---- Edit one profile (full detail) ----
  const setEF = (k: string, v: string) => setEditForm((f) => ({ ...f, [k]: v }));
  const openEdit = async (id: string) => {
    setActionErr(null);
    try {
      const p: EditProfile = await fetchProfileEdit(id);
      setEditForm({
        name: p.name, group: p.group, platform: p.platform,
        proxyType: p.proxyType || "http", proxy: p.proxy,
        proxyError: p.proxyError ?? "",
        username: p.username, password: p.password,
        email: p.email, emailPassword: p.emailPassword, twofa: p.twofa,
        resolution: p.resolution, tags: p.tags,
      });
      setEditExts(p.extensions ?? []);
      setEditMobile(p.desktopConversion ?? null);
      setEditExpectedVersion(p.expectedVersion ?? null);
      setEditErr(null);
      setEditId(id);
    } catch (e) {
      setActionErr(String(e));
    }
  };
  const closeEdit = () => { setEditId(null); setEditExpectedVersion(null); setEditForm({}); setEditErr(null); setEditMobile(null); };
  const saveEdit = async () => {
    if (!editId) return;
    setEditSaving(true);
    setEditErr(null);
    try {
      if (isCloudMode && editExpectedVersion === null) throw new Error("Cloud profile version is missing; close and reopen Edit");
      const r = await updateProfile(editId, {
        name: editForm.name ?? "", group: editForm.group ?? "", platform: editForm.platform ?? "",
        proxy: editForm.proxy ?? "", proxyType: editForm.proxyType ?? "http",
        username: editForm.username ?? "", password: editForm.password ?? "",
        email: editForm.email ?? "", emailPassword: editForm.emailPassword ?? "", twofa: editForm.twofa ?? "",
        resolution: editForm.resolution ?? "", tags: editForm.tags ?? "",
        ...(!isCloudMode ? { extensions: editExts } : {}),
      }, isCloudMode ? editExpectedVersion ?? undefined : undefined);
      if (r.ok) { closeEdit(); await load(); }
      else if (r.status === 409) {
        const message = r.error || "Cloud profile changed; reopen Edit before saving";
        closeEdit();
        setActionErr(message);
      } else setEditErr(r.error || "save failed");
    } catch (e) {
      setEditErr(String(e));
    } finally {
      setEditSaving(false);
    }
  };
  const convertEditedMobile = async () => {
    if (!editId || !editMobile) return;
    const platform = editMobile.platform === "macos" ? "macOS" : "Windows";
    const screenNote = editMobile.screenChanged ? ` Its mobile-sized screen will become ${editMobile.resolution}.` : " Its existing desktop-sized screen will be kept.";
    if (!confirm(
      `Convert this imported mobile persona to a stable ${platform} desktop persona?\n\n` +
      `Cookies, login/session, credentials, proxy, timezone, fingerprint seed, tags and extensions are preserved.${screenNote}\n\n` +
      "The website may treat the first launch as a new desktop device and request verification. Other unsaved edits in this dialog are not included.",
    )) return;
    setEditSaving(true);
    setEditErr(null);
    try {
      const r = await convertMobileProfile(editId);
      if (!r.ok) { setEditErr(r.error || "conversion failed"); return; }
      closeEdit();
      await load();
      flash(`Converted profile to a stable ${platform} desktop persona`);
    } catch (e) {
      setEditErr(String(e));
    } finally {
      setEditSaving(false);
    }
  };

  // ---- Extensions manager (upload / delete) ----
  const reloadExtensions = async () => { try { setExtensions(await fetchExtensions()); } catch {} };
  const doUploadExtensions = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setExtBusy(true);
    setExtErr(null);
    try {
      const r = await uploadExtensions(list);
      if (!r.ok) setExtErr(r.error || "upload failed");
      await reloadExtensions();
    } catch (e) {
      setExtErr(String(e));
    } finally {
      setExtBusy(false);
    }
  };
  const doRemoveExtension = async (id: string, name: string) => {
    if (!confirm(`Remove extension "${name}"? It will be unassigned from all profiles.`)) return;
    setExtErr(null);
    try {
      const r = await removeExtension(id);
      if (!r.ok) setExtErr(r.error || "remove failed");
      setEditExts((xs) => xs.filter((x) => x !== id));
      await reloadExtensions();
    } catch (e) {
      setExtErr(String(e));
    }
  };
  const toggleEditExt = (id: string) =>
    setEditExts((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  const bulkAssignExt = async (op: "add" | "remove") => {
    const ids = [...selected];
    if (!ids.length || !bulkExt) return;
    setActionErr(null);
    try {
      const r = await assignExtensionBulk(ids, bulkExt, op);
      if (r.ok === false) { setActionErr(r.error || "extension assign failed"); return; }
      await load();
      const name = extensions.find((x) => x.id === bulkExt)?.name ?? "extension";
      flash(`${op === "add" ? "Added" : "Removed"} “${name}” ${op === "add" ? "to" : "from"} ${r.updated} profile(s)`);
    } catch (e) {
      setActionErr(String(e));
    }
  };

  // ---- 2FA quick-copy (row authenticator button) ----
  const copy2fa = async (id: string) => {
    setActionErr(null);
    try {
      const r = await fetchTotp(id);
      if (!r.code) { setActionErr("no 2FA secret on this profile"); return; }
      try { await navigator.clipboard.writeText(r.code); } catch {}
      setTwoFaFlash({ id, code: r.code });
      setTimeout(() => setTwoFaFlash((f) => (f && f.id === id ? null : f)), 4000);
    } catch (e) {
      setActionErr(String(e));
    }
  };

  // ---- Bulk open / close (bounded concurrency) ----
  const bulkRun = async (op: (id: string) => Promise<any>, pick: (p: UiProfile) => boolean) => {
    const ids = [...selected].filter((id) => { const p = profiles.find((x) => x.id === id); return p && pick(p); });
    if (!ids.length) return;
    setActionErr(null);
    setBusy((b) => { const n = { ...b }; ids.forEach((id) => (n[id] = true)); return n; });
    await runPool(ids, 4, async (id) => { try { await op(id); } catch {} });
    await load();
    setBusy((b) => { const n = { ...b }; ids.forEach((id) => delete n[id]); return n; });
  };
  const openSelected = () => bulkRun(openProfile, (p) => !p.running && !p.mobilePersona);
  const closeSelected = () => bulkRun(closeProfile, (p) => p.running);
  const convertSelectedMobile = async () => {
    const ids = [...selected].filter((id) => profiles.find((p) => p.id === id)?.mobilePersona);
    if (!ids.length) return;
    if (!confirm(
      `Convert ${ids.length} selected mobile persona(s) to stable desktop personas?\n\n` +
      "Account data, sessions, proxies, timezones and fingerprint seeds are preserved. Android keeps the Windows desktop family used by older AliasMode; iPhone/iPad keeps macOS. A website may request device verification on first launch.",
    )) return;
    setActionErr(null);
    setBusy((b) => { const n = { ...b }; ids.forEach((id) => (n[id] = true)); return n; });
    const failed: string[] = [];
    await runPool(ids, 4, async (id) => {
      try {
        const r = await convertMobileProfile(id);
        if (!r.ok) failed.push(`${id}: ${r.error || "conversion failed"}`);
      } catch (e) {
        failed.push(`${id}: ${String(e)}`);
      }
    });
    await load().catch(() => {});
    setBusy((b) => { const n = { ...b }; ids.forEach((id) => delete n[id]); return n; });
    if (failed.length) setActionErr(`${ids.length - failed.length} converted; ${failed.length} failed — ${failed.join("; ")}`);
    else flash(`Converted ${ids.length} mobile persona(s) to stable desktop personas`);
  };

  // ---- Export selected → file ----
  const exportSelected = async (format: ExportFormat) => {
    setExportOpen(false);
    if (!selected.size) return;
    try { await exportProfiles([...selected], format); }
    catch (e) { setActionErr(String(e)); }
  };

  // ---- Transient success banner ----
  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice((cur) => (cur === m ? null : cur)), 3500); };

  // ---- File-based bulk update (export → edit → re-upload, matched by id) ----
  const openUpdate = () => { setShowUpdate(true); setUpdateFile(null); setUpdateErr(null); setUpdateResult(null); };
  const submitUpdate = async () => {
    if (!updateFile) return;
    setUpdateBusy(true); setUpdateErr(null); setUpdateResult(null);
    try {
      const r = await updateFromFile([updateFile]);
      if (!r.ok) { setUpdateErr(r.error || "update failed"); return; }
      let m = `Updated ${r.updated} profile(s)`;
      if (r.notFound?.length) m += ` · ${r.notFound.length} id(s) in the file matched no profile`;
      if (r.skipped) m += ` · ${r.skipped} row(s) skipped (no id)`;
      setUpdateResult(m);
      await load();
    } catch (e) {
      setUpdateErr(String(e));
    } finally {
      setUpdateBusy(false);
    }
  };

  // ---- Group create / rename / delete ----
  const createSidebarGroup = async () => {
    const name = sidebarGroupName.trim();
    if (!name) return;
    if (name === "all") {
      setActionErr("This name is reserved.");
      return;
    }
    setActionErr(null);
    try {
      const result = isCloudMode
        ? await cloudWorkspaceAction("create-folder", { name })
        : await createGroup(name);
      if (result.ok === false) {
        setActionErr(result.error || "create failed");
        return;
      }
      await Promise.all([load(), isCloudMode ? loadTeam() : Promise.resolve()]);
      setGroup(name);
      setSidebarGroupName("");
      setAddingGroup(false);
    } catch (error) {
      setActionErr(error instanceof Error ? error.message : String(error));
    }
  };
  const startRename = (g: string) => { setRenaming(g); setRenameVal(g); };
  const commitRename = async () => {
    const from = renaming, to = renameVal.trim();
    setRenaming(null);
    if (!from || !to || to === from) return;
    setActionErr(null);
    try {
      const r = await renameGroup(from, to);
      if (r.ok === false) setActionErr(r.error || "rename failed");
      else {
        if (group === from) setGroup(to);
        await Promise.all([load(), isCloudMode ? loadTeam() : Promise.resolve()]);
      }
    } catch (e) {
      setActionErr(String(e));
    }
  };
  const removeGroup = async (g: string) => {
    const n = countFor(g);
    const prompt = isCloudMode
      ? `Permanently delete folder "${g}"? Only an empty folder can be deleted.`
      : `Delete group "${g}"?${n ? ` Its ${n} profile(s) move to Ungrouped (not deleted).` : ""}`;
    if (!confirm(prompt)) return;
    setActionErr(null);
    try {
      const r = isCloudMode
        ? await cloudWorkspaceAction("delete-folder", { name: g })
        : await deleteGroup(g);
      if (r.ok === false) setActionErr(r.error || "delete failed");
      else {
        if (group === g) setGroup("all");
        await Promise.all([load(), isCloudMode ? loadTeam() : Promise.resolve()]);
      }
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (!appMode || !workspaceReady || restartRequired) {
    return (
      <>
        <main className="onboarding">
        <section className="onboarding-card" aria-labelledby="onboarding-title">
          <div className="onboarding-brand">AliasMode <span>by Xreacher</span></div>
          {restartRequired ? (
            <>
              <h1 id="onboarding-title">Your mode is ready</h1>
              <p>Quit and reopen AliasMode to start in {appMode?.mode === "cloud" ? "Cloud" : "Local"} mode.</p>
              {modeErr && <div className="mode-error" role="alert">{modeErr}</div>}
              <button className="mode-primary" type="button" onClick={() => window.close()}>Quit AliasMode</button>
            </>
          ) : appMode?.mode === "cloud" ? (
            cloudAuth?.authenticated ? (
              <>
                <h1 id="onboarding-title">Review the Cloud terms</h1>
                <p>Accept the current policies before synchronizing this workspace.</p>
                <div className="auth-actions">
                  <a href="https://aliasmode.com/terms/" target="_blank" rel="noreferrer">Terms</a>
                  <a href="https://aliasmode.com/privacy/" target="_blank" rel="noreferrer">Privacy</a>
                  <a href="https://aliasmode.com/acceptable-use/" target="_blank" rel="noreferrer">Acceptable Use</a>
                </div>
                {authErr && <div className="mode-error" role="alert">{authErr}</div>}
                <button
                  className="mode-primary"
                  type="button"
                  disabled={authBusy || !cloudAuth.legal}
                  onClick={() => void acceptCurrentLegal()}
                >
                  {authBusy ? "Working…" : cloudAuth.legal ? "Accept and continue to Cloud" : "Checking workspace…"}
                </button>
                {modeErr && <div className="mode-error" role="alert">{modeErr}</div>}
              </>
            ) : savedSessionPhase === "restoring" ? (
              <>
                <h1 id="onboarding-title">Restoring saved session</h1>
                <p role="status">Checking the saved Cloud session on this device…</p>
              </>
            ) : savedSessionPhase === "retryable-failure" ? (
              <>
                <h1 id="onboarding-title">Restoring saved session</h1>
                <p>The saved session is still on this device. Reconnect and try again.</p>
                {authErr && <div className="mode-error" role="alert">{authErr}</div>}
                <div className="auth-actions">
                  <button className="mode-primary" type="button" disabled={authBusy} onClick={() => void restoreSavedSession(true)}>Try again</button>
                  <button className="mode-secondary" type="button" disabled={authBusy} onClick={() => void signInInstead()}>Sign in instead</button>
                </div>
              </>
            ) : (
              <>
                <h1 id="onboarding-title">{authView === "signin" ? "Sign in to AliasMode Cloud" : "Create your Cloud account"}</h1>
                <p>Verified accounts can synchronize portable profiles across authorized devices.</p>
                <form className="auth-form" onSubmit={(event) => { event.preventDefault(); void submitCloudAuth(); }}>
                  <label>Email<input type="email" autoComplete="email" required value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} /></label>
                  <label>Password<input type="password" autoComplete={authView === "signin" ? "current-password" : "new-password"} required value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} /></label>
                  {authErr && <div className="mode-error" role="alert">{authErr}</div>}
                  {authNotice && <div className="auth-notice" role="status">{authNotice}</div>}
                  {confirmationEmail && (
                    <button type="button" className="mode-secondary" disabled={authBusy} onClick={() => void resendConfirmation()}>
                      Resend confirmation
                    </button>
                  )}
                  <button className="mode-primary" type="submit" disabled={authBusy}>{authBusy ? "Working…" : authView === "signin" ? "Sign in" : "Create account"}</button>
                </form>
                <div className="auth-actions">
                  <button type="button" onClick={() => { setAuthErr(null); setAuthNotice(null); setAuthView(authView === "signin" ? "signup" : "signin"); }}>
                    {authView === "signin" ? "Create an account" : "Back to sign in"}
                  </button>
                </div>
                {modeErr && <div className="mode-error" role="alert">{modeErr}</div>}
              </>
            )
          ) : appMode ? (
            <>
              <h1 id="onboarding-title">How do you want to use AliasMode?</h1>
              <p>Choose where browser profiles live for this installation.</p>
              <div className="mode-options">
                <button className="mode-option primary" type="button" disabled={modeBusy} onClick={() => chooseMode("cloud")}>
                  <strong>AliasMode Cloud</strong>
                  <span>Sync profiles across authorized devices and work with your team.</span>
                </button>
                <button className="mode-option" type="button" disabled={modeBusy} onClick={() => chooseMode("local")}>
                  <strong>AliasMode Local</strong>
                  <span>No account. Profile data stays on this computer and analytics is off.</span>
                </button>
              </div>
              {modeErr && <div className="mode-error" role="alert">{modeErr}</div>}
            </>
          ) : (
            <>
              <h1 id="onboarding-title">Starting AliasMode</h1>
              <p>{connErr ?? "Loading your configuration…"}</p>
              {connErr && <button className="mode-primary" type="button" onClick={() => window.location.reload()}>Try again</button>}
            </>
          )}
          </section>
        </main>
        {pendingMode && (
          <ModeSwitchConfirmation
            mode={pendingMode}
            busy={modeBusy}
            error={modeErr}
            onConfirm={() => void confirmModeSwitch()}
            onCancel={() => { if (!modeBusy) setPendingMode(null); }}
          />
        )}
      </>
    );
  }

  const diagWhen = diag ? new Date(diag.generatedAt).toLocaleTimeString() : null;

  return (
    <div
      className="app"
      onDragOver={(e) => { e.preventDefault(); if (isCloudMode) return; if (!dragging) setDragging(true); }}
      onDragLeave={(e) => { e.preventDefault(); if (isCloudMode) return; if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => {
        e.preventDefault();
        if (isCloudMode) return;
        setDragging(false);
        if (e.dataTransfer.files?.length) doUpload(e.dataTransfer.files);
      }}
    >
      {!isCloudMode && dragging && <div className="dropzone">Drop AdsPower <code>.txt</code> or <code>.csv</code> files to import</div>}

      <aside className="sidebar">
        <div className="brandrow">
          <div className="brand"><img src={aliasLoopUrl} alt="" />AliasMode</div>
          {appVersion && <span className="appversion">{appVersion}</span>}
        </div>
        <div className="newrow">
          <button className="newbtn" disabled={!canEditCloud} onClick={openCreate}>+ New Profile</button>
          <button className="importbtn" disabled={!canEditCloud} title="Import / bulk-add accounts from CSV or AdsPower .txt" onClick={openBulk}>⤓</button>
        </div>
        <div className={`folder${group === "all" ? " active" : ""}`} onClick={() => setGroup("all")}>
          <span>All profiles</span><span className="cnt">{profiles.length}</span>
        </div>
        <div className="sidesection">
          <button className="sidehead" onClick={() => setGroupsOpen((o) => !o)}>
            <span className={`chev${groupsOpen ? " open" : ""}`}>▸</span>
            <span>{isCloudMode ? "Folders" : "Groups"}</span>
            <span className="grow" />
            <span className="cnt">{existingGroups.length}</span>
          </button>
          {groupsOpen && <>
            <div className="folders">
            {existingGroups.length === 0 && <div className="folders-empty">No {isCloudMode ? "folders" : "groups"} yet</div>}
            {existingGroups.map((g) => (
              <div
                key={g}
                className={`folder${group === g ? " active" : ""}`}
                onClick={() => { if (renaming !== g) setGroup(g); }}
              >
                {renaming === g ? (
                  <input
                    className="renameinput"
                    autoFocus
                    value={renameVal}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameVal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") commitRename(); else if (e.key === "Escape") setRenaming(null); }}
                    onBlur={commitRename}
                  />
                ) : (
                  <>
                    <span className="fname" title={g}>{g}</span>
                    {(canEditGroup(g) || (isCloudMode && canManageCloudFolders)) && (
                      <span className="gactions">
                        {canEditGroup(g) && <button title={isCloudMode ? "Rename folder" : "Rename group"} onClick={(e) => { e.stopPropagation(); startRename(g); }}>✎</button>}
                        {(!isCloudMode || canManageCloudFolders) && <button title={isCloudMode ? "Delete folder" : "Delete group"} onClick={(e) => { e.stopPropagation(); removeGroup(g); }}>🗑</button>}
                      </span>
                    )}
                    <span className="cnt">{countFor(g)}</span>
                  </>
                )}
              </div>
            ))}
            </div>
            {addingGroup ? (
              <div className="newgroup">
                <input
                  autoFocus
                  aria-label={isCloudMode ? "New folder name" : "New group name"}
                  value={sidebarGroupName}
                  onChange={(event) => setSidebarGroupName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void createSidebarGroup();
                    else if (event.key === "Escape") { setAddingGroup(false); setSidebarGroupName(""); }
                  }}
                />
                <button type="button" title="Create" onClick={() => void createSidebarGroup()}>✓</button>
                <button type="button" title="Cancel" onClick={() => { setAddingGroup(false); setSidebarGroupName(""); }}>×</button>
              </div>
            ) : (
              <button className="newgroup" type="button" disabled={!canEditCloud} onClick={() => setAddingGroup(true)}>
                {isCloudMode ? "+ New folder" : "+ New group"}
              </button>
            )}
          </>}
        </div>
        {!isCloudMode && <button className="extbtn" onClick={() => { setExtErr(null); setShowExts(true); }}>🧩 Extensions</button>}
        <button
          className="extbtn"
          type="button"
          title="View detailed logs"
          onClick={() => {
            setLogErr(null);
            setLogView(null);
            fetchLogs().then(setLogView).catch((e) => setLogErr(e instanceof Error ? e.message : String(e)));
          }}
        >📄 Logs</button>
        <button
          className="account-button"
          type="button"
          aria-label="Open Account and Settings"
          title="Account & Settings"
          onClick={openAccountSettings}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="8" r="3.5" />
            <path d="M5.5 20c.5-4 2.7-6 6.5-6s6 2 6.5 6" />
          </svg>
          <span>Account &amp; Settings</span>
        </button>
        {modeErr && <div className="mode-error" role="alert">{modeErr}</div>}
      </aside>

      <div className="main">
      <header className="toolbar">
        <input className="search" placeholder="search id or name…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select
          className="health-filter"
          aria-label="Health filter"
          value={healthFilter}
          onChange={(e) => setHealthFilter(e.target.value as "all" | HealthStatus)}
        >
          <option value="all">All health</option>
          <option value="suspended">Suspended</option>
          <option value="alive">Alive</option>
          <option value="no_data">No data</option>
        </select>
        <span className="spacer" />
        <HealthSources sources={healthSources} />
      </header>

      {(actionErr ?? connErr) && (
        <div className="error">
          <span>{actionErr ?? connErr}</span>
          <button className="dismiss" onClick={() => { setActionErr(null); setConnErr(null); }}>×</button>
        </div>
      )}
      {notice && <div className="notice" role="status" onClick={() => setNotice(null)}>{notice}</div>}
      {desktopUpdate?.state === "available" && (
        <div className="update-banner" role="status">
          <span><strong>AliasMode {desktopUpdate.version} is available.</strong> The update will save active browsers and restart the app.</span>
          <button type="button" disabled={desktopUpdateChecking || desktopUpdateInstalling} onClick={() => void installDesktopUpdate()}>
            {desktopUpdateInstalling ? "Downloading and verifying…" : "Update now"}
          </button>
        </div>
      )}

      <div className={`actionbar${selected.size ? " active" : ""}`}>
        <span className="count">{selected.size ? `${selected.size} selected` : "No selection"}</span>
        <button className="btn open sm" disabled={!selected.size} onClick={openSelected}>Open</button>
        <button className="btn close sm" disabled={!selected.size} onClick={closeSelected}>Close</button>
        {(!isCloudMode || selectedEditable) && <>
        {!isCloudMode && <>
        {selectedMobileCount > 0 && <button className="abtn convert" onClick={convertSelectedMobile}>Convert mobile ({selectedMobileCount})</button>}
        <div className="exportwrap">
          <button className="abtn" disabled={!selected.size} onClick={() => setExportOpen((o) => !o)}>Export ▾</button>
          {exportOpen && selected.size > 0 && (
            <div className="exportmenu" onMouseLeave={() => setExportOpen(false)}>
              <button onClick={() => exportSelected("csv")}>Export as CSV (credentials)</button>
              <button onClick={() => exportSelected("txt")}>Export as .txt (full profile)</button>
              <button onClick={() => exportSelected("xlsx")}>Export as Excel (full profile)</button>
            </div>
          )}
        </div>
        <button className="abtn" disabled={!selected.size} onClick={openUpdate} title="Export → edit → re-upload to change credentials in bulk">Edit from file</button>
        </>}
        <span className="vsep" />
        <span className="movelbl">Move to</span>
        {newMode ? (
          <input className="moveinput" autoFocus placeholder="new group name" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
        ) : (
          <select
            className="move-group"
            title={moveTarget || "Choose group"}
            disabled={!selected.size}
            value={moveTarget}
            onChange={(e) => (e.target.value === "__new__" ? setNewMode(true) : setMoveTarget(e.target.value))}
          >
            <option value="">choose group…</option>
            {editableGroups.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
            <option value="__new__">+ new group…</option>
          </select>
        )}
        {newMode && (
          <button className="link" onClick={() => { setNewMode(false); setNewGroup(""); }}>cancel</button>
        )}
        <button className="primary" disabled={!selected.size || (newMode ? !newGroup.trim() : !moveTarget)} onClick={moveSelected}>
          Move
        </button>
        {!isCloudMode && extensions.length > 0 && (
          <>
            <span className="vsep" />
            <div className="extctl">
              <span className="extctl-lbl">🧩 Extension</span>
              <select className="extctl-sel" disabled={!selected.size} value={bulkExt} onChange={(e) => setBulkExt(e.target.value)}>
                <option value="">choose…</option>
                {extensions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <button className="extctl-btn" disabled={!selected.size || !bulkExt} onClick={() => bulkAssignExt("add")}>Add</button>
              <button className="extctl-btn" disabled={!selected.size || !bulkExt} onClick={() => bulkAssignExt("remove")}>Remove</button>
            </div>
          </>
        )}
        <span className="spacer" />
        {(!isCloudMode || selectedEditable) && <button className="abtn danger" disabled={!selected.size} onClick={deleteSelected}>Delete</button>}
        </>}
      </div>

      <div className="tablewrap">
        <table className="profile-table">
          <thead>
            <tr>
              <th className="chk"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} /></th>
              <th></th>
              <th>id</th>
              <th>name</th>
              <th>group</th>
              <th>platform</th>
              <th>tags</th>
              <th>proxy</th>
              <th>health</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visibleProfiles.map((p) => (
              <tr key={p.id} className={p.running ? "running" : ""}>
                <td className="chk"><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} /></td>
                <td><StatusDot running={p.running} /></td>
                <td className="mono">{p.id}</td>
                <td className="profile-name" title={p.name}>{p.name}</td>
                <td className="profile-group" title={p.group}>{p.group ? <span className="chip">{p.group}</span> : <span className="muted">—</span>}</td>
                <td><PlatformPill platform={p.platform} /></td>
                <td className="tags">{p.tags?.length ? p.tags.map((t) => <span key={t} className="chip">{t}</span>) : <span className="muted">—</span>}</td>
                <td className="mono" title={p.proxyError}>{p.proxyError ? "⚠ invalid — edit" : p.proxy ?? "—"}</td>
                <td><HealthBadge profile={p} /></td>
                <td className="act">
                  {!isCloudMode && p.has2fa && (
                    <button
                      className={`btn twofa${twoFaFlash?.id === p.id ? " flash" : ""}`}
                      title="Copy current 2FA code"
                      onClick={() => copy2fa(p.id)}
                    >
                      {twoFaFlash?.id === p.id ? `✓ ${twoFaFlash.code}` : "2FA"}
                    </button>
                  )}
                  {(!isCloudMode || (p.permission === "edit" && !p.running && !p.lockedBy)) && <button className="btn edit" onClick={() => openEdit(p.id)}>Edit</button>}
                  {p.running ? (
                    <>
                      <button className="btn raise" title="Bring this browser window to the front" disabled={busy[p.id]} onClick={() => act(p.id, raiseProfile)}>Bring to front</button>
                      <button className="btn close" disabled={busy[p.id]} onClick={() => act(p.id, closeProfile)}>Close</button>
                    </>
                  ) : p.mobilePersona ? (
                    p.lockedBy ? (
                      <span className="lockedby" title={`in use by ${p.lockedBy}; close it there before conversion`}>🔒 {p.lockedBy} · mobile persona</span>
                    ) : (
                      (!isCloudMode || p.permission === "edit") ? <button className="btn convert" disabled={busy[p.id]} title="Convert this unsupported mobile persona to a coherent desktop device" onClick={() => openEdit(p.id)}>Convert device</button> : null
                    )
                  ) : p.lockedBy ? (
                    <span className="lockedby" title={`session writer: ${p.lockedBy}; this browser will not save its session back`}>
                      ⚠ {p.lockedBy}{" "}
                      <button className="btn open" disabled={busy[p.id]} onClick={() => act(p.id, openProfile)}>Open</button>
                    </span>
                  ) : (
                    <button className="btn open" disabled={busy[p.id]} onClick={() => act(p.id, openProfile)}>Open</button>
                  )}
                </td>
              </tr>
            ))}
            {loaded && filtered.length === 0 && (
              <tr>
                <td colSpan={10} className="empty">
                  {profiles.length === 0
                    ? isCloudMode
                      ? "No Cloud profiles yet — click New Profile to create one."
                      : "No profiles yet — drop an AdsPower export in the inbox and click Import."
                    : "No profiles match the current filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showDiag && diag && (
        <div className="diagpanel">
          <div className="when">Last diagnose: {diagWhen}</div>
          {diag.analysis.verdicts.map((v, i) => (
            <div className="v" key={i}>{v}</div>
          ))}
        </div>
      )}

      <footer className="statusbar">
        <span>{profiles.length} profiles · {runningCount} running</span>
        {filtered.length > PROFILE_PAGE_SIZE && (
          <span className="profile-pages">
            <button disabled={visibleProfilePage === 0} onClick={() => setProfilePage(visibleProfilePage - 1)}>Previous</button>
            <span>
              {visibleProfilePage * PROFILE_PAGE_SIZE + 1}–{Math.min((visibleProfilePage + 1) * PROFILE_PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            <button disabled={visibleProfilePage + 1 >= profilePageCount} onClick={() => setProfilePage(visibleProfilePage + 1)}>Next</button>
          </span>
        )}
        {diag && (
          <span className="diag" onClick={() => setShowDiag((s) => !s)}>
            Diagnose · last {diagWhen} {showDiag ? "▾" : "▸"}
          </span>
        )}
      </footer>
      </div>

      {showAccount && (
        <div className="modal-backdrop" onClick={() => setShowAccount(false)}>
          <div className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="account-settings-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head" id="account-settings-title">Account &amp; Settings</div>
            <div className="modal-body">
              <section className="settings-section">
                <h2>Account</h2>
                <div className="settings-row"><span>Signed in as</span><strong>{isCloudMode ? cloudAuth?.user?.email ?? "Cloud account" : "Local · no account"}</strong></div>
                <div className="settings-row"><span>Mode</span><strong>{isCloudMode ? "AliasMode Cloud" : "AliasMode Local"}</strong></div>
                {isCloudMode && cloudAuth?.authenticated && (
                  <button type="button" disabled={authBusy} onClick={() => void signOut()}>
                    {authBusy ? "Signing out…" : "Sign out / Switch account"}
                  </button>
                )}
              </section>
              <section className="settings-section update-settings">
                <h2>Updates</h2>
                <div className="settings-row"><span>Installed version</span><strong className="mono">{appVersion || desktopUpdate?.currentVersion || "—"}</strong></div>
                {desktopUpdate?.state === "upToDate" && <p role="status">AliasMode is up to date.</p>}
                {desktopUpdate?.state === "available" && (
                  <p role="status">Version {desktopUpdate.version} is ready. Active browsers will be saved and closed.</p>
                )}
                {!desktopUpdate && !desktopUpdateChecking && <p>AliasMode checks for updates when it starts.</p>}
                {desktopUpdateInstalling && <p role="status">Downloading and verifying the update. AliasMode will save browsers and restart.</p>}
                {desktopUpdateErr && <div className="modal-err" role="alert">{desktopUpdateErr}</div>}
                <div className="update-actions">
                  <button type="button" disabled={desktopUpdateChecking || desktopUpdateInstalling} onClick={() => void checkDesktopUpdate(true)}>
                    {desktopUpdateChecking ? "Checking…" : "Check for updates"}
                  </button>
                  {desktopUpdate?.state === "available" && (
                    <button className="primary" type="button" disabled={desktopUpdateChecking || desktopUpdateInstalling} onClick={() => void installDesktopUpdate()}>
                      {desktopUpdateInstalling ? "Updating…" : "Update now"}
                    </button>
                  )}
                </div>
              </section>
              <section className="settings-section">
                <h2>{isCloudMode ? "Team" : "Workspace"}</h2>
                {isCloudMode ? (
                  <>
                    <div className="settings-row"><span>Workspace</span><strong>{cloudAuth?.workspace?.name ?? "Cloud workspace"}</strong></div>
                    <div className="settings-row"><span>Role</span><strong>{cloudAuth?.workspace?.role ?? "member"}</strong></div>
                    {teamBusy && !team && <p className="hint" role="status">Loading team…</p>}
                    <h3 className="settings-subhead">Your folder access</h3>
                    {team?.folders.map((folder) => (
                      <div className="settings-row" key={folder.name}>
                        <span>{folder.name}</span><strong>{folder.permission}</strong>
                      </div>
                    ))}
                    <h3 className="settings-subhead">Members</h3>
                    {team?.members.map((member) => (
                      <div className="team-member" key={member.accountId}>
                        <div className="settings-row">
                          <span>{member.email}<small> · {member.grants.map((grant) => `${grant.folderName}: ${grant.permission}`).join(", ") || "No folder access"}</small></span>
                          {member.role === "owner" || cloudAuth?.workspace?.role !== "owner" ? <strong>{member.role}</strong> : (
                            <select aria-label={`Role for ${member.email}`} value={member.role} disabled={teamBusy} onChange={(event) => void runTeamAction("role", { accountId: member.accountId, role: event.target.value })}>
                              <option value="member">member</option><option value="admin">admin</option>
                            </select>
                          )}
                        </div>
                        {member.role === "member" && (cloudAuth?.workspace?.role === "owner" || cloudAuth?.workspace?.role === "admin") && (
                          <div className="team-grants">
                            {team.folders.filter((folder) => !folder.archivedAt).map((folder) => {
                              const permission = member.grants.find((grant) => grant.folderName === folder.name)?.permission ?? "";
                              return <label key={folder.name}>{folder.name}<select aria-label={`${folder.name} access for ${member.email}`} value={permission} disabled={teamBusy} onChange={(event) => void runTeamAction(event.target.value ? "grant" : "remove-grant", { folderName: folder.name, accountId: member.accountId, permission: event.target.value })}><option value="">No access</option><option value="view">View</option><option value="edit">Edit</option></select></label>;
                            })}
                            <button type="button" aria-label={`Remove ${member.email}`} disabled={teamBusy} onClick={() => void runTeamAction("remove-member", { accountId: member.accountId }, `Removed ${member.email}`)}>Remove</button>
                          </div>
                        )}
                      </div>
                    ))}
                    {(cloudAuth?.workspace?.role === "owner" || cloudAuth?.workspace?.role === "admin") && (
                      <>
                        <h3 className="settings-subhead">Invitations</h3>
                        <form className="team-code" onSubmit={(event) => { event.preventDefault(); void inviteTeamMember(); }}>
                          <input type="email" aria-label="Invite email" aria-describedby="invite-team-help" placeholder="Staff email address" value={teamEmail} disabled={teamBusy} onChange={(event) => setTeamEmail(event.target.value)} />
                          {cloudAuth?.workspace?.role === "owner" && <select aria-label="Invitation role" value={teamRole} disabled={teamBusy} onChange={(event) => setTeamRole(event.target.value as "admin" | "member")}><option value="member">Member</option><option value="admin">Admin</option></select>}
                          <button type="submit" disabled={teamBusy || !teamEmail.trim()}>Send invite</button>
                        </form>
                        <p className="hint" id="invite-team-help">Invitations go to that exact verified email. New members see no folders until you grant access here.</p>
                        {team?.invitations.filter((invite) => !invite.acceptedAt && !invite.revokedAt).map((invite) => {
                          const status = invite.expiresAt <= Date.now() ? "Expired" : "Pending";
                          return <div className="settings-row" key={invite.id}>
                            <span>{invite.email}<small>{invite.role}</small></span>
                            <span>
                              <span className={`team-tag ${status.toLowerCase()}`}>{status}</span>
                              {(cloudAuth?.workspace?.role === "owner" || invite.role === "member") && <> <button type="button" aria-label={`Resend invitation to ${invite.email}`} disabled={teamBusy} onClick={() => void runTeamAction("resend", { id: invite.id }, "Invitation resent")}>Resend</button> <button type="button" aria-label={`Revoke invitation to ${invite.email}`} disabled={teamBusy} onClick={() => void runTeamAction("revoke", { id: invite.id }, "Invitation revoked")}>Revoke</button></>}
                            </span>
                          </div>;
                        })}
                      </>
                    )}
                    {teamErr && <p className="modal-err" role="alert">{teamErr}</p>}
                    <h3 className="settings-subhead">Join another workspace</h3>
                    <form className="team-code" onSubmit={(event) => { event.preventDefault(); void acceptInvitation(); }}>
                      <input aria-label="Invitation code" placeholder="Paste invitation code" value={invitationCode} onChange={(event) => setInvitationCode(event.target.value)} />
                      <button type="submit" disabled={authBusy || !invitationCode.trim()}>Accept</button>
                    </form>
                    <p className="hint">Paste the code from your invitation email. It works only for the email you signed in with.</p>
                    {authNotice && <p className="hint" role="status">{authNotice}</p>}
                    {authErr && <p className="modal-err" role="alert">{authErr}</p>}
                  </>
                ) : <p>Local mode has no Cloud workspace.</p>}
              </section>
              {isCloudMode && (
                <section className="settings-section diagnostics-section">
                  <div className="diagnostics-head">
                    <h2>Recent diagnostics</h2>
                    <button type="button" disabled={cloudEventsBusy} onClick={() => void loadCloudEvents()}>
                      {cloudEventsBusy ? "Loading…" : "Refresh"}
                    </button>
                  </div>
                  {cloudEventsErr && <div className="diagnostics-error" role="alert">{cloudEventsErr}</div>}
                  {!cloudEventsErr && cloudEvents.length === 0 && (
                    <p>{cloudEventsBusy ? "Loading recent Cloud events…" : "No Cloud lifecycle events in this run."}</p>
                  )}
                  {cloudEvents.length > 0 && (
                    <div className="diagnostics-list" role="log" aria-label="Recent Cloud diagnostics">
                      {cloudEvents.map((event, index) => (
                        <div className={`diagnostics-row${cloudDiagnosticFailed(event.type) ? " failed" : ""}`} key={`${event.timestamp}-${index}`}>
                          <time dateTime={new Date(event.timestamp).toISOString()}>{new Date(event.timestamp).toLocaleTimeString()}</time>
                          <span>{CLOUD_DIAGNOSTIC_LABELS[event.type]}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <p>Diagnostics contain fixed lifecycle labels only. They exclude profile data and credentials.</p>
                  <button type="button" className="btn" onClick={() => {
                    setLogErr(null);
                    fetchLogs().then(setLogView).catch((e) => setLogErr(e instanceof Error ? e.message : String(e)));
                  }}>View detailed logs</button>
                  {logErr && <p className="hint">Logs: {logErr}</p>}
                  {logView && (
                    <pre className="hint" style={{ maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap", textAlign: "left" }}>
                      {logView.file + "\n" + logView.content}
                    </pre>
                  )}
                  {logDir && <p className="hint">Detailed log file: {logDir}</p>}
                </section>
              )}
              <section className="settings-mode">
                <button type="button" disabled={modeBusy || desktopUpdateInstalling} onClick={() => requestModeSwitch(isCloudMode ? "local" : "cloud")}>
                  Switch to {isCloudMode ? "Local" : "Cloud"}
                </button>
                <p>{isCloudMode ? "Local mode keeps this installation offline from AliasMode Cloud." : "Cloud mode requires an account and does not upload Local profiles automatically."}</p>
              </section>
              {modeErr && <div className="modal-err" role="alert">{modeErr}</div>}
            </div>
            <div className="modal-foot"><button className="link" type="button" onClick={() => setShowAccount(false)}>Close</button></div>
          </div>
        </div>
      )}

      {(logView || logErr) && (
        <div className="modal-backdrop" onClick={() => { setLogView(null); setLogErr(null); }}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">Detailed logs</div>
            <div className="modal-body">
              {logErr && <p className="hint">{logErr}</p>}
              {logView && (
                <pre className="hint" style={{ maxHeight: 360, overflow: "auto", whiteSpace: "pre-wrap", textAlign: "left", userSelect: "text" }}>
                  {logView.file + "\n" + logView.content}
                </pre>
              )}
            </div>
            <div className="modal-foot"><button className="link" type="button" onClick={() => { setLogView(null); setLogErr(null); }}>Close</button></div>
          </div>
        </div>
      )}

      {pendingMode && (
        <ModeSwitchConfirmation
          mode={pendingMode}
          busy={modeBusy}
          error={modeErr}
          onConfirm={() => void confirmModeSwitch()}
          onCancel={() => { if (!modeBusy) setPendingMode(null); }}
        />
      )}

      {showCreate && (
        <div className="modal-backdrop" onClick={closeCreate}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">New profile</div>
            <div className="modal-body">
              {createErr && <div className="modal-err">{createErr}</div>}
              <label className="fld">
                <span>Name</span>
                <input value={form.name} placeholder="auto if blank" onChange={(e) => setF("name", e.target.value)} />
              </label>
              <label className="fld">
                <span>Folder</span>
                <GroupPicker value={form.group} onChange={(v) => setF("group", v)} groups={editableGroups} allowCreate={!isCloudMode} />
              </label>
              <label className="fld">
                <span>Platform</span>
                <PlatformPicker value={form.platform} onChange={(v) => setF("platform", v)} />
              </label>
              <div className="proxy-paste-row">
                <label className="fld grow">
                  <span>Paste proxy to autofill <span className="muted">(select type first · host:port:username:password)</span></span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={proxyPaste}
                    placeholder="Paste here — credentials stay hidden"
                    onChange={(e) => { setProxyPaste(e.target.value); setProxyPasteOk(null); }}
                    onPaste={(e) => {
                      const pasted = e.clipboardData.getData("text");
                      if (pasted) { e.preventDefault(); applyProxyPaste(pasted); }
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyProxyPaste(proxyPaste); } }}
                  />
                </label>
                <button type="button" disabled={!proxyPaste.trim()} onClick={() => applyProxyPaste(proxyPaste)}>Autofill</button>
              </div>
              {proxyPasteOk && <div className="proxy-paste-ok">{proxyPasteOk}</div>}
              <div className="fld-row">
                <label className="fld">
                  <span>Proxy type</span>
                  <select value={form.proxyType} onChange={(e) => setF("proxyType", e.target.value)}>
                    <option value="http">http</option>
                    <option value="socks5">socks5</option>
                  </select>
                </label>
                <label className="fld grow">
                  <span>Host</span>
                  <input value={form.host} placeholder="proxy host (blank = no proxy)" onChange={(e) => setF("host", e.target.value)} />
                </label>
                <label className="fld port">
                  <span>Port</span>
                  <input value={form.port} inputMode="numeric" onChange={(e) => setF("port", e.target.value)} />
                </label>
              </div>
              <div className="fld-row">
                <label className="fld grow"><span>Proxy user</span><input value={form.user} onChange={(e) => setF("user", e.target.value)} /></label>
                <label className="fld grow"><span>Proxy pass</span><input type="password" value={form.pass} onChange={(e) => setF("pass", e.target.value)} /></label>
              </div>
              <FingerprintSettings screen={form.screen} onScreenChange={(value) => setF("screen", value)} />
            </div>
            <div className="modal-foot">
              <button className="link" onClick={closeCreate}>Cancel</button>
              <button className="primary" disabled={creating} onClick={submitCreate}>{creating ? "Creating…" : "Create"}</button>
            </div>
          </div>
        </div>
      )}

      {editId && (
        <div className="modal-backdrop" onClick={closeEdit}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">Edit profile <span className="mono muted">{editId}</span></div>
            <div className="modal-body">
              {editErr && <div className="modal-err">{editErr}</div>}
              {editForm.proxyError && <div className="modal-err">Stored proxy quarantined: {editForm.proxyError}. Replace it below or clear the field.</div>}
              {!isCloudMode && editMobile && (
                <div className="persona-warning">
                  <strong>Imported mobile persona cannot open safely</strong>
                  <span>
                    Older AliasMode opened it as a desktop browser anyway: Android became Windows; iPhone/iPad became macOS. That looked usable, but it was not coherent mobile emulation.
                  </span>
                  <span>
                    Convert it once to {editMobile.platform === "macos" ? "macOS" : "Windows"} desktop. Cookies, login/session, proxy, timezone, credentials and fingerprint seed stay intact
                    {editMobile.screenChanged ? `; the mobile-sized screen becomes ${editMobile.resolution}` : "; the existing desktop-sized screen stays intact"}.
                  </span>
                  <button className="persona-convert" disabled={editSaving} onClick={convertEditedMobile}>
                    {editSaving ? "Converting…" : `Convert to ${editMobile.platform === "macos" ? "macOS" : "Windows"} desktop`}
                  </button>
                </div>
              )}
              <label className="fld">
                <span>Name</span>
                <input value={editForm.name ?? ""} onChange={(e) => setEF("name", e.target.value)} />
              </label>
              <label className="fld">
                <span>Folder</span>
                <GroupPicker value={editForm.group ?? ""} onChange={(v) => setEF("group", v)} groups={editableGroups} allowCreate={!isCloudMode} />
              </label>
              <label className="fld">
                <span>Platform</span>
                <PlatformPicker value={editForm.platform ?? ""} onChange={(v) => setEF("platform", v)} />
              </label>
              <label className="fld">
                <span>Tags <span className="muted">(comma-separated)</span></span>
                <input value={editForm.tags ?? ""} placeholder="e.g. warmup, us, priority" onChange={(e) => setEF("tags", e.target.value)} />
              </label>
              <div className="fld-row">
                <label className="fld">
                  <span>Proxy type</span>
                  <select value={editForm.proxyType ?? "http"} onChange={(e) => setEF("proxyType", e.target.value)}>
                    <option value="http">http</option>
                    <option value="socks5">socks5</option>
                  </select>
                </label>
                <label className="fld grow">
                  <span>Proxy (host:port:user:pass)</span>
                  <input value={editForm.proxy ?? ""} placeholder="blank = no proxy" onChange={(e) => setEF("proxy", e.target.value)} />
                </label>
              </div>
              <div className="fld-row">
                <CopyField label="Username" value={editForm.username ?? ""} onChange={(value) => setEF("username", value)} />
                <CopyField label="Password" value={editForm.password ?? ""} onChange={(value) => setEF("password", value)} />
              </div>
              <div className="fld-row">
                <CopyField label="Email" value={editForm.email ?? ""} onChange={(value) => setEF("email", value)} />
                <CopyField label="Email password" value={editForm.emailPassword ?? ""} onChange={(value) => setEF("emailPassword", value)} />
              </div>
              <CopyField label="2FA secret" value={editForm.twofa ?? ""} onChange={(value) => setEF("twofa", value)} />
              {!isCloudMode && editTotp && (
                <div className="authrow">
                  <span className="authlabel">Authenticator</span>
                  <span className="authcode">{editTotp.code.slice(0, 3)} {editTotp.code.slice(3)}</span>
                  <span className="authsecs" title="seconds until it refreshes">{editTotp.secs}s</span>
                  <button className="tlink" onClick={() => navigator.clipboard?.writeText(editTotp.code)}>Copy</button>
                </div>
              )}
              <FingerprintSettings screen={editForm.resolution ?? ""} onScreenChange={(value) => setEF("resolution", value)} />
              {!isCloudMode && (
                <div className="fld">
                  <span>Extensions</span>
                {extensions.length === 0 ? (
                  <div className="hint" style={{ marginTop: 0 }}>None uploaded yet — add some via 🧩 Extensions in the sidebar.</div>
                ) : (
                  <div className="extassign">
                    {extensions.map((x) => (
                      <label key={x.id} className="extchk">
                        <input type="checkbox" checked={editExts.includes(x.id)} onChange={() => toggleEditExt(x.id)} />
                        <span>{x.name}</span>
                      </label>
                    ))}
                  </div>
                )}
                </div>
              )}
              <div className="hint">Cookies and locked fingerprint values are preserved. Only editable fields change.{!isCloudMode && " Extensions load when the browser opens."}</div>
            </div>
            <div className="modal-foot">
              <button className="link" onClick={closeEdit}>Cancel</button>
              <button className="primary" disabled={editSaving} onClick={saveEdit}>{editSaving ? "Saving…" : "Save changes"}</button>
            </div>
          </div>
        </div>
      )}

      {showBulk && (
        <div className="modal-backdrop" onClick={closeBulk}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">Import accounts</div>
            <div className="modal-body">
              {bulkErr && <div className="modal-err">{bulkErr}</div>}
              <label className="fld">
                <span>Paste AdsPower TXT records</span>
                <textarea
                  rows={8}
                  value={bulkText}
                  placeholder="Paste one or more AdsPower key=value profile records"
                  onChange={(event) => setBulkText(event.target.value)}
                />
              </label>
              <div
                className={`bulkdrop${bulkOver ? " over" : ""}`}
                onClick={() => bulkFileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); if (!bulkOver) setBulkOver(true); }}
                onDragLeave={(e) => { e.preventDefault(); setBulkOver(false); }}
                onDrop={(e) => { e.preventDefault(); setBulkOver(false); if (e.dataTransfer.files?.length) setBulkFiles(Array.from(e.dataTransfer.files)); }}
              >
                <div className="big">⤓</div>
                <div>Or drag &amp; drop files, or <b>click to choose</b></div>
                <div className="sub">CSV (template columns) or an AdsPower <code>.txt</code> export</div>
              </div>
              <input
                ref={bulkFileRef}
                type="file"
                multiple
                accept=".csv,.txt,text/plain,text/csv"
                style={{ display: "none" }}
                onChange={(e) => { if (e.target.files) setBulkFiles(Array.from(e.target.files)); e.target.value = ""; }}
              />
              {bulkFiles.length > 0 && <div className="bulkfiles">Selected: <b>{bulkFiles.map((f) => f.name).join(", ")}</b></div>}
              <label className="fld">
                <span>{isCloudMode ? "Destination folder" : "Assign to group"}</span>
                <GroupPicker value={bulkGroup} onChange={setBulkGroup} groups={isCloudMode ? editableGroups : existingGroups} allowCreate={!isCloudMode} />
              </label>
              <label className="fld">
                <span>Platform</span>
                <select value={bulkPlatform} onChange={(e) => setBulkPlatform(e.target.value)}>
                  {KNOWN_PLATFORMS.map((platform) => <option key={platform.value} value={platform.value}>{platform.label}</option>)}
                </select>
              </label>
              <div className="hint">
                A chosen group or platform overrides every imported record, including AdsPower TXT records.
                <div className="tlinks">
                  <button className="tlink" onClick={() => downloadText("aliasmode-template.csv", CSV_TEMPLATE, "text/csv")}>⤓ CSV template</button>
                  <button className="tlink" onClick={() => downloadText("aliasmode-example.txt", TXT_EXAMPLE, "text/plain")}>⤓ AdsPower .txt example</button>
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="link" onClick={closeBulk}>Cancel</button>
              <button className="primary" disabled={bulkBusy || (!bulkFiles.length && !bulkText.trim()) || (isCloudMode && !bulkGroup)} onClick={submitBulk}>{bulkBusy ? "Importing…" : "Import"}</button>
            </div>
          </div>
        </div>
      )}

      {showExts && (
        <div className="modal-backdrop" onClick={() => setShowExts(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">Extensions</div>
            <div className="modal-body">
              {extErr && <div className="modal-err">{extErr}</div>}
              <div className="hint" style={{ marginTop: 0 }}>
                Chrome Web Store installs are not supported in AliasMode. Profiles use CloakBrowser rather than Google Chrome, so “Switch to Chrome to install extensions and themes” is expected.
              </div>
              <ol className="steps">
                <li>Obtain a trusted extension as a <code>.zip</code> or <code>.crx</code>.</li>
                <li>Upload it here.</li>
                <li>Close the target profile, then use <b>Edit &gt; Extensions</b> to assign it.</li>
                <li>Reopen the profile. AliasMode loads the extension when the browser starts.</li>
              </ol>
              {extensions.length === 0 ? (
                <div className="hint">No extensions uploaded yet.</div>
              ) : (
                <div className="extlist">
                  {extensions.map((x) => (
                    <div key={x.id} className="extrow">
                      <span className="extname">{x.name}</span>
                      <span className="spacer" />
                      <button className="extrm" onClick={() => doRemoveExtension(x.id, x.name)}>Remove</button>
                    </div>
                  ))}
                </div>
              )}
              <input
                ref={extFileRef}
                type="file"
                multiple
                accept=".zip,.crx,application/zip,application/x-chrome-extension"
                style={{ display: "none" }}
                onChange={(e) => { if (e.target.files) doUploadExtensions(e.target.files); e.target.value = ""; }}
              />
            </div>
            <div className="modal-foot">
              <button className="link" onClick={() => setShowExts(false)}>Done</button>
              <button className="primary" disabled={extBusy} onClick={() => extFileRef.current?.click()}>{extBusy ? "Uploading…" : "+ Upload ZIP/CRX"}</button>
            </div>
          </div>
        </div>
      )}

      {showUpdate && (
        <div className="modal-backdrop" onClick={() => setShowUpdate(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">Update profiles from file</div>
            <div className="modal-body">
              {updateErr && <div className="modal-err">{updateErr}</div>}
              {updateResult && <div className="modal-ok">{updateResult}</div>}
              <ol className="steps">
                <li><b>Export</b> the profiles you want to change — that gives you a file with each profile's <code>id</code> (how rows are matched).</li>
                <li><b>Edit</b> the columns you want (name, username, password, 2FA, proxy…). Keep the <code>id</code> column; delete any column you don't want to touch.</li>
                <li><b>Re-upload</b> the edited file below. Matched by <code>id</code>; cookies &amp; fingerprints are preserved — editing a <code>cookie</code> or <code>ua</code> column has no effect, an update never rewrites an identity.</li>
              </ol>
              <div className="updexport">
                {selected.size > 0 ? (
                  <span>
                    Export {selected.size} selected:&nbsp;
                    <button className="tlink" onClick={() => exportSelected("csv")}>⤓ CSV</button>
                    &nbsp;·&nbsp;
                    <button className="tlink" onClick={() => exportSelected("txt")}>⤓ .txt</button>
                    &nbsp;·&nbsp;
                    <button className="tlink" onClick={() => exportSelected("xlsx")}>⤓ Excel</button>
                  </span>
                ) : (
                  <span className="hint" style={{ margin: 0 }}>Tip: select profiles first, then export here to get an editable file.</span>
                )}
                <span className="grow" />
                <button className="tlink" onClick={() => downloadText("aliasmode-update-template.csv", UPDATE_TEMPLATE_CSV, "text/csv")}>⤓ example sheet</button>
              </div>
              <div
                className={`bulkdrop${updateOver ? " over" : ""}`}
                onClick={() => updateFileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); if (!updateOver) setUpdateOver(true); }}
                onDragLeave={(e) => { e.preventDefault(); setUpdateOver(false); }}
                onDrop={(e) => { e.preventDefault(); setUpdateOver(false); if (e.dataTransfer.files?.[0]) setUpdateFile(e.dataTransfer.files[0]); }}
              >
                <div className="big">⤒</div>
                <div>Drag &amp; drop the edited file, or <b>click to choose</b></div>
                <div className="sub">CSV, <code>.txt</code> or Excel <code>.xlsx</code> with an <code>id</code> column</div>
              </div>
              <input
                ref={updateFileRef}
                type="file"
                accept=".csv,.txt,.xlsx,text/plain,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                style={{ display: "none" }}
                onChange={(e) => { if (e.target.files?.[0]) setUpdateFile(e.target.files[0]); e.target.value = ""; }}
              />
              {updateFile && <div className="bulkfiles">Selected: <b>{updateFile.name}</b></div>}
            </div>
            <div className="modal-foot">
              <button className="link" onClick={() => setShowUpdate(false)}>Close</button>
              <button className="primary" disabled={updateBusy || !updateFile} onClick={submitUpdate}>{updateBusy ? "Updating…" : "Update profiles"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
