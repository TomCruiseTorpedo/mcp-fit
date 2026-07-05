/**
 * Card signing tests (ADR-F4 companion).
 *
 * The signer and verifier share canonicalCardPayload, so these are
 * production-to-production round trips — no hand-rolled signing here
 * (contrast verify.test.ts, which deliberately hand-rolls §8.4.2 as an
 * independent implementation of the generation steps).
 */

import { describe, expect, it } from 'vitest';

import type { AgentCardJson } from '../card-types.js';
import { generateCardSigningKeys, jwksFromPrivateJwk, signAgentCard } from '../sign.js';
import { verifyCardSignature } from '../verify.js';

const CARD: AgentCardJson = {
  name: 'Signer Test Agent',
  description: 'Card used for signer round trips.',
  version: '1.0.0',
  capabilities: {},
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['application/json'],
  supportedInterfaces: [
    { url: 'https://sign.example.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  skills: [
    {
      id: 'noop',
      name: 'No-op',
      description: 'Does nothing, verifiably.',
      tags: ['testing'],
    },
  ],
};

describe('generateCardSigningKeys', () => {
  it('produces kid+alg-carrying JWKs and a publishable JWKS', async () => {
    const keys = await generateCardSigningKeys({ kid: 'k-test', alg: 'ES256' });
    expect(keys.privateJwk).toMatchObject({ kid: 'k-test', alg: 'ES256' });
    expect(keys.publicJwk).toMatchObject({ kid: 'k-test', alg: 'ES256' });
    expect(keys.publicJwk).not.toHaveProperty('d'); // no private material
    expect(keys.jwks.keys).toEqual([keys.publicJwk]);
  });
});

describe('jwksFromPrivateJwk', () => {
  it('strips private members and the derived JWKS verifies a signature', async () => {
    const keys = await generateCardSigningKeys();
    const derived = jwksFromPrivateJwk(keys.privateJwk);
    expect(derived.keys[0]).not.toHaveProperty('d');
    expect(derived.keys[0]).toMatchObject({ kid: 'card-key-1' });
    const signed = await signAgentCard(CARD, keys.privateJwk);
    const report = await verifyCardSignature(signed, {
      keyStore: { keys: { 'card-key-1': derived.keys[0]! } },
    });
    expect(report.tier).toBe('crypto-pinned');
  });
});

describe('signAgentCard → verifyCardSignature round trips', () => {
  it('verifies at crypto-pinned with the generated public JWKS (ES256)', async () => {
    const keys = await generateCardSigningKeys();
    const signed = await signAgentCard(CARD, keys.privateJwk);
    const report = await verifyCardSignature(signed, {
      keyStore: { keys: { 'card-key-1': keys.publicJwk } },
    });
    expect(report.tier).toBe('crypto-pinned');
    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('verifies with EdDSA too', async () => {
    const keys = await generateCardSigningKeys({ alg: 'EdDSA' });
    const signed = await signAgentCard(CARD, keys.privateJwk);
    const report = await verifyCardSignature(signed, {
      keyStore: { keys: { 'card-key-1': keys.publicJwk } },
    });
    expect(report.tier).toBe('crypto-pinned');
  });

  it('embeds jku and verifies at crypto-jku via a fetched JWKS', async () => {
    const keys = await generateCardSigningKeys({ kid: 'k-jku' });
    const signed = await signAgentCard(CARD, keys.privateJwk, {
      jku: 'https://sign.example.com/.well-known/jwks.json',
    });
    const report = await verifyCardSignature(signed, {
      fetchJku: true,
      fetchImpl: async (url) => {
        expect(url).toBe('https://sign.example.com/.well-known/jwks.json');
        return { ok: true, json: async () => keys.jwks };
      },
    });
    expect(report.tier).toBe('crypto-jku');
  });

  it('REPLACES existing signatures (re-signing semantics, ADR-H)', async () => {
    const stale = {
      ...CARD,
      signatures: [{ protected: 'c3RhbGU', signature: 'c3RhbGU' }],
    };
    const keys = await generateCardSigningKeys();
    const signed = await signAgentCard(stale, keys.privateJwk);
    expect(signed.signatures).toHaveLength(1);
    const report = await verifyCardSignature(signed, {
      keyStore: { keys: { 'card-key-1': keys.publicJwk } },
    });
    expect(report.tier).toBe('crypto-pinned'); // stale sig gone, fresh one verifies
  });

  it('a signed card that is then modified fails verification', async () => {
    const keys = await generateCardSigningKeys();
    const signed = await signAgentCard(CARD, keys.privateJwk);
    const tampered = { ...signed, version: '6.6.6' };
    const report = await verifyCardSignature(tampered, {
      keyStore: { keys: { 'card-key-1': keys.publicJwk } },
    });
    expect(report.tier).toBeNull();
  });

  it('refuses keys without kid or alg (protected-header MUSTs)', async () => {
    const keys = await generateCardSigningKeys();
    const { kid: _k, ...noKid } = keys.privateJwk;
    await expect(signAgentCard(CARD, noKid)).rejects.toThrow(/kid/);
    const { alg: _a, ...noAlg } = keys.privateJwk;
    await expect(signAgentCard(CARD, noAlg)).rejects.toThrow(/alg/);
  });
});
