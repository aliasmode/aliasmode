import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const transportStatsKey = Symbol.for("aliasmode.playwrightTransportStats");
const require = createRequire(import.meta.url);
const transportPath = fileURLToPath(
  new URL("./node_modules/playwright-core/lib/server/transport.js", import.meta.url),
);
const browserContextPath = fileURLToPath(
  new URL("./node_modules/playwright-core/lib/server/browserContext.js", import.meta.url),
);

function transportStats() {
  return (globalThis as any)[transportStatsKey] as {
    opened: number;
    closed: number;
    forced: number;
    active: number;
  };
}

class FakeSocket extends EventEmitter {
  readyState = 1;
  closeCalls = 0;
  terminateCalls = 0;

  constructor(private readonly closeGracefully: boolean) {
    super();
  }

  addEventListener(event: string, listener: (...args: any[]) => void) {
    this.on(event, listener);
  }

  close() {
    this.closeCalls++;
    if (this.closeGracefully) this.finishClose();
  }

  terminate() {
    this.terminateCalls++;
    this.finishClose();
  }

  private finishClose() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code: 1000, reason: "" });
  }
}

function fakeTransport(WebSocketTransport: any, socket: FakeSocket) {
  const transport = Object.create(WebSocketTransport.prototype);
  Object.assign(transport, {
    _ws: socket,
    _progress: undefined,
    _logUrl: "test",
    _closeTimer: undefined,
    _closeRequested: false,
    _closed: false,
  });
  socket.addEventListener("close", () => transport._didClose());
  transportStats().opened = 1;
  transportStats().active = 1;
  return transport;
}

describe("Playwright CDP compatibility patch", () => {
  const { WebSocketTransport } = require(transportPath);

  beforeEach(() => {
    Object.assign(transportStats(), { opened: 0, closed: 0, forced: 0, active: 0 });
  });

  test("pins the patched Playwright version and installs its external WebSocket dependency", async () => {
    const packageJson = await Bun.file(new URL("./package.json", import.meta.url)).json() as {
      dependencies?: Record<string, string>;
      patchedDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.["playwright-core"]).toBe("1.58.2");
    expect(packageJson.dependencies?.ws).toBe("8.21.0");
    expect(packageJson.patchedDependencies?.["playwright-core@1.58.2"])
      .toBe("patches/playwright-core@1.58.2.patch");
  });

  test("installs the external ws and hardened transport patch", async () => {
    const patch = await Bun.file(
      new URL("./patches/playwright-core@1.58.2.patch", import.meta.url),
    ).text();
    const installed = await Bun.file(new URL(
      "./node_modules/playwright-core/lib/server/transport.js",
      import.meta.url,
    )).text();
    const installedContext = await Bun.file(new URL(
      "./node_modules/playwright-core/lib/server/browserContext.js",
      import.meta.url,
    )).text();

    for (const source of [patch, installed]) {
      expect(source).toContain("const perMessageDeflate = false");
      expect(source).toContain("const kWebSocketCloseTimeout = 5e3");
      expect(source).toContain("this._ws.terminate()");
      expect(source).not.toContain("closeTimeout:");
    }
    expect(patch).toContain('const _rawWs = require("ws")');
    for (const source of [patch, installedContext]) {
      expect(source).toContain("if (!options.name && !options.domain && !options.path)");
    }
    expect(installed.match(/(?:this|transport)\._ws\.close\(\)/g)).toHaveLength(1);
  });

  test("unfiltered cookie clearing skips the unnecessary cookie read", async () => {
    const { BrowserContext } = require(browserContextPath);
    const events: string[] = [];
    const context = {
      async cookies() {
        events.push("read");
        return [
          { name: "keep", value: "1", domain: ".x.com", path: "/" },
          { name: "remove", value: "2", domain: ".x.com", path: "/" },
        ];
      },
      async doClearCookies() { events.push("clear"); },
      async addCookies(cookies: any[]) { events.push(`add:${cookies.map((cookie) => cookie.name).join(",")}`); },
    };

    await BrowserContext.prototype.clearCookies.call(context, {});
    expect(events).toEqual(["clear"]);

    events.length = 0;
    await BrowserContext.prototype.clearCookies.call(context, { name: "remove" });
    expect(events).toEqual(["read", "clear", "add:keep"]);
  });

  test("graceful close clears the fallback without terminating", async () => {
    const socket = new FakeSocket(true);
    const transport = fakeTransport(WebSocketTransport, socket);

    await transport.closeAndWait(5);
    await Bun.sleep(10);

    expect(socket.closeCalls).toBe(1);
    expect(socket.terminateCalls).toBe(0);
    expect(transportStats()).toEqual({ opened: 1, closed: 1, forced: 0, active: 0 });
  });

  test("stalled and repeated closes force-terminate exactly once", async () => {
    const socket = new FakeSocket(false);
    const transport = fakeTransport(WebSocketTransport, socket);

    const closed = transport.closeAndWait(5);
    transport.close(5);
    transport.close(5);
    await closed;
    transport._didClose();

    expect(socket.closeCalls).toBe(1);
    expect(socket.terminateCalls).toBe(1);
    expect(transportStats()).toEqual({ opened: 1, closed: 1, forced: 1, active: 0 });
  });
});
