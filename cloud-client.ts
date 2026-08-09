import { normalizeSecureServiceUrl } from "./app-config.ts";
import {
  CLOUD_API_BASE_PATH,
  type AbandonOpenResponse,
  type AcceptLegalRequest,
  type AcceptLegalResponse,
  type BootstrapRequest,
  type BootstrapResponse,
  type CloseOpenConflict,
  type CloseOpenRequest,
  type CloseOpenResponse,
  type CloudError,
  type CloudErrorCode,
  type CloudStatusResponse,
  type CreateProfileRequest,
  type CreateProfileResponse,
  type GetProfileResponse,
  type ListProfilesResponse,
  type OpenHeartbeatResponse,
  type OpenProfileRequest,
  type OpenProfileResponse,
  type ProfileMutationResponse,
  type PurgeProfileResponse,
  type RestoreProfileRequest,
  type TrashProfileRequest,
  type UpdateProfileRequest,
  type UpdateProfileResponse,
} from "./contracts/cloud-v1.ts";

export type CloudFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type CloudCredentialProvider = () => string | undefined | Promise<string | undefined>;

const DEFAULT_CLOUD_REQUEST_TIMEOUT_MS = 30_000;

export class CloudApiError extends Error {
  constructor(
    message: string,
    readonly code: CloudErrorCode,
    readonly status: number,
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

export interface CloudClientOptions {
  baseUrl: string;
  accessToken: CloudCredentialProvider;
  deviceCredential?: CloudCredentialProvider;
  fetchFn?: CloudFetch;
  requestTimeoutMs?: number;
}

export class CloudClient {
  private readonly baseUrl: string;
  private readonly fetchFn: CloudFetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: CloudClientOptions) {
    this.baseUrl = normalizeSecureServiceUrl(options.baseUrl, "AliasMode Cloud");
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_CLOUD_REQUEST_TIMEOUT_MS);
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const accessToken = await this.options.accessToken();
    if (!accessToken) {
      throw new CloudApiError("AliasMode Cloud authentication is required", "authentication_required", 401);
    }
    const deviceCredential = await this.options.deviceCredential?.();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${accessToken}`);
    if (deviceCredential) headers.set("x-aliasmode-device", deviceCredential);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");

    const controller = new AbortController();
    const upstreamSignal = init.signal;
    const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal?.aborted) abortFromUpstream();
    else upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`AliasMode Cloud request ${path} timed out after ${this.requestTimeoutMs}ms`);
        controller.abort(error);
        reject(error);
      }, this.requestTimeoutMs);
      if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
    });

    try {
      const request = Promise.resolve().then(async () => {
        const response = await this.fetchFn(`${this.baseUrl}${CLOUD_API_BASE_PATH}${path}`, {
          ...init,
          headers,
          signal: controller.signal,
        });
        const text = await response.text();
        let body: any = {};
        if (text.trim()) {
          try {
            body = JSON.parse(text);
          } catch {
            const contentType = response.headers.get("content-type") ?? "unknown content type";
            throw new Error(
              `AliasMode Cloud ${path} returned non-JSON (${response.status}, ${contentType})`,
            );
          }
        }
        if (!response.ok || body?.ok === false) this.throwApiError(response.status, body);
        return body as T;
      });
      return await Promise.race([request, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      upstreamSignal?.removeEventListener("abort", abortFromUpstream);
    }
  }

  private throwApiError(status: number, body: Partial<CloudError>): never {
    const error = body.error;
    const code = error?.code ?? "internal_error";
    const message = error?.message ?? `AliasMode Cloud request failed (${status})`;
    throw new CloudApiError(message, code, status, error?.currentVersion);
  }

  status(): Promise<CloudStatusResponse> {
    return this.call("/status");
  }

  bootstrap(request: BootstrapRequest): Promise<BootstrapResponse> {
    return this.call("/account/bootstrap", { method: "POST", body: JSON.stringify(request) });
  }

  acceptLegal(request: AcceptLegalRequest): Promise<AcceptLegalResponse> {
    return this.call("/account/legal", { method: "POST", body: JSON.stringify(request) });
  }

  listProfiles(): Promise<ListProfilesResponse> {
    return this.call("/profiles");
  }

  getProfile(profileId: string): Promise<GetProfileResponse> {
    return this.call(`/profiles/${encodeURIComponent(profileId)}`);
  }

  updateProfile(profileId: string, request: UpdateProfileRequest): Promise<UpdateProfileResponse> {
    return this.call(`/profiles/${encodeURIComponent(profileId)}`, {
      method: "PATCH",
      body: JSON.stringify(request),
    });
  }

  trashProfile(profileId: string, request: TrashProfileRequest): Promise<ProfileMutationResponse> {
    return this.call(`/profiles/${encodeURIComponent(profileId)}/trash`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  restoreProfile(profileId: string, request: RestoreProfileRequest): Promise<ProfileMutationResponse> {
    return this.call(`/profiles/${encodeURIComponent(profileId)}/restore`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  purgeProfile(profileId: string, expectedVersion: number): Promise<PurgeProfileResponse> {
    return this.call(`/profiles/${encodeURIComponent(profileId)}/purge`, {
      method: "DELETE",
      body: JSON.stringify({ expectedVersion }),
    });
  }

  createProfile(request: CreateProfileRequest): Promise<CreateProfileResponse> {
    return this.call("/profiles", { method: "POST", body: JSON.stringify(request) });
  }

  openProfile(profileId: string, request: OpenProfileRequest): Promise<OpenProfileResponse> {
    return this.call(`/profiles/${encodeURIComponent(profileId)}/open`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  heartbeat(registrationId: string): Promise<OpenHeartbeatResponse> {
    return this.call(`/open-sessions/${encodeURIComponent(registrationId)}/heartbeat`, { method: "POST" });
  }

  async closeOpen(
    registrationId: string,
    request: CloseOpenRequest,
  ): Promise<CloseOpenResponse | CloseOpenConflict> {
    try {
      return await this.call(`/open-sessions/${encodeURIComponent(registrationId)}/close`, {
        method: "PUT",
        body: JSON.stringify(request),
      });
    } catch (error) {
      if (error instanceof CloudApiError && error.code === "version_conflict") {
        if (!Number.isSafeInteger(error.currentVersion) || error.currentVersion! < 0) {
          throw new Error("AliasMode Cloud version conflict is missing currentVersion");
        }
        return {
          ok: false,
          error: {
            code: "version_conflict",
            message: error.message,
            currentVersion: error.currentVersion!,
          },
        };
      }
      throw error;
    }
  }

  abandon(registrationId: string): Promise<AbandonOpenResponse> {
    return this.call(`/open-sessions/${encodeURIComponent(registrationId)}/abandon`, { method: "POST" });
  }
}
