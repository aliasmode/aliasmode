import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "./i18n.tsx";
import { WalletPanel, formatUsd } from "./store.tsx";
import {
  deleteAgentConversation,
  fetchAgent,
  fetchAgentConversation,
  fetchAgentUsage,
  resumeAgentConversation,
  saveAgentSettings,
  scriptsDesktopAvailable,
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

const EXAMPLES = [
  "Create 5 profiles that reuse the proxies of profiles A and B, open example.com in each and tell me what you see",
  "Open my X profile, find what is trending in my niche today and draft 3 posts",
  "Follow this SOP in profile A step by step:",
  "Check which of my profiles have a failing proxy",
  "Open profile A, go to the Gmail inbox and summarize the unread emails",
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

export function AgentPage({ active, cloudMode, owner, wallet, draft, onReloadWallet, onUseCloud }: {
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
}) {
  const { t, language } = useTranslation();
  const desktop = scriptsDesktopAvailable();
  const [settings, setSettings] = useState<AgentSettingsView | null>(null);
  const [conversations, setConversations] = useState<AgentConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<AgentConversation | null>(null);
  const [usage, setUsage] = useState<AiUsageResponse | null>(null);
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const selectedRef = useRef<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  selectedRef.current = selectedId;

  const loadUsage = useCallback(() => fetchAgentUsage().then(setUsage, () => setUsage(null)), []);
  const loadList = useCallback(() => fetchAgent().then((result) => {
    setSettings(result.settings);
    setConversations(result.conversations);
  }), []);
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
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!active || !desktop) return;
    void loadList().catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)));
    void loadUsage();
  }, [active, desktop, loadList, loadUsage]);

  useEffect(() => {
    if (!draft.key) return;
    selectedRef.current = null;
    setSelectedId(null); setConversation(null); setError(null);
    setComposer(draft.text);
    requestAnimationFrame(() => {
      const box = composerRef.current;
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    });
  }, [draft.key]);

  // Runs continue in the background; poll while one is running and the page is open.
  const anyRunning = conversation?.status === "running" || conversations.some((item) => item.status === "running");
  useEffect(() => {
    if (!active || !desktop || !anyRunning) return;
    const timer = window.setInterval(() => {
      void loadList().catch(() => {});
      const id = selectedRef.current;
      if (id) void fetchAgentConversation(id).then((next) => { if (selectedRef.current === id) setConversation(next); }, () => {});
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, desktop, anyRunning, loadList]);

  // A finished run changed the balance and the free allowance.
  const lastStatus = useRef(conversation?.status);
  useEffect(() => {
    if (lastStatus.current === "running" && conversation?.status !== "running") void loadUsage();
    lastStatus.current = conversation?.status;
  }, [conversation?.status, loadUsage]);

  const messageCount = conversation?.messages.length ?? 0;
  useEffect(() => {
    const box = transcriptRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messageCount, conversation?.status, selectedId]);

  if (!desktop) {
    return <div className="workspace proxy-page agent-page" hidden={!active}>
      <div className="tools-empty agent-desktop-note"><h3>{t("The agent requires the desktop app.")}</h3><p>{t("Open AliasMode in the desktop app to use the agent.")}</p></div>
    </div>;
  }

  const open = (id: string) => {
    selectedRef.current = id;
    setSelectedId(id); setConversation(null); setError(null);
    void fetchAgentConversation(id).then((next) => { if (selectedRef.current === id) setConversation(next); },
      (failure) => setError(failure instanceof Error ? failure.message : String(failure)));
  };
  const newChat = () => {
    selectedRef.current = null;
    setSelectedId(null); setConversation(null); setError(null); setComposer("");
    composerRef.current?.focus();
  };
  const remove = (id: string) => {
    if (!confirm(t("Delete this chat?"))) return;
    void act(async () => {
      await deleteAgentConversation(id);
      setConversations((list) => list.filter((item) => item.id !== id));
      if (selectedRef.current === id) newChat();
    });
  };
  const running = conversation?.status === "running";
  const send = () => {
    const prompt = composer.trim();
    if (!prompt || busy || running) return;
    void act(async () => {
      show(conversation ? await sendAgentMessage(conversation.id, prompt) : await startAgentConversation(prompt));
      setComposer("");
    });
  };
  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
  };
  const resume = () => conversation && void act(async () => show(await resumeAgentConversation(conversation.id)));
  const stop = () => conversation && void act(async () => setConversation(await stopAgentConversation(conversation.id)));
  const openWallet = () => { setWalletOpen(true); void onReloadWallet(); };

  const ownModel = settings?.source === "own";
  const needsCloud = !!settings && !ownModel && !cloudMode;
  const turns = agentTurns(conversation?.messages ?? []);
  const canTopUp = owner && !!wallet;
  const fundsAction = canTopUp
    ? <button type="button" className="btn primary sm" onClick={openWallet}>{t("Add funds")}</button>
    : <span className="agent-muted">{t("Ask the workspace owner to add funds.")}</span>;

  return <div className="workspace proxy-page agent-page" hidden={!active}>
    <aside className="agent-list" aria-label={t("Chats")}>
      <button type="button" className="btn primary sm agent-new" onClick={newChat}>+ {t("New chat")}</button>
      <ul>
        {conversations.map((item) => <li key={item.id} className={item.id === selectedId ? "active" : ""}>
          <button type="button" className="agent-chat" onClick={() => open(item.id)} title={item.title}>
            <span className={`agent-dot ${item.status}`} aria-hidden="true" />
            <span className="agent-chat-title">{item.title || t("New chat")}</span>
          </button>
          <button type="button" className="agent-chat-del" aria-label={t("Delete chat {title}", { title: item.title })} onClick={() => remove(item.id)}>×</button>
        </li>)}
      </ul>
    </aside>

    <section className="agent-main">
      <header className="agent-head">
        {ownModel
          ? <span>{t("Your own model: {model}", { model: settings?.model || "—" })}</span>
          : usage && <>
            <span>{t("Free this month: {left} of {total} left", { left: formatMicroUsd(usage.freeLeftMicro, language), total: formatMicroUsd(usage.freeAllowanceMicro, language) })}</span>
            <span className="agent-sep">{t("Workspace balance: {amount}", { amount: formatUsd(usage.balanceCents, language) })}</span>
            {canTopUp && <button type="button" className="store-link" onClick={openWallet}>{t("Add funds")}</button>}
          </>}
        <span className="spacer" />
        {!!conversation?.billedMicro && <span className="agent-muted">{t("This chat: {amount}", { amount: formatMicroUsd(conversation.billedMicro, language) })}</span>}
        <button type="button" className="btn ghost sm" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((value) => !value)}>{t("Model")}</button>
      </header>

      {settingsOpen && settings && <AgentSettingsPanel settings={settings} onSaved={(next) => { setSettings(next); setSettingsOpen(false); void loadUsage(); }} onClose={() => setSettingsOpen(false)} />}
      {walletOpen && wallet && <div className="agent-wallet">
        <WalletPanel wallet={wallet} owner={owner} onClose={() => setWalletOpen(false)} onReload={async () => { await onReloadWallet(); await loadUsage(); }} />
      </div>}

      <div className="agent-transcript" ref={transcriptRef}>
        {needsCloud && <div className="tools-panel agent-card">
          <strong>{t("Get free AI credits every month")}</strong>
          <p>{t("Sign in to AliasMode Cloud to get free monthly AI credits for the agent, or use your own model.")}</p>
          <div className="agent-actions">
            <button type="button" className="btn primary sm" onClick={onUseCloud}>{t("Sign in to AliasMode Cloud")}</button>
            <button type="button" className="btn sm" onClick={() => setSettingsOpen(true)}>{t("Use my own model")}</button>
          </div>
        </div>}
        {!conversation && !selectedId && <div className="agent-empty">
          <h2>{t("Tell the agent what to do")}</h2>
          <p>{t("The agent opens your profiles, browses like you and reports back. It keeps working in the background while you use AliasMode.")}</p>
          <div className="agent-examples">
            {EXAMPLES.map((example) => <button type="button" key={example} onClick={() => { setComposer(t(example)); composerRef.current?.focus(); }}>{t(example)}</button>)}
          </div>
        </div>}
        {turns.map((turn, index) => turn.role === "user"
          ? <div key={index} className="agent-user">{turn.text}</div>
          : <div key={index} className="agent-reply">
            {turn.steps.length > 0 && <details className="agent-steps">
              <summary>{turn.steps.length === 1 ? t("1 step") : t("{count} steps", { count: turn.steps.length })}: {[...new Set(turn.steps.map((step) => toolLabel(step.name)))].join(", ")}</summary>
              {turn.steps.map((step) => <details key={step.id} className="agent-step">
                <summary>{toolLabel(step.name)}</summary>
                <pre>{clip(prettyArgs(step.args))}</pre>
                {step.result !== undefined && <pre className="agent-result">{clip(step.result)}</pre>}
              </details>)}
            </details>}
            {turn.texts.map((text, textIndex) => <div key={textIndex} className="agent-text">{text}</div>)}
          </div>)}
        {running && <div className="agent-working" role="status">
          <span className="agent-dot running" aria-hidden="true" />{t("Working…")}
          <button type="button" className="btn sm" disabled={busy} onClick={stop}>{t("Stop")}</button>
        </div>}
        {conversation?.status === "error" && <div className="tools-alert agent-card" role="alert">
          <span>{conversation.error || t("The agent stopped with an error.")}</span>
          <div className="agent-actions"><button type="button" className="btn sm" disabled={busy} onClick={resume}>{t("Try again")}</button></div>
        </div>}
        {conversation?.status === "paused" && conversation.pauseReason === "credits" && <div className="tools-panel agent-card agent-credits">
          <strong>{usage && usage.freeLeftMicro <= 0 ? t("Your free AI credits for this month are used up") : t("Not enough credits")}</strong>
          <p>{canTopUp ? t("Add funds to your workspace balance, then continue where the agent stopped.") : t("The agent continues where it stopped once the workspace has funds.")}</p>
          <div className="agent-actions">
            {fundsAction}
            <button type="button" className="btn sm" disabled={busy} onClick={resume}>{t("Continue")}</button>
          </div>
        </div>}
      </div>

      {error && <div className="tools-alert agent-error" role="alert">{error}</div>}
      <form className="agent-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
        <textarea ref={composerRef} rows={3} value={composer} aria-label={t("Message to the agent")} placeholder={t("Tell the agent what to do…")}
          onChange={(event) => setComposer(event.target.value)} onKeyDown={onComposerKey} />
        <button type="submit" className="btn primary" disabled={!composer.trim() || busy || running}>{t("Send")}</button>
      </form>
    </section>
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
  return <form className="tools-panel agent-settings" onSubmit={(event) => { event.preventDefault(); void save(apiKey || undefined); }}>
    <div role="radiogroup" aria-label={t("Model")} className="agent-sources">
      <label><input type="radio" name="agent-source" checked={source === "aliasmode"} onChange={() => setSource("aliasmode")} />
        <span><strong>{t("AliasMode AI (recommended)")}</strong><small>{t("Uses your free monthly credits, then your workspace balance.")}</small></span></label>
      <label><input type="radio" name="agent-source" checked={source === "own"} onChange={() => setSource("own")} />
        <span><strong>{t("Your own model (advanced)")}</strong><small>{t("Any OpenAI-compatible server such as Ollama, LM Studio or OpenRouter.")}</small></span></label>
    </div>
    {source === "own" && <div className="agent-own">
      <label className="fld"><span>{t("Server URL")}</span><input value={baseUrl} placeholder="http://localhost:11434/v1" onChange={(event) => setBaseUrl(event.target.value)} /></label>
      <label className="fld"><span>{t("Model")}</span><input value={model} placeholder="llama3.1" onChange={(event) => setModel(event.target.value)} /></label>
      <label className="fld"><span>{t("API key")}</span><input type="password" autoComplete="off" value={apiKey} placeholder={settings.hasKey ? t("Saved. Leave blank to keep it.") : t("Optional")} onChange={(event) => setApiKey(event.target.value)} /></label>
      {settings.hasKey && <button type="button" className="store-link agent-remove-key" disabled={busy} onClick={() => void save("")}>{t("Remove saved key")}</button>}
    </div>}
    <p className="tools-hint">{t("Page content the agent reads is sent to the model you choose.")}</p>
    {error && <div className="tools-alert" role="alert">{error}</div>}
    <div className="agent-actions">
      <button type="submit" className="btn primary sm" disabled={busy || (source === "own" && (!baseUrl.trim() || !model.trim()))}>{busy ? t("Saving…") : t("Save")}</button>
      <button type="button" className="btn ghost sm" onClick={onClose}>{t("Cancel")}</button>
    </div>
  </form>;
}
