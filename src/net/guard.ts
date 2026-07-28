/**
 * Outbound destination guard (SSRF).
 *
 * mcp-fit makes outbound requests to destinations that are, in whole or in
 * part, chosen by untrusted input:
 *   - `card --url <url>`      — a URL the operator supplied, but which may be
 *                               an unreviewed third-party origin.
 *   - the A2A `jku` JWKS fetch — a URL read out of the *inside* of the very
 *                               card being scored. Fully attacker-chosen.
 *
 * Without a guard, either path can be pointed at the cloud metadata endpoint
 * (169.254.169.254), at a service bound to loopback, or at an RFC1918 host
 * reachable only from the machine running the scan. That is textbook SSRF: the
 * tool becomes the attacker's HTTP client on a network they cannot reach.
 *
 * Design — three properties, in order of how often they are got wrong:
 *
 *   1. CLASSIFY RESOLVED ADDRESSES, NOT HOSTNAME STRINGS. A string check is
 *      trivially bypassed: `http://2130706433/`, `http://0177.0.0.1/`,
 *      `http://[::ffff:127.0.0.1]/`, and `http://internal.example.com/` (an
 *      A record pointing at 169.254.169.254) are all loopback/link-local and
 *      none of them look it. Everything here runs on parsed address bytes,
 *      and hostnames are resolved before classification. Node's `getaddrinfo`
 *      normalises the numeric-literal forms itself, so resolve-then-check
 *      absorbs that whole bypass class.
 *
 *   2. RE-CHECK EVERY REDIRECT HOP. `fetch` follows redirects by default, so a
 *      guarded first hop is worth nothing if hop two is a 302 to the metadata
 *      IP. `guardedFetch` uses `redirect: 'manual'` and guards each `Location`.
 *
 *   3. FAIL CLOSED. An address that cannot be resolved, cannot be parsed, or
 *      is of an unrecognised shape is refused, not allowed. A guard whose
 *      unknown case is "permit" is a guard that an attacker only has to
 *      confuse rather than defeat.
 *
 * KNOWN RESIDUAL — DNS rebinding. The address is resolved here for the check
 * and resolved again by the HTTP stack for the connection. A hostile
 * authoritative server answering with a short TTL can return a public address
 * to the first lookup and a private one to the second. Closing that window
 * requires pinning the checked IP into the socket (a custom dispatcher/lookup),
 * which is undici-specific and out of scope for a `node >= 18` npx tool. This
 * is documented rather than papered over: the guard raises the cost of SSRF
 * substantially and does not claim to eliminate it. See `RESIDUAL_RISK`.
 */

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

// ---------------------------------------------------------------------------
// Address parsing — strict, canonical, no clever string matching
// ---------------------------------------------------------------------------

/**
 * Parse a strict dotted-decimal IPv4 address to 4 bytes.
 *
 * Strict on purpose: leading zeros (`0177.0.0.1`, octal to `getaddrinfo`) and
 * short forms (`127.1`) are REJECTED here rather than guessed at. Anything
 * rejected falls through to DNS resolution, where `getaddrinfo` canonicalises
 * it and the result gets classified properly.
 */
export function parseIpv4(address: string): Uint8Array | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i] as string;
    // No leading zeros: '0' is fine, '01' is not (it is octal to inet_aton).
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

/** Parse an IPv6 address (including `::` compression and IPv4 tails) to 16 bytes. */
export function parseIpv6(address: string): Uint8Array | null {
  // Drop any zone index ('fe80::1%en0') — it is interface scope, not address.
  const bare = (address.split('%')[0] as string).replace(/^\[|\]$/g, '');
  const halves = bare.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const groups = part.split(':');
    for (const [index, group] of groups.entries()) {
      if (group.includes('.')) {
        // An IPv4 tail is only legal as the final element.
        if (index !== groups.length - 1) return null;
        const v4 = parseIpv4(group);
        if (v4 === null) return null;
        out.push(((v4[0] as number) << 8) | (v4[1] as number));
        out.push(((v4[2] as number) << 8) | (v4[3] as number));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  const head = parseGroups(halves[0] as string);
  if (head === null) return null;

  let groups: number[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const tail = parseGroups(halves[1] as string);
    if (tail === null) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  }

  const bytes = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** An IPv4 CIDR block, pre-parsed into a network integer + prefix length. */
interface Cidr4 {
  readonly network: number;
  readonly prefix: number;
  readonly label: string;
}

const cidr4 = (block: string, label: string): Cidr4 => {
  const [address, bits] = block.split('/') as [string, string];
  const bytes = parseIpv4(address) as Uint8Array;
  const network =
    (((bytes[0] as number) << 24) |
      ((bytes[1] as number) << 16) |
      ((bytes[2] as number) << 8) |
      (bytes[3] as number)) >>>
    0;
  return { network, prefix: Number(bits), label };
};

/**
 * IPv4 ranges that an outbound fetch from mcp-fit must never reach.
 *
 * Every entry is either non-routable on the public internet or names a host
 * that is only meaningful from *inside* the network running the scan — which
 * is exactly the reachability an SSRF is trying to borrow.
 */
const BLOCKED_V4: readonly Cidr4[] = [
  cidr4('0.0.0.0/8', 'this-network'),
  cidr4('10.0.0.0/8', 'private (RFC1918)'),
  cidr4('100.64.0.0/10', 'carrier-grade NAT / tailnet (RFC6598)'),
  cidr4('127.0.0.0/8', 'loopback'),
  cidr4('169.254.0.0/16', 'link-local — includes the cloud metadata endpoint'),
  cidr4('172.16.0.0/12', 'private (RFC1918)'),
  cidr4('192.0.0.0/24', 'IETF protocol assignments'),
  cidr4('192.168.0.0/16', 'private (RFC1918)'),
  cidr4('198.18.0.0/15', 'benchmarking (RFC2544)'),
  cidr4('224.0.0.0/4', 'multicast'),
  cidr4('240.0.0.0/4', 'reserved — includes broadcast'),
];

/** Classify 4 IPv4 bytes; returns the block label when blocked, else null. */
function classifyIpv4(bytes: Uint8Array): string | null {
  const value =
    (((bytes[0] as number) << 24) |
      ((bytes[1] as number) << 16) |
      ((bytes[2] as number) << 8) |
      (bytes[3] as number)) >>>
    0;
  for (const { network, prefix, label } of BLOCKED_V4) {
    // A /0 mask would shift by 32, which is a no-op in JS — not reachable
    // from the table above, but guarded so a future /0 entry cannot silently
    // match nothing.
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((value & mask) >>> 0 === network) return label;
  }
  return null;
}

/** Classify 16 IPv6 bytes; returns the block label when blocked, else null. */
function classifyIpv6(bytes: Uint8Array): string | null {
  const b = (i: number): number => bytes[i] as number;

  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) carry a real IPv4
  // address in the low 32 bits — unwrap and classify it as IPv4, otherwise
  // `::ffff:169.254.169.254` walks straight past an IPv6-only check.
  const isV4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && b(10) === 0xff && b(11) === 0xff;
  const isNat64 =
    b(0) === 0x00 && b(1) === 0x64 && b(2) === 0xff && b(3) === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);
  if (isV4Mapped || isNat64) {
    const embedded = classifyIpv4(bytes.slice(12, 16));
    return embedded ?? null;
  }

  // 6to4 (2002::/16) embeds an IPv4 address in bytes 2..5.
  if (b(0) === 0x20 && b(1) === 0x02) {
    const embedded = classifyIpv4(bytes.slice(2, 6));
    if (embedded !== null) return `6to4 wrapping ${embedded}`;
  }

  if (bytes.every((byte) => byte === 0)) return 'unspecified (::)';
  if (bytes.slice(0, 15).every((byte) => byte === 0) && b(15) === 1) return 'loopback (::1)';
  if ((b(0) & 0xfe) === 0xfc) return 'unique local (fc00::/7)';
  if (b(0) === 0xfe && (b(1) & 0xc0) === 0x80) return 'link-local (fe80::/10)';
  if (b(0) === 0xff) return 'multicast (ff00::/8)';
  return null;
}

/**
 * Classify a resolved IP address string.
 *
 * Returns a human-readable reason when the address must be refused, or `null`
 * when it is an ordinary public address. Fails closed: an address that cannot
 * be parsed is refused with a reason, never silently allowed.
 */
export function classifyAddress(address: string): string | null {
  const family = isIP(address);
  if (family === 4) {
    const bytes = parseIpv4(address);
    return bytes === null ? 'unparseable IPv4 address' : classifyIpv4(bytes);
  }
  if (family === 6) {
    const bytes = parseIpv6(address);
    return bytes === null ? 'unparseable IPv6 address' : classifyIpv6(bytes);
  }
  return 'not an IP address';
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Why a destination was refused. Stable identifiers — safe to assert on. */
export type BlockReason =
  | 'scheme-not-allowed'
  | 'unresolvable-host'
  | 'blocked-address'
  | 'too-many-redirects'
  | 'redirect-without-location';

/**
 * Thrown when a destination is refused. Carries the machine-readable reason
 * and the offending address so callers can report precisely what was blocked
 * (an error that says only "blocked" is an error nobody can act on).
 */
export class BlockedDestinationError extends Error {
  readonly reason: BlockReason;
  readonly url: string;
  readonly address: string | null;

  constructor(reason: BlockReason, url: string, detail: string, address: string | null = null) {
    super(`refusing to fetch ${url}: ${detail}`);
    this.name = 'BlockedDestinationError';
    this.reason = reason;
    this.url = url;
    this.address = address;
  }
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

/** Resolver shape — injectable so tests never touch real DNS. */
export type LookupLike = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

/** Minimal response shape the guard needs. The global `Response` satisfies it. */
export interface GuardedResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** Minimal fetch shape — injectable for tests, satisfied by the global `fetch`. */
export type GuardedFetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; redirect?: 'manual' },
) => Promise<GuardedResponse>;

export interface GuardOptions {
  /**
   * Permit private, loopback and link-local destinations.
   *
   * DEFAULT FALSE, and it must stay false on any path where the destination
   * comes from untrusted content (the `jku` fetch). It exists for the operator
   * scanning an agent they are running on their own machine — a real workflow,
   * but one that must be asked for out loud rather than assumed.
   */
  allowPrivate?: boolean;
  /** Redirect hops to follow, each one re-guarded. 0 refuses all redirects. */
  maxRedirects?: number;
  /** Injectable resolver (tests). */
  lookupImpl?: LookupLike;
  /** Injectable fetch (tests). */
  fetchImpl?: GuardedFetchLike;
}

/** Schemes we will originate a request on. Everything else is refused. */
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Stated plainly so it can be quoted rather than re-derived: what this guard
 * does NOT close. Distinct from the eval isolation posture — that describes
 * containment of the SPAWNED SERVER; this is about our own outbound requests.
 */
export const RESIDUAL_RISK =
  'DNS rebinding: the address is resolved for the check and again for the ' +
  'connection, so a hostile short-TTL resolver can differ between the two.';

/**
 * Assert that `rawUrl` is a destination we are willing to contact.
 *
 * Resolves the hostname and classifies EVERY returned address — a name with
 * one public and one private A record is refused, because which one the socket
 * picks is not ours to choose.
 *
 * @returns the parsed URL when allowed.
 * @throws {BlockedDestinationError} when refused.
 */
export async function assertDestinationAllowed(
  rawUrl: string,
  options: GuardOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedDestinationError('scheme-not-allowed', rawUrl, 'not a valid absolute URL');
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new BlockedDestinationError(
      'scheme-not-allowed',
      rawUrl,
      `scheme '${url.protocol}' is not http(s)`,
    );
  }

  if (options.allowPrivate === true) return url;

  // `URL.hostname` strips the brackets from an IPv6 literal already.
  const host = url.hostname;
  let addresses: string[];

  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    const resolver = options.lookupImpl ?? (lookup as unknown as LookupLike);
    try {
      addresses = (await resolver(host, { all: true })).map((entry) => entry.address);
    } catch {
      throw new BlockedDestinationError('unresolvable-host', rawUrl, `cannot resolve '${host}'`);
    }
    if (addresses.length === 0) {
      throw new BlockedDestinationError(
        'unresolvable-host',
        rawUrl,
        `'${host}' resolved to no addresses`,
      );
    }
  }

  for (const address of addresses) {
    const blocked = classifyAddress(address);
    if (blocked !== null) {
      throw new BlockedDestinationError(
        'blocked-address',
        rawUrl,
        `'${host}' resolves to ${address} — ${blocked}`,
        address,
      );
    }
  }

  return url;
}

/**
 * Fetch `rawUrl` with the destination guard applied to the initial request AND
 * to every redirect hop.
 *
 * Redirects are followed manually (`redirect: 'manual'`); an automatic-redirect
 * fetch would guard hop one and then obediently walk to wherever hop two points.
 *
 * @throws {BlockedDestinationError} when any hop is refused.
 */
export async function guardedFetch(
  rawUrl: string,
  init: { headers?: Record<string, string> } = {},
  options: GuardOptions = {},
): Promise<GuardedResponse> {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as GuardedFetchLike);
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let target = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const url = await assertDestinationAllowed(target, options);
    const response = await fetchImpl(url.toString(), { ...init, redirect: 'manual' });

    const isRedirect =
      response.status === 301 ||
      response.status === 302 ||
      response.status === 303 ||
      response.status === 307 ||
      response.status === 308;
    if (!isRedirect) return response;

    const location = response.headers.get('location');
    if (location === null || location === '') {
      throw new BlockedDestinationError(
        'redirect-without-location',
        target,
        `HTTP ${response.status} with no Location header`,
      );
    }
    // Relative redirects are legal; resolve against the hop we just made.
    target = new URL(location, url).toString();
  }

  throw new BlockedDestinationError(
    'too-many-redirects',
    rawUrl,
    `exceeded ${maxRedirects} redirect hops`,
  );
}
