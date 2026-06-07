import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { z } from "zod";

const GV_ADDRESSES_ID = "ctl00_mainContent_gvAddresses";
const GV_MAR_DATA_ID = "ctl00_mainContent_gvMarData";
const MSG_LABEL_ID = "ctl00_mainContent_lblMsg";

const GridRowSchema = z.record(z.string(), z.string());
const GridSchema = z.object({
  headers: z.array(z.string()),
  rows: z.array(GridRowSchema),
});

export type GridTable = z.infer<typeof GridSchema>;

export type MarPage = {
  message: string;
  addresses: GridTable | null;
  marData: GridTable | null;
};

export function parseMarPage(html: string): MarPage {
  const $ = cheerio.load(html);
  const message = $(`#${MSG_LABEL_ID}`).text().trim();
  const addresses = parseGridById($, GV_ADDRESSES_ID);
  const marData = parseGridById($, GV_MAR_DATA_ID);
  return { message, addresses, marData };
}

function parseGridById(
  $: cheerio.CheerioAPI,
  id: string,
): GridTable | null {
  const table = $(`#${id}`);
  if (table.length === 0) return null;

  const rows = table.find("tr").toArray();
  if (rows.length === 0) return null;

  const headerCells = $(rows[0]).find("th").toArray();
  if (headerCells.length === 0) {
    // No header row → grid is empty or uses td-only header. Try first row as header anyway.
    const tdHeaders = $(rows[0]).find("td").toArray();
    if (tdHeaders.length === 0) return null;
    const headers = tdHeaders.map((c) =>
      normalizeHeader($(c).text()),
    );
    return GridSchema.parse({ headers, rows: parseDataRows($, rows.slice(1), headers) });
  }

  const headers = headerCells.map((c) => normalizeHeader($(c).text()));
  return GridSchema.parse({
    headers,
    rows: parseDataRows($, rows.slice(1), headers),
  });
}

function parseDataRows(
  $: cheerio.CheerioAPI,
  rowEls: AnyNode[],
  headers: string[],
): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const rowEl of rowEls) {
    const cells = $(rowEl).find("td").toArray();
    if (cells.length === 0) continue;
    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i];
      if (header === undefined) continue;
      const cell = cells[i];
      row[header] = cell ? $(cell).text().trim().replace(/\s+/g, " ") : "";
    }
    out.push(row);
  }
  return out;
}

function normalizeHeader(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
