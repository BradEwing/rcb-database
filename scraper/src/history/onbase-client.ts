import { request } from "undici";
import { logger } from "../logger.ts";

const BASE = "https://rentcontroldocs.santamonica.gov/Client24/api";

const USER_AGENT =
  "rcb-database/0.0 (Santa Monica MAR registry; bradleywewing@gmail.com; https://github.com/)";

// The portal is a heavier backend than mar.aspx and sits behind Imperva/Incapsula.
// Treat 429/503 as an explicit "slow down" and back off (honoring Retry-After);
// treat an Incapsula challenge (a 403, or HTML where we expect JSON) the same way
// but more cautiously — it means the WAF noticed us, so we wait longer and let the
// warmed cookie ride. We never try to *defeat* the challenge.
const THROTTLE_STATUSES = new Set([429, 503]);
const MAX_RETRIES = 4;
const THROTTLE_BASE_MS = 2_000;
const WAF_BASE_MS = 15_000;

export type Keyword = { id: number; value: string; Operator?: number };

export type SearchColumn = { Heading: string; DataType: string };
export type SearchCell = { Value: string; RawValue: string | null };
export type SearchDoc = {
  ID: string;
  Name: string;
  DisplayType: string;
  DisplayColumnValues: SearchCell[];
};
export type SearchResult = {
  Data: SearchDoc[];
  DisplayColumns: SearchColumn[];
  Truncated: boolean;
};

/** Thrown when the WAF challenges us (403 or non-JSON body) so callers can decide to stop. */
export class WafChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WafChallengeError";
  }
}

export type OnBaseClientOptions = {
  /** Minimum delay between HTTP requests, in ms. Default 400 (polite; heavier backend). */
  minDelayMs?: number;
};

/**
 * Client for the Rent Control document portal's OnBase Public Access (OBPA) REST
 * API. Unlike the MAR WebForms page this is plain anonymous JSON — no ViewState —
 * but it sits behind Incapsula, so we (a) warm a cookie jar once with a cheap GET
 * and replay any `set-cookie` (Incapsula `visid`/`incap_ses`), and (b) back off
 * hard if the WAF ever starts challenging. One rate-limited request per call.
 */
export class OnBaseClient {
  private lastRequestAt = 0;
  private cookies = "";
  private warmed = false;
  private readonly minDelayMs: number;

  public searches = 0;
  public fetches = 0;
  public throttles = 0;
  public wafWaits = 0;

  constructor(opts: OnBaseClientOptions = {}) {
    this.minDelayMs = opts.minDelayMs ?? 400;
  }

  /** Warm the Incapsula cookie jar with a cheap real call (the query catalogue). */
  private async warm(): Promise<void> {
    if (this.warmed) return;
    const res = await this.rawRequest(`${BASE}/CustomQuery`, {
      method: "GET",
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    });
    this.captureCookies(res.headers["set-cookie"]);
    await res.body.dump();
    this.warmed = true;
  }

  /**
   * POST a KeywordSearch against a custom query (125 = parcel, 128 = address).
   * Returns the parsed JSON. `QueryLimit: 0` = no limit (one parcel's full doc set
   * comes back in a single response).
   */
  async keywordSearch(
    queryId: string,
    keywords: Keyword[],
    opts: { fromDate?: string | null; toDate?: string | null } = {},
  ): Promise<SearchResult> {
    await this.warm();
    const body = JSON.stringify({
      QueryID: queryId,
      Keywords: keywords.map((k) => ({
        id: k.id,
        value: k.value,
        Operator: k.Operator ?? 0,
      })),
      FromDate: opts.fromDate ?? null,
      ToDate: opts.toDate ?? null,
      QueryLimit: 0,
    });
    const json = await this.requestJson(`${BASE}/CustomQuery/KeywordSearch`, {
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
        "content-type": "application/json",
        cookie: this.cookies,
      },
      body,
    });
    this.searches++;
    return json as SearchResult;
  }

  /**
   * Fetch a document as PDF. `id` is the opaque/encrypted token from a search
   * result's `ID` field (URL-encoded here). ViewerMode: PDF=0, Native=1.
   */
  async fetchDocument(id: string, viewerMode: "PDF" | "Native" = "PDF"): Promise<Buffer> {
    await this.warm();
    const url = `${BASE}/Document/${encodeURIComponent(id)}/?ViewerMode=${viewerMode}`;
    const res = await this.rateLimitedRequest(url, {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/pdf",
        cookie: this.cookies,
      },
    });
    this.captureCookies(res.headers["set-cookie"]);
    const contentType = String(res.headers["content-type"] ?? "");
    if (res.statusCode !== 200) {
      await res.body.dump();
      throw new Error(`Document fetch failed: HTTP ${res.statusCode}`);
    }
    const buf = Buffer.from(await res.body.arrayBuffer());
    if (!contentType.includes("pdf") && buf.subarray(0, 4).toString("latin1") !== "%PDF") {
      throw new WafChallengeError(
        `Document fetch returned non-PDF (${contentType}, ${buf.length}B) — possible WAF challenge`,
      );
    }
    this.fetches++;
    return buf;
  }

  /** Rate-limited JSON request with throttle + WAF back-off; returns parsed JSON. */
  private async requestJson(
    url: string,
    opts: Parameters<typeof request>[1],
  ): Promise<unknown> {
    const res = await this.rateLimitedRequest(url, opts);
    this.captureCookies(res.headers["set-cookie"]);
    const contentType = String(res.headers["content-type"] ?? "");
    const text = await res.body.text();
    if (res.statusCode !== 200) {
      throw new Error(`${opts?.method} ${url} → HTTP ${res.statusCode}`);
    }
    if (!contentType.includes("json")) {
      // HTML where we expected JSON = Incapsula challenge page.
      throw new WafChallengeError(
        `${url} returned ${contentType} not JSON — WAF challenge (${text.length}B)`,
      );
    }
    return JSON.parse(text);
  }

  /**
   * Issue a request, backing off and retrying on 429/503 (honoring Retry-After)
   * and on a 403 WAF challenge (longer wait). Returns the final response; the
   * caller reads/drains the body.
   */
  private async rateLimitedRequest(
    url: string,
    opts: Parameters<typeof request>[1],
  ): Promise<Awaited<ReturnType<typeof request>>> {
    for (let attempt = 1; ; attempt++) {
      await this.respectRateLimit();
      const res = await this.rawRequest(url, opts);
      const isThrottle = THROTTLE_STATUSES.has(res.statusCode);
      const isWaf = res.statusCode === 403;
      if ((!isThrottle && !isWaf) || attempt > MAX_RETRIES) return res;

      const retryAfter = Number(res.headers["retry-after"]);
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1_000
          : (isWaf ? WAF_BASE_MS : THROTTLE_BASE_MS) * 2 ** (attempt - 1);
      await res.body.dump();
      if (isWaf) this.wafWaits++;
      else this.throttles++;
      logger.warn({ status: res.statusCode, attempt, waitMs, url }, "onbase.throttled");
      await sleep(waitMs);
    }
  }

  private async rawRequest(
    url: string,
    opts: Parameters<typeof request>[1],
  ): Promise<Awaited<ReturnType<typeof request>>> {
    return request(url, { ...opts, maxRedirections: 0 });
  }

  private captureCookies(setCookie: string | string[] | undefined): void {
    if (!setCookie) return;
    const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
    const jar = new Map<string, string>();
    for (const pair of this.cookies.split(";").map((s) => s.trim()).filter(Boolean)) {
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
    }
    for (const h of headers) {
      const first = h.split(";", 1)[0] ?? "";
      const eq = first.indexOf("=");
      if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1));
    }
    this.cookies = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private async respectRateLimit(): Promise<void> {
    const since = Date.now() - this.lastRequestAt;
    if (since < this.minDelayMs) await sleep(this.minDelayMs - since);
    this.lastRequestAt = Date.now();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Map a search doc's DisplayColumnValues onto its DisplayColumns headings. */
export function rowByHeading(
  doc: SearchDoc,
  columns: SearchColumn[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < columns.length; i++) {
    const heading = columns[i]?.Heading ?? String(i);
    out[heading] = (doc.DisplayColumnValues[i]?.Value ?? "").trim();
  }
  return out;
}
