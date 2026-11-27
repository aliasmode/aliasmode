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
const FIREFOX_FILTERED_TOOLS = new Set(["browser_close", "browser_install", "browser_pdf_save"]);

function firefoxTools(tools) {
  return tools.filter((tool) => !FIREFOX_FILTERED_TOOLS.has(tool.name) && !/pdf/i.test(tool.name));
}

function safeBrowserResult(value) {
  if (value?.engine !== "firefox") return value;
  const {
    profileId, running, state, engine, capabilities, headless, alreadyOpen,
    ownedByConnection, attachedExisting, selected, closed, sync, deleted, detached,
  } = value;
  return {
    ...(profileId !== undefined ? { profileId } : {}),
    ...(running !== undefined ? { running } : {}),
    ...(state !== undefined ? { state } : {}),
    engine,
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(headless !== undefined ? { headless } : {}),
    ...(alreadyOpen !== undefined ? { alreadyOpen } : {}),
    ...(ownedByConnection !== undefined ? { ownedByConnection } : {}),
    ...(attachedExisting !== undefined ? { attachedExisting } : {}),
    ...(selected !== undefined ? { selected } : {}),
    ...(closed !== undefined ? { closed } : {}),
    ...(sync !== undefined ? { sync } : {}),
    ...(deleted !== undefined ? { deleted } : {}),
    ...(detached !== undefined ? { detached } : {}),
  };
}
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
    description: "List AliasMode profiles, their proxy host:port (never credentials) and current browser state. Cloud profiles include expectedVersion and permission for editing.",
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
    description: "Create a persistent AliasMode profile, or an explicit temporary profile. Without engine, Windows creates an AliasMode Chromium profile, and macOS and Linux create an AliasMode Firefox profile.",
    annotations: toolAnnotations("Create an AliasMode profile"),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        group: { type: "string" },
        platform: { type: "string" },
        engine: { type: "string", enum: ["chromium", "firefox"] },
        chromiumRuntime: {
          type: "string",
          enum: ["aliasmode", "cloakbrowser"],
          description: "Chromium profiles only. aliasmode (AliasMode Chromium 155) is the default where this computer can run it. CloakBrowser profiles on one computer can be linked to each other.",
        },
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
        proxyFrom: { ...PROFILE_ID, description: "Copy the proxy of this profile ID (credentials included) instead of passing proxy" },
        temporary: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_profile_update",
    description: "Edit a closed AliasMode profile by ID. Cloud profiles need expectedVersion from aliasmode_profiles_list. Only supplied fields change; empty strings clear fields. Sessions and cookies are preserved. Returns confirmation, not credentials.",
    annotations: toolAnnotations("Edit an AliasMode profile", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: {
        profileId: PROFILE_ID,
        proxyFrom: { ...PROFILE_ID, description: "Copy the proxy of this profile ID (credentials included) instead of set.proxy" },
        expectedVersion: { type: "integer", minimum: 0 },
        set: {
          type: "object",
          properties: {
            name: { type: "string" },
            group: { type: "string" },
            platform: { type: "string" },
            username: { type: "string" },
            password: { type: "string" },
            email: { type: "string" },
            emailPassword: { type: "string" },
            twofa: { type: "string" },
            proxy: { type: "string", description: "host:port:user:pass, or an empty string to remove the proxy" },
            proxyType: { type: "string" },
            resolution: { type: "string", description: "WIDTH*HEIGHT" },
            blockMedia: { type: "boolean", description: "Block images to save proxy traffic (Firefox profiles also stop video autoplay). Takes effect at next open." },
            extensions: { type: "array", items: { type: "string" } },
            tags: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
          },
          additionalProperties: false,
        },
      },
      required: ["profileId"],
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_profile_delete",
    description: "Move a closed AliasMode profile to Trash. Only the user can empty Trash.",
    annotations: toolAnnotations("Delete an AliasMode profile", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: { profileId: PROFILE_ID },
      required: ["profileId"],
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_profile_new_identity",
    description: "Give an AliasMode profile a new identity, like Mullvad Browser's New Identity: delete its whole browser data on this computer (cookies, logins, history, bookmarks, saved passwords, site data and add-ons installed inside the browser) and give it a new fingerprint on the same system and browser. Name, folder, proxy, login details, tags and extensions assigned in AliasMode stay. An open profile is closed and opened again. There is no undo.",
    annotations: toolAnnotations("Start a new identity for an AliasMode profile", { destructive: true }),
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
    name: "aliasmode_scripts_list",
    description: "List the user's Script Library scripts (id, name, language, description; never source code). Use an id with aliasmode_scripts_run.",
    annotations: toolAnnotations("List AliasMode library scripts", { readOnly: true }),
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: "aliasmode_scripts_get",
    description: "Read one Script Library script: its metadata, revision and full source code. Use it before changing a script.",
    annotations: toolAnnotations("Read an AliasMode library script", { readOnly: true }),
    inputSchema: {
      type: "object",
      properties: { scriptId: { type: "string", minLength: 1 } },
      required: ["scriptId"],
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_scripts_save",
    description: "Create a script in the user's own Script Library, or update one by passing its scriptId. On update, omitted fields keep their current value; source replaces the whole file. JavaScript scripts export a default async function receiving { browser, context, page, profile, inputs, credentials, log }; Python scripts define async def run(...) with the same names. Read an existing script first to match its shape.",
    annotations: toolAnnotations("Save an AliasMode library script"),
    inputSchema: {
      type: "object",
      properties: {
        scriptId: { type: "string", minLength: 1, description: "Omit to create a new script." },
        name: { type: "string" },
        description: { type: "string" },
        language: { type: "string", enum: ["javascript", "python"] },
        source: { type: "string" },
        expectedRevision: { type: "integer", minimum: 1, description: "Revision you read; the save fails if the script changed since." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_scripts_run",
    description: "Run a Script Library script on one or more profiles; AliasMode opens and closes each browser. Only one run can be active at a time, and a second request fails while one is running. Returns the run immediately: follow it with aliasmode_scripts_status and aliasmode_scripts_log.",
    annotations: toolAnnotations("Run an AliasMode library script"),
    inputSchema: {
      type: "object",
      properties: {
        scriptId: { type: "string", minLength: 1 },
        profileIds: { type: "array", minItems: 1, items: PROFILE_ID },
        inputs: { type: "object", description: "JSON inputs passed to the script." },
        headless: { type: "boolean", description: "Run the browsers hidden." },
        useCredentials: { type: "boolean", default: false, description: "Give the script the saved login details of each profile. They are shown as *** in the status and log." },
      },
      required: ["scriptId", "profileIds"],
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_scripts_status",
    description: "Get the current or last script run: its id, status (running, stopping, finished) and the state of each profile. The run is null when none exists.",
    annotations: toolAnnotations("Get AliasMode script run status", { readOnly: true }),
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: "aliasmode_scripts_log",
    description: "Read the output log of a script run from a byte offset. Pass the nextOffset of the previous call to read only new output.",
    annotations: toolAnnotations("Read AliasMode script run log", { readOnly: true }),
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_scripts_stop",
    description: "Stop the running script and close its browsers. Returns the final run state.",
    annotations: toolAnnotations("Stop the AliasMode script run", { destructive: true }),
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: "aliasmode_scripts_on_open",
    description: "Set the script that runs each time a profile is opened from the AliasMode app, or omit scriptId to clear it.",
    annotations: toolAnnotations("Set an AliasMode run-on-open script"),
    inputSchema: {
      type: "object",
      properties: {
        profileId: PROFILE_ID,
        scriptId: { type: "string", minLength: 1, description: "Omit to clear the profile's run-on-open script." },
      },
      required: ["profileId"],
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_schedules_list",
    description: "List script schedules (jobs with their next and last run), the recent schedule run history, and the run-on-open script of each profile.",
    annotations: toolAnnotations("List AliasMode script schedules", { readOnly: true }),
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: "aliasmode_schedules_save",
    description: "Create a schedule that runs a library script on profiles every few hours or daily at a set time, or update one by passing its scheduleId. On update, omitted fields keep their current value. Schedules run only while the AliasMode app is open.",
    annotations: toolAnnotations("Save an AliasMode script schedule"),
    inputSchema: {
      type: "object",
      properties: {
        scheduleId: { type: "string", minLength: 1, description: "Omit to create a new schedule." },
        name: { type: "string" },
        scriptId: { type: "string", minLength: 1 },
        profileIds: { type: "array", minItems: 1, items: PROFILE_ID },
        everyHours: { type: "number", exclusiveMinimum: 0, description: "Run every this many hours. Set this or dailyAt." },
        dailyAt: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "Run daily at HH:MM in the computer's local time. Set this or everyHours." },
        inputs: { type: "object", description: "JSON inputs passed to the script." },
        headless: { type: "boolean", description: "Run the browsers hidden." },
        useCredentials: { type: "boolean", description: "Give the script the saved login details of each profile. Off for a new schedule." },
        enabled: { type: "boolean", description: "On for a new schedule." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "aliasmode_schedules_delete",
    description: "Delete a script schedule. The script itself stays in the library.",
    annotations: toolAnnotations("Delete an AliasMode script schedule", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: { scheduleId: { type: "string", minLength: 1 } },
      required: ["scheduleId"],
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
  const { temporary = false, proxyFrom, ...input } = args;
  return { input, temporary, ...(proxyFrom === undefined ? {} : { proxyFrom }) };
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
  let selectedEngine;
  let selectedFirefoxTools = [];
  const ownedProfileIds = new Set();
  let closing;

  const selectedTools = () => selectedEngine === "firefox" ? selectedFirefoxTools : playwright.listTools();

  const selectBrowser = async (profileId, knownStatus) => {
    const status = knownStatus ?? await runtime.call("browser.status", { profileId });
    if (!status.running) throw new Error("open this AliasMode profile before selecting it");
    const wasChromium = selectedEngine === "chromium";
    selectedProfileId = undefined;
    selectedEngine = undefined;
    selectedFirefoxTools = [];
    if (wasChromium) await playwright.detach();
    if (status.engine === "firefox") {
      const result = await runtime.call("firefox.tools.list", { profileId });
      selectedFirefoxTools = firefoxTools(result.tools ?? []);
      selectedProfileId = profileId;
      selectedEngine = "firefox";
      return safeBrowserResult({ ...status, selected: true });
    }
    if (!status.ws) throw new Error("open this AliasMode profile before selecting it");
    await playwright.attach(status.ws);
    selectedProfileId = profileId;
    selectedEngine = "chromium";
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
    const engine = selectedEngine;
    if (selected) await playwright.detach();
    try {
      const result = await runtime.call("browser.close", { profileId: target });
      ownedProfileIds.delete(target);
      if (selected) {
        selectedProfileId = undefined;
        selectedEngine = undefined;
        selectedFirefoxTools = [];
      }
      return safeBrowserResult(result);
    } catch (error) {
      if (selected) {
        const status = await runtime.call("browser.status", { profileId: target }).catch(() => undefined);
        if (status?.running) {
          if (engine === "firefox") await selectBrowser(target, status).catch(() => {});
          else if (status.ws) await playwright.attach(status.ws).catch(() => {});
        }
      }
      throw error;
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...ALIAS_TOOLS, ...selectedTools()],
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
      if (name === "aliasmode_profile_update") {
        return toolResult(await runtime.call("profiles.update", args));
      }
      if (name === "aliasmode_profile_delete") {
        return toolResult(await runtime.call("profiles.delete", { profileId: args.profileId }));
      }
      if (name === "aliasmode_profile_new_identity") {
        const result = await runtime.call("profiles.newIdentity", { profileId: args.profileId });
        // The browser closed and may have opened again, so the selection moves to the new one.
        if (args.profileId === selectedProfileId) {
          if (selectedEngine === "chromium") await playwright.detach();
          selectedProfileId = undefined;
          selectedEngine = undefined;
          selectedFirefoxTools = [];
          if (result.reopened) await selectBrowser(args.profileId).catch(() => {});
        }
        if (!result.reopened) ownedProfileIds.delete(args.profileId);
        return toolResult(result);
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
              ...(opened.engine === "firefox"
                ? { engine: "firefox", capabilities: opened.capabilities, headless: opened.headless }
                : { ws: opened.ws, port: opened.port, headless: opened.headless }),
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
        return toolResult(safeBrowserResult({
          profileId: opened.profileId,
          ...(opened.engine === "firefox"
            ? { engine: "firefox", capabilities: opened.capabilities }
            : { port: opened.port }),
          headless: opened.headless,
          alreadyOpen: opened.alreadyOpen,
          selected: args.select !== false,
        }));
      }
      if (name === "aliasmode_scripts_list") {
        return toolResult(await runtime.call("scripts.list"));
      }
      if (name === "aliasmode_scripts_get") {
        return toolResult(await runtime.call("scripts.get", args));
      }
      if (name === "aliasmode_scripts_save") {
        return toolResult(await runtime.call("scripts.save", args));
      }
      if (name === "aliasmode_scripts_run") {
        return toolResult(await runtime.call("scripts.run", args));
      }
      if (name === "aliasmode_scripts_status") {
        return toolResult(await runtime.call("scripts.status"));
      }
      if (name === "aliasmode_scripts_log") {
        return toolResult(await runtime.call("scripts.log", args));
      }
      if (name === "aliasmode_scripts_stop") {
        return toolResult(await runtime.call("scripts.stop"));
      }
      if (name === "aliasmode_scripts_on_open") {
        return toolResult(await runtime.call("scripts.onOpen", args));
      }
      if (name === "aliasmode_schedules_list") {
        return toolResult(await runtime.call("schedules.list"));
      }
      if (name === "aliasmode_schedules_save") {
        return toolResult(await runtime.call("schedules.save", args));
      }
      if (name === "aliasmode_schedules_delete") {
        return toolResult(await runtime.call("schedules.delete", args));
      }
      if (name === "aliasmode_browser_select") {
        return toolResult(await selectBrowser(args.profileId));
      }
      if (name === "aliasmode_browser_status") {
        const profileId = args.profileId || selectedProfileId;
        if (!profileId) throw new Error("select an open AliasMode browser first");
        const status = await runtime.call("browser.status", { profileId });
        const { ws: _ws, firefoxOwner: _firefoxOwner, ...safeStatus } = safeBrowserResult(status);
        return toolResult({ ...safeStatus, selected: profileId === selectedProfileId });
      }
      if (name === "aliasmode_browser_close" || name === "browser_close") {
        return toolResult(await closeBrowser(args.profileId));
      }
      if (!selectedProfileId) throw new Error("select an open AliasMode browser first");
      if (!selectedTools().some((tool) => tool.name === name)) {
        throw new Error(`unknown AliasMode tool: ${name}`);
      }
      if (selectedEngine === "firefox") {
        return await runtime.call("firefox.tools.call", {
          profileId: selectedProfileId,
          name,
          arguments: args,
        });
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
    // Linux: the app that the host may start needs the desktop session, and the data folder.
    "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
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
    // macOS: Contents/Resources -> Contents/MacOS; Linux: lib/<app> -> bin.
    ...(process.platform === "darwin" ? ["..", "MacOS", "aliasmode"]
      : process.platform === "linux" ? ["..", "..", "bin", "aliasmode"] : ["AliasMode.exe"]),
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
