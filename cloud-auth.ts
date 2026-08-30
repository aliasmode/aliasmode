import {
  SupabaseAuthClient,
  type SignUpResult,
  type SupabaseAuthSession,
  type SupabaseAuthUser,
} from "./supabase-auth.ts";

export interface CloudAuthState {
  authenticated: boolean;
  expiresAt?: number;
  user?: SupabaseAuthUser;
}

export interface CloudAuthResult extends CloudAuthState {
  authenticated: true;
  refreshToken: string;
}

export class CloudAuthRuntime {
  private accessTokenValue: string | undefined;
  private refreshTokenValue: string | undefined;
  private expiresAtValue: number | undefined;
  private userValue: SupabaseAuthUser | undefined;
  private refreshInFlight: Promise<string | undefined> | undefined;
  private credentialMutation = Promise.resolve();
  private signOutInFlight: Promise<void> | undefined;
  private generation = 0;

  constructor(
    private readonly auth: SupabaseAuthClient,
    private readonly nowMs: () => number = () => Date.now(),
    private readonly onRefreshToken?: (refreshToken: string) => void | Promise<void>,
    private readonly onSignOut?: () => void | Promise<void>,
  ) {}

  state(): CloudAuthState {
    if (!this.accessToken()) return { authenticated: false };
    return {
      authenticated: true,
      expiresAt: this.expiresAtValue,
      user: this.userValue,
    };
  }

  accessToken(): string | undefined {
    if (!this.accessTokenValue || !this.expiresAtValue || this.expiresAtValue <= this.nowMs()) {
      return undefined;
    }
    return this.accessTokenValue;
  }

  async accessTokenOrRefresh(): Promise<string | undefined> {
    const current = this.accessToken();
    if (current) return current;
    if (!this.refreshTokenValue) return undefined;
    if (this.refreshInFlight) return this.refreshInFlight;

    const refreshToken = this.refreshTokenValue;
    const generation = this.generation;
    const pending = (async () => {
      const session = await this.auth.refresh(refreshToken);
      if (generation !== this.generation) return undefined;
      const result = this.accept(session);
      await this.persistRefreshToken(result.refreshToken, generation);
      if (generation !== this.generation) return undefined;
      return this.accessToken();
    })().finally(() => {
      if (this.refreshInFlight === pending) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = pending;
    return pending;
  }

  signUp(email: string, password: string): Promise<SignUpResult> {
    return this.auth.signUp(email, password);
  }

  resendSignUpConfirmation(email: string): Promise<void> {
    return this.auth.resendSignUpConfirmation(email);
  }

  async signIn(email: string, password: string): Promise<CloudAuthResult> {
    const generation = this.generation;
    return this.acceptAndPersist(await this.auth.signIn(email, password), generation);
  }

  async restore(refreshToken: string): Promise<CloudAuthResult> {
    const generation = this.generation;
    return this.acceptAndPersist(await this.auth.refresh(refreshToken), generation);
  }

  signOut(): Promise<void> {
    if (this.signOutInFlight) return this.signOutInFlight;
    const accessToken = this.accessTokenValue;
    this.clear();
    const pending = (async () => {
      try {
        if (accessToken) {
          try {
            await this.auth.signOut(accessToken);
          } catch {
            // Local sign-out must not depend on the remote session being reachable.
          }
        }
      } finally {
        try {
          await this.mutateCredentials(async () => { await this.onSignOut?.(); });
        } finally {
          this.clear();
        }
      }
    })().finally(() => {
      if (this.signOutInFlight === pending) this.signOutInFlight = undefined;
    });
    this.signOutInFlight = pending;
    return pending;
  }

  async clearStoredSession(): Promise<void> {
    this.clear();
    try {
      await this.mutateCredentials(async () => { await this.onSignOut?.(); });
    } finally {
      this.clear();
    }
  }

  clear(): void {
    this.generation++;
    this.accessTokenValue = undefined;
    this.refreshTokenValue = undefined;
    this.expiresAtValue = undefined;
    this.userValue = undefined;
  }

  private async acceptAndPersist(session: SupabaseAuthSession, generation: number): Promise<CloudAuthResult> {
    if (generation !== this.generation) throw new Error("Cloud authentication was cancelled");
    const result = this.accept(session);
    await this.persistRefreshToken(result.refreshToken, generation);
    if (generation !== this.generation) throw new Error("Cloud authentication was cancelled");
    return result;
  }

  private persistRefreshToken(refreshToken: string, generation: number): Promise<void> {
    return this.mutateCredentials(async () => {
      if (generation !== this.generation) throw new Error("Cloud authentication was cancelled");
      await this.onRefreshToken?.(refreshToken);
    });
  }

  private mutateCredentials(mutation: () => Promise<void>): Promise<void> {
    const pending = this.credentialMutation.then(mutation, mutation);
    this.credentialMutation = pending.catch(() => {});
    return pending;
  }

  private accept(session: SupabaseAuthSession): CloudAuthResult {
    this.accessTokenValue = session.accessToken;
    this.refreshTokenValue = session.refreshToken;
    this.expiresAtValue = session.expiresAt;
    this.userValue = session.user;
    return {
      authenticated: true,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      user: session.user,
    };
  }
}
