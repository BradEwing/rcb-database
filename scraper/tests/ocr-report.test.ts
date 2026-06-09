import { describe, it, expect } from "vitest";
import { parseReportPage, type Word } from "../src/history/ocr-report.ts";

// Build a synthetic OCR word at a column x-center on a given visual line. Only
// text / cx / line drive the parser; the rest mirror what tesseract.js emits.
function w(text: string, cx: number, line: number): Word {
  return { text, x: cx - 10, y: line * 30, w: 20, h: 20, cx, cy: line * 30 + 10, conf: 95, line };
}

// Assemble a page from rows of [text, cx] pairs, one array per visual line.
function page(rows: Array<Array<[string, number]>>): Word[] {
  return rows.flatMap((cells, line) => cells.map(([t, cx]) => w(t, cx, line)));
}

describe("parseReportPage", () => {
  it("parses the newer layout (date before MAR; $ GA; N/E)", () => {
    const words = page([
      [["Established", 1049], ["GA", 1700]], // header band (no section yet)
      [["Site", 140], ["Address:", 270], ["854", 404], ["9TH", 490], ["ST", 564], ["Infor", 1291], ["ID:", 1377], ["14024", 1478], ["Parcel", 2110], ["#:", 2198], ["4281032011", 2345]],
      [["854", 136], ["9TH", 217], ["ST", 288], ["1", 330], ["11/20/2000", 1043], ["$2,750", 1437], ["$67", 1845], ["$2,817", 2259]],
      [["854", 136], ["9TH", 217], ["ST", 288], ["3", 333], ["07/31/2022", 1042], ["$3,050", 1437], ["N/E", 1845], ["$3,050", 2259]],
    ]);
    const res = parseReportPage(words, "2023");
    expect(res).not.toBeNull();
    expect(res!.records).toHaveLength(2);
    const u1 = res!.records[0]!;
    expect(u1).toMatchObject({
      parcel: "4281032011",
      infor_id: "14024",
      unit_id: "854-9th-st-1",
      market_rate_established: "2000-11-20",
      mar_cents: "275000",
      ga_cents: "6700",
      new_mar_cents: "281700",
    });
    // N/E GA → empty ga_cents; new == current.
    expect(res!.records[1]).toMatchObject({ ga_cents: "", mar_cents: "305000", new_mar_cents: "305000" });
  });

  it("parses the older layout (% GA, 2-digit date after MAR, bare-number unit)", () => {
    const words = page([
      [["Established", 1400]],
      [["SITE", 120], ["ADDRESS:", 260], ["1164", 420], ["BERKELEY", 600], ["ST", 760], ["RENT", 1600], ["CONTROL", 1760], ["ID#:", 1900], ["4266001050", 2100]],
      // Unit "A" | $1721 (MAR) | 06/01/03 (date, AFTER mar) | 2.9% (GA pct) | $1771 (new)
      [["A", 150], ["$1721", 700], ["06/01/03", 1100], ["2.9%", 1500], ["$1771", 1900]],
    ]);
    const res = parseReportPage(words, "2018");
    expect(res).not.toBeNull();
    expect(res!.records).toHaveLength(1);
    expect(res!.records[0]).toMatchObject({
      parcel: "4266001050",
      unit_label_raw: "A",
      market_rate_established: "2003-06-01", // 2-digit year → 2003
      mar_cents: "172100",
      ga_cents: "", // percentage GA → not a cents value
      new_mar_cents: "177100",
    });
  });

  it("returns null when there is no section header (cover-letter page)", () => {
    const words = page([
      [["Report", 100], ["of", 200], ["Maximum", 300], ["Allowable", 450], ["Rents", 600]],
      [["Dear", 100], ["Owner", 200]],
    ]);
    expect(parseReportPage(words, "2020")).toBeNull();
  });

  it("reads the report year from the September header, overriding the fallback", () => {
    const words = page([
      [["September", 2209], ["1,", 2336], ["2024", 2407]],
      [["Site", 140], ["Address:", 270], ["100", 404], ["MAIN", 490], ["ST", 564], ["Parcel", 2110], ["#:", 2198], ["4200000001", 2345]],
      [["100", 136], ["MAIN", 240], ["ST", 320], ["1", 380], ["$1,000", 1437], ["$30", 1845], ["$1,030", 2259]],
    ]);
    const res = parseReportPage(words, "1999");
    expect(res!.records[0]!.report_year).toBe("2024");
  });
});
