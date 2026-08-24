import { expect, test } from "bun:test";
import {
  AGENT_CONTROL_MAX_MESSAGE_BYTES,
  AGENT_CONTROL_PROTOCOL,
  AgentControlSession,
  parseAgentControlRequest,
  validAgentAuthorization,
} from "./agent-control.ts";

function wire(method: string, params: Record<string, unknown> = {}, id = 1): string {
  return JSON.stringify({ protocol: AGENT_CONTROL_PROTOCOL, id, method, params });
}

function harness(options: {
  active?: boolean;
  stopResult?: boolean;
  temporary?: boolean;
} = {}) {
  const events: string[] = [];
  let launch = options.active
    ? {
        profileId: "profile1",
        pid: 11,
        debugPort: 9333,
        ws: "ws://127.0.0.1:9333/devtools/browser/test",
        startedAt: 1,
        headless: true,
      }
    : null;
  let profileExists = true;
  let temporary = options.temporary ?? false;
  const store = {
    getLaunch: (id: string) => id === "profile1" ? launch : null,
    listAgentTemporary: () => temporary ? ["profile1"] : [],
    clearAgentTemporary: (id: string) => {
      events.push(`clear-temp:${id}`);
      temporary = false;
    },
    getProfile: (id: string) => id === "profile1" && profileExists ? { id } : null,
    deleteProfile: (id: string) => {
      events.push(`delete:${id}`);
      profileExists = false;
      temporary = false;
      return true;
    },
  };
  const launcher = {
    certifiedActive: async () => options.active ?? false,
    start: async (_id: string, _urls: string[], open: { headless?: boolean }) => {
      events.push(`start:${open.headless ?? false}`);
      launch = {
        profileId: "profile1",
        pid: 12,
        debugPort: 9444,
        ws: "ws://127.0.0.1:9444/devtools/browser/new",
        startedAt: 2,
        headless: open.headless,
      } as typeof launch;
      return {
        ws: "ws://127.0.0.1:9444/devtools/browser/new",
        port: 9444,
      };
    },
    stop: async (id: string) => {
      events.push(`stop:${id}`);
      if (options.stopResult === false) return false;
      launch = null;
      return true;
    },
    profileDeletionBlocked: () => false,
    removeUserDataDir: (id: string) => events.push(`remove-data:${id}`),
  };
  const admission = {
    run: async (_operation: unknown, fn: () => Promise<unknown>) => await fn(),
  };
  return {
    events,
    session: new AgentControlSession({
      launcher: launcher as any,
      store: store as any,
      admission: admission as any,
    }),
    temporary: () => temporary,
    profileExists: () => profileExists,
  };
}

test("agent protocol validates message shape, size, and authorization", () => {
  expect(parseAgentControlRequest(wire("profiles.list", {}, 7))).toEqual({
    protocol: AGENT_CONTROL_PROTOCOL,
    id: 7,
    method: "profiles.list",
    params: {},
  });
  expect(() => parseAgentControlRequest("{}"))
    .toThrow("invalid protocol shape");
  expect(() => parseAgentControlRequest(new Uint8Array(AGENT_CONTROL_MAX_MESSAGE_BYTES + 1)))
    .toThrow("request size is invalid");

  const nonce = "a".repeat(64);
  expect(validAgentAuthorization(`Bearer ${nonce}`, nonce)).toBe(true);
  expect(validAgentAuthorization(null, nonce)).toBe(false);
  expect(validAgentAuthorization(`Bearer ${"b".repeat(64)}`, nonce)).toBe(false);
});

test("disconnect closes a browser opened by this connection", async () => {
  const h = harness();
  const response = await h.session.enqueue(wire("browser.open", {
    profileId: "profile1",
    headless: true,
  }));

  expect(response.ok).toBe(true);
  expect(response.result).toMatchObject({
    profileId: "profile1",
    headless: true,
    alreadyOpen: false,
    ownedByConnection: true,
  });

  await h.session.disconnect();
  expect(h.events).toEqual(["start:true", "stop:profile1"]);
});

test("an explicit detach transfers a CLI-opened browser out of connection cleanup", async () => {
  const h = harness();
  await h.session.enqueue(wire("browser.open", { profileId: "profile1" }));
  const detached = await h.session.enqueue(wire("browser.detach", { profileId: "profile1" }));
  expect(detached).toMatchObject({ ok: true, result: { detached: true } });

  await h.session.disconnect();
  expect(h.events).toEqual(["start:false"]);
});

test("disconnect detaches from an existing browser without closing it", async () => {
  const h = harness({ active: true });
  const response = await h.session.enqueue(wire("browser.open", {
    profileId: "profile1",
    headless: true,
  }));

  expect(response.result).toMatchObject({
    alreadyOpen: true,
    ownedByConnection: false,
  });
  await h.session.disconnect();
  expect(h.events).toEqual([]);
});

test("an existing browser rejects a launch-mode change", async () => {
  const h = harness({ active: true });
  const response = await h.session.enqueue(wire("browser.open", {
    profileId: "profile1",
    headless: false,
  }));

  expect(response).toMatchObject({
    ok: false,
    error: { code: "mode_conflict" },
  });
  await h.session.disconnect();
  expect(h.events).toEqual([]);
});

test("temporary profiles delete only after confirmed browser close", async () => {
  const h = harness({ active: true, temporary: true });
  const response = await h.session.enqueue(wire("browser.close", {
    profileId: "profile1",
  }));

  expect(response).toMatchObject({ ok: true, result: { closed: true, deleted: true } });
  expect(h.events).toEqual([
    "stop:profile1",
    "remove-data:profile1",
    "delete:profile1",
  ]);
  expect(h.temporary()).toBe(false);
  expect(h.profileExists()).toBe(false);
});

test("an unconfirmed close retains the temporary profile marker", async () => {
  const h = harness({ active: true, temporary: true, stopResult: false });
  const response = await h.session.enqueue(wire("browser.close", {
    profileId: "profile1",
  }));

  expect(response).toMatchObject({
    ok: false,
    error: { code: "close_unconfirmed" },
  });
  expect(h.events).toEqual(["stop:profile1"]);
  expect(h.temporary()).toBe(true);
  expect(h.profileExists()).toBe(true);
});
