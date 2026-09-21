import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectOfficial, nonClosingContext } from "./agent/playwright-proxy.mjs";
import { MAX_BYTES, VERSION, operatePersistentContext } from "./playwright-worker.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const ERROR_MESSAGES = {
  invalid_request: "Firefox owner request is invalid",
  invalid_response: "Firefox owner response is invalid",
  operation_failed: "Firefox owner operation failed",
  runtime_unavailable: "Firefox owner runtime is unavailable",
  timeout: "Firefox owner operation timed out",
};

function typed(code, details) {
  const error = new Error(ERROR_MESSAGES[code] || ERROR_MESSAGES.operation_failed);
  error.code = code;
  if (details) error.details = details;
  return error;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function isLoopbackEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "::1")
      && !!url.port
      && url.pathname === "/";
  } catch {
    return false;
  }
}

function validConfig(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function cleanCamouConfig(config) {
  for (const key of Object.keys(process.env)) {
    if (/^CAMOU_CONFIG(?:_\d+)?$/i.test(key)) delete process.env[key];
  }
  const serialized = JSON.stringify(config);
  for (let offset = 0; offset < serialized.length; offset += 2047) {
    process.env[`CAMOU_CONFIG_${Math.floor(offset / 2047) + 1}`] = serialized.slice(offset, offset + 2047);
  }
}

async function readConfig() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw typed("invalid_request");
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw typed("invalid_request"); }
  if (input?.version !== VERSION
    || typeof input.profileId !== "string" || !input.profileId
    || typeof input.executablePath !== "string" || !input.executablePath
    || typeof input.executableSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.executableSha256)
    || typeof input.userDataDir !== "string" || !input.userDataDir
    || !validConfig(input.config)
    || !input.owner || !isLoopbackEndpoint(input.owner.endpoint)
    || typeof input.owner.token !== "string" || !input.owner.token
    || typeof input.owner.generation !== "string" || !input.owner.generation
    || (input.proxy !== undefined && (!validConfig(input.proxy) || typeof input.proxy.server !== "string" || !input.proxy.server))
    || (input.args !== undefined && (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string")))
    || (input.headless !== undefined && typeof input.headless !== "boolean")
    || (input.restoreLastSession !== undefined && typeof input.restoreLastSession !== "boolean")) {
    throw typed("invalid_request");
  }
  return input;
}

function sameToken(expected, actual) {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readRequest(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw typed("invalid_request");
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw typed("invalid_request"); }
  if (value?.version !== VERSION || typeof value.operation !== "string" || !value.payload || typeof value.payload !== "object") {
    throw typed("invalid_request");
  }
  return value;
}

function powerShellLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

async function browserPidOf(context, input) {
  const browser = context.browser?.();
  const launched = typeof browser?.process === "function"
    ? browser.process()
    : browser?._process ?? browser?._browserProcess;
  if (Number.isSafeInteger(launched?.pid) && launched.pid > 0) return launched.pid;
  if (process.platform !== "win32") throw typed("runtime_unavailable");
  const executable = powerShellLiteral(input.executablePath);
  const directory = powerShellLiteral(input.userDataDir);
  const command = `$exe = ${executable}; $directory = ${directory}; $profile = '(?i)(?:^|\\s)-profile\\s+(?:"' + [regex]::Escape($directory) + '"|' + [regex]::Escape($directory) + ')(?=\\s|$)'; Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid}" | Where-Object { $_.ExecutablePath -ieq $exe -and $_.CommandLine -match $profile } | Select-Object -First 1 -ExpandProperty ProcessId`;
  try {
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
    const pid = Number(String(stdout).trim());
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
  } catch {}
  throw typed("runtime_unavailable");
}

function responseBody(response) {
  const body = JSON.stringify(response);
  if (Buffer.byteLength(body) <= MAX_BYTES) return body;
  return JSON.stringify({ version: VERSION, ok: false, error: { code: "operation_failed", message: ERROR_MESSAGES.operation_failed } });
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

export function firefoxLaunchOptions(input) {
  return {
    executablePath: input.executablePath,
    viewport: null,
    ...(input.proxy ? { proxy: input.proxy } : {}),
    firefoxUserPrefs: {
      "browser.startup.page": input.restoreLastSession ? 3 : 0,
      ...(input.proxy ? {
        "media.peerconnection.ice.proxy_only": true,
        "media.peerconnection.ice.default_address_only": true,
        "media.peerconnection.ice.no_host": true,
      } : {}),
    },
    ...(input.headless === undefined ? {} : { headless: input.headless }),
    ...(input.args ? { args: input.args } : {}),
  };
}

async function launchOwner(input) {
  if (await sha256File(input.executablePath) !== input.executableSha256) throw typed("operation_failed");
  cleanCamouConfig(input.config);
  let runtime;
  try { runtime = await import(pathToFileURL(join(ROOT, "node_modules", "playwright-core", "index.mjs")).href); } catch { throw typed("runtime_unavailable"); }
  if (!runtime.firefox) throw typed("runtime_unavailable");
  try {
    return await runtime.firefox.launchPersistentContext(input.userDataDir, firefoxLaunchOptions(input));
  } catch {
    throw typed("operation_failed");
  }
}

async function run() {
  const input = await readConfig();
  if (!process.argv.includes(`--aliasmode-firefox-owner=${input.owner.generation}`)) throw typed("invalid_request");
  const context = await launchOwner(input);
  const browser = context.browser?.();
  let browserPid;
  try { browserPid = await browserPidOf(context, input); }
  catch (error) { await context.close().catch(() => {}); throw error; }
  const pageIds = new WeakMap();
  let nextPageId = 1;
  const observedOrigins = new Set();
  let observedTelegramClient;
  const observeUrl = (value) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      observedOrigins.add(url.origin);
      if (url.origin === "https://web.telegram.org") {
        if (url.pathname === "/a" || url.pathname.startsWith("/a/")) observedTelegramClient = "a";
        if (url.pathname === "/k" || url.pathname.startsWith("/k/")) observedTelegramClient = "k";
      }
    } catch {}
  };
  const observePage = (page) => {
    try { observeUrl(page.url()); } catch {}
    page.on?.("framenavigated", (frame) => { try { observeUrl(frame.url()); } catch {} });
  };
  for (const page of context.pages()) observePage(page);
  context.on?.("page", observePage);
  let official;
  let closed = false;
  let closing = false;
  let queue = Promise.resolve();
  const pageTargets = () => context.pages().map((page) => {
    let id = pageIds.get(page);
    if (!id) { id = `page-${nextPageId++}`; pageIds.set(page, id); }
    let url = "";
    try { url = page.url(); } catch {}
    return { id, url };
  });
  const closeOfficial = async () => {
    const current = official;
    official = undefined;
    await current?.client.close().catch(() => {});
    await current?.server.close().catch(() => {});
  };
  let playwrightServer;
  let playwrightEndpoint;
  const closePlaywrightServer = async () => {
    const current = playwrightServer;
    playwrightServer = undefined;
    playwrightEndpoint = undefined;
    await current?.close();
  };
  const initializePlaywrightServer = async () => {
    if (playwrightEndpoint) return playwrightEndpoint;
    const serverContext = context?._connection?.toImpl?.(context);
    const serverBrowser = serverContext?._browser;
    if (!serverBrowser) throw typed("runtime_unavailable");
    let PlaywrightServer;
    try { ({ PlaywrightServer } = require(join(ROOT, "node_modules", "playwright-core", "lib", "remote", "playwrightServer.js"))); }
    catch { throw typed("runtime_unavailable"); }
    const bridge = new PlaywrightServer({
      mode: "launchServerShared",
      path: `/${randomBytes(32).toString("hex")}`,
      maxConnections: Infinity,
      preLaunchedBrowser: serverBrowser,
    });
    try {
      playwrightEndpoint = await bridge.listen(0, "127.0.0.1");
      playwrightServer = bridge;
      return playwrightEndpoint;
    } catch (error) {
      await bridge.close().catch(() => {});
      throw error;
    }
  };
  let server;
  const closeServer = () => !server
    ? Promise.resolve()
    : new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const stopContext = async () => {
    if (closing) return;
    closing = true;
    closed = true;
    try {
      await closeOfficial();
      await closePlaywrightServer().catch(() => {});
      await context.close();
    } catch (error) {
      closing = false;
      closed = false;
      throw error;
    }
  };
  const shutdown = async () => {
    try {
      await stopContext();
    } finally {
      await closePlaywrightServer().catch(() => {});
      await closeServer().catch(() => {});
    }
  };
  const initializeOfficial = async () => {
    if (official) return official;
    official = await connectOfficial("aliasmode-firefox-owner", async () => nonClosingContext(context));
    return official;
  };
  const operation = async (name, payload) => {
    if (closed) throw typed("runtime_unavailable");
    if (payload.ownerGeneration !== input.owner.generation) throw typed("runtime_unavailable");
    if (name === "session-capture") {
      const seed = payload.captureSeed;
      if (seed === undefined || (seed && typeof seed === "object" && !Array.isArray(seed) && Array.isArray(seed.origins))) {
        const origins = new Set([...(seed?.origins ?? []), ...observedOrigins]);
        payload = {
          ...payload,
          captureSeed: {
            ...(seed ?? {}),
            origins: [...origins],
            ...(seed?.telegramClient || !observedTelegramClient ? {} : { telegramClient: observedTelegramClient }),
          },
        };
      }
    }
    if (name === "close") return null;
    if (name === "status") return {
      generation: input.owner.generation,
      directory: input.userDataDir,
      executablePath: input.executablePath,
      pid: process.pid,
      browserPid,
      profileId: input.profileId,
      pageTargets: pageTargets(),
      hasPages: context.pages().length > 0,
    };
    if (name === "bring-to-front") {
      const targets = pageTargets();
      const target = payload.targetId
        ? targets.find((item) => item.id === payload.targetId)
        : targets[0];
      const page = target && context.pages().find((item) => pageIds.get(item) === target.id);
      if (!page) throw typed("operation_failed");
      await page.bringToFront();
      return null;
    }
    if (name === "mcp-list") {
      const bridge = await initializeOfficial();
      return bridge.tools.filter((tool) => !/pdf/i.test(tool.name));
    }
    if (name === "mcp-call") {
      if (typeof payload.name !== "string" || /pdf/i.test(payload.name)) throw typed("invalid_request");
      const bridge = await initializeOfficial();
      if (!bridge.tools.some((tool) => tool.name === payload.name && !/pdf/i.test(tool.name))) throw typed("invalid_request");
      return bridge.client.callTool({ name: payload.name, arguments: payload.arguments ?? {} });
    }
    if (name === "detach") {
      await closeOfficial();
      return null;
    }
    if (name === "playwright-endpoint") return { endpoint: await initializePlaywrightServer() };
    return operatePersistentContext(browser, context, name, payload, { nativeStorage: true });
  };

  server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/"
        || !sameToken(input.owner.token, request.headers.authorization?.replace(/^Bearer /, ""))) {
        send(response, 401, responseBody({ version: VERSION, ok: false, error: { code: "runtime_unavailable", message: ERROR_MESSAGES.runtime_unavailable } }));
        return;
      }
      try {
        const requestValue = await readRequest(request);
        const runOperation = queue.then(() => operation(requestValue.operation, requestValue.payload));
        queue = runOperation.catch(() => {});
        const result = await runOperation;
        if (requestValue.operation === "close") {
          await stopContext();
          send(response, 200, responseBody({ version: VERSION, ok: true, result }));
          await closeServer();
          return;
        }
        send(response, 200, responseBody({ version: VERSION, ok: true, result }));
      } catch (error) {
        const code = ERROR_MESSAGES[error?.code] ? error.code : "operation_failed";
        send(response, 400, responseBody({ version: VERSION, ok: false, error: { code, message: ERROR_MESSAGES[code], ...(error?.details ? { details: error.details } : {}) } }));
      }
    })();
  });
  const address = new URL(input.owner.endpoint);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(address.port), address.hostname, resolve);
    });
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
  const ready = { version: VERSION, ok: true, result: { endpoint: input.owner.endpoint, pid: process.pid, browserPid, generation: input.owner.generation } };
  process.stdout.write(`${JSON.stringify(ready)}\n`);
  browser?.once?.("disconnected", () => { if (!closing) void shutdown(); });
  context.once?.("close", () => { if (!closing) void shutdown(); });
}

if (process.argv.some((argument) => argument.startsWith("--aliasmode-firefox-owner="))) {
  try {
    await run();
  } catch (error) {
    const code = ERROR_MESSAGES[error?.code] ? error.code : "operation_failed";
    process.stdout.write(`${JSON.stringify({ version: VERSION, ok: false, error: { code, message: ERROR_MESSAGES[code] } })}\n`);
    process.exitCode = 1;
  }
}
