/**
 * Minimal, dependency-free .xlsx (SpreadsheetML) writer and reader.
 *
 * An .xlsx is a ZIP of a handful of XML parts, and we only ever deal with one
 * flat sheet of text, so a full spreadsheet library would be all cost and no
 * benefit here — this file is the whole implementation. It mirrors unzip.ts:
 * that inflates with node:zlib, this deflates with it, and both share
 * unzip.ts's central-directory walk.
 *
 * Every cell we WRITE is an inline string (`t="inlineStr"`). That keeps the
 * writer stateless (no shared-string table to thread through) and, unlike CSV,
 * makes the output immune to formula injection: a value beginning with "=" is
 * declared a string by the file format, so Excel cannot evaluate it.
 *
 * Every cell we READ may be an inline string, a shared string, or a number,
 * because Excel rewrites the file its own way as soon as a human saves it.
 */

import { deflateRawSync } from "node:zlib";

import { zipEntries } from "./unzip.ts";

/** Excel refuses to open a workbook with a cell longer than this. */
export const XLSX_MAX_CELL = 32_767;

// ===========================================================================
// ZIP writing
// ===========================================================================

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function deflateRaw(data: Uint8Array): Uint8Array {
  return new Uint8Array(deflateRawSync(data));
}

export interface ZipPart {
  name: string;
  data: string | Uint8Array;
}

/**
 * Build a ZIP from in-memory parts. Timestamps are pinned to the DOS epoch so
 * exporting the same profiles twice produces byte-identical files, rather than
 * files that differ only in a header nobody reads.
 */
export async function buildZip(parts: ZipPart[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const DOS_DATE = 0x0021; // 1980-01-01
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const part of parts) {
    const name = enc.encode(part.name);
    const raw = typeof part.data === "string" ? enc.encode(part.data) : part.data;
    const comp = deflateRaw(raw);
    // Deflate can grow already-incompressible data; store it verbatim if so.
    const stored = comp.length >= raw.length;
    const body = stored ? raw : comp;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);

    chunks.push(local, body);
    central.push(cd);
    offset += local.length + body.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, parts.length, true);
  ev.setUint16(10, parts.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
}

// ===========================================================================
// XML helpers
// ===========================================================================

/** Characters XML 1.0 cannot represent at all — dropped rather than smuggled. */
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function xmlEscape(s: string): string {
  return s
    .replace(ILLEGAL_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlUnescape(s: string): string {
  return s
    // OOXML encodes characters it cannot write literally as _xHHHH_.
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Last: an escaped ampersand must not re-enable the entities above.
    .replace(/&amp;/g, "&");
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
function colName(n: number): string {
  let s = "";
  for (let x = n + 1; x > 0; ) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = (x - 1 - r) / 26;
  }
  return s;
}

/** "AB12" -> 27 (zero-based column index). */
function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.toUpperCase().charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

// ===========================================================================
// Writing
// ===========================================================================

/** Split a value into <= XLSX_MAX_CELL pieces. Always at least one piece. */
function chunkCell(v: string): string[] {
  if (v.length <= XLSX_MAX_CELL) return [v];
  const out: string[] = [];
  for (let i = 0; i < v.length; i += XLSX_MAX_CELL) out.push(v.slice(i, i + XLSX_MAX_CELL));
  return out;
}

/**
 * Write one sheet. `rows` are positional against `headers`.
 *
 * A value too long for one Excel cell is spilled across numbered continuation
 * columns — `cookie`, `cookie2`, `cookie3` — which readXlsx rejoins. Truncating
 * instead would hand back a profile whose session silently no longer works.
 */
export async function writeXlsx(headers: string[], rows: string[][], sheetName = "Profiles"): Promise<Uint8Array> {
  const chunked = rows.map((r) => headers.map((_, i) => chunkCell(r[i] ?? "")));
  // A column is only widened as far as its widest cell in this export.
  const parts = headers.map((_, i) => Math.max(1, ...chunked.map((r) => r[i]!.length)));

  const outHeaders: string[] = [];
  for (let i = 0; i < headers.length; i++) {
    for (let p = 0; p < parts[i]!; p++) outHeaders.push(p === 0 ? headers[i]! : `${headers[i]}${p + 1}`);
  }

  const cell = (col: number, row: number, v: string) =>
    `<c r="${colName(col)}${row}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;

  const xmlRows = [
    `<row r="1">${outHeaders.map((h, i) => cell(i, 1, h)).join("")}</row>`,
    ...chunked.map((cells, ri) => {
      let col = 0;
      const out: string[] = [];
      for (let i = 0; i < headers.length; i++) {
        for (let p = 0; p < parts[i]!; p++) out.push(cell(col++, ri + 2, cells[i]![p] ?? ""));
      }
      return `<row r="${ri + 2}">${out.join("")}</row>`;
    }),
  ].join("");

  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${xmlRows}</sheetData></worksheet>`;

  return buildZip([
    {
      name: "[Content_Types].xml",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `</Types>`,
    },
    {
      name: "_rels/.rels",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
        `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `</Relationships>`,
    },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
}

// ===========================================================================
// Reading
// ===========================================================================

/** Resolve the first sheet's part name via workbook rels; fall back to sheet1. */
function firstSheetPath(workbook: string | null, rels: string | null, available: string[]): string | null {
  const rid = workbook?.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
  if (rid && rels) {
    const esc = rid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const target =
      rels.match(new RegExp(`<Relationship\\b[^>]*\\bId="${esc}"[^>]*\\bTarget="([^"]+)"`))?.[1] ??
      rels.match(new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${esc}"`))?.[1];
    if (target) {
      const full = `xl/${target.replace(/^\/+/, "").replace(/^xl\//, "")}`;
      if (available.includes(full)) return full;
    }
  }
  return available.filter((n) => n.startsWith("xl/worksheets/") && n.endsWith(".xml")).sort()[0] ?? null;
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const [, si] of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    // A shared string can be split across runs (<r><t>a</t></r><r><t>b</t></r>).
    let s = "";
    for (const [, t] of si!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += xmlUnescape(t!);
    out.push(s);
  }
  return out;
}

function cellText(type: string | undefined, body: string, shared: string[]): string {
  if (type === "inlineStr") {
    let s = "";
    for (const [, t] of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += xmlUnescape(t!);
    return s;
  }
  const v = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
  if (v == null) return "";
  if (type === "s") return shared[Number(v)] ?? "";
  return xmlUnescape(v);
}

/**
 * Read the first sheet into one object per data row, keyed by the header row.
 *
 * Excel omits empty cells entirely rather than writing them out, so a column's
 * position comes from its own `r="B7"` reference and not from its order in the
 * row — reading positionally silently shifts every value after a blank one.
 */
export async function readXlsx(bytes: Uint8Array): Promise<Record<string, string>[]> {
  const wanted = new Map<string, string>();
  const names: string[] = [];
  for await (const entry of zipEntries(bytes)) {
    names.push(entry.name);
    if (
      entry.name === "xl/workbook.xml" ||
      entry.name === "xl/_rels/workbook.xml.rels" ||
      entry.name === "xl/sharedStrings.xml" ||
      (entry.name.startsWith("xl/worksheets/") && entry.name.endsWith(".xml"))
    ) {
      wanted.set(entry.name, new TextDecoder().decode(await entry.bytes()));
    }
  }
  const sheetPath = firstSheetPath(
    wanted.get("xl/workbook.xml") ?? null,
    wanted.get("xl/_rels/workbook.xml.rels") ?? null,
    names,
  );
  const sheet = sheetPath ? wanted.get(sheetPath) : undefined;
  if (!sheet) throw new Error("not an .xlsx workbook (no worksheet found)");

  const shared = parseSharedStrings(wanted.get("xl/sharedStrings.xml") ?? "");

  const grid: string[][] = [];
  for (const [, attrs, body] of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    // Honour the row's own index so a blank row does not shift the ones below it.
    const rowIdx = Number(attrs!.match(/\br="(\d+)"/)?.[1] ?? grid.length + 1) - 1;
    const cells: string[] = [];
    let next = 0;
    for (const [, cellAttrs, selfClose, inner] of body!.matchAll(/<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = cellAttrs!.match(/\br="([A-Za-z]+\d+)"/)?.[1];
      const at = ref ? colIndex(ref) : next;
      const type = cellAttrs!.match(/\bt="([^"]+)"/)?.[1];
      cells[at] = selfClose === "/>" ? "" : cellText(type, inner ?? "", shared);
      next = at + 1;
    }
    grid[rowIdx] = cells;
  }
  const rows = grid.filter((r) => r !== undefined);
  const header = rows.shift();
  if (!header) return [];

  // Map each column to the field it belongs to, rejoining `cookie2`/`cookie3`
  // continuation columns back onto `cookie` (see writeXlsx).
  const bases = new Set(header.map((h) => (h ?? "").trim()).filter(Boolean));
  const columns = header.map((raw) => {
    const h = (raw ?? "").trim();
    const m = /^(.*?)(\d+)$/.exec(h);
    if (m && Number(m[2]) > 1 && bases.has(m[1]!)) return { key: m[1]!, part: Number(m[2]) };
    return { key: h, part: 1 };
  });

  return rows.map((cells) => {
    const acc = new Map<string, string[]>();
    columns.forEach((col, i) => {
      if (!col.key) return;
      const parts = acc.get(col.key) ?? [];
      parts[col.part - 1] = cells[i] ?? "";
      acc.set(col.key, parts);
    });
    const out: Record<string, string> = {};
    for (const [k, parts] of acc) out[k] = Array.from(parts, (p) => p ?? "").join("");
    return out;
  });
}
