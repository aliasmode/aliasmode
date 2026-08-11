export const CLOUD_DIAGNOSTIC_TYPES = [
  "open_started",
  "cloud_registered",
  "browser_started",
  "session_restore_started",
  "session_restore_completed",
  "session_restore_unclassified_failed",
  "session_restore_invalid_bundle_failed",
  "session_restore_invalid_bundle_timeout",
  "session_restore_connect_failed",
  "session_restore_connect_timeout",
  "session_restore_context_failed",
  "session_restore_context_timeout",
  "session_restore_origin_storage_failed",
  "session_restore_origin_storage_timeout",
  "session_restore_cookie_clear_failed",
  "session_restore_cookie_clear_timeout",
  "session_restore_cookie_add_failed",
  "session_restore_cookie_add_timeout",
  "session_restore_disconnect_failed",
  "session_restore_disconnect_timeout",
  "open_running",
  "open_failed",
  "close_started",
  "session_captured",
  "browser_stopped",
  "session_synced",
  "cloud_registration_released",
  "cleanup_retained",
  "heartbeat_failed",
  "access_ended",
] as const;

export type CloudDiagnosticType = typeof CLOUD_DIAGNOSTIC_TYPES[number];

export interface CloudDiagnosticEvent {
  timestamp: number;
  type: CloudDiagnosticType;
}

const CLOUD_DIAGNOSTIC_TYPE_SET = new Set<string>(CLOUD_DIAGNOSTIC_TYPES);

export function normalizeCloudDiagnostics(raw: unknown): CloudDiagnosticEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const timestamp = (candidate as any).timestamp;
    const type = (candidate as any).type;
    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(new Date(timestamp).getTime()) ||
      !CLOUD_DIAGNOSTIC_TYPE_SET.has(type)
    ) return [];
    return [{ timestamp, type: type as CloudDiagnosticType }];
  });
}

const MAX_CLOUD_DIAGNOSTICS = 100;

export class CloudDiagnostics {
  private readonly events: CloudDiagnosticEvent[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  record(type: CloudDiagnosticType): void {
    if (!CLOUD_DIAGNOSTIC_TYPE_SET.has(type)) {
      throw new Error("unknown Cloud diagnostic event");
    }
    this.events.push({ timestamp: this.now(), type });
    if (this.events.length > MAX_CLOUD_DIAGNOSTICS) {
      this.events.splice(0, this.events.length - MAX_CLOUD_DIAGNOSTICS);
    }
  }

  snapshot(): CloudDiagnosticEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
}
