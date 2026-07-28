/**
 * Crypto signature-tier tests (ADR-F4 crypto-pinned / crypto-jku).
 *
 * The spec's §8.4.2 worked example is not self-contained (no public key is
 * published), so the acceptance gate is self-signed round-trip vectors: cards
 * are signed IN-TEST following the §8.4.2 generation steps exactly
 * (default-strip → exclude signatures → JCS → JWS over
 * protected||'.'||payload), then verified by the production verifier —
 * plus the stability property the default-stripping exists for: a card with
 * explicit default values must verify identically to one without them.
 */

import { describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, CompactSign } from 'jose';
import type { JWK } from 'jose';

import type { AgentCardJson } from '../card-types.js';
import {
  canonicalCardPayload,
  keyStoreFromJwks,
  stripDefaults,
  verifyCardSignature,
  type LocalKeyStore,
} from '../verify.js';

// ---------------------------------------------------------------------------
// Test signer — implements §8.4.2 generation exactly
// ---------------------------------------------------------------------------

/** Private-key type via inference — avoids depending on the DOM CryptoKey lib type. */
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

async function makeKeys(alg: 'ES256' | 'EdDSA'): Promise<{
  privateKey: SigningKey;
  publicJwk: JWK;
  store: LocalKeyStore;
}> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid: 'card-key-1', alg };
  return { privateKey, publicJwk, store: { keys: { 'card-key-1': publicJwk } } };
}

async function signCard(
  card: AgentCardJson,
  privateKey: SigningKey,
  alg: string,
  headerExtras: Record<string, unknown> = {},
): Promise<AgentCardJson> {
  const { payload } = canonicalCardPayload(card);
  const jws = await new CompactSign(new TextEncoder().encode(payload))
    .setProtectedHeader({ alg, typ: 'JOSE', kid: 'card-key-1', ...headerExtras })
    .sign(privateKey);
  const [protectedB64, , signatureB64] = jws.split('.');
  return {
    ...card,
    signatures: [{ protected: protectedB64!, signature: signatureB64! }],
  };
}

const BASE_CARD: AgentCardJson = {
  name: 'Signed Agent',
  description: 'A card used for round-trip signature vectors.',
  version: '1.0.0',
  capabilities: {},
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['application/json'],
  supportedInterfaces: [
    { url: 'https://signed.example.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  skills: [
    {
      id: 'echo-structured',
      name: 'Echo structured data',
      description: 'Echoes structured input back as a DataPart.',
      tags: ['echo', 'testing'],
    },
  ],
};

// ---------------------------------------------------------------------------
// Default-stripping (§8.4.1/§8.4.3 step 3)
// ---------------------------------------------------------------------------

describe('stripDefaults', () => {
  it('keeps REQUIRED fields even at default values, strips non-REQUIRED defaults', () => {
    const { value } = stripDefaults({
      name: 'x',
      description: 'y',
      version: '1',
      capabilities: {}, // REQUIRED — kept even though empty
      iconUrl: '', // non-REQUIRED default — stripped
      documentationUrl: 'https://docs.example.com', // non-default — kept
    });
    const out = value as Record<string, unknown>;
    expect(out).toHaveProperty('capabilities');
    expect(out).not.toHaveProperty('iconUrl');
    expect(out).toHaveProperty('documentationUrl');
  });

  it('reports unknown default-valued fields instead of silently eating them (C4)', () => {
    const { unknownStripped } = stripDefaults({ name: 'x', futureFlag: false });
    expect(unknownStripped).toEqual(['futureFlag']);
  });

  it('treats map entries as data, not fields — empty scope lists survive', () => {
    const { value } = stripDefaults({
      name: 'x',
      securitySchemes: { key: { apiKeySecurityScheme: { location: 'header', name: 'X' } } },
      securityRequirements: [{ key: [] }], // empty scopes = valid data, NOT a default field
    });
    const out = value as { securityRequirements: unknown[] };
    expect(out.securityRequirements).toEqual([{ key: [] }]);
  });
});

describe('canonicalCardPayload', () => {
  it('is stable across default-explicitness — the property stripping exists for', () => {
    const explicit: AgentCardJson = {
      ...BASE_CARD,
      iconUrl: '',
      capabilities: { streaming: false, pushNotifications: false },
    };
    expect(canonicalCardPayload(explicit).payload).toBe(canonicalCardPayload(BASE_CARD).payload);
  });

  it('excludes the signatures field from the payload', () => {
    const signed = { ...BASE_CARD, signatures: [{ protected: 'x', signature: 'y' }] };
    expect(canonicalCardPayload(signed).payload).toBe(canonicalCardPayload(BASE_CARD).payload);
  });
});

// ---------------------------------------------------------------------------
// Round-trip vectors
// ---------------------------------------------------------------------------

describe('verifyCardSignature — crypto-pinned tier', () => {
  it('round-trips an ES256-signed card against the pinned key store', async () => {
    const { privateKey, store } = await makeKeys('ES256');
    const signed = await signCard(BASE_CARD, privateKey, 'ES256');
    const report = await verifyCardSignature(signed, { keyStore: store });
    expect(report.tier).toBe('crypto-pinned');
    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('round-trips an EdDSA-signed card', async () => {
    const { privateKey, store } = await makeKeys('EdDSA');
    const signed = await signCard(BASE_CARD, privateKey, 'EdDSA');
    const report = await verifyCardSignature(signed, { keyStore: store });
    expect(report.tier).toBe('crypto-pinned');
  });

  it('verifies a card whose signer omitted defaults when the receiver sees explicit ones', async () => {
    const { privateKey, store } = await makeKeys('ES256');
    const signed = await signCard(BASE_CARD, privateKey, 'ES256');
    const received: AgentCardJson = {
      ...signed,
      iconUrl: '',
      capabilities: { streaming: false },
    };
    const report = await verifyCardSignature(received, { keyStore: store });
    expect(report.tier).toBe('crypto-pinned');
  });

  it('grants NO tier on a tampered card and raises an error finding', async () => {
    const { privateKey, store } = await makeKeys('ES256');
    const signed = await signCard(BASE_CARD, privateKey, 'ES256');
    const tampered = { ...signed, description: 'Tampered description.' };
    const report = await verifyCardSignature(tampered, { keyStore: store });
    expect(report.tier).toBeNull();
    expect(report.findings.some((f) => f.ruleId === 'signature-verification-failed')).toBe(true);
  });

  it('rejects a signature made with a DIFFERENT key than the pinned one', async () => {
    const { privateKey } = await makeKeys('ES256');
    const other = await makeKeys('ES256');
    const signed = await signCard(BASE_CARD, privateKey, 'ES256');
    const report = await verifyCardSignature(signed, { keyStore: other.store });
    expect(report.tier).toBeNull();
    expect(report.findings.some((f) => f.ruleId === 'signature-verification-failed')).toBe(true);
  });

  it('stays at the structural tier when the kid is unknown and jku is not enabled', async () => {
    const { privateKey } = await makeKeys('ES256');
    const signed = await signCard(BASE_CARD, privateKey, 'ES256');
    const report = await verifyCardSignature(signed, { keyStore: { keys: {} } });
    expect(report.tier).toBe('structural');
    expect(report.findings.some((f) => f.ruleId === 'no-resolvable-key')).toBe(true);
  });
});

describe('verifyCardSignature — crypto-jku tier (explicit opt-in)', () => {
  /**
   * The jku fetch runs through the SSRF destination guard, which resolves the
   * hostname. Tests inject the resolver so they never touch real DNS —
   * `publicResolver` stands in for "this name is an ordinary public host".
   */
  const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];

  it('verifies via a fetched JWKS and grants crypto-jku, not crypto-pinned', async () => {
    const { privateKey, publicJwk } = await makeKeys('ES256');
    const signed = await signCard(BASE_CARD, privateKey, 'ES256', {
      jku: 'https://signed.example.com/jwks.json',
    });
    const report = await verifyCardSignature(signed, {
      fetchJku: true,
      guard: { lookupImpl: publicResolver },
      fetchImpl: async () => ({ ok: true, json: async () => ({ keys: [publicJwk] }) }),
    });
    expect(report.tier).toBe('crypto-jku');
  });

  it('REFUSES a jku pointing at the cloud metadata endpoint, and says so distinctly', async () => {
    const { privateKey } = await makeKeys('ES256');
    const signed = await signCard(BASE_CARD, privateKey, 'ES256', {
      jku: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    });
    let fetched = 0;
    const report = await verifyCardSignature(signed, {
      fetchJku: true,
      fetchImpl: async () => {
        fetched += 1;
        return { ok: true, json: async () => ({ keys: [] }) };
      },
    });
    // No request was made at all — the guard runs before the transport.
    expect(fetched).toBe(0);
    expect(report.tier).toBe('structural');
    expect(report.findings.some((f) => f.ruleId === 'jku-destination-blocked')).toBe(true);
    // Distinct from an ordinary network failure — that distinction is the
    // whole reason the guard is visible in the report.
    expect(report.findings.some((f) => f.ruleId === 'jku-fetch-failed')).toBe(false);
  });

  it('REFUSES a jku whose innocuous hostname resolves to a private address', async () => {
    const { privateKey } = await makeKeys('ES256');
    const signed = await signCard(BASE_CARD, privateKey, 'ES256', {
      jku: 'https://keys.example.com/jwks.json',
    });
    let fetched = 0;
    const report = await verifyCardSignature(signed, {
      fetchJku: true,
      guard: { lookupImpl: async () => [{ address: '10.0.0.5', family: 4 }] },
      fetchImpl: async () => {
        fetched += 1;
        return { ok: true, json: async () => ({ keys: [] }) };
      },
    });
    expect(fetched).toBe(0);
    expect(report.findings.some((f) => f.ruleId === 'jku-destination-blocked')).toBe(true);
  });

  it('ignores the generic guard.allowPrivate knob on the jku path', async () => {
    // A caller may have set `allowPrivate` for unrelated reasons; it must not
    // silently open the one path whose destination comes from untrusted input.
    const { privateKey } = await makeKeys('ES256');
    const signed = await signCard(BASE_CARD, privateKey, 'ES256', {
      jku: 'http://127.0.0.1:8080/jwks.json',
    });
    const report = await verifyCardSignature(signed, {
      fetchJku: true,
      guard: { allowPrivate: true },
      fetchImpl: async () => ({ ok: true, json: async () => ({ keys: [] }) }),
    });
    expect(report.findings.some((f) => f.ruleId === 'jku-destination-blocked')).toBe(true);
  });

  it('permits a loopback jku ONLY under the explicit dangerous opt-in', async () => {
    // Caller intent ("I started this server myself") may be honoured; card
    // intent never is. The opt-in is what distinguishes the two.
    const { privateKey, publicJwk } = await makeKeys('ES256');
    const signed = await signCard(BASE_CARD, privateKey, 'ES256', {
      jku: 'http://127.0.0.1:8080/jwks.json',
    });
    const report = await verifyCardSignature(signed, {
      fetchJku: true,
      dangerouslyAllowPrivateJku: true,
      fetchImpl: async () => ({ ok: true, json: async () => ({ keys: [publicJwk] }) }),
    });
    expect(report.tier).toBe('crypto-jku');
    expect(report.findings.some((f) => f.ruleId === 'jku-destination-blocked')).toBe(false);
  });

  it('still reports an ordinary fetch failure as a fetch failure', async () => {
    const { privateKey } = await makeKeys('ES256');
    const signed = await signCard(BASE_CARD, privateKey, 'ES256', {
      jku: 'https://signed.example.com/jwks.json',
    });
    const report = await verifyCardSignature(signed, {
      fetchJku: true,
      guard: { lookupImpl: publicResolver },
      fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
    });
    expect(report.findings.some((f) => f.ruleId === 'jku-fetch-failed')).toBe(true);
    expect(report.findings.some((f) => f.ruleId === 'jku-destination-blocked')).toBe(false);
  });

  it('never fetches jku without the explicit opt-in', async () => {
    const { privateKey } = await makeKeys('ES256');
    const signed = await signCard(BASE_CARD, privateKey, 'ES256', {
      jku: 'https://signed.example.com/jwks.json',
    });
    let fetched = 0;
    const report = await verifyCardSignature(signed, {
      fetchImpl: async () => {
        fetched += 1;
        return { ok: true, json: async () => ({ keys: [] }) };
      },
    });
    expect(fetched).toBe(0);
    expect(report.tier).toBe('structural');
  });

  it('prefers the pinned tier when both paths could verify', async () => {
    const { privateKey, publicJwk, store } = await makeKeys('ES256');
    const signed = await signCard(BASE_CARD, privateKey, 'ES256', {
      jku: 'https://signed.example.com/jwks.json',
    });
    const report = await verifyCardSignature(signed, {
      keyStore: store,
      fetchJku: true,
      guard: { lookupImpl: publicResolver },
      fetchImpl: async () => ({ ok: true, json: async () => ({ keys: [publicJwk] }) }),
    });
    expect(report.tier).toBe('crypto-pinned');
  });
});

describe('keyStoreFromJwks', () => {
  it('indexes keys by kid and ignores malformed entries', () => {
    const store = keyStoreFromJwks({
      keys: [{ kid: 'a', kty: 'EC' }, { kty: 'EC' }, 'garbage', null],
    });
    expect(Object.keys(store.keys)).toEqual(['a']);
  });

  it('tolerates non-JWKS input', () => {
    expect(keyStoreFromJwks(null).keys).toEqual({});
    expect(keyStoreFromJwks('nope').keys).toEqual({});
  });
});
