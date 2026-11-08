import { describe, expect, it } from "vitest";
import { extractCveIds, extractCveIdsFrom, normalizeCveId } from "@/lib/cve";

const NOW = new Date("2026-11-08T12:00:00Z");
const x = (s: string) => extractCveIds(s, NOW);

describe("extractCveIds", () => {
  it("finds a plain ID", () => {
    expect(x("Patch CVE-2026-1234 now")).toEqual(["CVE-2026-1234"]);
  });

  it("uppercases lowercase and mixed-case IDs", () => {
    expect(x("see cve-2026-1234 and Cve-2025-99999")).toEqual(["CVE-2026-1234", "CVE-2025-99999"]);
  });

  it("dedupes, preserving first-seen order", () => {
    expect(x("CVE-2026-2 CVE-2026-0002 cve-2026-0002 CVE-2025-1111 CVE-2026-0002")).toEqual([
      "CVE-2026-0002",
      "CVE-2025-1111",
    ]);
  });

  it("accepts 4- to 7-digit sequence numbers (KEV has 6-digit IDs)", () => {
    expect(x("CVE-2026-1234 CVE-2026-119977 CVE-2026-1234567")).toEqual([
      "CVE-2026-1234",
      "CVE-2026-119977",
      "CVE-2026-1234567",
    ]);
  });

  it("rejects too-short and too-long sequence numbers", () => {
    expect(x("CVE-2026-123 CVE-2026-12345678")).toEqual([]);
  });

  it("normalizes en-dashes, em-dashes and other dash look-alikes", () => {
    expect(x("CVE–2026–1234, CVE—2026—5678, CVE‑2026‑9999, CVE−2026−4321")).toEqual([
      "CVE-2026-1234",
      "CVE-2026-5678",
      "CVE-2026-9999",
      "CVE-2026-4321",
    ]);
  });

  it("captures IDs inside URLs", () => {
    expect(
      x("https://nvd.nist.gov/vuln/detail/CVE-2026-1234 and https://x.test/cve-2025-4444.html"),
    ).toEqual(["CVE-2026-1234", "CVE-2025-4444"]);
  });

  it("only captures the first ID of a range", () => {
    expect(x("CVE-2026-1234 through -1236 are fixed")).toEqual(["CVE-2026-1234"]);
    expect(x("CVE-2026-1234 to CVE-2026-1236")).toEqual(["CVE-2026-1234", "CVE-2026-1236"]);
  });

  it("requires word boundaries", () => {
    expect(x("XCVE-2026-1234 CVE-2026-1234X CVE-2026-1234_")).toEqual([]);
    expect(x("(CVE-2026-1234)")).toEqual(["CVE-2026-1234"]);
  });

  it("discards years before 1999 and after next year", () => {
    expect(x("CVE-1998-0001 CVE-1999-0001 CVE-2027-0001 CVE-2028-0001")).toEqual([
      "CVE-1999-0001",
      "CVE-2027-0001",
    ]);
  });

  it("handles empty input", () => {
    expect(x("")).toEqual([]);
    expect(extractCveIds(null, NOW)).toEqual([]);
    expect(extractCveIds(undefined, NOW)).toEqual([]);
  });

  it("is safe to call repeatedly (no global regex state leaks)", () => {
    for (let i = 0; i < 3; i++) expect(x("CVE-2026-1234")).toEqual(["CVE-2026-1234"]);
  });
});

describe("extractCveIdsFrom", () => {
  it("dedupes across fields", () => {
    expect(
      extractCveIdsFrom(["CVE-2026-1 CVE-2026-1111", null, "cve-2026-1111 CVE-2026-2222"], NOW),
    ).toEqual(["CVE-2026-1111", "CVE-2026-2222"]);
  });
});

describe("normalizeCveId", () => {
  it("normalizes valid input and rejects junk", () => {
    expect(normalizeCveId(" cve–2026–1234 ")).toBe("CVE-2026-1234");
    expect(normalizeCveId("CVE-2026-12")).toBeNull();
    expect(normalizeCveId("CVE-2026-1234; DROP TABLE")).toBeNull();
  });
});
