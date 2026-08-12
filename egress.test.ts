import { expect, test } from "bun:test";
import { fetchDirectEgress, parseEgressResponse, resolveEgressEndpoints } from "./egress.ts";

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

test("direct egress tries the next endpoint after a failure", async () => {
  const seen: string[] = [];
  const info = await fetchDirectEgress({
    endpoints: ["https://one.test/ip", "https://two.test/ip"],
  }, (async (endpoint: string) => {
    seen.push(endpoint);
    if (endpoint.includes("one")) throw new Error("unavailable");
    return new Response('{"ip":"198.51.100.7"}');
  }) as typeof fetch);

  expect(info).toEqual({ ip: "198.51.100.7" });
  expect(seen).toEqual(["https://one.test/ip", "https://two.test/ip"]);
});
