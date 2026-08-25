import process from "node:process";
import { pathToFileURL } from "node:url";
import { createConnection } from "@playwright/mcp";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const FILTERED_TOOLS = new Set(["browser_close", "browser_install"]);

function nonClosingContext(context) {
  return new Proxy(context, {
    get(target, property) {
      if (property === "close") return async () => {};
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export class PlaywrightToolProxy {
  constructor(version) {
    this.version = version;
    this.tools = [];
  }

  async attach(endpoint) {
    await this.detach();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 30_000 });
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close();
      throw new Error("AliasMode browser did not expose a persistent context");
    }

    const officialServer = await createConnection(
      { capabilities: ["core", "core-tabs", "vision", "pdf", "testing", "tracing"] },
      async () => nonClosingContext(context),
    );
    const officialClient = new Client(
      { name: "aliasmode-playwright-proxy", version: this.version },
      { capabilities: { roots: { listChanged: false } } },
    );
    officialClient.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(process.cwd()).href, name: "workspace" }],
    }));
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        officialServer.connect(serverTransport),
        officialClient.connect(clientTransport),
      ]);
      const listed = await officialClient.listTools();
      this.browser = browser;
      this.officialServer = officialServer;
      this.officialClient = officialClient;
      this.tools = listed.tools.filter((tool) => !FILTERED_TOOLS.has(tool.name));
    } catch (error) {
      await officialClient.close().catch(() => {});
      await officialServer.close().catch(() => {});
      await browser.close().catch(() => {});
      throw error;
    }
  }

  listTools() {
    return this.tools;
  }

  async callTool(name, args) {
    if (!this.officialClient) throw new Error("select an open AliasMode browser first");
    if (FILTERED_TOOLS.has(name)) throw new Error("AliasMode owns browser lifecycle operations");
    return await this.officialClient.callTool({ name, arguments: args ?? {} });
  }

  async detach() {
    const client = this.officialClient;
    const server = this.officialServer;
    const browser = this.browser;
    this.officialClient = undefined;
    this.officialServer = undefined;
    this.browser = undefined;
    this.tools = [];
    await client?.close().catch(() => {});
    await server?.close().catch(() => {});
    // A CDP-connected Browser closes only its Playwright transport. The guarded
    // context close above prevents the official MCP server from closing AliasMode.
    await browser?.close().catch(() => {});
  }
}
