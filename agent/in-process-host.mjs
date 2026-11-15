import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAliasModeMcp } from "./mcp-host.mjs";

/**
 * The AliasMode MCP host inside the dashboard server, for a source checkout that has no packaged
 * `aliasmode-mcp` helper. `session` is an agent control session of this server.
 */
export async function connectInProcess(session) {
  let id = 0;
  const runtime = {
    async call(method, params = {}) {
      const response = await session.enqueue(JSON.stringify({ protocol: "aliasmode-agent-v1", id: ++id, method, params }));
      if (response.ok) return response.result;
      const error = new Error(response.error?.message || "AliasMode operation failed");
      error.code = response.error?.code || "operation_failed";
      throw error;
    },
    close() {
      void session.disconnect();
    },
  };
  const host = await createAliasModeMcp({ discovered: { client: runtime } });
  const client = new Client({ name: "aliasmode-agent", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async close() {
      await client.close().catch(() => {});
      await host.close();
    },
  };
}
