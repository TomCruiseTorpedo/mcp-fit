/**
 * A2A Agent Card signature analysis — structural tier (ADR-F4).
 *
 * Grades the `signatures[]` array of an Agent Card per spec §8.4:
 *  - presence (signing is recommended-not-required in v1.0 → absence is a warning)
 *  - base64url well-formedness of `protected` and `signature`
 *  - decoded protected header carries `alg` / `typ` / `kid` (MUST, §8.4.2)
 *  - `alg` is not `none`
 *
 * This tier NEVER claims cryptographic validity. The crypto tiers
 * ('crypto-pinned' via a local key store, 'crypto-jku' via header key fetch)
 * are deferred — see ADR-F4 for the tier ladder and why `jku`-only
 * verification proves possession, not provenance.
 *
 * Deterministic: same card in, same report out. No I/O.
 */

import type {
  AgentCardJson,
  AgentCardSignatureJson,
  CardFinding,
  SignatureReport,
} from './card-types.js';

/** Strict base64url alphabet (no padding, per JWS compact serialisation). */
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Protected-header fields the spec marks MUST (§8.4.2). */
const REQUIRED_HEADER_FIELDS = ['alg', 'typ', 'kid'] as const;

/** Decode a base64url segment into a parsed JSON object, or null on failure. */
function decodeHeader(segment: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(segment, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Analyse one signature entry, appending findings. */
function analyseOne(
  sig: AgentCardSignatureJson,
  index: number,
  findings: CardFinding[],
): void {
  const at = (field: string): string => `signatures[${index}].${field}`;

  for (const field of ['protected', 'signature'] as const) {
    const value = sig[field];
    if (typeof value !== 'string' || value.length === 0) {
      findings.push({
        ruleId: 'malformed-signature-encoding',
        axis: 'signature-hygiene',
        severity: 'error',
        field: at(field),
        message: `Signature entry ${index} is missing required "${field}" (spec §8.4.2).`,
      });
    } else if (!B64URL_RE.test(value)) {
      findings.push({
        ruleId: 'malformed-signature-encoding',
        axis: 'signature-hygiene',
        severity: 'error',
        field: at(field),
        message: `Signature entry ${index} "${field}" is not valid base64url.`,
      });
    }
  }

  const protectedB64 = sig.protected;
  if (typeof protectedB64 !== 'string' || !B64URL_RE.test(protectedB64)) {
    return; // encoding findings above already cover this entry
  }

  const header = decodeHeader(protectedB64);
  if (header === null) {
    findings.push({
      ruleId: 'signature-header-undecodable',
      axis: 'signature-hygiene',
      severity: 'error',
      field: at('protected'),
      message: `Signature entry ${index} protected header does not decode to a JSON object.`,
    });
    return;
  }

  for (const required of REQUIRED_HEADER_FIELDS) {
    if (typeof header[required] !== 'string' || (header[required] as string).length === 0) {
      findings.push({
        ruleId: 'signature-header-fields',
        axis: 'signature-hygiene',
        severity: 'error',
        field: at('protected'),
        message: `Signature entry ${index} protected header is missing "${required}" (MUST, spec §8.4.2).`,
      });
    }
  }

  if (header['alg'] === 'none') {
    findings.push({
      ruleId: 'signature-alg-none',
      axis: 'signature-hygiene',
      severity: 'error',
      field: at('protected'),
      message: `Signature entry ${index} declares alg "none" — an unsigned signature is not a signature.`,
    });
  }
}

/**
 * Analyse the card's signatures and produce the SignatureReport.
 *
 * `tier` is 'structural' only when at least one signature is present AND no
 * error-severity finding was raised; otherwise null. Warning-level findings
 * (e.g. absence) do not grant a tier.
 */
export function analyseSignatures(card: AgentCardJson): SignatureReport {
  const findings: CardFinding[] = [];
  const signatures = Array.isArray(card.signatures) ? card.signatures : [];

  if (signatures.length === 0) {
    findings.push({
      ruleId: 'no-card-signature',
      axis: 'signature-hygiene',
      severity: 'warning',
      field: 'signatures',
      message:
        'Card carries no signature; signed cards let clients verify the card was issued by the domain owner (spec §8.4).',
    });
    return { present: false, tier: null, findings };
  }

  signatures.forEach((sig, i) => analyseOne(sig ?? {}, i, findings));

  const hasError = findings.some((f) => f.severity === 'error');
  return {
    present: true,
    tier: hasError ? null : 'structural',
    findings,
  };
}
