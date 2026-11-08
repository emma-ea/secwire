/**
 * Admin auth (SPEC §10). Single admin, password from ADMIN_PASSWORD, session
 * in an iron-session sealed cookie. proxy.ts is NOT the auth boundary:
 * requireAdmin()/guardAdminApi() must be called in the admin layout, every
 * admin route handler and every Server Action.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { getIronSession, type SessionOptions } from "iron-session";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "../db/client";
import { loginAttempts } from "../db/schema";
import { getEnv } from "../env";
import { SESSION_COOKIE } from "./auth-cookie";

export { SESSION_COOKIE };
const SESSION_TTL_SECONDS = 12 * 60 * 60;

export const LOGIN_WINDOW_MINUTES = 15;
export const LOGIN_MAX_FAILURES_PER_IP = 5;
/** X-Forwarded-For is client-controlled unless a proxy overwrites it, so also cap globally. */
export const LOGIN_MAX_FAILURES_GLOBAL = 20;

export type AdminSession = { admin?: boolean; loggedInAt?: number };

export function sessionOptions(): SessionOptions {
  const env = getEnv();
  return {
    cookieName: SESSION_COOKIE,
    password: env.SESSION_SECRET,
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    },
  };
}

export async function getSession() {
  return getIronSession<AdminSession>(await cookies(), sessionOptions());
}

export async function isAdmin(): Promise<boolean> {
  return (await getSession()).admin === true;
}

/** Pages, layouts and Server Actions: redirects to the login page when not signed in. */
export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) redirect("/admin/login");
}

/** Constant-time comparison of a password attempt (hashing equalizes lengths). */
export function passwordMatches(attempt: string, expected: string): boolean {
  const a = createHash("sha256").update(attempt, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Constant-time bearer token check for POST /api/ingest. */
export function tokenMatches(presented: string | null | undefined, expected: string): boolean {
  return presented ? passwordMatches(presented, expected) : false;
}

export function clientIp(h: Headers): string {
  const xff = h.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || h.get("x-real-ip")?.trim() || "unknown";
}

export async function loginRateLimited(ip: string): Promise<boolean> {
  const db = getDb();
  const since = sql`now() - make_interval(mins => ${LOGIN_WINDOW_MINUTES})`;
  const [perIp] = await db
    .select({ n: count() })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.ip, ip), eq(loginAttempts.succeeded, false), gt(loginAttempts.attemptedAt, since)));
  if ((perIp?.n ?? 0) >= LOGIN_MAX_FAILURES_PER_IP) return true;
  const [global] = await db
    .select({ n: count() })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.succeeded, false), gt(loginAttempts.attemptedAt, since)));
  return (global?.n ?? 0) >= LOGIN_MAX_FAILURES_GLOBAL;
}

export type LoginResult = { ok: true } | { ok: false; error: string };

export async function attemptLogin(password: string): Promise<LoginResult> {
  const ip = clientIp(await headers());
  if (await loginRateLimited(ip)) {
    return { ok: false, error: `Too many failed attempts. Try again in ${LOGIN_WINDOW_MINUTES} minutes.` };
  }
  const ok = passwordMatches(password, getEnv().ADMIN_PASSWORD);
  await getDb().insert(loginAttempts).values({ ip, succeeded: ok });
  if (!ok) return { ok: false, error: "Incorrect password." };

  const session = await getSession();
  session.admin = true;
  session.loggedInAt = Date.now();
  await session.save();
  return { ok: true };
}

export async function logout(): Promise<void> {
  const session = await getSession();
  session.destroy();
}

// ---------------------------------------------------------------------------
// Route handler guards
// ---------------------------------------------------------------------------

/**
 * CSRF (SPEC §10): state-changing admin routes require an Origin header that
 * matches the host the request was sent to. Browsers always send Origin on
 * cross-site and same-site POST/PUT/PATCH/DELETE.
 */
export function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  return originHost === host;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Admin API routes: returns an error Response to send, or null when allowed. */
export async function guardAdminApi(req: Request): Promise<Response | null> {
  if (!SAFE_METHODS.has(req.method) && !originAllowed(req)) {
    return Response.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }
  if (!(await isAdmin())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
