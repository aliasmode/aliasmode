import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { discoverRuntime } from "./runtime-client.mjs";
import { PlaywrightToolProxy } from "./playwright-proxy.mjs";

const VERSION = process.env.ALIASMODE_APP_VERSION || "0.1.0-beta.32";
const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };
const PROFILE_ID = { type: "string", minLength: 1 };
const PROXY_REPLACEMENT_ROW = {
  type: "object",
  properties: {
    profileId: PROFILE_ID,
    username: { type: "string", minLength: 1, maxLength: 255 },
    expectedVersion: { type: "integer", minimum: 1 },
    proxy: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["http", "https", "socks5"] },
        host: { type: "string" },
        port: { type: "string" },
        user: { type: "string" },
        pass: { type: "string" },
      },
      required: ["type", "host", "port", "user", "pass"],
      additionalProperties: false,
    },
  },
  required: ["proxy"],
  oneOf: [
    { required: ["profileId"], not: { required: ["username"] } },
    { required: ["username"], not: { required: ["profileId"] } },
  ],
  additionalProperties: false,
};

function diagnose(message) {
  if (process.env.ALIASMODE_MCP_DIAGNOSTICS === "1") {
    process.stderr.write(`[aliasmode-mcp-host] ${message}\n`);
  }
}

function toolAnnotations(title, { readOnly = false, destructive = false, openWorld = false } = {}) {
  return {
    title,
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    openWorldHint: openWorld,
  };
}

const ALIAS_TOOLS = [
  {
    name: "aliasmode_profiles_list",
    description: "List AliasMode profiles and their current browser state.",
    annotations: toolAnnotations("List AliasMode profiles"),
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: "aliasmode_profiles_replace_proxies",
    description: "Dry-run or apply bulk proxy replacements to closed AliasMode Cloud profiles. Apply always preflights first.",
    annotations: toolAnnotations("Replace AliasMode profile proxies", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", default: true },
        replacements: {
          type: "array",
          minItems: 1,
          items: PROXY_REPLACEMENT_ROW,
        },
        csv: { type: "string", minLength: 1 },
      },
      oneOf: [
        { required: ["replacements"], not: { required: ["csv"] } },
        { required: ["csv"], not: { required: ["replacements"] } },
      ],
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_profile_create",
    description: "Create a persistent AliasMode profile, or an explicit temporary profile.",
    annotations: toolAnnotations("Create an AliasMode profile"),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        group: { type: "string" },
        platform: { type: "string" },
        screen: { type: "string" },
        proxy: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              properties: {
                type: { type: "string", enum: ["http", "https", "socks5"] },
                host: { type: "string" },
                port: { type: "string" },
                user: { type: "string" },
                pass: { type: "string" },
              },
              additionalProperties: false,
            },
          ],
        },
        temporary: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_profile_delete",
    description: "Delete a closed AliasMode profile.",
    annotations: toolAnnotations("Delete an AliasMode profile", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: { profileId: PROFILE_ID },
      required: ["profileId"],
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_browser_open",
    description: "Open an AliasMode browser and select it for Playwright actions.",
    annotations: toolAnnotations("Open an AliasMode browser", { destructive: true, openWorld: true }),
    inputSchema: {
      type: "object",
      properties: {
        profileId: PROFILE_ID,
        headless: { type: "boolean", default: false },
        startupUrls: {
          type: "array",
          items: { type: "string", pattern: "^https?://" },
        },
        select: { type: "boolean", default: true },
      },
      required: ["profileId"],
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_browser_select",
    description: "Select an open AliasMode browser for subsequent Playwright actions.",
    annotations: toolAnnotations("Select an AliasMode browser", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: { profileId: PROFILE_ID },
      required: ["profileId"],
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_browser_status",
    description: "Get the selected browser state, or the state of one profile.",
    annotations: toolAnnotations("Get AliasMode browser status", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: { profileId: PROFILE_ID },
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_browser_close",
    description: "Safely capture and close one AliasMode browser.",
    annotations: toolAnnotations("Close an AliasMode browser", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: { profileId: PROFILE_ID },
      additionalProperties: false,
    },
  },
  {
    name: "browser_close",
    description: "Safely capture and close the selected AliasMode browser.",
    annotations: toolAnnotations("Close the selected AliasMode browser", { destructive: true }),
    inputSchema: EMPTY_SCHEMA,
  },
];

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function safeError(error) {
  const message = error instanceof Error ? error.message : "AliasMode operation failed";
  return message.replace(/wss?:\/\/\S+/gi, "CDP endpoint").slice(0, 500);
}

function errorResult(error) {
  return {
    isError: true,
    content: [{ type: "text", text: safeError(error) }],
  };
}

function profileInput(args) {
  const { temporary = false, ...input } = args;
  return { input, temporary };
}

export async function createAliasModeMcp(options = {}) {
  const playwright = options.playwright ?? new PlaywrightToolProxy(VERSION);
  await playwright.initialize();
  const discovered = options.discovered ?? await discoverRuntime(options.runtime);
  const runtime = discovered.client;
  const server = new Server(
    { name: "aliasmode", version: VERSION },
    { capabilities: { tools: {} } },
  );
  let selectedProfileId;
  const ownedProfileIds = new Set();
  let closing;

  const selectBrowser = async (profileId, knownStatus) => {
    const status = knownStatus ?? await runtime.call("browser.status", { profileId });
    if (!status.running || !status.ws) throw new Error("open this AliasMode profile before selecting it");
    selectedProfileId = undefined;
    await playwright.attach(status.ws);
    selectedProfileId = profileId;
    return {
      profileId,
      selected: true,
      running: true,
      port: status.port,
      headless: status.headless,
    };
  };

  const closeBrowser = async (profileId) => {
    const target = profileId || selectedProfileId;
    if (!target) throw new Error("select an open AliasMode browser first");
    const selected = target === selectedProfileId;
    if (selected) await playwright.detach();
    try {
      const result = await runtime.call("browser.close", { profileId: target });
      ownedProfileIds.delete(target);
      if (selected) selectedProfileId = undefined;
      return result;
    } catch (error) {
      if (selected) {
        const status = await runtime.call("browser.status", { profileId: target }).catch(() => undefined);
        if (status?.running && status.ws) await playwright.attach(status.ws).catch(() => {});
      }
      throw error;
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...ALIAS_TOOLS, ...playwright.listTools()],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      if (name === "aliasmode_profiles_list") {
        return toolResult(await runtime.call("profiles.list"));
      }
      if (name === "aliasmode_profiles_replace_proxies") {
        return toolResult(await runtime.call("profiles.replaceProxies", args));
      }
      if (name === "aliasmode_profile_create") {
        return toolResult(await runtime.call("profiles.create", profileInput(args)));
      }
      if (name === "aliasmode_profile_delete") {
        return toolResult(await runtime.call("profiles.delete", { profileId: args.profileId }));
      }
      if (name === "aliasmode_browser_open") {
        const opened = await runtime.call("browser.open", {
          profileId: args.profileId,
          ...(args.headless !== undefined ? { headless: args.headless } : {}),
          ...(args.startupUrls ? { startupUrls: args.startupUrls } : {}),
        });
        if (opened.ownedByConnection) ownedProfileIds.add(args.profileId);
        if (args.select !== false) {
          try {
            await selectBrowser(args.profileId, {
              running: true,
              ws: opened.ws,
              port: opened.port,
              headless: opened.headless,
            });
          } catch (error) {
            if (opened.ownedByConnection) {
              const closed = await runtime.call("browser.close", { profileId: args.profileId })
                .then(() => true, () => false);
              if (closed) ownedProfileIds.delete(args.profileId);
            }
            throw error;
          }
        }
        return toolResult({
          profileId: opened.profileId,
          port: opened.port,
          headless: opened.headless,
          alreadyOpen: opened.alreadyOpen,
          selected: args.select !== false,
        });
      }
      if (name === "aliasmode_browser_select") {
        return toolResult(await selectBrowser(args.profileId));
      }
      if (name === "aliasmode_browser_status") {
        const profileId = args.profileId || selectedProfileId;
        if (!profileId) throw new Error("select an open AliasMode browser first");
        const status = await runtime.call("browser.status", { profileId });
        const { ws: _ws, ...safeStatus } = status;
        return toolResult({ ...safeStatus, selected: profileId === selectedProfileId });
      }
      if (name === "aliasmode_browser_close" || name === "browser_close") {
        return toolResult(await closeBrowser(args.profileId));
      }
      if (!selectedProfileId) throw new Error("select an open AliasMode browser first");
      if (!playwright.listTools().some((tool) => tool.name === name)) {
        throw new Error(`unknown AliasMode tool: ${name}`);
      }
      return await playwright.callTool(name, args);
    } catch (error) {
      return errorResult(error);
    }
  });

  const close = async () => {
    if (closing) return closing;
    closing = (async () => {
      diagnose("close started");
      await playwright.detach();
      diagnose("playwright detached");
      for (const profileId of [...ownedProfileIds]) {
        diagnose("owned browser close started");
        const closed = await runtime.call("browser.close", { profileId })
          .then(() => true, () => false);
        diagnose(`owned browser close finished closed=${closed}`);
        if (closed) ownedProfileIds.delete(profileId);
      }
      runtime.close();
      diagnose("runtime closed");
    })();
    return closing;
  };
  server.onclose = () => { void close(); };
  return { server, close };
}

export function sanitizeEnvironment(env = process.env) {
  const allowed = new Set([
    "APPDATA", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH",
    "ALIASMODE_APP_VERSION", "ALIASMODE_DESKTOP_EXE", "ALIASMODE_MCP_DIAGNOSTICS",
    "ALIASMODE_RUNTIME_DESCRIPTOR",
    "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE",
  ]);
  for (const key of Object.keys(env)) {
    if (!allowed.has(key.toUpperCase())) delete env[key];
  }
}

async function main() {
  sanitizeEnvironment();
  const desktopExecutable = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "AliasMode.exe",
  );
  const host = await createAliasModeMcp({ runtime: { desktopExecutable } });
  let shuttingDown = false;
  const shutdown = (event = "signal") => {
    if (shuttingDown) return;
    shuttingDown = true;
    diagnose(`shutdown requested event=${event}`);
    void host.close().finally(() => {
      diagnose("shutdown complete");
      process.exit(0);
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.stdin.once("end", () => shutdown("stdin-end"));
  process.stdin.once("close", () => shutdown("stdin-close"));
  await host.server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`AliasMode MCP could not start: ${safeError(error)}`);
    console.error("Run AliasMode setup again or open the app once.");
    process.exit(1);
  });
}
