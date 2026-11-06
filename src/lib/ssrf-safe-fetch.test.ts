import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));
vi.mock("node:http", () => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));

import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import {
  fetchPublicUrlSafely,
  resolveAllSafe,
  isBlockedAddress,
  UnsafeUrlError,
} from "./ssrf-safe-fetch";

const mockedLookup = vi.mocked(dnsLookup);
const mockedHttpRequest = vi.mocked(http.request);
const mockedHttpsRequest = vi.mocked(https.request);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isBlockedAddress — IP range checks", () => {
  it("blocks IPv4 loopback", () => {
    expect(isBlockedAddress("127.0.0.1", 4)).toBe(true);
  });
  it("blocks IPv4 private ranges (10/8, 172.16/12, 192.168/16)", () => {
    expect(isBlockedAddress("10.0.0.1", 4)).toBe(true);
    expect(isBlockedAddress("172.16.5.5", 4)).toBe(true);
    expect(isBlockedAddress("172.31.255.255", 4)).toBe(true);
    expect(isBlockedAddress("192.168.1.1", 4)).toBe(true);
  });
  it("blocks IPv4 link-local, including the cloud metadata endpoint", () => {
    expect(isBlockedAddress("169.254.1.1", 4)).toBe(true);
    expect(isBlockedAddress("169.254.169.254", 4)).toBe(true);
  });
  it("blocks IPv4 carrier-grade NAT and test-net ranges", () => {
    expect(isBlockedAddress("100.64.0.1", 4)).toBe(true);
    expect(isBlockedAddress("192.0.2.1", 4)).toBe(true);
    expect(isBlockedAddress("198.51.100.1", 4)).toBe(true);
    expect(isBlockedAddress("203.0.113.1", 4)).toBe(true);
  });
  it("allows ordinary public IPv4 addresses", () => {
    expect(isBlockedAddress("8.8.8.8", 4)).toBe(false);
    expect(isBlockedAddress("93.184.216.34", 4)).toBe(false);
  });
  it("blocks IPv6 loopback and unspecified", () => {
    expect(isBlockedAddress("::1", 6)).toBe(true);
    expect(isBlockedAddress("::", 6)).toBe(true);
  });
  it("blocks IPv6 link-local and unique-local (ULA)", () => {
    expect(isBlockedAddress("fe80::1", 6)).toBe(true);
    expect(isBlockedAddress("fc00::1", 6)).toBe(true);
    expect(isBlockedAddress("fd12:3456:789a::1", 6)).toBe(true);
  });
  it("allows ordinary public IPv6 addresses", () => {
    expect(isBlockedAddress("2001:4860:4860::8888", 6)).toBe(false);
  });
  it("blocks an IPv4-mapped IPv6 address whose embedded IPv4 is private — the exact bypass shape this check exists for", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1", 6)).toBe(true);
    expect(isBlockedAddress("::ffff:10.0.0.1", 6)).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254", 6)).toBe(true);
  });
  it("allows an IPv4-mapped IPv6 address whose embedded IPv4 is public", () => {
    expect(isBlockedAddress("::ffff:8.8.8.8", 6)).toBe(false);
  });
});

describe("resolveAllSafe — DNS resolution + validation", () => {
  it("rejects a hostname resolving to loopback", async () => {
    mockedLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as any);
    await expect(resolveAllSafe("evil.example")).rejects.toThrow(UnsafeUrlError);
  });
  it("rejects a hostname resolving to a private IPv4 address", async () => {
    mockedLookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }] as any);
    await expect(resolveAllSafe("internal.example")).rejects.toThrow(UnsafeUrlError);
  });
  it("rejects a hostname resolving to a private IPv6 address", async () => {
    mockedLookup.mockResolvedValue([{ address: "fd00::1", family: 6 }] as any);
    await expect(resolveAllSafe("internal6.example")).rejects.toThrow(UnsafeUrlError);
  });
  it("rejects a hostname resolving to a link-local address", async () => {
    mockedLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }] as any);
    await expect(resolveAllSafe("metadata.example")).rejects.toThrow(UnsafeUrlError);
  });
  it("rejects MIXED DNS results — one public and one private address — not just checking the first result", async () => {
    mockedLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ] as any);
    await expect(resolveAllSafe("rebinding.example")).rejects.toThrow(UnsafeUrlError);
  });
  it("accepts a hostname resolving only to public addresses", async () => {
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as any);
    const result = await resolveAllSafe("example.com");
    expect(result).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
  it("rejects when DNS resolution itself fails", async () => {
    mockedLookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(resolveAllSafe("nonexistent.example")).rejects.toThrow(UnsafeUrlError);
  });
  it("never leaks the resolved address or which range matched in its error message", async () => {
    mockedLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }] as any);
    let caught: unknown;
    try {
      await resolveAllSafe("metadata.example");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsafeUrlError);
    expect((caught as Error).message).not.toContain("169.254");
  });
});

// A minimal fake ClientRequest/IncomingMessage pair that mimics just
// enough of node:http's real event-emitter shape for fetchPublicUrlSafely
// to drive end to end, including actually invoking the `lookup` option
// it was given — the same way Node's real http.request would — so the
// DNS-rebinding test below can prove no second, independent resolution
// ever happens for the connection itself.
function makeFakeRequest(opts: {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  onLookupCalled?: (hostname: string, pinnedFamily: number) => void;
}) {
  const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
  req.end = vi.fn();
  req.destroy = vi.fn();
  return (requestOptions: any, callback: (res: any) => void) => {
    // Exercise the real `lookup` function exactly as Node would — this
    // is what proves pinning happens: if this ever called the REAL
    // dns.lookup instead of using the pre-resolved address, that would
    // be the rebinding bug this module exists to prevent.
    requestOptions.lookup(
      "ignored-by-pin.example",
      { family: 0 },
      (_err: unknown, address: string, family: number) => {
        opts.onLookupCalled?.(address, family);
      },
    );
    queueMicrotask(() => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
      };
      res.statusCode = opts.status;
      res.headers = opts.headers ?? {};
      callback(res);
      queueMicrotask(() => {
        if (opts.body) res.emit("data", Buffer.from(opts.body));
        res.emit("end");
      });
    });
    return req;
  };
}

describe("fetchPublicUrlSafely — full pipeline", () => {
  it("rejects an obviously-unsafe host (literal 'localhost') without ever calling DNS", async () => {
    await expect(fetchPublicUrlSafely("http://localhost/")).rejects.toThrow(UnsafeUrlError);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("rejects a non-http(s) protocol without ever calling DNS", async () => {
    await expect(fetchPublicUrlSafely("file:///etc/passwd")).rejects.toThrow(UnsafeUrlError);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("rejects a public-looking hostname that actually resolves to a private address", async () => {
    mockedLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }] as any);
    await expect(fetchPublicUrlSafely("https://looks-public.example/")).rejects.toThrow(
      UnsafeUrlError,
    );
    expect(mockedHttpsRequest).not.toHaveBeenCalled();
  });

  it("fetches a normal public HTTPS URL successfully, pinning the connection to the validated address", async () => {
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as any);
    let pinnedAddress: string | undefined;
    mockedHttpsRequest.mockImplementation(
      makeFakeRequest({
        status: 200,
        body: "<html>hello</html>",
        onLookupCalled: (addr) => {
          pinnedAddress = addr;
        },
      }) as any,
    );
    const response = await fetchPublicUrlSafely("https://example.com/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>hello</html>");
    expect(pinnedAddress).toBe("93.184.216.34");
    // Exactly one DNS resolution for this one hop — the connection
    // itself never triggers a second, independent lookup.
    expect(mockedLookup).toHaveBeenCalledTimes(1);
  });

  it("DNS rebinding: the connection is pinned to the already-validated address, never re-resolved at connect time", async () => {
    // Simulates the attack this module defends against: if the real
    // dns.lookup were called again for the connection, a rebinding DNS
    // server could answer with a private address the second time. This
    // test proves the `lookup` function handed to http(s).request is a
    // pure pass-through to the pre-validated address, not a fresh call
    // to the mocked (or real) resolver.
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as any);
    let lookupCallbackAddress: string | undefined;
    mockedHttpsRequest.mockImplementation(
      makeFakeRequest({
        status: 200,
        body: "ok",
        onLookupCalled: (addr) => {
          lookupCallbackAddress = addr;
        },
      }) as any,
    );
    await fetchPublicUrlSafely("https://example.com/");
    expect(lookupCallbackAddress).toBe("93.184.216.34");
    expect(mockedLookup).toHaveBeenCalledTimes(1); // not called again for the connection
  });

  it("follows a redirect to a safe destination, re-validating the new hostname independently", async () => {
    mockedLookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as any) // first hop
      .mockResolvedValueOnce([{ address: "93.184.216.50", family: 4 }] as any); // redirect target
    let callCount = 0;
    mockedHttpsRequest.mockImplementation(((requestOptions: any, callback: (res: any) => void) => {
      callCount++;
      const isFirstHop = callCount === 1;
      return makeFakeRequest(
        isFirstHop
          ? { status: 302, headers: { location: "https://example.com/final" } }
          : { status: 200, body: "final page" },
      )(requestOptions, callback);
    }) as any);
    const response = await fetchPublicUrlSafely("https://example.com/start");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("final page");
    expect(mockedLookup).toHaveBeenCalledTimes(2); // one per hop, each independently validated
  });

  it("rejects a redirect whose destination resolves to a private address — the exact bypass this module closes", async () => {
    mockedLookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as any) // first hop looks fine
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as any); // redirect target is not
    mockedHttpsRequest.mockImplementation(
      makeFakeRequest({
        status: 302,
        headers: { location: "https://internal.example/secret" },
      }) as any,
    );
    await expect(fetchPublicUrlSafely("https://example.com/start")).rejects.toThrow(UnsafeUrlError);
  });

  it("rejects a redirect chain that exceeds the configured maximum", async () => {
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as any);
    mockedHttpsRequest.mockImplementation(
      makeFakeRequest({ status: 302, headers: { location: "https://example.com/loop" } }) as any,
    );
    await expect(
      fetchPublicUrlSafely("https://example.com/start", { maxRedirects: 2 }),
    ).rejects.toThrow(UnsafeUrlError);
  });
});
