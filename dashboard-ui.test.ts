import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(import.meta.dir, "web", "app.tsx"), "utf8").replaceAll("\r\n", "\n");
const styles = readFileSync(join(import.meta.dir, "web", "styles.css"), "utf8").replaceAll("\r\n", "\n");
const logo = readFileSync(join(import.meta.dir, "web", "alias-loop.svg"), "utf8").replaceAll("\r\n", "\n");
const notice = readFileSync(join(import.meta.dir, "NOTICE"), "utf8");

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

test("dashboard checks and installs desktop updates through argument-free native commands", () => {
  expect(app).toContain('type DesktopUpdateStatus =');
  expect(app).toContain('invoke("check_for_updates")');
  expect(app).toContain('invoke("update_now")');
  expect(app).not.toContain('invoke("check_for_updates",');
  expect(app).not.toContain('invoke("update_now",');
  expect(app).toContain("desktopUpdateCheckStarted.current = true");
  expect(app).toContain("AliasMode checks for updates when it starts.");
  expect(app).toContain("Downloading and verifying the update");
  expect(app).toContain('disabled={modeBusy || desktopUpdateInstalling}');
  expect(app).toContain('className="update-banner" role="status"');
  expect(styles).toContain(".update-banner");
  expect(styles).toContain(".update-actions");
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
  expect(styles).toContain("td.col-no, td.col-name, td.col-group, td.col-tags, td.col-proxy, td.col-created, td.col-opened { overflow: hidden; text-overflow: ellipsis; }");
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

test("running profile rows expose Bring to front in Local and Cloud mode", () => {
  expect(app).toContain('p.running ? (');
  expect(app).toContain('data-tip="Bring to front"');
  expect(app).toContain('aria-label="Bring this browser window to the front"');
  expect(app).toContain('onClick={() => act(p.id, raiseProfile)}');
  // The running-row branch must stay mode-agnostic: raising a window is a local
  // action on a browser this machine already opened, in Cloud mode too.
  const runningBranch = app.slice(app.indexOf("p.running ? ("), app.indexOf(") : p.mobilePersona ? ("));
  expect(runningBranch).toContain("Bring to front");
  expect(runningBranch).not.toContain("isCloudMode");
});

test("Cloud rows expose Edit and Convert device only with effective Edit permission", () => {
  expect(app).toContain('(p.permission === "edit" && !p.running && !p.lockedBy)');
  expect(app).toContain('(!isCloudMode || p.permission === "edit")');
  expect(app).toContain('<button className="btn sm warn"');
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
  expect(app).toContain("<ProfileAvatar profile={p} no={no.value} />");
  expect(app).toContain('className={`no-text${no.custom ? " custom" : ""}`}');
  expect(styles).toContain(".no-avatar");
});

test("the custom NO. editor is Local-only, digits-only and previews the window title", () => {
  expect(app).toContain("const MAX_CUSTOM_NO = 12;"); // matches MAX_CUSTOM_NO_LENGTH in parse.ts
  expect(app).toContain("<span>Custom NO.</span>");
  expect(app).toContain("<small>Digits only · blank uses the serial</small>");
  // The placeholder shows the serial that would be used instead, so an empty
  // field is never ambiguous about what the browser window will display.
  expect(app).toContain('placeholder={editSerial != null ? String(editSerial) : "auto"}');
  expect(app).toContain('setEF("customNo", e.target.value.replace(/\\D/g, "").slice(0, MAX_CUSTOM_NO))');
  expect(app).toContain('Browser window and bookmark show');
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

test("New profile and Edit are pages, not dialogs", () => {
  expect(app).toContain('useState<"profiles" | "settings" | "extensions" | "create" | "edit">("profiles")');
  // Both entry points navigate; neither opens a modal any more.
  expect(app).toContain('setView("create")');
  expect(app).toContain('setView("edit")');
  expect(app).not.toContain("setShowCreate");
  expect(app).toContain("const isCreateView = view === \"create\";");
  expect(app).toContain("const isFormView = view === \"create\" || view === \"edit\";");
  // Cancel, Back and a completed save all return to the roster.
  expect(app).toContain('const closeCreate = () => {\n    setView("profiles");');
  expect(app).toContain('const closeEdit = () => { setView("profiles");');
  expect(app).toContain("PAGE_TITLES[view]");
});

test("the profile form tabs are a scroll-spy over one scrolling page", () => {
  // Sections live in a single scroll container; the tabs mark position in it
  // rather than swapping panes, so scrolling and clicking both work.
  expect(app).toContain('<div className="formpage" ref={formBodyRef} onScroll={syncActiveSection}>');
  expect(app).toContain("const syncActiveSection = () => {");
  expect(app).toContain("if (element && element.getBoundingClientRect().top <= threshold) current = section.key;");
  expect(app).toContain('?.scrollIntoView({ behavior: "smooth", block: "start" })');
  expect(app).toContain('aria-selected={activeSection === section.key}');
  for (const id of ["form-general", "form-proxy", "form-credentials", "form-fingerprint", "form-extensions"]) {
    expect(app).toContain(`id="${id}"`);
  }
  // Credentials and Extensions only exist when editing / in Local mode, so the
  // strip must be built from the same condition the sections are.
  expect(app).toContain("...(!isCreateView && !isCloudMode ? [{ key: \"extensions\", label: \"Extensions\" }] : [])");
  expect(styles).toContain("scroll-margin-top");
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
  expect(app).toContain("const style = { width: column.width } as CSSProperties;");
  // Widths live in the registry only — a stray CSS width would silently win.
  expect(styles).not.toMatch(/th\.col-\w+, td\.col-\w+ \{ width:/);
  expect(styles).toContain("table-layout: fixed");
  expect(styles).toContain(".tablewrap { flex: 1; min-height: 0; overflow: auto; }");
});

test("the roster shows when a profile was created and last opened", () => {
  expect(app).toContain('{ key: "created", label: "Created", sort: true, width: 116 }');
  expect(app).toContain('{ key: "opened", label: "Last opened", sort: true, width: 132 }');
  expect(app).toContain('case "created": return p.createdAt ?? 0;');
  expect(app).toContain('case "opened": return p.lastOpenAt ?? 0;');
  // 0 means "the store never recorded it", which is not 1970 and not "never
  // opened" either — each renders its own way, with the exact time on hover.
  expect(app).toContain('if (!ms) return "—";');
  expect(app).toContain('title={p.lastOpenAt ? fullStamp(p.lastOpenAt) : "Never opened on this machine"}');
  expect(app).toContain('<span className="muted">Never</span>');
});

test("the Action column stays reachable while the roster scrolls sideways", () => {
  expect(styles).toContain("position: sticky; right: 0;");
  // A sticky cell has no row behind it, so every row state repaints its own.
  expect(styles).toContain(".profile-table tbody tr.selected td.col-action { background: var(--accent-soft); }");
  expect(styles).toContain(".profile-table thead th.col-action { z-index: 3; background: var(--surface-sunken); }");
  // The edge shadow only appears once there is content underneath it.
  expect(app).toContain("onScroll={(event) => setTableScrolled(event.currentTarget.scrollLeft > 0)}");
  expect(styles).toContain(".tablewrap.scrolled td.col-action::before");
  // Action is toggleable like any other column.
  expect(app).toContain('{ key: "action", label: "Action", sort: false, width: 160 }');
  expect(app).toContain('{columnVisible("action") && (');
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
  // Two accents only work if each means something: blue = actions, violet =
  // identity. A violet button or a blue custom NO. would break that split.
  // Both accents come from the site's own tokens, not invented values.
  expect(styles).toContain("--accent: #6d4aff;");
  expect(styles).toContain("--accent-2: #ff9e7a;");
  expect(styles).toContain(".no-cell .no-text.custom { color: var(--accent-2-ink); }");
  expect(styles).toContain("linear-gradient(150deg, var(--accent), var(--accent-2))");
  expect(styles).not.toMatch(/\.btn\.primary \{[^}]*--accent-2/);

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
  // Disc colours live in CSS so they can inverse for dark rows.
  expect(app).toContain("const AVATAR_HUES = 14;");
  expect(app).toContain("data-hue={avatarHue(profile.id)}");
  expect(styles).toContain(':root[data-theme="dark"] .no-avatar[data-hue="0"]');
  // The app resolves "system" itself rather than duplicating the palette.
  expect(app).toContain('window.matchMedia("(prefers-color-scheme: dark)")');
  expect(app).toContain("document.documentElement.dataset.theme =");
  expect(app).toContain('media.addEventListener("change", apply)');
});
