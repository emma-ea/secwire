/**
 * In-process request spacing for NVD (SPEC §6.6). NVD allows 5 requests per
 * rolling 30s without a key and 50 with one; spacing requests evenly with a
 * small margin stays under both without tracking a window.
 *
 * It is per process: the worker runs enrich.cve at concurrency 1, so the
 * worker's own traffic is covered. A CLI --inline enrich running at the same
 * time has its own throttle (see DECISIONS.md).
 */

export const NVD_SPACING_MS = { withoutKey: 6_500, withKey: 650 } as const;
export const NVD_BACKOFF_MS = { initial: 30_000, max: 5 * 60_000 } as const;

export function nvdSpacingMs(hasApiKey: boolean): number {
  return hasApiKey ? NVD_SPACING_MS.withKey : NVD_SPACING_MS.withoutKey;
}

export type Clock = {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

export class Throttle {
  private nextAt = 0;
  private backoffMs = 0;
  /** Serializes callers so concurrent waiters get consecutive slots. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly spacingMs: number,
    private readonly clock: Clock = realClock,
    private readonly backoff = NVD_BACKOFF_MS,
  ) {}

  /** Resolves when the caller may send its request, and books the slot. */
  wait(signal?: AbortSignal): Promise<void> {
    const turn = this.chain.then(async () => {
      const delay = this.nextAt - this.clock.now();
      if (delay > 0) await this.clock.sleep(delay, signal);
      this.nextAt = Math.max(this.nextAt, this.clock.now()) + this.spacingMs;
    });
    // A failed (aborted) waiter must not block the ones behind it.
    this.chain = turn.catch(() => {});
    return turn;
  }

  /** Rate-limited (403/429/503): push the next slot out, doubling up to the max. */
  penalize(): number {
    this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, this.backoff.max) : this.backoff.initial;
    this.nextAt = Math.max(this.nextAt, this.clock.now() + this.backoffMs);
    return this.backoffMs;
  }

  /** A request succeeded: the next rate-limit starts from the initial backoff again. */
  succeeded(): void {
    this.backoffMs = 0;
  }

  get currentBackoffMs(): number {
    return this.backoffMs;
  }
}
