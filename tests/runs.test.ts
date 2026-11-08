import { describe, expect, it } from "vitest";
import { deriveRunStatus } from "@/ingest/runs";

describe("deriveRunStatus", () => {
  it.each([
    [{ succeeded: 3 }, "succeeded"],
    [{ succeeded: 1, not_modified: 2, coalesced: 1, skipped_cooldown: 1 }, "succeeded"],
    [{ skipped_disabled: 2 }, "succeeded"],
    [{}, "succeeded"],
    [{ failed: 2 }, "failed"],
    [{ failed: 1, skipped_locked: 1 }, "failed"],
    [{ failed: 1, succeeded: 1 }, "partial"],
    [{ failed: 1, not_modified: 1 }, "partial"],
    [{ failed: 1, cancelled: 1 }, "partial"],
    [{ cancelled: 2 }, "cancelled"],
    [{ cancelled: 1, succeeded: 1 }, "cancelled"],
  ] as const)("%o → %s", (counts, expected) => {
    expect(deriveRunStatus(counts)).toBe(expected);
  });
});
