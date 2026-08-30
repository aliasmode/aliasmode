import { normalizeSecureServiceUrl } from "./app-config.ts";

export type AuthFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface SupabaseAuthUser {
  id: string;
  email?: string;
  email_confirmed_at?: string | null;
}

export interface SupabaseAuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  expiresAt: number;
  user: SupabaseAuthUser;
}

export interface SignUpResult {
  user: SupabaseAuthUser;
  verificationRequired: boolean;
}

export type SupabaseAuthFailure =
  | { kind: "transport"; retryable: true }
  | { kind: "timeout"; retryable: true }
  | { kind: "http"; status: number; retryable: boolean };

export class SupabaseAuthRequestError extends Error {
  constructor(
    message: string,
    readonly failure: SupabaseAuthFailure,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SupabaseAuthRequestError";
  }
}

export class EmailVerificationRequiredError extends Error {
  constructor() {
    super("Verify your email before signing in to AliasMode Cloud");
    this.name = "EmailVerificationRequiredError";
  }
}

export interface SupabaseAuthClientOptions {
  baseUrl: string;
  anonKey: string;
  fetchFn?: AuthFetch;
  requestTimeoutMs?: number;
  nowMs?: () => number;
}

const DEFAULT_AUTH_TIMEOUT_MS = 30_000;
const EMAIL_CONFIRMATION_REDIRECT = "https://aliasmode.com/auth/email-confirmation";

function isRetryableAuthStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

export class SupabaseAuthClient {
  private readonly baseUrl: string;
  private readonly fetchFn: AuthFetch;
  private readonly requestTimeoutMs: number;
  private readonly nowMs: () => number;

  constructor(private readonly options: SupabaseAuthClientOptions) {
    this.baseUrl = normalizeSecureServiceUrl(options.baseUrl, "AliasMode Auth");
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async signUp(email: string, password: string): Promise<SignUpResult> {
    const body = await this.call(`/signup?redirect_to=${encodeURIComponent(EMAIL_CONFIRMATION_REDIRECT)}`, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    const user = body.user ?? body;
    if (!user?.id) throw new Error("AliasMode Auth signup response is missing a user");
    return { user, verificationRequired: !user.email_confirmed_at };
  }

  async resendSignUpConfirmation(email: string): Promise<void> {
    await this.call(`/resend?redirect_to=${encodeURIComponent(EMAIL_CONFIRMATION_REDIRECT)}`, {
      method: "POST",
      body: JSON.stringify({ type: "signup", email }),
    });
  }

  async signIn(email: string, password: string): Promise<SupabaseAuthSession> {
    const body = await this.call("/token?grant_type=password", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    return this.session(body);
  }

  async refresh(refreshToken: string): Promise<SupabaseAuthSession> {
    const body = await this.call("/token?grant_type=refresh_token", {
      method: "POST",
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    return this.session(body);
  }

  async requestPasswordReset(email: string, redirectTo: string): Promise<void> {
    await this.call("/recover", {
      method: "POST",
      body: JSON.stringify({ email, redirect_to: redirectTo }),
    });
  }

  async updatePassword(accessToken: string, password: string): Promise<void> {
    await this.call("/user", {
      method: "PUT",
      headers: { authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ password }),
    });
  }

  async signOut(accessToken: string): Promise<void> {
    await this.call("/logout?scope=local", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  private session(body: any): SupabaseAuthSession {
    if (!body?.user?.email_confirmed_at) throw new EmailVerificationRequiredError();
    if (!body.access_token || !body.refresh_token || !Number.isFinite(body.expires_in)) {
      throw new Error("AliasMode Auth returned an incomplete session");
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresIn: body.expires_in,
      expiresAt: this.nowMs() + body.expires_in * 1_000,
      user: body.user,
    };
  }

  private async call(path: string, init: RequestInit): Promise<any> {
    const headers = new Headers(init.headers);
    headers.set("apikey", this.options.anonKey);
    headers.set("content-type", "application/json");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new SupabaseAuthRequestError(
          `AliasMode Auth request timed out after ${this.requestTimeoutMs}ms`,
          { kind: "timeout", retryable: true },
        );
        controller.abort(error);
        reject(error);
      }, this.requestTimeoutMs);
      if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
    });
    try {
      const request = Promise.resolve().then(async () => {
        let response: Response;
        try {
          response = await this.fetchFn(`${this.baseUrl}/auth/v1${path}`, {
            ...init,
            headers,
            signal: controller.signal,
          });
        } catch (error) {
          throw new SupabaseAuthRequestError(
            "AliasMode Auth could not be reached",
            { kind: "transport", retryable: true },
            { cause: error },
          );
        }

        let text: string;
        try {
          text = await response.text();
        } catch (error) {
          throw new SupabaseAuthRequestError(
            "AliasMode Auth response could not be read",
            { kind: "transport", retryable: true },
            { cause: error },
          );
        }
        let body: any = {};
        if (text.trim()) {
          try {
            body = JSON.parse(text);
          } catch {
            if (response.ok) throw new Error(`AliasMode Auth returned non-JSON (${response.status})`);
          }
        }
        if (!response.ok) {
          throw new SupabaseAuthRequestError(
            body?.msg ?? body?.message ?? body?.error_description ?? `AliasMode Auth failed (${response.status})`,
            { kind: "http", status: response.status, retryable: isRetryableAuthStatus(response.status) },
          );
        }
        return body;
      });
      return await Promise.race([request, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
