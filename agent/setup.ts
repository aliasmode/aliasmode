import spawn from "cross-spawn";

export type SetupClient = "claude" | "codex" | "openclaw" | "hermes";

export interface CommandResult {
  found: boolean;
  code: number;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

const CLIENTS: Record<SetupClient, {
  command: string;
  remove: string[];
  add: (command: string, args: string[]) => string[];
}> = {
  claude: {
    command: "claude",
    remove: ["mcp", "remove", "aliasmode", "--scope", "user"],
    add: (command, args) => ["mcp", "add", "--scope", "user", "aliasmode", "--", command, ...args],
  },
  codex: {
    command: "codex",
    remove: ["mcp", "remove", "aliasmode"],
    add: (command, args) => ["mcp", "add", "aliasmode", "--", command, ...args],
  },
  openclaw: {
    command: "openclaw",
    remove: ["mcp", "unset", "aliasmode"],
    add: (command, args) => [
      "mcp", "add", "aliasmode", "--command", command,
      ...args.flatMap((arg) => ["--arg", arg]),
    ],
  },
  hermes: {
    command: "hermes",
    remove: ["mcp", "remove", "aliasmode"],
    add: (command, args) => ["mcp", "add", "aliasmode", "--command", command, "--args", ...args],
  },
};

export const defaultCommandRunner: CommandRunner = async (command, args) => {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    child.once("error", (error: NodeJS.ErrnoException) => {
      resolve({ found: error.code !== "ENOENT", code: 1 });
    });
    child.once("exit", (code) => resolve({ found: true, code: code ?? 1 }));
  });
};

export async function configureClients(options: {
  helper: string;
  command?: string;
  args?: string[];
  clients?: SetupClient[];
  run?: CommandRunner;
}) {
  const run = options.run ?? defaultCommandRunner;
  const command = options.command ?? options.helper;
  const commandArgs = options.args ?? ["serve"];
  const clients = options.clients ?? (Object.keys(CLIENTS) as SetupClient[]);
  const statuses: Array<{
    client: SetupClient;
    status: "configured" | "not_installed" | "failed";
    restartRequired: boolean;
    reason?: "command_not_found" | "registration_failed";
  }> = [];

  for (const client of clients) {
    const config = CLIENTS[client];
    const detected = await run(config.command, ["--version"]);
    if (!detected.found) {
      statuses.push({
        client,
        status: "not_installed",
        restartRequired: false,
        reason: "command_not_found",
      });
      continue;
    }
    await run(config.command, config.remove);
    const added = await run(config.command, config.add(command, commandArgs));
    statuses.push({
      client,
      status: added.code === 0 ? "configured" : "failed",
      restartRequired: added.code === 0,
      ...(added.code === 0 ? {} : { reason: "registration_failed" as const }),
    });
  }

  return {
    helper: options.helper,
    mcp: { command, args: commandArgs },
    clients: statuses,
    generic: {
      mcpServers: {
        aliasmode: {
          command,
          args: commandArgs,
        },
      },
    },
  };
}
