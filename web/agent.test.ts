import { expect, test } from "bun:test";
import { agentTurns, clip, describeStep, formatMicroUsd, groupConversations, toolLabel } from "./agent.tsx";
import { translate } from "./i18n.tsx";
import { parseInline, parseMarkdown, safeHref, type MdBlock } from "./markdown.tsx";

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

test("tool steps read as friendly past-tense lines with an icon", () => {
  const t = (source: string, values?: Record<string, string | number>) => translate({ "en-US": {} }, "en-US", source, values);
  expect(describeStep({ name: "aliasmode_profiles_list", args: "{}" }, t)).toEqual({ label: "Listed profiles", icon: "list" });
  expect(describeStep({ name: "aliasmode_browser_open", args: "{\"profileId\":\"x\"}" }, t).label).toBe("Opened profile");
  expect(describeStep({ name: "browser_navigate", args: "{\"url\":\"https://www.example.com/a?b\"}" }, t)).toEqual({ label: "Opened example.com", icon: "globe" });
  expect(describeStep({ name: "browser_navigate", args: "{\"url\":\"not a url\"}" }, t).label).toBe("Opened a page");
  expect(describeStep({ name: "browser_snapshot", args: "" }, t).label).toBe("Read the page");
  expect(describeStep({ name: "browser_click", args: "{\"element\":\"Post button\"}" }, t).label).toBe("Clicked Post button");
  expect(describeStep({ name: "aliasmode_profile_create", args: "{\"name\":\"Shop 3\"}" }, t).label).toBe("Created profile Shop 3");
  expect(describeStep({ name: "browser_type", args: "{broken" }, t).label).toBe("Typed");
  expect(describeStep({ name: "custom_tool_thing", args: "{}" }, t)).toEqual({ label: "Custom tool thing", icon: "tool" });
});

test("chats group into Today, Previous 7 days and Older", () => {
  const now = new Date(2026, 10, 15, 12, 0);
  const at = (days: number) => new Date(2026, 10, 15 - days, 11).toISOString();
  const groups = groupConversations([
    { id: "a", updatedAt: at(0) }, { id: "b", updatedAt: at(1) }, { id: "c", updatedAt: at(6) }, { id: "d", updatedAt: at(30) },
  ], now);
  expect(groups.map((group) => [group.label, group.items.map((item) => item.id)])).toEqual([
    ["Today", ["a"]], ["Previous 7 days", ["b", "c"]], ["Older", ["d"]],
  ]);
  expect(groupConversations([], now)).toEqual([]);
});

test("markdown: paragraphs, headings, emphasis, inline code and line breaks", () => {
  expect(parseMarkdown("# Title\n\nSome **bold**, *it*, _em_, ~~old~~ and `code`.\nNext line")).toEqual([
    { type: "h", level: 1, children: [{ type: "text", text: "Title" }] },
    { type: "p", children: [
      { type: "text", text: "Some " }, { type: "strong", children: [{ type: "text", text: "bold" }] },
      { type: "text", text: ", " }, { type: "em", children: [{ type: "text", text: "it" }] },
      { type: "text", text: ", " }, { type: "em", children: [{ type: "text", text: "em" }] },
      { type: "text", text: ", " }, { type: "del", children: [{ type: "text", text: "old" }] },
      { type: "text", text: " and " }, { type: "code", text: "code" }, { type: "text", text: "." },
      { type: "br" }, { type: "text", text: "Next line" },
    ] },
  ]);
  // Snake case and stray asterisks stay text.
  expect(parseMarkdown("call aliasmode_browser_open with 2 * 3")).toEqual([
    { type: "p", children: [{ type: "text", text: "call aliasmode_browser_open with 2 * 3" }] },
  ]);
});

test("markdown: fenced code keeps its text and language", () => {
  expect(parseMarkdown("Before\n```js\nconst a = 1;\n\n**not bold**\n```\nAfter")).toEqual([
    { type: "p", children: [{ type: "text", text: "Before" }] },
    { type: "code", lang: "js", text: "const a = 1;\n\n**not bold**" },
    { type: "p", children: [{ type: "text", text: "After" }] },
  ]);
});

test("markdown: ordered, unordered and nested lists", () => {
  const text = (value: string): MdBlock[] => [{ type: "p", children: [{ type: "text", text: value }] }];
  expect(parseMarkdown("1. One\n2. Two\n   - a\n   - b\n\n3. Three\n\n- x\n- y")).toEqual([
    { type: "list", ordered: true, start: 1, items: [
      text("One"),
      [...text("Two"), { type: "list", ordered: false, start: 1, items: [text("a"), text("b")] }],
      text("Three"),
    ] },
    { type: "list", ordered: false, start: 1, items: [text("x"), text("y")] },
  ]);
  expect(parseMarkdown("3) Third")[0]).toMatchObject({ type: "list", ordered: true, start: 3 });
});

test("markdown: GFM tables with alignment, quotes and rules", () => {
  expect(parseMarkdown("| Profile | IP | Ok |\n|:--|--:|:-:|\n| A | `1.2.3.4` | yes |\n| B \\| C | 5.6.7.8 |")).toEqual([
    { type: "table", align: ["left", "right", "center"],
      head: [[{ type: "text", text: "Profile" }], [{ type: "text", text: "IP" }], [{ type: "text", text: "Ok" }]],
      rows: [
        [[{ type: "text", text: "A" }], [{ type: "code", text: "1.2.3.4" }], [{ type: "text", text: "yes" }]],
        [[{ type: "text", text: "B | C" }], [{ type: "text", text: "5.6.7.8" }], []],
      ] },
  ]);
  expect(parseMarkdown("> quoted\n\n---")).toEqual([
    { type: "quote", children: [{ type: "p", children: [{ type: "text", text: "quoted" }] }] },
    { type: "hr" },
  ]);
  // A lone pipe is not a table.
  expect(parseMarkdown("a | b")[0]!.type).toBe("p");
});

test("markdown: only web and mail links become links", () => {
  expect(parseInline("[site](https://example.com) and https://x.com/home. [bad](javascript:alert(1)) <mailto:a@b.co>")).toEqual([
    { type: "link", href: "https://example.com", children: [{ type: "text", text: "site" }] },
    { type: "text", text: " and " },
    { type: "link", href: "https://x.com/home", children: [{ type: "text", text: "https://x.com/home" }] },
    { type: "text", text: ". bad) " },
    { type: "link", href: "mailto:a@b.co", children: [{ type: "text", text: "mailto:a@b.co" }] },
  ]);
  expect(safeHref("javascript:alert(1)")).toBeNull();
  expect(safeHref("data:text/html,x")).toBeNull();
  expect(safeHref("www.example.com")).toBe("https://www.example.com");
});
