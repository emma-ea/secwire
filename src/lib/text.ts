/**
 * HTML → plain text for feed fields (SPEC §10: strip all HTML, render as text).
 * This is a sanitizer for *display as text*, not an HTML sanitizer: the output
 * must never be rendered as HTML.
 */

export const EXCERPT_MAX = 400;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  middot: "·",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
      if (code >= 0xd800 && code <= 0xdfff) return "";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function htmlToText(input: string | null | undefined): string {
  if (!input) return "";
  let s = input
    // Drop elements whose content is never prose.
    .replace(/<(script|style|noscript|template|iframe|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    // Block-level boundaries become spaces so words don't run together.
    .replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|blockquote|section|article|figure|figcaption)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "");
  // Decode after stripping so "&lt;script&gt;" ends up as literal text.
  s = decodeEntities(s);
  // Second pass catches markup that was entity-encoded inside CDATA.
  s = s.replace(/<\/?[a-z][^>]*>/gi, "");
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Truncate to ≤ max chars on a word boundary when possible, appending "…". */
export function truncate(s: string, max = EXCERPT_MAX): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  const cut = chars.slice(0, max - 1).join("");
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[\s.,;:!?-]+$/, "")}…`;
}

/** Plain-text excerpt, or null when nothing meaningful is left. */
export function toExcerpt(html: string | null | undefined, max = EXCERPT_MAX): string | null {
  const text = htmlToText(html);
  return text ? truncate(text, max) : null;
}

/** Plain-text single-line title. */
export function toTitle(html: string | null | undefined): string {
  return truncate(htmlToText(html), 500);
}
