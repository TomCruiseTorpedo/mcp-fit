/**
 * A2A Agent Card cryptographic signature verification — the crypto tiers
 * (ADR-F4: 'crypto-pinned' via a local trusted key store, 'crypto-jku' via
 * opt-in network fetch of the header `jku` JWKS).
 *
 * Implements spec §8.4.3 verification exactly:
 *   1. extract each signature from `signatures[]`
 *   2. resolve the public key by `kid` (key store first; `jku` only when the
 *      caller explicitly opted into network fetch)
 *   3. remove default-valued properties from the received card
 *   4. exclude the `signatures` field
 *   5. canonicalize per RFC 8785 (JCS)
 *   6. verify the JWS (RFC 7515) over
 *      ASCII(BASE64URL(protected) || '.' || BASE64URL(payload))
 *
 * Trust semantics (ADR-F4): `jku` lives inside the very card being verified,
 * so a jku-only pass proves integrity + key possession, NOT provenance — the
 * trust anchor is the caller's key store. That is why 'crypto-pinned'
 * outranks 'crypto-jku' and why jku fetching is never on by default.
 *
 * Determinism caveat (spec-depth C4): default-stripping is schema-version-
 * conditional. The REQUIRED classification below is the A2A v1.0.1 table;
 * unknown default-valued fields are stripped (they cannot be REQUIRED) and
 * surfaced as an info finding rather than silently ignored.
 */

import canonicalize from 'canonicalize';
import { compactVerify, importJWK, type JWK } from 'jose';

import type {
  AgentCardJson,
  CardFinding,
  SignatureReport,
  SignatureTier,
} from './card-types.js';
import { analyseSignatures } from './signature.js';

// ---------------------------------------------------------------------------
// Key store
// ---------------------------------------------------------------------------

/** A local trusted key store: kid → public JWK (the ADR-F4 trust anchor). */
export interface LocalKeyStore {
  keys: Record<string, JWK>;
}

/** Build a LocalKeyStore from a standard JWKS document ({ keys: [...] }). */
export function keyStoreFromJwks(jwks: unknown): LocalKeyStore {
  const store: LocalKeyStore = { keys: {} };
  if (typeof jwks !== 'object' || jwks === null) return store;
  const list = (jwks as { keys?: unknown }).keys;
  if (!Array.isArray(list)) return store;
  for (const entry of list) {
    if (typeof entry === 'object' && entry !== null) {
      const jwk = entry as JWK & { kid?: string };
      if (typeof jwk.kid === 'string' && jwk.kid.length > 0) {
        store.keys[jwk.kid] = jwk;
      }
    }
  }
  return store;
}

// ---------------------------------------------------------------------------
// Canonical payload (§8.4.3 steps 3-5)
// ---------------------------------------------------------------------------

/**
 * A2A v1.0.1 REQUIRED-field classification (proto field_behavior) — REQUIRED
 * fields are always kept, even at their default value. Paths use `[]` for
 * array elements and `*` for map values.
 */
const REQUIRED_PATHS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'version',
  'capabilities',
  'defaultInputModes',
  'defaultOutputModes',
  'supportedInterfaces',
  'skills',
  'skills[].id',
  'skills[].name',
  'skills[].description',
  'skills[].tags',
  'supportedInterfaces[].url',
  'supportedInterfaces[].protocolBinding',
  'supportedInterfaces[].protocolVersion',
  'capabilities.extensions[].uri',
  'provider.organization',
  'provider.url',
]);

/**
 * MAP-valued paths (proto `map<...>` fields and requirement entries): their
 * KEYS are data, not proto fields — never default-stripped (the smoke-caught
 * bug: a requirement entry with an empty scope list, `{"scheme": []}`, must
 * survive canonicalization intact).
 */
const MAP_PATHS: ReadonlySet<string> = new Set([
  'securitySchemes',
  'securityRequirements[]',
  'security[]',
  'skills[].securityRequirements[]',
  'capabilities.extensions[].params',
]);

/** True when `value` is a proto3 default (zero value) for JSON purposes. */
function isDefaultValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (value === false || value === 0 || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/** Child path for a field under `path` ('' = root). */
function childPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/**
 * Strip default-valued non-REQUIRED properties, depth-first (§8.4.3 step 3).
 * Returns the stripped copy plus the paths of stripped fields that are NOT
 * in the known v1.0.1 vocabulary (the C4 ambiguity — surfaced, not silent).
 */
export function stripDefaults(
  value: unknown,
  path = '',
): { value: unknown; unknownStripped: string[] } {
  const unknownStripped: string[] = [];

  const walk = (node: unknown, nodePath: string): unknown => {
    if (Array.isArray(node)) {
      return node.map((item) => walk(item, `${nodePath}[]`));
    }
    if (typeof node !== 'object' || node === null) {
      return node;
    }
    const isMap = MAP_PATHS.has(nodePath);
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(node as Record<string, unknown>)) {
      // Map entries: the key is DATA — keep it verbatim; walk the value with
      // a wildcard path so nested message fields still strip normally.
      const fieldPath = isMap ? `${nodePath}.*` : childPath(nodePath, key);
      const walked = walk(raw, fieldPath);
      if (!isMap && isDefaultValue(walked) && !REQUIRED_PATHS.has(fieldPath)) {
        // Known non-REQUIRED default → stripped per spec. Unknown field →
        // also stripped (unknown fields cannot be REQUIRED), but recorded.
        if (!isKnownPath(fieldPath)) unknownStripped.push(fieldPath);
        continue;
      }
      out[key] = walked;
    }
    return out;
  };

  return { value: walk(value, path), unknownStripped };
}

/** Fields of the v1.0.1 vocabulary we recognise at any depth (for the C4 note). */
const KNOWN_FIELDS = new Set([
  'name', 'description', 'version', 'provider', 'organization', 'url',
  'iconUrl', 'documentationUrl', 'supportedInterfaces', 'protocolBinding',
  'protocolVersion', 'capabilities', 'streaming', 'pushNotifications',
  'extendedAgentCard', 'extensions', 'uri', 'required', 'params',
  'defaultInputModes', 'defaultOutputModes', 'skills', 'id', 'tags',
  'examples', 'inputModes', 'outputModes', 'securitySchemes',
  'securityRequirements', 'security', 'signatures', 'protected', 'signature',
  'header',
]);

function isKnownPath(fieldPath: string): boolean {
  const last = fieldPath.split('.').pop() ?? fieldPath;
  return KNOWN_FIELDS.has(last.replace(/\[\]$/, ''));
}

/**
 * Produce the canonical signing payload for a card (§8.4.1/§8.4.3):
 * default-stripped, `signatures` excluded, JCS-canonicalized.
 */
export function canonicalCardPayload(card: AgentCardJson): {
  payload: string;
  unknownStripped: string[];
} {
  const { signatures: _excluded, ...rest } = card;
  const { value, unknownStripped } = stripDefaults(rest);
  const payload = canonicalize(value);
  if (payload === undefined) {
    throw new Error('card could not be canonicalized (RFC 8785)');
  }
  return { payload, unknownStripped };
}

// ---------------------------------------------------------------------------
// Verification (§8.4.3)
// ---------------------------------------------------------------------------

/** Algorithms accepted for card signatures ('none' is rejected structurally). */
const ALLOWED_ALGS: ReadonlySet<string> = new Set([
  'ES256', 'ES384', 'ES512', 'EdDSA', 'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512',
]);

/** Minimal fetch signature (injectable for tests). */
export type JwksFetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface VerifyCardOptions {
  /** Trusted keys — enables the 'crypto-pinned' tier. */
  keyStore?: LocalKeyStore;
  /** Explicit opt-in to fetch the header `jku` JWKS — enables 'crypto-jku'. */
  fetchJku?: boolean;
  /** Injectable fetch for tests. */
  fetchImpl?: JwksFetchLike;
}

function decodeProtected(protectedB64: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(protectedB64, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Verify a card's signatures cryptographically (§8.4.3).
 *
 * Tier result (highest achieved across signatures):
 *   'crypto-pinned' — verified with a key-store key (the trust anchor)
 *   'crypto-jku'    — verified with a jku-fetched key (integrity + possession
 *                     only, NOT provenance — ADR-F4)
 *   'structural'    — structure passed but no signature verified crypto-
 *                     graphically (no resolvable key, or verification failed
 *                     downgrades to null with an error finding)
 */
export async function verifyCardSignature(
  card: AgentCardJson,
  options: VerifyCardOptions = {},
): Promise<SignatureReport> {
  // ── Structural tier first: reuse the exact W1 analysis ───────────────────
  const structural = analyseSignatures(card);
  if (!structural.present || structural.tier === null) {
    return structural; // absent or structurally invalid — nothing to verify
  }

  const findings: CardFinding[] = [...structural.findings];
  const { payload, unknownStripped } = canonicalCardPayload(card);
  if (unknownStripped.length > 0) {
    findings.push({
      ruleId: 'unknown-default-fields-stripped',
      axis: 'signature-hygiene',
      severity: 'info',
      message:
        `Stripped ${unknownStripped.length} unknown default-valued field(s) before verification ` +
        `(${unknownStripped.slice(0, 3).join(', ')}${unknownStripped.length > 3 ? ', …' : ''}) — `
        + 'cross-spec-version cards may verify differently (A2A §5.7 ambiguity).',
    });
  }
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');

  let best: SignatureTier = 'structural';
  const signatures = Array.isArray(card.signatures) ? card.signatures : [];

  for (const [index, sig] of signatures.entries()) {
    const protectedB64 = sig?.protected;
    const signatureB64 = sig?.signature;
    if (typeof protectedB64 !== 'string' || typeof signatureB64 !== 'string') continue;

    const header = decodeProtected(protectedB64);
    const alg = header?.['alg'];
    const kid = header?.['kid'];
    const jku = header?.['jku'];

    if (typeof alg !== 'string' || !ALLOWED_ALGS.has(alg)) {
      findings.push({
        ruleId: 'signature-alg-not-allowed',
        axis: 'signature-hygiene',
        severity: 'warning',
        field: `signatures[${index}].protected`,
        message: `Signature ${index} algorithm '${String(alg)}' is not in the accepted set.`,
      });
      continue;
    }

    // ── Resolve the key: pinned store first, jku only on explicit opt-in ───
    let jwk: JWK | undefined;
    let tierIfVerified: SignatureTier = 'structural';

    if (typeof kid === 'string' && options.keyStore?.keys[kid] !== undefined) {
      jwk = options.keyStore.keys[kid];
      tierIfVerified = 'crypto-pinned';
    } else if (options.fetchJku === true && typeof jku === 'string') {
      try {
        const fetchImpl = options.fetchImpl ?? (fetch as unknown as JwksFetchLike);
        const response = await fetchImpl(jku);
        if (!response.ok) throw new Error('jwks fetch failed');
        const store = keyStoreFromJwks(await response.json());
        jwk = typeof kid === 'string' ? store.keys[kid] : undefined;
        tierIfVerified = 'crypto-jku';
      } catch {
        findings.push({
          ruleId: 'jku-fetch-failed',
          axis: 'signature-hygiene',
          severity: 'warning',
          field: `signatures[${index}].protected`,
          message: `Signature ${index} jku JWKS could not be fetched (${String(jku)}).`,
        });
        continue;
      }
    }

    if (jwk === undefined) {
      findings.push({
        ruleId: 'no-resolvable-key',
        axis: 'signature-hygiene',
        severity: 'info',
        field: `signatures[${index}].protected`,
        message:
          `Signature ${index} kid '${String(kid)}' is not in the trusted key store` +
          (options.fetchJku === true ? ' and the jku yielded no matching key.' : ' (jku fetch not enabled).'),
      });
      continue;
    }

    // ── RFC 7515 verify over protected.payload.signature ───────────────────
    try {
      const key = await importJWK(jwk, alg);
      await compactVerify(`${protectedB64}.${payloadB64}.${signatureB64}`, key);
      if (best === 'structural' || tierIfVerified === 'crypto-pinned') {
        best = tierIfVerified;
      }
    } catch {
      findings.push({
        ruleId: 'signature-verification-failed',
        axis: 'signature-hygiene',
        severity: 'error',
        field: `signatures[${index}].signature`,
        message: `Signature ${index} failed cryptographic verification against the canonical payload.`,
      });
    }
  }

  const hasCryptoError = findings.some((f) => f.ruleId === 'signature-verification-failed');
  return {
    present: true,
    // A failed verification is worse than unverified: the card was tampered
    // with or signed over a different payload — no tier is granted.
    tier: hasCryptoError ? null : best,
    findings,
  };
}
