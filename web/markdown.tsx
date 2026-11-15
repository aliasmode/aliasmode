import { useState, type ReactNode } from "react";
import { useTranslation } from "./i18n.tsx";

/**
 * A small, safe Markdown renderer for agent replies. Text becomes React
 * elements (never HTML strings), and only http(s) and mailto links become links.
 */
export type MdInline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong" | "em" | "del"; children: MdInline[] }
  | { type: "link"; href: string; children: MdInline[] }
  | { type: "br" };

export type MdAlign = "left" | "center" | "right" | null;

export type MdBlock =
  | { type: "p"; children: MdInline[] }
  | { type: "h"; level: number; children: MdInline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; start: number; items: MdBlock[][] }
  | { type: "table"; align: MdAlign[]; head: MdInline[][]; rows: MdInline[][][] }
  | { type: "quote"; children: MdBlock[] }
  | { type: "hr" };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function parseMarkdown(source: string): MdBlock[] {
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"));
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i]!;
  const sep = lines[i + 1];
  return head.includes("|") && sep !== undefined && sep.includes("-") && TABLE_SEP.test(sep)
    && splitRow(head).length === splitRow(sep).length;
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]!;
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line) || isTableStart(lines, i);
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function parseBlocks(lines: string[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) body.push(lines[i++]!);
      i++;
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ type: "h", level: heading[1]!.length, children: parseInline(heading[2]!) });
      i++;
      continue;
    }

    if (HR.test(line)) { blocks.push({ type: "hr" }); i++; continue; }

    if (isTableStart(lines, i)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map((cell): MdAlign =>
        cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : null);
      i += 2;
      const rows: MdInline[][][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) {
        const cells = splitRow(lines[i++]!);
        rows.push(head.map((_, column) => parseInline(cells[column] ?? "")));
      }
      blocks.push({ type: "table", align, head: head.map((cell) => parseInline(cell)), rows });
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(lines[i++]!.match(QUOTE)![1]!);
      blocks.push({ type: "quote", children: parseBlocks(body) });
      continue;
    }

    const first = line.match(LIST);
    if (first) {
      const base = first[1]!.length;
      const ordered = /\d/.test(first[2]!);
      const items: MdBlock[][] = [];
      while (i < lines.length) {
        const item = lines[i]!.match(LIST);
        if (!item || item[1]!.length > base + 1 || /\d/.test(item[2]!) !== ordered) break;
        const width = item[1]!.length + item[2]!.length + 1;
        const body = [item[3]!];
        i++;
        while (i < lines.length) {
          const next = lines[i]!;
          if (!next.trim()) {
            let ahead = i + 1;
            while (ahead < lines.length && !lines[ahead]!.trim()) ahead++;
            if (ahead < lines.length && indentOf(lines[ahead]!) >= base + 2) { body.push(""); i++; continue; }
            break;
          }
          if (indentOf(next) >= base + 2) { body.push(next.slice(Math.min(width, indentOf(next)))); i++; continue; }
          if (startsBlock(lines, i)) break;
          body.push(next.trim());
          i++;
        }
        items.push(parseBlocks(body));
        // Blank lines between items keep the list going.
        let ahead = i;
        while (ahead < lines.length && !lines[ahead]!.trim()) ahead++;
        const following = lines[ahead]?.match(LIST);
        if (ahead > i && following && following[1]!.length <= base + 1 && /\d/.test(following[2]!) === ordered) i = ahead;
      }
      blocks.push({ type: "list", ordered, start: ordered ? Number.parseInt(first[2]!, 10) : 1, items });
      continue;
    }

    const paragraph = [line.trim()];
    i++;
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines, i)) paragraph.push(lines[i++]!.trim());
    blocks.push({ type: "p", children: parseInline(paragraph.join("\n")) });
  }
  return blocks;
}

/** Only web and mail links open; anything else (javascript:, file:, data:) stays text. */
export function safeHref(href: string): string | null {
  const value = href.trim();
  if (/^(https?:\/\/|mailto:)/i.test(value)) return value;
  if (/^www\.[^\s]+\.[^\s]+/i.test(value)) return `https://${value}`;
  return null;
}

const URL_AT = /^(https?:\/\/|www\.)[^\s<]+/i;

export function parseInline(source: string): MdInline[] {
  const out: MdInline[] = [];
  let text = "";
  const flush = () => { if (text) { out.push({ type: "text", text }); text = ""; } };
  const push = (node: MdInline) => { flush(); out.push(node); };
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    const rest = source.slice(i);

    if (char === "\\" && i + 1 < source.length && /[!-/:-@[-`{-~]/.test(source[i + 1]!)) { text += source[i + 1]; i += 2; continue; }
    if (char === "\n") { push({ type: "br" }); i++; continue; }

    if (char === "`") {
      const run = rest.match(/^`+/)![0];
      const end = source.indexOf(run, i + run.length);
      if (end > i) { push({ type: "code", text: source.slice(i + run.length, end).trim() || source.slice(i + run.length, end) }); i = end + run.length; continue; }
      text += run; i += run.length; continue;
    }

    const pair = rest.startsWith("**") ? "**" : rest.startsWith("__") ? "__" : rest.startsWith("~~") ? "~~" : null;
    if (pair && (pair !== "__" || !/\w/.test(source[i - 1] ?? ""))) {
      const end = source.indexOf(pair, i + 2);
      const inner = end > i + 2 ? source.slice(i + 2, end) : "";
      if (inner.trim() && inner === inner.trim()) {
        push({ type: pair === "~~" ? "del" : "strong", children: parseInline(inner) });
        i = end + 2;
        continue;
      }
    }

    if ((char === "*" || char === "_") && source[i + 1] !== char && source[i + 1] && /\S/.test(source[i + 1]!)
      && (char === "*" || !/\w/.test(source[i - 1] ?? ""))) {
      let end = i + 1;
      while ((end = source.indexOf(char, end)) !== -1) {
        const doubled = source[end + 1] === char || source[end - 1] === char;
        if (!doubled && /\S/.test(source[end - 1]!) && (char === "*" || !/\w/.test(source[end + 1] ?? ""))) break;
        end++;
      }
      if (end > i + 1) { push({ type: "em", children: parseInline(source.slice(i + 1, end)) }); i = end + 1; continue; }
    }

    if (char === "[") {
      const link = rest.match(/^\[([^\]\n]+)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/);
      if (link) {
        const href = safeHref(link[2]!);
        if (href) push({ type: "link", href, children: parseInline(link[1]!) });
        else {
          const label = parseInline(link[1]!);
          if (label.every((node) => node.type === "text")) text += label.map((node) => node.text).join("");
          else { flush(); out.push(...label); }
        }
        i += link[0].length;
        continue;
      }
    }

    if (char === "<") {
      const auto = rest.match(/^<((?:https?:\/\/|mailto:)[^\s>]+)>/i);
      if (auto) { push({ type: "link", href: auto[1]!, children: [{ type: "text", text: auto[1]! }] }); i += auto[0].length; continue; }
    }

    if ((char === "h" || char === "w" || char === "H" || char === "W") && !/\w/.test(source[i - 1] ?? "")) {
      const bare = rest.match(URL_AT);
      if (bare) {
        let url = bare[0].replace(/[.,;:!?'"*_]+$/, "");
        while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
        const href = safeHref(url);
        if (href) { push({ type: "link", href, children: [{ type: "text", text: url }] }); i += url.length; continue; }
      }
    }

    text += char;
    i++;
  }
  flush();
  return out;
}

function renderInline(nodes: MdInline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text": return node.text;
      case "br": return <br key={index} />;
      case "code": return <code key={index}>{node.text}</code>;
      case "strong": return <strong key={index}>{renderInline(node.children)}</strong>;
      case "em": return <em key={index}>{renderInline(node.children)}</em>;
      case "del": return <del key={index}>{renderInline(node.children)}</del>;
      case "link": return <a key={index} href={node.href} target="_blank" rel="noreferrer">{renderInline(node.children)}</a>;
    }
  });
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }, () => {});
  };
  return <div className="md-code">
    <div className="md-code-head">
      <span>{lang || "text"}</span>
      <button type="button" onClick={copy} aria-label={t("Copy code")}>
        <svg className="icon sm" viewBox="0 0 24 24" aria-hidden="true">
          {copied ? <path d="M5 12.5l4.5 4.5L19 7.5" /> : <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 012-2h8" /></>}
        </svg>
        {copied ? t("Copied") : t("Copy code")}
      </button>
    </div>
    <pre><code>{text}</code></pre>
  </div>;
}

function renderBlocks(blocks: MdBlock[], tight = false): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.type) {
      case "p": return tight && index === 0 ? <span key={index}>{renderInline(block.children)}</span> : <p key={index}>{renderInline(block.children)}</p>;
      case "h": {
        const Tag = `h${Math.min(6, block.level + 2)}` as "h3" | "h4" | "h5" | "h6";
        return <Tag key={index}>{renderInline(block.children)}</Tag>;
      }
      case "code": return <CodeBlock key={index} lang={block.lang} text={block.text} />;
      case "hr": return <hr key={index} />;
      case "quote": return <blockquote key={index}>{renderBlocks(block.children)}</blockquote>;
      case "list": {
        const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{renderBlocks(item, true)}</li>);
        return block.ordered ? <ol key={index} start={block.start === 1 ? undefined : block.start}>{items}</ol> : <ul key={index}>{items}</ul>;
      }
      case "table": return <div key={index} className="md-table">
        <table>
          <thead><tr>{block.head.map((cell, column) => <th key={column} style={block.align[column] ? { textAlign: block.align[column]! } : undefined}>{renderInline(cell)}</th>)}</tr></thead>
          <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) =>
            <td key={column} style={block.align[column] ? { textAlign: block.align[column]! } : undefined}>{renderInline(cell)}</td>)}</tr>)}</tbody>
        </table>
      </div>;
    }
  });
}

export function Markdown({ text }: { text: string }) {
  return <div className="md">{renderBlocks(parseMarkdown(text))}</div>;
}
