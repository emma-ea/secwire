import type { NextConfig } from "next";

// Security headers (SPEC §10). Pages get a per-request nonce CSP from
// src/proxy.ts; this static CSP covers everything the proxy doesn't match
// (API routes, static assets).
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  // Off: every page reads Postgres per request and needs a CSP nonce, which
  // Cache Components' prerendered static shell can't carry. See DECISIONS.md.
  cacheComponents: false,
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      // Pages: proxy.ts sets the nonce CSP; don't send a second, conflicting one.
      { source: "/((?!api/|_next/).*)", headers: securityHeaders.filter((h) => h.key !== "Content-Security-Policy") },
      { source: "/(api|_next)/:path*", headers: securityHeaders },
    ];
  },
};

export default nextConfig;
