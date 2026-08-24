import { expect, test } from "bun:test";
import { createConnection } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

test("pinned official Playwright MCP exposes full action capabilities", async () => {
  const server = await createConnection(
    { capabilities: ["core", "core-tabs", "vision", "pdf", "testing", "tracing"] },
    async () => { throw new Error("browser context should not be needed to list tools"); },
  );
  const client = new Client({ name: "schema-test", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const names = new Set((await client.listTools()).tools.map((tool) => tool.name));

  for (const name of [
    "browser_run_code",
    "browser_file_upload",
    "browser_tabs",
    "browser_evaluate",
    "browser_start_tracing",
    "browser_stop_tracing",
  ]) {
    expect(names.has(name)).toBe(true);
  }

  await client.close();
  await server.close();
});
