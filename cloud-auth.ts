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

export interface CloudAuthTransition {
  generation: number;
  release(): void;
}

export class CloudAuthRuntime {
  private accessTokenValue: string | undefined;
  private refreshTokenValue: string | undefined;
  private expiresAtValue: number | undefined;
  private userValue: SupabaseAuthUser | undefined;
  private refreshInFlight: Promise<string | undefined> | undefined;
  private credentialMutation = Promise.resolve();
  private transitionTail = Promise.resolve();
  private transitionGeneration = 0;
  private exitsInProgress = 0;
  private signOutInFlight: Promise<void> | undefined;
  private authenticationInFlight: number | undefined;
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

  hasSession(): boolean {
    return !!(this.accessTokenValue || this.refreshTokenValue);
  }

  canSignIn(): boolean {
    return !this.hasSession() &&
      this.authenticationInFlight === undefined &&
      this.signOutInFlight === undefined &&
      this.exitsInProgress === 0;
  }

  canRestore(refreshToken: string): boolean {
    return this.authenticationInFlight === undefined &&
      this.signOutInFlight === undefined &&
      this.exitsInProgress === 0 &&
      (!this.hasSession() || this.refreshTokenValue === refreshToken);
  }

  async acquireTransition(): Promise<CloudAuthTransition> {
    const generation = this.transitionGeneration;
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const previous = this.transitionTail;
    this.transitionTail = previous.then(() => turn);
    await previous;
    let released = false;
    return {
      generation,
      release() {
        if (released) return;
        released = true;
        releaseTurn();
      },
    };
  }

  isTransitionCurrent(transition: CloudAuthTransition): boolean {
    return transition.generation === this.transitionGeneration && this.exitsInProgress === 0;
  }

  beginExit(): () => void {
    this.transitionGeneration++;
    this.transitionTail = Promise.resolve();
    this.exitsInProgress++;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.exitsInProgress--;
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
      await this.persistRefreshToken(session.refreshToken, generation);
      if (generation !== this.generation) return undefined;
      this.accept(session);
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
    if (this.hasSession()) {
      throw new Error("Sign out before signing in to another Cloud account");
    }
    const generation = this.beginAuthentication();
    try {
      return await this.acceptAndPersist(await this.auth.signIn(email, password), generation);
    } finally {
      this.finishAuthentication(generation);
    }
  }

  async restore(refreshToken: string): Promise<CloudAuthResult> {
    if (this.hasSession() && this.refreshTokenValue !== refreshToken) {
      throw new Error("Sign out before restoring another Cloud account");
    }
    const generation = this.beginAuthentication();
    try {
      if (this.hasSession()) {
        if (!this.accessToken() && !await this.accessTokenOrRefresh()) {
          throw new Error("Cloud authentication was cancelled");
        }
        if (generation !== this.generation) {
          throw new Error("Cloud authentication was cancelled");
        }
        return this.currentResult();
      }
      return await this.acceptAndPersist(await this.auth.refresh(refreshToken), generation);
    } finally {
      this.finishAuthentication(generation);
    }
  }

  signOut(): Promise<void> {
    if (this.signOutInFlight) return this.signOutInFlight;
    const accessToken = this.accessTokenValue;
    this.clear();
    const pending = (async () => {
      if (accessToken) {
        try {
          void this.auth.signOut(accessToken).catch(() => {});
        } catch {
          // Local sign-out must not depend on the remote session being reachable.
        }
      }
      try {
        await this.mutateCredentials(async () => { await this.onSignOut?.(); });
      } finally {
        this.clear();
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
    this.authenticationInFlight = undefined;
    this.refreshInFlight = undefined;
    this.accessTokenValue = undefined;
    this.refreshTokenValue = undefined;
    this.expiresAtValue = undefined;
    this.userValue = undefined;
  }

  private beginAuthentication(): number {
    if (
      this.authenticationInFlight !== undefined ||
      this.signOutInFlight !== undefined ||
      this.exitsInProgress > 0
    ) {
      throw new Error("Cloud authentication is already in progress");
    }
    const generation = this.generation;
    this.authenticationInFlight = generation;
    return generation;
  }

  private finishAuthentication(generation: number): void {
    if (this.authenticationInFlight === generation) {
      this.authenticationInFlight = undefined;
    }
  }

  private currentResult(): CloudAuthResult {
    if (!this.refreshTokenValue || !this.expiresAtValue || !this.userValue) {
      throw new Error("Cloud authentication was cancelled");
    }
    return {
      authenticated: true,
      refreshToken: this.refreshTokenValue,
      expiresAt: this.expiresAtValue,
      user: this.userValue,
    };
  }

  private async acceptAndPersist(session: SupabaseAuthSession, generation: number): Promise<CloudAuthResult> {
    if (generation !== this.generation) throw new Error("Cloud authentication was cancelled");
    await this.persistRefreshToken(session.refreshToken, generation);
    if (generation !== this.generation) throw new Error("Cloud authentication was cancelled");
    return this.accept(session);
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
