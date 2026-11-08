import { z } from "zod";

/**
 * Environment schema (SPEC §11). Validation is lazy — call getEnv() — so that
 * `next build` and Docker image builds don't require runtime secrets. The web
 * server validates at boot via src/instrumentation.ts; the worker and scripts
 * validate on startup.
 */

/** Treat empty strings (e.g. `NVD_API_KEY=`) as unset. */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v));

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection URL"),
    ADMIN_PASSWORD: z.string().min(8, "must be at least 8 characters"),
    SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
    INGEST_API_TOKEN: z.string().min(16, "must be at least 16 characters"),
    NVD_API_KEY: optionalString,
    FETCH_USER_AGENT: z.string().min(1),
    KEV_ITEM_LOOKBACK_DAYS: positiveInt(14),
    CLUSTER_WINDOW_DAYS: positiveInt(14),
    WORKER_SCHEDULES_ENABLED: z.stringbool().default(true),
    // Phase 3: X (paid, pay-per-use). Off unless explicitly enabled.
    X_ENABLED: z.stringbool().default(false),
    X_BEARER_TOKEN: optionalString,
    X_MONTHLY_CAP_USD: z.coerce.number().min(0).default(10),
    /** Price per post returned (docs.x.com pricing, checked 2026-11-08). */
    X_POST_READ_USD: z.coerce.number().min(0).default(0.005),
    // Phase 3: AI story summaries. Off unless an API key is set.
    ANTHROPIC_API_KEY: optionalString,
    SUMMARY_MODEL: z.string().trim().min(1).default("claude-haiku-5-5"),
    SUMMARY_MIN_ITEMS: z.coerce.number().int().min(1).default(2),
    AI_MONTHLY_CAP_USD: z.coerce.number().min(0).default(5),
    /** USD per million tokens; only needed for a SUMMARY_MODEL missing from the built-in price table. */
    AI_INPUT_USD_PER_MTOK: z.coerce.number().min(0).optional(),
    AI_OUTPUT_USD_PER_MTOK: z.coerce.number().min(0).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    const placeholders: Array<[keyof typeof env, string]> = [
      ["ADMIN_PASSWORD", "change-me"],
      ["SESSION_SECRET", "generate-a-32+-char-random-string"],
      ["INGEST_API_TOKEN", "generate-a-random-token"],
    ];
    for (const [key, placeholder] of placeholders) {
      if (env[key] === placeholder) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "still set to the .env.example placeholder",
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvError";
  }
}

/** Pure parser, exported for tests. Never echoes values, only variable names. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    );
  }
  return result.data;
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Tests only: re-read process.env on the next getEnv() call. */
export function resetEnvCache(): void {
  cached = undefined;
}
