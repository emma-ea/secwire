/** Admin operations on sources, shared by API routes and Server Actions. */
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/client";
import { sourceCategory, sources, sourceType } from "../db/schema";
import { parseHttpUrl } from "../lib/url";
import { activeSourceIds } from "./runs";

export const UNHEALTHY_AFTER_FAILURES = 5;

export const sourcePatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    minIntervalMinutes: z.number().int().min(1).max(10_080).nullable().optional(),
  })
  .strict();
export type SourcePatch = z.infer<typeof sourcePatchSchema>;

export const ingestRequestSchema = z
  .object({
    sourceIds: z.union([z.literal("all"), z.array(z.string().min(1).max(100)).min(1).max(200)]),
    force: z.boolean().optional(),
    includeDisabled: z.boolean().optional(),
  })
  .strict();

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((u) => parseHttpUrl(u) !== null, "must be an http(s) URL");

export const newSourceSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, "3–50 chars: lowercase letters, digits and hyphens"),
  name: z.string().trim().min(1).max(100),
  type: z.enum(sourceType.enumValues),
  category: z.enum(sourceCategory.enumValues),
  url: httpUrl,
  minIntervalMinutes: z.number().int().min(1).max(10_080).nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type NewSource = z.infer<typeof newSourceSchema>;

export const testSourceSchema = newSourceSchema.pick({ type: true, url: true, config: true });

export class SourceExistsError extends Error {
  constructor(id: string) {
    super(`A source with id "${id}" already exists`);
    this.name = "SourceExistsError";
  }
}

export async function updateSource(id: string, patch: SourcePatch) {
  const db = getDb();
  const set: Partial<typeof sources.$inferInsert> = {};
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.minIntervalMinutes !== undefined) set.minIntervalMinutes = patch.minIntervalMinutes;
  if (!Object.keys(set).length) {
    const [row] = await db.select().from(sources).where(eq(sources.id, id));
    return row ?? null;
  }
  const [row] = await db.update(sources).set(set).where(eq(sources.id, id)).returning();
  return row ?? null;
}

export async function createSource(input: NewSource) {
  const db = getDb();
  const [row] = await db
    .insert(sources)
    .values({
      id: input.id,
      name: input.name,
      type: input.type,
      category: input.category,
      url: input.url,
      minIntervalMinutes: input.minIntervalMinutes ?? null,
      config: input.config ?? {},
      enabled: true,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new SourceExistsError(input.id);
  return row;
}

export async function getSource(id: string) {
  const [row] = await getDb().select().from(sources).where(eq(sources.id, id));
  return row ?? null;
}

/** Sources table for the dashboard: adds 24h item counts and queued/running flag. */
export async function listSourcesForAdmin() {
  const db = getDb();
  const rows = await db
    .select({
      source: sources,
      // Written with explicit aliases: inside select({...}) Drizzle renders
      // column refs unqualified, so ${sources.id} would bind to items.id here.
      items24h: sql<number>`(SELECT count(*)::int FROM items i WHERE i.source_id = "sources"."id" AND i.fetched_at > now() - interval '24 hours')`,
    })
    .from(sources)
    .orderBy(asc(sources.id));
  const active = await activeSourceIds(db);
  return rows.map((r) => ({
    ...r.source,
    items24h: r.items24h,
    busy: active.has(r.source.id),
    unhealthy: r.source.consecutiveFailures >= UNHEALTHY_AFTER_FAILURES,
  }));
}
