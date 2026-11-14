import { expect, test } from "bun:test";
import { agentTurns, clip, formatMicroUsd, toolLabel } from "./agent.tsx";

test("micro-USD shows dollars and cents, and a tiny charge as <$0.01", () => {
  expect(formatMicroUsd(500_000)).toBe("$0.50");
  expect(formatMicroUsd(320_000)).toBe("$0.32");
  expect(formatMicroUsd(0)).toBe("$0.00");
  expect(formatMicroUsd(1_200)).toBe("<$0.01");
  expect(formatMicroUsd(12_400_000)).toBe("$12.40");
});

test("tool names read as short words, and long step text is cut", () => {
  expect(toolLabel("browser_navigate")).toBe("Navigate");
  expect(toolLabel("aliasmode_profiles_list")).toBe("Profiles list");
  expect(toolLabel("aliasmode_browser_open")).toBe("Open");
  expect(clip("x".repeat(2100)).length).toBe(2001);
  expect(clip("short")).toBe("short");
});

test("each user message is followed by one agent turn holding its steps, results and text", () => {
  const turns = agentTurns([
    { role: "user", content: "Open A" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "browser_navigate", arguments: "{\"url\":\"https://example.com\"}" } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    { role: "assistant", content: "Done.\nIt shows Example Domain." },
    { role: "user", content: "Thanks" },
  ]);
  expect(turns).toEqual([
    { role: "user", text: "Open A" },
    { role: "agent", steps: [{ id: "c1", name: "browser_navigate", args: "{\"url\":\"https://example.com\"}", result: "ok" }], texts: ["Done.\nIt shows Example Domain."] },
    { role: "user", text: "Thanks" },
  ]);
});
