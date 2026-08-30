import { describe, expect, test } from "bun:test";
import { AGENT_CONTROL_MAX_MESSAGE_BYTES } from "./agent-control.ts";
import type {
  ProxyReplacementResult,
  ProxyReplacementsRequest,
  ProxyReplacementsResponse,
} from "./contracts/cloud-v1.ts";
import {
  parseProxyReplacementCsv,
  ProxyReplacementInputError,
  runProxyReplacements,
} from "./proxy-replacements.ts";

const proxy = {
  type: "socks5" as const,
  host: "proxy.test",
  port: "1080",
  user: "proxy-user",
  pass: "proxy-secret",
};

function response(
  dryRun: boolean,
  results: ProxyReplacementResult[],
  missingUsernames: string[] = [],
): ProxyReplacementsResponse {
  return {
    ok: true,
    dryRun,
    counts: {
      received: results.length,
      matched: results.filter((result) => !!result.profileId).length,
      ready: results.filter((result) => result.status === "ready").length,
      updated: results.filter((result) => result.status === "updated").length,
      unchanged: results.filter((result) => result.status === "unchanged").length,
      missing: results.filter((result) => result.status === "missing").length,
      skipped: results.filter((result) => result.status === "skipped").length,
    },
    results,
    missingUsernames,
  };
}

describe("proxy replacement coordination", () => {
  test("defaults structured replacements to one Cloud dry-run", async () => {
    const calls: ProxyReplacementsRequest[] = [];
    const client = {
      async replaceProfileProxies(request: ProxyReplacementsRequest) {
        calls.push(structuredClone(request));
        return {
          ...response(true, [{ index: 0, status: "ready", profileId: "profile-1", currentVersion: 7 }]),
          leaked: proxy.pass,
          missingUsernames: [proxy.pass],
          results: [{
            index: 0,
            status: "ready",
            profileId: "profile-1",
            currentVersion: 7,
            proxy: { pass: proxy.pass },
          }],
        } as unknown as ProxyReplacementsResponse;
      },
    };
    const replacements = [{ username: "exact-user", proxy }];

    const result = await runProxyReplacements(client, { replacements });

    expect(calls).toEqual([{ dryRun: true, replacements }]);
    expect(result).toEqual(response(true, [
      { index: 0, status: "ready", profileId: "profile-1", currentVersion: 7 },
    ]));
    expect(JSON.stringify(result)).not.toContain(proxy.pass);
  });

  test("parses BOM, CRLF, quoted fields, commas, and escaped quotes", () => {
    const csv = "﻿username,type,host,port,user,pass,expectedVersion\r\n" +
      '"account,one",SOCKS5,"[2001:db8::1]",01080,"proxy,user","p,a""ss",7\r\n';

    expect(parseProxyReplacementCsv(csv) as unknown).toEqual([{
      username: "account,one",
      proxy: {
        type: "SOCKS5",
        host: "[2001:db8::1]",
        port: "01080",
        user: "proxy,user",
        pass: 'p,a"ss',
      },
      expectedVersion: 7,
    }]);
  });

  test("rejects malformed CSV and invalid selector headers without exposing records", () => {
    const cases = [
      'username,type,host,port,user,pass\n"private-record,http,host,80,,',
      "type,host,port,user,pass\nhttp,host,80,,",
      "username,profileId,type,host,port,user,pass\nuser,id,http,host,80,,",
      "username,type,host,port,user,pass,extra\nuser,http,host,80,,,secret-value",
      "username,type,host,port,user,pass\n",
    ];
    for (const csv of cases) {
      expect(() => parseProxyReplacementCsv(csv)).toThrow(ProxyReplacementInputError);
      try {
        parseProxyReplacementCsv(csv);
      } catch (error) {
        expect(String(error)).not.toContain("private-record");
        expect(String(error)).not.toContain("secret-value");
      }
    }
  });

  test("preflights apply, targets canonical IDs, and remaps compact apply results", async () => {
    const replacements = [
      { username: "ready-user", proxy: { ...proxy, pass: "ready-secret" } },
      { username: "missing-user", proxy: { ...proxy, pass: "missing-secret" } },
      { profileId: "bad-profile", proxy: { ...proxy, pass: "bad-secret" } },
      { profileId: "ready-profile", expectedVersion: 9, proxy: { ...proxy, pass: "second-secret" } },
    ];
    const calls: ProxyReplacementsRequest[] = [];
    const client = {
      async replaceProfileProxies(request: ProxyReplacementsRequest) {
        calls.push(structuredClone(request));
        if (request.dryRun) {
          return response(true, [
            { index: 0, status: "ready", profileId: "canonical-1", currentVersion: 5 },
            { index: 1, status: "missing", code: "no_editable_match" },
            { index: 2, status: "skipped", code: "invalid_proxy" },
            { index: 3, status: "ready", profileId: "ready-profile", currentVersion: 9 },
          ], ["missing-user"]);
        }
        return response(false, [
          { index: 0, status: "updated", profileId: "canonical-1", previousVersion: 5, version: 6 },
          { index: 1, status: "skipped", code: "version_conflict", profileId: "ready-profile", currentVersion: 10 },
        ]);
      },
    };

    const result = await runProxyReplacements(client, { dryRun: false, replacements });

    expect(calls).toEqual([
      { dryRun: true, replacements },
      {
        dryRun: false,
        replacements: [
          { profileId: "canonical-1", expectedVersion: 5, proxy: replacements[0]!.proxy },
          { profileId: "ready-profile", expectedVersion: 9, proxy: replacements[3]!.proxy },
        ],
      },
    ]);
    expect(result).toEqual(response(false, [
      { index: 0, status: "updated", profileId: "canonical-1", previousVersion: 5, version: 6 },
      { index: 1, status: "missing", code: "no_editable_match" },
      { index: 2, status: "skipped", code: "invalid_proxy" },
      { index: 3, status: "skipped", code: "version_conflict", profileId: "ready-profile", currentVersion: 10 },
    ], ["missing-user"]));
    for (const secret of ["ready-secret", "missing-secret", "bad-secret", "second-secret"]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  test("reports a username that becomes inaccessible between preflight and apply", async () => {
    let calls = 0;
    const client = {
      async replaceProfileProxies(request: ProxyReplacementsRequest) {
        calls++;
        return request.dryRun
          ? response(true, [{ index: 0, status: "ready", profileId: "canonical-1", currentVersion: 5 }])
          : response(false, [{ index: 0, status: "missing", code: "no_editable_match" }]);
      },
    };

    const result = await runProxyReplacements(client, {
      dryRun: false,
      replacements: [{ username: "raced-user", proxy }],
    });

    expect(result.results).toEqual([{ index: 0, status: "missing", code: "no_editable_match" }]);
    expect(result.missingUsernames).toEqual(["raced-user"]);
    expect(calls).toBe(2);
  });

  test("apply stops after preflight when no rows are ready", async () => {
    let calls = 0;
    const client = {
      async replaceProfileProxies() {
        calls++;
        return response(true, [{ index: 0, status: "missing", code: "no_editable_match" }], ["missing-user"]);
      },
    };

    expect(await runProxyReplacements(client, {
      dryRun: false,
      replacements: [{ username: "missing-user", proxy }],
    })).toEqual(response(false, [{ index: 0, status: "missing", code: "no_editable_match" }], ["missing-user"]));
    expect(calls).toBe(1);
  });

  test("requires a strict top-level input shape", async () => {
    const client = { replaceProfileProxies: async () => response(true, []) };
    const invalid = [
      {},
      { replacements: [], csv: "x" },
      { replacements: [] },
      { csv: "" },
      { csv: "username,type,host,port,user,pass\nuser,http,host,80,,", dryRun: "false" },
      { csv: "username,type,host,port,user,pass\nuser,http,host,80,,", extra: true },
    ];
    for (const input of invalid) {
      await expect(runProxyReplacements(client, input)).rejects.toBeInstanceOf(ProxyReplacementInputError);
    }
  });

  test("keeps a 1,645-row Agent Control request below the existing message limit", async () => {
    const replacements = Array.from({ length: 1_645 }, (_, index) => ({
      username: `account-${index.toString().padStart(4, "0")}`,
      proxy: {
        type: "socks5" as const,
        host: "representative-subscription-host.example",
        port: "65535",
        user: "representative-subscription-user",
        pass: "representative-subscription-password",
      },
    }));
    const message = JSON.stringify({
      protocol: "aliasmode-agent-v1",
      id: 1,
      method: "profiles.replaceProxies",
      params: { replacements },
    });
    expect(Buffer.byteLength(message)).toBeLessThan(AGENT_CONTROL_MAX_MESSAGE_BYTES);

    let received = 0;
    const client = {
      async replaceProfileProxies(request: ProxyReplacementsRequest) {
        received = request.replacements.length;
        return response(true, request.replacements.map((_, index) => ({
          index,
          status: "missing",
          code: "no_editable_match",
        })));
      },
    };
    await runProxyReplacements(client, { replacements });
    expect(received).toBe(1_645);
  });
});
