/**
 * Structural signature-tier tests (ADR-F4).
 */

import { describe, expect, it } from 'vitest';

import { analyseSignatures } from '../signature.js';
import type { AgentCardJson } from '../card-types.js';

const b64url = (value: object | string): string =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

const cardWith = (signatures: AgentCardJson['signatures']): AgentCardJson => ({ signatures });

const validHeader = { alg: 'EdDSA', typ: 'JOSE', kid: 'k1' };

describe('analyseSignatures', () => {
  it('reports an unsigned card as a warning, not an error, with no tier', () => {
    const report = analyseSignatures(cardWith(undefined));
    expect(report.present).toBe(false);
    expect(report.tier).toBeNull();
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.ruleId).toBe('no-card-signature');
    expect(report.findings[0]?.severity).toBe('warning');
  });

  it('grants the structural tier to a well-formed signature', () => {
    const report = analyseSignatures(
      cardWith([{ protected: b64url(validHeader), signature: b64url('sig-bytes') }]),
    );
    expect(report.present).toBe(true);
    expect(report.tier).toBe('structural');
    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('rejects non-base64url segments', () => {
    const report = analyseSignatures(
      cardWith([{ protected: 'not+valid/base64=', signature: b64url('x') }]),
    );
    expect(report.tier).toBeNull();
    expect(report.findings.some((f) => f.ruleId === 'malformed-signature-encoding')).toBe(true);
  });

  it('rejects a protected header that does not decode to JSON', () => {
    const report = analyseSignatures(
      cardWith([{ protected: b64url('plain text, not JSON'), signature: b64url('x') }]),
    );
    expect(report.tier).toBeNull();
    expect(report.findings.some((f) => f.ruleId === 'signature-header-undecodable')).toBe(true);
  });

  it('requires alg, typ, and kid in the protected header (MUST, spec §8.4.2)', () => {
    const report = analyseSignatures(
      cardWith([{ protected: b64url({ alg: 'EdDSA' }), signature: b64url('x') }]),
    );
    expect(report.tier).toBeNull();
    const missing = report.findings.filter((f) => f.ruleId === 'signature-header-fields');
    expect(missing).toHaveLength(2); // typ + kid
  });

  it('rejects alg "none"', () => {
    const report = analyseSignatures(
      cardWith([
        { protected: b64url({ alg: 'none', typ: 'JOSE', kid: 'k1' }), signature: b64url('x') },
      ]),
    );
    expect(report.tier).toBeNull();
    expect(report.findings.some((f) => f.ruleId === 'signature-alg-none')).toBe(true);
  });

  it('never claims a crypto tier from structural analysis alone', () => {
    const report = analyseSignatures(
      cardWith([{ protected: b64url(validHeader), signature: b64url('sig-bytes') }]),
    );
    expect(report.tier).not.toBe('crypto-pinned');
    expect(report.tier).not.toBe('crypto-jku');
  });
});
