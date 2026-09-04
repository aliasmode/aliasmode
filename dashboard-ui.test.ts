import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(import.meta.dir, "web", "app.tsx"), "utf8").replaceAll("\r\n", "\n");
const styles = readFileSync(join(import.meta.dir, "web", "styles.css"), "utf8").replaceAll("\r\n", "\n");
const logo = readFileSync(join(import.meta.dir, "web", "alias-loop.svg"), "utf8").replaceAll("\r\n", "\n");
const notice = readFileSync(join(import.meta.dir, "NOTICE"), "utf8");

test("dashboard renders the approved Alias Loop logo and it survives dark mode", () => {
  // The mark is inlined so the dark arm can ride currentColor: the packaged
  // SVG's #111827 stroke is invisible on a dark surface.
  expect(app).toContain("function AliasLoop(");
  expect(app).toContain('stroke="currentColor"');
  expect(app).toContain('<div className="brand"><AliasLoop />AliasMode</div>');
  expect(app).toContain('<div className="onboarding-brand"><AliasLoop />AliasMode');
  expect(styles).toContain(".alias-loop .loop-accent { stroke: var(--accent); }");
  expect(styles).not.toContain(".brand::before");
  // Both marks draw the same approved paths as the packaged asset.
  const paths = [
    'd="M152 96H320C380 96 416 136 416 196V316C416 376 376 416 316 416H196C136 416 96 376 96 316V288"',
    'd="M96 288C96 240 136 208 184 208H280"',
  ];
  for (const path of paths) {
    expect(app).toContain(path);
    expect(logo).toContain(path);
  }
});

test("dashboard exposes account settings and confirms mode switching", () => {
  expect(app).toContain('aria-label="Open Account and Settings"');
  expect(app).toContain("<ModeSwitchConfirmation");
  expect(app).toContain("Cloud profiles will not appear until you switch back");
  expect(app).toContain("does not upload them to Cloud automatically");
  expect(app).toContain("Accept and continue to Cloud");
  expect(app).not.toContain(">Stay Local</button>");
  expect(app).toContain('Switch to {isCloudMode ? "Local" : "Cloud"}');
  expect(app).toContain('invoke("restart_after_mode_change")');
});

test("dashboard offers HTTPS proxies in both profile forms", () => {
  expect(app.match(/<option value="https">https<\/option>/g)).toHaveLength(2);
});

test("dashboard shows curated desktop update notes and live progress", () => {
  expect(app).toContain('import { Channel } from "@tauri-apps/api/core"');
  expect(app).toContain('type DesktopUpdateStatus =');
  expect(app).toContain('invoke("check_for_updates")');
  expect(app).toContain('invoke("update_now", { onProgress })');
  expect(app).toContain('message.phase === "ready"');
  expect(app).toContain('{ ...status, version: message.version, highlights: message.highlights }');
  expect(app).not.toContain('invoke("check_for_updates",');
  expect(app).toContain("desktopUpdateCheckStarted.current = true");
  expect(app).toContain("AliasMode checks for updates when it starts.");
  expect(app).toContain('className="update-highlights"');
  expect(app).toContain('<summary>What’s new in {version}</summary>');
  expect(app).toContain('<progress max={100} value={percent ?? undefined}');
  expect(app).toContain("Preparing update…");
  expect(app).toContain("Downloading update…");
  expect(app).toContain("Verifying update…");
  expect(app).toContain("Saving and closing browsers…");
  expect(app).toContain("Installing and restarting…");
  expect(app).toContain('{desktopUpdateErr && <span className="modal-err" role="alert">{desktopUpdateErr}</span>}');
  expect(app).toContain('disabled={modeBusy || desktopUpdateInstalling}');
  expect(app).toContain('className="update-banner"');
  expect(styles).toContain(".update-banner");
  expect(styles).toContain(".update-highlights");
  expect(styles).toContain(".update-progress progress");
  expect(styles).toContain("accent-color: var(--accent)");
});

test("dashboard shows the durable result in its banner and Updates panel", () => {
  expect(app).toContain('parseDesktopUpdateResult');
  expect(app).toContain('invoke("last_update_result")');
  expect(app).toContain('setDesktopUpdateResult(parseDesktopUpdateResult(value))');
  expect(app).toContain('className={`update-banner update-result ${desktopUpdateResultSummary.tone}`}');
  expect(app).toContain('aria-label="Dismiss last update result"');
  expect(app).toContain('className={`update-last-result ${desktopUpdateResultSummary.tone}`}');
  expect(app).toContain('{desktopUpdateResultSummary.title}');
  expect(app).toContain('{desktopUpdateResultSummary.detail}');
  expect(styles).toContain('.update-banner.update-result.success');
  expect(styles).toContain('.update-last-result.warning');
  expect(styles).toContain('.update-last-result.error');
});

test("dashboard contains long roster labels inside the window", () => {
  expect(app).toContain('className="profile-table"');
  // The name sits in its own truncatable span; the fingerprint badge rides
  // alongside it inside that span, so match the wrapper rather than the whole
  // element (which changes whenever anything is added next to the name).
  expect(app).toContain('<span className="n">{p.name}');
  expect(app).toContain('<td className="col-group" title={p.group}>');
  expect(app).toContain('className="select move-group"');
  // Every truncatable cell carries its full value as a title, so hovering shows
  // what the ellipsis hid.
  expect(app).toContain('title={`${p.name}\\n${p.id}`}');
  expect(app).toContain('title={p.tags?.length ? p.tags.join(", ") : "No tags"}');
  expect(app).toContain('title={p.proxyError || p.proxy || "no proxy"}');
  // Fixed layout plus per-column clipping keeps a long value inside its cell.
  expect(styles).toContain("table-layout: fixed");
  expect(styles).toContain("td.col-no, td.col-name, td.col-group, td.col-tags, td.col-proxy { overflow: hidden; text-overflow: ellipsis; }");
});

test("Account settings offers fenced Cloud sign-out and clears account state", () => {
  expect(app).toContain('"Sign out / Switch account"');
  expect(app).toContain("await signOutCloud();");
  expect(app).toContain("authGeneration.current++;");
  expect(app).toContain("setCloudAuth({ authenticated: false });");
  expect(app).toContain("setProfiles([]);");
  expect(app).toContain("setTeam(null);");
  expect(app).toContain("generation !== authGeneration.current");

  const account = app.slice(
    app.indexOf('<h2 className="sect-title">Account information</h2>'),
    app.indexOf('className="settings-card remote-mcp-settings"'),
  );
  expect(account).toContain('{authErr && <p className="modal-err" role="alert">{authErr}</p>}');
});

test("dashboard accepts a server-persisted pending queue key", () => {
  expect(app).toContain("result.queueKeyPersisted !== true");
  expect(app).toContain('typeof result.queueKey === "string" ? result.queueKey : undefined');
});

test("Account settings prepares and protects one app-owned Remote MCP connector", () => {
  expect(app).toContain('key: "remote_mcp_connector"');
  expect(app).toContain('createCloudConnector()');
  expect(app).toContain('fetchCloudConnector(stored.connectorId)');
  expect(app).toContain('storeDesktopRemoteMcpCredential({ version: 1, state: "disabled" })');
  expect(app).toContain('>Remote MCP</h2>');
  expect(app).toContain('>MCP server URL</span>');
  expect(app).toContain('>Access key</span>');
  expect(app).toContain('remoteMcpTokenVisible ? remoteMcp.token : "••••••••••••••••••••••••"');
  expect(app).toContain('>Connect Claude.ai or ChatGPT</strong>');
  expect(app).toContain('Paste the MCP server URL and select Connect.');
  expect(app).toContain('Sign into AliasMode and select Allow.');
  expect(app).toContain('Claude.ai and ChatGPT use OAuth and do not need the access key.');
  expect(app).not.toContain('web connectors are not supported');
  expect(app).toContain('Regenerate key');
  expect(app).toContain('Enable Remote MCP');
  expect(app).toContain('if (remoteMcpAccountExit.current) return Promise.resolve();');
  expect(app).toContain('await prepareRemoteMcpForAccountExit(true);\n      await forgetCloudSession();');
  expect(app).toContain('if (view !== "settings" || !isCloudMode || !workspaceReady || restartRequired) return;');
  expect(app).toContain('await prepareRemoteMcpForAccountExit();\n      await signOutCloud();');
  expect(styles).toContain('.remote-mcp-status.active');
  expect(styles).toContain('.remote-mcp-value input');
});

test("dashboard recovers saved Cloud sessions without false sign-out", () => {
  expect(app).toContain('type SavedSessionPhase = "restoring" | "manual-signin" | "retryable-failure";');
  expect(app).toContain('useState<SavedSessionPhase>("restoring")');
  expect(app).toContain("Restoring saved session");
  expect(app).toContain(">Try again</button>");
  expect(app).toContain(">Sign in instead</button>");
  expect(app).toContain("error instanceof CloudSessionRestoreError && !error.retryable");
  expect(app).toContain("setScheduledRefreshPending(true)");
  expect(app).toContain('window.addEventListener("online", retryWhenOnline)');
  expect(app).toContain("await forgetCloudSession()");
  expect(app).toContain("const savedSessionRestoreEnabled = useRef(true)");
  expect(app).toContain("if (!savedSessionRestoreEnabled.current || restoreInFlight.current) return;");
  expect(app).toContain("generation !== authGeneration.current || !savedSessionRestoreEnabled.current");
  expect(app).toContain("savedSessionRestoreEnabled.current = false");
  expect(app).toContain("cloudSessionContextReady(state)");
});

test("Account settings exposes fixed Cloud diagnostics without raw server messages", () => {
  expect(app).toContain("fetchCloudEvents");
  expect(app).toContain("Recent diagnostics");
  expect(app).toContain("CLOUD_DIAGNOSTIC_LABELS[event.type]");
  expect(app).toContain("Cloud lease ended after a version conflict");
  expect(app).toContain("Browser teardown could not be confirmed");
  expect(app).toContain("Session synchronization has a terminal conflict");
  expect(app).toContain("They exclude profile data and credentials");
  expect(styles).toContain(".diagnostics-list");
});

test("dashboard shows close warnings without an open-only prefix", () => {
  expect(app).toContain("else if (r && r.warning) setActionErr(r.warning);");
  expect(app).not.toContain("Opened — ${r.warning}");
  expect(app).toContain("if (r?.ok === false) issues.push");
  expect(app).toContain("else if (r?.warning) issues.push");
});

test("dashboard lists the supported profile platforms", () => {
  for (const platform of [
    "x.com",
    "instagram.com",
    "facebook.com",
    "tiktok.com",
    "linkedin.com",
    "reddit.com",
    "telegram.org",
  ]) {
    expect(app).toContain(`value: "${platform}"`);
  }
});

test("New Profile promotes the approved proxy provider after proxy credentials", () => {
  const createModal = app.slice(app.indexOf("{showCreate && ("), app.indexOf("{editId && ("));
  const credentials = createModal.indexOf("<span>Proxy pass</span>");
  const referral = createModal.indexOf('className="proxy-referral"');
  const fingerprint = createModal.indexOf("<FingerprintSettings");

  expect(credentials).toBeGreaterThan(-1);
  expect(referral).toBeGreaterThan(credentials);
  expect(fingerprint).toBeGreaterThan(referral);
  expect(createModal).toContain('href="https://outreachproxy.com/t/aliasmode"');
  expect(createModal).toContain('target="_blank"');
  expect(createModal).toContain('rel="noreferrer"');
  expect(createModal).toContain('aria-label="Get a proxy from OutreachProxy (opens externally)"');
  expect(createModal).toContain('aria-hidden="true"');
  expect(styles).toContain(".proxy-referral {");
  expect(styles).toContain(".proxy-referral a:focus-visible");
});

test("running profile rows expose Bring to front in Local and Cloud mode", () => {
  expect(app).toContain('data-tip="Bring to front"');
  expect(app).toContain('aria-label="Bring this browser window to the front"');
  expect(app).toContain('onClick={() => act(p.id, raiseProfile)}');
  // The running-row branch must stay mode-agnostic: raising a window is a local
  // action on a browser this machine already opened, in Cloud mode too.
  const runningBranch = app.slice(app.indexOf("{p.running ? ("), app.indexOf(") : p.mobilePersona ? ("));
  expect(runningBranch).toContain("Bring to front");
  expect(runningBranch).not.toContain("isCloudMode");
});

test("running profile rows expose live cookie addition in every mode", () => {
  expect(app).toContain('data-tip="Add cookie"');
  expect(app).toContain('aria-label={`Add a cookie to ${p.name}`}');
  expect(app).toContain('onClick={() => openCookie(p)}');

  const runningBranch = app.slice(app.indexOf("{p.running ? ("), app.indexOf(") : p.mobilePersona ? ("));
  expect(runningBranch).toContain("Add cookie");
  expect(runningBranch).not.toContain("isCloudMode");

  expect(app).toContain('aria-labelledby="add-cookie-title"');
  expect(app).toContain('<span>Name</span>');
  expect(app).toContain('<span>Value</span>');
  expect(app).toContain('<span>Domain</span>');
  expect(app).toContain('<span>Path</span>');
  expect(app).toContain('type="password" autoComplete="off"');
  expect(app).toContain("await addProfileCookie(cookieProfile.id, cookieForm);");
  expect(app).toContain('flash("Cookie added to the open browser.");');
  expect(app).not.toContain('className="modal-backdrop" onClick={closeCookie}');
});

test("Cloud rows expose Edit and Convert device only with effective Edit permission", () => {
  // Running rows are editable (live edit through the local cache); only rows
  // locked by ANOTHER session stay read-only.
  expect(app).toContain('(p.permission === "edit" && !p.lockedBy)');
  expect(app).toContain('(!isCloudMode || p.permission === "edit")');
  expect(app).toContain('title="Convert this mobile persona to a desktop device"');
  expect(app).toContain("setEditExpectedVersion(p.expectedVersion ?? null)");
  expect(app).toContain("isCloudMode && !editLive ? editExpectedVersion ?? undefined : undefined");
  expect(app).toContain("!isCloudMode && editTotp");
  expect(app).toContain("!isCloudMode && editMobile");
});

test("Cloud profile pickers use only editable folders", () => {
  expect(app).toContain('<GroupPicker value={form.group} onChange={(v) => setF("group", v)} groups={editableGroups} allowCreate={!isCloudMode} />');
  expect(app).toContain('<GroupPicker value={editForm.group ?? ""} onChange={(v) => setEF("group", v)} groups={editableGroups} allowCreate={!isCloudMode} />');
  expect(app).toContain('group !== "all" && (!isCloudMode || editableGroups.includes(group))');
  expect(app).toContain('<GroupPicker value={bulkGroup} onChange={setBulkGroup} groups={isCloudMode ? editableGroups : existingGroups} allowCreate={!isCloudMode} />');
});

test("bulk import accepts pasted AdsPower text in Local and Cloud mode", () => {
  expect(app).toContain('className="btn importbtn tip"');
  expect(app).toContain('disabled={!canEditCloud}');
  expect(app).toContain('value={bulkText}');
  expect(app).toContain('onChange={(event) => setBulkText(event.target.value)}');
  expect(app).toContain('new File([bulkText], "pasted-adspower.txt", { type: "text/plain" })');
  expect(app).toContain('setBulkText("")');
  expect(app).toContain('bulkBusy || (!bulkFiles.length && !bulkText.trim()) || (isCloudMode && !bulkGroup)');
  expect(app).not.toContain('max 1000');
});

test("Cloud workspace loads independently and refreshes with Account Settings", () => {
  expect(app).toContain("if (!isCloudMode || !workspaceReady || restartRequired) return;\n    void loadTeam();");
  expect(app).toContain("void loadCloudEvents();\n    void loadTeam();");
  expect(app).toContain("await Promise.all([load(), loadTeam()]);");
});

test("sidebar creates persistent groups and gates Cloud deletion to workspace managers", () => {
  expect(app).toContain("const [registeredGroups, setRegisteredGroups] = useState<string[]>([]);");
  expect(app).toContain("team?.folders.filter((folder) => !folder.archivedAt).map((folder) => folder.name)");
  expect(app).toContain("const canManageCloudFolders = cloudAuth?.workspace?.role === \"owner\" || cloudAuth?.workspace?.role === \"admin\";");
  expect(app).toContain('className="newgroup"');
  expect(app).toContain('{isCloudMode ? "New folder" : "New group"}');
  expect(app).toContain('if (name === "all") {');
  expect(app).toContain('cloudWorkspaceAction("delete-folder", { name: g })');
  expect(app).toContain("!isCloudMode || canManageCloudFolders");
  expect(styles).toContain(".newgroup");
});

test("Team settings guide invitations and explicit folder access", () => {
  for (const heading of ["Members", "Invitations", "Join another workspace"]) expect(app).toContain(`>${heading}</h3>`);
  // The "Your folder access" self-listing was removed on request: an owner or
  // admin already sees every folder, so the list said nothing.
  expect(app).not.toContain("Your folder access");
  expect(app).toContain("New members see no folders until you grant access here.");
  expect(app).toContain("It works only for the email you signed in with.");
  expect(app).toContain('invite.expiresAt <= Date.now() ? "Expired" : "Pending"');
  expect(app).toContain('aria-label={`${folder.name} access for ${member.email}`}');
  expect(app).toContain('aria-label={`Resend invitation to ${invite.email}`}');
  expect(app).toContain('if (ok) setTeamEmail("")');
  expect(app).toContain('className="notice" role="status"');
  expect(styles).toContain(".team-tag");
  expect(styles).toContain(".team-code input:focus");
});

test("Admin invitations are read-only for Admin viewers", () => {
  expect(app).toContain('cloudAuth?.workspace?.role === "owner" || invite.role === "member"');
  expect(app).toContain("Resend");
  expect(app).toContain("Revoke");
});

test("Cloud Delete requires edit permission for every selected profile", () => {
  expect(app).toContain('const selectedEditable = [...selected].every((id) => profiles.find((profile) => profile.id === id)?.permission === "edit");');
  expect(app).toContain('{(!isCloudMode || selectedEditable) && (');
  expect(app).toContain('<button className="btn danger tip" data-tip="Delete selected profiles" disabled={!selected.size} onClick={deleteSelected}>');
  expect(app).toContain('r.failed?.length && `${r.failed.length} failed: ${r.failed.join(", ")}`');
});

test("the roster numbers every profile and prefers a custom NO. over the serial", () => {
  // Mirrors profileDisplayNo in launcher.ts so the row, the browser window title
  // and the identity bookmark all show the same number.
  expect(app).toContain("function displayNo(profile: UiProfile, fallbackIndex: number)");
  expect(app).toContain('const custom = (profile.customNo ?? "").trim();');
  expect(app).toContain("if (custom) return { value: custom, custom: true };");
  expect(app).toContain("if (profile.serial != null) return { value: String(profile.serial), custom: false };");
  // Numbering is resolved against the unsorted roster, so sorting cannot renumber rows.
  expect(app).toContain("profiles.forEach((profile, index) => map.set(profile.id, displayNo(profile, index)));");
  expect(app).toContain('className={`no-text${no.custom ? " custom" : ""}`}');
  // The number stands alone — the colored identity disc was removed on request.
  expect(app).not.toContain("ProfileAvatar");
  expect(styles).not.toContain(".no-avatar");
});

test("the custom NO. editor is Local-only and digits-only", () => {
  expect(app).toContain("const MAX_CUSTOM_NO = 12;"); // matches MAX_CUSTOM_NO_LENGTH in parse.ts
  expect(app).toContain("<span>Custom NO.</span>");
  expect(app).toContain("<small>Digits only · blank uses the serial</small>");
  // The placeholder shows the serial that would be used instead, so an empty
  // field is never ambiguous about what the browser window will display.
  expect(app).toContain('placeholder={editSerial != null ? String(editSerial) : "auto"}');
  expect(app).toContain('setEF("customNo", e.target.value.replace(/\\D/g, "").slice(0, MAX_CUSTOM_NO))');
  // Cloud profiles round-trip through the portable-profile contract, which has
  // no custom NO. field — so it is never offered or sent in Cloud mode.
  expect(app).toContain('...(!isCloudMode ? { extensions: editExts, customNo: editForm.customNo ?? "" } : {}),');
  expect(app).toContain('...(isCloudMode ? {} : { customNo: form.customNo }),');
});

test("the roster is sortable, pageable and its columns are selectable", () => {
  expect(app).toContain("const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: \"no\", dir: 1 });");
  expect(app).toContain("current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: 1 }");
  // A running browser is the row an operator acts on next, so it outranks the sort column.
  expect(app).toContain("if (a.running !== b.running) return a.running ? -1 : 1;");
  expect(app).toContain('aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}');
  expect(app).toContain('aria-label="Choose visible columns"');
  expect(app).toContain('aria-label="Rows per page"');
  expect(app).toContain("const PAGE_SIZES = [25, 50, 100, 200];");
  expect(app).toContain('const DEFAULT_HIDDEN_COLUMNS: ColumnKey[] = ["tags"];');
  // Layout preferences are a convenience; disabled storage must not break the roster.
  expect(app).toContain("catch { return new Set(DEFAULT_HIDDEN_COLUMNS); }");
  expect(app).toContain("catch { /* private mode / disabled storage */ }");
});

test("header controls stay reachable and dismissable", () => {
  expect(app).toContain("function useDismiss<T extends HTMLElement>(open: boolean, close: () => void)");
  expect(app).toContain('document.addEventListener("mousedown", onDown);');
  expect(app).toContain('if (event.key === "Escape") onClose.current();');
  expect(app).toContain('aria-label="Refresh profiles"');
  expect(app).toContain('aria-label="Automation node freshness"');
  expect(app).toContain('aria-label="Open Account and Settings"');
});

test("the dashboard typeface is bundled, never fetched at runtime", () => {
  // AliasMode is local-first and must render correctly with no network, so the
  // face ships with the app. A CDN @import or an https font URL is a regression.
  expect(styles).toContain('src: url("./fonts/inter-latin.woff2") format("woff2")');
  expect(styles).toContain('src: url("./fonts/inter-latin-ext.woff2") format("woff2")');
  expect(styles).not.toContain("fonts.googleapis.com");
  expect(styles).not.toContain("fonts.gstatic.com");
  expect(styles).not.toMatch(/@import\s+url\(/);

  for (const file of ["inter-latin.woff2", "inter-latin-ext.woff2"]) {
    const bytes = readFileSync(join(import.meta.dir, "web", "fonts", file));
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2"); // real woff2, not an error page
  }

  // One variable file per subset covers every weight the UI asks for.
  expect(styles).toContain("font-weight: 100 900;");
  expect(styles).toContain("font-display: swap;");
  // Splitting by unicode-range keeps a latin-only roster off the larger subset.
  expect(styles.match(/unicode-range:/g)?.length).toBe(2);

  // SIL OFL requires the license to travel with the font.
  const license = readFileSync(join(import.meta.dir, "web", "fonts", "Inter-LICENSE.txt"), "utf8");
  expect(license).toContain("SIL OPEN FONT LICENSE");
  expect(notice).toContain("Inter typeface");
});

test("New profile and Edit are instant dialogs; only Settings and Extensions are pages", () => {
  expect(app).toContain('useState<"profiles" | "settings" | "extensions">("profiles")');
  expect(app).toContain("const [showCreate, setShowCreate] = useState(false);");
  expect(app).toContain('aria-labelledby="create-profile-title"');
  expect(app).toContain('aria-labelledby="edit-profile-title"');
  expect(app).toContain('const closeCreate = () => {\n    setShowCreate(false);');
  expect(app).toContain("PAGE_TITLES[view]");
  // Edit opens on the click — the detail fetch fills the dialog in when it
  // lands, and a stale response for an abandoned dialog is discarded.
  expect(app).toContain("editFetchId.current = id;");
  expect(app).toContain("if (editFetchId.current !== id) return;");
  expect(app).toContain('<p className="hint" role="status">Loading profile…</p>');
  expect(app).toContain("disabled={editSaving || editLoading}");
});

test("running profiles are editable, live-synced in Cloud mode", () => {
  // A Cloud profile open on THIS device is edited through the local cache; the
  // running session's checkpoint/close sync carries the change to Cloud.
  expect(app).toContain("const [editLive, setEditLive] = useState(false);");
  expect(app).toContain("setEditLive(p.liveEdit === true);");
  expect(app).toContain("isCloudMode && !editLive && editExpectedVersion === null");
  expect(app).toContain("isCloudMode && !editLive ? editExpectedVersion ?? undefined : undefined");
  expect(app).toContain("Changes save to this device now and sync to Cloud when it closes.");
  expect(app).toContain("Changes save now and apply the next time it launches.");
});

test("the sidebar collapses to an icon rail and remembers it", () => {
  expect(app).toContain('const SIDEBAR_KEY = "aliasmode.shell.sidebarCollapsed";');
  expect(app).toContain("function readSidebarCollapsed(): boolean {");
  expect(app).toContain('writeSetting(SIDEBAR_KEY, collapsed ? "0" : "1")');
  expect(app).toContain('aria-expanded={!sidebarCollapsed}');
  expect(app).toContain('data-tip={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}');
  // Labels must be elements, not bare text, or they cannot be hidden on the rail.
  expect(app).toContain('<Icon name="plus" /><span className="navlabel">New Profile</span>');
  expect(app).toContain('<Icon name="profiles" /><span className="navlabel">All profiles</span>');
  expect(styles).toContain(".sidebar.collapsed");
  expect(styles).toContain(".rail-toggle");
  // Every rail item needs a hover label once its text is gone.
  expect(app).toContain('data-tip="All profiles"');
  expect(app).toContain('data-tip="Settings"');
});

test("roster columns declare their own width and never collapse", () => {
  // One registry drives the header cells and the table's min-width, so a column
  // cannot be squeezed below a readable size.
  expect(app).toContain('{ key: "name", label: "Name", sort: true, width: 220 }');
  expect(app).toContain("const CHECKBOX_COLUMN_WIDTH = 44;");
  expect(app).toContain("const tableMinWidth = CHECKBOX_COLUMN_WIDTH + shownColumns.reduce((total, column) => total + column.width, 0);");
  expect(app).toContain('style={{ minWidth: tableMinWidth }}');
  // Every column declares a width, so a wide window's extra space spreads
  // proportionally across all of them — no single column hoards it.
  expect(app).toContain("const style = { width: column.width } as CSSProperties;");
  // The Action column shows no header text — its buttons explain themselves.
  expect(app).toContain('const label = column.key === "action" ? ""');
  // Widths live in the registry only — a stray CSS width would silently win.
  expect(styles).not.toMatch(/th\.col-\w+, td\.col-\w+ \{ width:/);
  expect(styles).toContain("table-layout: fixed");
  expect(styles).toContain(".tablewrap { flex: 1; min-height: 0; overflow: auto; }");
});

test("the roster keeps only the columns that matter and stays compact", () => {
  // Health, Created and Last opened were removed on request; what is left is
  // identity, grouping, connectivity — and the one button every row needs.
  for (const key of ["health", "created", "opened"]) {
    expect(app).not.toContain(`key: "${key}"`);
  }
  expect(app).toContain('{ key: "proxy", label: "Proxy", sort: true, width: 160 }');
  expect(app).toContain('{ key: "action", label: "Action", sort: false, width: 230 }');
  expect(app).not.toContain("healthFilter");
});

test("every row action sits beside Open in the Action cell — nothing hides on hover", () => {
  expect(app).toContain('<span className="rowactions">');
  expect(app).toContain('aria-label={`Open ${p.name}`}');
  expect(app).toContain('aria-label={`Close ${p.name}`}');
  expect(app).toContain('aria-label={`Edit ${p.name}`}');
  expect(app).toContain('aria-label="Copy current 2FA code"');
  // The hover-revealed overlay is gone: it overlapped the profile name.
  expect(app).not.toContain("rowquick");
  expect(styles).not.toContain(".rowquick");
  expect(styles).toContain(".rowactions { display: inline-flex; align-items: center; justify-content: flex-end;");
});

test("the Action column stays reachable while the roster scrolls sideways", () => {
  expect(styles).toContain("position: sticky; right: 0;");
  // A sticky cell has no row behind it, so every row state repaints its own.
  expect(styles).toContain(".profile-table tbody tr.selected td.col-action { background: var(--accent-soft); }");
  expect(styles).toContain(".profile-table thead th.col-action { z-index: 3; background: var(--surface-sunken); }");
  // The edge shadow only appears once there is content underneath it.
  expect(app).toContain("onScroll={(event) => setTableScrolled(event.currentTarget.scrollLeft > 0)}");
  expect(styles).toContain(".tablewrap.scrolled td.col-action::before");
});

test("small windows keep navigation and dialogs keep typed input", () => {
  // Below the rail breakpoint the sidebar becomes the icon rail instead of
  // disappearing — a resizable desktop app must never lose its navigation.
  expect(app).toContain('const RAIL_MEDIA = "(max-width: 760px)";');
  expect(app).toContain("sidebarCollapsed || railForced");
  expect(styles).not.toContain(".sidebar { display: none; }");
  // On a big monitor the WHOLE shell caps and centers as one frame — sidebar,
  // header and roster together — a six-column app cannot fill 2500px gracefully.
  expect(styles).toContain("max-width: 1704px; margin: 0 auto;");
  expect(styles).toContain("width: min(1440px, 100% - 32px);");
  // Escape closes the open dialog; a stray backdrop click never discards a form.
  expect(app).toContain('if (event.key !== "Escape") return;');
  expect(app).not.toContain('className="modal-backdrop" onClick={closeCreate}');
  expect(app).not.toContain('className="modal-backdrop" onClick={closeEdit}');
  expect(app).not.toContain('className="modal-backdrop" onClick={closeBulk}');
});

test("import offers one source at a time and counts what was pasted", () => {
  // Two full-height inputs stacked left it ambiguous which one Import would read.
  expect(app).toContain('const [bulkSource, setBulkSource] = useState<"file" | "paste">("file");');
  expect(app).toContain('aria-label="Import source"');
  // Switching sources clears the other, so a stale value cannot be submitted.
  expect(app).toContain('onClick={() => { setBulkSource("file"); setBulkText(""); }}');
  expect(app).toContain('onClick={() => { setBulkSource("paste"); setBulkFiles([]); }}');
  // Every AdsPower record opens with its own id= line, so this count is exact.
  expect(app).toContain("function countPastedRecords(text: string): number {");
  expect(app).toContain('return (text.match(/^id=/gm) ?? []).length;');
  expect(app).toContain("} detected — each one starts with its own id= line.");
  // Chosen files are individually removable rather than a comma-joined string.
  expect(app).toContain('aria-label={`Remove ${file.name}`}');
  expect(app).toContain(">Clear all</button>");
  expect(styles).toContain(".filechip");
  expect(styles).toContain(".segmented");
});

test("no legacy arrow glyphs survive in place of icons", () => {
  // These predate the icon set; a stray one means a control was missed.
  for (const glyph of ["⤓", "⤒", "↩", "🧩", "📄", "▸", "▾"]) {
    expect(app).not.toContain(glyph);
  }
});

test("the second accent marks identity, and the credit matches the website", () => {
  // Two accents only work if each means something: the live build's brand blue
  // (#3366e6) marks actions, peach marks identity. A peach button or a blue
  // custom NO. would break that split.
  expect(styles).toContain("--accent: #3366e6;");
  expect(styles).toContain("--accent-2: #ff9e7a;");
  expect(styles).toContain("td.col-no .no-text.custom { color: var(--accent-2-ink); }");
  expect(styles).toContain("linear-gradient(150deg, var(--accent), var(--accent-2))");
  expect(styles).not.toMatch(/\.btn\.primary \{[^}]*--accent-2/);
  // The accent is the logo's blue, and no trace of the old violet survives.
  expect(logo).toContain('stroke="#2457D6"');
  expect(styles).not.toContain("#6d4aff");
  expect(styles).not.toContain("#8b6dff");

  // aliasmode.com credits "Developed by Xreacher" — not "Powered by" — and the
  // name links to its owner, not back to the product it credits.
  expect(app).toContain("Developed by");
  expect(app).toContain('<a href="https://xreacher.com/" target="_blank" rel="noreferrer" title="xreacher.com">Xreacher</a>');
  expect(app).not.toContain('className="watermark" href="https://aliasmode.com/"');
  expect(styles).toContain(".watermark");
  // The site paints its footer wordmark as a clipped gradient, not flat text.
  expect(app).toContain('<p className="footer-mark" aria-hidden="true">AliasMode</p>');
  expect(styles).toContain("-webkit-background-clip: text; background-clip: text; color: transparent;");
  // It is a credit, not a control: it must not survive into the icon rail.
  expect(styles).toContain(".sidebar.collapsed .sidecredit { display: none; }");
});

test("the project links match the site footer and this repository", () => {
  // The GitHub URL is this repo's own origin — the two cannot drift apart.
  expect(app).toContain('href: "https://github.com/aliasmode/aliasmode"');
  expect(app).toContain('href: "https://t.me/aliasmode"');
  // Outbound links from a desktop shell must not hand the opener over.
  const links = app.slice(app.indexOf("const PROJECT_LINKS"), app.indexOf("] as const;", app.indexOf("const PROJECT_LINKS")));
  expect(links).toContain("github.com");
  expect(links).toContain("t.me");
  expect(app).toContain('aria-label={`AliasMode on ${link.label}`}');
  expect(styles).toContain(".projectlink");
});

test("Extensions is a page, consistent with the rest of the shell", () => {
  // It was the last modal among pages, and opening it from Settings stacked a
  // dialog over a page.
  expect(app).toContain('setView("extensions")');
  expect(app).not.toContain("showExts");
  expect(app).toContain('view === "extensions" ? (');
  expect(app).toContain('className={`navitem${view === "extensions" ? " active" : ""}`}');
  expect(app).toContain('extensions: "Extensions",');
});

test("the dark theme is a token swap, and native controls follow it", () => {
  expect(styles).toContain(':root[data-theme="dark"] {');
  // Without color-scheme the browser keeps painting checkboxes and scrollbars light.
  expect(styles).toContain("color-scheme: dark;");
  expect(styles).toContain("color-scheme: light;");
  // Nothing may hardcode a light surface, or it survives into the dark theme —
  // this is exactly how the modal header stayed white.
  const rules = styles.slice(styles.indexOf("\n}", styles.indexOf(":root {")));
  expect(rules).not.toContain("linear-gradient(180deg, #ffffff");
  expect(rules).not.toMatch(/background: #fff/);
  // Two near-black brand tiles would vanish on a dark row.
  expect(styles).toContain(':root[data-theme="dark"] .platform-pill .glyph.pm-x');
  // Light is the out-of-the-box default; Dark and follow-the-OS System are
  // opt-in from Settings. A host-only cookie survives the desktop app's changing port.
  expect(app).toContain('import { THEME_KEY, readThemeChoice, themeCookie, type ThemeChoice } from "./theme.ts";');
  expect(app).toContain("return readThemeChoice(cookies, stored);");
  expect(app).toContain("document.cookie = themeCookie(choice);");
  // The app resolves "system" itself rather than duplicating the palette.
  expect(app).toContain('window.matchMedia("(prefers-color-scheme: dark)")');
  expect(app).toContain("document.documentElement.dataset.theme =");
  expect(app).toContain('media.addEventListener("change", apply)');
});

test("the sidebar offers extension management in both modes and a support link", () => {
  // The extension registry is local in both modes; Cloud profiles carry their
  // assignments and load matching local uploads at launch.
  expect(app).toContain('<Icon name="puzzle" /><span className="navlabel">Manage extensions</span>');
  const nav = app.slice(app.indexOf('className="sidenav"'), app.indexOf("</nav>"));
  expect(nav).not.toContain("isCloudMode");
  // Small support entry that forwards to the Telegram group.
  expect(app).toContain('href="https://t.me/aliasmode"');
  expect(app).toContain('<Icon name="help" /><span className="navlabel">Support</span>');
  expect(styles).toContain("a.navitem");
});

test("editable Cloud selections expose every profile export format", () => {
  const toolbar = app.slice(app.indexOf('className="toolbar active"'), app.indexOf("className={`tablewrap"));
  expect(toolbar).toContain("(!isCloudMode || selectedEditable) && <>");
  // Export is deliberately NOT Local-gated (the Cloud editor decrypts the
  // selected profiles server-side); Convert and Edit-from-file remain Local.
  expect(toolbar).not.toContain("{!isCloudMode && <>");
  expect(toolbar).toContain("!isCloudMode && selectedMobileCount > 0");
  for (const format of ["csv", "txt", "xlsx"]) expect(toolbar).toContain(`exportSelected("${format}")`);
});

test("the existing Extensions page installs from a Web Store URL and keeps archive upload", () => {
  expect(app).toContain("Install from Chrome Web Store");
  expect(app).toContain('aria-label="Chrome Web Store URL or extension ID"');
  expect(app).toContain("installWebStoreExtension(source)");
  expect(app).toContain("The in-browser Store button does not work in CloakBrowser");
  expect(app).toContain("Edit &gt; Extensions");
  expect(app).toContain("Upload ZIP/CRX");
  expect(app).toContain('accept=".zip,.crx,application/zip,application/x-chrome-extension"');
  expect(app).not.toContain("Chrome Web Store installs are not supported in AliasMode");
  expect(app.match(/setView\("extensions"\)/g)).toHaveLength(1);
});

test("Settings carries the Remote MCP connector card in Cloud mode", () => {
  expect(app).toContain('className="settings-card remote-mcp-settings"');
  expect(app).toContain("MCP server URL");
  expect(app).toContain('aria-label="Remote MCP access key"');
  // Leaving the account (sign out, forget session) always revokes and forgets
  // the connector so a stale key cannot outlive the session that made it.
  expect(app).toContain("prepareRemoteMcpForAccountExit");
  expect(app).toContain("deleteDesktopRemoteMcpCredential");
  expect(styles).toContain(".remote-mcp-value");
});

test("the update banner shows release highlights and native install progress", () => {
  expect(app).toContain("<UpdateHighlights version={desktopUpdate.version} highlights={desktopUpdate.highlights} />");
  expect(app).toContain("function DesktopUpdateProgressView(");
  expect(app).toContain('invoke("update_now", { onProgress })');
  expect(styles).toContain(".update-progress progress");
});
