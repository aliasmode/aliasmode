import { expect, test } from "bun:test";
// @ts-expect-error ws does not bundle TypeScript declarations.
import WebSocket from "ws";
import {
  AGENT_CONTROL_PATH,
  AGENT_CONTROL_PROTOCOL,
} from "./agent-control.ts";
import { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import { ProfileStore } from "./store.ts";
import { serveDashboard } from "./web.ts";

function openSocket(url: string, nonce: string): Promise<WebSocket> {
  const socket = new WebSocket(url, AGENT_CONTROL_PROTOCOL, {
    headers: { Authorization: `Bearer ${nonce}` },
  });
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

test("agent WebSocket requires its separate nonce and serves protocol requests", async () => {
  const nonce = "a".repeat(64);
  const store = new ProfileStore(":memory:");
  const launcher = {
    reconcileOrphans: async () => {},
  };
  const server = serveDashboard({
    launcher: launcher as any,
    store,
    port: 0,
    agentNonce: nonce,
    lifecycleAdmission: new LifecycleAdmissionController(),
    log: () => {},
  });
  const endpoint = `http://127.0.0.1:${server.port}${AGENT_CONTROL_PATH}`;

  try {
    const missing = await fetch(endpoint, {
      headers: { "sec-websocket-protocol": AGENT_CONTROL_PROTOCOL },
    });
    expect(missing.status).toBe(401);

    const socket = await openSocket(endpoint.replace("http:", "ws:"), nonce);
    const response = new Promise<any>((resolve) => {
      socket.once("message", (data: Buffer) => resolve(JSON.parse(data.toString("utf8"))));
    });
    socket.send(JSON.stringify({
      protocol: AGENT_CONTROL_PROTOCOL,
      id: 9,
      method: "profiles.list",
      params: {},
    }));
    expect(await response).toEqual({
      protocol: AGENT_CONTROL_PROTOCOL,
      id: 9,
      ok: true,
      result: { profiles: [] },
    });
    socket.close();
  } finally {
    await server.stop(true);
    store.close();
  }
});
