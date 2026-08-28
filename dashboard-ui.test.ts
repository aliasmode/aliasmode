import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(import.meta.dir, "web", "app.tsx"), "utf8").replaceAll("\r\n", "\n");
const styles = readFileSync(join(import.meta.dir, "web", "styles.css"), "utf8").replaceAll("\r\n", "\n");
const logo = readFileSync(join(import.meta.dir, "web", "alias-loop.svg"), "utf8").replaceAll("\r\n", "\n");

test("dashboard packages the approved Alias Loop logo", () => {
  expect(app).toContain('import aliasLoopUrl from "./alias-loop.svg"');
  expect(app).toContain('<img src={aliasLoopUrl} alt="" />AliasMode');
  expect(styles).not.toContain(".brand::before");
  expect(logo).toContain('stroke="#111827"');
  expect(logo).toContain('stroke="#2457D6"');
  expect(logo).toContain('d="M152 96H320C380 96 416 136 416 196V316C416 376 376 416 316 416H196C136 416 96 376 96 316V288"');
  expect(logo).toContain('d="M96 288C96 240 136 208 184 208H280"');
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
  expect(app).toContain("Installing and restarting…");
  expect(app).toContain('disabled={modeBusy || desktopUpdateInstalling}');
  expect(app).toContain('className="update-banner"');
  expect(styles).toContain(".update-banner");
  expect(styles).toContain(".update-highlights");
  expect(styles).toContain(".update-progress progress");
  expect(styles).toContain("accent-color: var(--accent)");
});

test("dashboard contains long roster labels inside the window", () => {
  expect(app).toContain('className="profile-table"');
  expect(app).toContain('className="profile-name" title={p.name}');
  expect(app).toContain('className="profile-group" title={p.group}');
  expect(app).toContain('className="move-group"');
  expect(styles).toContain("table-layout: fixed");
  expect(styles).toContain("overflow-x: hidden");
  expect(styles).toContain("text-overflow: ellipsis");
});

test("Account settings offers fenced Cloud sign-out and clears account state", () => {
  expect(app).toContain('"Sign out / Switch account"');
  expect(app).toContain("await signOutCloud();");
  expect(app).toContain("authGeneration.current++;");
  expect(app).toContain("setCloudAuth({ authenticated: false });");
  expect(app).toContain("setProfiles([]);");
  expect(app).toContain("setTeam(null);");
  expect(app).toContain("generation !== authGeneration.current");
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
  expect(app).toContain('if (!showAccount || !isCloudMode || !workspaceReady || restartRequired) return;');
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
  expect(app).toContain("They exclude profile data and credentials");
  expect(styles).toContain(".diagnostics-list");
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
  expect(app).toContain('p.running ? (');
  expect(app).toContain('className="btn raise"');
  expect(app).toContain('onClick={() => act(p.id, raiseProfile)}>Bring to front</button>');
  expect(app).not.toContain('!isCloudMode && <button className="btn raise"');
});

test("Cloud rows expose Edit and Convert device only with effective Edit permission", () => {
  expect(app).toContain('(p.permission === "edit" && !p.running && !p.lockedBy)');
  expect(app).toContain('(!isCloudMode || p.permission === "edit") ? <button className="btn convert"');
  expect(app).toContain("setEditExpectedVersion(p.expectedVersion ?? null)");
  expect(app).toContain("isCloudMode ? editExpectedVersion ?? undefined : undefined");
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
  expect(app).toContain('<button className="importbtn" disabled={!canEditCloud}');
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
  expect(app).toContain('{isCloudMode ? "+ New folder" : "+ New group"}');
  expect(app).toContain('if (name === "all") {');
  expect(app).toContain('cloudWorkspaceAction("delete-folder", { name: g })');
  expect(app).toContain("!isCloudMode || canManageCloudFolders");
  expect(styles).toContain(".newgroup");
});

test("Team settings guide invitations and explicit folder access", () => {
  for (const heading of ["Your folder access", "Members", "Invitations", "Join another workspace"]) expect(app).toContain(`>${heading}</h3>`);
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
  expect(app).toContain('{(!isCloudMode || selectedEditable) && <button className="abtn danger" disabled={!selected.size} onClick={deleteSelected}>Delete</button>}');
  expect(app).toContain('r.failed?.length && `${r.failed.length} failed: ${r.failed.join(", ")}`');
});

test("editable Cloud selections expose every profile export format", () => {
  const actionbar = app.slice(app.indexOf('className={`actionbar'), app.indexOf('className="tablewrap"'));
  expect(actionbar).toContain('(!isCloudMode || selectedEditable) && <>');
  expect(actionbar).not.toContain('{!isCloudMode && <>');
  expect(actionbar).toContain('!isCloudMode && selectedMobileCount > 0');
  expect(actionbar).toContain('!isCloudMode && <button className="abtn" disabled={!selected.size} onClick={openUpdate}');
  for (const format of ["csv", "txt", "xlsx"]) expect(actionbar).toContain(`exportSelected("${format}")`);
});

test("Local extension manager explains the supported ZIP/CRX workflow", () => {
  expect(app).toContain('{!isCloudMode && <button className="extbtn"');
  expect(app).toContain("Chrome Web Store installs are not supported");
  expect(app).toContain("Switch to Chrome to install extensions and themes");
  expect(app).toContain("Close the target profile");
  expect(app).toContain("Edit &gt; Extensions");
  expect(app).toContain("+ Upload ZIP/CRX");
  expect(app).toContain('accept=".zip,.crx,application/zip,application/x-chrome-extension"');
});
