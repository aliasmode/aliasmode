/**
 * Regenerates the public documentation contracts in docs/public from the real
 * Local API and MCP host code, so the website copies them instead of retyping.
 *
 *   bun scripts/generate-public-docs.mjs                  rewrite current-source catalog + manifest
 *   bun scripts/generate-public-docs.mjs --check          fail when the committed files drift
 *   bun scripts/generate-public-docs.mjs --released <tag> write an immutable catalog for a git tag
 *
 * MCP tool catalogs are produced by connecting an in-memory MCP client to the
 * real `createAliasModeMcp` server with a fake browser proxy and runtime, so no
 * browser or AliasMode runtime is needed. Playwright tools come from the real
 * pinned @playwright/mcp package through PlaywrightToolProxy.initialize().
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PUBLIC_DOCS_DIR = join(ROOT, "docs", "public");
export const OPENAPI_PATH = "local-api.openapi.json";
export const MANIFEST_PATH = "manifest.json";
export const CATALOG_DIR = "mcp-tools";
export const CURRENT_CATALOG_PATH = `${CATALOG_DIR}/current-source.json`;
const CATALOG_SCHEMA_VERSION = 1;
const MANIFEST_SCHEMA_VERSION = 1;
const TAG_AGENT_FILES = ["mcp-host.mjs", "playwright-proxy.mjs", "runtime-client.mjs"];

export function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stringList(text) {
  return [...(text ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** Capabilities, filtered tools, and listing behaviour, read from playwright-proxy.mjs source text. */
export function playwrightMetaFromSource(source) {
  const capabilities = stringList(source.match(/(?:CAPABILITIES\s*=|capabilities:)\s*\[([^\]]*)\]/)?.[1]);
  const filtered = stringList(source.match(/FILTERED_TOOLS\s*=\s*new Set\(\[([^\]]*)\]\)/)?.[1]);
  if (!capabilities.length || !filtered.length) {
    throw new Error("could not read CAPABILITIES and FILTERED_TOOLS from agent/playwright-proxy.mjs");
  }
  return {
    capabilities,
    filtered,
    availability: /^\s*async initialize\(\)/m.test(source) ? "listed-before-selection" : "after-browser-selection",
  };
}

function publicTool(tool) {
  return {
    name: tool.name,
    description: tool.description ?? "",
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    inputSchema: tool.inputSchema,
  };
}

function isAliasModeTool(tool) {
  return tool.name.startsWith("aliasmode_") || tool.name === "browser_close";
}

async function listPlaywrightTools(version) {
  const { PlaywrightToolProxy } = await import(pathToFileURL(join(ROOT, "agent", "playwright-proxy.mjs")).href);
  const proxy = new PlaywrightToolProxy(version);
  await proxy.initialize();
  return proxy.listTools().map(publicTool);
}

/** List the tools the AliasMode MCP host at `mcpHostPath` serves, via an in-memory MCP client. */
async function listHostTools(mcpHostPath, playwrightTools) {
  const { createAliasModeMcp } = await import(pathToFileURL(mcpHostPath).href);
  const refuse = () => {
    throw new Error("the public docs generator never drives a browser");
  };
  const host = await createAliasModeMcp({
    playwright: {
      async initialize() {},
      listTools: () => playwrightTools,
      attach: refuse,
      callTool: refuse,
      async detach() {},
    },
    discovered: { client: { call: refuse, close() {} } },
  });
  const client = new Client({ name: "aliasmode-public-docs", version: "0" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools.map(publicTool);
  } finally {
    await client.close().catch(() => {});
    await host.server.close().catch(() => {});
    await host.close().catch(() => {});
  }
}

function catalog({ aliasModeVersion, status, sourceRef, playwrightMcpVersion, meta, tools }) {
  return {
    catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
    aliasModeVersion,
    status,
    sourceRef,
    playwrightMcpVersion,
    playwrightCapabilities: meta.capabilities,
    filteredPlaywrightTools: meta.filtered,
    playwrightToolAvailability: meta.availability,
    aliasModeTools: tools.filter(isAliasModeTool),
    playwrightTools: tools.filter((tool) => !isAliasModeTool(tool)),
  };
}

export async function generateCurrentSourceCatalog() {
  const pkg = readJson(join(ROOT, "package.json"));
  const meta = playwrightMetaFromSource(readFileSync(join(ROOT, "agent", "playwright-proxy.mjs"), "utf8"));
  const playwrightTools = await listPlaywrightTools(pkg.version);
  const tools = await listHostTools(join(ROOT, "agent", "mcp-host.mjs"), playwrightTools);
  return catalog({
    aliasModeVersion: pkg.version,
    status: "source",
    sourceRef: "source",
    playwrightMcpVersion: pkg.dependencies["@playwright/mcp"],
    meta,
    tools,
  });
}

function sameList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Catalog for a released git tag, introspected from the tag's own agent/ sources. */
export async function generateReleasedCatalog(tag) {
  const show = (path) => execFileSync("git", ["-C", ROOT, "show", `${tag}:${path}`], { encoding: "utf8" });
  const pkg = JSON.parse(show("package.json"));
  const currentPkg = readJson(join(ROOT, "package.json"));
  const meta = playwrightMetaFromSource(show("agent/playwright-proxy.mjs"));
  const currentMeta = playwrightMetaFromSource(readFileSync(join(ROOT, "agent", "playwright-proxy.mjs"), "utf8"));
  const playwrightMcpVersion = pkg.dependencies["@playwright/mcp"];
  if (
    playwrightMcpVersion !== currentPkg.dependencies["@playwright/mcp"]
    || !sameList(meta.capabilities, currentMeta.capabilities)
    || !sameList(meta.filtered, currentMeta.filtered)
  ) {
    throw new Error(`${tag} pins a different @playwright/mcp version, capabilities, or filtered tools; its Playwright tool list cannot be reproduced from the installed package`);
  }
  const playwrightTools = await listPlaywrightTools(pkg.version);
  const tmp = join(ROOT, `.tmp-${tag}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, "agent"), { recursive: true });
  try {
    for (const file of TAG_AGENT_FILES) writeFileSync(join(tmp, "agent", file), show(`agent/${file}`));
    const tools = await listHostTools(join(tmp, "agent", "mcp-host.mjs"), playwrightTools);
    return catalog({
      aliasModeVersion: pkg.version,
      status: "released",
      sourceRef: tag,
      playwrightMcpVersion,
      meta,
      tools,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function releasedVersions() {
  const dir = join(PUBLIC_DOCS_DIR, CATALOG_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== "current-source.json")
    .map((name) => name.slice(0, -".json".length))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/** Stamp the package version into the hand-written OpenAPI document. */
export function stampOpenApi(text, productVersion) {
  const doc = JSON.parse(text);
  doc.info.version = productVersion;
  return serialize(doc);
}

export function buildManifest({ productVersion, openapiText, currentCatalogText }) {
  const mcpCatalogs = { "current-source": { path: CURRENT_CATALOG_PATH, sha256: sha256(currentCatalogText) } };
  const versions = releasedVersions();
  for (const version of versions) {
    const path = `${CATALOG_DIR}/${version}.json`;
    mcpCatalogs[version] = { path, sha256: sha256(readFileSync(join(PUBLIC_DOCS_DIR, path), "utf8")) };
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    productVersion,
    openapi: { path: OPENAPI_PATH, sha256: sha256(openapiText) },
    mcpCatalogs,
    releasedVersions: versions,
  };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main(argv) {
  const check = argv.includes("--check");
  const releasedAt = argv.indexOf("--released");
  if (releasedAt !== -1) {
    const tag = argv[releasedAt + 1];
    if (!tag) fail("usage: bun scripts/generate-public-docs.mjs --released <git tag>");
    const path = join(PUBLIC_DOCS_DIR, CATALOG_DIR, `${tag.replace(/^v/, "")}.json`);
    if (existsSync(path)) fail(`${relative(ROOT, path)} already exists; released catalogs are immutable`);
    const released = serialize(await generateReleasedCatalog(tag));
    if (check) return console.log(`${relative(ROOT, path)} would be written`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, released);
    console.log(`wrote ${relative(ROOT, path)}`);
  }

  const productVersion = readJson(join(ROOT, "package.json")).version;
  const openapiPath = join(PUBLIC_DOCS_DIR, OPENAPI_PATH);
  const openapiText = stampOpenApi(readFileSync(openapiPath, "utf8"), productVersion);
  const currentCatalogText = serialize(await generateCurrentSourceCatalog());
  const manifestText = serialize(buildManifest({ productVersion, openapiText, currentCatalogText }));
  const outputs = [
    [openapiPath, openapiText],
    [join(PUBLIC_DOCS_DIR, CURRENT_CATALOG_PATH), currentCatalogText],
    [join(PUBLIC_DOCS_DIR, MANIFEST_PATH), manifestText],
  ];

  if (!check) {
    mkdirSync(join(PUBLIC_DOCS_DIR, CATALOG_DIR), { recursive: true });
    for (const [path, text] of outputs) writeFileSync(path, text);
    console.log(`wrote ${outputs.map(([path]) => relative(ROOT, path)).join(", ")}`);
    return;
  }

  const problems = [];
  for (const [path, expected] of outputs) {
    const actual = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (actual !== expected) problems.push(`${relative(ROOT, path)} is out of date`);
  }
  const committed = existsSync(join(PUBLIC_DOCS_DIR, MANIFEST_PATH)) ? readJson(join(PUBLIC_DOCS_DIR, MANIFEST_PATH)) : {};
  for (const version of committed.releasedVersions ?? []) {
    const entry = committed.mcpCatalogs?.[version];
    const path = entry ? join(PUBLIC_DOCS_DIR, entry.path) : null;
    if (!path || !existsSync(path) || sha256(readFileSync(path, "utf8")) !== entry.sha256) {
      problems.push(`released catalog ${entry?.path ?? version} does not match its sha256 in docs/public/manifest.json`);
    }
  }
  if (problems.length) fail(`${problems.join("\n")}\nRun \`bun run docs:public\` and commit the result.`);
  console.log("public docs are up to date");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
