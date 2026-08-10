import { expect, test } from "bun:test";
import { CloudConnectionRuntime } from "./cloud-connection.ts";

const bootstrapResponse = {
  ok: true as const,
  account: { id: "account1", email: "user@example.com", emailVerified: true },
  workspace: { id: "workspace1", ownerAccountId: "account1", name: "Workspace", role: "owner" as const },
  device: {
    id: "device1",
    label: "Laptop",
    platform: "windows" as const,
    appVersion: "0.1.0",
    createdAt: 1,
    lastSeenAt: 1,
    revokedAt: null,
    current: true,
  },
  legal: {
    current: { terms: "1", privacy: "1", acceptableUse: "1" },
    accepted: null,
  },
  deviceCredential: "device-secret",
};

test("Cloud connection bootstraps an installation before sending device credentials", async () => {
  const headers: Array<string | null> = [];
  const connection = new CloudConnectionRuntime({
    baseUrl: "https://cloud.aliasmode.test",
    accessToken: () => "access-token",
    installation: {
      installationId: "installation1",
      label: "Laptop",
      platform: "windows",
      appVersion: "0.1.0",
    },
    fetchFn: async (_url, init) => {
      headers.push(new Headers(init?.headers).get("x-aliasmode-device"));
      return Response.json(headers.length === 1 ? bootstrapResponse : bootstrapResponse);
    },
  });

  expect((await connection.bootstrap()).deviceCredential).toBe("device-secret");
  expect(connection.accountId()).toBe("account1");
  expect(connection.deviceId()).toBe("device1");
  await connection.client.status();
  expect(headers).toEqual([null, "device-secret"]);
});

test("Cloud connection restores a credential from secure desktop storage", async () => {
  let deviceHeader = "";
  const connection = new CloudConnectionRuntime({
    baseUrl: "https://cloud.aliasmode.test",
    accessToken: () => "access-token",
    installation: {
      installationId: "installation1",
      label: "Laptop",
      platform: "windows",
      appVersion: "0.1.0",
    },
    fetchFn: async (_url, init) => {
      deviceHeader = new Headers(init?.headers).get("x-aliasmode-device") ?? "";
      return Response.json(bootstrapResponse);
    },
  });
  connection.restoreAccount("account1");
  connection.restoreDevice("device1", "stored-device-secret");
  await connection.client.status();
  expect(connection.accountId()).toBe("account1");
  expect(connection.deviceId()).toBe("device1");
  expect(deviceHeader).toBe("stored-device-secret");
});
