import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs"; // execFileSync: pdftoppm rasterization
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorker, type Worker } from "tesseract.js";
import { slug } from "../normalize.ts";

/**
 * OCR + template parse of an annual MAR report (the golden per-unit grid). The
 * report layout is rigid in *content* but its column ORDER is not stable across
 * years (the "Market Rate Established" date column floats between position 2 and
 * 3, while the numbered columns 1/2/3 — current MAR, GA, new MAR — stay in
 * order). So we extract by word geometry (Tesseract word bounding boxes) and bin
 * each cell to a column x-range derived from the page's own header, rather than
 * trusting a fixed column order.
 *
 * The OCR engine is tesseract.js (the Tesseract engine compiled to WASM) so the
 * backfill stays Node-only and self-hosted — no system binary to install. Pages
 * are rasterized with poppler's `pdftoppm` (already a repo dependency for the map
 * geometry step). Create one worker and reuse it across every page/document.
 */

const PDFTOPPM = process.env.PDFTOPPM_BIN ?? "/opt/homebrew/bin/pdftoppm";
const RENDER_DPI = 300;
const PSM_SINGLE_BLOCK = "6";
// tesseract.js caches its ~5MB English model. Keep it under data/raw/ (already
// gitignored) so it never pollutes the repo or re-downloads every run.
const OCR_CACHE_DIR = new URL("../../../data/raw/ocr-cache/", import.meta.url).pathname;

export type Word = {
  text: string;
  x: number; // left
  y: number; // top
  w: number;
  h: number;
  cx: number; // center x
  cy: number; // center y
  conf: number;
  line: number; // synthesized line index (grouped by y)
};

export type UnitRecord = {
  parcel: string;
  infor_id: string;
  unit_id: string;
  unit_label_raw: string;
  report_year: string;
  market_rate_established: string; // ISO yyyy-mm-dd or ""
  mar_cents: string;
  ga_cents: string; // "" when N/E
  new_mar_cents: string;
};

export type ParseResult = {
  records: UnitRecord[];
  /** Diagnostics for the fail-loud QA gate. */
  warnings: string[];
};

/** Render every page of a PDF to PNG at RENDER_DPI; returns image paths in order. */
export function renderPages(pdfPath: string): { dir: string; pages: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "marocr-"));
  execFileSync(PDFTOPPM, ["-png", "-r", String(RENDER_DPI), pdfPath, join(dir, "p")]);
  const pages = readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .sort();
  return { dir, pages: pages.map((p) => join(dir, p)) };
}

/** Create a reusable OCR worker (loads the WASM engine + English data once). */
export async function createOcrWorker(): Promise<Worker> {
  const worker = await createWorker("eng", undefined, {
    cachePath: OCR_CACHE_DIR,
  });
  await worker.setParameters({ tessedit_pageseg_mode: PSM_SINGLE_BLOCK as never });
  return worker;
}

/** OCR an image to word boxes via tesseract.js. */
export async function ocrWords(worker: Worker, imagePath: string): Promise<Word[]> {
  const { data } = await worker.recognize(imagePath, {}, { blocks: true });
  const flat =
    data.words && data.words.length > 0
      ? data.words
      : (data.blocks ?? []).flatMap((b) =>
          (b.paragraphs ?? []).flatMap((p) => (p.lines ?? []).flatMap((l) => l.words ?? [])),
        );
  const words: Word[] = [];
  for (const wd of flat) {
    const text = (wd.text ?? "").trim();
    if (text === "") continue;
    const { x0, y0, x1, y1 } = wd.bbox;
    const x = x0;
    const y = y0;
    const w = x1 - x0;
    const h = y1 - y0;
    words.push({ text, x, y, w, h, cx: x + w / 2, cy: y + h / 2, conf: wd.confidence, line: 0 });
  }
  return assignLines(words);
}

/** Group words into visual rows by y-proximity; sets `line` and returns sorted words. */
export function assignLines(words: Word[]): Word[] {
  const sorted = [...words].sort((a, b) => a.cy - b.cy);
  let line = 0;
  let lastCy = -Infinity;
  for (const w of sorted) {
    // A new line when the vertical gap exceeds ~60% of the word height.
    if (w.cy - lastCy > w.h * 0.6) line++;
    w.line = line;
    lastCy = w.cy;
  }
  return sorted;
}

export function groupByLine(words: Word[]): Word[][] {
  const byLine = new Map<number, Word[]>();
  for (const w of words) {
    const arr = byLine.get(w.line) ?? [];
    arr.push(w);
    byLine.set(w.line, arr);
  }
  return [...byLine.keys()]
    .sort((a, b) => a - b)
    .map((k) => byLine.get(k)!.sort((a, b) => a.cx - b.cx));
}

function lineText(line: Word[]): string {
  return line.map((w) => w.text).join(" ");
}

// A *value* dollar must carry the "$" sign. This is the key disambiguator: unit
// labels are often bare numbers ("933", "1") that would otherwise look like money;
// the MAR / GA / New-MAR cells always print a "$". Allows a stray trailing token
// like "$2,817" but not "$67)" from a header subtitle.
const DOLLAR_RE = /^\$[\d,]+(?:\.\d{2})?\.?$/;
const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;

function moneyToCents(text: string): string {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (cleaned === "") return "";
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n)) return "";
  return String(Math.round(n * 100));
}

function isoDate(text: string): string {
  const m = text.match(DATE_RE);
  if (!m) return "";
  let year = m[3]!;
  if (year.length === 2) {
    // Tenancy dates are historical (≈1979–today). 2-digit yy ≤ 30 → 20yy else 19yy.
    const yy = Number(year);
    year = yy <= 30 ? `20${year.padStart(2, "0")}` : `19${year}`;
  }
  return `${year}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

/**
 * Parse one OCR'd report page into per-unit records. Returns null if the page is
 * not a unit grid (e.g. a cover-letter-only page). Columns are located from the
 * header; cells are binned by x-position.
 */
export function parseReportPage(
  words: Word[],
  fallbackYear: string,
): ParseResult | null {
  const lines = groupByLine(words);
  const warnings: string[] = [];

  // The page is a grid when it carries a per-parcel section header ("Site Address
  // / Parcel # / Rent Control ID#"). Cover-letter pages never do, so this alone is
  // a reliable gate. (We deliberately do NOT require the "Market Rate Established"
  // column header — the 2024+ template garbles/renames it, but those pages are
  // still valid grids with intact section headers and $-rows.)
  const hasSection = lines.some((l) =>
    /parcel\s*#|rent\s*control\s*id|control\s*id#|site\s+address/i.test(lineText(l)),
  );
  if (!hasSection) return null;

  // Year: prefer a "September 1, <yyyy>" / "September <yyyy>" / "9/1/<yy>" in the
  // header band; fall back to the document's metadata year.
  let reportYear = fallbackYear;
  for (const l of lines) {
    const t = lineText(l);
    const m =
      t.match(/September\s+1,?\s+(\d{4})/i) ||
      t.match(/September\s+(\d{4})\s+General/i) ||
      t.match(/9\/1\/(\d{2,4})/);
    if (m) {
      const y = m[1]!;
      reportYear = y.length === 2 ? `20${y}` : y;
      break;
    }
  }

  const records: UnitRecord[] = [];
  let curParcel = "";
  let curInfor = "";

  for (const line of lines) {
    const text = lineText(line);

    // Section header → switch parcel context. Templates vary: newer reports label
    // the APN "Parcel #:", older ones "RENT CONTROL ID#:"; both carry the bare
    // 10-digit APN, and both line types also say "SITE ADDRESS". So a section line
    // is any with those markers, and the parcel is the line's 10-digit run (the
    // Infor ID, when present, is shorter and separately labelled). The unit row's
    // label is kept verbatim (unit_label_raw); resolving it to a registry unit_id
    // happens downstream against units.csv keyed by APN (the OCR'd site-address
    // header text is too noisy — "9TH" reads as "09" — to rebuild ids from).
    if (/site\s+address|parcel\s*#|rent\s*control\s*id|control\s*id#/i.test(text)) {
      const apnM = text.match(/\b(\d{10})\b/);
      const inforM = text.match(/infor\s*id:?\s*(\d+)/i);
      if (apnM) curParcel = apnM[1]!;
      curInfor = inforM ? inforM[1]! : "";
      continue;
    }

    // Value cells: the $-tagged tokens, left-to-right. The numbered columns are
    // always [current MAR, GA, new MAR] in order, and MAR/New always print a "$";
    // the GA between them may be a "$" (newer), a "%" (older), or "N/E". So the
    // leftmost $ is the current MAR and the rightmost $ is the new MAR regardless
    // of where the floating date column sits. GA is the middle $ when present.
    const dollars = line.filter((w) => DOLLAR_RE.test(w.text)).sort((a, b) => a.cx - b.cx);
    if (dollars.length < 2) {
      // A real unit row always shows ≥2 $-cells (current + new MAR). Zero-dollar
      // lines are cover-letter prose (1-page reports carry the letter above the
      // grid) and must not warn; a lone $-cell is a genuinely broken row → flag it.
      if (dollars.length === 1) warnings.push(`unparsed row (dollars=1): ${text}`);
      continue;
    }
    const marW = dollars[0]!;
    const newW = dollars[dollars.length - 1]!;
    const ga = dollars.length >= 3 ? moneyToCents(dollars[1]!.text) : "";

    // Date (Market Rate Established), wherever it sits.
    const dateW = line.find((w) => DATE_RE.test(w.text));

    // Unit id = tokens left of the current-MAR cell that aren't the date or a $.
    const unitWords = line
      .filter((w) => w.cx < marW.cx && w !== dateW && !DOLLAR_RE.test(w.text))
      .sort((a, b) => a.cx - b.cx);
    const unitRaw = unitWords
      .map((w) => w.text)
      .join(" ")
      .replace(/\s+-\s*$/, "") // drop a trailing dash artifact ("- 933")
      .replace(/^-\s*/, "")
      .trim();
    if (unitRaw === "") continue;

    // Provisional id = slug of the raw label; the authoritative registry unit_id
    // is resolved downstream from (parcel APN, unit_label_raw) against units.csv.
    records.push({
      parcel: curParcel,
      infor_id: curInfor,
      unit_id: slug(unitRaw),
      unit_label_raw: unitRaw,
      report_year: reportYear,
      market_rate_established: dateW ? isoDate(dateW.text) : "",
      mar_cents: moneyToCents(marW!.text),
      ga_cents: ga,
      new_mar_cents: moneyToCents(newW!.text),
    });
  }

  if (records.length === 0) warnings.push("grid detected but no unit rows parsed");
  return { records, warnings };
}

/** Full pipeline for one PDF: render, OCR each page, parse the grid page(s). */
export async function ocrReport(
  worker: Worker,
  pdfPath: string,
  fallbackYear: string,
): Promise<ParseResult> {
  const { dir, pages } = renderPages(pdfPath);
  try {
    const all: UnitRecord[] = [];
    const warnings: string[] = [];
    let gridFound = false;
    for (const img of pages) {
      const words = await ocrWords(worker, img);
      const parsed = parseReportPage(words, fallbackYear);
      if (!parsed) continue;
      gridFound = true;
      all.push(...parsed.records);
      warnings.push(...parsed.warnings);
    }
    if (!gridFound) warnings.push("no grid page found in document");
    return { records: all, warnings };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
