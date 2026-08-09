import { expect, test } from "bun:test";
import { serveDashboard } from "./web.ts";

test("dashboard health route blocks browser cross-origin submissions on loopback", async () => {
  let publishes = 0;
  const server = serveDashboard({
    port: 0,
    launcher: {} as any,
    store: {} as any,
    remote: {
      publishAutomationHealthSnapshot: async () => {
        publishes++;
        return { profiles: 1, alive: 0, suspended: 1 };
      },
    } as any,
    log: () => {},
  });

  try {
    const endpoint = `http://127.0.0.1:${server.port}/api/xactions/health-snapshot`;
    const body = JSON.stringify({ profiles: [{ profileId: "p1", suspended: true }] });

    const automation = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(automation.status).toBe(200);
    expect(publishes).toBe(1);

    const browser = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body,
    });
    expect(browser.status).toBe(403);

    const simplePost = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://attacker.example" },
      body,
    });
    expect(simplePost.status).toBe(415);
    expect(publishes).toBe(1);
  } finally {
    await server.stop(true);
  }
});
