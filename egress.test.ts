import { expect, test } from "bun:test";
import { parseEgressResponse, resolveEgressEndpoints, verifyRelayEgress } from "./egress.ts";

test("parseEgressResponse accepts JSON and plain IPv4/IPv6 responses", () => {
  expect(parseEgressResponse('{"ip":"203.0.113.4","country":"US"}')).toEqual({ ip: "203.0.113.4", country: "US" });
  expect(parseEgressResponse('{"query":"2001:db8::1"}')).toEqual({ ip: "2001:db8::1" });
  expect(parseEgressResponse("198.51.100.9\n")).toEqual({ ip: "198.51.100.9" });
});

test("parseEgressResponse rejects malformed responses", () => {
  expect(parseEgressResponse("")).toBeNull();
  expect(parseEgressResponse("not an ip")).toBeNull();
  expect(parseEgressResponse('{"ip":"localhost"}')).toBeNull();
});

test("egress endpoints support an operator override and reject invalid schemes", () => {
  expect(resolveEgressEndpoints("https://one.example/ip, http://127.0.0.1:8080/ip")).toEqual([
    "https://one.example/ip",
    "http://127.0.0.1:8080/ip",
  ]);
  expect(() => resolveEgressEndpoints("")).toThrow("at least one URL");
  expect(() => resolveEgressEndpoints("file:///tmp/ip")).toThrow("must use http or https");
});

test("relay proxy verification refuses plaintext endpoints before connecting", async () => {
  await expect(verifyRelayEgress(
    1, // never contacted: endpoint validation happens first
    { endpoints: ["http://example.test/ip"] },
  )).rejects.toThrow("must use HTTPS");
});

test("relay proxy verification returns the egress IP from the tunnel", async () => {
  const calls: Array<[number, string]> = [];
  const info = await verifyRelayEgress(4321, {
    endpoints: ["https://example.test/ip"],
    fetchThroughRelay: async (relayPort, endpoint) => {
      calls.push([relayPort, endpoint]);
      return { ip: "203.0.113.9" };
    },
  });
  expect(info.ip).toBe("203.0.113.9");
  expect(calls).toEqual([[4321, "https://example.test/ip"]]);
});

test("relay proxy verification tries the next endpoint after a failure", async () => {
  const seen: string[] = [];
  const info = await verifyRelayEgress(4321, {
    endpoints: ["https://one.test/ip", "https://two.test/ip"],
    fetchThroughRelay: async (_port, endpoint) => {
      seen.push(endpoint);
      if (endpoint.includes("one")) throw new Error("refused");
      return { ip: "198.51.100.7" };
    },
  });
  expect(info.ip).toBe("198.51.100.7");
  expect(seen).toEqual(["https://one.test/ip", "https://two.test/ip"]);
});

test("relay proxy verification fails closed when every endpoint fails", async () => {
  await expect(verifyRelayEgress(4321, {
    endpoints: ["https://one.test/ip", "https://two.test/ip"],
    fetchThroughRelay: async () => { throw new Error("refused"); },
  })).rejects.toThrow("proxy verification failed before account traffic");
});
