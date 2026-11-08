import { describe, expect, it } from "vitest";
import { canonicalizeUrl, hashCanonicalUrl, isHttpUrl, parseHttpUrl } from "@/lib/url";

describe("canonicalizeUrl", () => {
  it("lowercases scheme and host but not path", () => {
    expect(canonicalizeUrl("HTTPS://Example.COM/Path/To")).toBe("https://example.com/Path/To");
  });

  it("drops the fragment", () => {
    expect(canonicalizeUrl("https://a.com/x#section")).toBe("https://a.com/x");
  });

  it("strips tracking params and sorts the rest", () => {
    expect(
      canonicalizeUrl(
        "https://a.com/x?utm_source=tw&b=2&UTM_Medium=x&fbclid=1&a=1&gclid=2&mc_cid=3&mc_eid=4&ref=hn",
      ),
    ).toBe("https://a.com/x?a=1&b=2");
  });

  it("keeps params that merely start with a tracking name", () => {
    expect(canonicalizeUrl("https://a.com/x?referrer=1&refs=2")).toBe("https://a.com/x?referrer=1&refs=2");
  });

  it("sorts repeated keys by value for stability", () => {
    expect(canonicalizeUrl("https://a.com/?t=b&t=a")).toBe(canonicalizeUrl("https://a.com/?t=a&t=b"));
  });

  it("strips trailing slashes, including the root", () => {
    expect(canonicalizeUrl("https://a.com/x/")).toBe("https://a.com/x");
    expect(canonicalizeUrl("https://a.com/")).toBe("https://a.com");
    expect(canonicalizeUrl("https://a.com")).toBe("https://a.com");
  });

  it("drops default ports and credentials", () => {
    expect(canonicalizeUrl("https://user:pw@a.com:443/x")).toBe("https://a.com/x");
    expect(canonicalizeUrl("http://a.com:8080/x")).toBe("http://a.com:8080/x");
  });

  it("treats tracking-only differences as the same URL", () => {
    expect(hashCanonicalUrl("https://www.bleepingcomputer.com/news/x/?utm_source=hn#c")).toBe(
      hashCanonicalUrl("https://www.bleepingcomputer.com/news/x"),
    );
  });

  it("rejects non-http(s) URLs", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "ftp://a.com/x", "file:///etc/passwd", "not a url"]) {
      expect(() => canonicalizeUrl(bad)).toThrow(/Not an http/);
      expect(isHttpUrl(bad)).toBe(false);
    }
  });
});

describe("hashCanonicalUrl", () => {
  it("is a 64-char sha256 hex digest", () => {
    expect(hashCanonicalUrl("https://a.com/x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("parseHttpUrl", () => {
  it("trims and parses", () => {
    expect(parseHttpUrl("  https://a.com/x ")?.href).toBe("https://a.com/x");
    expect(parseHttpUrl(null)).toBeNull();
  });
});
