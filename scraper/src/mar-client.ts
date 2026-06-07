import { request } from "undici";
import * as cheerio from "cheerio";
import { logger } from "./logger.ts";

const MAR_URL = "https://www.smgov.net/departments/rentcontrol/mar.aspx";

const USER_AGENT =
  "rcb-database/0.0 (Santa Monica MAR registry; bradleywewing@gmail.com; https://github.com/)";

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

export class MarClient {
  private lastRequestAt = 0;

  constructor(private readonly minDelayMs = 5_000) {}

  async query(streetNumber: string, streetName: string): Promise<MarQueryResult> {
    await this.respectRateLimit();

    const getRes = await request(MAR_URL, {
      method: "GET",
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
      maxRedirections: 5,
    });
    if (getRes.statusCode !== 200) {
      throw new Error(`MAR GET failed: HTTP ${getRes.statusCode}`);
    }
    const getBody = await getRes.body.text();
    const cookies = collectCookies(getRes.headers["set-cookie"]);
    const hidden = extractHiddenFields(getBody);

    const form = new URLSearchParams();
    form.set("EktronClientManager", hidden.EktronClientManager);
    form.set("__VIEWSTATE", hidden.__VIEWSTATE);
    form.set("__VIEWSTATEGENERATOR", hidden.__VIEWSTATEGENERATOR);
    form.set("__EVENTVALIDATION", hidden.__EVENTVALIDATION);
    form.set("ctl00$mainContent$txtStNumber", streetNumber);
    form.set("ctl00$mainContent$txtStreet", streetName);
    form.set("ctl00$mainContent$btnSearch", "Search");

    await this.respectRateLimit();
    const postRes = await request(MAR_URL, {
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies,
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

function collectCookies(
  setCookie: string | string[] | undefined,
): string {
  if (!setCookie) return "";
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  return headers
    .map((h) => h.split(";", 1)[0])
    .filter((c): c is string => Boolean(c))
    .join("; ");
}

function extractHiddenFields(html: string): HiddenFields {
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
