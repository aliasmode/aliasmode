import { join } from "node:path";

export const AUTOFILL_EXTENSION_REVISION = 1;
export const autofillExtensionDir = (userDataDir: string) => join(userDataDir, "aliasmode-autofill");

export const AUTOFILL_MANIFEST = {
  manifest_version: 3,
  name: "AliasMode Autofill",
  version: "1.0.0",
  description: "Fill saved credentials from this AliasMode profile.",
  host_permissions: ["http://127.0.0.1/*"],
  background: { service_worker: "background.js" },
  content_scripts: [{
    matches: ["http://*/*", "https://*/*"],
    js: ["content.js"],
    all_frames: true,
    run_at: "document_idle",
  }],
};

// Embedded source also ships inside the compiled desktop sidecar.
export const AUTOFILL_BACKGROUND = String.raw`
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.tab || !sender.url) return;
  if (message?.operation !== "fields" && message?.operation !== "fill") return;
  (async () => {
    const binding = await (await fetch(chrome.runtime.getURL("bind.json"), { cache: "no-store" })).json();
    const response = await fetch("http://127.0.0.1:" + binding.port + "/v1/" + message.operation, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + binding.token },
      body: JSON.stringify({ url: sender.url, field: message.field }),
      cache: "no-store",
    });
    return await response.json();
  })().then(reply, () => reply({ ok: false, error: "Open AliasMode to use autofill." }));
  return true;
});
`;

export const AUTOFILL_CONTENT = String.raw`
(() => {
  const labels = { username: "Username", email: "Email", password: "Password", totp: "2FA code" };
  let panel = null;
  let active = null;
  let revision = 0;

  function eligible(input) {
    return input instanceof HTMLInputElement && !input.disabled && !input.readOnly &&
      ["text", "email", "tel", "password", "number", "search", "url"].includes(input.type);
  }

  function preferred(input) {
    if (input.type === "password") return "password";
    const hints = [input.autocomplete, input.name, input.id, input.placeholder, input.getAttribute("aria-label")].join(" ").toLowerCase();
    if (/one-time-code|otp|verification|authentication|2fa|totp|challenge_response/.test(hints)) return "totp";
    if (input.type === "email" || /email/.test(hints)) return "email";
    return "username";
  }

  function hide() {
    revision++;
    if (panel) panel.remove();
    panel = null;
    active = null;
  }

  function send(operation, field) {
    return chrome.runtime.sendMessage({ operation, field });
  }

  async function show(input) {
    hide();
    if (!eligible(input)) return;
    active = input;
    const current = revision;
    let data;
    try { data = await send("fields"); } catch { return; }
    if (current !== revision || !input.isConnected || !input.matches(":focus") || !data?.ok || !data.fields.length) return;
    const host = document.createElement("aliasmode-autofill");
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = ":host{all:initial;position:fixed!important;left:0;top:0;z-index:2147483647!important;display:block!important}" +
      "*{box-sizing:border-box}section{width:240px;background:#fff;color:#172033;border:1px solid #dce1e8;border-radius:10px;box-shadow:0 6px 24px #0003;padding:6px;font:13px/1.4 system-ui,sans-serif}" +
      "header{padding:6px 8px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#5d6470;font-size:12px}" +
      "button{display:block;width:100%;border:0;border-radius:6px;background:transparent;color:inherit;text-align:left;font:inherit;padding:8px;cursor:pointer}" +
      "button:hover,button:focus-visible{background:#edf2ff;outline:2px solid #b8caff}" +
      "p{margin:6px 8px;color:#a02a2a;font-size:12px}";
    const section = document.createElement("section");
    section.setAttribute("aria-label", "AliasMode autofill");
    const header = document.createElement("header");
    header.textContent = "AliasMode · " + data.name;
    section.append(header);
    const first = preferred(input);
    const fields = data.fields.filter((field) => labels[field]);
    fields.sort((a, b) => (a === first ? -1 : b === first ? 1 : 0));
    let filling = false;
    for (const field of fields) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.field = field;
      button.textContent = "Fill " + labels[field];
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", async (event) => {
        if (!event.isTrusted || filling || current !== revision || !eligible(input)) return;
        const url = location.href;
        filling = true;
        let result;
        try { result = await send("fill", field); } catch { result = { ok: false }; }
        if (current !== revision || !input.isConnected || location.href !== url || !eligible(input)) return;
        if (!result?.ok) {
          section.querySelector("p")?.remove();
          const error = document.createElement("p");
          error.setAttribute("role", "status");
          error.textContent = result?.error || "Autofill is unavailable. Check AliasMode.";
          section.append(error);
          filling = false;
          return;
        }
        // Native setter bypasses React's own value tracker. Events update the app's state.
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, result.value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        hide();
        input.focus();
      });
      section.append(button);
    }
    root.append(style, section);
    panel = host;
    document.documentElement.append(host);
    const rect = input.getBoundingClientRect();
    const box = host.getBoundingClientRect();
    host.style.setProperty("left", Math.max(0, Math.min(rect.left, innerWidth - box.width)) + "px", "important");
    const top = rect.bottom + box.height <= innerHeight ? rect.bottom + 4 : rect.top - box.height - 4;
    host.style.setProperty("top", Math.max(0, top) + "px", "important");
  }

  document.addEventListener("focusin", (event) => {
    if (panel && event.composedPath().includes(panel)) return;
    const input = event.composedPath()[0];
    if (eligible(input)) void show(input);
    else hide();
  }, true);
  document.addEventListener("pointerdown", (event) => {
    if (panel && event.composedPath().includes(panel)) return;
    const input = event.composedPath()[0];
    if (input === active && panel) return;
    hide();
    if (eligible(input) && input.matches(":focus")) void show(input);
  }, true);
  document.addEventListener("focusout", () => queueMicrotask(() => {
    if (active && !active.matches(":focus") && document.activeElement !== panel) hide();
  }), true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hide(); }, true);
  document.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
  window.addEventListener("pagehide", hide);
  if (eligible(document.activeElement)) void show(document.activeElement);
})();
`;
