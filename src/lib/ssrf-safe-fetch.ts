// SSRF-safe outbound fetch for server-side requests to a URL an
// authenticated user supplies (currently: price-sheet-server.ts's
// extractPriceSheetFromUrl). Deliberately built on Node's own core
// modules (node:dns, node:net, node:http, node:https) rather than a
// third-party package — these are maintained as part of Node.js itself,
// already the exact runtime this app deploys on (Vercel's Node.js
// serverless functions), and node:net's BlockList (stable since Node 15)
// is purpose-built for exactly this "is this address allowed" check.
//
// The core defense, in order:
// 1. Reject anything that isn't http/https before any network activity.
// 2. Resolve the hostname via DNS ourselves, requesting EVERY A/AAAA
//    record (dns.lookup's `all: true`) — not just the first — and
//    reject the whole request if ANY resolved address is private,
//    loopback, link-local, or otherwise reserved. A hostname that
//    resolves to one public and one private address is exactly the
//    shape of a DNS-rebinding setup designed to pass a "check the first
//    result" validator.
// 3. Connect to ONE of the addresses we already validated, via Node's
//    http(s).request's own `lookup` option — a function that stands in
//    for dns.lookup for that one connection. This is the actual
//    DNS-rebinding defense: the address used for the TCP connection is
//    the exact one we checked, never a second, independent DNS lookup
//    that a malicious DNS server could answer differently a few hundred
//    milliseconds later. The original hostname is still used for the
//    HTTP Host header and (over HTTPS) TLS SNI/certificate-hostname
//    validation, so a normal site's certificate still validates
//    correctly — only the raw socket's destination address is pinned.
// 4. Never auto-follow a redirect. Each hop is surfaced to the caller,
//    which re-runs this entire module's validation from scratch on the
//    new URL — a redirect to a private address gets rejected exactly
//    like a direct request to one would, and a redirect chain can't
//    accumulate hops past the caller's own cap.
//
// Tradeoff worth naming: this adds one real DNS round-trip before the
// real request (a few milliseconds, typically well within this
// function's own timeout) that a plain `fetch()` wouldn't pay. That's
// the cost of actually controlling what address gets connected to,
// rather than trusting whatever the platform's default resolver decides
// to do at request time.

import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList } from "node:net";
import * as http from "node:http";
import * as https from "node:https";

// Every range below is a real IANA special-purpose registry entry
// (RFC 1918 private-use, RFC 6598 carrier-grade NAT, RFC 5735/6890
// reserved/test-net/benchmarking, RFC 3927/4291 link-local, RFC 4193
// unique-local, RFC 4291 loopback/multicast, RFC 3056/6052 6to4/NAT64) —
// not an arbitrary partial list. 169.254.0.0/16 alone already covers the
// cloud-metadata endpoint (169.254.169.254) used on AWS/GCP/Azure/etc.
const BLOCKED_IPV4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC 1918 private
  ["100.64.0.0", 10], // RFC 6598 carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. cloud metadata 169.254.169.254)
  ["172.16.0.0", 12], // RFC 1918 private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC 1918 private
  ["198.18.0.0", 15], // benchmark testing
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
  ["255.255.255.255", 32], // limited broadcast
];

const BLOCKED_IPV6_RANGES: Array<[string, number]> = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64
  ["100::", 64], // discard-only
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local (ULA)
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
];

let blockList: BlockList | null = null;
function getBlockList(): BlockList {
  if (blockList) return blockList;
  blockList = new BlockList();
  for (const [net, prefix] of BLOCKED_IPV4_RANGES) blockList.addSubnet(net, prefix, "ipv4");
  for (const [net, prefix] of BLOCKED_IPV6_RANGES) blockList.addSubnet(net, prefix, "ipv6");
  return blockList;
}

// Exported for direct, fast unit testing of the range logic itself,
// without needing to go through DNS resolution or a network request.
export function isBlockedAddress(address: string, family: 4 | 6): boolean {
  // net.BlockList correctly unwraps an IPv4-mapped IPv6 address
  // (::ffff:a.b.c.d) against the IPv4 subnets when checked with the
  // "ipv6" family — confirmed directly against this Node version before
  // relying on it, rather than assumed from documentation alone.
  return getBlockList().check(address, family === 4 ? "ipv4" : "ipv6");
}

export class UnsafeUrlError extends Error {
  constructor(message = "That URL isn't allowed.") {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

// Fast, pre-DNS rejection of the obvious cases (same checks the previous
// isSafePublicUrl had) — purely an early-exit optimization so a request
// we already know is bad doesn't pay for a DNS lookup first. The DNS
// resolution + BlockList check below is what actually enforces safety;
// this function being wrong or incomplete doesn't weaken that.
function hasObviouslyUnsafeHost(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::"
  );
}

type ResolvedAddress = { address: string; family: 4 | 6 };

// Resolves EVERY A/AAAA record for the hostname (not just the first) and
// rejects if any single one is unsafe — a hostname returning one public
// and one private address is exactly what a rebinding setup looks like,
// and checking only the first result would miss it.
// Exported so tests can exercise the validation decision (including the
// "mixed safe/unsafe DNS results" and "hostname resolves to a private
// address" cases) directly against a mocked dns.lookup, without needing
// to also mock the network-request layer for every one of those cases.
export async function resolveAllSafe(hostname: string): Promise<ResolvedAddress[]> {
  let records: ResolvedAddress[];
  try {
    const result = await dnsLookup(hostname, { all: true, verbatim: true });
    records = result.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
  } catch {
    throw new UnsafeUrlError("Couldn't resolve that address.");
  }
  if (records.length === 0) throw new UnsafeUrlError("Couldn't resolve that address.");
  for (const r of records) {
    if (isBlockedAddress(r.address, r.family)) {
      // Deliberately generic — never echo the resolved address or which
      // range matched back to the caller.
      throw new UnsafeUrlError("That address isn't reachable.");
    }
  }
  return records;
}

export type SafeFetchResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: () => Promise<string>;
};

const DEFAULT_MAX_BODY_BYTES = 5_000_000; // 5MB — generous for a web page's HTML, bounded

// The actual pinned request: connects to `pinnedAddress` (already
// validated by the caller) while keeping `parsed`'s own hostname for the
// Host header and, over HTTPS, TLS SNI + certificate hostname checks —
// confirmed this is how Node's own `lookup` option is documented to
// behave (it only replaces address resolution, not the request's
// `Host`/`servername`), not assumed.
function pinnedRequest(
  parsed: URL,
  pinnedAddress: string,
  opts: { timeoutMs: number; userAgent: string; maxBodyBytes: number },
): Promise<SafeFetchResponse> {
  const isHttps = parsed.protocol === "https:";
  const lib = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: { "user-agent": opts.userAgent },
        timeout: opts.timeoutMs,
        // The one line that actually pins the connection: instead of
        // Node resolving parsed.hostname again (a second, independent
        // DNS lookup an attacker's rebinding DNS server could answer
        // differently), this always returns the single address we
        // already validated.
        lookup: (_hostname, lookupOpts, callback) => {
          const family =
            lookupOpts && typeof lookupOpts === "object" && "family" in lookupOpts
              ? (lookupOpts.family as number)
              : 0;
          callback(
            null,
            pinnedAddress,
            family === 6 ? 6 : family === 4 ? 4 : pinnedAddress.includes(":") ? 6 : 4,
          );
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let rejected = false;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > opts.maxBodyBytes) {
            rejected = true;
            req.destroy();
            reject(new UnsafeUrlError("That page was too large to read."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (rejected) return;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: async () => Buffer.concat(chunks).toString("utf-8"),
          });
        });
        res.on("error", (err) => {
          if (!rejected) reject(err);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new UnsafeUrlError("That page took too long to respond."));
    });
    req.on("error", () => {
      reject(new UnsafeUrlError("Couldn't reach that page."));
    });
    req.end();
  });
}

export type SafeFetchOptions = {
  timeoutMs?: number;
  userAgent?: string;
  maxRedirects?: number;
  maxBodyBytes?: number;
};

// Validates and fetches `rawUrl`, following redirects manually: every
// hop is independently resolved and validated from scratch (never just
// "the redirect target looked fine as a string") before being connected
// to, up to `maxRedirects`. Throws UnsafeUrlError (safe to show the
// caller's own message verbatim — it never contains the resolved
// address or which blocked range matched) for anything unsafe, and a
// plain Error for ordinary network failures.
export async function fetchPublicUrlSafely(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResponse> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const userAgent = options.userAgent ?? "Mozilla/5.0 (compatible; JobItReadyBot/1.0)";
  const maxRedirects = options.maxRedirects ?? 3;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new UnsafeUrlError("That doesn't look like a valid web address.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new UnsafeUrlError("Only http:// and https:// addresses are allowed.");
    }
    if (hasObviouslyUnsafeHost(parsed)) {
      throw new UnsafeUrlError("That address isn't reachable.");
    }

    const resolved = await resolveAllSafe(parsed.hostname);
    // Prefer an IPv4 result if one exists (broadest compatibility with
    // Node's request internals); otherwise use the first validated IPv6.
    const pinned = resolved.find((r) => r.family === 4) ?? resolved[0]!;

    const response = await pinnedRequest(parsed, pinned.address, {
      timeoutMs,
      userAgent,
      maxBodyBytes,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location) throw new UnsafeUrlError("That page redirects without a destination.");
      if (hop === maxRedirects) {
        throw new UnsafeUrlError("That page redirects too many times.");
      }
      // Resolve a relative Location header against the current URL —
      // the next loop iteration re-validates it from scratch, exactly
      // like a fresh request, so a redirect to a private address is
      // rejected the same way a direct request to one would be.
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return response;
  }
  // Unreachable in practice (the loop always returns or throws above),
  // but keeps the function's return type honest for the type checker.
  throw new UnsafeUrlError("That page redirects too many times.");
}
