import type { ProxyCheckResult } from "./proxy-check.ts";

export interface ProxyScope {
  all?: boolean;
  groups?: string[];
  ids?: string[];
}

export type ProxyReplacementMode = "profileId" | "oldProxy" | "list";

export interface ProxyPreviewInput {
  scope: ProxyScope;
  mode: ProxyReplacementMode;
  input: string;
}

export interface ProxyReplacementView {
  index: number;
  profileId?: string;
  name?: string;
  group?: string;
  previousProxy: string | null;
  proxy: string | null;
  status: "ready" | "updated" | "unchanged" | "missing" | "skipped" | "failed";
  code?: string;
}

export interface ProxyPreview {
  ok: true;
  previewId: string;
  rows: ProxyReplacementView[];
  unusedProxies: number;
}

export interface ProxyCheckView {
  key: string;
  proxy: string | null;
  profiles: Array<{ id: string; name: string; group: string }>;
  status: ProxyCheckResult["status"] | "missing" | "invalid" | "unsupported";
  reason?: string;
  ip?: string;
  country?: string;
  checkedAt: number;
}

export type ProxyProgressEvent =
  | { type: "progress"; phase: "loading" | "checking" | "applying"; completed: number; total: number }
  | { type: "summary"; selectedProfiles: number; uniqueProxies: number; duplicatesSkipped: number }
  | { type: "check"; row: ProxyCheckView }
  | { type: "replacement"; row: ProxyReplacementView }
  | { type: "done" }
  | { type: "error"; error: string };

export interface TrashProfileView {
  id: string;
  name: string;
  group: string;
  trashedAt: number;
  version?: number;
  canRestore: boolean;
  canPurge: boolean;
}

export interface TrashMutationResult {
  ok: true;
  results: Array<{ id: string; status: "restored" | "purged" | "failed"; code?: string }>;
}
