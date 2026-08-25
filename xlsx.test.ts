import { test, expect } from "bun:test";
import { writeXlsx, readXlsx, XLSX_MAX_CELL } from "./xlsx.ts";

test("writeXlsx emits a real zip container", async () => {
  const bytes = await writeXlsx(["id"], [["k1"]]);
  expect(bytes[0]).toBe(0x50); // "P"
  expect(bytes[1]).toBe(0x4b); // "K"
});

test("round-trips headers and rows keyed by header", async () => {
  const bytes = await writeXlsx(
    ["id", "name", "proxy"],
    [
      ["k1d0cd11", "sophiaskye852", "5.249.176.244:5432:user:pass"],
      ["k2xxxx", "otheracct", ""],
    ],
  );
  expect(await readXlsx(bytes)).toEqual([
    { id: "k1d0cd11", name: "sophiaskye852", proxy: "5.249.176.244:5432:user:pass" },
    { id: "k2xxxx", name: "otheracct", proxy: "" },
  ]);
});

test("escapes XML metacharacters instead of corrupting the sheet", async () => {
  const nasty = `a&b <c> "d" 'e'`;
  const rows = await readXlsx(await writeXlsx(["v"], [[nasty]]));
  expect(rows[0]!.v).toBe(nasty);
});

test("preserves newlines and tabs inside a cell", async () => {
  const v = "line1\nline2\tend";
  const rows = await readXlsx(await writeXlsx(["v"], [[v]]));
  expect(rows[0]!.v).toBe(v);
});

test("preserves non-ASCII text", async () => {
  const v = "Ünïcøde — 日本語 — emoji 🎉";
  const rows = await readXlsx(await writeXlsx(["v"], [[v]]));
  expect(rows[0]!.v).toBe(v);
});

test("a header-only sheet reads back as no rows", async () => {
  expect(await readXlsx(await writeXlsx(["id", "name"], []))).toEqual([]);
});

test("spills an oversized cell into continuation columns and rejoins it on read", async () => {
  const huge = "x".repeat(XLSX_MAX_CELL * 2 + 5);
  const rows = await readXlsx(await writeXlsx(["id", "cookie"], [["k1", huge]]));
  expect(rows[0]!.cookie).toBe(huge);
  expect(rows[0]!.id).toBe("k1");
});

test("no cell in a written sheet exceeds Excel's per-cell limit", async () => {
  const bytes = await writeXlsx(["cookie"], [["y".repeat(XLSX_MAX_CELL + 1)]]);
  const sheet = await sheetXml(bytes);
  for (const [, text] of sheet.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) {
    expect(text!.length).toBeLessThanOrEqual(XLSX_MAX_CELL);
  }
});

test("reads a sheet that stores cells in sharedStrings, as Excel re-saves them", async () => {
  const bytes = await sharedStringsWorkbook(
    ["id", "name"],
    [["k1", "alice"], ["k2", "bob"]],
  );
  expect(await readXlsx(bytes)).toEqual([
    { id: "k1", name: "alice" },
    { id: "k2", name: "bob" },
  ]);
});

test("rejects bytes that are not a workbook", async () => {
  expect(readXlsx(new TextEncoder().encode("id,name\nk1,alice\n"))).rejects.toThrow();
});

// ---- helpers ---------------------------------------------------------------

/** Pull xl/worksheets/sheet1.xml back out of a written workbook. */
async function sheetXml(bytes: Uint8Array): Promise<string> {
  const { zipEntries } = await import("./unzip.ts");
  for await (const e of zipEntries(bytes)) {
    if (e.name === "xl/worksheets/sheet1.xml") return new TextDecoder().decode(await e.bytes());
  }
  throw new Error("sheet1.xml missing");
}

/**
 * Build a workbook the way Excel does — cells as `t="s"` indexes into
 * xl/sharedStrings.xml — so the reader is exercised against a real saved file's
 * shape, not only against our own inline-string writer.
 */
async function sharedStringsWorkbook(headers: string[], rows: string[][]): Promise<Uint8Array> {
  const table: string[] = [];
  const idx = (s: string) => {
    const at = table.indexOf(s);
    return at === -1 ? table.push(s) - 1 : at;
  };
  const col = (n: number) => {
    let s = "";
    for (let x = n + 1; x > 0; ) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = (x - 1 - r) / 26; }
    return s;
  };
  const body = [headers, ...rows]
    .map((cells, r) =>
      `<row r="${r + 1}">` +
      cells.map((c, i) => `<c r="${col(i)}${r + 1}" t="s"><v>${idx(c)}</v></c>`).join("") +
      `</row>`)
    .join("");
  const { buildZip } = await import("./xlsx.ts");
  return buildZip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Profiles" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>` },
    { name: "xl/sharedStrings.xml", data: `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${table.length}" uniqueCount="${table.length}">${table.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>` },
    { name: "xl/worksheets/sheet1.xml", data: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>` },
  ]);
}
