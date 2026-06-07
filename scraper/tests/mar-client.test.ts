import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectCookies,
  extractHiddenFields,
  mergeCookies,
} from "../src/mar-client.ts";

const fixturesDir = join(import.meta.dirname, "fixtures");
const read = (name: string) => readFileSync(join(fixturesDir, name), "utf8");

// These fixtures are captured POST *responses*. The premise of token reuse is
// that a postback carries the next form-token triplet — so extractHiddenFields
// must succeed on them, not just on a freshly GET'd empty form.
const POSTBACK_FIXTURES = [
  "colorado-ave-list.html",
  "624-lincoln-blvd.html",
  "colorado-2615.html",
];

describe("extractHiddenFields", () => {
  for (const name of POSTBACK_FIXTURES) {
    it(`harvests a replayable token triplet from postback ${name}`, () => {
      const hidden = extractHiddenFields(read(name));
      expect(hidden.__VIEWSTATE.length).toBeGreaterThan(0);
      expect(hidden.__VIEWSTATEGENERATOR.length).toBeGreaterThan(0);
      expect(hidden.__EVENTVALIDATION.length).toBeGreaterThan(0);
      expect(hidden.EktronClientManager).toBeDefined();
    });
  }

  it("succeeds on the freshly GET'd empty form", () => {
    expect(() => extractHiddenFields(read("mar-empty-form.html"))).not.toThrow();
  });

  // The fallback path: when a response lacks a token field, extractHiddenFields
  // throws, which is what drives MarClient to re-seed with a fresh GET.
  it("throws when a token field is missing", () => {
    const stripped = read("mar-empty-form.html").replace(
      /name="__EVENTVALIDATION"/g,
      'name="__NOT_IT"',
    );
    expect(() => extractHiddenFields(stripped)).toThrow(/__EVENTVALIDATION/);
  });

  it("throws on a non-form page", () => {
    expect(() => extractHiddenFields("<html><body>down</body></html>")).toThrow();
  });
});

describe("collectCookies", () => {
  it("returns empty string when there are no cookies", () => {
    expect(collectCookies(undefined)).toBe("");
  });

  it("keeps only the name=value of a single set-cookie header", () => {
    expect(collectCookies("ASP.NET_SessionId=abc; path=/; HttpOnly")).toBe(
      "ASP.NET_SessionId=abc",
    );
  });

  it("joins multiple set-cookie headers", () => {
    expect(
      collectCookies([
        "ASP.NET_SessionId=abc; path=/; HttpOnly",
        "ecm=xyz; path=/",
      ]),
    ).toBe("ASP.NET_SessionId=abc; ecm=xyz");
  });
});

describe("mergeCookies", () => {
  it("adds new cookies and lets newer values override by name", () => {
    const merged = mergeCookies("ASP.NET_SessionId=old; ecm=keep", [
      "ASP.NET_SessionId=new; path=/",
      "extra=1; path=/",
    ]);
    const jar = Object.fromEntries(
      merged.split("; ").map((p) => p.split("=") as [string, string]),
    );
    expect(jar["ASP.NET_SessionId"]).toBe("new");
    expect(jar["ecm"]).toBe("keep");
    expect(jar["extra"]).toBe("1");
  });

  it("returns the existing jar unchanged when there is no set-cookie", () => {
    expect(mergeCookies("a=1; b=2", undefined)).toBe("a=1; b=2");
  });
});
