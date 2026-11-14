import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { CloudApiError } from "./cloud-client.ts";

/** OpenAI chat-completions message, the format DeepSeek, OpenRouter, Ollama and LM Studio all accept. */
export interface AgentMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export type AgentStatus = "idle" | "running" | "paused" | "error";

export interface AgentConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: AgentStatus;
  /** "credits": AliasMode credits ran out; the run continues after a top-up. */
  pauseReason?: "credits";
  error?: string;
  /** Spent AliasMode credits in micro-USD (1,000,000 = $1). Own models cost nothing here. */
  billedMicro: number;
  messages: AgentMessage[];
}

export type AgentConversationSummary = Omit<AgentConversation, "messages">;

export interface AgentSettings {
  source: "aliasmode" | "own";
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface AgentSettingsView {
  source: "aliasmode" | "own";
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

export interface AgentTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface AgentToolSession {
  /** The tool host stopped (crashed or closed); a new one is needed. */
  readonly exited?: boolean;
  listTools(): Promise<AgentTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): void;
}

export interface AgentChatRequest {
  messages: ({ role: "system"; content: string } | AgentMessage)[];
  tools: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
}

export interface AgentChatResult {
  message: AgentMessage;
  billedMicro?: number;
}

export type AgentChat = (request: AgentChatRequest, signal: AbortSignal) => Promise<AgentChatResult>;

export class AgentError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** AliasMode credits ran out; the conversation pauses until the workspace tops up. */
export class AgentCreditsError extends Error {}

/** Results above this are cut: one page snapshot of a busy feed can be 100k+ characters. */
export const TOOL_RESULT_MAX_CHARS = 40_000;
/** Above this transcript size, old tool output is dropped once (keeps the cached prefix stable afterwards). */
const COMPACT_ABOVE_CHARS = 300_000;
const KEEP_RECENT_TOOL_RESULTS = 2;
const HELPER_IDLE_MS = 30 * 60_000;
const COMPACTED = "[Older tool output removed to save space. Call the tool again if you need it.]";
/** Tools that return files or images the agent cannot use. */
const HIDDEN_TOOLS = new Set(["browser_take_screenshot", "browser_pdf_save", "browser_start_tracing", "browser_stop_tracing", "browser_install"]);

export const AGENT_SYSTEM_PROMPT = `You are the AliasMode agent. AliasMode is an antidetect browser manager: every profile is a separate browser identity with its own fingerprint, cookies and proxy. You work for the user inside their AliasMode app and act through tools.

How to work:
- Do the whole task yourself. Do not ask for confirmation; ask a question only when the task cannot be done without the answer.
- To act on a website in a profile: call aliasmode_browser_open (it opens the profile and selects it), then use the browser_* tools. Only one browser is selected at a time; use aliasmode_browser_select to switch between open browsers.
- Read pages with browser_snapshot and act with the element refs it returns. Prefer browser_navigate to a known URL over clicking through menus.
- Use aliasmode_profiles_list to find profiles by name, group, or proxy. When you create profiles that reuse proxies from other profiles, copy those proxy settings.
- Deleting a profile moves it to Trash. You can list Trash and restore profiles from it. You cannot empty Trash; only the user can.
- Close browsers you opened when the task no longer needs them, unless the user wants them open.
- When you write posts or messages, write natural text that fits the site and the account. Follow any SOP the user gives step by step.
- Finish with a short, clear report: what you did, what you found, and anything that failed.`;

const LOCAL_TOOLS: AgentTool[] = [
  {
    name: "aliasmode_trash_list",
    description: "List profiles in Trash.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "aliasmode_trash_restore",
    description: "Restore profiles from Trash.",
    inputSchema: {
      type: "object",
      properties: { profileIds: { type: "array", items: { type: "string" }, minItems: 1 } },
      required: ["profileIds"],
      additionalProperties: false,
    },
  },
];

export interface AgentRunnerOptions {
  root: string;
  /** Storage scope: the signed-in Cloud account, or "local". Undefined when signed out of Cloud. */
  scope: () => string | undefined;
  /** Starts the MCP helper for one conversation. */
  openTools: () => AgentToolSession;
  /** Model provider: AliasMode credits (undefined without a Cloud account) or the user's own model. */
  cloudChat?: () => AgentChat | undefined;
  ownChat?: (settings: Required<Pick<AgentSettings, "baseUrl" | "model">> & { apiKey?: string }) => AgentChat;
  trash: (operation: "list" | "restore", profileIds?: string[]) => Promise<unknown>;
  log?: (message: string) => void;
}

interface Active {
  controller: AbortController;
  done: Promise<void>;
}

export class AgentRunner {
  private readonly active = new Map<string, Active>();
  private readonly helpers = new Map<string, { session: AgentToolSession; timer?: ReturnType<typeof setTimeout> }>();
  private pauses = 0;
  private closing = false;

  constructor(private readonly options: AgentRunnerOptions) {}

  private dir(): string {
    const scope = this.options.scope();
    if (!scope) throw new AgentError("Sign in to AliasMode Cloud first", 401);
    return join(this.options.root, "agent", scope.replace(/[^a-zA-Z0-9-]/g, "_"));
  }

  private conversationPath(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new AgentError("Unknown conversation", 404);
    return join(this.dir(), "conversations", `${id}.json`);
  }

  private settingsPath(): string {
    return join(this.options.root, "agent", "settings.json");
  }

  settings(): AgentSettings {
    try {
      const raw = JSON.parse(readFileSync(this.settingsPath(), "utf8"));
      return {
        source: raw.source === "own" ? "own" : "aliasmode",
        ...(typeof raw.baseUrl === "string" ? { baseUrl: raw.baseUrl } : {}),
        ...(typeof raw.model === "string" ? { model: raw.model } : {}),
        ...(typeof raw.apiKey === "string" && raw.apiKey ? { apiKey: raw.apiKey } : {}),
      };
    } catch {
      return { source: "aliasmode" };
    }
  }

  settingsView(): AgentSettingsView {
    const settings = this.settings();
    return { source: settings.source, baseUrl: settings.baseUrl ?? "", model: settings.model ?? "", hasKey: !!settings.apiKey };
  }

  /** `apiKey` undefined keeps the saved key; an empty string removes it. */
  saveSettings(input: unknown): AgentSettingsView {
    const body = (input ?? {}) as Record<string, unknown>;
    if (body.source !== "aliasmode" && body.source !== "own") throw new AgentError("Choose a model source");
    const current = this.settings();
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/+$/, "") : current.baseUrl;
    const model = typeof body.model === "string" ? body.model.trim() : current.model;
    if (body.source === "own") {
      if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw new AgentError("Enter the model server URL, for example http://localhost:11434/v1");
      if (!model) throw new AgentError("Enter the model name");
    }
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : current.apiKey;
    const next: AgentSettings = { source: body.source, ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}), ...(apiKey ? { apiKey } : {}) };
    writeJson(this.settingsPath(), next, true);
    return this.settingsView();
  }

  list(): AgentConversationSummary[] {
    const dir = join(this.dir(), "conversations");
    if (!existsSync(dir)) return [];
    const items: AgentConversationSummary[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const { messages: _messages, ...summary } = this.read(file.slice(0, -5));
        items.push(summary);
      } catch {}
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): AgentConversation {
    return this.read(id);
  }

  private read(id: string): AgentConversation {
    const path = this.conversationPath(id);
    if (!existsSync(path)) throw new AgentError("Unknown conversation", 404);
    const conversation = JSON.parse(readFileSync(path, "utf8")) as AgentConversation;
    if (!this.active.has(id)) {
      // A run that was cut by an app exit is no longer running, and models refuse tool calls without results.
      if (conversation.status === "running") conversation.status = "idle";
      answerOpenToolCalls(conversation.messages);
    }
    return conversation;
  }

  private save(conversation: AgentConversation): void {
    conversation.updatedAt = new Date().toISOString();
    writeJson(this.conversationPath(conversation.id), conversation, false);
  }

  pause(): () => void {
    this.pauses++;
    return () => { this.pauses--; };
  }

  start(prompt: unknown): AgentConversation {
    const text = cleanPrompt(prompt);
    const now = new Date().toISOString();
    const conversation: AgentConversation = {
      id: randomUUID(),
      title: text.replace(/\s+/g, " ").slice(0, 80),
      createdAt: now,
      updatedAt: now,
      status: "idle",
      billedMicro: 0,
      messages: [{ role: "user", content: text }],
    };
    this.save(conversation);
    return this.launch(conversation);
  }

  send(id: string, prompt: unknown): AgentConversation {
    const text = cleanPrompt(prompt);
    if (this.active.has(id)) throw new AgentError("The agent is still working on this chat", 409);
    const conversation = this.read(id);
    conversation.messages.push({ role: "user", content: text });
    this.save(conversation);
    return this.launch(conversation);
  }

  /** Continues a paused or failed run from where it stopped. */
  resume(id: string): AgentConversation {
    if (this.active.has(id)) throw new AgentError("The agent is still working on this chat", 409);
    return this.launch(this.read(id));
  }

  async stop(id: string): Promise<AgentConversation> {
    const active = this.active.get(id);
    if (active) {
      active.controller.abort();
      await active.done;
    }
    return this.read(id);
  }

  async remove(id: string): Promise<void> {
    await this.stop(id);
    this.closeHelper(id);
    rmSync(this.conversationPath(id), { force: true });
  }

  /** Stops every run, for an account change or app exit. */
  async stopAll(): Promise<void> {
    for (const active of this.active.values()) active.controller.abort();
    await Promise.all([...this.active.values()].map((active) => active.done));
    for (const id of [...this.helpers.keys()]) this.closeHelper(id);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await this.stopAll();
  }

  private launch(conversation: AgentConversation): AgentConversation {
    if (this.closing || this.pauses) throw new AgentError("The agent is paused while AliasMode changes accounts or shuts down", 409);
    const chat = this.chat();
    const controller = new AbortController();
    conversation.status = "running";
    delete conversation.pauseReason;
    delete conversation.error;
    this.save(conversation);
    const done = this.loop(conversation, chat, controller.signal)
      .catch((error) => {
        if (error instanceof AgentCreditsError) {
          conversation.status = "paused";
          conversation.pauseReason = "credits";
        } else if (controller.signal.aborted) {
          conversation.status = "idle";
        } else {
          conversation.status = "error";
          conversation.error = error instanceof Error ? error.message : String(error);
          this.options.log?.(`agent run failed: ${conversation.error}`);
        }
      })
      .finally(() => {
        if (conversation.status === "running") conversation.status = "idle";
        try { this.save(conversation); } catch {}
        this.active.delete(conversation.id);
        this.idleHelper(conversation.id);
      });
    this.active.set(conversation.id, { controller, done });
    return structuredClone(conversation);
  }

  private chat(): AgentChat {
    const settings = this.settings();
    if (settings.source === "own") {
      if (!settings.baseUrl || !settings.model || !this.options.ownChat) throw new AgentError("Set up your own model in Agent settings");
      return this.options.ownChat({ baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey });
    }
    const chat = this.options.cloudChat?.();
    if (!chat) throw new AgentError("Sign in to AliasMode Cloud to use AliasMode credits, or set up your own model in Agent settings", 401);
    return chat;
  }

  private helper(id: string): AgentToolSession {
    const existing = this.helpers.get(id);
    if (existing?.session.exited) this.closeHelper(id);
    else if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = undefined;
      return existing.session;
    }
    const session = this.options.openTools();
    this.helpers.set(id, { session });
    return session;
  }

  /** Browsers the agent opened stay open between messages; an idle chat releases them. */
  private idleHelper(id: string): void {
    const helper = this.helpers.get(id);
    if (!helper) return;
    helper.timer = setTimeout(() => this.closeHelper(id), HELPER_IDLE_MS);
    if (typeof helper.timer === "object" && "unref" in helper.timer) helper.timer.unref();
  }

  private closeHelper(id: string): void {
    const helper = this.helpers.get(id);
    if (!helper) return;
    if (helper.timer) clearTimeout(helper.timer);
    this.helpers.delete(id);
    helper.session.close();
  }

  private async loop(conversation: AgentConversation, chat: AgentChat, signal: AbortSignal): Promise<void> {
    const tools = this.helper(conversation.id);
    while (!signal.aborted) {
      const available = [...(await tools.listTools()).filter((tool) => !HIDDEN_TOOLS.has(tool.name)), ...LOCAL_TOOLS];
      compact(conversation.messages);
      const result = await chat({
        messages: [{ role: "system", content: AGENT_SYSTEM_PROMPT }, ...conversation.messages],
        tools: available.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description ?? "",
            parameters: tool.inputSchema ?? { type: "object", properties: {} },
          },
        })),
      }, signal);
      conversation.billedMicro += result.billedMicro ?? 0;
      const calls = result.message.tool_calls?.filter((call) => call?.function?.name) ?? [];
      conversation.messages.push({
        role: "assistant",
        content: result.message.content ?? null,
        ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.function.name, arguments: call.function.arguments ?? "{}" } })) } : {}),
      });
      this.save(conversation);
      if (!calls.length) return;
      for (const call of calls) {
        const content = signal.aborted ? "Stopped by the user." : await this.callTool(tools, call.function.name, call.function.arguments);
        conversation.messages.push({ role: "tool", tool_call_id: call.id, content });
        this.save(conversation);
      }
    }
  }

  private async callTool(tools: AgentToolSession, name: string, rawArgs: string | undefined): Promise<string> {
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawArgs || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      args = parsed;
    } catch {
      return "Error: the tool arguments were not a valid JSON object.";
    }
    try {
      let text: string;
      if (name === "aliasmode_trash_list") text = JSON.stringify(await this.options.trash("list"));
      else if (name === "aliasmode_trash_restore") {
        const ids = Array.isArray(args.profileIds) ? args.profileIds.filter((id): id is string => typeof id === "string") : [];
        text = JSON.stringify(await this.options.trash("restore", ids));
      } else text = await tools.callTool(name, args);
      return text.length > TOOL_RESULT_MAX_CHARS
        ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n[Output cut at ${TOOL_RESULT_MAX_CHARS} characters.]`
        : text;
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

function answerOpenToolCalls(messages: AgentMessage[]): void {
  const index = messages.findLastIndex((message) => message.role === "assistant" && message.tool_calls?.length);
  if (index < 0) return;
  const answered = new Set(messages.slice(index + 1).map((message) => message.tool_call_id));
  for (const call of messages[index]!.tool_calls!) {
    if (!answered.has(call.id)) messages.push({ role: "tool", tool_call_id: call.id, content: "Stopped before this tool finished." });
  }
}

function cleanPrompt(prompt: unknown): string {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (!text) throw new AgentError("Write what the agent should do");
  return text;
}

/** Drops old tool output in one step when the transcript grows large, so later requests reuse a stable prefix. */
export function compact(messages: AgentMessage[]): void {
  const size = messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
  if (size <= COMPACT_ABOVE_CHARS) return;
  const toolIndexes = messages.flatMap((message, index) => message.role === "tool" ? [index] : []);
  for (const index of toolIndexes.slice(0, -KEEP_RECENT_TOOL_RESULTS)) {
    const message = messages[index]!;
    if ((message.content?.length ?? 0) > COMPACTED.length) message.content = COMPACTED;
  }
}

function writeJson(path: string, value: unknown, secret: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), secret ? { mode: 0o600 } : undefined);
  if (secret) try { chmodSync(temp, 0o600); } catch {}
  renameSync(temp, path);
}

/** Text of an MCP tools/call result; images become a note, since the agent reads snapshots instead. */
export function toolResultText(result: any): string {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts.map((part: any) => part?.type === "text" ? String(part.text ?? "") : `[${part?.type ?? "content"} omitted]`).join("\n");
  return result?.isError ? `Error: ${text}` : text;
}

type HelperChild = ChildProcessByStdio<Writable, Readable, null>;

/** One `aliasmode-mcp serve` process: the same tool host that Claude and the Cloud tunnel use. */
export class McpHelperSession implements AgentToolSession {
  private readonly child: HelperChild;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  exited = false;
  private readonly ready: Promise<void>;

  constructor(spawnChild: () => HelperChild) {
    this.child = spawnChild();
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      const waiter = typeof message?.id === "number" ? this.pending.get(message.id) : undefined;
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(String(message.error.message ?? "MCP error")));
      else waiter.resolve(message.result);
    });
    const fail = () => {
      this.exited = true;
      for (const waiter of this.pending.values()) waiter.reject(new Error("The AliasMode tool host stopped"));
      this.pending.clear();
    };
    this.child.once("error", fail);
    this.child.once("close", fail);
    this.child.stdin.on("error", () => {});
    this.ready = this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "aliasmode-agent", version: "1" },
    }).then(() => this.write({ jsonrpc: "2.0", method: "notifications/initialized" }));
    this.ready.catch(() => {});
  }

  private write(message: unknown): void {
    if (!this.exited) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: unknown): Promise<any> {
    if (this.exited) return Promise.reject(new Error("The AliasMode tool host stopped"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async listTools(): Promise<AgentTool[]> {
    await this.ready;
    return (await this.request("tools/list", {}))?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.ready;
    return toolResultText(await this.request("tools/call", { name, arguments: args }));
  }

  close(): void {
    if (this.exited) return;
    this.child.stdin.end();
    const timer = setTimeout(() => { if (!this.exited) this.child.kill(); }, 30_000);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  }
}

export function spawnMcpHelper(helperPath: string, env: NodeJS.ProcessEnv): HelperChild {
  return spawn(helperPath, ["serve"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env });
}

/** OpenAI-compatible chat completions on the user's own server (Ollama, LM Studio, OpenRouter, OpenAI...). */
export function ownModelChat(
  settings: { baseUrl: string; model: string; apiKey?: string },
  fetchFn: typeof fetch = fetch,
): AgentChat {
  return async (request, signal) => {
    let response: Response;
    try {
      response = await fetchFn(`${settings.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: settings.model, messages: request.messages, tools: request.tools }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AgentError(`Your model server at ${settings.baseUrl} did not answer`, 502);
    }
    const body = await response.json().catch(() => undefined) as any;
    if (!response.ok) {
      const detail = typeof body?.error === "string" ? body.error : body?.error?.message;
      throw new AgentError(`Your model server answered ${response.status}${detail ? `: ${String(detail).slice(0, 300)}` : ""}`, 502);
    }
    const message = body?.choices?.[0]?.message;
    if (!message) throw new AgentError("Your model server sent no answer", 502);
    return { message };
  };
}

/** AliasMode credits: Cloud forwards to the agent model and charges the free allowance, then the wallet. */
export function cloudChat(call: (body: unknown, signal: AbortSignal) => Promise<any>): AgentChat {
  return async (request, signal) => {
    let body: any;
    try {
      body = await call({ messages: request.messages, tools: request.tools }, signal);
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 402) throw new AgentCreditsError(error.message);
      throw error;
    }
    const message = body?.choices?.[0]?.message;
    if (!message) throw new AgentError("The AliasMode agent model sent no answer", 502);
    return { message, billedMicro: Number(body?.aliasmode?.billedMicro) || 0 };
  };
}
