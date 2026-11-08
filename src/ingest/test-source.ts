/**
 * "Test source" dry run (SPEC §7.2 B): fetch + parse with a hard 20s timeout,
 * no DB writes, no run row. Works for saved sources and unsaved form input.
 */
import { getEnv } from "../env";
import { SafeFetchError } from "../lib/safe-fetch";
import { fetchWithBudget } from "./spend";
import { getAdapter, SourceHttpError, type AdapterContext, type NormalizedItem, type Source } from "./adapters";

export const TEST_SOURCE_TIMEOUT_MS = 20_000;

export type TestSourceInput = Pick<Source, "type" | "url" | "config"> &
  Partial<Pick<Source, "id" | "lastSuccessAt">>;

export type TestSourceResult = {
  ok: boolean;
  items: NormalizedItem[];
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
};

export async function testSource(
  input: TestSourceInput,
  opts: { fetcher?: AdapterContext["fetcher"] } = {},
): Promise<TestSourceResult> {
  const started = Date.now();
  const now = new Date();
  const source: Source = {
    id: input.id ?? "__test__",
    name: "test",
    category: "news",
    enabled: true,
    minIntervalMinutes: null,
    etag: null,
    lastModified: null,
    lastFetchedAt: null,
    lastSuccessAt: input.lastSuccessAt ?? null,
    lastError: null,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
    type: input.type,
    url: input.url,
    config: input.config ?? {},
  };
  try {
    const r = await fetchWithBudget(getAdapter(source.type), source, {
      force: true,
      signal: AbortSignal.timeout(TEST_SOURCE_TIMEOUT_MS),
      timeoutMs: TEST_SOURCE_TIMEOUT_MS,
      fetcher: opts.fetcher,
      now,
      kevItemLookbackDays: getEnv().KEV_ITEM_LOOKBACK_DAYS,
    });
    if (r.status === "not_modified") {
      return { ok: true, items: [], httpStatus: 304, durationMs: Date.now() - started, error: null };
    }
    return { ok: true, items: r.items, httpStatus: r.httpStatus, durationMs: Date.now() - started, error: null };
  } catch (err) {
    return {
      ok: false,
      items: [],
      httpStatus: err instanceof SourceHttpError ? err.httpStatus : null,
      durationMs: Date.now() - started,
      error:
        err instanceof SafeFetchError && err.code === "aborted"
          ? `Timed out after ${TEST_SOURCE_TIMEOUT_MS / 1000}s`
          : (err instanceof Error ? err.message : String(err)).slice(0, 1000),
    };
  }
}
