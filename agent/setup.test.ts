import { expect, test } from "bun:test";
import { configureClients, type CommandRunner } from "./setup.ts";

test("setup uses each client's supported MCP registration command", async () => {
  const calls: Array<[string, string[]]> = [];
  const inputs: Array<[string, string[], string | undefined]> = [];
  const run: CommandRunner = async (command, args, input) => {
    calls.push([command, args]);
    inputs.push([command, args, input]);
    return { found: true, code: 0 };
  };
  const helper = "C:\\Program Files\\AliasMode\\aliasmode-mcp.exe";
  const command = "C:\\Program Files\\AliasMode\\playwright\\node\\node.exe";
  const host = "C:\\Program Files\\AliasMode\\playwright\\agent\\mcp-host.mjs";
  const result = await configureClients({ helper, command, args: [host], run });

  expect(result.clients).toEqual([
    { client: "claude", status: "configured", restartRequired: true },
    { client: "codex", status: "configured", restartRequired: true },
    { client: "openclaw", status: "configured", restartRequired: true },
    { client: "hermes", status: "configured", restartRequired: true },
  ]);
  expect(calls).toContainEqual([
    "claude",
    ["mcp", "remove", "aliasmode", "--scope", "user"],
  ]);
  expect(calls).toContainEqual(["codex", ["mcp", "remove", "aliasmode"]]);
  expect(calls).toContainEqual(["openclaw", ["mcp", "unset", "aliasmode"]]);
  expect(calls).toContainEqual(["hermes", ["mcp", "remove", "aliasmode"]]);
  expect(calls).toContainEqual([
    "claude",
    ["mcp", "add", "--scope", "user", "aliasmode", "--", command, host],
  ]);
  expect(calls).toContainEqual([
    "codex",
    ["mcp", "add", "aliasmode", "--", command, host],
  ]);
  expect(calls).toContainEqual([
    "openclaw",
    ["mcp", "add", "aliasmode", "--command", command, "--arg", host],
  ]);
  expect(calls).toContainEqual([
    "hermes",
    ["mcp", "add", "aliasmode", "--command", command, "--args", host],
  ]);
  expect(inputs).toContainEqual([
    "hermes",
    ["mcp", "remove", "aliasmode"],
    "y\n",
  ]);
  expect(inputs).toContainEqual([
    "hermes",
    ["mcp", "add", "aliasmode", "--command", command, "--args", host],
    "y\n",
  ]);
  expect(inputs.filter(([client]) => client !== "hermes").every(([, , input]) => input === undefined)).toBe(true);
  expect(result.generic.mcpServers.aliasmode).toEqual({ command, args: [host] });
});

test("setup reports a detected client registration failure", async () => {
  const run: CommandRunner = async (_command, args) => ({
    found: true,
    code: args[1] === "add" ? 1 : 0,
  });
  const result = await configureClients({
    helper: "C:\\AliasMode\\aliasmode-mcp.exe",
    clients: ["claude"],
    run,
  });
  expect(result.clients).toEqual([{
    client: "claude",
    status: "failed",
    restartRequired: false,
    reason: "registration_failed",
  }]);
});

test("setup is repeatable and reports clients that are not installed", async () => {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "codex") return { found: false, code: 1 };
    return { found: true, code: 0 };
  };
  const options = {
    helper: "C:\\AliasMode\\aliasmode-mcp.exe",
    clients: ["claude", "codex"] as const,
    run,
  };

  const first = await configureClients({ ...options, clients: [...options.clients] });
  const firstCalls = [...calls];
  calls.length = 0;
  const second = await configureClients({ ...options, clients: [...options.clients] });

  expect(second).toEqual(first);
  expect(calls).toEqual(firstCalls);
  expect(first.clients[1]).toEqual({
    client: "codex",
    status: "not_installed",
    restartRequired: false,
    reason: "command_not_found",
  });
  expect(calls.some((call) => call.startsWith("codex mcp add"))).toBe(false);
});
