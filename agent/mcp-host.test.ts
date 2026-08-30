import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAliasModeMcp, sanitizeEnvironment } from "./mcp-host.mjs";

class FakeRuntime {
  events: string[] = [];
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  closed = false;

  async call(method: string, params: Record<string, unknown> = {}) {
    this.events.push(`${method}:${params.profileId ?? ""}`);
    this.calls.push({ method, params: structuredClone(params) });
    if (method === "profiles.list") return { profiles: [] };
    if (method === "profiles.replaceProxies") {
      return {
        ok: true,
        dryRun: params.dryRun !== false,
        counts: { received: 1, matched: 1, ready: 1, updated: 0, unchanged: 0, missing: 0, skipped: 0 },
        results: [{ index: 0, status: "ready", profileId: "profile-1", currentVersion: 4 }],
        missingUsernames: [],
      };
    }
    if (method === "browser.open") {
      const ownedByConnection = params.profileId !== "existing";
      return {
        profileId: params.profileId,
        ws: "ws://127.0.0.1:9333/devtools/browser/test",
        port: 9333,
        headless: params.headless === true,
        alreadyOpen: !ownedByConnection,
        ownedByConnection,
      };
    }
    if (method === "browser.status") {
      return {
        profileId: params.profileId,
        running: true,
        ws: "ws://127.0.0.1:9333/devtools/browser/test",
        port: 9333,
        headless: false,
      };
    }
    if (method === "browser.close") return { profileId: params.profileId, closed: true, deleted: false };
    throw new Error(`unexpected runtime method ${method}`);
  }

  close() {
    this.closed = true;
    this.events.push("runtime.close:");
  }
}

class FakePlaywright {
  events: string[] = [];
  tools = [{
    name: "browser_snapshot",
    description: "snapshot",
    inputSchema: { type: "object", properties: {} },
    annotations: {
      title: "Browser snapshot",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  }];
  failNextAttach = false;

  async initialize() {
    this.events.push("initialize");
  }

  async attach(endpoint: string) {
    this.events.push(`attach:${endpoint}`);
    if (this.failNextAttach) {
      this.failNextAttach = false;
      throw new Error("attach failed");
    }
  }

  listTools() {
    return this.tools;
  }

  async callTool(name: string) {
    this.events.push(`call:${name}`);
    return { content: [{ type: "text", text: "snapshot" }] };
  }

  async detach() {
    this.events.push("detach");
  }
}

test("MCP host preserves Windows environment keys case-insensitively", () => {
  const env: Record<string, string> = {
    APPDATA: "appdata",
    Path: "system path",
    TEMP: "temp",
    ALIASMODE_LIVE_PROXY_PASS: "secret",
    GITHUB_TOKEN: "secret",
  };
  sanitizeEnvironment(env);
  expect(env).toEqual({ APPDATA: "appdata", Path: "system path", TEMP: "temp" });
});

test("MCP lifecycle tools include directory annotations", async () => {
  const host = await createAliasModeMcp({
    discovered: { client: new FakeRuntime() },
    playwright: new FakePlaywright(),
  });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);

  const tools = (await client.listTools()).tools;
  const annotated = tools.filter((tool) => tool.name.startsWith("aliasmode_") || tool.name === "browser_close");
  for (const tool of annotated) {
    expect(typeof tool.annotations?.title).toBe("string");
    expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
    expect(typeof tool.annotations?.destructiveHint).toBe("boolean");
    expect(typeof tool.annotations?.openWorldHint).toBe("boolean");
  }
  expect(tools.find((tool) => tool.name === "aliasmode_profiles_list")?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  });
  expect(tools.find((tool) => tool.name === "aliasmode_profile_delete")?.annotations?.destructiveHint).toBe(true);
  expect(tools.find((tool) => tool.name === "aliasmode_profiles_replace_proxies")?.annotations?.destructiveHint).toBe(true);
  expect(tools.find((tool) => tool.name === "aliasmode_browser_open")?.annotations).toMatchObject({
    destructiveHint: true,
    openWorldHint: true,
  });
  expect(tools.find((tool) => tool.name === "aliasmode_browser_select")?.annotations?.destructiveHint).toBe(true);
  expect(tools.find((tool) => tool.name === "aliasmode_browser_status")?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  });
  expect(tools.find((tool) => tool.name === "aliasmode_browser_close")?.annotations?.destructiveHint).toBe(true);
  expect(tools.find((tool) => tool.name === "browser_close")?.annotations?.destructiveHint).toBe(true);

  await client.close();
  await host.close();
});

test("MCP host exposes strict proxy replacement input and forwards safe results", async () => {
  const runtime = new FakeRuntime();
  const host = await createAliasModeMcp({
    discovered: { client: runtime },
    playwright: new FakePlaywright(),
  });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);

  const listed = await client.listTools();
  const tool = listed.tools.find((candidate) => candidate.name === "aliasmode_profiles_replace_proxies");
  expect(tool?.inputSchema).toMatchObject({
    type: "object",
    properties: {
      dryRun: { type: "boolean", default: true },
      replacements: { type: "array", minItems: 1 },
      csv: { type: "string", minLength: 1 },
    },
    additionalProperties: false,
  });
  expect((tool?.inputSchema as { oneOf?: unknown[] }).oneOf).toHaveLength(2);

  const replacement = {
    username: "exact-user",
    proxy: { type: "socks5", host: "proxy.test", port: "1080", user: "proxy-user", pass: "private-pass" },
  };
  const structured = await client.callTool({
    name: "aliasmode_profiles_replace_proxies",
    arguments: { dryRun: true, replacements: [replacement] },
  });
  expect(structured.isError).not.toBe(true);
  expect(runtime.calls.at(-1)).toEqual({
    method: "profiles.replaceProxies",
    params: { dryRun: true, replacements: [replacement] },
  });
  expect(JSON.stringify(structured)).not.toContain("private-pass");
  expect(structured.structuredContent).toMatchObject({
    dryRun: true,
    counts: { ready: 1 },
    results: [{ index: 0, status: "ready", profileId: "profile-1", currentVersion: 4 }],
  });

  const csv = "username,type,host,port,user,pass\nexact-user,http,proxy.test,8080,user,private-csv-pass";
  await client.callTool({ name: "aliasmode_profiles_replace_proxies", arguments: { csv } });
  expect(runtime.calls.at(-1)).toEqual({ method: "profiles.replaceProxies", params: { csv } });

  await client.close();
  await host.close();
});

test("MCP host exposes Playwright tools before selection and uses safe close", async () => {
  const runtime = new FakeRuntime();
  const playwright = new FakePlaywright();
  const host = await createAliasModeMcp({
    discovered: { client: runtime },
    playwright,
  });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    host.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const initial = await client.listTools();
  expect(initial.tools.some((tool) => tool.name === "browser_snapshot")).toBe(true);
  expect(initial.tools.some((tool) => tool.name === "browser_install")).toBe(false);
  expect(initial.tools.some((tool) => tool.name === "browser_close")).toBe(true);

  const opened = await client.callTool({
    name: "aliasmode_browser_open",
    arguments: { profileId: "profile1", headless: true },
  });
  expect(opened.isError).not.toBe(true);
  expect((await client.listTools()).tools.some((tool) => tool.name === "browser_snapshot")).toBe(true);

  const snapshot = await client.callTool({ name: "browser_snapshot", arguments: {} });
  expect(snapshot.content).toEqual([{ type: "text", text: "snapshot" }]);

  const closed = await client.callTool({ name: "browser_close", arguments: {} });
  expect(closed.isError).not.toBe(true);
  expect(playwright.events).toEqual([
    "initialize",
    "attach:ws://127.0.0.1:9333/devtools/browser/test",
    "call:browser_snapshot",
    "detach",
  ]);
  expect(runtime.events).toContain("browser.close:profile1");
  expect((await client.listTools()).tools.some((tool) => tool.name === "browser_snapshot")).toBe(true);

  await client.close();
  await host.close();
  expect(runtime.closed).toBe(true);
});

test("MCP shutdown closes owned browsers but preserves pre-existing browsers", async () => {
  const runtime = new FakeRuntime();
  const host = await createAliasModeMcp({
    discovered: { client: runtime },
    playwright: new FakePlaywright(),
  });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);

  await client.callTool({
    name: "aliasmode_browser_open",
    arguments: { profileId: "existing" },
  });
  await client.callTool({
    name: "aliasmode_browser_open",
    arguments: { profileId: "owned" },
  });
  await client.close();
  await host.close();

  expect(runtime.events).toContain("browser.close:owned");
  expect(runtime.events).not.toContain("browser.close:existing");
  expect(runtime.events.at(-1)).toBe("runtime.close:");
});

test("a failed profile switch clears the stale selection", async () => {
  const runtime = new FakeRuntime();
  const playwright = new FakePlaywright();
  const host = await createAliasModeMcp({ discovered: { client: runtime }, playwright });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);

  await client.callTool({
    name: "aliasmode_browser_open",
    arguments: { profileId: "profile1" },
  });
  playwright.failNextAttach = true;
  const switched = await client.callTool({
    name: "aliasmode_browser_select",
    arguments: { profileId: "profile2" },
  });
  expect(switched.isError).toBe(true);
  expect((await client.listTools()).tools.some((tool) => tool.name === "browser_snapshot")).toBe(true);
  const status = await client.callTool({ name: "aliasmode_browser_status", arguments: {} });
  expect(status.isError).toBe(true);

  await client.close();
  await host.close();
});

test("browser actions require one selected profile", async () => {
  const runtime = new FakeRuntime();
  const playwright = new FakePlaywright();
  const host = await createAliasModeMcp({ discovered: { client: runtime }, playwright });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({ name: "browser_snapshot", arguments: {} });
  expect(result.isError).toBe(true);
  expect((result.content as Array<{ text?: string }>)[0]).toMatchObject({ text: "select an open AliasMode browser first" });

  await client.close();
  await host.close();
});
