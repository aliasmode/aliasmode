/**
 * "New identity", like Mullvad Browser's: a profile gets fresh cookies and a fresh fingerprint.
 * Its whole browser data folder on this computer (cookies, logins, history, bookmarks, saved
 * passwords, cache, site storage, add-ons installed in the browser) and saved session are deleted, and it
 * gets a new seed, screen and hardware on the same system, engine and runtime. Name, folder,
 * proxy, notes, tags, login details and extensions stay. An open profile is closed, reset and
 * opened again; a closed one stays closed. There is no undo. A Cloud profile's empty session carries a
 * one-time token: every other computer that opens the profile while Cloud holds it deletes its own copy too.
 */

import type { CloudBrowserLifecycle } from "./cloud-browser.ts";
import { CloudProfileEditor, cloudProfileEditorErrorStatus, type CloudProfileEditorClient } from "./cloud-profile-editor.ts";
import { freshIdentity } from "./create.ts";
import { waitForHostGpu } from "./host-gpu.ts";
import type { Launcher } from "./launcher.ts";
import { assertSafeProfileId } from "./profile-id.ts";
import type { ProfileStore } from "./store.ts";
import type { Profile } from "./types.ts";

export interface NewIdentityDeps {
  launcher: Pick<Launcher, "start" | "stop" | "resetUserData" | "resetUserDataRefusal" | "recordNewIdentity">;
  store: ProfileStore;
  cloudBrowser?: Pick<CloudBrowserLifecycle, "open" | "close" | "newIdentityBlocked" | "discardSessions">;
  cloudClient?: CloudProfileEditorClient;
  remote?: unknown;
  /** True while a script run has the profile queued or running. */
  scriptBusy?: (profileId: string) => boolean;
}

export interface NewIdentityResult {
  profileId: string;
  reopened: boolean;
  warning?: string;
}

export class NewIdentityError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "NewIdentityError";
  }
}

export function newIdentityErrorStatus(error: unknown): number {
  return error instanceof NewIdentityError ? error.status : cloudProfileEditorErrorStatus(error);
}

export async function startNewIdentity(deps: NewIdentityDeps, profileId: string): Promise<NewIdentityResult> {
  const { launcher, store, cloudBrowser } = deps;
  try {
    assertSafeProfileId(profileId);
  } catch (error) {
    throw new NewIdentityError(error instanceof Error ? error.message : String(error), 400);
  }
  if (deps.remote) throw new NewIdentityError("New identity is unavailable in legacy Remote mode", 400);
  // The run owns that browser; closing it under the script would leave its next open unowned.
  if (deps.scriptBusy?.(profileId)) throw new NewIdentityError("A script is using this profile; stop it first", 409);
  const launch = store.getLaunch(profileId);
  const headless = launch?.headless !== undefined ? { headless: launch.headless } : {};
  await waitForHostGpu();
  const seeds = new Set(store.listProfiles().map((profile) => profile.fingerprintSeed));
  const fresh = (profile: Profile) => freshIdentity(profile, (seed) => seeds.has(seed));
  // This computer goes first, and Cloud last: a refusal here must leave the browser open and Cloud unchanged.
  const refusal = launcher.resetUserDataRefusal(profileId);
  if (refusal) throw new NewIdentityError(refusal, 409);
  // Browser data first: a profile left with a new fingerprint and its old cookies would link the two.
  const wipe = async (next: Profile) => {
    await launcher.resetUserData(profileId);
    store.resetIdentity(next);
    // Sessions this device kept of the old identity must not come back onto the new one.
    cloudBrowser?.discardSessions?.(profileId);
  };

  if (cloudBrowser) {
    if (!deps.cloudClient) throw new NewIdentityError("AliasMode Cloud connection is unavailable", 503);
    // Every refusal comes before the browser closes. An upload still owed to Cloud would race the empty session.
    const current = await deps.cloudClient.getProfile(profileId);
    if (current.profile.permission !== "edit") throw new NewIdentityError("You can view this Cloud profile but not change it", 403);
    if (current.profile.activeOpens.length > (launch ? 1 : 0)) {
      throw new NewIdentityError("profile is open on another device; close it there first", 409);
    }
    const blocked = cloudBrowser.newIdentityBlocked?.(profileId);
    if (blocked) throw new NewIdentityError(blocked, 409);
    if (launch && !(await cloudBrowser.close(profileId)).closed) {
      throw new NewIdentityError("browser teardown unconfirmed", 500);
    }
    // Only the close's own upload can still be under way.
    const unsaved = cloudBrowser.newIdentityBlocked?.(profileId);
    if (unsaved) throw new NewIdentityError(unsaved, 409);
    let wiped = false;
    // Other computers delete their copy of the profile's data once when they open it while Cloud holds this token.
    const token = crypto.randomUUID();
    try {
      await new CloudProfileEditor(deps.cloudClient, store).newIdentity(profileId, fresh, async (next) => {
        await wipe(next);
        wiped = true;
        // This computer has applied it already.
        launcher.recordNewIdentity(profileId, token);
      }, token);
    } catch (error) {
      if (!wiped) throw error;
      // Nothing links: this computer holds an empty folder, and Cloud still the old identity.
      throw new NewIdentityError(
        `This profile's browser data on this computer was deleted, but Cloud did not save the new identity: ${error instanceof Error ? error.message : String(error)}. Start a new identity again.`,
        newIdentityErrorStatus(error),
      );
    }
  } else {
    const profile = store.getProfile(profileId);
    if (!profile) throw new NewIdentityError("no such profile", 404);
    if (launch && !(await launcher.stop(profileId, launch))) throw new NewIdentityError("browser teardown unconfirmed", 500);
    await wipe(fresh(profile));
  }

  if (!launch) return { profileId, reopened: false };
  try {
    if (cloudBrowser) {
      const opened = await cloudBrowser.open(profileId, [], headless);
      if (!opened.ok) throw new Error(opened.error ?? "open failed");
      return { profileId, reopened: true, ...(opened.warning ? { warning: opened.warning } : {}) };
    }
    await launcher.start(profileId, [], headless);
    return { profileId, reopened: true };
  } catch (error) {
    return {
      profileId,
      reopened: false,
      warning: `The new identity is ready, but the profile did not open again: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
