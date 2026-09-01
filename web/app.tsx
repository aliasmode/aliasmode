import { Channel } from "@tauri-apps/api/core";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { parsePastedProxy } from "./proxy-input.ts";
import {
  describeDesktopUpdateResult,
  parseDesktopUpdateResult,
  type DesktopUpdateResult,
} from "./desktop-update-result.ts";
import {
  type UiProfile,
  type HealthSource,
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
  createCloudConnector,
  fetchCloudConnector,
  revokeCloudConnector,
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
  installWebStoreExtension,
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
  "id,name,group,platform,proxy,proxytype,username,password,twofa,resolution,custom_no\n" +
  "<paste-the-profile-id-here>,New name,Warmup,x.com,1.2.3.4:8080:user:pass,http,new@example.com,NewPass1,JBSWY3DPEHPK3PXP,1920*1080,123456\n";

/**
 * How many profiles a pasted AdsPower export would create. Every record starts
 * with its own `id=` line, so counting those is exact rather than a guess at
 * blocks — and it gives the operator a number to sanity-check before importing.
 */
function countPastedRecords(text: string): number {
  return (text.match(/^id=/gm) ?? []).length;
}

function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

const REFRESH_MS = 3000;
const PROFILE_PAGE_SIZE = 50;
const PAGE_SIZES = [25, 50, 100, 200];

const PAGE_TITLES: Record<"profiles" | "settings" | "extensions", string> = {
  profiles: "Profiles",
  settings: "Settings",
  extensions: "Extensions",
};

const SETTINGS_TABS = [
  { key: "account", label: "Account" },
  { key: "team", label: "Workspace" },
  { key: "advanced", label: "Advanced" },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]["key"];

/** Mirrors MAX_CUSTOM_NO_LENGTH in parse.ts — the server rejects anything longer. */
const MAX_CUSTOM_NO = 12;

/**
 * Roster columns. `width` is the single source of truth: each column is laid out
 * at exactly that width and the table's min-width is their sum, so a column can
 * never be squeezed below a readable size — the roster scrolls sideways instead.
 * Only the checkbox column is fixed; everything else can be hidden.
 */
const COLUMNS = [
  { key: "no", label: "No.", sort: true, width: 96 },
  { key: "name", label: "Name", sort: true, width: 220 },
  { key: "group", label: "Group", sort: true, width: 120 },
  { key: "platform", label: "Platform", sort: true, width: 128 },
  { key: "tags", label: "Tags", sort: false, width: 140 },
  { key: "proxy", label: "Proxy", sort: true, width: 160 },
  /* Every row action lives here, beside Open/Close — no hover reveal. */
  { key: "action", label: "Action", sort: false, width: 190 },
] as const;

/** Width of the always-present select-all checkbox column. */
const CHECKBOX_COLUMN_WIDTH = 44;

type ColumnKey = (typeof COLUMNS)[number]["key"];
type SortKey = ColumnKey | "status";

const THEME_KEY = "aliasmode.shell.theme";

const THEMES = [
  { key: "system", label: "System", icon: "laptop" },
  { key: "light", label: "Light", icon: "sun" },
  { key: "dark", label: "Dark", icon: "moon" },
] as const;

type ThemeChoice = (typeof THEMES)[number]["key"];

function readTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    // Light is the out-of-the-box look; Dark and follow-the-OS System are
    // opt-in from Settings, and whatever is chosen there sticks.
    return stored === "dark" || stored === "system" ? stored : "light";
  } catch { return "light"; }
}

const SIDEBAR_KEY = "aliasmode.shell.sidebarCollapsed";

/**
 * Below this width the sidebar always renders as the icon rail. Hiding it
 * entirely (the old breakpoint behavior) left a small window with no
 * navigation at all — this is a desktop app and the user sizes it freely.
 */
const RAIL_MEDIA = "(max-width: 760px)";

function readRailForced(): boolean {
  try { return window.matchMedia(RAIL_MEDIA).matches; } catch { return false; }
}
const HIDDEN_COLUMNS_KEY = "aliasmode.roster.hiddenColumns";
const PAGE_SIZE_KEY = "aliasmode.roster.pageSize";

/** Tags are off until an operator asks for them — most rosters do not use them. */
const DEFAULT_HIDDEN_COLUMNS: ColumnKey[] = ["tags"];

/** Roster layout preferences are a convenience: a hostile/empty store must not break the view. */
function readHiddenColumns(): Set<ColumnKey> {
  try {
    const stored = localStorage.getItem(HIDDEN_COLUMNS_KEY);
    if (stored === null) return new Set(DEFAULT_HIDDEN_COLUMNS);
    const raw = JSON.parse(stored);
    const known = new Set(COLUMNS.map((column) => column.key as string));
    return new Set((Array.isArray(raw) ? raw : []).filter((key) => known.has(key)) as ColumnKey[]);
  } catch { return new Set(DEFAULT_HIDDEN_COLUMNS); }
}

function readSidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_KEY) === "1"; } catch { return false; }
}

function readPageSize(): number {
  try {
    const stored = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return PAGE_SIZES.includes(stored) ? stored : PROFILE_PAGE_SIZE;
  } catch { return PROFILE_PAGE_SIZE; }
}

function writeSetting(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode / disabled storage */ }
}

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
  heartbeat_terminal_conflict: "Cloud lease ended after a version conflict",
  heartbeat_terminal_access_ended: "Cloud lease ended after access was revoked",
  no_page_observed: "Browser has no visible page",
  no_page_close_requested: "Browser close requested after pages disappeared",
  browser_death_confirmed: "Browser process exit confirmed",
  browser_teardown_unconfirmed: "Browser teardown could not be confirmed",
  session_sync_conflict: "Session synchronization has a terminal conflict",
  access_ended: "Cloud access ended",
};

function cloudDiagnosticFailed(type: CloudDiagnosticEvent["type"]): boolean {
  return type.includes("failed") || type.includes("timeout") || type === "checkpoint_invalid"
    || type === "session_sync_pending" || type === "session_sync_conflict"
    || type === "cleanup_retained" || type === "heartbeat_terminal_conflict"
    || type === "heartbeat_terminal_access_ended" || type === "no_page_close_requested"
    || type === "browser_teardown_unconfirmed" || type === "access_ended";
}

/**
 * Stroke-icon set (16px grid, 1.7 stroke) used everywhere a control needs a
 * glyph. Inline so the dashboard ships no icon font or sprite request, and one
 * `.icon` rule in styles.css controls size and color for all of them.
 */
const ICONS = {
  plus: <path d="M12 5v14M5 12h14" />,
  import: <><path d="M12 3v12" /><path d="M8 11l4 4 4-4" /><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" /></>,
  /* Pulling a file INTO the app. A bare download tray reads as "save to disk",
     which is the opposite of what the import control does. */
  fileImport: <><path d="M15 2H7a2 2 0 00-2 2v16a2 2 0 002 2h10a2 2 0 002-2V6z" /><path d="M14 2v4a2 2 0 002 2h3" /><path d="M12 18v-7" /><path d="M9 14l3-3 3 3" /></>,
  export: <><path d="M12 15V3" /><path d="M8 7l4-4 4 4" /><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  close: <path d="M18 6L6 18M6 6l12 12" />,
  refresh: <><path d="M20 11a8 8 0 10-2.3 5.7" /><path d="M20 4v7h-7" /></>,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  sort: <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />,
  sortUp: <path d="M7 14l5-5 5 5" />,
  sortDown: <path d="M7 10l5 5 5-5" />,
  profiles: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 9v11" /></>,
  folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  folders: <><path d="M8 17a2 2 0 01-2-2V5a2 2 0 012-2h2.88a2 2 0 011.41.59l.71.7A2 2 0 0014.41 5H18a2 2 0 012 2v8a2 2 0 01-2 2z" /><path d="M2 8v11a2 2 0 002 2h14" /></>,
  puzzle: <path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z" />,
  logs: <><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
  user: <><circle cx="12" cy="8" r="3.6" /><path d="M5 20c.6-4 3-6 7-6s6.4 2 7 6" /></>,
  settings: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>,
  columns: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></>,
  play: <path d="M7 4.5l12 7.5-12 7.5z" />,
  power: <><path d="M12 3v9" /><path d="M6.5 6.5a8 8 0 1011 0" /></>,
  trash: <><path d="M4 7h16M10 7V5a1 1 0 011-1h2a1 1 0 011 1v2" /><path d="M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12" /></>,
  edit: <><path d="M4 20h4L20 8a2.8 2.8 0 10-4-4L4 16z" /><path d="M14 6l4 4" /></>,
  move: <><path d="M4 20h13a3 3 0 003-3v-6a2 2 0 00-2-2h-7.5a2 2 0 01-1.6-.8L7.6 5.8A2 2 0 006 5H4a2 2 0 00-2 2v11a2 2 0 002 2z" /><path d="M9 14h6M13 11.5l2.5 2.5L13 16.5" /></>,
  raise: <><rect x="8" y="3" width="13" height="13" rx="2" /><path d="M16 16v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-9a2 2 0 012-2h3" /></>,
  key: <><circle cx="8" cy="12" r="4" /><path d="M12 12h9M18 12v3M15.5 12v2.5" /></>,
  more: <><circle cx="6" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="18" cy="12" r="1.4" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16.2v.3" /></>,
  warning: <><path d="M10.3 4.2L2.8 17a2 2 0 001.7 3h15a2 2 0 001.7-3L13.7 4.2a2 2 0 00-3.4 0z" /><path d="M12 9.5v4M12 17v.3" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  activity: <path d="M3 12h4l3 8 4-16 3 8h4" />,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 118 0v3" /></>,
  cloud: <path d="M7.5 19a4.5 4.5 0 01-.4-9 6 6 0 0111.4 1.6A3.9 3.9 0 0117.5 19z" />,
  laptop: <><rect x="4" y="5" width="16" height="11" rx="2" /><path d="M2 20h20" /></>,
  hash: <path d="M9 4L7 20M17 4l-2 16M4 9h16M3 15h16" />,
  window: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /></>,
  file: <><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 012-2h8" /></>,
  filter: <path d="M4 5h16l-6 7v6l-4 2v-8z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.4 9.1a2.7 2.7 0 015.3.7c0 1.8-2.7 2.2-2.7 3.7" /><path d="M12 16.8v.3" /></>,
} as const;

type IconName = keyof typeof ICONS;

/**
 * Official project links, mirroring the footer on aliasmode.com. The GitHub URL
 * is this repository's own origin, so the two can never drift apart.
 */
const PROJECT_LINKS = [
  {
    href: "https://github.com/aliasmode/aliasmode",
    label: "GitHub",
    path: "M12 .3a12 12 0 00-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.9 1.2 1.9 1.2 1.1 1.9 2.9 1.3 3.6 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 016 0C17.4 5.4 18.4 5.7 18.4 5.7c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0012 .3z",
  },
  {
    href: "https://t.me/aliasmode",
    label: "Telegram",
    path: "M23.91 3.79 20.3 20.84c-.25 1.21-.98 1.5-1.99.93l-5.49-4.05-2.65 2.55c-.3.3-.55.55-1.12.55l.4-5.63 10.24-9.25c.45-.4-.1-.62-.69-.22L6.44 13.09.2 11.14c-1.36-.42-1.38-1.36.28-2.01L22.17 1.8c1.13-.42 2.12.26 1.74 1.99Z",
  },
] as const;

function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

/**
 * Close a popover on outside click or Escape. The returned ref goes on the
 * wrapper holding BOTH the trigger and the panel, so clicking the trigger again
 * toggles it instead of closing and immediately reopening.
 */
function useDismiss<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  const onClose = useRef(close);
  onClose.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose.current();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose.current(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return ref;
}

/**
 * The Alias Loop mark, inlined so it can follow the theme: the dark arm is
 * near-black in the packaged SVG and would vanish on a dark surface, so here it
 * takes currentColor (the theme's ink) and the loop arm takes the accent.
 */
function AliasLoop({ className }: { className?: string }) {
  return (
    <svg className={className ? `alias-loop ${className}` : "alias-loop"} viewBox="0 0 512 512" aria-hidden="true">
      <path d="M152 96H320C380 96 416 136 416 196V316C416 376 376 416 316 416H196C136 416 96 376 96 316V288" stroke="currentColor" />
      <path className="loop-accent" d="M96 288C96 240 136 208 184 208H280" stroke="#2457D6" />
    </svg>
  );
}

/**
 * The number an operator sees for a profile: their custom NO. when set, else the
 * store serial, else the row's position. Mirrors profileDisplayNo in launcher.ts
 * so the roster, the browser window title and the identity bookmark agree.
 */
function displayNo(profile: UiProfile, fallbackIndex: number): { value: string; custom: boolean } {
  const custom = (profile.customNo ?? "").trim();
  if (custom) return { value: custom, custom: true };
  if (profile.serial != null) return { value: String(profile.serial), custom: false };
  return { value: String(fallbackIndex + 1), custom: false };
}

/**
 * Whether this profile's last measured fingerprint still matches the one its
 * import claimed. Renders nothing when there is no attestation to check
 * against — "unknown" must not look like "verified".
 */
function FingerprintBadge({ p }: { p: UiProfile }) {
  const v = p.fpVerdict;
  if (!v) return null;
  if (v.verdict === "match") {
    return (
      <span className="fpbadge ok" title={`Fingerprint verified against the import${p.fpCapturedAt ? ` — measured ${p.fpCapturedAt}` : ""}`}>
        verified
      </span>
    );
  }
  const detail = v.differences
    .map((d) => `${d.field}: ${d.expected || "(none)"} → ${d.observed || "(none)"}`)
    .join("; ");
  return (
    <span className="fpbadge warn" title={`This browser no longer matches the imported fingerprint — ${detail}`}>
      identity changed
    </span>
  );
}

function StatusDot({ running }: { running: boolean }) {
  return <span className={`dot ${running ? "on" : ""}`} title={running ? "running" : "stopped"} />;
}

function HealthSources({ sources }: { sources: HealthSource[] }) {
  if (sources.length === 0) return <div className="health-sources none">No health nodes</div>;
  return (
    <div className="health-sources" aria-label="Automation node freshness">
      {sources.map((source) => (
        <span
          key={source.sourceId}
          className={`health-source${source.stale ? " stale" : ""}`}
          title={`Last snapshot ${new Date(source.lastSnapshotAt).toLocaleString()}`}
        >
          <Icon name="activity" className="sm" />
          {source.sourceId} · {source.stale ? "stale" : "fresh"} · {new Date(source.lastSnapshotAt).toLocaleTimeString()}
        </span>
      ))}
    </div>
  );
}

/**
 * Real brand marks for the platforms a profile can target. A letter in a colored
 * box reads as a placeholder; the actual logo is what makes a row scannable at a
 * glance. Paths are the official single-color marks on a 24x24 grid, filled (not
 * stroked) — see .brandmark in styles.css. Tile colors live in CSS as .pm-*.
 */
const PLATFORM_MARKS: Record<string, { key: string; path: string }> = {
  "x.com": {
    key: "x",
    path: "M18.9 1.153h3.682l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.153h7.594l5.243 6.932ZM17.61 20.644h2.04L6.486 3.24H4.298Z",
  },
  "telegram.org": {
    key: "telegram",
    path: "M23.91 3.79 20.3 20.84c-.25 1.21-.98 1.5-1.99.93l-5.49-4.05-2.65 2.55c-.3.3-.55.55-1.12.55l.4-5.63 10.24-9.25c.45-.4-.1-.62-.69-.22L6.44 13.09.2 11.14c-1.36-.42-1.38-1.36.28-2.01L22.17 1.8c1.13-.42 2.12.26 1.74 1.99Z",
  },
  "instagram.com": {
    key: "instagram",
    path: "M12 0C8.74 0 8.33.01 7.05.07 5.78.13 4.9.33 4.14.63a5.9 5.9 0 0 0-2.13 1.38A5.9 5.9 0 0 0 .63 4.14C.33 4.9.13 5.78.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.06 1.27.26 2.15.56 2.91a5.9 5.9 0 0 0 1.38 2.13 5.9 5.9 0 0 0 2.13 1.38c.76.3 1.64.5 2.91.56C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c1.27-.06 2.15-.26 2.91-.56a5.9 5.9 0 0 0 2.13-1.38 5.9 5.9 0 0 0 1.38-2.13c.3-.76.5-1.64.56-2.91.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95c-.06-1.27-.26-2.15-.56-2.91a5.9 5.9 0 0 0-1.38-2.13A5.9 5.9 0 0 0 19.86.63c-.76-.3-1.64-.5-2.91-.56C15.67.01 15.26 0 12 0Zm0 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23-.06-1.27-.07-1.65-.07-4.85s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16Zm0 3.68a6.16 6.16 0 1 0 0 12.32 6.16 6.16 0 0 0 0-12.32ZM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm7.85-10.4a1.44 1.44 0 1 1-2.88 0 1.44 1.44 0 0 1 2.88 0Z",
  },
  "facebook.com": {
    key: "facebook",
    path: "M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.09 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.09 24 18.1 24 12.07Z",
  },
  "tiktok.com": {
    key: "tiktok",
    path: "M12.53.02C13.84 0 15.14.01 16.44 0c.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07Z",
  },
  "linkedin.com": {
    key: "linkedin",
    path: "M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13Zm1.78 13.02H3.56V9h3.56v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0Z",
  },
  "reddit.com": {
    key: "reddit",
    path: "M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0Zm6.07 6.53a1.4 1.4 0 0 1 1.4 1.4 1.4 1.4 0 0 1-.83 1.28c.02.15.03.3.03.45 0 2.87-3.44 5.2-7.67 5.2s-7.67-2.33-7.67-5.2c0-.16.01-.31.03-.46a1.4 1.4 0 1 1 1.58-2.28 7.6 7.6 0 0 1 4.1-1.31l.78-3.66a.34.34 0 0 1 .4-.26l2.6.55a1 1 0 1 1-.14.67l-2.24-.48-.7 3.3c1.5.06 2.9.5 4.05 1.2a1.4 1.4 0 0 1 1.28-.8ZM8.1 10.42a1.16 1.16 0 1 0 0 2.32 1.16 1.16 0 0 0 0-2.32Zm7.8 0a1.16 1.16 0 1 0 0 2.32 1.16 1.16 0 0 0 0-2.32Zm-7.6 4.9a.34.34 0 0 0-.24.58c.98.98 2.53 1.46 3.94 1.46s2.96-.48 3.94-1.46a.34.34 0 0 0-.48-.48c-.78.78-2.1 1.18-3.46 1.18s-2.68-.4-3.46-1.18a.34.34 0 0 0-.24-.1Z",
  },
};

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
  if (!platform) return <span className="muted">—</span>;
  const known = KNOWN_PLATFORMS.find((candidate) => candidate.value === platform);
  const mark = PLATFORM_MARKS[platform];
  return (
    <span className="platform-pill" title={platform}>
      <span className={`glyph pm-${mark?.key ?? "other"}`}>
        {mark
          ? <svg className="brandmark" viewBox="0 0 24 24" aria-hidden="true"><path d={mark.path} /></svg>
          : platform.slice(0, 1).toUpperCase()}
      </span>
      {known?.label ?? platform}
    </span>
  );
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
        <button type="button" className="btn gp-back tip" data-tip="Pick an existing group" title="Pick an existing group" onClick={() => { setCreating(false); onChange(""); }}><Icon name="chevronLeft" /></button>
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
        <button type="button" className="btn gp-back tip" data-tip="Pick a known platform" title="Pick a known platform" onClick={() => { setCreating(false); onChange(""); }}><Icon name="chevronLeft" /></button>
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
          <button className="btn ghost" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="btn primary" type="button" disabled={busy} onClick={onConfirm}>
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
      {/* Copy sits inside the field rather than beside it: a separate bordered
          button per credential turned the dialog into a grid of grey boxes. */}
      <div className="inputwrap">
        <input value={value} onChange={(event) => onChange(event.target.value)} />
        <button
          type="button"
          className={`inline-action tip${copied ? " ok" : ""}`}
          data-tip={copied ? "Copied" : `Copy ${label.toLowerCase()}`}
          aria-label={`Copy ${label}`}
          onClick={copy}
        >
          <Icon name={copied ? "check" : "copy"} className="sm" />
        </button>
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
  | { state: "available"; currentVersion: string; version: string; highlights: string[] };
type DesktopUpdateProgress =
  | { phase: "preparing" | "verifying" | "closingBrowsers" | "installing" }
  | { phase: "downloading"; percent: number | null };
type DesktopUpdateMessage =
  | DesktopUpdateProgress
  | { phase: "ready"; version: string; highlights: string[] };
type SavedSessionPhase = "restoring" | "manual-signin" | "retryable-failure";
type RemoteMcpCredential =
  | { version: 1; state: "active"; connectorId: string; deviceId: string; token: string }
  | { version: 1; state: "disabled" };
interface RemoteMcpSettings {
  state: "idle" | "loading" | "active" | "disabled" | "error";
  connectorId?: string;
  deviceId?: string;
  url?: string;
  token?: string;
  error?: string;
}

function parseRemoteMcpCredential(value: string): RemoteMcpCredential {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (parsed.version !== 1) throw new Error("Stored Remote MCP settings are invalid.");
  if (parsed.state === "disabled") return { version: 1, state: "disabled" };
  if (
    parsed.state === "active" &&
    typeof parsed.connectorId === "string" && parsed.connectorId &&
    typeof parsed.deviceId === "string" && parsed.deviceId &&
    typeof parsed.token === "string" && parsed.token
  ) {
    return {
      version: 1,
      state: "active",
      connectorId: parsed.connectorId,
      deviceId: parsed.deviceId,
      token: parsed.token,
    };
  }
  throw new Error("Stored Remote MCP settings are invalid.");
}

async function readDesktopRemoteMcpCredential(): Promise<RemoteMcpCredential | null | undefined> {
  const invoke = desktopInvoke();
  if (!invoke) return undefined;
  const value = await invoke("credential_get", { key: "remote_mcp_connector" });
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Stored Remote MCP settings are invalid.");
  return parseRemoteMcpCredential(value);
}

async function storeDesktopRemoteMcpCredential(value: RemoteMcpCredential): Promise<void> {
  const invoke = desktopInvoke();
  if (!invoke) throw new Error("Remote MCP settings are available in the Windows app.");
  await invoke("credential_set", { key: "remote_mcp_connector", secret: JSON.stringify(value) });
}

async function deleteDesktopRemoteMcpCredential(): Promise<void> {
  const invoke = desktopInvoke();
  if (invoke) await invoke("credential_delete", { key: "remote_mcp_connector" });
}

function isUpdateHighlights(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 3 && value.every((highlight) => typeof highlight === "string");
}

function parseDesktopUpdateStatus(value: unknown): DesktopUpdateStatus {
  if (!value || typeof value !== "object") throw new Error("AliasMode returned an invalid update status.");
  const status = value as Record<string, unknown>;
  if (status.state === "upToDate" && typeof status.currentVersion === "string") {
    return { state: "upToDate", currentVersion: status.currentVersion };
  }
  if (
    status.state === "available" &&
    typeof status.currentVersion === "string" &&
    typeof status.version === "string" &&
    isUpdateHighlights(status.highlights)
  ) {
    return {
      state: "available",
      currentVersion: status.currentVersion,
      version: status.version,
      highlights: status.highlights,
    };
  }
  throw new Error("AliasMode returned an invalid update status.");
}

function parseDesktopUpdateMessage(value: unknown): DesktopUpdateMessage {
  if (!value || typeof value !== "object") throw new Error("AliasMode returned invalid update progress.");
  const progress = value as Record<string, unknown>;
  if (progress.phase === "ready" && typeof progress.version === "string" && isUpdateHighlights(progress.highlights)) {
    return { phase: "ready", version: progress.version, highlights: progress.highlights };
  }
  if (
    progress.phase === "preparing" ||
    progress.phase === "verifying" ||
    progress.phase === "closingBrowsers" ||
    progress.phase === "installing"
  ) {
    return { phase: progress.phase };
  }
  if (
    progress.phase === "downloading" &&
    (progress.percent === null ||
      (typeof progress.percent === "number" && Number.isInteger(progress.percent) && progress.percent >= 0 && progress.percent <= 100))
  ) {
    return { phase: "downloading", percent: progress.percent as number | null };
  }
  throw new Error("AliasMode returned invalid update progress.");
}

function desktopInvoke(): DesktopInvoke | undefined {
  return (window as any).__TAURI_INTERNALS__?.invoke as DesktopInvoke | undefined;
}

function UpdateHighlights({ version, highlights }: { version: string; highlights: string[] }) {
  if (highlights.length === 0) return null;
  return (
    <details className="update-highlights">
      <summary>What’s new in {version}</summary>
      <ul>{highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul>
    </details>
  );
}

function DesktopUpdateProgressView({ progress }: { progress: DesktopUpdateProgress }) {
  const percent = progress.phase === "downloading" ? progress.percent : null;
  const label = progress.phase === "preparing"
    ? "Preparing update…"
    : progress.phase === "downloading"
      ? percent === null ? "Downloading update…" : `Downloading update… ${percent}%`
      : progress.phase === "verifying"
        ? "Verifying update…"
        : progress.phase === "closingBrowsers"
          ? "Saving and closing browsers…"
          : "Installing and restarting…";
  return (
    <div className="update-progress" role="status">
      <span>{label}</span>
      <progress max={100} value={percent ?? undefined} aria-label="Update progress" />
    </div>
  );
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

const BLANK_FORM = {
  name: "", group: "", platform: "", proxyType: "http", host: "", port: "", user: "", pass: "",
  screen: "", customNo: "", username: "", password: "", email: "", emailPassword: "", twofa: "",
};

function App() {
  const [profiles, setProfiles] = useState<UiProfile[]>([]);
  const [registeredGroups, setRegisteredGroups] = useState<string[]>([]);
  const [appMode, setAppMode] = useState<AppModeConfig | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [modeErr, setModeErr] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  // "profiles" is the roster; "settings" replaces it in the same content area
  // rather than opening a dialog — Settings outgrew a modal. New profile and
  // Edit stay dialogs: short forms, and a page felt like too much ceremony.
  const [view, setView] = useState<"profiles" | "settings" | "extensions">("profiles");
  const [showCreate, setShowCreate] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("account");
  const [remoteMcp, setRemoteMcp] = useState<RemoteMcpSettings>({ state: "idle" });
  const [remoteMcpTokenVisible, setRemoteMcpTokenVisible] = useState(false);
  const [remoteMcpCopied, setRemoteMcpCopied] = useState<"url" | "token" | null>(null);
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
  const [appVersion, setAppVersion] = useState("");
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateStatus | null>(null);
  const [desktopUpdateResult, setDesktopUpdateResult] = useState<DesktopUpdateResult | null>(null);
  const [desktopUpdateResultDismissed, setDesktopUpdateResultDismissed] = useState(false);
  const [desktopUpdateChecking, setDesktopUpdateChecking] = useState(false);
  const [desktopUpdateInstalling, setDesktopUpdateInstalling] = useState(false);
  const [desktopUpdateProgress, setDesktopUpdateProgress] = useState<DesktopUpdateProgress | null>(null);
  const [desktopUpdateErr, setDesktopUpdateErr] = useState<string | null>(null);
  const [logDir, setLogDir] = useState<string | undefined>(undefined);
  const [logView, setLogView] = useState<{ file: string; content: string } | null>(null);
  const [logErr, setLogErr] = useState<string | null>(null);
  const [diag, setDiag] = useState<DiagnoseReport | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("all");
  const [profilePage, setProfilePage] = useState(0);
  const [pageSize, setPageSize] = useState(readPageSize);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "no", dir: 1 });
  const [hiddenCols, setHiddenCols] = useState<Set<ColumnKey>>(readHiddenColumns);
  const [colsOpen, setColsOpen] = useState(false);
  const [nodesOpen, setNodesOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [railForced, setRailForced] = useState(readRailForced);
  const [tableScrolled, setTableScrolled] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
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
  const [editLoading, setEditLoading] = useState(false);
  // Cloud profile open on this device: edits land in the local cache and sync
  // to Cloud with the running session — no expectedVersion handshake.
  const [editLive, setEditLive] = useState(false);
  const editFetchId = useRef<string | null>(null);
  const [editMobile, setEditMobile] = useState<NonNullable<EditProfile["desktopConversion"]> | null>(null);
  const [editTotp, setEditTotp] = useState<{ code: string; secs: number } | null>(null);
  const [twoFaFlash, setTwoFaFlash] = useState<{ id: string; code: string } | null>(null);
  const [editExts, setEditExts] = useState<string[]>([]);
  // Local extension registry + Extensions page
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [extSource, setExtSource] = useState("");
  const [extInstallBusy, setExtInstallBusy] = useState(false);
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
  // One source at a time: two full-height inputs stacked made it ambiguous which
  // one the Import button would actually read.
  const [bulkSource, setBulkSource] = useState<"file" | "paste">("file");
  const bulkFileRef = useRef<HTMLInputElement>(null);
  const authGeneration = useRef(0);
  const remoteMcpInFlight = useRef<Promise<void> | null>(null);
  const remoteMcpAccountExit = useRef(false);
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

  // The app resolves "system" itself and stamps the result on <html>, so the
  // stylesheet carries exactly one dark palette instead of a duplicated media query.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    // Only follow the OS while the operator has actually asked us to.
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia(RAIL_MEDIA);
    const apply = () => setRailForced(media.matches);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  // Escape closes whatever dialog is open, topmost first — standard desktop
  // behavior the mouse-only close buttons don't cover.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (pendingMode) { if (!modeBusy) setPendingMode(null); return; }
      if (logView || logErr) { setLogView(null); setLogErr(null); return; }
      if (showUpdate) { setShowUpdate(false); return; }
      if (showBulk) { closeBulk(); return; }
      if (editId) { closeEdit(); return; }
      if (showCreate) closeCreate();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

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
    const onProgress = new Channel<unknown>();
    onProgress.onmessage = (value) => {
      try {
        const message = parseDesktopUpdateMessage(value);
        if (message.phase === "ready") {
          setDesktopUpdate((status) => status?.state === "available"
            ? { ...status, version: message.version, highlights: message.highlights }
            : status);
        } else {
          setDesktopUpdateProgress(message);
        }
      } catch { /* Ignore malformed native progress without interrupting the update. */ }
    };
    setDesktopUpdateInstalling(true);
    setDesktopUpdateProgress({ phase: "preparing" });
    setDesktopUpdateErr(null);
    try {
      await invoke("update_now", { onProgress });
    } catch (error) {
      setDesktopUpdateErr(error instanceof Error ? error.message : String(error));
      setDesktopUpdateProgress(null);
      setDesktopUpdateInstalling(false);
    }
  };

  const provisionRemoteMcp = async (): Promise<RemoteMcpSettings> => {
    const created = await createCloudConnector();
    if (
      created.state !== "active" ||
      typeof created.connectorId !== "string" || !created.connectorId ||
      typeof created.deviceId !== "string" || !created.deviceId ||
      typeof created.url !== "string" || !created.url ||
      typeof created.token !== "string" || !created.token
    ) {
      throw new Error("AliasMode Cloud returned invalid Remote MCP settings.");
    }
    try {
      await storeDesktopRemoteMcpCredential({
        version: 1,
        state: "active",
        connectorId: created.connectorId,
        deviceId: created.deviceId,
        token: created.token,
      });
    } catch {
      await revokeCloudConnector(created.connectorId).catch(() => undefined);
      throw new Error("The Remote MCP access key could not be stored securely.");
    }
    return {
      state: "active",
      connectorId: created.connectorId,
      deviceId: created.deviceId,
      url: created.url,
      token: created.token,
    };
  };

  const runRemoteMcpTask = (work: () => Promise<void>): Promise<void> => {
    if (remoteMcpAccountExit.current) return Promise.resolve();
    if (remoteMcpInFlight.current) return remoteMcpInFlight.current;
    const task = work().finally(() => {
      if (remoteMcpInFlight.current === task) remoteMcpInFlight.current = null;
    });
    remoteMcpInFlight.current = task;
    return task;
  };

  const loadRemoteMcp = (): Promise<void> => runRemoteMcpTask(async () => {
    if (!isCloudMode || !cloudWorkspaceReady(cloudAuth)) {
      setRemoteMcp({ state: "idle" });
      return;
    }
    setRemoteMcpTokenVisible(false);
    setRemoteMcpCopied(null);
    setRemoteMcp({ state: "loading" });
    try {
      const stored = await readDesktopRemoteMcpCredential();
      if (stored === undefined) {
        throw new Error("Remote MCP settings are available in the Windows desktop app.");
      }
      if (stored?.state === "disabled") {
        setRemoteMcp({ state: "disabled" });
        return;
      }
      if (stored?.state === "active") {
        const status = await fetchCloudConnector(stored.connectorId);
        if (status.state === "active" && status.url) {
          setRemoteMcp({
            state: "active",
            connectorId: stored.connectorId,
            deviceId: stored.deviceId,
            url: status.url,
            token: stored.token,
          });
          return;
        }
      }
      setRemoteMcp(await provisionRemoteMcp());
    } catch (error) {
      setRemoteMcp({ state: "error", error: error instanceof Error ? error.message : String(error) });
    }
  });

  const enableRemoteMcp = (): Promise<void> => runRemoteMcpTask(async () => {
    setRemoteMcp({ state: "loading" });
    setRemoteMcpTokenVisible(false);
    try {
      setRemoteMcp(await provisionRemoteMcp());
    } catch (error) {
      setRemoteMcp({ state: "error", error: error instanceof Error ? error.message : String(error) });
    }
  });

  const disableRemoteMcp = async () => {
    if (remoteMcp.state !== "active" || !remoteMcp.connectorId) return;
    if (!window.confirm("Disable this Remote MCP connection? Connected clients will stop working.")) return;
    await runRemoteMcpTask(async () => {
      setRemoteMcp({ state: "loading" });
      setRemoteMcpTokenVisible(false);
      try {
        await revokeCloudConnector(remoteMcp.connectorId!);
        await storeDesktopRemoteMcpCredential({ version: 1, state: "disabled" });
        setRemoteMcp({ state: "disabled" });
      } catch (error) {
        setRemoteMcp({ state: "error", error: error instanceof Error ? error.message : String(error) });
      }
    });
  };

  const regenerateRemoteMcp = async () => {
    if (remoteMcp.state !== "active" || !remoteMcp.connectorId) return;
    if (!window.confirm("Generate a new Remote MCP access key? Existing clients will disconnect.")) return;
    await runRemoteMcpTask(async () => {
      setRemoteMcp({ state: "loading" });
      setRemoteMcpTokenVisible(false);
      try {
        await revokeCloudConnector(remoteMcp.connectorId!);
        await storeDesktopRemoteMcpCredential({ version: 1, state: "disabled" });
        setRemoteMcp(await provisionRemoteMcp());
      } catch (error) {
        setRemoteMcp({ state: "error", error: error instanceof Error ? error.message : String(error) });
      }
    });
  };

  const copyRemoteMcp = async (kind: "url" | "token", value: string) => {
    try {
      await copyPlainText(value);
      setRemoteMcpCopied(kind);
      window.setTimeout(() => setRemoteMcpCopied((current) => current === kind ? null : current), 1200);
    } catch {
      setRemoteMcp((current) => ({ ...current, error: "Remote MCP connection details could not be copied." }));
    }
  };

  const prepareRemoteMcpForAccountExit = async (bestEffort = false) => {
    remoteMcpAccountExit.current = true;
    try {
      if (remoteMcpInFlight.current) await remoteMcpInFlight.current;
      const connector = await readDesktopRemoteMcpCredential();
      if (connector?.state === "active") {
        await revokeCloudConnector(connector.connectorId);
        await storeDesktopRemoteMcpCredential({ version: 1, state: "disabled" });
        setRemoteMcp({ state: "disabled" });
        setRemoteMcpTokenVisible(false);
      }
    } catch (error) {
      if (!bestEffort) throw error;
    }
  };

  const openAccountSettings = () => {
    setModeErr(null);
    setView("settings");
    setRemoteMcpTokenVisible(false);
    void loadRemoteMcp();
    void loadCloudEvents();
    void loadTeam();
  };

  /** Leaving Settings must never keep a revealed Remote MCP key on screen. */
  const closeAccountSettings = () => {
    setRemoteMcpTokenVisible(false);
    setRemoteMcpCopied(null);
    setView("profiles");
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
      closeAccountSettings();
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
            await deleteDesktopRemoteMcpCredential().catch(() => undefined);
            setRemoteMcp({ state: "idle" });
            setRemoteMcpTokenVisible(false);
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
      await prepareRemoteMcpForAccountExit(true);
      await forgetCloudSession();
      await deleteDesktopRemoteMcpCredential().catch(() => undefined);
      setRemoteMcp({ state: "idle" });
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
      remoteMcpAccountExit.current = false;
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
        if (
          !stored?.queueKey &&
          result.queueKeyPersisted !== true &&
          (typeof result.queueKey !== "string" || !result.queueKey)
        ) {
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
      await prepareRemoteMcpForAccountExit();
      await signOutCloud();
      await deleteDesktopRemoteMcpCredential().catch(() => undefined);
      setRemoteMcp({ state: "idle" });
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
      closeAccountSettings();
    } catch (error) {
      setAuthErr(error instanceof Error ? error.message : String(error));
    } finally {
      remoteMcpAccountExit.current = false;
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
    const invoke = desktopInvoke();
    if (!invoke) return;
    let active = true;
    void invoke("last_update_result")
      .then((value) => {
        if (!active) return;
        setDesktopUpdateResult(parseDesktopUpdateResult(value));
        setDesktopUpdateResultDismissed(false);
      })
      .catch((error) => {
        if (active) setDesktopUpdateErr(error instanceof Error ? error.message : String(error));
      });
    return () => { active = false; };
  }, []);

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
    if (view !== "settings" || !isCloudMode || !workspaceReady || restartRequired) return;
    void loadRemoteMcp();
  }, [view, isCloudMode, restartRequired, workspaceReady]);

  useEffect(() => {
    if (!appMode || !workspaceReady || restartRequired) return;
    load();
    fetchHealth().then((health) => { setAppVersion(health.version); setLogDir(health.logDir); }).catch(() => {});
    // The extension registry is local to this computer in both modes; Cloud
    // profiles carry assignments and load the matching uploads at launch.
    fetchExtensions().then(setExtensions).catch(() => {});
    if (appMode.mode === "local") {
      fetchDiagnose().then(setDiag).catch(() => {});
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

  /**
   * Every profile's visible "No.", resolved once against the unsorted roster so
   * sorting or paging can never renumber a row underneath the operator.
   */
  const numbering = useMemo(() => {
    const map = new Map<string, { value: string; custom: boolean }>();
    profiles.forEach((profile, index) => map.set(profile.id, displayNo(profile, index)));
    return map;
  }, [profiles]);

  const sortField = (p: UiProfile, key: SortKey): string | number => {
    switch (key) {
      case "no": return Number(numbering.get(p.id)?.value ?? 0);
      case "name": return p.name.toLowerCase();
      case "group": return p.group.toLowerCase();
      case "platform": return p.platform.toLowerCase();
      case "proxy": return (p.proxy ?? "").toLowerCase();
      case "status": return p.running ? 0 : 1;
      default: return 0;
    }
  };

  const filtered = useMemo(() => {
    const matched = profiles.filter((p) => {
      if (group !== "all" && p.group !== group) return false;
      if (q) {
        const needle = q.toLowerCase();
        const no = numbering.get(p.id)?.value ?? "";
        if (
          !p.id.toLowerCase().includes(needle) &&
          !p.name.toLowerCase().includes(needle) &&
          !no.includes(needle)
        ) return false;
      }
      return true;
    });
    // Running profiles stay on top regardless of the chosen column: an open
    // browser is the row an operator acts on next.
    return matched.sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1;
      const left = sortField(a, sort.key);
      const right = sortField(b, sort.key);
      if (left < right) return -sort.dir;
      if (left > right) return sort.dir;
      return a.id.localeCompare(b.id);
    });
  }, [profiles, group, q, sort, numbering]);

  const profilePageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visibleProfilePage = Math.min(profilePage, profilePageCount - 1);
  const visibleProfiles = filtered.slice(visibleProfilePage * pageSize, (visibleProfilePage + 1) * pageSize);
  useEffect(() => setProfilePage(0), [q, group, pageSize]);

  const editSerial = editId ? profiles.find((profile) => profile.id === editId)?.serial ?? null : null;
  const editRunning = editId ? profiles.find((profile) => profile.id === editId)?.running === true : false;

  const pastedRecordCount = bulkText.trim() ? countPastedRecords(bulkText) : null;

  const colsRef = useDismiss<HTMLDivElement>(colsOpen, () => setColsOpen(false));
  const nodesRef = useDismiss<HTMLDivElement>(nodesOpen, () => setNodesOpen(false));
  const exportRef = useDismiss<HTMLDivElement>(exportOpen, () => setExportOpen(false));

  const columnVisible = (key: ColumnKey) => !hiddenCols.has(key);
  const toggleColumn = (key: ColumnKey) =>
    setHiddenCols((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeSetting(HIDDEN_COLUMNS_KEY, JSON.stringify([...next]));
      return next;
    });
  const applyPageSize = (size: number) => { setPageSize(size); writeSetting(PAGE_SIZE_KEY, String(size)); };
  const chooseTheme = (choice: ThemeChoice) => {
    setTheme(choice);
    writeSetting(THEME_KEY, choice);
  };
  const toggleSidebar = () =>
    setSidebarCollapsed((collapsed) => {
      writeSetting(SIDEBAR_KEY, collapsed ? "0" : "1");
      return !collapsed;
    });
  const toggleSort = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const refreshRoster = async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  };
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
      else if (r && r.warning) setActionErr(r.warning);
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
    setBulkSource("file");
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
        ...(isCloudMode ? {} : { customNo: form.customNo }),
        username: form.username,
        password: form.password,
        email: form.email,
        emailPassword: form.emailPassword,
        twofa: form.twofa,
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
  // The dialog opens on the click; the detail fetch fills it in when it lands.
  // The ref discards a stale response if the operator has moved on meanwhile.
  const openEdit = (id: string) => {
    setActionErr(null);
    editFetchId.current = id;
    setEditId(id);
    setEditForm({});
    setEditExts([]);
    setEditMobile(null);
    setEditExpectedVersion(null);
    setEditLive(false);
    setEditErr(null);
    setEditLoading(true);
    void (async () => {
      try {
        const p: EditProfile = await fetchProfileEdit(id);
        if (editFetchId.current !== id) return;
        setEditForm({
          name: p.name, group: p.group, platform: p.platform,
          proxyType: p.proxyType || "http", proxy: p.proxy,
          proxyError: p.proxyError ?? "",
          username: p.username, password: p.password,
          email: p.email, emailPassword: p.emailPassword, twofa: p.twofa,
          resolution: p.resolution, tags: p.tags,
          customNo: p.customNo ?? "",
        });
        setEditExts(p.extensions ?? []);
        setEditMobile(p.desktopConversion ?? null);
        setEditExpectedVersion(p.expectedVersion ?? null);
        setEditLive(p.liveEdit === true);
      } catch (e) {
        if (editFetchId.current === id) setEditErr(String(e));
      } finally {
        if (editFetchId.current === id) setEditLoading(false);
      }
    })();
  };
  const closeEdit = () => {
    editFetchId.current = null;
    setEditId(null);
    setEditExpectedVersion(null);
    setEditLive(false);
    setEditLoading(false);
    setEditForm({});
    setEditErr(null);
    setEditMobile(null);
  };
  const saveEdit = async () => {
    if (!editId) return;
    setEditSaving(true);
    setEditErr(null);
    try {
      if (isCloudMode && !editLive && editExpectedVersion === null) throw new Error("Cloud profile version is missing; close and reopen Edit");
      const r = await updateProfile(editId, {
        name: editForm.name ?? "", group: editForm.group ?? "", platform: editForm.platform ?? "",
        proxy: editForm.proxy ?? "", proxyType: editForm.proxyType ?? "http",
        username: editForm.username ?? "", password: editForm.password ?? "",
        email: editForm.email ?? "", emailPassword: editForm.emailPassword ?? "", twofa: editForm.twofa ?? "",
        resolution: editForm.resolution ?? "", tags: editForm.tags ?? "",
        ...(!isCloudMode ? { extensions: editExts, customNo: editForm.customNo ?? "" } : {}),
      }, isCloudMode && !editLive ? editExpectedVersion ?? undefined : undefined);
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

  // ---- Extensions manager (Store URL / upload / delete) ----
  const reloadExtensions = async () => { try { setExtensions(await fetchExtensions()); } catch {} };
  const doInstallWebStoreExtension = async () => {
    const source = extSource.trim();
    if (!source) { setExtErr("Paste a Chrome Web Store URL or extension ID"); return; }
    setExtInstallBusy(true);
    setExtErr(null);
    try {
      const r = await installWebStoreExtension(source);
      if (!r.ok) { setExtErr(r.error || "installation failed"); return; }
      setExtSource("");
      await reloadExtensions();
      flash(r.alreadyInstalled ? `${r.installed.name} is already installed` : `Installed ${r.installed.name}`);
    } catch (e) {
      setExtErr(String(e));
    } finally {
      setExtInstallBusy(false);
    }
  };
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
    const issues: string[] = [];
    await runPool(ids, 4, async (id) => {
      try {
        const r = await op(id);
        if (r?.ok === false) issues.push(`${id}: ${r.error || "action failed"}`);
        else if (r?.warning) issues.push(`${id}: ${r.warning}`);
      } catch (error) {
        issues.push(`${id}: ${String(error)}`);
      }
    });
    await load();
    setBusy((b) => { const n = { ...b }; ids.forEach((id) => delete n[id]); return n; });
    if (issues.length > 0) setActionErr(issues.join("; "));
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

  const desktopUpdateResultSummary = desktopUpdateResult
    ? describeDesktopUpdateResult(desktopUpdateResult)
    : null;

  if (!appMode || !workspaceReady || restartRequired) {
    return (
      <>
        <main className="onboarding">
        <section className="onboarding-card" aria-labelledby="onboarding-title">
          <div className="onboarding-brand"><AliasLoop />AliasMode <span>by Xreacher</span></div>
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
                  <span className="badge"><Icon name="cloud" className="lg" /></span>
                  <strong>AliasMode Cloud</strong>
                  <span>Sync profiles across authorized devices and work with your team.</span>
                </button>
                <button className="mode-option" type="button" disabled={modeBusy} onClick={() => chooseMode("local")}>
                  <span className="badge"><Icon name="laptop" className="lg" /></span>
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
  const shownColumns = COLUMNS.filter((column) => columnVisible(column.key));
  const visibleColumnCount = 1 + shownColumns.length;
  // Sum of what is actually on screen: below this the wrapper scrolls rather
  // than letting the browser crush Name down to "mia.h…".
  const tableMinWidth = CHECKBOX_COLUMN_WIDTH + shownColumns.reduce((total, column) => total + column.width, 0);
  const columnHead = (column: (typeof COLUMNS)[number]) => {
    // The Action column carries no header text: its buttons explain themselves,
    // and a floating "ACTION" label over a right-aligned cluster read as an
    // empty column. The column chooser still lists it by its registry label.
    const label = column.key === "action" ? "" : column.key === "group" && isCloudMode ? "Folder" : column.label;
    // Every column declares its width, so a wide window's extra space spreads
    // proportionally across all of them — an even layout, no dead gap.
    const style = { width: column.width } as CSSProperties;
    if (!column.sort) return <th key={column.key} className={`col-${column.key}`} style={style}>{label}</th>;
    const key = column.key as SortKey;
    return (
      <th
        key={column.key}
        className={`col-${column.key} sortable${sort.key === key ? " sorted" : ""}`}
        style={style}
        aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
        onClick={() => toggleSort(key)}
      >
        <span className="th-inner">
          {label}
          <Icon className="sortglyph sm" name={sort.key === key ? (sort.dir === 1 ? "sortUp" : "sortDown") : "sort"} />
        </span>
      </th>
    );
  };

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
      {!isCloudMode && dragging && (
        <div className="dropzone">
          <Icon name="fileImport" />
          <span>Drop AdsPower <code>.txt</code> or <code>.csv</code> files to import</span>
        </div>
      )}

      <aside className={`sidebar${sidebarCollapsed || railForced ? " collapsed" : ""}`}>
        {/* A too-narrow window forces the rail; the toggle would be a no-op. */}
        {!railForced && (
          <button
            type="button"
            className="rail-toggle tip"
            data-tip={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!sidebarCollapsed}
            onClick={toggleSidebar}
          >
            <Icon name={sidebarCollapsed ? "chevronRight" : "chevronLeft"} className="sm" />
          </button>
        )}
        <div className="brandrow">
          <div className="brand"><AliasLoop />AliasMode</div>
          {appVersion && <span className="appversion" title={appVersion}>{appVersion}</span>}
        </div>
        <div className="newrow">
          <button className="btn primary newbtn" data-tip="New profile" title="New profile" disabled={!canEditCloud} onClick={openCreate}>
            <Icon name="plus" /><span className="navlabel">New Profile</span>
          </button>
          <button
            className="btn importbtn tip"
            data-tip="Import from file"
            disabled={!canEditCloud}
            title="Import / bulk-add accounts from CSV or AdsPower .txt"
            onClick={openBulk}
          ><Icon name="fileImport" /></button>
        </div>

        <nav className="sidenav" aria-label="Sections">
          <button
            type="button"
            className={`navitem${view === "profiles" && group === "all" ? " active" : ""}`}
            data-tip="All profiles"
            title="All profiles"
            onClick={() => { setView("profiles"); setGroup("all"); }}
          >
            <Icon name="profiles" /><span className="navlabel">All profiles</span>
            <span className="cnt">{profiles.length}</span>
          </button>
          <button
            type="button"
            className={`navitem${view === "extensions" ? " active" : ""}`}
            data-tip="Manage extensions"
            title="Manage extensions"
            onClick={() => { setExtErr(null); setView("extensions"); }}
          >
            <Icon name="puzzle" /><span className="navlabel">Manage extensions</span>
            {extensions.length > 0 && <span className="cnt">{extensions.length}</span>}
          </button>
          <button
            type="button"
            className="navitem"
            title="View detailed logs"
            onClick={() => {
              setLogErr(null);
              setLogView(null);
              fetchLogs().then(setLogView).catch((e) => setLogErr(e instanceof Error ? e.message : String(e)));
            }}
          ><Icon name="logs" /><span className="navlabel">Logs</span></button>
        </nav>

        <div className="sidesection">
          <button className="sidehead" onClick={() => setGroupsOpen((o) => !o)}>
            <span className={`chev${groupsOpen ? " open" : ""}`}><Icon name="chevronRight" className="sm" /></span>
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
                className={`folder${view === "profiles" && group === g ? " active" : ""}`}
                onClick={() => { if (renaming !== g) { setView("profiles"); setGroup(g); } }}
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
                    <Icon name="folder" className="sm" />
                    <span className="fname" title={g}>{g}</span>
                    {(canEditGroup(g) || (isCloudMode && canManageCloudFolders)) && (
                      <span className="gactions">
                        {canEditGroup(g) && (
                          <button title={isCloudMode ? "Rename folder" : "Rename group"} onClick={(e) => { e.stopPropagation(); startRename(g); }}>
                            <Icon name="edit" className="sm" />
                          </button>
                        )}
                        {(!isCloudMode || canManageCloudFolders) && (
                          <button className="danger" title={isCloudMode ? "Delete folder" : "Delete group"} onClick={(e) => { e.stopPropagation(); removeGroup(g); }}>
                            <Icon name="trash" className="sm" />
                          </button>
                        )}
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
                <button type="button" title="Create" onClick={() => void createSidebarGroup()}><Icon name="check" className="sm" /></button>
                <button type="button" title="Cancel" onClick={() => { setAddingGroup(false); setSidebarGroupName(""); }}><Icon name="close" className="sm" /></button>
              </div>
            ) : (
              <button className="newgroup" type="button" disabled={!canEditCloud} onClick={() => setAddingGroup(true)}>
                <Icon name="plus" className="sm" />{isCloudMode ? "New folder" : "New group"}
              </button>
            )}
          </>}
        </div>

        <div className="sidefoot">
          <a
            className="navitem"
            href="https://t.me/aliasmode"
            target="_blank"
            rel="noreferrer"
            data-tip="Support"
            title="Support — AliasMode Telegram group"
          >
            <Icon name="help" /><span className="navlabel">Support</span>
          </a>
          <button type="button" className={`navitem${view === "settings" ? " active" : ""}`} data-tip="Settings" title="Settings" onClick={openAccountSettings}>
            <Icon name="settings" /><span className="navlabel">Settings</span>
          </button>
          <div className="sidecredit">
            {/* Only the name is a link, and it points at its owner: "Developed by
                Xreacher" goes to Xreacher, not to AliasMode. The project's own
                links are the GitHub and Telegram marks beside it. */}
            <span className="watermark">
              Developed by
              <a href="https://xreacher.com/" target="_blank" rel="noreferrer" title="xreacher.com">Xreacher</a>
            </span>
            <div className="projectlinks">
              {PROJECT_LINKS.map((link) => (
                <a
                  key={link.label}
                  className="projectlink tip"
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  data-tip={link.label}
                  aria-label={`AliasMode on ${link.label}`}
                >
                  <svg className="brandmark" viewBox="0 0 24 24" aria-hidden="true"><path d={link.path} /></svg>
                </a>
              ))}
            </div>
            <p className="footer-mark" aria-hidden="true">AliasMode</p>
          </div>
        </div>
        {modeErr && <div className="mode-error" role="alert">{modeErr}</div>}
      </aside>

      <div className="main">
      <header className="pagehead">
        <h1>{PAGE_TITLES[view]}</h1>
        {view === "profiles" && (
          <span className="pagesub">
            {filtered.length === profiles.length ? `${profiles.length} total` : `${filtered.length} of ${profiles.length}`}
          </span>
        )}
        <span className="spacer" />
        <div className="headactions">
          {view === "profiles" && <>
          {/* Health snapshots are pushed by automation workers through the hub, so
              in Local mode this list is always empty (see ui.ts: the local roster
              returns healthSources: []). Show the control only when something
              actually reports, instead of a button that can only say "none". */}
          {healthSources.length > 0 && (
          <div className="menuwrap" ref={nodesRef}>
            <button
              type="button"
              className={`iconbtn tip${nodesOpen ? " on" : ""}`}
              data-tip="Automation nodes"
              aria-label="Automation node freshness"
              onClick={() => setNodesOpen((o) => !o)}
            ><Icon name="activity" /></button>
            {nodesOpen && (
              <div className="popover below-right">
                <div className="pop-head">Automation nodes</div>
                <HealthSources sources={healthSources} />
              </div>
            )}
          </div>
          )}
          <button
            type="button"
            className="iconbtn tip"
            data-tip="Refresh"
            aria-label="Refresh profiles"
            disabled={refreshing}
            onClick={() => void refreshRoster()}
          ><Icon name="refresh" /></button>
          <div className="menuwrap" ref={colsRef}>
            <button
              type="button"
              className={`iconbtn tip${colsOpen ? " on" : ""}`}
              data-tip="Columns"
              aria-label="Choose visible columns"
              onClick={() => setColsOpen((o) => !o)}
            ><Icon name="columns" /></button>
            {colsOpen && (
              <div className="popover below-right">
                <div className="pop-head">Visible columns</div>
                {COLUMNS.map((column) => (
                  <label className="pop-item" key={column.key}>
                    <input type="checkbox" checked={columnVisible(column.key)} onChange={() => toggleColumn(column.key)} />
                    {column.label}
                  </label>
                ))}
              </div>
            )}
          </div>
          </>}
          <button
            className="account-button"
            type="button"
            aria-label="Open Account and Settings"
            title="Account & Settings"
            onClick={openAccountSettings}
          >
            <span className="avatar"><Icon name="user" /></span>
            <span className="who">
              <b>{isCloudMode ? cloudAuth?.user?.email ?? "Cloud account" : "Local workspace"}</b>
              <span>{isCloudMode ? cloudAuth?.workspace?.role ?? "member" : "No account"}</span>
            </span>
            <Icon name="chevronRight" className="sm" />
          </button>
        </div>
      </header>

      {(actionErr ?? connErr) && (
        <div className="error">
          <Icon name="alert" />
          <span>{actionErr ?? connErr}</span>
          <button className="dismiss" aria-label="Dismiss error" onClick={() => { setActionErr(null); setConnErr(null); }}>
            <Icon name="close" className="sm" />
          </button>
        </div>
      )}
      {notice && (
        <div className="notice" role="status" onClick={() => setNotice(null)}>
          <Icon name="check" className="sm" />{notice}
        </div>
      )}
      {desktopUpdateResultSummary && !desktopUpdateResultDismissed && (
        <div
          className={`update-banner update-result ${desktopUpdateResultSummary.tone}`}
          role={desktopUpdateResultSummary.tone === "success" ? "status" : "alert"}
        >
          <Icon name={desktopUpdateResultSummary.tone === "success" ? "check" : desktopUpdateResultSummary.tone === "warning" ? "warning" : "alert"} />
          <div className="update-copy">
            <strong>{desktopUpdateResultSummary.title}</strong>
            <span>{desktopUpdateResultSummary.detail}</span>
          </div>
          <button
            className="update-result-dismiss"
            type="button"
            aria-label="Dismiss last update result"
            onClick={() => setDesktopUpdateResultDismissed(true)}
          >
            <Icon name="close" className="sm" />
          </button>
        </div>
      )}
      {desktopUpdate?.state === "available" && (
        <div className="update-banner">
          <Icon name="import" />
          <div className="update-copy">
            <span role="status"><strong>AliasMode {desktopUpdate.version} is available.</strong> The update will save active browsers and restart the app.</span>
            <UpdateHighlights version={desktopUpdate.version} highlights={desktopUpdate.highlights} />
            {desktopUpdateProgress && <DesktopUpdateProgressView progress={desktopUpdateProgress} />}
            {desktopUpdateErr && <span className="modal-err" role="alert">{desktopUpdateErr}</span>}
          </div>
          <button className="btn primary" type="button" disabled={desktopUpdateChecking || desktopUpdateInstalling} onClick={() => void installDesktopUpdate()}>
            {desktopUpdateInstalling ? "Updating…" : "Update now"}
          </button>
        </div>
      )}

      {view === "profiles" ? (
      <div className="workspace">
        <div className="filterbar">
          <select
            className="select group-filter"
            aria-label={isCloudMode ? "Folder filter" : "Group filter"}
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          >
            <option value="all">All {isCloudMode ? "folders" : "groups"}</option>
            {existingGroups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <div className="searchfield">
            <Icon name="search" className="sm" />
            <input
              className="input search"
              placeholder="Search by No., id or name…"
              aria-label="Search profiles"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {q && <button type="button" className="clear" aria-label="Clear search" onClick={() => setQ("")}><Icon name="close" className="sm" /></button>}
          </div>
        </div>

        {/* Bulk actions only exist once there is a selection to act on — an
            always-present strip of disabled buttons read as clutter. */}
        {selected.size > 0 && (
        <div className="toolbar active">
          <span className="selcount">
            <Icon name="check" className="sm" />
            {selected.size} selected
          </span>
          <button className="btn primary tip" data-tip="Open selected browsers" disabled={!selected.size} onClick={openSelected}>
            <Icon name="play" className="sm" />Open
          </button>
          <button className="btn solid-danger tip" data-tip="Close selected browsers" disabled={!selected.size} onClick={closeSelected}>
            <Icon name="power" className="sm" />Close
          </button>
          {(!isCloudMode || selectedEditable) && <>
          <span className="vsep" />
          {!isCloudMode && selectedMobileCount > 0 && (
            <button className="btn warn" onClick={convertSelectedMobile}>
              <Icon name="laptop" className="sm" />Convert mobile ({selectedMobileCount})
            </button>
          )}
          {/* Export works in Cloud mode too (the server decrypts the selected
              profiles); Convert and Edit-from-file remain Local-only. */}
          <div className="menuwrap" ref={exportRef}>
            <button className="btn tip" data-tip="Export selected profiles" disabled={!selected.size} onClick={() => setExportOpen((o) => !o)}>
              <Icon name="export" className="sm" />Export<Icon name="chevronDown" className="sm" />
            </button>
            {exportOpen && selected.size > 0 && (
              <div className="exportmenu popover below-left" onMouseLeave={() => setExportOpen(false)}>
                <button className="pop-item" onClick={() => exportSelected("csv")}><Icon name="file" className="sm" />Export as CSV (credentials)</button>
                <button className="pop-item" onClick={() => exportSelected("txt")}><Icon name="file" className="sm" />Export as .txt (full profile)</button>
                <button className="pop-item" onClick={() => exportSelected("xlsx")}><Icon name="file" className="sm" />Export as Excel (full profile)</button>
              </div>
            )}
          </div>
          {!isCloudMode && (
            <button className="btn tip" data-tip="Export → edit → re-upload" disabled={!selected.size} onClick={openUpdate} title="Export → edit → re-upload to change credentials in bulk">
              <Icon name="edit" className="sm" />Edit from file
            </button>
          )}
          <span className="vsep" />
          <div className="movewrap">
            {newMode ? (
              <input className="input" autoFocus placeholder="new group name" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
            ) : (
              <select
                className="select move-group"
                aria-label="Move to group"
                title={moveTarget || "Choose group"}
                disabled={!selected.size}
                value={moveTarget}
                onChange={(e) => (e.target.value === "__new__" ? setNewMode(true) : setMoveTarget(e.target.value))}
              >
                <option value="">Move to…</option>
                {editableGroups.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
                <option value="__new__">+ new group…</option>
              </select>
            )}
            {newMode && (
              <button className="btn ghost" onClick={() => { setNewMode(false); setNewGroup(""); }}>cancel</button>
            )}
            <button className="btn accent" disabled={!selected.size || (newMode ? !newGroup.trim() : !moveTarget)} onClick={moveSelected}>
              <Icon name="move" className="sm" />Move
            </button>
          </div>
          {!isCloudMode && extensions.length > 0 && (
            <>
              <span className="vsep" />
              <div className="extctl">
                <span className="extctl-lbl"><Icon name="puzzle" className="sm" />Extension</span>
                <select className="select extctl-sel" aria-label="Extension for bulk assignment" disabled={!selected.size} value={bulkExt} onChange={(e) => setBulkExt(e.target.value)}>
                  <option value="">choose…</option>
                  {extensions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <button className="btn xs" disabled={!selected.size || !bulkExt} onClick={() => bulkAssignExt("add")}>Add</button>
                <button className="btn xs" disabled={!selected.size || !bulkExt} onClick={() => bulkAssignExt("remove")}>Remove</button>
              </div>
            </>
          )}
          <span className="spacer" />
          {(!isCloudMode || selectedEditable) && (
            <button className="btn danger tip" data-tip="Delete selected profiles" disabled={!selected.size} onClick={deleteSelected}>
              <Icon name="trash" className="sm" />Delete
            </button>
          )}
          </>}
        </div>
        )}

        <div
          className={`tablewrap${tableScrolled ? " scrolled" : ""}`}
          onScroll={(event) => setTableScrolled(event.currentTarget.scrollLeft > 0)}
        >
          <table className="profile-table" style={{ minWidth: tableMinWidth }}>
            <thead>
              <tr>
                <th className="chk" style={{ width: CHECKBOX_COLUMN_WIDTH }}>
                  <input type="checkbox" aria-label="Select all visible profiles" checked={allVisibleSelected} onChange={toggleAll} />
                </th>
                {shownColumns.map(columnHead)}
              </tr>
            </thead>
            <tbody>
              {visibleProfiles.map((p) => {
                // The numbering memo covers every roster profile, so this
                // lookup cannot miss; a silent fallback here would renumber
                // rows wrongly if that invariant ever broke.
                const no = numbering.get(p.id)!;
                // Running rows are editable too: an open Cloud profile is edited
                // live through the local cache. Only rows locked by ANOTHER
                // session stay read-only — that writer owns the profile.
                const canEditRow = !isCloudMode || (p.permission === "edit" && !p.lockedBy);
                return (
                <tr key={p.id} className={`${p.running ? "running" : ""}${selected.has(p.id) ? " selected" : ""}`}>
                  <td className="chk">
                    <input type="checkbox" aria-label={`Select ${p.name}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                  </td>
                  {columnVisible("no") && (
                    <td className="col-no">
                      <span className={`no-text${no.custom ? " custom" : ""}`} title={`${no.custom ? "Custom NO." : "Serial"} ${no.value}`}>{no.value}</span>
                    </td>
                  )}
                  {columnVisible("name") && (
                    <td className="col-name" title={`${p.name}\n${p.id}`}>
                      <span className="name-cell">
                        <span className="n">{p.name}<FingerprintBadge p={p} /></span>
                        <span className="sub">
                          {p.id}
                          {p.running && <span className="live"><StatusDot running />running</span>}
                          {p.lockedBy && (
                            <span className="lockedby" title={`in use by ${p.lockedBy}`}>
                              <Icon name="lock" className="sm" />{p.lockedBy}
                            </span>
                          )}
                        </span>
                      </span>
                    </td>
                  )}
                  {columnVisible("group") && (
                    <td className="col-group" title={p.group}>
                      {p.group ? <span className="chip">{p.group}</span> : <span className="muted">—</span>}
                    </td>
                  )}
                  {columnVisible("platform") && <td className="col-platform"><PlatformPill platform={p.platform} /></td>}
                  {columnVisible("tags") && (
                    <td className="col-tags" title={p.tags?.length ? p.tags.join(", ") : "No tags"}>
                      {p.tags?.length ? p.tags.map((t) => <span key={t} className="chip">{t}</span>) : <span className="muted">—</span>}
                    </td>
                  )}
                  {columnVisible("proxy") && (
                    <td className="col-proxy" title={p.proxyError || p.proxy || "no proxy"}>
                      {p.proxyError
                        ? <span className="proxy-cell bad"><Icon name="warning" className="sm" />invalid — edit</span>
                        : p.proxy
                          ? <span className="proxy-cell">{p.proxy}</span>
                          : <span className="muted">—</span>}
                    </td>
                  )}
                  {columnVisible("action") && (
                    <td className="col-action">
                      <span className="rowactions">
                        {!isCloudMode && p.has2fa && (
                          <button
                            className={`iconbtn twofa tip${twoFaFlash?.id === p.id ? " flash" : ""}`}
                            data-tip={twoFaFlash?.id === p.id ? `Copied ${twoFaFlash.code}` : "Copy current 2FA code"}
                            aria-label="Copy current 2FA code"
                            onClick={() => copy2fa(p.id)}
                          >
                            <Icon name={twoFaFlash?.id === p.id ? "check" : "key"} className="sm" />
                          </button>
                        )}
                        {canEditRow && (
                          <button className="iconbtn tip" data-tip="Edit profile" aria-label={`Edit ${p.name}`} onClick={() => openEdit(p.id)}>
                            <Icon name="edit" className="sm" />
                          </button>
                        )}
                        {p.running ? (
                          <>
                            <button
                              className="iconbtn tip"
                              data-tip="Bring to front"
                              aria-label="Bring this browser window to the front"
                              disabled={busy[p.id]}
                              onClick={() => act(p.id, raiseProfile)}
                            ><Icon name="raise" className="sm" /></button>
                            <button className="btn sm solid-danger" aria-label={`Close ${p.name}`} disabled={busy[p.id]} onClick={() => act(p.id, closeProfile)}>
                              <Icon name="power" className="sm" />Close
                            </button>
                          </>
                        ) : p.mobilePersona ? (
                          !p.lockedBy && (!isCloudMode || p.permission === "edit") ? (
                            <button className="btn sm warn" disabled={busy[p.id]} title="Convert this mobile persona to a desktop device" onClick={() => openEdit(p.id)}>
                              <Icon name="laptop" className="sm" />Convert
                            </button>
                          ) : null
                        ) : (
                          <button
                            className="btn sm primary"
                            aria-label={`Open ${p.name}`}
                            title={p.lockedBy ? `Open — session writer: ${p.lockedBy}; this browser will not save its session back` : undefined}
                            disabled={busy[p.id]}
                            onClick={() => act(p.id, openProfile)}
                          >
                            <Icon name="play" className="sm" />Open
                          </button>
                        )}
                      </span>
                    </td>
                  )}
                </tr>
                );
              })}
              {loaded && filtered.length === 0 && (
                <tr>
                  <td colSpan={visibleColumnCount} className="empty">
                    <div className="emptystate">
                      <span className="glyph"><Icon name="profiles" /></span>
                      {profiles.length === 0 ? (
                        <>
                          <b>No profiles yet</b>
                          <p>
                            {isCloudMode
                              ? "No Cloud profiles yet — click New Profile to create one."
                              : "No profiles yet — click New Profile, or drop an AdsPower .txt / .csv export anywhere in this window to import it."}
                          </p>
                          <button className="btn primary" disabled={!canEditCloud} onClick={openCreate}><Icon name="plus" className="sm" />New Profile</button>
                        </>
                      ) : (
                        <>
                          <b>No matches</b>
                          <p>No profiles match the current filters.</p>
                          <button className="btn" onClick={() => { setQ(""); setGroup("all"); }}>Clear filters</button>
                        </>
                      )}
                    </div>
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
          <span className="stat"><b>{profiles.length}</b> profiles</span>
          <span className="stat"><StatusDot running={runningCount > 0} /><b>{runningCount}</b> running</span>
          {diag && (
            <span className="diag" onClick={() => setShowDiag((s) => !s)}>
              Diagnose · last {diagWhen}
              <Icon name={showDiag ? "chevronDown" : "chevronRight"} className="sm" />
            </span>
          )}
          <span className="pager">
            <button
              type="button"
              className="iconbtn"
              aria-label="Previous page"
              disabled={visibleProfilePage === 0}
              onClick={() => setProfilePage(visibleProfilePage - 1)}
            ><Icon name="chevronLeft" className="sm" /></button>
            <span className="page-of">Page <b>{visibleProfilePage + 1}</b> / {profilePageCount}</span>
            <button
              type="button"
              className="iconbtn"
              aria-label="Next page"
              disabled={visibleProfilePage + 1 >= profilePageCount}
              onClick={() => setProfilePage(visibleProfilePage + 1)}
            ><Icon name="chevronRight" className="sm" /></button>
            <select className="select" aria-label="Rows per page" value={pageSize} onChange={(e) => applyPageSize(Number(e.target.value))}>
              {PAGE_SIZES.map((size) => <option key={size} value={size}>{size} / page</option>)}
            </select>
          </span>
        </footer>
      </div>
      ) : view === "extensions" ? (
      <div className="workspace">
        <div className="settingspage">
          <h2 className="sect-title">Extensions</h2>
          {extErr && <div className="modal-err"><Icon name="alert" className="sm" />{extErr}</div>}
          <section className="settings-card">
            <header><Icon name="puzzle" className="sm" /><h2>Install from Chrome Web Store</h2></header>
            <div className="card-body">
              <p>Paste a Chrome Web Store extension link or its 32-character ID.</p>
              <form className="fld-row" onSubmit={(event) => { event.preventDefault(); void doInstallWebStoreExtension(); }}>
                <input
                  className="input"
                  style={{ flex: 1 }}
                  aria-label="Chrome Web Store URL or extension ID"
                  placeholder="https://chromewebstore.google.com/detail/…"
                  value={extSource}
                  onChange={(event) => setExtSource(event.target.value)}
                />
                <button className="btn primary" type="submit" disabled={extInstallBusy || extBusy}>
                  <Icon name="plus" className="sm" />{extInstallBusy ? "Installing…" : "Install"}
                </button>
              </form>
            </div>
          </section>
          <p className="formnote">The in-browser Store button does not work in CloakBrowser. Paste the Store link above, or upload a ZIP/CRX archive.</p>
          <ol className="steps">
            <li>Install the extension here.</li>
            <li>Use <b>Edit &gt; Extensions</b> to assign it to a profile{!isCloudMode && ", or assign many at once from the roster toolbar"}.</li>
            <li>Reopen the profile. AliasMode loads the extension when the browser starts.</li>
          </ol>
          {extensions.length === 0 ? (
            <div className="emptystate">
              <span className="glyph"><Icon name="puzzle" /></span>
              <b>No extensions yet</b>
              <p>Uploaded extensions appear here, ready to assign to any profile.</p>
              <button className="btn primary" disabled={extBusy || extInstallBusy} onClick={() => extFileRef.current?.click()}>
                <Icon name="plus" className="sm" />{extBusy ? "Uploading…" : "Upload ZIP/CRX"}
              </button>
            </div>
          ) : (
            <div className="extlist">
              {extensions.map((x) => (
                <div key={x.id} className="extrow">
                  <Icon name="puzzle" className="sm" />
                  <span className="extname">{x.name}</span>
                  <span className="spacer" />
                  <button className="btn xs danger" onClick={() => doRemoveExtension(x.id, x.name)}>Remove</button>
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
        <footer className="pagefoot">
          <span className="spacer" />
          {extensions.length > 0 && (
            <button className="btn primary" type="button" disabled={extBusy || extInstallBusy} onClick={() => extFileRef.current?.click()}>
              <Icon name="plus" className="sm" />{extBusy ? "Uploading…" : "Upload ZIP/CRX"}
            </button>
          )}
        </footer>
      </div>
      ) : view === "settings" ? (
      <div className="workspace">
        <div className="tabs" role="tablist" aria-label="Settings sections">
          {SETTINGS_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={settingsTab === tab.key}
              className={`tab${settingsTab === tab.key ? " active" : ""}`}
              onClick={() => setSettingsTab(tab.key)}
            >
              {tab.key === "team" && isCloudMode ? "Team" : tab.label}
            </button>
          ))}
        </div>
        <div className="settingspage">
          {settingsTab === "account" && (
            <>
              <h2 className="sect-title">Account information</h2>
              <div className="identity-card">
                <span className="identity-avatar"><Icon name="user" className="lg" /></span>
                <span className="identity-lines">
                  <b>{isCloudMode ? cloudAuth?.user?.email ?? "Cloud account" : "Local workspace"}</b>
                  <span>
                    {isCloudMode
                      ? `${cloudAuth?.workspace?.role ?? "member"} · ${cloudAuth?.workspace?.name ?? "Cloud workspace"}`
                      : "No account · profile data stays on this computer"}
                  </span>
                </span>
                <span className="chip">{isCloudMode ? "Cloud" : "Local"}</span>
              </div>
<section className="settings-card">
            <header><Icon name="user" className="sm" /><h2>Account</h2></header>
            <div className="card-body">
            <div className="settings-row"><span>Signed in as</span><strong>{isCloudMode ? cloudAuth?.user?.email ?? "Cloud account" : "Local · no account"}</strong></div>
            <div className="settings-row"><span>Profiles stored</span><strong>{profiles.length}</strong></div>
            {isCloudMode && cloudAuth?.authenticated && (
              <button className="btn danger" type="button" disabled={authBusy} onClick={() => void signOut()}>
                <Icon name="power" className="sm" />{authBusy ? "Signing out…" : "Sign out / Switch account"}
              </button>
            )}
            {authErr && <p className="modal-err" role="alert">{authErr}</p>}
            </div>
          </section>

          {isCloudMode && cloudAuth?.authenticated && (
            <section className="settings-card remote-mcp-settings">
              <header>
                <Icon name="cloud" className="sm" /><h2>Remote MCP</h2>
                <span className={`remote-mcp-status ${remoteMcp.state}`}>
                  {remoteMcp.state === "active" ? "Ready" : remoteMcp.state === "disabled" ? "Disabled" : remoteMcp.state === "loading" ? "Preparing" : remoteMcp.state === "error" ? "Unavailable" : "Not ready"}
                </span>
              </header>
              <div className="card-body">
                <p>Connect an AI client on another computer. Browser windows open on this Windows PC, so keep AliasMode running.</p>
                {remoteMcp.state === "loading" && <p className="hint" role="status">Preparing your secure connection…</p>}
                {remoteMcp.state === "active" && remoteMcp.url && remoteMcp.token && (
                  <>
                    <label className="fld remote-mcp-field">
                      <span>MCP server URL</span>
                      <span className="remote-mcp-value">
                        <input className="mono" value={remoteMcp.url} readOnly />
                        <button className="btn" type="button" disabled={authBusy} onClick={() => void copyRemoteMcp("url", remoteMcp.url!)}>{remoteMcpCopied === "url" ? "Copied" : "Copy"}</button>
                      </span>
                    </label>
                    <label className="fld remote-mcp-field">
                      <span>Access key</span>
                      <span className="remote-mcp-value">
                        <input className="mono" value={remoteMcpTokenVisible ? remoteMcp.token : "••••••••••••••••••••••••"} readOnly aria-label="Remote MCP access key" />
                        <button className="btn" type="button" disabled={authBusy} onClick={() => setRemoteMcpTokenVisible((visible) => !visible)}>{remoteMcpTokenVisible ? "Hide" : "Reveal"}</button>
                        <button className="btn" type="button" disabled={authBusy} onClick={() => void copyRemoteMcp("token", remoteMcp.token!)}>{remoteMcpCopied === "token" ? "Copied" : "Copy"}</button>
                      </span>
                    </label>
                    <div className="hint remote-mcp-guide">
                      <strong>Connect Claude.ai or ChatGPT</strong>
                      <ol>
                        <li>Add a custom MCP connector or app.</li>
                        <li>Paste the MCP server URL and select Connect.</li>
                        <li>Sign into AliasMode and select Allow.</li>
                      </ol>
                      <details>
                        <summary>Claude Code and other clients</summary>
                        <p>Claude Code uses an HTTP entry in <code>.mcp.json</code>. Keep the access key in an environment variable. Other bearer-capable MCP clients can use the same URL and secret header.</p>
                        <p>Claude.ai and ChatGPT use OAuth and do not need the access key.</p>
                      </details>
                    </div>
                    <div className="update-actions">
                      <button className="btn" type="button" disabled={authBusy} onClick={() => void regenerateRemoteMcp()}>Regenerate key</button>
                      <button className="btn danger" type="button" disabled={authBusy} onClick={() => void disableRemoteMcp()}>Disable</button>
                    </div>
                  </>
                )}
                {remoteMcp.state === "disabled" && (
                  <>
                    <p>Remote connections are disabled for this Windows device.</p>
                    <button className="btn" type="button" disabled={authBusy} onClick={() => void enableRemoteMcp()}>Enable Remote MCP</button>
                  </>
                )}
                {remoteMcp.error && <div className="modal-err" role="alert">{remoteMcp.error}</div>}
                {remoteMcp.state === "error" && <button className="btn" type="button" disabled={authBusy} onClick={() => void loadRemoteMcp()}>Try again</button>}
              </div>
            </section>
          )}

<section className="settings-card">
            <header><Icon name="sun" className="sm" /><h2>Appearance</h2></header>
            <div className="card-body">
              <p>Choose how AliasMode looks. System follows your operating system setting.</p>
              <div className="segmented" role="radiogroup" aria-label="Theme">
                {THEMES.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    role="radio"
                    aria-checked={theme === option.key}
                    className={theme === option.key ? "active" : ""}
                    onClick={() => chooseTheme(option.key)}
                  >
                    <Icon name={option.icon} className="sm" />{option.label}
                  </button>
                ))}
              </div>
            </div>
          </section>
          <section className="settings-card">
            <header><Icon name={isCloudMode ? "laptop" : "cloud"} className="sm" /><h2>Switch mode</h2></header>
            <div className="card-body settings-mode">
              <p>{isCloudMode ? "Local mode keeps this installation offline from AliasMode Cloud." : "Cloud mode requires an account and does not upload Local profiles automatically."}</p>
              <button className="btn" type="button" disabled={modeBusy || desktopUpdateInstalling} onClick={() => requestModeSwitch(isCloudMode ? "local" : "cloud")}>
                <Icon name={isCloudMode ? "laptop" : "cloud"} className="sm" />
                Switch to {isCloudMode ? "Local" : "Cloud"}
              </button>
            </div>
          </section>
          
            </>
          )}
          {settingsTab === "team" && (
            <>
              <h2 className="sect-title">{isCloudMode ? "Team and folder access" : "Workspace"}</h2>
<section className="settings-card">
            <header><Icon name="folders" className="sm" /><h2>{isCloudMode ? "Team" : "Workspace"}</h2></header>
            <div className="card-body">
            {isCloudMode ? (
              <>
                <div className="settings-row"><span>Workspace</span><strong>{cloudAuth?.workspace?.name ?? "Cloud workspace"}</strong></div>
                <div className="settings-row"><span>Role</span><strong>{cloudAuth?.workspace?.role ?? "member"}</strong></div>
                {teamBusy && !team && <p className="hint" role="status">Loading team…</p>}
                <h3 className="settings-subhead">Members</h3>
                {team?.members.map((member) => (
                  <div className="team-member" key={member.accountId}>
                    <div className="settings-row">
                      <span>{member.email}<small> · {member.grants.map((grant) => `${grant.folderName}: ${grant.permission}`).join(", ") || "No folder access"}</small></span>
                      {member.role === "owner" || cloudAuth?.workspace?.role !== "owner" ? <strong>{member.role}</strong> : (
                        <select className="select" aria-label={`Role for ${member.email}`} value={member.role} disabled={teamBusy} onChange={(event) => void runTeamAction("role", { accountId: member.accountId, role: event.target.value })}>
                          <option value="member">member</option><option value="admin">admin</option>
                        </select>
                      )}
                    </div>
                    {member.role === "member" && (cloudAuth?.workspace?.role === "owner" || cloudAuth?.workspace?.role === "admin") && (
                      <div className="team-grants">
                        {team.folders.filter((folder) => !folder.archivedAt).map((folder) => {
                          const permission = member.grants.find((grant) => grant.folderName === folder.name)?.permission ?? "";
                          return <label key={folder.name}>{folder.name}<select className="select" aria-label={`${folder.name} access for ${member.email}`} value={permission} disabled={teamBusy} onChange={(event) => void runTeamAction(event.target.value ? "grant" : "remove-grant", { folderName: folder.name, accountId: member.accountId, permission: event.target.value })}><option value="">No access</option><option value="view">View</option><option value="edit">Edit</option></select></label>;
                        })}
                        <button className="btn xs danger" type="button" aria-label={`Remove ${member.email}`} disabled={teamBusy} onClick={() => void runTeamAction("remove-member", { accountId: member.accountId }, `Removed ${member.email}`)}>Remove</button>
                      </div>
                    )}
                  </div>
                ))}
                {(cloudAuth?.workspace?.role === "owner" || cloudAuth?.workspace?.role === "admin") && (
                  <>
                    <h3 className="settings-subhead">Invitations</h3>
                    <form className="team-code" onSubmit={(event) => { event.preventDefault(); void inviteTeamMember(); }}>
                      <input className="input" type="email" aria-label="Invite email" aria-describedby="invite-team-help" placeholder="Staff email address" value={teamEmail} disabled={teamBusy} onChange={(event) => setTeamEmail(event.target.value)} />
                      {cloudAuth?.workspace?.role === "owner" && <select className="select" aria-label="Invitation role" value={teamRole} disabled={teamBusy} onChange={(event) => setTeamRole(event.target.value as "admin" | "member")}><option value="member">Member</option><option value="admin">Admin</option></select>}
                      <button className="btn primary" type="submit" disabled={teamBusy || !teamEmail.trim()}>Send invite</button>
                    </form>
                    <p className="hint" id="invite-team-help">Invitations go to that exact verified email. New members see no folders until you grant access here.</p>
                    {team?.invitations.filter((invite) => !invite.acceptedAt && !invite.revokedAt).map((invite) => {
                      const status = invite.expiresAt <= Date.now() ? "Expired" : "Pending";
                      return <div className="settings-row" key={invite.id}>
                        <span>{invite.email}<small>{invite.role}</small></span>
                        <span>
                          <span className={`team-tag ${status.toLowerCase()}`}>{status}</span>
                          {(cloudAuth?.workspace?.role === "owner" || invite.role === "member") && <> <button className="btn xs" type="button" aria-label={`Resend invitation to ${invite.email}`} disabled={teamBusy} onClick={() => void runTeamAction("resend", { id: invite.id }, "Invitation resent")}>Resend</button> <button className="btn xs danger" type="button" aria-label={`Revoke invitation to ${invite.email}`} disabled={teamBusy} onClick={() => void runTeamAction("revoke", { id: invite.id }, "Invitation revoked")}>Revoke</button></>}
                        </span>
                      </div>;
                    })}
                  </>
                )}
                {teamErr && <p className="modal-err" role="alert">{teamErr}</p>}
                <h3 className="settings-subhead">Join another workspace</h3>
                <form className="team-code" onSubmit={(event) => { event.preventDefault(); void acceptInvitation(); }}>
                  <input className="input" aria-label="Invitation code" placeholder="Paste invitation code" value={invitationCode} onChange={(event) => setInvitationCode(event.target.value)} />
                  <button className="btn primary" type="submit" disabled={authBusy || !invitationCode.trim()}>Accept</button>
                </form>
                <p className="hint">Paste the code from your invitation email. It works only for the email you signed in with.</p>
                {authNotice && <p className="hint" role="status">{authNotice}</p>}
                {authErr && <p className="modal-err" role="alert">{authErr}</p>}
              </>
            ) : <p>Local mode has no Cloud workspace.</p>}
            </div>
          </section>
          
            </>
          )}
          {settingsTab === "advanced" && (
            <>
              <h2 className="sect-title">Updates and diagnostics</h2>
<section className="settings-card update-settings">
            <header><Icon name="import" className="sm" /><h2>Updates</h2></header>
            <div className="card-body">
            <div className="settings-row"><span>Installed version</span><strong className="mono">{appVersion || desktopUpdate?.currentVersion || "—"}</strong></div>
            {desktopUpdateResultSummary && (
              <div
                className={`update-last-result ${desktopUpdateResultSummary.tone}`}
                role={desktopUpdateResultSummary.tone === "success" ? "status" : "alert"}
              >
                <strong>{desktopUpdateResultSummary.title}</strong>
                <span>{desktopUpdateResultSummary.detail}</span>
              </div>
            )}
            {desktopUpdate?.state === "upToDate" && <p role="status">AliasMode is up to date.</p>}
            {desktopUpdate?.state === "available" && (
              <>
                <p role="status">Version {desktopUpdate.version} is ready. Active browsers will be saved and closed.</p>
                <UpdateHighlights version={desktopUpdate.version} highlights={desktopUpdate.highlights} />
              </>
            )}
            {!desktopUpdate && !desktopUpdateChecking && <p>AliasMode checks for updates when it starts.</p>}
            {desktopUpdateProgress && <DesktopUpdateProgressView progress={desktopUpdateProgress} />}
            {desktopUpdateErr && <div className="modal-err" role="alert">{desktopUpdateErr}</div>}
            <div className="update-actions">
              <button className="btn" type="button" disabled={desktopUpdateChecking || desktopUpdateInstalling} onClick={() => void checkDesktopUpdate(true)}>
                <Icon name="refresh" className="sm" />{desktopUpdateChecking ? "Checking…" : "Check for updates"}
              </button>
              {desktopUpdate?.state === "available" && (
                <button className="btn primary" type="button" disabled={desktopUpdateChecking || desktopUpdateInstalling} onClick={() => void installDesktopUpdate()}>
                  {desktopUpdateInstalling ? "Updating…" : "Update now"}
                </button>
              )}
            </div>
            </div>
          </section>
          
{isCloudMode && (
            <section className="settings-card diagnostics-section">
              <header>
                <Icon name="activity" className="sm" /><h2>Recent diagnostics</h2>
                <button className="btn xs" type="button" disabled={cloudEventsBusy} onClick={() => void loadCloudEvents()}>
                  {cloudEventsBusy ? "Loading…" : "Refresh"}
                </button>
              </header>
              <div className="card-body">
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
              </div>
            </section>
          )}
          {/* Logs are not a Cloud feature — a Local install needs them just as
              much, so this card is the one part of Advanced that always shows. */}
          <section className="settings-card">
            <header><Icon name="logs" className="sm" /><h2>Logs</h2></header>
            <div className="card-body">
              <p>The detailed log records launches, proxy setup and browser lifecycle for this installation.</p>
              <button type="button" className="btn" onClick={() => {
                setLogErr(null);
                fetchLogs().then(setLogView).catch((e) => setLogErr(e instanceof Error ? e.message : String(e)));
              }}><Icon name="logs" className="sm" />View detailed logs</button>
              {logErr && <p className="cardnote">Logs: {logErr}</p>}
              {logDir && <p className="cardnote">File: {logDir}</p>}
            </div>
          </section>
          
            </>
          )}
          {modeErr && <div className="modal-err" role="alert"><Icon name="alert" className="sm" />{modeErr}</div>}
        </div>
        <footer className="pagefoot">
          <span className="spacer" />
          <button className="btn primary" type="button" onClick={() => setView("profiles")}>Done</button>
        </footer>
      </div>
      ) : null}
      </div>

      {(logView || logErr) && (
        <div className="modal-backdrop" onClick={() => { setLogView(null); setLogErr(null); }}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">Detailed logs<button type="button" className="modal-close" aria-label="Close" onClick={() => { setLogView(null); setLogErr(null); }}><Icon name="close" className="sm" /></button></div>
            <div className="modal-body">
              {logErr && <p className="hint">{logErr}</p>}
              {logView && (
                <pre className="logpre">
                  {logView.file + "\n" + logView.content}
                </pre>
              )}
            </div>
            <div className="modal-foot"><button className="btn ghost" type="button" onClick={() => { setLogView(null); setLogErr(null); }}>Close</button></div>
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
        /* Form dialog: a stray backdrop click must not discard typed input —
           close via Cancel, the X, or Escape (the backdrop has no onClick). */
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="create-profile-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head" id="create-profile-title">
              <Icon name="plus" />New profile
              <button type="button" className="modal-close" aria-label="Close" onClick={closeCreate}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body">
              {createErr && <div className="modal-err"><Icon name="alert" className="sm" />{createErr}</div>}
              <div className="fld-row">
                <label className="fld grow">
                  <span>Name</span>
                  <input value={form.name} placeholder="auto if blank" onChange={(e) => setF("name", e.target.value)} />
                </label>
                {!isCloudMode && (
                  <label className="fld no">
                    <span>Custom NO.</span>
                    <input
                      value={form.customNo}
                      inputMode="numeric"
                      maxLength={MAX_CUSTOM_NO}
                      placeholder="auto"
                      onChange={(e) => setF("customNo", e.target.value.replace(/\D/g, "").slice(0, MAX_CUSTOM_NO))}
                    />
                  </label>
                )}
              </div>
              <div className="fld-row">
                <label className="fld grow">
                  <span>Folder</span>
                  <GroupPicker value={form.group} onChange={(v) => setF("group", v)} groups={editableGroups} allowCreate={!isCloudMode} />
                </label>
                <label className="fld grow">
                  <span>Platform</span>
                  <PlatformPicker value={form.platform} onChange={(v) => setF("platform", v)} />
                </label>
              </div>
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
                <button type="button" className="btn accent" disabled={!proxyPaste.trim()} onClick={() => applyProxyPaste(proxyPaste)}>Autofill</button>
              </div>
              {proxyPasteOk && <div className="proxy-paste-ok"><Icon name="check" className="sm" />{proxyPasteOk}</div>}
              <div className="fld-row">
                <label className="fld type">
                  <span>Proxy type</span>
                  <select value={form.proxyType} onChange={(e) => setF("proxyType", e.target.value)}>
                    <option value="http">http</option>
                    <option value="socks5">socks5</option>
                  </select>
                </label>
                <label className="fld grow">
                  <span>Host</span>
                  <input value={form.host} placeholder="blank = no proxy" onChange={(e) => setF("host", e.target.value)} />
                </label>
                <label className="fld port">
                  <span>Port</span>
                  <input value={form.port} inputMode="numeric" placeholder="8080" onChange={(e) => setF("port", e.target.value)} />
                </label>
              </div>
              <div className="fld-row">
                <label className="fld grow"><span>Proxy user</span><input value={form.user} onChange={(e) => setF("user", e.target.value)} /></label>
                <label className="fld grow"><span>Proxy pass</span><input type="password" value={form.pass} onChange={(e) => setF("pass", e.target.value)} /></label>
              </div>
              <div className="proxy-referral">
                <div>
                  <strong>Need a proxy?</strong>
                  <span>Static residential proxies from $2.97/mo at OutreachProxy.</span>
                </div>
                <a
                  href="https://outreachproxy.com/t/aliasmode"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Get a proxy from OutreachProxy (opens externally)"
                >
                  Get a proxy <span aria-hidden="true">↗</span>
                </a>
              </div>
              <FingerprintSettings screen={form.screen} onScreenChange={(value) => setF("screen", value)} />
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={closeCreate}>Cancel</button>
              <button className="btn primary" disabled={creating} onClick={submitCreate}>{creating ? "Creating…" : "Create profile"}</button>
            </div>
          </div>
        </div>
      )}

      {editId && (
        /* Form dialog: a stray backdrop click must not discard typed input —
           close via Cancel, the X, or Escape (the backdrop has no onClick). */
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-profile-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head" id="edit-profile-title">
              <Icon name="edit" />Edit profile<span className="mono muted">{editId}</span>
              <button type="button" className="modal-close" aria-label="Close" onClick={closeEdit}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body">
              {editErr && <div className="modal-err"><Icon name="alert" className="sm" />{editErr}</div>}
              {editLoading ? (
                <p className="hint" role="status">Loading profile…</p>
              ) : (
                <>
                  {editForm.proxyError && <div className="modal-err"><Icon name="alert" className="sm" />Stored proxy quarantined: {editForm.proxyError}. Replace it below or clear the field.</div>}
                  {(editLive || (!isCloudMode && editRunning)) && (
                    <p className="hint" role="status">
                      {editLive
                        ? "This browser is open. Changes save to this device now and sync to Cloud when it closes."
                        : "This browser is open. Changes save now and apply the next time it launches."}
                    </p>
                  )}
                  {!isCloudMode && editMobile && (
                    <div className="persona-warning">
                      <strong><Icon name="warning" className="sm" />Imported mobile persona cannot open safely</strong>
                      <span>
                        Older AliasMode opened it as a desktop browser anyway: Android became Windows; iPhone/iPad became macOS. That looked usable, but it was not coherent mobile emulation.
                      </span>
                      <span>
                        Convert it once to {editMobile.platform === "macos" ? "macOS" : "Windows"} desktop. Cookies, login/session, proxy, timezone, credentials and fingerprint seed stay intact
                        {editMobile.screenChanged ? `; the mobile-sized screen becomes ${editMobile.resolution}` : "; the existing desktop-sized screen stays intact"}.
                      </span>
                      <button className="btn persona-convert" disabled={editSaving} onClick={convertEditedMobile}>
                        {editSaving ? "Converting…" : `Convert to ${editMobile.platform === "macos" ? "macOS" : "Windows"} desktop`}
                      </button>
                    </div>
                  )}
                  <div className="fld-row">
                    <label className="fld grow">
                      <span>Name</span>
                      <input value={editForm.name ?? ""} onChange={(e) => setEF("name", e.target.value)} />
                    </label>
                    {!isCloudMode && (
                      <label className="fld no">
                        <span>Custom NO.</span>
                        <input
                          value={editForm.customNo ?? ""}
                          inputMode="numeric"
                          maxLength={MAX_CUSTOM_NO}
                          placeholder={editSerial != null ? String(editSerial) : "auto"}
                          onChange={(e) => setEF("customNo", e.target.value.replace(/\D/g, "").slice(0, MAX_CUSTOM_NO))}
                        />
                        <small>Digits only · blank uses the serial</small>
                      </label>
                    )}
                  </div>
                  <div className="fld-row">
                    <label className="fld grow">
                      <span>Folder</span>
                      <GroupPicker value={editForm.group ?? ""} onChange={(v) => setEF("group", v)} groups={editableGroups} allowCreate={!isCloudMode} />
                    </label>
                    <label className="fld grow">
                      <span>Platform</span>
                      <PlatformPicker value={editForm.platform ?? ""} onChange={(v) => setEF("platform", v)} />
                    </label>
                  </div>
                  <label className="fld">
                    <span>Tags <span className="muted">(comma-separated)</span></span>
                    <input value={editForm.tags ?? ""} placeholder="warmup, us, priority" onChange={(e) => setEF("tags", e.target.value)} />
                  </label>
                  <div className="fld-row">
                    <label className="fld type">
                      <span>Proxy type</span>
                      <select value={editForm.proxyType ?? "http"} onChange={(e) => setEF("proxyType", e.target.value)}>
                        <option value="http">http</option>
                        <option value="socks5">socks5</option>
                      </select>
                    </label>
                    <label className="fld grow">
                      <span>Proxy</span>
                      <input value={editForm.proxy ?? ""} placeholder="host:port:username:password" onChange={(e) => setEF("proxy", e.target.value)} />
                      <small>Leave blank to launch on a direct connection.</small>
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
                      <button className="btn xs" onClick={() => navigator.clipboard?.writeText(editTotp.code)}>
                        <Icon name="copy" className="sm" />Copy
                      </button>
                    </div>
                  )}
                  <FingerprintSettings screen={editForm.resolution ?? ""} onScreenChange={(value) => setEF("resolution", value)} />
                  {!isCloudMode && extensions.length > 0 && (
                    <div className="fld">
                      <span>Extensions</span>
                      <div className="extassign">
                        {extensions.map((x) => (
                          <label key={x.id} className="extchk">
                            <input type="checkbox" checked={editExts.includes(x.id)} onChange={() => toggleEditExt(x.id)} />
                            <span>{x.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  <p className="formnote">
                    Cookies and locked fingerprint values are preserved. Only editable fields change.
                    {!isCloudMode && " Extensions load when the browser opens."}
                  </p>
                </>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={closeEdit}>Cancel</button>
              <button className="btn primary" disabled={editSaving || editLoading} onClick={saveEdit}>{editSaving ? "Saving…" : "Save changes"}</button>
            </div>
          </div>
        </div>
      )}

      {showBulk && (
        /* Form dialog: a stray backdrop click must not discard typed input —
           close via Cancel, the X, or Escape (the backdrop has no onClick). */
        <div className="modal-backdrop">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <Icon name="fileImport" />Import accounts
              <button type="button" className="modal-close" aria-label="Close" onClick={closeBulk}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body">
              {bulkErr && <div className="modal-err"><Icon name="alert" className="sm" />{bulkErr}</div>}

              <div className="segmented" role="tablist" aria-label="Import source">
                <button
                  type="button"
                  role="tab"
                  aria-selected={bulkSource === "file"}
                  className={bulkSource === "file" ? "active" : ""}
                  onClick={() => { setBulkSource("file"); setBulkText(""); }}
                >
                  <Icon name="fileImport" className="sm" />From file
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={bulkSource === "paste"}
                  className={bulkSource === "paste" ? "active" : ""}
                  onClick={() => { setBulkSource("paste"); setBulkFiles([]); }}
                >
                  <Icon name="copy" className="sm" />Paste text
                </button>
              </div>

              {bulkSource === "file" ? (
                <>
                  <div
                    className={`bulkdrop${bulkOver ? " over" : ""}`}
                    onClick={() => bulkFileRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); if (!bulkOver) setBulkOver(true); }}
                    onDragLeave={(e) => { e.preventDefault(); setBulkOver(false); }}
                    onDrop={(e) => { e.preventDefault(); setBulkOver(false); if (e.dataTransfer.files?.length) setBulkFiles(Array.from(e.dataTransfer.files)); }}
                  >
                    <Icon name="fileImport" />
                    <b>Drag &amp; drop files, or click to choose</b>
                    <div className="sub">CSV using the template columns, or an AdsPower <code>.txt</code> export</div>
                  </div>
                  {bulkFiles.length > 0 && (
                    <div className="filelist">
                      {bulkFiles.map((file) => (
                        <span className="filechip" key={file.name}>
                          <Icon name="file" className="sm" />
                          <span className="fname">{file.name}</span>
                          <button
                            type="button"
                            aria-label={`Remove ${file.name}`}
                            onClick={() => setBulkFiles((files) => files.filter((candidate) => candidate !== file))}
                          ><Icon name="close" className="sm" /></button>
                        </span>
                      ))}
                      <button type="button" className="btn xs ghost" onClick={() => setBulkFiles([])}>Clear all</button>
                    </div>
                  )}
                </>
              ) : (
                <label className="fld">
                  <span>AdsPower TXT records</span>
                  <textarea
                    rows={9}
                    value={bulkText}
                    placeholder={"id=k1example01\ngroup=Warmup\nname=alice\n…"}
                    onChange={(event) => setBulkText(event.target.value)}
                  />
                  <small>{pastedRecordCount === null
                    ? "Paste one or more key=value records, separated by a line of asterisks."
                    : `${pastedRecordCount} record${pastedRecordCount === 1 ? "" : "s"} detected — each one starts with its own id= line.`}</small>
                </label>
              )}

              <input
                ref={bulkFileRef}
                type="file"
                multiple
                accept=".csv,.txt,text/plain,text/csv"
                style={{ display: "none" }}
                onChange={(e) => { if (e.target.files) setBulkFiles(Array.from(e.target.files)); e.target.value = ""; }}
              />

              <div className="fld-row">
                <label className="fld grow">
                  <span>{isCloudMode ? "Destination folder" : "Assign to group"}</span>
                  <GroupPicker value={bulkGroup} onChange={setBulkGroup} groups={isCloudMode ? editableGroups : existingGroups} allowCreate={!isCloudMode} />
                </label>
                <label className="fld grow">
                  <span>Platform</span>
                  <select value={bulkPlatform} onChange={(e) => setBulkPlatform(e.target.value)}>
                    {KNOWN_PLATFORMS.map((platform) => <option key={platform.value} value={platform.value}>{platform.label}</option>)}
                  </select>
                </label>
              </div>
              <p className="formnote">
                Anything chosen above overrides that field on every imported record, including
                AdsPower TXT records that already carry a group.
              </p>
              <p className="formnote">
                An AliasMode export also carries <code>seed</code>, <code>timezone</code> and{" "}
                <code>platform_os</code>, which recreate the exact browser fingerprint. Its{" "}
                <code>fp_*</code> columns are a <b>record</b> of the fingerprint that was measured,
                not settings — they are checked after the browser opens, never applied to it.
              </p>
            </div>
            <div className="modal-foot">
              <button className="tlink" onClick={() => downloadText("aliasmode-template.csv", CSV_TEMPLATE, "text/csv")}>
                <Icon name="export" className="sm" />CSV template
              </button>
              <button className="tlink" onClick={() => downloadText("aliasmode-example.txt", TXT_EXAMPLE, "text/plain")}>
                <Icon name="export" className="sm" />.txt example
              </button>
              <span className="spacer" />
              <button className="btn ghost" onClick={closeBulk}>Cancel</button>
              <button className="btn primary" disabled={bulkBusy || (!bulkFiles.length && !bulkText.trim()) || (isCloudMode && !bulkGroup)} onClick={submitBulk}>
                <Icon name="fileImport" className="sm" />{bulkBusy ? "Importing…" : "Import"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showUpdate && (
        /* Form dialog: a stray backdrop click must not discard typed input —
           close via Cancel, the X, or Escape (the backdrop has no onClick). */
        <div className="modal-backdrop">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">Update profiles from file<button type="button" className="modal-close" aria-label="Close" onClick={() => setShowUpdate(false)}><Icon name="close" className="sm" /></button></div>
            <div className="modal-body">
              {updateErr && <div className="modal-err"><Icon name="alert" className="sm" />{updateErr}</div>}
              {updateResult && <div className="modal-ok"><Icon name="check" className="sm" />{updateResult}</div>}
              <ol className="steps">
                <li><b>Export</b> the profiles you want to change — that gives you a file with each profile's <code>id</code> (how rows are matched).</li>
                <li><b>Edit</b> the columns you want (name, username, password, 2FA, proxy…). Keep the <code>id</code> column; delete any column you don't want to touch.</li>
                <li>Add a <code>custom_no</code> column to renumber profiles in bulk — that number shows in the roster and in the launched browser's window title.</li>
                <li><b>Re-upload</b> the edited file below. Matched by <code>id</code>; cookies &amp; fingerprints are preserved — editing a <code>cookie</code> or <code>ua</code> column has no effect, an update never rewrites an identity.</li>
              </ol>
              <div className="updexport">
                {selected.size > 0 ? (
                  <span>
                    Export {selected.size} selected:&nbsp;
                    <button className="tlink" onClick={() => exportSelected("csv")}><Icon name="export" className="sm" />CSV</button>
                    &nbsp;·&nbsp;
                    <button className="tlink" onClick={() => exportSelected("txt")}><Icon name="export" className="sm" />.txt</button>
                    &nbsp;·&nbsp;
                    <button className="tlink" onClick={() => exportSelected("xlsx")}><Icon name="export" className="sm" />Excel</button>
                  </span>
                ) : (
                  <span className="hint">Tip: select profiles first, then export here to get an editable file.</span>
                )}
                <span className="grow" />
                <button className="tlink" onClick={() => downloadText("aliasmode-update-template.csv", UPDATE_TEMPLATE_CSV, "text/csv")}><Icon name="export" className="sm" />example sheet</button>
              </div>
              <div
                className={`bulkdrop${updateOver ? " over" : ""}`}
                onClick={() => updateFileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); if (!updateOver) setUpdateOver(true); }}
                onDragLeave={(e) => { e.preventDefault(); setUpdateOver(false); }}
                onDrop={(e) => { e.preventDefault(); setUpdateOver(false); if (e.dataTransfer.files?.[0]) setUpdateFile(e.dataTransfer.files[0]); }}
              >
                <Icon name="export" />
                <b>Drag &amp; drop the edited file, or click to choose</b>
                <div className="sub">CSV, <code>.txt</code> or Excel <code>.xlsx</code> with an <code>id</code> column</div>
              </div>
              <input
                ref={updateFileRef}
                type="file"
                accept=".csv,.txt,.xlsx,text/plain,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                style={{ display: "none" }}
                onChange={(e) => { if (e.target.files?.[0]) setUpdateFile(e.target.files[0]); e.target.value = ""; }}
              />
              {updateFile && <div className="bulkfiles"><Icon name="file" className="sm" />Selected: <b>{updateFile.name}</b></div>}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setShowUpdate(false)}>Close</button>
              <button className="btn primary" disabled={updateBusy || !updateFile} onClick={submitUpdate}>{updateBusy ? "Updating…" : "Update profiles"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
