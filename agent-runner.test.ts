import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunner,
  McpHelperSession,
  TOOL_RESULT_MAX_CHARS,
  cloudChat,
  compact,
  ownModelChat,
  type AgentChat,
  type AgentConversation,
  type AgentMessage,
  type AgentRunnerOptions,
  type AgentToolSession,
} from "./agent-runner.ts";
import { CloudApiError } from "./cloud-client.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeTools(calls: { name: string; args: Record<string, unknown> }[] = []) {
  let closed = 0;
  const session: AgentToolSession = {
    listTools: async () => [
      { name: "aliasmode_profiles_list", description: "List", inputSchema: { type: "object" } },
      { name: "browser_take_screenshot", description: "Screenshot" },
    ],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return name === "big" ? "x".repeat(TOOL_RESULT_MAX_CHARS + 10) : `result of ${name}`;
    },
    close: () => { closed++; },
  };
  return { session, calls, closed: () => closed };
}

function toolCall(id: string, name: string, args: unknown = {}): AgentMessage {
  return { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

function runner(chat: AgentChat, overrides: Partial<AgentRunnerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-agent-"));
  roots.push(root);
  const tools = fakeTools();
  const agent = new AgentRunner({
    root,
    scope: () => "local",
    openTools: () => tools.session,
    cloudChat: () => chat,
    trash: async (operation, ids) => ({ operation, ids }),
    ...overrides,
  });
  return { agent, tools, root };
}

async function settled(agent: AgentRunner, id: string): Promise<AgentConversation> {
  for (let i = 0; i < 200; i++) {
    const conversation = agent.get(id);
    if (conversation.status !== "running") return conversation;
    await Bun.sleep(5);
  }
  throw new Error("run did not settle");
}

describe("AgentRunner", () => {
  test("runs tool steps until the model answers, and saves the transcript", async () => {
    const requests: Parameters<AgentChat>[0][] = [];
    const answers: AgentMessage[] = [
      toolCall("c1", "aliasmode_profiles_list"),
      toolCall("c2", "big"),
      toolCall("c3", "aliasmode_trash_restore", { profileIds: ["p1"] }),
      { role: "assistant", content: "Done: 2 profiles found." },
    ];
    const { agent, tools } = runner(async (request) => {
      requests.push(structuredClone(request));
      return { message: answers.shift()!, billedMicro: 1_000 };
    });
    const started = agent.start("  List my profiles  ");
    expect(started.status).toBe("running");
    expect(started.title).toBe("List my profiles");
    const done = await settled(agent, started.id);
    expect(done.status).toBe("idle");
    expect(done.billedMicro).toBe(4_000);
    expect(done.messages.at(-1)).toEqual({ role: "assistant", content: "Done: 2 profiles found." });
    expect(tools.calls.map((call) => call.name)).toEqual(["aliasmode_profiles_list", "big"]);
    const results = done.messages.filter((message) => message.role === "tool");
    expect(results[0]).toEqual({ role: "tool", tool_call_id: "c1", content: "result of aliasmode_profiles_list" });
    expect(results[1]!.content!.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 100);
    expect(results[1]!.content).toContain("Output cut");
    expect(results[2]!.content).toBe(JSON.stringify({ operation: "restore", ids: ["p1"] }));
    // System prompt first; screenshots hidden; Trash tools added.
    expect(requests[0]!.messages[0]!.role).toBe("system");
    const names = requests[0]!.tools.map((tool) => tool.function.name);
    expect(names).toContain("aliasmode_trash_restore");
    expect(names).not.toContain("browser_take_screenshot");
    expect(agent.list().map((item) => item.id)).toEqual([started.id]);
  });

  test("pauses when credits run out and continues the same transcript", async () => {
    let fail = true;
    const { agent } = runner(async () => ({ message: { role: "assistant", content: "" } }), {
      cloudChat: () => cloudChat(async () => {
        if (fail) throw new CloudApiError("Not enough credits", "insufficient_credits", 402);
        return { choices: [{ message: { role: "assistant", content: "Finished." } }], aliasmode: { billedMicro: 250 } };
      }),
    });
    const started = agent.start("Do it");
    const paused = await settled(agent, started.id);
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("credits");
    fail = false;
    agent.resume(started.id);
    const done = await settled(agent, started.id);
    expect(done.status).toBe("idle");
    expect(done.pauseReason).toBeUndefined();
    expect(done.billedMicro).toBe(250);
    expect(done.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  test("stop answers pending tool calls so the transcript stays valid", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { agent } = runner(async (_request, signal) => {
      await gate;
      if (signal.aborted) throw new Error("aborted");
      return { message: { role: "assistant", content: null, tool_calls: [
        { id: "a", type: "function", function: { name: "aliasmode_profiles_list", arguments: "{}" } },
      ] } };
    });
    const started = agent.start("Loop");
    const stopping = agent.stop(started.id);
    release();
    const stopped = await stopping;
    expect(stopped.status).toBe("idle");
    expect(() => agent.send(started.id, "next")).not.toThrow();
    await agent.stop(started.id);
  });

  test("a crashed tool host is replaced, and a cut transcript is repaired on load", async () => {
    let opened = 0;
    const dead = { exited: true, listTools: async () => { throw new Error("The AliasMode tool host stopped"); }, callTool: async () => "", close: () => {} };
    const { agent, root } = runner(async () => ({ message: { role: "assistant", content: "ok" } }), {
      openTools: () => (opened++ === 0 ? dead : fakeTools().session),
    });
    const first = agent.start("one");
    expect((await settled(agent, first.id)).status).toBe("error");
    agent.resume(first.id);
    expect((await settled(agent, first.id)).status).toBe("idle");
    expect(opened).toBe(2);

    // An app exit after the model asked for tools but before their results.
    const path = join(root, "agent", "local", "conversations", `${first.id}.json`);
    const saved = JSON.parse(await Bun.file(path).text());
    saved.status = "running";
    saved.messages.push(toolCall("x1", "aliasmode_profiles_list"));
    await Bun.write(path, JSON.stringify(saved));
    const loaded = agent.get(first.id);
    expect(loaded.status).toBe("idle");
    expect(loaded.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "x1", content: "Stopped before this tool finished." });
  });

  test("own model settings are validated and the key is kept private", async () => {
    const { agent, root } = runner(async () => ({ message: { role: "assistant", content: "ok" } }));
    expect(() => agent.saveSettings({ source: "own", baseUrl: "localhost:11434", model: "qwen" })).toThrow("model server URL");
    const view = agent.saveSettings({ source: "own", baseUrl: "http://localhost:11434/v1/", model: "qwen3", apiKey: "secret" });
    expect(view).toEqual({ source: "own", baseUrl: "http://localhost:11434/v1", model: "qwen3", hasKey: true });
    expect(JSON.stringify(view)).not.toContain("secret");
    if (process.platform !== "win32") expect(statSync(join(root, "agent", "settings.json")).mode & 0o777).toBe(0o600);
    expect(agent.saveSettings({ source: "aliasmode" }).hasKey).toBe(true);
    expect(agent.saveSettings({ source: "aliasmode", apiKey: "" }).hasKey).toBe(false);
  });

  test("AliasMode credits need a Cloud account", () => {
    const { agent } = runner(async () => ({ message: { role: "assistant", content: "" } }), { cloudChat: () => undefined });
    expect(() => agent.start("hi")).toThrow("Sign in to AliasMode Cloud");
  });

  test("a signed-out Cloud scope refuses access", () => {
    const { agent } = runner(async () => ({ message: { role: "assistant", content: "" } }), { scope: () => undefined });
    expect(() => agent.list()).toThrow("Sign in");
  });

  test("account changes pause new runs", () => {
    const { agent } = runner(async () => ({ message: { role: "assistant", content: "" } }));
    const resume = agent.pause();
    expect(() => agent.start("hi")).toThrow("paused");
    resume();
    expect(() => agent.start("hi")).not.toThrow();
  });
});

describe("compact", () => {
  test("drops old tool output once the transcript is large and keeps the latest results", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "go" }];
    for (let i = 0; i < 10; i++) messages.push({ role: "tool", tool_call_id: String(i), content: "y".repeat(40_000) });
    compact(messages);
    const tools = messages.filter((message) => message.role === "tool");
    expect(tools.slice(0, -2).every((message) => message.content!.startsWith("[Older tool output"))).toBe(true);
    expect(tools.slice(-2).every((message) => message.content!.length === 40_000)).toBe(true);
    const small: AgentMessage[] = [{ role: "tool", tool_call_id: "1", content: "z".repeat(1000) }, { role: "tool", tool_call_id: "2", content: "z" }, { role: "tool", tool_call_id: "3", content: "z" }];
    compact(small);
    expect(small[0]!.content!.length).toBe(1000);
  });
});

describe("model providers", () => {
  test("own model posts OpenAI chat completions with the key", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const chat = ownModelChat({ baseUrl: "http://localhost:11434/v1", model: "qwen3", apiKey: "k" }, (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return Response.json({ choices: [{ message: { role: "assistant", content: "hello" } }] });
    }) as typeof fetch);
    const result = await chat({ messages: [{ role: "user", content: "hi" }], tools: [] }, new AbortController().signal);
    expect(result.message.content).toBe("hello");
    expect(seen!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(new Headers(seen!.init.headers).get("authorization")).toBe("Bearer k");
    expect(JSON.parse(String(seen!.init.body)).model).toBe("qwen3");
  });

  test("own model errors name the server", async () => {
    const chat = ownModelChat({ baseUrl: "http://localhost:1/v1", model: "m" }, (async () => Response.json({ error: { message: "model not found" } }, { status: 404 })) as unknown as typeof fetch);
    await expect(chat({ messages: [], tools: [] }, new AbortController().signal)).rejects.toThrow("404: model not found");
  });
});

describe("McpHelperSession", () => {
  test("initializes, lists tools and returns text results", async () => {
    const script = `
      const rl = require("node:readline").createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const m = JSON.parse(line);
        if (m.id === undefined) return;
        const result = m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "t", version: "1" } }
          : m.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: "hi " + m.params.arguments.who }, { type: "image", data: "" }] };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
      });`;
    const session = new McpHelperSession(() => spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "ignore"] }));
    expect((await session.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
    expect(await session.callTool("echo", { who: "you" })).toBe("hi you\n[image omitted]");
    session.close();
  });
});

describe("agent UI routes", () => {
  test("require the desktop nonce and trusted origin", async () => {
    const { handleUiRequest } = await import("./ui.ts");
    const { agent } = runner(async () => ({ message: { role: "assistant", content: "Hello." } }));
    const nonce = "b".repeat(64);
    const options = { scripts: { nonce } as any, agent };
    for (const [method, path] of [["GET", ""], ["GET", "/usage"], ["POST", "/settings"], ["POST", "/conversations"], ["GET", "/conversations/x"], ["POST", "/conversations/x/stop"], ["DELETE", "/conversations/x"]]) {
      const response = await handleUiRequest(new Request(`http://127.0.0.1/ui/api/agent${path}`, { method }), {} as any, {} as any, null, options);
      expect(response?.status).toBe(401);
    }
    const foreign = await handleUiRequest(new Request("http://127.0.0.1/ui/api/agent", {
      headers: { authorization: `Bearer ${nonce}`, origin: "https://foreign.test" },
    }), {} as any, {} as any, null, options);
    expect(foreign?.status).toBe(403);
    const started = await handleUiRequest(new Request("http://127.0.0.1/ui/api/agent/conversations", {
      method: "POST", headers: { authorization: `Bearer ${nonce}`, "content-type": "application/json" }, body: JSON.stringify({ prompt: "Say hello" }),
    }), {} as any, {} as any, null, options);
    expect(started?.status).toBe(200);
    const { conversation } = await started!.json() as any;
    expect((await settled(agent, conversation.id)).messages.at(-1)?.content).toBe("Hello.");
    const listed = await handleUiRequest(new Request("http://127.0.0.1/ui/api/agent", { headers: { authorization: `Bearer ${nonce}` } }), {} as any, {} as any, null, options);
    expect(((await listed!.json()) as any).conversations).toHaveLength(1);
    const missing = await handleUiRequest(new Request("http://127.0.0.1/ui/api/agent/conversations/not-a-uuid", { headers: { authorization: `Bearer ${nonce}` } }), {} as any, {} as any, null, options);
    expect(missing?.status).toBe(404);
  });
});
