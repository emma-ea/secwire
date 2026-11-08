"use server";

/**
 * Admin Server Actions. Each one calls requireAdmin() first (SPEC §10) and
 * then the same service functions as the /api/admin routes. Next.js checks
 * the Origin header on Server Actions, which covers CSRF.
 */
import { redirect } from "next/navigation";
import { z } from "zod";
import { attemptLogin, logout, requireAdmin } from "@/lib/auth";
import {
  createWatchlist,
  deleteWatchlist,
  matchingStories,
  sendTestAlert,
  updateWatchlist,
  watchlistInputSchema,
  type WatchlistInput,
} from "@/ingest/alerts";
import { cancelRun } from "@/ingest/cancel";
import { getSchedulerState, SettingsValidationError, updateSchedulerSettings } from "@/ingest/scheduler-service";
import {
  createSource,
  getSource,
  ingestRequestSchema,
  newSourceSchema,
  SourceExistsError,
  sourcePatchSchema,
  testSourceSchema,
  updateSource,
} from "@/ingest/sources-service";
import { testSource, type TestSourceResult } from "@/ingest/test-source";
import { triggerIngestion, UnknownSourcesError, type TriggerSourceResult } from "@/ingest/trigger";
import {
  InvalidCveIdError,
  InvalidSinceError,
  parseSince,
  triggerEnrichCve,
  triggerRecluster,
  type JobTriggerResult,
} from "@/ingest/trigger-jobs";

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

// --- Session ---------------------------------------------------------------

export async function loginAction(_prev: { error?: string } | null, form: FormData): Promise<{ error?: string }> {
  const password = String(form.get("password") ?? "");
  const r = await attemptLogin(password);
  if (!r.ok) return { error: r.error };
  const next = String(form.get("next") ?? "");
  // Only same-site relative paths under /admin.
  redirect(next.startsWith("/admin") && !next.startsWith("//") ? next : "/admin");
}

export async function logoutAction(): Promise<void> {
  await logout();
  redirect("/admin/login");
}

// --- Ingestion -------------------------------------------------------------

export async function runIngestAction(
  input: z.input<typeof ingestRequestSchema>,
): Promise<ActionResult<{ runId: string | null; sources: TriggerSourceResult[] }>> {
  await requireAdmin();
  const parsed = ingestRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request" };
  try {
    const r = await triggerIngestion({
      trigger: "admin",
      triggeredBy: "admin",
      sourceIds: parsed.data.sourceIds,
      force: parsed.data.force,
      includeDisabled: parsed.data.includeDisabled,
    });
    return { ok: true, data: { runId: r.runId, sources: r.sources.map((s) => ({ sourceId: s.sourceId, status: s.status, coalescedIntoJobId: s.coalescedIntoJobId ?? null })) } };
  } catch (err) {
    if (err instanceof UnknownSourcesError) return { ok: false, error: err.message };
    throw err;
  }
}

export async function cancelRunAction(runId: string): Promise<ActionResult<{ cancelled: string[]; stillRunning: string[] }>> {
  await requireAdmin();
  if (!z.uuid().safeParse(runId).success) return { ok: false, error: "Invalid run id" };
  const r = await cancelRun(runId);
  return r ? { ok: true, data: { cancelled: r.cancelled, stillRunning: r.stillRunning } } : { ok: false, error: "Run not found" };
}

// --- Enrichment & clustering -------------------------------------------------

export async function reEnrichCveAction(cveId: string): Promise<ActionResult<Pick<JobTriggerResult, "runId" | "status" | "error">>> {
  await requireAdmin();
  try {
    const r = await triggerEnrichCve({ trigger: "admin", triggeredBy: "admin", cveId: String(cveId) });
    return { ok: true, data: { runId: r.runId, status: r.status, error: r.error ?? null } };
  } catch (err) {
    if (err instanceof InvalidCveIdError) return { ok: false, error: err.message };
    throw err;
  }
}

export async function reclusterAction(since: string): Promise<ActionResult<Pick<JobTriggerResult, "runId" | "status" | "error">>> {
  await requireAdmin();
  try {
    const r = await triggerRecluster({ trigger: "admin", triggeredBy: "admin", since: parseSince(String(since)) });
    return { ok: true, data: { runId: r.runId, status: r.status, error: r.error ?? null } };
  } catch (err) {
    if (err instanceof InvalidSinceError) return { ok: false, error: err.message };
    throw err;
  }
}

// --- Sources ---------------------------------------------------------------

export async function testSavedSourceAction(sourceId: string): Promise<TestSourceResult | { ok: false; error: string; items: [] }> {
  await requireAdmin();
  const source = await getSource(sourceId);
  if (!source) return { ok: false, error: "Unknown source", items: [] };
  return testSource(source);
}

export async function testNewSourceAction(input: z.input<typeof testSourceSchema>): Promise<TestSourceResult> {
  await requireAdmin();
  const parsed = testSourceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, items: [], httpStatus: null, durationMs: 0, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  return testSource({ type: parsed.data.type, url: parsed.data.url, config: parsed.data.config ?? {} });
}

export async function updateSourceAction(
  id: string,
  patch: z.input<typeof sourcePatchSchema>,
): Promise<ActionResult<null>> {
  await requireAdmin();
  const parsed = sourcePatchSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const row = await updateSource(id, parsed.data);
  return row ? { ok: true, data: null } : { ok: false, error: "Unknown source" };
}

export async function createSourceAction(input: z.input<typeof newSourceSchema>): Promise<ActionResult<{ id: string }>> {
  await requireAdmin();
  const parsed = newSourceSchema.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false, error: i ? `${i.path.join(".")}: ${i.message}` : "Invalid input" };
  }
  try {
    const row = await createSource(parsed.data);
    return { ok: true, data: { id: row.id } };
  } catch (err) {
    if (err instanceof SourceExistsError) return { ok: false, error: err.message };
    throw err;
  }
}

// --- Scheduler -------------------------------------------------------------

export async function saveSchedulerAction(input: {
  enabled?: boolean;
  intervalMinutes?: number;
  enrichRefreshEnabled?: boolean;
  cancelQueuedScheduled?: boolean;
}) {
  await requireAdmin();
  try {
    const r = await updateSchedulerSettings(input, "admin");
    return { ok: true as const, data: r };
  } catch (err) {
    if (err instanceof SettingsValidationError) return { ok: false as const, error: err.message };
    throw err;
  }
}

export async function getSchedulerStateAction() {
  await requireAdmin();
  return getSchedulerState();
}

// --- Watchlists (Phase 3) ----------------------------------------------------

function watchlistError(err: z.ZodError): string {
  const i = err.issues[0];
  return i ? `${i.path.join(".") || "input"}: ${i.message}` : "Invalid input";
}

export async function saveWatchlistAction(
  id: string | null,
  input: WatchlistInput,
): Promise<ActionResult<{ id: string; baselined: number }>> {
  await requireAdmin();
  const parsed = watchlistInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: watchlistError(parsed.error) };
  const r = id ? await updateWatchlist(id, parsed.data) : await createWatchlist(parsed.data);
  if (!r) return { ok: false, error: "Watchlist not found" };
  return { ok: true, data: { id: r.watchlist.id, baselined: r.baselined } };
}

export async function deleteWatchlistAction(id: string): Promise<ActionResult<null>> {
  await requireAdmin();
  return (await deleteWatchlist(String(id))) ? { ok: true, data: null } : { ok: false, error: "Watchlist not found" };
}

export async function testWatchlistAction(id: string): Promise<ActionResult<{ sent: string[]; errors: string[] }>> {
  await requireAdmin();
  const r = await sendTestAlert(String(id));
  return r ? { ok: true, data: r } : { ok: false, error: "Watchlist not found" };
}

/** Recent stories an (unsaved) watchlist would match, so the admin can tune terms before saving. */
export async function previewWatchlistAction(
  input: WatchlistInput,
): Promise<ActionResult<Array<{ id: string; title: string; has_kev: boolean; max_cvss: number | null }>>> {
  await requireAdmin();
  const parsed = watchlistInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: watchlistError(parsed.error) };
  const rows = await matchingStories(parsed.data, { limit: 20 });
  return { ok: true, data: rows.map((s) => ({ id: s.id, title: s.title, has_kev: s.has_kev, max_cvss: s.max_cvss })) };
}
