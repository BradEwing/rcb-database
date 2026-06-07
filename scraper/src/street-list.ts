import { request } from "undici";
import * as cheerio from "cheerio";
import { logger } from "./logger.ts";

const STREET_LIST_URL =
  "https://www.smgov.net/WorkArea/linkit.aspx?LinkIdentifier=id&ItemID=44652";

const USER_AGENT =
  "rcb-database/0.0 (Santa Monica MAR registry; bradleywewing@gmail.com)";

const STREET_SUFFIX = new Set([
  "ST",
  "AVE",
  "BLVD",
  "RD",
  "DR",
  "WAY",
  "PL",
  "LN",
  "CT",
  "TER",
  "TRL",
  "PKWY",
  "CIR",
  "ALY",
  "WALK",
  "LANE",
  "ROAD",
  "PROMENADE",
  "FRONT",
  "MALL",
  "PARK",
  "HWY",
]);

// Streets the city lists without a type suffix. Extend as new ones surface.
const SUFFIXLESS_STREETS = new Set(["BROADWAY"]);

export async function fetchStreetListHtml(): Promise<string> {
  const res = await request(STREET_LIST_URL, {
    method: "GET",
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    maxRedirections: 5,
  });
  if (res.statusCode !== 200) {
    throw new Error(`street list GET failed: HTTP ${res.statusCode}`);
  }
  return res.body.text();
}

export function parseStreetList(html: string): string[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const out: string[] = [];

  // The published list lays street names out in <td> cells, one per cell.
  // Interspersed cells contain single-letter alphabetical anchors (A, B, ...)
  // which we filter by length + suffix.
  $("td").each((_, el) => {
    const raw = $(el).text().trim();
    const normalized = canonicalize(raw);
    if (!normalized) return;
    if (seen.has(normalized.toUpperCase())) return;
    seen.add(normalized.toUpperCase());
    out.push(normalized);
  });

  logger.info({ count: out.length }, "street-list.parsed");
  return out;
}

function canonicalize(raw: string): string | null {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length < 3) return null;
  // Source spells ordinal streets like "2nd ST", "10th CT" (mixed case);
  // everything else is uppercase. Skip cells with arbitrary punctuation.
  if (!/^[A-Za-z0-9 ]+$/.test(cleaned)) return null;

  const parts = cleaned.split(" ");
  const suffix = parts.at(-1)?.toUpperCase().replace(/\.$/, "");
  if (!suffix) return null;

  if (SUFFIXLESS_STREETS.has(cleaned.toUpperCase())) {
    return parts.map(prettyToken).join(" ");
  }
  if (!STREET_SUFFIX.has(suffix)) return null;

  // Convert suffix to MAR-form spelling (mixed case, no trailing period).
  // Examples from the form: "Lincoln Blvd", "10th St", "Colorado Ave".
  const head = parts.slice(0, -1).join(" ");
  const headPretty = head
    .split(" ")
    .map(prettyToken)
    .join(" ");
  return `${headPretty} ${pretty(suffix)}`;
}

function pretty(suffix: string): string {
  // Title-case the suffix (St, Ave, Blvd, etc.).
  return suffix.charAt(0) + suffix.slice(1).toLowerCase();
}

function prettyToken(token: string): string {
  // Preserve ordinals like 10TH → 10th; otherwise title-case.
  if (/^\d+(ST|ND|RD|TH)$/i.test(token)) return token.toLowerCase();
  if (/^\d/.test(token)) return token.toLowerCase();
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}
