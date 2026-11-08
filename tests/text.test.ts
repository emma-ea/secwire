import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToText, toExcerpt, truncate } from "@/lib/text";

describe("htmlToText", () => {
  it("strips tags and collapses whitespace", () => {
    expect(htmlToText("<p>Hello <b>world</b></p>\n\n<p>Again</p>")).toBe("Hello world Again");
  });

  it("drops script/style contents entirely", () => {
    expect(htmlToText("a<script>alert(1)</script>b<style>p{}</style>c")).toBe("a b c");
    expect(htmlToText("x<script type='x'>evil()</script>y")).not.toContain("evil");
  });

  it("decodes entities after stripping, so encoded markup stays literal text", () => {
    expect(htmlToText("Use &lt;b&gt; tags &amp; more")).toBe("Use tags & more");
    expect(htmlToText("Tom &amp; Jerry &#8217;s &#x2014; ok&nbsp;now")).toBe("Tom & Jerry ’s — ok now");
  });

  it("unwraps CDATA", () => {
    expect(htmlToText("<![CDATA[<p>Inside</p>]]>")).toBe("Inside");
  });

  it("removes control characters", () => {
    expect(htmlToText("a\u0000b\u0007c")).toBe("abc");
  });

  it("does not run words together across block tags", () => {
    expect(htmlToText("one<br>two<li>three</li>")).toBe("one two three");
  });

  it("handles empty input", () => {
    expect(htmlToText(null)).toBe("");
    expect(htmlToText("   ")).toBe("");
  });
});

describe("decodeEntities", () => {
  it("leaves unknown or invalid entities alone or drops invalid code points", () => {
    expect(decodeEntities("&bogus; &#0; &#xD800;")).toBe("&bogus;  ");
  });
});

describe("truncate / toExcerpt", () => {
  it("keeps short strings intact", () => {
    expect(truncate("short", 400)).toBe("short");
  });

  it("never exceeds the limit and ends with an ellipsis", () => {
    const long = "word ".repeat(200);
    const out = truncate(long, 400);
    expect([...out].length).toBeLessThanOrEqual(400);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s…$/);
  });

  it("cuts mid-word when there is no reasonable boundary", () => {
    const out = truncate("x".repeat(1000), 10);
    expect(out).toBe(`${"x".repeat(9)}…`);
  });

  it("counts code points, not UTF-16 units", () => {
    const out = truncate("🔒".repeat(500), 400);
    expect([...out].length).toBeLessThanOrEqual(400);
  });

  it("toExcerpt returns null for empty content", () => {
    expect(toExcerpt("<p> </p>")).toBeNull();
    expect(toExcerpt("<p>Hi</p>")).toBe("Hi");
  });
});
