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
  | "profile_trashed"
  | "profile_open"
  | "version_conflict"
  | "validation_failed"
  | "rate_limited"
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
  archivedAt: number | null;
  permission: FolderPermission;
}

export interface CloudFolderGrant {
  folderName: string;
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

/** Complete portable state. The server stores this only as an encrypted envelope. */
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
    screenWidth: number;
    screenHeight: number;
    fingerprintSeed: number;
    /** Explicit desktop platform; "" when the profile predates the field. */
    platformOs?: string;
  };
  session: PortableSessionV1;
}

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
  payload: PortableProfileV1;
}

export interface CreateProfileResponse {
  ok: true;
  profile: CloudProfileSummary;
  payloadDigest: string;
}

export interface ImportProfilesRequest {
  destination: string;
  profiles: PortableProfileV1[];
}

export interface ImportProfilesResponse {
  ok: true;
  imported: number;
  ids: string[];
}

export interface GetProfileResponse {
  ok: true;
  profile: CloudProfileSummary;
  payload: PortableProfileV1;
  payloadDigest: string;
}

export interface UpdateProfileResponse {
  ok: true;
  profile: CloudProfileSummary;
  payloadDigest: string;
}

export interface UpdateProfileRequest {
  expectedVersion: number;
  payload: PortableProfileV1;
}

export interface OpenProfileRequest {
  deviceId: string;
}

export interface OpenProfileResponse {
  ok: true;
  registrationId: string;
  baseVersion: number;
  payload: PortableProfileV1;
  activeOpens: CloudOpenWarning[];
}

export interface OpenHeartbeatResponse {
  ok: true;
  revoked: false;
  activeOpens: CloudOpenWarning[];
}

export interface CloseOpenRequest {
  expectedVersion: number;
  payload: PortableProfileV1;
}

export interface CloseOpenResponse {
  ok: true;
  status: "accepted";
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

export type CloudResult<T> = T | CloudError;
