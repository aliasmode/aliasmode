export interface SessionRecord {
  profileId: string;
  bundle: string;
  version: number;
  updatedAt: number;
  updatedBy: string;
}

export type AutomationHealthStatus = "suspended" | "alive" | "no_data";

export interface AutomationHealthEntry {
  profileId: string;
  suspended: boolean;
}

export interface HealthSource {
  sourceId: string;
  lastSnapshotAt: number;
  stale: boolean;
}
