/**
 * Tests for the outbound destination guard (SSRF).
 *
 * The cases that matter are the BYPASSES, not the happy path: a guard that
 * only rejects the literal string '127.0.0.1' passes a naive test suite and
 * fails in production. Every obfuscated spelling of a blocked address that a
 * real attacker would reach for gets its own case here.
 *
 * DNS and network are injected throughout — these tests make no real requests.
 */

import { describe, it, expect } from 'vitest';
import {
  BlockedDestinationError,
  assertDestinationAllowed,
  classifyAddress,
  guardedFetch,
  parseIpv4,
  parseIpv6,
  type GuardedResponse,
  type LookupLike,
} from '../guard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A resolver that always answers with `addresses`, whatever the hostname. */
const resolverReturning = (...addresses: string[]): LookupLike =>
  async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

/** A resolver that always fails, as a hostile or dead nameserver would. */
const failingResolver: LookupLike = async () => {
  throw new Error('NXDOMAIN');
};

const response = (
  status: number,
  headers: Record<string, string> = {},
): GuardedResponse => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => '',
  json: async () => ({}),
});

/** Assert the call was refused, and with the reason we expect. */
async function expectBlocked(
  promise: Promise<unknown>,
  reason: BlockedDestinationError['reason'],
): Promise<BlockedDestinationError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(BlockedDestinationError);
  const blocked = error as BlockedDestinationError;
  expect(blocked.reason).toBe(reason);
  return blocked;
}

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

describe('parseIpv4', () => {
  it('parses canonical dotted-decimal', () => {
    expect(Array.from(parseIpv4('169.254.169.254') as Uint8Array)).toEqual([169, 254, 169, 254]);
  });

  it('rejects leading zeros — 0177.0.0.1 is octal to getaddrinfo, not 177', () => {
    expect(parseIpv4('0177.0.0.1')).toBeNull();
  });

  it('rejects short forms and out-of-range octets', () => {
    expect(parseIpv4('127.1')).toBeNull();
    expect(parseIpv4('256.0.0.1')).toBeNull();
  });
});

describe('parseIpv6', () => {
  it('expands :: compression', () => {
    expect(Array.from(parseIpv6('::1') as Uint8Array)).toEqual([...new Array(15).fill(0), 1]);
    expect(Array.from(parseIpv6('::') as Uint8Array)).toEqual(new Array(16).fill(0));
  });

  it('parses an IPv4 tail', () => {
    const bytes = parseIpv6('::ffff:127.0.0.1') as Uint8Array;
    expect(Array.from(bytes.slice(10, 16))).toEqual([0xff, 0xff, 127, 0, 0, 1]);
  });

  it('strips a zone index and brackets', () => {
    expect(parseIpv6('[fe80::1%en0]')).not.toBeNull();
  });

  it('rejects a double :: and over-long groups', () => {
    expect(parseIpv6('1::2::3')).toBeNull();
    expect(parseIpv6('12345::1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('classifyAddress', () => {
  it('blocks the cloud metadata endpoint', () => {
    expect(classifyAddress('169.254.169.254')).toMatch(/link-local/);
  });

  it.each([
    ['127.0.0.1', /loopback/],
    ['10.1.2.3', /RFC1918/],
    ['172.16.0.1', /RFC1918/],
    ['192.168.1.1', /RFC1918/],
    ['100.64.0.1', /carrier-grade NAT/],
    ['0.0.0.0', /this-network/],
    ['255.255.255.255', /reserved/],
    ['224.0.0.1', /multicast/],
  ])('blocks %s', (address, pattern) => {
    expect(classifyAddress(address)).toMatch(pattern);
  });

  it.each([
    ['::1', /loopback/],
    ['::', /unspecified/],
    ['fd00::1', /unique local/],
    ['fe80::1', /link-local/],
    ['ff02::1', /multicast/],
  ])('blocks IPv6 %s', (address, pattern) => {
    expect(classifyAddress(address)).toMatch(pattern);
  });

  it('unwraps IPv4-mapped IPv6 — ::ffff:169.254.169.254 is the metadata IP', () => {
    expect(classifyAddress('::ffff:169.254.169.254')).toMatch(/link-local/);
  });

  it('unwraps a 6to4 address wrapping a private IPv4', () => {
    // 2002:c0a8:0101:: embeds 192.168.1.1.
    expect(classifyAddress('2002:c0a8:101::')).toMatch(/6to4/);
  });

  it('unwraps NAT64 (64:ff9b::/96)', () => {
    expect(classifyAddress('64:ff9b::7f00:1')).toMatch(/loopback/);
  });

  it('allows ordinary public addresses', () => {
    expect(classifyAddress('93.184.216.34')).toBeNull();
    expect(classifyAddress('2606:2800:220:1::')).toBeNull();
  });

  it('fails closed on anything that is not a parseable address', () => {
    expect(classifyAddress('not-an-ip')).toBe('not an IP address');
  });
});

// ---------------------------------------------------------------------------
// assertDestinationAllowed
// ---------------------------------------------------------------------------

describe('assertDestinationAllowed', () => {
  it('allows a public destination', async () => {
    const url = await assertDestinationAllowed('https://agent.example.com/card', {
      lookupImpl: resolverReturning('93.184.216.34'),
    });
    expect(url.host).toBe('agent.example.com');
  });

  it('blocks the metadata IP given as a literal', async () => {
    const blocked = await expectBlocked(
      assertDestinationAllowed('http://169.254.169.254/latest/meta-data/'),
      'blocked-address',
    );
    expect(blocked.address).toBe('169.254.169.254');
  });

  it('blocks a public-looking hostname that RESOLVES to the metadata IP', async () => {
    // The whole point of resolve-then-classify: nothing about this string is
    // suspicious.
    await expectBlocked(
      assertDestinationAllowed('https://metadata.example.com/', {
        lookupImpl: resolverReturning('169.254.169.254'),
      }),
      'blocked-address',
    );
  });

  it('blocks when ANY resolved address is private, not just the first', async () => {
    await expectBlocked(
      assertDestinationAllowed('https://split.example.com/', {
        lookupImpl: resolverReturning('93.184.216.34', '127.0.0.1'),
      }),
      'blocked-address',
    );
  });

  it.each(['file:///etc/passwd', 'gopher://example.com/', 'ftp://example.com/'])(
    'blocks non-http(s) scheme %s',
    async (target) => {
      await expectBlocked(assertDestinationAllowed(target), 'scheme-not-allowed');
    },
  );

  it('fails closed when the host cannot be resolved', async () => {
    await expectBlocked(
      assertDestinationAllowed('https://nope.example.com/', { lookupImpl: failingResolver }),
      'unresolvable-host',
    );
  });

  it('fails closed when the host resolves to nothing', async () => {
    await expectBlocked(
      assertDestinationAllowed('https://empty.example.com/', { lookupImpl: resolverReturning() }),
      'unresolvable-host',
    );
  });

  it('allows a private destination ONLY under the explicit opt-in', async () => {
    await expectBlocked(assertDestinationAllowed('http://localhost:3001/sse'), 'blocked-address');
    const url = await assertDestinationAllowed('http://localhost:3001/sse', {
      allowPrivate: true,
    });
    expect(url.port).toBe('3001');
  });
});

// ---------------------------------------------------------------------------
// guardedFetch — redirects
// ---------------------------------------------------------------------------

describe('guardedFetch', () => {
  it('returns a non-redirect response as-is', async () => {
    const seen: string[] = [];
    const result = await guardedFetch(
      'https://agent.example.com/card',
      {},
      {
        lookupImpl: resolverReturning('93.184.216.34'),
        fetchImpl: async (url) => {
          seen.push(url);
          return response(200);
        },
      },
    );
    expect(result.status).toBe(200);
    expect(seen).toEqual(['https://agent.example.com/card']);
  });

  it('BLOCKS a redirect that lands on the metadata IP', async () => {
    // The case an automatic-redirect fetch gets wrong: hop one is clean.
    await expectBlocked(
      guardedFetch(
        'https://agent.example.com/card',
        {},
        {
          lookupImpl: async (hostname) =>
            hostname === 'agent.example.com'
              ? [{ address: '93.184.216.34', family: 4 }]
              : [{ address: '169.254.169.254', family: 4 }],
          fetchImpl: async (url) =>
            url.includes('agent.example.com')
              ? response(302, { location: 'http://metadata.internal/latest/meta-data/' })
              : response(200),
        },
      ),
      'blocked-address',
    );
  });

  it('follows a permitted redirect and re-guards the hop', async () => {
    const seen: string[] = [];
    const result = await guardedFetch(
      'https://agent.example.com/card',
      {},
      {
        lookupImpl: resolverReturning('93.184.216.34'),
        fetchImpl: async (url) => {
          seen.push(url);
          return url.endsWith('/card')
            ? response(301, { location: '/.well-known/agent-card.json' })
            : response(200);
        },
      },
    );
    expect(result.status).toBe(200);
    expect(seen).toEqual([
      'https://agent.example.com/card',
      'https://agent.example.com/.well-known/agent-card.json',
    ]);
  });

  it('refuses to loop forever on a redirect cycle', async () => {
    await expectBlocked(
      guardedFetch(
        'https://agent.example.com/a',
        {},
        {
          maxRedirects: 2,
          lookupImpl: resolverReturning('93.184.216.34'),
          fetchImpl: async () => response(302, { location: 'https://agent.example.com/a' }),
        },
      ),
      'too-many-redirects',
    );
  });

  it('refuses a redirect with no Location header', async () => {
    await expectBlocked(
      guardedFetch(
        'https://agent.example.com/card',
        {},
        {
          lookupImpl: resolverReturning('93.184.216.34'),
          fetchImpl: async () => response(302),
        },
      ),
      'redirect-without-location',
    );
  });

  it('passes request headers through', async () => {
    let seenHeaders: Record<string, string> | undefined;
    await guardedFetch(
      'https://agent.example.com/card',
      { headers: { accept: 'application/json' } },
      {
        lookupImpl: resolverReturning('93.184.216.34'),
        fetchImpl: async (_url, init) => {
          seenHeaders = init?.headers;
          return response(200);
        },
      },
    );
    expect(seenHeaders).toEqual({ accept: 'application/json' });
  });
});
