import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/env", () => ({ getEnv: () => ({ FETCH_USER_AGENT: "SecWire/test" }) }));

const { SafeFetchError, isPublicAddress, safeFetch } = await import("@/lib/safe-fetch");

// Tests talk to a loopback server, so allow exactly 127.0.0.1 and keep every
// other policy decision the production one.
const allowLoopback = (addr: string, fam: 4 | 6) => addr === "127.0.0.1" || isPublicAddress(addr, fam);

let server: http.Server;
let base: string;
let lastUserAgent: string | undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastUserAgent = req.headers["user-agent"];
    const u = new URL(req.url ?? "/", "http://x");
    switch (u.pathname) {
      case "/ok":
        res.setHeader("etag", '"v1"');
        return res.end("hello");
      case "/304":
        res.statusCode = 304;
        return res.end();
      case "/redirect":
        res.statusCode = 302;
        res.setHeader("location", "/ok");
        return res.end();
      case "/loop":
        res.statusCode = 302;
        res.setHeader("location", "/loop");
        return res.end();
      case "/to-metadata":
        res.statusCode = 301;
        res.setHeader("location", "http://169.254.169.254/latest/meta-data/");
        return res.end();
      case "/to-localhost-name":
        res.statusCode = 301;
        res.setHeader("location", `http://localhost:${(server.address() as AddressInfo).port}/ok`);
        return res.end();
      case "/to-file":
        res.statusCode = 302;
        res.setHeader("location", "file:///etc/passwd");
        return res.end();
      case "/big":
        res.setHeader("content-length", String(2_000));
        return res.end("x".repeat(2_000));
      case "/big-chunked":
        res.write("x".repeat(1_500));
        return res.end("x".repeat(1_500));
      case "/gzip-bomb":
        res.setHeader("content-encoding", "gzip");
        return res.end(zlib.gzipSync(Buffer.alloc(50_000)));
      case "/gzip":
        res.setHeader("content-encoding", "gzip");
        return res.end(zlib.gzipSync("compressed hello"));
      case "/hang":
        return; // never respond
      default:
        res.statusCode = 404;
        return res.end("nope");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const get = (path: string, extra: Parameters<typeof safeFetch>[1] = {}) =>
  safeFetch(`${base}${path}`, { addressPolicy: allowLoopback, ...extra });

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(SafeFetchError);
  await expect(p).rejects.toMatchObject({ code });
}

describe("isPublicAddress", () => {
  it.each([
    ["127.0.0.1", 4],
    ["10.1.2.3", 4],
    ["172.16.0.1", 4],
    ["172.31.255.255", 4],
    ["192.168.1.1", 4],
    ["169.254.169.254", 4],
    ["100.64.0.1", 4],
    ["0.0.0.0", 4],
    ["255.255.255.255", 4],
    ["224.0.0.1", 4],
    ["::1", 6],
    ["::", 6],
    ["::ffff:127.0.0.1", 6],
    ["::ffff:7f00:1", 6],
    ["::ffff:8.8.8.8", 6],
    ["fe80::1", 6],
    ["fd00:ec2::254", 6],
    ["fc00::1", 6],
    ["64:ff9b::a00:1", 6],
    ["2002:7f00:1::", 6],
    ["ff02::1", 6],
    ["[::1]", 6],
    ["fe80::1%en0", 6],
  ] as const)("blocks %s", (addr, fam) => {
    expect(isPublicAddress(addr, fam)).toBe(false);
  });

  it.each([
    ["8.8.8.8", 4],
    ["1.1.1.1", 4],
    ["172.32.0.1", 4],
    ["2606:4700:4700::1111", 6],
    ["2a00:1450:4001::1", 6],
  ] as const)("allows %s", (addr, fam) => {
    expect(isPublicAddress(addr, fam)).toBe(true);
  });

  it("rejects garbage and family mismatches", () => {
    expect(isPublicAddress("not-an-ip", 4)).toBe(false);
    expect(isPublicAddress("8.8.8.8", 6)).toBe(false);
  });
});

describe("safeFetch", () => {
  it("fetches a body with the identifying User-Agent", async () => {
    const res = await get("/ok");
    expect(res.status).toBe(200);
    expect(res.text()).toBe("hello");
    expect(res.headers.get("etag")).toBe('"v1"');
    expect(lastUserAgent).toBe("SecWire/test");
  });

  it("passes 304 through with an empty body", async () => {
    const res = await get("/304", { headers: { "if-none-match": '"v1"' } });
    expect(res.status).toBe(304);
    expect(res.body.length).toBe(0);
  });

  it("returns non-2xx responses without throwing", async () => {
    expect((await get("/missing")).status).toBe(404);
  });

  it("follows redirects and reports the final URL", async () => {
    const res = await get("/redirect");
    expect(res.text()).toBe("hello");
    expect(res.url).toBe(`${base}/ok`);
    expect(res.redirects).toBe(1);
  });

  it("caps redirects", async () => {
    await expectCode(get("/loop"), "too_many_redirects");
  });

  it("re-checks every redirect hop against the address policy (IP literal)", async () => {
    await expectCode(get("/to-metadata"), "blocked_address");
  });

  it("re-checks every redirect hop against the address policy (DNS name)", async () => {
    // Allow only the *first* 127.0.0.1 check (the initial IP-literal request).
    // The redirect to `localhost` then goes through DNS + the production policy.
    let loopbackChecks = 0;
    const policy = (a: string, f: 4 | 6) =>
      a === "127.0.0.1" && loopbackChecks++ === 0 ? true : isPublicAddress(a, f);
    await expectCode(safeFetch(`${base}/to-localhost-name`, { addressPolicy: policy }), "blocked_address");
  });

  it("refuses non-http(s) redirect targets", async () => {
    await expectCode(get("/to-file"), "bad_url");
  });

  it("blocks private targets under the default policy", async () => {
    await expectCode(safeFetch(`${base}/ok`), "blocked_address");
    await expectCode(safeFetch("http://[::1]/"), "blocked_address");
    await expectCode(safeFetch("http://169.254.169.254/latest/meta-data/"), "blocked_address");
    await expectCode(safeFetch("http://localhost/"), "blocked_address");
  });

  it("rejects bad URLs and credentials", async () => {
    await expectCode(safeFetch("javascript:alert(1)"), "bad_url");
    await expectCode(safeFetch("not a url"), "bad_url");
    await expectCode(safeFetch("https://user:pw@example.com/"), "bad_url");
  });

  it("enforces the size cap via content-length and while streaming", async () => {
    await expectCode(get("/big", { maxBytes: 1_000 }), "too_large");
    await expectCode(get("/big-chunked", { maxBytes: 2_000 }), "too_large");
  });

  it("decompresses gzip and applies the cap to decompressed bytes", async () => {
    expect((await get("/gzip")).text()).toBe("compressed hello");
    await expectCode(get("/gzip-bomb", { maxBytes: 10_000 }), "too_large");
  });

  it("times out", async () => {
    await expectCode(get("/hang", { timeoutMs: 200 }), "timeout");
  });

  it("honours an external abort signal", async () => {
    const ac = new AbortController();
    const p = get("/hang", { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expectCode(p, "aborted");
  });
});
