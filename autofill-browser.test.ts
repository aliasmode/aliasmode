import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { ProfileStore } from "./store.ts";
import { generateTotp } from "./totp.ts";
import type { Profile } from "./types.ts";

// Opt-in like proxy-live.test.ts. Uses only synthetic accounts and intercepted pages.
const browserPath = process.env.ALIASMODE_AUTOFILL_BROWSER;
const browserTest = browserPath ? test : test.skip;

async function clickAutofill(page: Page, field: string, trusted = true) {
  await page.locator("aliasmode-autofill").waitFor();
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const find = (node: any): any => {
      const attrs: string[] = node.attributes ?? [];
      if (node.nodeName === "BUTTON" && attrs.some((key, index) => key === "data-field" && attrs[index + 1] === field)) return node;
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        const result = find(child);
        if (result) return result;
      }
    };
    const button = find(root);
    expect(!!button).toBe(true);
    if (trusted) {
      const { model } = await cdp.send("DOM.getBoxModel", { nodeId: button.nodeId });
      await page.mouse.click((model.content[0]! + model.content[4]!) / 2, (model.content[1]! + model.content[5]!) / 2);
    } else {
      const { object } = await cdp.send("DOM.resolveNode", { nodeId: button.nodeId });
      await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function() { this.click(); }" });
    }
  } finally { await cdp.detach(); }
}

browserTest("profile extension fills multi-step React forms, new tabs and surviving browsers", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-autofill-browser-"));
  const db = join(root, "profiles.sqlite");
  writeFileSync(join(root, "config.json"), JSON.stringify({ version: 1, mode: "local", localAnalytics: false }));
  const store = new ProfileStore(db);
  const profile: Profile = {
    id: "autofill-one", accId: "1", name: "Autofill test", group: "", platform: "x.com",
    username: "test-one", password: "synthetic-password", email: "test@example.com", twofa: "JBSWY3DPEHPK3PXP",
    proxy: null, ua: "", timezone: "UTC", screenWidth: 1280, screenHeight: 900, fingerprintSeed: 1, cookies: [], seeded: false,
  };
  store.upsertProfile(profile);
  store.upsertProfile({ ...profile, id: "autofill-two", username: "test-two", fingerprintSeed: 2 });
  store.close();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const browsers: Browser[] = [];
  let base = "";
  const startApp = async () => {
    const app = Bun.spawn([
      process.execPath, "cli.ts", "serve", "--state-root", root, "--db", db,
      "--data-root", join(root, "profiles"), "--port", "0", "--no-sandbox", "--unsafe-disable-identity-gates",
    ], {
      cwd: import.meta.dir,
      env: { ...process.env, CLOAKBROWSER_BINARY_PATH: browserPath!, ALIASMODE_PLAYWRIGHT_RUNTIME: "" },
      stdout: "pipe", stderr: "pipe",
    });
    child = app;
    let resolveReady!: (url: string) => void;
    const ready = new Promise<string>((resolve) => { resolveReady = resolve; });
    const drain = (async () => {
      let text = "";
      const reader = app.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          const match = text.match(/dashboard \+ API on (http:\/\/127\.0\.0\.1:\d+)/);
          if (match) resolveReady(match[1]!);
        }
      } finally { reader.releaseLock(); }
    })();
    // Drain stderr without putting browser or app environment in assertion output.
    void new Response(app.stderr).text();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      base = await Promise.race([
        ready,
        app.exited.then(() => { throw new Error("autofill test app exited before ready"); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("autofill test app did not start")), 30_000); }),
      ]);
    } finally { clearTimeout(timer); }
    void drain;
  };
  const api = async (path: string, init?: RequestInit) => {
    const response = await fetch(base + path, init);
    expect(response.ok).toBe(true);
    return await response.json();
  };
  try {
    const fixture = join(root, "fixture.jsx");
    writeFileSync(fixture, `
          import React, { useState } from ${JSON.stringify(require.resolve("react"))};
          import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
          function App() {
            const [step, setStep] = useState(0), [value, setValue] = useState(''), [submits, setSubmits] = useState(0);
            const fields = [
              { name: 'text', type: 'text', auto: 'username', label: 'Username' },
              { name: 'text', type: 'text', auto: 'email', label: 'Confirm email' },
              { name: 'password', type: 'password', auto: 'current-password', label: 'Password' },
              { name: 'challenge_response', type: 'text', auto: 'one-time-code', label: 'Authentication code' }
            ];
            const field = fields[step];
            return <main style={{ margin: '100px auto', maxWidth: 420, fontFamily: 'system-ui' }}>
              <h1>Sign in</h1><p>AliasMode autofill test · synthetic account</p>
              <form onSubmit={e => { e.preventDefault(); setSubmits(submits + 1); }}>
                <label htmlFor="credential">{field.label}</label><br/>
                <input key={step} id="credential" name={field.name} type={field.type} autoComplete={field.auto}
                  aria-label={field.label} value={value} onChange={e => setValue(e.target.value)}
                  style={{ width: '100%', padding: 12, margin: '8px 0 16px' }}/>
                <button id="next" type="button" onClick={() => { setStep((step + 1) % fields.length); setValue(''); }}>Next</button>
                <output id="value">{value}</output><output id="submits">{submits}</output>
              </form></main>;
          }
          createRoot(document.getElementById('app')).render(<App/>);
    `);
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { jsx: "react" } }));
    const built = await Bun.build({ entrypoints: [fixture], target: "browser" });
    expect(built.success).toBe(true);
    const script = await built.outputs[0]!.text();
    const html = '<!doctype html><meta charset="utf-8"><title>Autofill test</title><div id="app"></div><script src="/fixture.js"></script>';
    await startApp();
    const open = async (id: string) => {
      const query = new URLSearchParams({ user_id: id, launch_args: JSON.stringify([base + "/api/v1/status"]) });
      const result = await api("/api/v1/browser/start?" + query);
      expect(result.code).toBe(0);
      const browser = await chromium.connectOverCDP(result.data.ws.puppeteer);
      browsers.push(browser);
      const context = browser.contexts()[0]!;
      await context.route("https://**/*", (route) => route.fulfill({
        contentType: new URL(route.request().url()).pathname === "/fixture.js" ? "text/javascript" : "text/html",
        body: new URL(route.request().url()).pathname === "/fixture.js" ? script : html,
      }));
      const page = await context.newPage();
      await page.goto("https://x.com/i/flow/login");
      return page;
    };
    const page = await open(profile.id);
    const input = page.locator("#credential");
    await input.click();
    await page.locator("aliasmode-autofill").waitFor();
    expect(await input.inputValue()).toBe("");
    const fieldBox = (await input.boundingBox())!;
    const menuBox = (await page.locator("aliasmode-autofill").boundingBox())!;
    expect(Math.abs(menuBox.x - fieldBox.x)).toBeLessThan(2);
    expect(menuBox.y).toBeGreaterThan(fieldBox.y + fieldBox.height);
    expect(menuBox.y).toBeLessThan(fieldBox.y + fieldBox.height + 8);
    if (process.env.ALIASMODE_AUTOFILL_SCREENSHOT) await page.screenshot({ path: process.env.ALIASMODE_AUTOFILL_SCREENSHOT });
    await page.keyboard.press("Escape");
    expect(await page.locator("aliasmode-autofill").count()).toBe(0);
    await input.click();
    await clickAutofill(page, "username", false);
    expect(await input.inputValue()).toBe("");
    await clickAutofill(page, "username");
    await page.waitForFunction(() => document.querySelector("#value")?.textContent === "test-one");
    expect(await input.inputValue()).toBe(profile.username);
    expect(await page.locator("#submits").textContent()).toBe("0");
    await page.locator("#next").click();
    await input.click();
    await clickAutofill(page, "email");
    await page.waitForFunction(() => document.querySelector("#value")?.textContent === "test@example.com");
    await page.locator("#next").click();
    await input.click();
    await clickAutofill(page, "password");
    await page.waitForFunction(() => document.querySelector("#value")?.textContent === "synthetic-password");
    await page.locator("#next").click();
    await input.click();
    const beforeCode = generateTotp(profile.twofa)!.code;
    await clickAutofill(page, "totp");
    await page.waitForFunction(() => !!document.querySelector("#value")?.textContent);
    expect([beforeCode, generateTotp(profile.twofa)!.code]).toContain(await input.inputValue());
    expect(await page.locator("#submits").textContent()).toBe("0");

    const second = await open("autofill-two");
    await second.locator("#credential").click();
    await clickAutofill(second, "username");
    await second.waitForFunction(() => document.querySelector("#value")?.textContent === "test-two");
    const tab = await page.context().newPage();
    await tab.goto("https://twitter.com/login");
    await tab.locator("#credential").click();
    await clickAutofill(tab, "username");
    await tab.waitForFunction(() => document.querySelector("#value")?.textContent === "test-one");
    const edited = await api(`/ui/api/profiles/${profile.id}/update`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: { username: "updated-user" } }),
    });
    expect(edited.ok).toBe(true);
    await tab.locator("#credential").click();
    await clickAutofill(tab, "username");
    await tab.waitForFunction(() => document.querySelector("#value")?.textContent === "updated-user");

    await tab.locator("#credential").fill("");
    child!.kill("SIGKILL");
    await child!.exited;
    await startApp();
    await tab.locator("#credential").click();
    await clickAutofill(tab, "username");
    await tab.waitForFunction(() => document.querySelector("#value")?.textContent === "updated-user");
    expect(await tab.locator("#credential").inputValue()).toBe("updated-user");
    await tab.bringToFront();
    await tab.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "login-frame";
      frame.src = "https://unrelated.test/login";
      frame.width = "700";
      frame.height = "500";
      document.body.append(frame);
    });
    const frame = tab.frameLocator("#login-frame");
    await frame.locator("#credential").focus();
    expect(await frame.locator("#credential").evaluate((element) => document.activeElement === element)).toBe(true);
    await Bun.sleep(300);
    expect(await frame.locator("aliasmode-autofill").count()).toBe(0);
    expect(await frame.locator("#credential").inputValue()).toBe("");
    const frameNavigation = tab.waitForEvent("framenavigated", { predicate: (value) => value.url() === "https://x.com/login" });
    await tab.locator("#login-frame").evaluate((element) => { (element as HTMLIFrameElement).src = "https://x.com/login"; });
    const matchingFrame = await frameNavigation;
    await matchingFrame.waitForLoadState("load");
    await frame.locator("#credential").focus();
    expect(await frame.locator("#credential").evaluate((element) => document.activeElement === element)).toBe(true);
    await frame.locator("aliasmode-autofill").waitFor({ timeout: 5_000 }).catch(async (error) => {
      console.info("Autofill frame state", await frame.locator("#credential").evaluate((element) => ({
        url: location.href, focused: document.activeElement === element, hasFocus: document.hasFocus(),
        panels: document.querySelectorAll("aliasmode-autofill").length, ready: document.readyState,
      })));
      throw error;
    });
    expect(await frame.locator("#credential").inputValue()).toBe("");
    await tab.goto("https://x.com.evil.test/login");
    await tab.locator("#credential").click();
    await Bun.sleep(300);
    expect(await tab.locator("aliasmode-autofill").count()).toBe(0);
    expect(await tab.locator("#credential").inputValue()).toBe("");
  } finally {
    for (const browser of browsers) {
      try { await (await browser.newBrowserCDPSession()).send("Browser.close"); } catch {}
      await browser.close().catch(() => {});
    }
    if (child && child.exitCode === null) {
      for (const id of [profile.id, "autofill-two"]) {
        await fetch(base + "/api/v1/browser/stop?user_id=" + id, { signal: AbortSignal.timeout(15_000) }).catch(() => {});
      }
    }
    if (child) { child.kill(); await child.exited; }
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
