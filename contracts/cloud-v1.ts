export const CLOUD_API_VERSION = 1 as const;
export const CLOUD_API_BASE_PATH = "/v1" as const;
export const MCP_TUNNEL_PROTOCOL = "aliasmode-mcp-tunnel-v1" as const;

export type McpTunnelToDevice =
  | { protocol: typeof MCP_TUNNEL_PROTOCOL; type: "open"; sessionId: string }
  | { protocol: typeof MCP_TUNNEL_PROTOCOL; type: "message"; sessionId: string; payload: unknown }
  | { protocol: typeof MCP_TUNNEL_PROTOCOL; type: "close"; sessionId: string };

export type McpTunnelToCloud =
  | { protocol: typeof MCP_TUNNEL_PROTOCOL; type: "message"; sessionId: string; payload: unknown }
  | { protocol: typeof MCP_TUNNEL_PROTOCOL; type: "closed"; sessionId: string }
  | { protocol: typeof MCP_TUNNEL_PROTOCOL; type: "error"; sessionId: string; code: string; message: string };

export type WorkspaceRole = "owner" | "admin" | "member";
export type FolderPermission = "view" | "edit";
export type OpenSessionStatus = "open" | "accepted" | "stale" | "abandoned";
export type PendingSyncStatus = "pending" | "retrying" | "conflict";

export type CloudErrorCode =
  | "authentication_required"
  | "email_not_verified"
  | "legal_acceptance_required"
  | "device_revoked"
  | "membership_revoked"
  | "workspace_conflict"
  | "folder_access_denied"
  | "invitation_invalid"
  | "profile_not_found"
  | "script_not_found"
  | "profile_trashed"
  | "profile_open"
  | "version_conflict"
  | "validation_failed"
  | "rate_limited"
  | "insufficient_balance"
  | "deposit_amount_out_of_range"
  | "owner_only"
  | "partner_unavailable"
  | "partner_rejected"
  | "record_not_found"
  | "internal_error";

export interface CloudError {
  ok: false;
  error: {
    code: CloudErrorCode;
    message: string;
    currentVersion?: number;
  };
}

export interface LegalVersions {
  terms: string;
  privacy: string;
  acceptableUse: string;
}

export interface LegalAcceptance extends LegalVersions {
  acceptedAt: number;
}

export interface CloudAccount {
  id: string;
  email: string;
  emailVerified: boolean;
}

export interface CloudWorkspace {
  id: string;
  ownerAccountId: string;
  name: string;
  role: WorkspaceRole;
}

export interface CloudFolder {
  name: string;
  parentName?: string | null;
  label?: string;
  archivedAt: number | null;
  permission: FolderPermission;
  extensionDefaults: string[];
}

export interface CloudFolderGrant {
  folderName: string;
  accountId: string;
  permission: FolderPermission;
}

export interface CloudProfileGrant {
  profileId: string;
  accountId: string;
  permission: FolderPermission;
}

export interface CloudInvitation {
  id: string;
  email: string;
  role: "admin" | "member";
  expiresAt: number;
  acceptedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

export interface CloudMember {
  accountId: string;
  email: string;
  role: WorkspaceRole;
  joinedAt: number;
  grants: CloudFolderGrant[];
  profileGrants?: CloudProfileGrant[];
}

export interface CloudDevice {
  id: string;
  label: string;
  platform: "windows" | "macos" | "linux";
  appVersion: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
  current: boolean;
}

export interface CloudMcpConnector {
  id: string;
  deviceId: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface CreateMcpConnectorRequest {
  label: string;
}

export interface CreateMcpConnectorResponse {
  ok: true;
  connector: CloudMcpConnector;
  token: string;
}

export interface ListMcpConnectorsResponse {
  ok: true;
  connectors: CloudMcpConnector[];
}

export interface CloudCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  partitionKey?: string;
  _crHasCrossSiteAncestor?: boolean;
}

export interface CloudOriginStorage {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
  indexedDB?: unknown[];
}

export interface PortableSessionV1 {
  cookies: CloudCookie[];
  origins?: CloudOriginStorage[];
  /** Ordered normal web tabs. Duplicates are intentional. */
  tabs?: string[];
  telegramClient?: "a" | "k";
}

export interface CloudProxy {
  type: "http" | "https" | "socks5";
  host: string;
  port: string;
  user: string;
  pass: string;
}

export interface CloudProxyInventoryProfile {
  id: string;
  name: string;
  group: string;
  version: number;
  permission: FolderPermission;
  proxy: CloudProxy | null;
  proxyError?: string;
  activeOpens: CloudOpenWarning[];
}

export interface ListProfileProxiesResponse {
  ok: true;
  profiles: CloudProxyInventoryProfile[];
}

export type ProxyReplacementSelector =
  | { profileId: string; username?: never }
  | { username: string; profileId?: never };

export type ProxyReplacementRequestRow = ProxyReplacementSelector & {
  proxy: CloudProxy;
  expectedVersion?: number;
};

export interface ProxyReplacementsRequest {
  dryRun: boolean;
  replacements: ProxyReplacementRequestRow[];
}

export type ProxyReplacementStatus = "ready" | "updated" | "unchanged" | "missing" | "skipped";

export type ProxyReplacementCode =
  | "invalid_row"
  | "invalid_proxy"
  | "expected_version_required"
  | "duplicate_selector"
  | "no_editable_match"
  | "ambiguous_username"
  | "duplicate_target"
  | "profile_trashed"
  | "profile_open"
  | "version_conflict";

export interface ProxyReplacementResult {
  index: number;
  status: ProxyReplacementStatus;
  code?: ProxyReplacementCode;
  profileId?: string;
  currentVersion?: number;
  previousVersion?: number;
  version?: number;
}

export interface ProxyReplacementsResponse {
  ok: true;
  dryRun: boolean;
  counts: {
    received: number;
    matched: number;
    ready: number;
    updated: number;
    unchanged: number;
    missing: number;
    skipped: number;
  };
  results: ProxyReplacementResult[];
  missingUsernames: string[];
}

/** Complete portable Chromium state. The server stores it only as an encrypted envelope. */
export interface PortableProfileV1 {
  schemaVersion: 1;
  profile: {
    id: string;
    accId: string;
    name: string;
    group: string;
    platform: string;
    username: string;
    password: string;
    email: string;
    emailPassword: string;
    twofa: string;
    proxy: CloudProxy | null;
    proxyError?: string;
    extensionAssignments: string[];
    tags: string[];
    ua: string;
    timezone: string;
    /** The user typed the timezone; launches keep it instead of the proxy's. Older clients ignore it. */
    timezoneManual?: true;
    locale?: string;
    screenWidth: number;
    screenHeight: number;
    fingerprintSeed: number;
    /** Explicit desktop platform; omitted when the profile predates the field. */
    platformOs?: string;
  };
  session: PortableSessionV1;
}

/** Recursive JSON data stored in a portable Camoufox configuration. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface FirefoxProfileConfig {
  version: 1;
  runtimeVersion: string;
  config: Record<string, JsonValue>;
}

/** Firefox portable state. V1 Chromium payloads remain unchanged. */
export interface PortableProfileV2 {
  schemaVersion: 2;
  profile: PortableProfileV1["profile"] & {
    engine: "firefox";
    firefox: FirefoxProfileConfig;
    /** Cores the user set. Older clients reject a profile that carries it. */
    hardware?: { cores: number };
  };
  session: PortableSessionV1;
}

/** Chromium on the opt-in AliasMode Chromium runtime. Older clients reject it instead of opening it on CloakBrowser. */
export interface PortableProfileV3 {
  schemaVersion: 3;
  profile: PortableProfileV1["profile"] & {
    chromiumRuntime: "aliasmode";
    /** Cores the user set. Older clients reject a profile that carries it. */
    hardware?: { cores: number };
    /** Windows display scale the pages draw at, fixed at the profile's first open (1.25 at 125%). */
    displayScale?: number;
  };
  session: PortableSessionV1;
}

/** CloakBrowser with stored hardware. Older clients reject it instead of opening it with the engine default and saving it without the hardware. */
export interface PortableProfileV4 {
  schemaVersion: 4;
  profile: PortableProfileV1["profile"] & {
    hardware: { cores: number };
  };
  session: PortableSessionV1;
}

export type PortableProfile = PortableProfileV1 | PortableProfileV2 | PortableProfileV3 | PortableProfileV4;

export interface CloudProfileSummary {
  id: string;
  name: string;
  group: string;
  platform: string;
  tags: string[];
  version: number;
  trashedAt: number | null;
  trashedBy: string | null;
  updatedAt: number;
  activeOpens: CloudOpenWarning[];
  permission: FolderPermission;
}

export interface CloudOpenWarning {
  registrationId: string;
  accountId: string;
  memberEmail: string;
  deviceId: string;
  deviceLabel: string;
  openedAt: number;
  heartbeatAt: number;
}

/** Another device's lease that lapsed without a close. Its session after `checkpointAt` is not in Cloud. */
export interface CloudLapsedOpen extends CloudOpenWarning {
  checkpointAt: number | null;
}

export interface CloudStatusResponse {
  ok: true;
  account: CloudAccount;
  workspace: CloudWorkspace;
  device: CloudDevice;
  legal: {
    current: LegalVersions;
    accepted: LegalAcceptance | null;
  };
}

export interface BootstrapRequest {
  device: {
    installationId: string;
    label: string;
    platform: CloudDevice["platform"];
    appVersion: string;
  };
}

export interface BootstrapResponse extends CloudStatusResponse {
  deviceCredential: string | null;
}

export interface AcceptLegalRequest {
  versions: LegalVersions;
}

export interface AcceptLegalResponse {
  ok: true;
  accepted: LegalVersions & { acceptedAt: number };
}

export interface AddMemberRequest {
  email: string;
}

export interface ListMembersResponse {
  ok: true;
  members: CloudMember[];
}

export interface UpdateMemberRoleRequest {
  role: "admin" | "member";
}

export interface RemoveMemberRequest {}

export interface ListFoldersResponse {
  ok: true;
  folders: CloudFolder[];
}

export interface CreateFolderRequest {
  name: string;
  parentName?: string | null;
}

export interface MoveFolderRequest {
  parentName: string | null;
}

export interface SetProfileGrantResponse {
  ok: true;
  grant: CloudProfileGrant;
}

export interface RenameFolderRequest {
  name: string;
}

export interface ArchiveFolderRequest {}

export interface SetFolderGrantRequest {
  permission: FolderPermission;
}

export interface SetFolderGrantResponse {
  ok: true;
  grant: CloudFolderGrant;
}

export interface SetFolderExtensionDefaultsRequest {
  extensionDefaults: string[];
}

export interface SetFolderExtensionDefaultsResponse {
  ok: true;
  folder: CloudFolder;
  updatedCount: number;
}

export interface MoveProfileRequest {
  expectedVersion: number;
  destination: string;
}

export interface CreateInvitationRequest {
  email: string;
  role: "admin" | "member";
}

export interface CreateInvitationResponse {
  ok: true;
  invitation: CloudInvitation;
}

export interface ListInvitationsResponse {
  ok: true;
  invitations: CloudInvitation[];
}

export interface ResendInvitationResponse {
  ok: true;
  invitation: CloudInvitation;
}

export interface AcceptInvitationRequest {
  code: string;
}

export interface ListProfilesResponse {
  ok: true;
  profiles: CloudProfileSummary[];
}

export interface CreateProfileRequest {
  migrationId?: string;
  payload: PortableProfile;
}

export interface CreateProfileResponse {
  ok: true;
  profile: CloudProfileSummary;
  payloadDigest: string;
}

export interface ImportProfilesRequest {
  destination: string;
  profiles: PortableProfile[];
}

export interface ImportProfilesResponse {
  ok: true;
  imported: number;
  ids: string[];
}

export interface GetProfileResponse {
  ok: true;
  profile: CloudProfileSummary;
  payload: PortableProfile;
  payloadDigest: string;
}

export interface UpdateProfileResponse {
  ok: true;
  profile: CloudProfileSummary;
  payloadDigest: string;
}

export interface UpdateProfileRequest {
  expectedVersion: number;
  payload: PortableProfile;
}

export interface OpenProfileRequest {
  deviceId: string;
}

export interface OpenProfileResponse {
  ok: true;
  registrationId: string;
  baseVersion: number;
  payload: PortableProfile;
  activeOpens: CloudOpenWarning[];
  /** Leases this open replaced because they lapsed on another device. Absent from older services. */
  lapsedOpens?: CloudLapsedOpen[];
}

export interface OpenHeartbeatResponse {
  ok: true;
  revoked: false;
  activeOpens: CloudOpenWarning[];
}

export interface CloseOpenRequest {
  expectedVersion: number;
  payload: PortableProfile;
}

export interface CloseOpenResponse {
  ok: true;
  status: "accepted";
  version: number;
}

/** Save the session of a profile that stays open. `expectedVersion` is the newest version the
    registration holds: the version it opened, or the version its last checkpoint returned. */
export interface CheckpointOpenRequest {
  expectedVersion: number;
  payload: PortableProfile;
}

/** `behind`: an earlier checkpoint was already saved as `version`; nothing was written, so save
    again against `version`. A lapsed or lost lease is a 409 `version_conflict`. */
export interface CheckpointOpenResponse {
  ok: true;
  status: "saved" | "unchanged" | "behind";
  version: number;
}

export interface CloseOpenConflict extends CloudError {
  error: CloudError["error"] & {
    code: "version_conflict";
    currentVersion: number;
  };
}

export interface AbandonOpenResponse {
  ok: true;
}

export interface ProfileMutationResponse {
  ok: true;
  profile: CloudProfileSummary;
}

export interface PurgeProfileResponse {
  ok: true;
}

export interface TrashProfileRequest {
  expectedVersion: number;
}

export interface RestoreProfileRequest {
  expectedVersion: number;
}

export interface DeletionRequestResponse {
  ok: true;
  requestId: string;
  status: "pending";
}

export const ANALYTICS_EVENTS = [
  "install_completed",
  "cloud_signup_completed",
  "profile_created",
  "profile_imported",
  "browser_opened",
  "profile_restored_on_second_device",
  "teammate_added",
  "app_error",
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

export interface AnalyticsEventRequest {
  name: AnalyticsEventName;
  appVersion: string;
  mode: "local" | "cloud";
  platform: CloudDevice["platform"];
  errorCategory?: string;
}

export type ScriptLanguage = "javascript" | "python";

export interface ScriptInput {
  name: string;
  description: string;
  language: ScriptLanguage;
  source: string;
}

export interface ScriptRecord extends ScriptInput {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  publishedRevision?: number | null;
}

export type ScriptSummary = Omit<ScriptRecord, "source">;

export interface PublishedScriptSummary {
  id: string;
  name: string;
  description: string;
  language: ScriptLanguage;
  authorName: string;
  authorEmail: string | null;
  sourceRevision: number;
  publishedAt: string;
  updatedAt: string;
}

export interface PublishedScript extends PublishedScriptSummary {
  source: string;
}

export interface PublishScriptInput {
  expectedRevision: number;
  authorName: string;
  showEmail: boolean;
}

export interface PublishedScriptsQuery {
  q?: string;
  language?: ScriptLanguage;
  offset?: number;
}

export interface ListPublishedScriptsResponse {
  ok: true;
  scripts: PublishedScriptSummary[];
  nextOffset: number | null;
}

/* Credits wallet and proxy purchases. Amounts are integer USD cents; times are epoch milliseconds.
   Owners deposit and buy; every active member sees the balance and the purchased proxies. */

export type WalletEntryKind = "deposit" | "purchase" | "renewal" | "refund" | "adjustment";

export interface CloudWalletEntry {
  id: string;
  /** Positive adds credits, negative spends them. */
  amountCents: number;
  kind: WalletEntryKind;
  createdAt: number;
  description?: string;
}

export interface CloudCryptoPaymentMethod {
  id: string;
  coin: string;
  network: string;
  label: string;
  /** Decimal string in the coin's units, for example "10.25". */
  amount: string;
  address: string;
  paymentUri: string;
}

export interface CloudWalletDeposit {
  id: string;
  amountCents: number;
  method: "card" | "crypto";
  /** disputed / refunded: a card chargeback or refund after payment; the balance is unchanged until support decides. */
  status: "pending" | "paid" | "expired" | "failed" | "disputed" | "refunded";
  createdAt: number;
  expiresAt: number | null;
  paidAt: number | null;
  /** Present while pending for card deposits: open this page to pay. */
  card?: { checkoutUrl: string };
  /** Present while pending for crypto deposits: pay one of these. */
  crypto?: { methods: CloudCryptoPaymentMethod[] };
}

export interface GetWalletResponse {
  ok: true;
  balanceCents: number;
  currency: "USD";
  /** Newest first, at most 50. */
  entries: CloudWalletEntry[];
  pendingDeposits: CloudPendingDeposit[];
}

export interface CloudPendingDeposit {
  depositId: string;
  amountCents: number;
  method: "card" | "crypto";
  status: "pending";
  expiresAt?: number;
}

export interface CreateDepositRequest {
  /** 500..1000000 ($5.00 to $10,000.00); outside that range the answer is 400 deposit_amount_out_of_range. */
  amountCents: number;
  method: "card" | "crypto";
}

export interface DepositResponse {
  ok: true;
  deposit: CloudWalletDeposit;
}

/** `type` is an opaque NobleProxy id such as `x-twitter-12`; country codes are ISO codes or `ANY`.
    Send them back unchanged and show `label` and `name`. */
export interface CloudProxyProduct {
  type: string;
  label: string;
  countries: Array<{ code: string; name: string }>;
  /** Unit price for quantities from minQty up to the next tier. `publicUnitPriceCents` is NobleProxy's
      public price for the same tier; optional, the app shows the saving only when it is sent. */
  tiers: Array<{ minQty: number; unitPriceCents: number; publicUnitPriceCents?: number }>;
}

export interface ProxyCatalogResponse {
  ok: true;
  products: CloudProxyProduct[];
}

export interface CreateProxyPurchaseRequest {
  type: string;
  country: string;
  quantity: number;
  /** Client-chosen key; the same key returns the same purchase and never charges twice. */
  idempotencyKey: string;
  /** Store placement that led to this purchase (for example `sidebar-cart`); `direct` when none. */
  src?: string;
}

export interface CloudProxyPurchase {
  id: string;
  idempotencyKey: string;
  type: string;
  country: string;
  quantity: number;
  totalCents: number;
  /** pending: charged, waiting for NobleProxy; failed: refunded; needs_review: no NobleProxy answer for
      24 hours, still charged, support settles it. */
  status: "pending" | "active" | "failed" | "needs_review";
  orderId: string | null;
  failure: string | null;
  createdAt: number;
}

export interface CloudPurchasedProxy {
  id: string;
  host: string;
  port: number;
  username: string;
  password: string;
  /** NobleProxy names are mapped: any SOCKS variant is socks5, everything else is http. */
  protocol: "http" | "socks5";
  country: string;
}

/** needs_review: the renewal was charged but NobleProxy gave no answer for 24 hours; support settles it. */
export type ProxyRenewalStatus = "ok" | "pending" | "renewal_failed" | "needs_review";
export type ProxyRenewalFailure = "insufficient_balance" | "partner_failed";

export interface CloudProxyOrder {
  id: string;
  type: string;
  country: string;
  quantity: number;
  expiresAt: number;
  autoRenew: boolean;
  renewalStatus: ProxyRenewalStatus;
  renewalFailure: ProxyRenewalFailure | null;
  proxies: CloudPurchasedProxy[];
}

export interface ProxyPurchaseResponse {
  ok: true;
  purchase: CloudProxyPurchase;
  order: CloudProxyOrder | null;
}

export interface ListPurchasedProxiesResponse {
  ok: true;
  orders: CloudProxyOrder[];
  /** Purchases with status pending or needs_review. */
  pendingPurchases: CloudProxyPurchase[];
}

export interface SetAutoRenewRequest {
  enabled: boolean;
}

export interface SetAutoRenewResponse {
  ok: true;
  orderId: string;
  autoRenew: boolean;
}

/** POST /v1/nobleproxy/handoff (owner only, no body): a short-lived link that opens NobleProxy signed in with the
    owner's verified email. Open `url` in the system browser before `expiresAt` (epoch milliseconds). */
export interface NobleProxyHandoffResponse {
  ok: true;
  url: string;
  expiresAt: number;
}

/** One in-app proxy store event. `src` is the placement slug, `at` epoch milliseconds. No personal data. */
export type StoreEventType = "entry_click" | "store_view" | "pay_click";

export interface StoreEvent {
  type: StoreEventType;
  src: string;
  at: number;
}

/** POST /v1/store/events: a batch of store events for the placement conversion report. Older Clouds answer 404. */
export interface StoreEventsRequest {
  events: StoreEvent[];
}

export interface StoreEventsResponse {
  ok: true;
}

export type CloudResult<T> = T | CloudError;
