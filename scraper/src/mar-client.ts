import { request } from "undici";
import * as cheerio from "cheerio";
import { logger } from "./logger.ts";

const MAR_URL = "https://www.smgov.net/departments/rentcontrol/mar.aspx";

const USER_AGENT =
  "rcb-database/0.0 (Santa Monica MAR registry; bradleywewing@gmail.com; https://github.com/)";

// On a 429/503 the server is telling us to slow down. Back off (honoring
// Retry-After when present) and retry a few times before giving up. This is the
// safety valve that makes bounded concurrency a good citizen even though the
// city publishes no rate limit.
const THROTTLE_STATUSES = new Set([429, 503]);
const MAX_THROTTLE_RETRIES = 4;
const THROTTLE_BASE_MS = 2_000;

type HiddenFields = {
  __VIEWSTATE: string;
  __VIEWSTATEGENERATOR: string;
  __EVENTVALIDATION: string;
  EktronClientManager: string;
};

export type MarQueryResult = {
  query: { streetNumber: string; streetName: string };
  html: string;
  fetchedAt: string;
};

export type MarClientOptions = {
  /** Minimum delay between HTTP requests, in ms. Default 5000 (polite). */
  minDelayMs?: number;
};

type Session = {
  hidden: HiddenFields;
  cookies: string;
};

/**
 * Client for the City's MAR WebForms page.
 *
 * The form is one ASP.NET page that posts back to itself. Every POST must
 * replay the `__VIEWSTATE`/`__EVENTVALIDATION`/`EktronClientManager` token
 * triplet. A postback *response* carries a fresh triplet, so we GET the form
 * once to seed a session, then chain POSTs — harvesting the next token set from
 * each response — to spend only one rate-limited request per query in steady
 * state. If a postback ever comes back without a replayable token set (rotation
 * or expiry), we transparently re-seed with a fresh GET and retry once, so
 * correctness never depends on the optimization holding.
 */
export class MarClient {
  private lastRequestAt = 0;
  private session: Session | null = null;
  private readonly minDelayMs: number;

  /** Observability: successful POSTs, fresh GET seeds, error-triggered retries, throttle waits. */
  public posts = 0;
  public seeds = 0;
  public reGets = 0;
  public throttles = 0;

  constructor(opts: MarClientOptions = {}) {
    this.minDelayMs = opts.minDelayMs ?? 5_000;
  }

  async query(streetNumber: string, streetName: string): Promise<MarQueryResult> {
    if (!this.session) await this.seedSession();
    try {
      return await this.postQuery(streetNumber, streetName);
    } catch (err) {
      // POST failed (non-200, network, or rejected tokens). Re-seed once and
      // retry; if this throws too, it bubbles to the caller as a real failure.
      this.reGets++;
      logger.debug(
        { streetNumber, streetName, err: (err as Error).message },
        "mar.session.reseed",
      );
      this.session = null;
      await this.seedSession();
      return await this.postQuery(streetNumber, streetName);
    }
  }

  /** Fetch the empty form to harvest a fresh token triplet + cookies. */
  private async seedSession(): Promise<void> {
    const getRes = await this.rateLimitedRequest({
      method: "GET",
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
      maxRedirections: 5,
    });
    if (getRes.statusCode !== 200) {
      throw new Error(`MAR GET failed: HTTP ${getRes.statusCode}`);
    }
    const getBody = await getRes.body.text();
    this.session = {
      hidden: extractHiddenFields(getBody),
      cookies: collectCookies(getRes.headers["set-cookie"]),
    };
    this.seeds++;
  }

  private async postQuery(
    streetNumber: string,
    streetName: string,
  ): Promise<MarQueryResult> {
    const session = this.session;
    if (!session) throw new Error("postQuery called without a session");

    const form = new URLSearchParams();
    form.set("EktronClientManager", session.hidden.EktronClientManager);
    form.set("__VIEWSTATE", session.hidden.__VIEWSTATE);
    form.set("__VIEWSTATEGENERATOR", session.hidden.__VIEWSTATEGENERATOR);
    form.set("__EVENTVALIDATION", session.hidden.__EVENTVALIDATION);
    form.set("ctl00$mainContent$txtStNumber", streetNumber);
    form.set("ctl00$mainContent$txtStreet", streetName);
    form.set("ctl00$mainContent$btnSearch", "Search");

    const postRes = await this.rateLimitedRequest({
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: session.cookies,
        referer: MAR_URL,
      },
      body: form.toString(),
    });
    if (postRes.statusCode !== 200) {
      throw new Error(
        `MAR POST failed for ${streetNumber || "(blank)"} ${streetName}: HTTP ${postRes.statusCode}`,
      );
    }
    const html = await postRes.body.text();
    this.posts++;

    // Harvest the next token set + updated cookies from this postback for the
    // following query. If the response isn't a replayable form, drop the session
    // so the next query re-seeds — the current result is still valid below.
    try {
      this.session = {
        hidden: extractHiddenFields(html),
        cookies: mergeCookies(session.cookies, postRes.headers["set-cookie"]),
      };
    } catch {
      this.session = null;
    }

    logger.debug(
      { streetNumber, streetName, bytes: html.length },
      "mar.query.ok",
    );
    return {
      query: { streetNumber, streetName },
      html,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * Rate-limited request to the MAR page that backs off and retries on a
   * 429/503 (honoring Retry-After). Returns the final response; the caller is
   * responsible for non-200 handling and for reading/draining the body.
   */
  private async rateLimitedRequest(
    opts: Parameters<typeof request>[1],
  ): Promise<Awaited<ReturnType<typeof request>>> {
    for (let attempt = 1; ; attempt++) {
      await this.respectRateLimit();
      const res = await request(MAR_URL, opts);
      if (!THROTTLE_STATUSES.has(res.statusCode) || attempt > MAX_THROTTLE_RETRIES) {
        return res;
      }
      this.throttles++;
      const retryAfter = Number(res.headers["retry-after"]);
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1_000
          : THROTTLE_BASE_MS * 2 ** (attempt - 1);
      await res.body.dump(); // release the socket before sleeping
      logger.warn(
        { status: res.statusCode, attempt, waitMs },
        "mar.throttled",
      );
      await sleep(waitMs);
    }
  }

  private async respectRateLimit(): Promise<void> {
    const since = Date.now() - this.lastRequestAt;
    if (since < this.minDelayMs) {
      await sleep(this.minDelayMs - since);
    }
    this.lastRequestAt = Date.now();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function collectCookies(
  setCookie: string | string[] | undefined,
): string {
  if (!setCookie) return "";
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  return headers
    .map((h) => h.split(";", 1)[0])
    .filter((c): c is string => Boolean(c))
    .join("; ");
}

/** Merge a `name=value; …` cookie string with new `set-cookie` headers; newer values win. */
export function mergeCookies(
  existing: string,
  setCookie: string | string[] | undefined,
): string {
  const jar = new Map<string, string>();
  const add = (pair: string): void => {
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  };
  for (const pair of existing.split(";").map((s) => s.trim()).filter(Boolean)) {
    add(pair);
  }
  const headers = setCookie
    ? Array.isArray(setCookie)
      ? setCookie
      : [setCookie]
    : [];
  for (const h of headers) {
    const first = h.split(";", 1)[0];
    if (first) add(first);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

export function extractHiddenFields(html: string): HiddenFields {
  const $ = cheerio.load(html);
  const get = (name: string): string => {
    const value = $(`input[name="${name}"]`).attr("value");
    if (value === undefined) {
      throw new Error(`MAR form missing hidden field: ${name}`);
    }
    return value;
  };
  return {
    __VIEWSTATE: get("__VIEWSTATE"),
    __VIEWSTATEGENERATOR: get("__VIEWSTATEGENERATOR"),
    __EVENTVALIDATION: get("__EVENTVALIDATION"),
    EktronClientManager: get("EktronClientManager"),
  };
}
