import { expect, test } from "bun:test";
import {
  createSystemProxyFetch,
  isLoopbackHost,
  matchesBypass,
  normalizeProxyAddress,
  parseWindowsProxySettings,
  runCurlDirectFirst,
  systemProxyCurlArgs,
} from "./system-proxy.ts";

test("system proxy normalization accepts URLs and Windows per-protocol values", () => {
  expect(normalizeProxyAddress(" http://proxy.example:8080 ")).toEqual({ host: "proxy.example", port: 8080 });
  expect(normalizeProxyAddress("https://proxy.example:8443")).toEqual({ host: "proxy.example", port: 8443 });
  expect(normalizeProxyAddress("http=old.example:80; https=new.example:443")).toEqual({ host: "new.example", port: 443 });
  expect(normalizeProxyAddress("broken")).toBeNull();
  expect(normalizeProxyAddress("http://:bad")).toBeNull();
});

test("Windows proxy output is parsed without interpreting PAC settings", () => {
  const parsed = parseWindowsProxySettings(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ       http=proxy.example:80;https=secure.example:443
    ProxyOverride  REG_MULTI_SZ  <local>;*.example.test
  `);
  expect(parsed).toEqual({
    enabled: true,
    proxy: "http=proxy.example:80;https=secure.example:443",
    bypass: ["<local>", "*.example.test"],
    pac: false,
  });
  expect(parseWindowsProxySettings("AutoConfigURL REG_SZ http://proxy/pac.js").pac).toBe(true);
});

test("system proxy fetch keeps bypassed and loopback hosts direct", async () => {
  const calls: Array<{ url: string; init?: any }> = [];
  const baseFetch = (async (url: string, init?: any) => {
    calls.push({ url, init });
    return new Response("ok");
  }) as typeof fetch;
  const proxied = createSystemProxyFetch(baseFetch, () => ({
    host: "proxy.example",
    port: 20122,
    bypass: ["*.internal.test", "<local>"],
  }));

  await proxied("https://service.internal.test/data");
  expect(calls.at(-1)?.init?.proxy).toBeUndefined();

  await proxied("http://localhost:8080/ui");
  expect(calls.at(-1)?.init?.proxy).toBeUndefined();

  await proxied("http://127.0.0.1:9000/health");
  expect(calls.at(-1)?.init?.proxy).toBeUndefined();

  const direct = createSystemProxyFetch(baseFetch, () => null);
  await direct("https://api.example.com/login");
  expect(calls.at(-1)?.init?.proxy).toBeUndefined();
});

test("system proxy fetch uses direct connections that work", async () => {
  const calls: Array<{ url: string; init?: any }> = [];
  const baseFetch = (async (url: string, init?: any) => {
    calls.push({ url, init });
    return new Response("ok");
  }) as typeof fetch;
  const proxied = createSystemProxyFetch(baseFetch, () => ({
    host: "proxy.example",
    port: 20122,
    bypass: [] as string[],
  }));

  const response = await proxied("https://api.example.com/login");
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.init?.proxy).toBeUndefined();

  await proxied("https://api.example.com/refresh");
  expect(calls).toHaveLength(2);
  expect(calls[1]?.init?.proxy).toBeUndefined();
});

test("system proxy fetch falls back to the proxy when direct fails and remembers it per origin", async () => {
  const calls: Array<{ url: string; init?: any }> = [];
  const baseFetch = (async (url: string, init?: any) => {
    calls.push({ url, init });
    if (!init?.proxy) throw new TypeError("fetch failed");
    return new Response("ok");
  }) as typeof fetch;
  const proxied = createSystemProxyFetch(baseFetch, () => ({
    host: "proxy.example",
    port: 20122,
    bypass: [] as string[],
  }));

  const response = await proxied("https://api.example.com/login");
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.init?.proxy).toBeUndefined();
  expect(calls[1]?.init?.proxy).toBe("http://proxy.example:20122");

  // Same origin: straight to the proxy, no fresh direct attempt.
  await proxied("https://api.example.com/refresh");
  expect(calls).toHaveLength(3);
  expect(calls[2]?.init?.proxy).toBe("http://proxy.example:20122");

  // A different origin still earns its own direct attempt first.
  await proxied("https://other.example.com/login");
  expect(calls).toHaveLength(5);
  expect(calls[3]?.init?.proxy).toBeUndefined();
  expect(calls[4]?.init?.proxy).toBe("http://proxy.example:20122");
});

test("system proxy fetch flips a remembered direct origin to the proxy when direct starts failing", async () => {
  const calls: Array<{ url: string; init?: any }> = [];
  let directWorks = true;
  const baseFetch = (async (url: string, init?: any) => {
    calls.push({ url, init });
    if (!init?.proxy && !directWorks) throw new TypeError("fetch failed");
    return new Response("ok");
  }) as typeof fetch;
  const proxied = createSystemProxyFetch(baseFetch, () => ({
    host: "proxy.example",
    port: 20122,
    bypass: [] as string[],
  }));

  await proxied("https://api.example.com/login");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.init?.proxy).toBeUndefined();

  directWorks = false;
  await proxied("https://api.example.com/refresh");
  expect(calls).toHaveLength(3);
  expect(calls[1]?.init?.proxy).toBeUndefined();
  expect(calls[2]?.init?.proxy).toBe("http://proxy.example:20122");

  await proxied("https://api.example.com/refresh");
  expect(calls).toHaveLength(4);
  expect(calls[3]?.init?.proxy).toBe("http://proxy.example:20122");
});

test("system proxy fetch never routes a bypassed host through the proxy, even when direct fails", async () => {
  const failure = new TypeError("fetch failed");
  let attempts = 0;
  const baseFetch = (async () => {
    attempts += 1;
    throw failure;
  }) as unknown as typeof fetch;
  const proxied = createSystemProxyFetch(baseFetch, () => ({
    host: "proxy.example",
    port: 20122,
    bypass: ["*.internal.test"],
  }));

  let caught: unknown;
  try {
    await proxied("https://service.internal.test/data");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(failure);
  expect(attempts).toBe(1);
});

test("system proxy fetch without a detected proxy passes failures through untouched", async () => {
  const failure = new TypeError("fetch failed");
  let attempts = 0;
  const baseFetch = (async () => {
    attempts += 1;
    throw failure;
  }) as unknown as typeof fetch;
  const direct = createSystemProxyFetch(baseFetch, () => null);

  let caught: unknown;
  try {
    await direct("https://api.example.com/login");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(failure);
  expect(attempts).toBe(1);
});

test("system proxy fetch reports the direct failure when the proxy attempt also fails", async () => {
  const directFailure = new TypeError("direct failed");
  const proxyFailure = new TypeError("proxy failed");
  const baseFetch = (async (_url: string, init?: any) => {
    throw init?.proxy ? proxyFailure : directFailure;
  }) as unknown as typeof fetch;
  const proxied = createSystemProxyFetch(baseFetch, () => ({
    host: "proxy.example",
    port: 20122,
    bypass: [] as string[],
  }));

  let caught: unknown;
  try {
    await proxied("https://api.example.com/login");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(directFailure);
});

test("system proxy fetch treats an HTTP error status as a reachable direct route", async () => {
  const calls: Array<{ url: string; init?: any }> = [];
  const baseFetch = (async (url: string, init?: any) => {
    calls.push({ url, init });
    return new Response("nope", { status: 500 });
  }) as typeof fetch;
  const proxied = createSystemProxyFetch(baseFetch, () => ({
    host: "proxy.example",
    port: 20122,
    bypass: [] as string[],
  }));

  const response = await proxied("https://api.example.com/login");
  expect(response.status).toBe(500);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.init?.proxy).toBeUndefined();
});

test("system proxy fetch does not reroute a request the caller aborted", async () => {
  let attempts = 0;
  const baseFetch = (async (_url: string, init?: any) => {
    attempts += 1;
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    return new Response("ok");
  }) as unknown as typeof fetch;
  const proxied = createSystemProxyFetch(baseFetch, () => ({
    host: "proxy.example",
    port: 20122,
    bypass: [] as string[],
  }));
  const controller = new AbortController();
  controller.abort();

  let caught: unknown;
  try {
    await proxied("https://api.example.com/login", { signal: controller.signal });
  } catch (error) {
    caught = error;
  }
  expect(attempts).toBe(1);
  expect((caught as Error)?.name).toBe("AbortError");
});

test("system proxy fetch gives up on a stalled direct attempt and uses the proxy", async () => {
  const calls: Array<{ url: string; init?: any }> = [];
  const baseFetch = (async (url: string, init?: any) => {
    calls.push({ url, init });
    if (init?.proxy) return new Response("ok");
    // A direct route that never produces headers: only the abort signal ends it.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted", "AbortError")));
    });
  }) as unknown as typeof fetch;
  const proxied = createSystemProxyFetch(baseFetch, () => ({
    host: "proxy.example",
    port: 20122,
    bypass: [] as string[],
  }));

  const response = await proxied("https://api.example.com/login");
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.init?.proxy).toBe("http://proxy.example:20122");
});

test("system proxy curl args follow the same routing decision", () => {
  const detect = () => ({ host: "proxy.example", port: 20122, bypass: [] as string[] });
  expect(systemProxyCurlArgs("https://github.com/x.zip", detect)).toEqual(["--proxy", "http://proxy.example:20122"]);
  expect(systemProxyCurlArgs("https://github.com/x.zip", () => null)).toEqual([]);
  expect(systemProxyCurlArgs("http://localhost:1/x", detect)).toEqual([]);
});

test("curl downloads try direct first and retry connection failures through the proxy", async () => {
  const detect = () => ({ host: "proxy.example", port: 20122, bypass: [] as string[] });

  const attempts: string[][] = [];
  const code = await runCurlDirectFirst("https://example.com/a.zip", async (args) => {
    attempts.push(args);
    return attempts.length === 1 ? 7 : 0;
  }, detect);
  expect(code).toBe(0);
  expect(attempts).toEqual([
    ["--connect-timeout", "5"],
    ["--proxy", "http://proxy.example:20122"],
  ]);

  // A timeout is also a connection-stage failure worth one proxy retry.
  const timeoutAttempts: string[][] = [];
  const timeoutCode = await runCurlDirectFirst("https://example.com/a.zip", async (args) => {
    timeoutAttempts.push(args);
    return timeoutAttempts.length === 1 ? 28 : 0;
  }, detect);
  expect(timeoutCode).toBe(0);
  expect(timeoutAttempts).toHaveLength(2);

  // A non-connection failure is the final answer: no proxy retry.
  const httpAttempts: string[][] = [];
  const httpCode = await runCurlDirectFirst("https://example.com/a.zip", async (args) => {
    httpAttempts.push(args);
    return 22;
  }, detect);
  expect(httpCode).toBe(22);
  expect(httpAttempts).toEqual([["--connect-timeout", "5"]]);

  // Without a detected proxy the command line is left untouched.
  const plainAttempts: string[][] = [];
  const plainCode = await runCurlDirectFirst("https://example.com/a.zip", async (args) => {
    plainAttempts.push(args);
    return 7;
  }, () => null);
  expect(plainCode).toBe(7);
  expect(plainAttempts).toEqual([[]]);
});

test("system proxy bypass and loopback checks are case-insensitive", () => {
  expect(matchesBypass("api.example.test", ["*.example.test"])).toBe(true);
  expect(matchesBypass("printer", ["<local>"])).toBe(true);
  expect(matchesBypass("api.other.test", ["*.example.test"])).toBe(false);
  expect(isLoopbackHost("LOCALHOST")).toBe(true);
  expect(isLoopbackHost("[::1]")).toBe(true);
  expect(isLoopbackHost("127.0.0.1")).toBe(true);
  expect(isLoopbackHost("192.168.1.1")).toBe(false);
});
