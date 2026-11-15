import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "./i18n.tsx";
import { Markdown } from "./markdown.tsx";
import { WalletPanel, formatUsd } from "./store.tsx";
import {
  deleteAgentConversation,
  fetchAgent,
  fetchAgentConversation,
  fetchAgentUsage,
  resumeAgentConversation,
  saveAgentSettings,
  sendAgentMessage,
  startAgentConversation,
  stopAgentConversation,
  type AgentConversation,
  type AgentConversationSummary,
  type AgentMessage,
  type AgentSettingsView,
} from "./api.ts";
import type { AiUsageResponse, GetWalletResponse } from "../contracts/cloud-v1.ts";

const POLL_MS = 1500;
const STEP_TEXT_MAX = 2000;
const DAY_MS = 86_400_000;

type Translate = (source: string, values?: Record<string, string | number>) => string;

const GLYPHS = {
  sparkle: <><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>,
  arrowUp: <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />,
  arrowDown: <path d="M12 5v14M5.5 12.5L12 19l6.5-6.5" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />,
  compose: <><path d="M11 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-5" /><path d="M18.4 2.6a2 2 0 012.9 2.9L12 14.8l-4 1 1-4z" /></>,
  trash: <><path d="M4 7h16M10 7V5a1 1 0 011-1h2a1 1 0 011 1v2" /><path d="M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12" /></>,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  expand: <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />,
  close: <path d="M18 6L6 18M6 6l12 12" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" /></>,
  user: <><circle cx="12" cy="8" r="3.6" /><path d="M5 20c.6-4 3-6 7-6s6.4 2 7 6" /></>,
  users: <><circle cx="9" cy="8" r="3.4" /><path d="M2.5 20c.5-3.6 2.9-5.6 6.5-5.6s6 2 6.5 5.6" /><path d="M16 4.8a3.4 3.4 0 010 6.4M18.5 14.6c1.7.8 2.7 2.6 3 5.4" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  pointer: <path d="M5 3l6.5 17 2.4-7.1L21 10.5z" />,
  keyboard: <><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>,
  camera: <><path d="M4 8a2 2 0 012-2h2l2-2h4l2 2h2a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2z" /><circle cx="12" cy="13" r="3.5" /></>,
  list: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
  window: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  tool: <path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" />,
  wallet: <><path d="M17 7V5a1 1 0 00-1-1H5a2 2 0 000 4h14a1 1 0 011 1v3" /><path d="M3 6v12a2 2 0 002 2h14a1 1 0 001-1v-3" /><path d="M21 12h-4a2 2 0 000 4h4z" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16.2v.3" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
  shield: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></>,
  trend: <><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
} as const;

type GlyphName = keyof typeof GLYPHS;

function Glyph({ name, className }: { name: GlyphName; className?: string }) {
  return <svg className={className ? `icon ${className}` : "icon"} viewBox="0 0 24 24" aria-hidden="true">{GLYPHS[name]}</svg>;
}

const SUGGESTIONS: { icon: GlyphName; title: string; text: string }[] = [
  { icon: "users", title: "Create profiles", text: "Create 5 profiles that reuse the proxies of profiles A and B, open example.com in each and tell me what you see" },
  { icon: "trend", title: "Draft posts on X", text: "Open my X profile, find what is trending in my niche today and draft 3 posts" },
  { icon: "shield", title: "Check proxies", text: "Check which of my profiles have a failing proxy" },
  { icon: "mail", title: "Summarize Gmail", text: "Open profile A, go to the Gmail inbox and summarize the unread emails" },
];

/** Micro-USD (1,000,000 = $1) as dollars and cents; a tiny non-zero amount shows as "<$0.01". */
export function formatMicroUsd(micro: number, language = "en-US"): string {
  if (micro > 0 && micro < 5_000) return `<${formatUsd(1, language)}`;
  return formatUsd(Math.round(micro / 10_000), language);
}

/** "aliasmode_profiles_list" → "Profiles list", "browser_navigate" → "Navigate". */
export function toolLabel(name: string): string {
  const words = name.replace(/^aliasmode_/, "").replace(/^browser_/, "").split("_").filter(Boolean).join(" ");
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

export function clip(text: string, max = STEP_TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function prettyArgs(args: string): string {
  try { return JSON.stringify(JSON.parse(args), null, 2); } catch { return args; }
}

function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return ""; }
}

/** A short past-tense line for one tool call, with an icon: "Opened example.com", "Read the page". */
export function describeStep(step: { name: string; args: string }, t: Translate): { label: string; icon: GlyphName } {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(step.args || "{}");
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch { /* plain or partial arguments */ }
  const text = (key: string) => typeof args[key] === "string" ? clip((args[key] as string).trim(), 48) : "";
  const element = text("element");
  switch (step.name) {
    case "aliasmode_profiles_list": return { label: t("Listed profiles"), icon: "list" };
    case "aliasmode_profile_create": {
      const name = text("name");
      return { label: name ? t("Created profile {name}", { name }) : t("Created a profile"), icon: "user" };
    }
    case "aliasmode_profile_update": return { label: t("Updated a profile"), icon: "user" };
    case "aliasmode_profile_delete": return { label: t("Moved a profile to Trash"), icon: "trash" };
    case "aliasmode_profiles_replace_proxies": return { label: t("Changed proxies"), icon: "shield" };
    case "aliasmode_trash_list": return { label: t("Checked Trash"), icon: "trash" };
    case "aliasmode_trash_restore": return { label: t("Restored from Trash"), icon: "trash" };
    case "aliasmode_browser_open": return { label: t("Opened profile"), icon: "window" };
    case "aliasmode_browser_select": return { label: t("Switched browser"), icon: "window" };
    case "aliasmode_browser_status": return { label: t("Checked browser"), icon: "window" };
    case "aliasmode_browser_close":
    case "browser_close": return { label: t("Closed browser"), icon: "window" };
    case "browser_navigate": {
      const host = hostOf(typeof args.url === "string" ? args.url : "");
      return { label: host ? t("Opened {host}", { host }) : t("Opened a page"), icon: "globe" };
    }
    case "browser_navigate_back": return { label: t("Went back"), icon: "globe" };
    case "browser_snapshot": return { label: t("Read the page"), icon: "eye" };
    case "browser_take_screenshot": return { label: t("Took a screenshot"), icon: "camera" };
    case "browser_click": return { label: element ? t("Clicked {element}", { element }) : t("Clicked"), icon: "pointer" };
    case "browser_hover": return { label: t("Hovered"), icon: "pointer" };
    case "browser_select_option": return { label: t("Selected an option"), icon: "pointer" };
    case "browser_type": return { label: element ? t("Typed into {element}", { element }) : t("Typed"), icon: "keyboard" };
    case "browser_fill_form": return { label: t("Filled in a form"), icon: "keyboard" };
    case "browser_press_key": {
      const key = text("key");
      return { label: key ? t("Pressed {key}", { key }) : t("Pressed a key"), icon: "keyboard" };
    }
    case "browser_wait_for": return { label: t("Waited"), icon: "clock" };
    case "browser_tabs": return { label: t("Switched tabs"), icon: "window" };
    default: return { label: toolLabel(step.name), icon: "tool" };
  }
}

export interface AgentStep { id: string; name: string; args: string; result?: string }
export type AgentTurn = { role: "user"; text: string } | { role: "agent"; steps: AgentStep[]; texts: string[] };

/** Groups the transcript: each user message, then one agent turn with its tool steps and its text. */
export function agentTurns(messages: AgentMessage[]): AgentTurn[] {
  const turns: AgentTurn[] = [];
  const steps = new Map<string, AgentStep>();
  for (const message of messages) {
    if (message.role === "user") { turns.push({ role: "user", text: message.content ?? "" }); continue; }
    if (message.role === "tool") {
      const step = steps.get(message.tool_call_id ?? "");
      if (step) step.result = message.content ?? "";
      continue;
    }
    let turn = turns.at(-1);
    if (turn?.role !== "agent") { turn = { role: "agent", steps: [], texts: [] }; turns.push(turn); }
    if (message.content?.trim()) turn.texts.push(message.content.trim());
    for (const call of message.tool_calls ?? []) {
      const step: AgentStep = { id: call.id, name: call.function.name, args: call.function.arguments };
      steps.set(call.id, step);
      turn.steps.push(step);
    }
  }
  return turns;
}

/** Chat history buckets, newest first, like ChatGPT's sidebar. */
export function groupConversations<T extends { updatedAt: string }>(items: T[], now = new Date()): { label: "Today" | "Previous 7 days" | "Older"; items: T[] }[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups: { label: "Today" | "Previous 7 days" | "Older"; items: T[] }[] = [
    { label: "Today", items: [] }, { label: "Previous 7 days", items: [] }, { label: "Older", items: [] },
  ];
  for (const item of items) {
    const time = Date.parse(item.updatedAt);
    groups[time >= today ? 0 : time >= today - 7 * DAY_MS ? 1 : 2]!.items.push(item);
  }
  return groups.filter((group) => group.items.length > 0);
}

/** Close a popover on an outside click or Escape. */
function useDismiss<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  const onClose = useRef(close);
  onClose.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) onClose.current(); };
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose.current(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return ref;
}

/** Agent state shared by the full page and the side panel, so both show the same chat and draft. */
function useAgentController(visible: boolean) {
  const [settings, setSettings] = useState<AgentSettingsView | null>(null);
  const [conversations, setConversations] = useState<AgentConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<AgentConversation | null>(null);
  const [usage, setUsage] = useState<AiUsageResponse | null>(null);
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const fail = (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure));
  const loadUsage = useCallback(() => fetchAgentUsage().then(setUsage, () => setUsage(null)), []);
  const loadList = useCallback(() => fetchAgent().then((result) => {
    setSettings(result.settings);
    setConversations(result.conversations);
  }), []);
  const refresh = useCallback(() => {
    const id = selectedRef.current;
    if (id) void fetchAgentConversation(id).then((next) => { if (selectedRef.current === id) setConversation(next); }, () => {});
  }, []);
  const show = (next: AgentConversation) => {
    if (selectedRef.current !== null && selectedRef.current !== next.id) return;
    selectedRef.current = next.id;
    setSelectedId(next.id);
    setConversation(next);
    setConversations((list) => [next, ...list.filter((item) => item.id !== next.id)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  };
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await work(); } catch (failure) { fail(failure); } finally { setBusy(false); }
  };

  // The launcher shows a running chat before the agent is opened; errors show once it is.
  useEffect(() => {
    void loadList().catch((failure) => { if (visible) fail(failure); });
    if (!visible) return;
    void loadUsage();
    refresh();
  }, [visible, loadList, loadUsage, refresh]);

  // Runs continue in the background; poll while one is running.
  const anyRunning = conversation?.status === "running" || conversations.some((item) => item.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const timer = window.setInterval(() => { void loadList().catch(() => {}); refresh(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [anyRunning, loadList, refresh]);

  // A finished run changed the balance and the free allowance.
  const lastStatus = useRef(conversation?.status);
  useEffect(() => {
    if (lastStatus.current === "running" && conversation?.status !== "running") void loadUsage();
    lastStatus.current = conversation?.status;
  }, [conversation?.status, loadUsage]);

  const focus = () => setFocusKey((key) => key + 1);
  const open = (id: string) => {
    selectedRef.current = id;
    setSelectedId(id); setConversation(null); setError(null);
    void fetchAgentConversation(id).then((next) => { if (selectedRef.current === id) setConversation(next); }, fail);
  };
  const newChat = (text = "") => {
    selectedRef.current = null;
    setSelectedId(null); setConversation(null); setError(null); setComposer(text);
    focus();
  };
  const running = conversation?.status === "running";
  return {
    settings, setSettings, conversations, selectedId, conversation, usage, loadUsage, composer, setComposer, busy, error,
    focusKey, focus, running, anyRunning, open, newChat,
    remove: (id: string, question: string) => {
      if (!confirm(question)) return;
      void act(async () => {
        await deleteAgentConversation(id);
        setConversations((list) => list.filter((item) => item.id !== id));
        if (selectedRef.current === id) newChat();
      });
    },
    send: () => {
      const prompt = composer.trim();
      if (!prompt || busy || running) return;
      void act(async () => {
        show(conversation ? await sendAgentMessage(conversation.id, prompt) : await startAgentConversation(prompt));
        setComposer("");
      });
    },
    resume: () => conversation && void act(async () => show(await resumeAgentConversation(conversation.id))),
    stop: () => conversation && void act(async () => setConversation(await stopAgentConversation(conversation.id))),
  };
}

type Agent = ReturnType<typeof useAgentController>;

/**
 * The in-app agent: the full Agent page, plus a floating launcher and a side
 * panel on every other page. Both views share one controller.
 */
export function AgentHost({ active, cloudMode, owner, wallet, draft, onReloadWallet, onUseCloud, onOpenPage }: {
  /** The full Agent page is the current view. */
  active: boolean;
  cloudMode: boolean;
  /** Only the workspace owner can add funds. */
  owner: boolean;
  /** The workspace wallet when this Cloud has the in-app store; null otherwise. */
  wallet: GetWalletResponse | null;
  /** Text for the composer from "Ask agent" on the profile list; a new key starts a new chat with it. */
  draft: { text: string; key: number };
  onReloadWallet: () => Promise<void>;
  onUseCloud: () => void;
  onOpenPage: () => void;
}) {
  const { t } = useTranslation();
  const [panelOpen, setPanelOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const agent = useAgentController(active || panelOpen);
  const launcherRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!draft.key) return;
    agent.newChat(draft.text);
    if (!active) setPanelOpen(true);
  }, [draft.key]);
  useEffect(() => { if (active) setPanelOpen(false); }, [active]);

  const openWallet = () => { setWalletOpen(true); void onReloadWallet(); };
  const closePanel = () => {
    setPanelOpen(false);
    requestAnimationFrame(() => launcherRef.current?.focus());
  };
  const chat = (compact: boolean) => <AgentChat agent={agent} compact={compact} cloudMode={cloudMode} canTopUp={owner && !!wallet}
    onAddFunds={openWallet} onUseCloud={onUseCloud} />;

  return <>
    {active && <div className="workspace agent-page">
      <aside className="agent-history" aria-label={t("Chats")}>
        <button type="button" className="agent-newchat" onClick={() => agent.newChat()}>
          <Glyph name="compose" />{t("New chat")}
        </button>
        <ChatList agent={agent} />
      </aside>
      <section className="agent-main">{chat(false)}</section>
    </div>}

    {!active && !panelOpen && <button ref={launcherRef} type="button" className="agent-launcher" data-tip={t("Agent")}
      aria-label={agent.anyRunning ? t("Open the agent (working)") : t("Open the agent")} onClick={() => setPanelOpen(true)}>
      <Glyph name="sparkle" />
      {agent.anyRunning && <span className="agent-launcher-dot" aria-hidden="true" />}
    </button>}

    {!active && panelOpen && <aside className="agent-panel" role="dialog" aria-label={t("Agent")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !document.querySelector(".agent-panel .agent-pop")) { event.preventDefault(); closePanel(); }
      }}>
      <header className="agent-panel-head">
        <ChatSwitcher agent={agent} />
        <button type="button" className="agent-iconbtn" title={t("New chat")} aria-label={t("New chat")} onClick={() => agent.newChat()}><Glyph name="compose" /></button>
        <button type="button" className="agent-iconbtn" title={t("Open full screen")} aria-label={t("Open full screen")}
          onClick={() => { setPanelOpen(false); onOpenPage(); }}><Glyph name="expand" /></button>
        <button type="button" className="agent-iconbtn" title={t("Close")} aria-label={t("Close")} onClick={closePanel}><Glyph name="close" /></button>
      </header>
      {chat(true)}
    </aside>}

    {walletOpen && wallet && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setWalletOpen(false); }}
      onKeyDown={(event) => { if (event.key === "Escape") setWalletOpen(false); }}>
      <div className="agent-wallet proxy-page" role="dialog" aria-modal="true" aria-label={t("Add funds")}>
        <WalletPanel wallet={wallet} owner={owner} onClose={() => setWalletOpen(false)} onReload={async () => { await onReloadWallet(); await agent.loadUsage(); }} />
      </div>
    </div>}
  </>;
}

function ChatList({ agent, onPicked }: { agent: Agent; onPicked?: () => void }) {
  const { t } = useTranslation();
  if (!agent.conversations.length) return <p className="agent-chats-empty">{t("Your chats appear here.")}</p>;
  return <div className="agent-chats">
    {groupConversations(agent.conversations).map((group) => <section key={group.label}>
      <h4>{t(group.label)}</h4>
      <ul>
        {group.items.map((item) => {
          const current = item.id === agent.selectedId;
          return <li key={item.id} className={current ? "active" : undefined}>
            <button type="button" className="agent-chat-open" title={item.title} aria-current={current ? "true" : undefined}
              onClick={() => { agent.open(item.id); onPicked?.(); }}>
              <span className="agent-chat-title">{item.title || t("New chat")}</span>
              {item.status === "running"
                ? <span className="agent-spinner" role="img" aria-label={t("Working…")} />
                : item.status !== "idle" && <span className="agent-dot" data-status={item.status} aria-hidden="true" />}
            </button>
            <button type="button" className="agent-chat-del" title={t("Delete")} aria-label={t("Delete chat {title}", { title: item.title })}
              onClick={() => agent.remove(item.id, t("Delete this chat?"))}><Glyph name="trash" className="sm" /></button>
          </li>;
        })}
      </ul>
    </section>)}
  </div>;
}

function ChatSwitcher({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const title = agent.conversation?.title || agent.conversations.find((item) => item.id === agent.selectedId)?.title || t("New chat");
  return <div className="agent-switcher" ref={ref}>
    <button type="button" className="agent-switcher-btn" aria-haspopup="true" aria-expanded={open} title={t("Chats")} onClick={() => setOpen((value) => !value)}>
      <span className="agent-switcher-title">{title}</span><Glyph name="chevronDown" className="sm" />
    </button>
    {open && <div className="popover agent-pop agent-switcher-pop">
      <ChatList agent={agent} onPicked={() => setOpen(false)} />
    </div>}
  </div>;
}

function AgentChat({ agent, compact, cloudMode, canTopUp, onAddFunds, onUseCloud }: {
  agent: Agent;
  compact: boolean;
  cloudMode: boolean;
  canTopUp: boolean;
  onAddFunds: () => void;
  onUseCloud: () => void;
}) {
  const { t, language } = useTranslation();
  const [modelOpen, setModelOpen] = useState(false);
  const [away, setAway] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const { settings, conversation, usage, busy, running } = agent;

  const toBottom = (smooth = false) => {
    const box = scrollRef.current;
    if (!box) return;
    const motion = smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollTo({ top: box.scrollHeight, behavior: motion ? "smooth" : "auto" });
  };
  const onScroll = () => {
    const box = scrollRef.current;
    if (!box) return;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 96;
    stick.current = near;
    setAway(!near);
  };
  // Follow new content only while the reader is at the bottom; a new chat always starts there.
  useLayoutEffect(() => { stick.current = true; setAway(false); toBottom(); }, [agent.selectedId]);
  const messageCount = conversation?.messages.length ?? 0;
  useLayoutEffect(() => { if (stick.current) toBottom(); }, [messageCount, conversation?.status, conversation?.id]);

  // Grow the composer with its text, from one line up to eight.
  useLayoutEffect(() => {
    const box = composerRef.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 200)}px`;
  }, [agent.composer]);
  useEffect(() => {
    const box = composerRef.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [agent.focusKey]);

  const send = () => { stick.current = true; agent.send(); };
  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
  };

  const ownModel = settings?.source === "own";
  const needsCloud = !!settings && !ownModel && !cloudMode;
  const empty = !conversation && !agent.selectedId;
  const turns = agentTurns(conversation?.messages ?? []);
  if (running && turns.at(-1)?.role !== "agent") turns.push({ role: "agent", steps: [], texts: [] });

  const model = <ModelMenu settings={settings} open={modelOpen} up={compact} onToggle={setModelOpen}
    onSaved={(next) => { agent.setSettings(next); void agent.loadUsage(); }} />;
  const fundsLink = canTopUp && <button type="button" className="agent-link" onClick={onAddFunds}>{t("Add funds")}</button>;
  const credits = !ownModel && usage && <>
    <span>{t("Free this month: {left} of {total} left", { left: formatMicroUsd(usage.freeLeftMicro, language), total: formatMicroUsd(usage.freeAllowanceMicro, language) })}</span>
    <span>{t("Balance {amount}", { amount: formatUsd(Math.max(0, usage.balanceCents - Math.ceil(usage.pendingMicro / 10_000)), language) })}</span>
    {fundsLink}
  </>;
  const cost = !!conversation?.billedMicro && <span className="agent-cost">{t("This chat: {amount}", { amount: formatMicroUsd(conversation.billedMicro, language) })}</span>;
  const cloudCard = needsCloud && <div className="agent-notice">
    <span className="agent-notice-icon"><Glyph name="sparkle" /></span>
    <div className="agent-notice-body">
      <strong>{t("Get free AI credits every month")}</strong>
      <p>{t("Sign in to AliasMode Cloud to get free monthly AI credits for the agent, or use your own model.")}</p>
      <div className="agent-notice-actions">
        <button type="button" className="btn primary sm" onClick={onUseCloud}>{t("Sign in to AliasMode Cloud")}</button>
        <button type="button" className="btn sm" onClick={() => setModelOpen(true)}>{t("Use my own model")}</button>
      </div>
    </div>
  </div>;

  return <div className={`agent-chat${compact ? " compact" : ""}`}>
    {!compact && <header className="agent-bar">{model}<span className="spacer" />{cost}</header>}

    <div className="agent-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className={`agent-column${empty ? " empty" : ""}`}>
        {empty ? <div className="agent-empty">
          <span className="agent-empty-mark"><Glyph name="sparkle" /></span>
          <h2>{t("What should the agent do?")}</h2>
          <p>{t("The agent opens your profiles, browses like you and reports back. It keeps working in the background while you use AliasMode.")}</p>
          <div className="agent-suggestions">
            {SUGGESTIONS.map((item) => <button type="button" key={item.title} onClick={() => { agent.setComposer(t(item.text)); agent.focus(); }}>
              <span className="agent-suggestion-icon"><Glyph name={item.icon} /></span>
              <span className="agent-suggestion-text"><strong>{t(item.title)}</strong><span>{t(item.text)}</span></span>
            </button>)}
          </div>
          {cloudCard}
        </div> : <>
          {cloudCard}
          {turns.map((turn, index) => turn.role === "user"
            ? <div key={index} className="agent-turn user"><div className="agent-bubble">{turn.text}</div></div>
            : <AgentReply key={index} turn={turn} live={running && index === turns.length - 1} />)}
          {conversation?.status === "error" && <div className="agent-notice danger" role="alert">
            <span className="agent-notice-icon"><Glyph name="alert" /></span>
            <div className="agent-notice-body">
              <strong>{t("The agent stopped with an error.")}</strong>
              {conversation.error && <p>{conversation.error}</p>}
              <div className="agent-notice-actions"><button type="button" className="btn sm" disabled={busy} onClick={agent.resume}>{t("Try again")}</button></div>
            </div>
          </div>}
          {conversation?.status === "paused" && conversation.pauseReason === "credits" && <div className="agent-notice warn">
            <span className="agent-notice-icon"><Glyph name="wallet" /></span>
            <div className="agent-notice-body">
              <strong>{usage && usage.freeLeftMicro <= 0 ? t("Your free AI credits for this month are used up") : t("Not enough credits")}</strong>
              <p>{canTopUp ? t("Add funds to your workspace balance, then continue where the agent stopped.") : t("The agent continues where it stopped once the workspace has funds.")}</p>
              <div className="agent-notice-actions">
                {canTopUp
                  ? <button type="button" className="btn primary sm" onClick={onAddFunds}>{t("Add funds")}</button>
                  : <span className="agent-muted">{t("Ask the workspace owner to add funds.")}</span>}
                <button type="button" className="btn sm" disabled={busy} onClick={agent.resume}>{t("Continue")}</button>
              </div>
            </div>
          </div>}
        </>}
      </div>
    </div>

    <div className="agent-dock">
      {away && !empty && <button type="button" className="agent-jump" aria-label={t("Jump to latest")} title={t("Jump to latest")}
        onClick={() => { stick.current = true; toBottom(true); }}><Glyph name="arrowDown" /></button>}
      {agent.error && <div className="agent-error" role="alert"><Glyph name="alert" className="sm" />{agent.error}</div>}
      <form className="agent-composer" onSubmit={(event) => { event.preventDefault(); send(); }}
        onMouseDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); composerRef.current?.focus(); } }}>
        <textarea ref={composerRef} rows={1} value={agent.composer} aria-label={t("Message to the agent")} placeholder={t("Message the agent…")}
          onChange={(event) => agent.setComposer(event.target.value)} onKeyDown={onComposerKey} />
        {running
          ? <button type="button" className="agent-send stop" title={t("Stop")} aria-label={t("Stop")} disabled={busy} onClick={agent.stop}><Glyph name="stop" /></button>
          : <button type="submit" className="agent-send" title={t("Send")} aria-label={t("Send")} disabled={!agent.composer.trim() || busy}><Glyph name="arrowUp" /></button>}
      </form>
      {compact ? <div className="agent-footnote">
        <div className="agent-footnote-row">{model}<span className="spacer" />{cost}</div>
        {credits && <div className="agent-footnote-row">{credits}</div>}
      </div> : credits && <div className="agent-footnote"><div className="agent-footnote-row">{credits}</div></div>}
    </div>
  </div>;
}

function AgentReply({ turn, live }: { turn: Extract<AgentTurn, { role: "agent" }>; live: boolean }) {
  const { t } = useTranslation();
  const current = live ? turn.steps.at(-1) : undefined;
  return <div className="agent-turn agent">
    <span className={`agent-avatar${live ? " live" : ""}`} aria-hidden="true"><Glyph name="sparkle" /></span>
    <div className="agent-turn-body">
      {turn.steps.length > 0 && <ToolSteps steps={turn.steps} live={live} />}
      {turn.texts.map((text, index) => <Markdown key={index} text={text} />)}
      {live && <div className="agent-working" role="status">
        <span className="agent-shimmer">{t("Working…")}</span>
        {current && current.result === undefined && <span className="agent-working-step">{describeStep(current, t).label}</span>}
      </div>}
    </div>
  </div>;
}

function ToolSteps({ steps, live }: { steps: AgentStep[]; live: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const described = steps.map((step) => describeStep(step, t));
  const labels = [...new Set(described.map((step) => step.label))];
  const icons = [...new Set(described.map((step) => step.icon))].slice(0, 3);
  return <div className={`agent-tools${open ? " open" : ""}`}>
    <button type="button" className="agent-tools-sum" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className="agent-tools-icons" aria-hidden="true">{icons.map((icon) => <span key={icon}><Glyph name={icon} /></span>)}</span>
      <span className="agent-tools-count">{steps.length === 1 ? t("Used 1 tool") : t("Used {count} tools", { count: steps.length })}</span>
      <span className="agent-tools-names">{labels.slice(0, 3).join(", ")}{labels.length > 3 ? "…" : ""}</span>
      <Glyph name="chevronRight" className="sm agent-chev" />
    </button>
    {open && <ol className="agent-timeline">
      {steps.map((step, index) => <ToolStep key={step.id} step={step} label={described[index]!.label} icon={described[index]!.icon}
        pending={live && step.result === undefined} />)}
    </ol>}
  </div>;
}

function ToolStep({ step, label, icon, pending }: { step: AgentStep; label: string; icon: GlyphName; pending: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <li className={open ? "open" : undefined}>
    <span className="agent-step-icon" aria-hidden="true">{pending ? <span className="agent-spinner" /> : <Glyph name={icon} />}</span>
    <div className="agent-step-body">
      <button type="button" className="agent-step-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span>{label}</span><Glyph name="chevronRight" className="sm agent-chev" />
      </button>
      {open && <div className="agent-step-detail">
        <span className="agent-step-label">{t("Input")}</span>
        <pre>{clip(prettyArgs(step.args))}</pre>
        {step.result !== undefined && <>
          <span className="agent-step-label">{t("Result")}</span>
          <pre>{clip(step.result)}</pre>
        </>}
      </div>}
    </div>
  </li>;
}

function ModelMenu({ settings, open, up, onToggle, onSaved }: {
  settings: AgentSettingsView | null;
  open: boolean;
  /** Opens upward from the composer footer in the side panel. */
  up: boolean;
  onToggle: (open: boolean) => void;
  onSaved: (settings: AgentSettingsView) => void;
}) {
  const { t } = useTranslation();
  const ref = useDismiss<HTMLDivElement>(open, () => onToggle(false));
  const label = settings?.source === "own" ? settings.model || t("Your own model") : "AliasMode AI";
  return <div className="agent-model" ref={ref}>
    <button type="button" className="agent-model-chip" aria-haspopup="dialog" aria-expanded={open} title={t("Model")} disabled={!settings}
      onClick={() => onToggle(!open)}>
      <Glyph name="sparkle" className="sm" /><span>{label}</span><Glyph name="chevronDown" className="sm" />
    </button>
    {open && settings && <div className={`popover agent-pop agent-model-pop${up ? " up" : ""}`} role="dialog" aria-label={t("Model")}>
      <AgentSettingsPanel settings={settings} onSaved={(next) => { onSaved(next); onToggle(false); }} onClose={() => onToggle(false)} />
    </div>}
  </div>;
}

function AgentSettingsPanel({ settings, onSaved, onClose }: {
  settings: AgentSettingsView;
  onSaved: (settings: AgentSettingsView) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState(settings.source);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (key: string | undefined) => {
    setBusy(true); setError(null);
    try {
      onSaved(await saveAgentSettings(source === "own" ? { source, baseUrl: baseUrl.trim(), model: model.trim(), apiKey: key } : { source }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setBusy(false); }
  };
  const option = (value: "aliasmode" | "own", title: string, hint: string) =>
    <label className={`agent-source${source === value ? " on" : ""}`}>
      <input type="radio" name="agent-source" checked={source === value} onChange={() => setSource(value)} />
      <span><strong>{title}</strong><small>{hint}</small></span>
      <Glyph name="check" className="sm agent-source-check" />
    </label>;
  return <form className="agent-settings" onSubmit={(event) => { event.preventDefault(); void save(apiKey || undefined); }}>
    <div role="radiogroup" aria-label={t("Model")} className="agent-sources">
      {option("aliasmode", t("AliasMode AI (recommended)"), t("Uses your free monthly credits, then your workspace balance."))}
      {option("own", t("Your own model (advanced)"), t("Any OpenAI-compatible server such as Ollama, LM Studio or OpenRouter."))}
    </div>
    {source === "own" && <div className="agent-own">
      <label className="fld"><span>{t("Server URL")}</span><input className="input" value={baseUrl} placeholder="http://localhost:11434/v1" onChange={(event) => setBaseUrl(event.target.value)} /></label>
      <label className="fld"><span>{t("Model")}</span><input className="input" value={model} placeholder="llama3.1" onChange={(event) => setModel(event.target.value)} /></label>
      <label className="fld"><span>{t("API key")}</span><input className="input" type="password" autoComplete="off" value={apiKey} placeholder={settings.hasKey ? t("Saved. Leave blank to keep it.") : t("Optional")} onChange={(event) => setApiKey(event.target.value)} /></label>
      {settings.hasKey && <button type="button" className="agent-link agent-remove-key" disabled={busy} onClick={() => void save("")}>{t("Remove saved key")}</button>}
    </div>}
    <p className="agent-settings-hint">{t("Page content the agent reads is sent to the model you choose.")}</p>
    {error && <div className="agent-error" role="alert">{error}</div>}
    <div className="agent-settings-actions">
      <button type="button" className="btn ghost sm" onClick={onClose}>{t("Cancel")}</button>
      <button type="submit" className="btn primary sm" disabled={busy || (source === "own" && (!baseUrl.trim() || !model.trim()))}>{busy ? t("Saving…") : t("Save")}</button>
    </div>
  </form>;
}
