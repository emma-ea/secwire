/**
 * Next.js 16 proxy (formerly middleware). Two jobs, neither of them auth:
 *
 * 1. Nonce-based Content-Security-Policy for every page (SPEC §10).
 * 2. Convenience redirect: no session cookie on /admin/* → /admin/login.
 *    This only checks that a cookie exists; the real check is requireAdmin()
 *    in the admin layout, route handlers and Server Actions (see
 *    CVE-2025-29927 for why proxy/middleware-only auth is unsafe).
 */
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "./lib/auth-cookie";

export function buildCsp(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Production: stylesheet files + Next's nonce'd inline styles. Dev: the
    // dev overlay/HMR inject un-nonced styles, and browsers ignore
    // 'unsafe-inline' whenever a nonce is present, so dev omits the nonce.
    isDev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (pathname.startsWith("/admin") && pathname !== "/admin/login" && !request.cookies.has(SESSION_COOKIE)) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin/login";
    url.search = pathname === "/admin" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, process.env.NODE_ENV === "development");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
