/**
 * Outbound HTTP for everything that touches admin-configurable URLs (SPEC §10).
 *
 * - 30s overall timeout (across redirects), 5 MB cap on the *decompressed* body,
 *   at most 5 redirects, identifying User-Agent.
 * - SSRF guard: every hostname is resolved inside the socket's own `lookup`
 *   hook and rejected if ANY resolved address is non-public. Because the check
 *   runs on the exact addresses the socket connects to, DNS rebinding between
 *   "check" and "connect" isn't possible. IP-literal hosts (which skip lookup)
 *   are checked up front. Both happen again on every redirect hop.
 *
 * Built on node:http/https rather than global fetch, because fetch offers no
 * per-connection lookup hook without adding undici as a dependency.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import type { Readable } from "node:stream";
import { getEnv } from "../env";

export const SAFE_FETCH_DEFAULTS = {
  timeoutMs: 30_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
} as const;

export type SafeFetchErrorCode =
  | "bad_url"
  | "blocked_address"
  | "dns"
  | "timeout"
  | "aborted"
  | "too_large"
  | "too_many_redirects"
  | "network";

export class SafeFetchError extends Error {
  constructor(
    public readonly code: SafeFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export type SafeFetchOptions = {
  headers?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  /** POST is for outbound notifications (Slack webhooks). Redirects are never followed for POST. */
  method?: "GET" | "POST";
  body?: string;
  /**
   * Override of the address policy. Tests only — production code must never
   * pass this. Defaults to isPublicAddress.
   */
  addressPolicy?: (address: string, family: 4 | 6) => boolean;
};

export type SafeResponse = {
  status: number;
  headers: Headers;
  /** Final URL after redirects. */
  url: string;
  redirects: number;
  body: Buffer;
  text(): string;
};

// ---------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------

// Separate lists per family: a single BlockList matches IPv4 addresses against
// IPv6 rules via mapping, so ::ffff:0:0/96 would block every IPv4 address.
const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [net4, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blocked4.addSubnet(net4, prefix, "ipv4");
}
for (const [net6, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::ffff:0:0", 96], // IPv4-mapped — could smuggle any v4 address
  ["64:ff9b::", 96], // NAT64 — embeds v4
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo — embeds v4
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 — embeds v4
  ["fc00::", 7], // unique local, incl. AWS metadata fd00:ec2::254
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
] as const) {
  blocked6.addSubnet(net6, prefix, "ipv6");
}

export function isPublicAddress(address: string, family: 4 | 6): boolean {
  const addr = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  if (family === 4 ? !net.isIPv4(addr) : !net.isIPv6(addr)) return false;
  return family === 4 ? !blocked4.check(addr, "ipv4") : !blocked6.check(addr, "ipv6");
}

type LookupAll = { address: string; family: number };
type Policy = NonNullable<SafeFetchOptions["addressPolicy"]>;

function guardedLookup(policy: Policy): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses: LookupAll[]) => {
      if (err) return callback(err, "", 4);
      if (!addresses.length) {
        return callback(Object.assign(new Error(`No addresses for ${hostname}`), { code: "ENOTFOUND" }), "", 4);
      }
      const bad = addresses.find((a) => !policy(a.address, a.family === 6 ? 6 : 4));
      if (bad) {
        return callback(
          new SafeFetchError("blocked_address", `Refusing to connect to ${hostname}: resolves to non-public address ${bad.address}`),
          "",
          4,
        );
      }
      const wanted = options.family === 4 || options.family === 6 ? options.family : 0;
      const usable = wanted ? addresses.filter((a) => a.family === wanted) : addresses;
      if (options.all) {
        (callback as unknown as (e: null, a: LookupAll[]) => void)(null, usable);
      } else {
        const first = usable[0] ?? addresses[0]!;
        callback(null, first.address, first.family);
      }
    });
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Request headers that carry secrets (X bearer token, NVD apiKey); stripped on cross-origin redirects. */
export const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie", "apikey", "x-api-key"] as const;

export async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const timeoutMs = opts.timeoutMs ?? SAFE_FETCH_DEFAULTS.timeoutMs;
  const maxBytes = opts.maxBytes ?? SAFE_FETCH_DEFAULTS.maxBytes;
  const maxRedirects = opts.maxRedirects ?? SAFE_FETCH_DEFAULTS.maxRedirects;
  const policy = opts.addressPolicy ?? isPublicAddress;

  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  const headers: Record<string, string> = {
    "user-agent": getEnv().FETCH_USER_AGENT,
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br",
  };
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (v !== undefined) headers[k.toLowerCase()] = v;
  }

  let url = parseTarget(input);
  for (let redirects = 0; ; redirects++) {
    try {
      const method = opts.method ?? "GET";
      const res = await requestOnce(url, headers, signal, maxBytes, policy, method, opts.body);
      const location = res.headers.get("location");
      if (method === "GET" && REDIRECT_STATUSES.has(res.status) && location) {
        if (redirects >= maxRedirects) {
          throw new SafeFetchError("too_many_redirects", `More than ${maxRedirects} redirects`);
        }
        const next = parseTarget(new URL(location, url).toString());
        // Like browsers and undici: credentials never follow a redirect to another origin.
        if (next.origin !== url.origin) {
          for (const h of CREDENTIAL_HEADERS) delete headers[h];
        }
        url = next;
        continue;
      }
      return { ...res, url: url.toString(), redirects, text: () => res.body.toString("utf8") };
    } catch (err) {
      if (err instanceof SafeFetchError) throw err;
      if (timeout.aborted) throw new SafeFetchError("timeout", `Timed out after ${timeoutMs}ms`);
      if (signal.aborted) throw new SafeFetchError("aborted", "Request aborted");
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") {
        throw new SafeFetchError("dns", `DNS lookup failed for ${url.hostname}`);
      }
      throw new SafeFetchError("network", `${e.code ?? "error"}: ${e.message}`);
    }
  }

  function parseTarget(raw: string): URL {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new SafeFetchError("bad_url", "Invalid URL");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new SafeFetchError("bad_url", `Unsupported protocol ${u.protocol}`);
    }
    if (u.username || u.password) {
      throw new SafeFetchError("bad_url", "URLs with credentials are not allowed");
    }
    // IP literals bypass the lookup hook, so check them here.
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const family = net.isIP(host);
    if (family && !policy(host, family as 4 | 6)) {
      throw new SafeFetchError("blocked_address", `Refusing to connect to non-public address ${host}`);
    }
    return u;
  }
}

function requestOnce(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  maxBytes: number,
  policy: Policy,
  method: "GET" | "POST" = "GET",
  body?: string,
): Promise<Omit<SafeResponse, "url" | "redirects" | "text">> {
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method,
        headers: body === undefined ? headers : { ...headers, "content-length": String(Buffer.byteLength(body)) },
        signal,
        lookup: guardedLookup(policy),
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          for (const val of Array.isArray(v) ? v : [v]) h.append(k, val);
        }

        // Redirects and bodiless statuses: don't read the body.
        if ((REDIRECT_STATUSES.has(status) && h.has("location")) || status === 304 || status === 204) {
          res.resume();
          return resolve({ status, headers: h, body: Buffer.alloc(0) });
        }

        const declared = Number(h.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes && !h.get("content-encoding")) {
          res.destroy();
          return reject(new SafeFetchError("too_large", `Response exceeds ${maxBytes} bytes`));
        }

        let stream: Readable = res;
        const enc = (h.get("content-encoding") ?? "").toLowerCase();
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());

        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            stream.destroy();
            reject(new SafeFetchError("too_large", `Response exceeds ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => resolve({ status, headers: h, body: Buffer.concat(chunks) }));
        stream.on("error", (err) => reject(err));
        res.on("error", (err) => reject(err));
      },
    );
    req.on("error", (err) => {
      // The lookup hook's SafeFetchError surfaces here.
      const cause = (err as { cause?: unknown }).cause;
      reject(err instanceof SafeFetchError ? err : cause instanceof SafeFetchError ? cause : err);
    });
    req.end(body);
  });
}
