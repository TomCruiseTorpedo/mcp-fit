/**
 * A2A Agent Card signing (ADR-F4 companion — the signer side of verify.ts).
 *
 * Signs a card per spec §8.4.2 with EXACTLY the same canonicalization the
 * verifier applies (§8.4.1: default-strip → exclude `signatures` → JCS
 * RFC 8785) — signer and verifier share `canonicalCardPayload`, so the two
 * can never drift apart. The JWS is RFC 7515 compact with a detached payload:
 * only `protected` and `signature` ride on the card.
 *
 * Re-signing semantics: `signAgentCard` REPLACES any existing `signatures`
 * array. That is deliberate — the primary consumer is a gateway serving (or
 * republishing) a card it vouches for, and a stale upstream signature over a
 * modified card is worse than none (ADR-H: republished cards MUST strip or
 * re-sign). Key rotation with multiple live signatures is out of scope here.
 */

import { CompactSign, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';

import type { AgentCardJson } from './card-types.js';
import { canonicalCardPayload } from './verify.js';

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/** Algorithms supported for card signing keys. */
export type CardSigningAlg = 'ES256' | 'EdDSA';

/** A generated signing key pair plus the publishable JWKS. */
export interface CardSigningKeys {
  /** Private JWK — keep secret (write with restrictive permissions). */
  privateJwk: JWK;
  /** Public JWK (kid + alg included). */
  publicJwk: JWK;
  /** Standard JWKS document carrying the public key — serve or pin this. */
  jwks: { keys: JWK[] };
}

/**
 * Generate a fresh card-signing key pair.
 *
 * The kid defaults to 'card-key-1' — rotate by minting a new pair with a new
 * kid and re-signing.
 */
export async function generateCardSigningKeys(
  options: { alg?: CardSigningAlg; kid?: string } = {},
): Promise<CardSigningKeys> {
  const alg = options.alg ?? 'ES256';
  const kid = options.kid ?? 'card-key-1';
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const privateJwk: JWK = { ...(await exportJWK(privateKey)), kid, alg };
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg };
  return { privateJwk, publicJwk, jwks: { keys: [publicJwk] } };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Derive the publishable JWKS from a private JWK by stripping private-key
 * members — lets a deployer store ONLY the private key and serve/pin the
 * public side without a second file.
 */
export function jwksFromPrivateJwk(privateJwk: JWK): { keys: JWK[] } {
  const publicJwk: JWK = { ...privateJwk };
  for (const member of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'] as const) {
    delete (publicJwk as Record<string, unknown>)[member];
  }
  return { keys: [publicJwk] };
}

export interface SignAgentCardOptions {
  /**
   * JWKS URL to embed in the protected header (`jku`) so clients can fetch
   * the public key (crypto-jku tier). Omit for pinned-key-only distribution.
   */
  jku?: string;
}

/**
 * Sign `card` per §8.4.2 and return a copy whose `signatures` array carries
 * exactly one fresh signature (any prior signatures are replaced — see the
 * module note on re-signing semantics).
 *
 * The private JWK MUST carry `kid` and `alg` — they go into the protected
 * header (both MUST per §8.4.2).
 */
export async function signAgentCard(
  card: AgentCardJson,
  privateJwk: JWK,
  options: SignAgentCardOptions = {},
): Promise<AgentCardJson> {
  const { kid, alg } = privateJwk;
  if (typeof kid !== 'string' || kid.length === 0) {
    throw new Error('signing key needs a kid (protected-header MUST, spec §8.4.2)');
  }
  if (typeof alg !== 'string' || alg.length === 0) {
    throw new Error('signing key needs an alg (protected-header MUST, spec §8.4.2)');
  }

  // Same canonicalization as verification — shared code path, zero drift.
  const { payload } = canonicalCardPayload(card);

  const key = await importJWK(privateJwk, alg);
  const jws = await new CompactSign(new TextEncoder().encode(payload))
    .setProtectedHeader({
      alg,
      typ: 'JOSE',
      kid,
      ...(options.jku !== undefined ? { jku: options.jku } : {}),
    })
    .sign(key);

  const [protectedB64, , signatureB64] = jws.split('.');
  if (protectedB64 === undefined || signatureB64 === undefined) {
    throw new Error('JWS compact serialization did not produce three segments');
  }

  return {
    ...card,
    signatures: [{ protected: protectedB64, signature: signatureB64 }],
  };
}
