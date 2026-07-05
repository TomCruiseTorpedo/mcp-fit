/**
 * Card lint engine tests (ADR-F).
 *
 * Covers the spec scenarios: deterministic card lint, REQUIRED-field floor,
 * and the red→green fixture pair (strawman vs clean).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { lintCard } from '../card-engine.js';
import { CARD_AXIS_NAMES } from '../card-types.js';

const strawman: unknown = JSON.parse(
  readFileSync(new URL('../../../fixtures/agent-cards/strawman-card.json', import.meta.url), 'utf8'),
);
const clean: unknown = JSON.parse(
  readFileSync(new URL('../../../fixtures/agent-cards/clean-card.json', import.meta.url), 'utf8'),
);

describe('lintCard determinism', () => {
  it('returns structurally identical output for the same input (spec: deterministic card lint)', () => {
    expect(lintCard(strawman)).toEqual(lintCard(strawman));
    expect(lintCard(clean)).toEqual(lintCard(clean));
  });
});

describe('lintCard on a non-object input', () => {
  it('produces a scorecard with an invalid-document finding instead of throwing', () => {
    const result = lintCard('not a card');
    const completeness = result.axisScores['card-completeness'];
    expect(completeness.findings.some((f) => f.ruleId === 'invalid-card-document')).toBe(true);
    expect(result.card).toEqual({ name: 'unknown', version: 'unknown' });
  });

  it('floors every axis — a non-card must not collect vacuous 10s (badge-inflation guard)', () => {
    const result = lintCard('not a card');
    for (const axis of CARD_AXIS_NAMES) {
      expect(result.axisScores[axis].score, axis).toBe(1);
    }
    expect(result.aggregate.lintScore).toBe(1);
  });
});

describe('lintCard on a card with zero skills', () => {
  it('floors the skill axes instead of awarding unmeasured 10s', () => {
    const result = lintCard({
      name: 'No Skills Agent',
      description: 'A card with an empty skills array.',
      version: '1.0.0',
      capabilities: {},
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['application/json'],
      supportedInterfaces: [
        { url: 'https://e.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      ],
      skills: [],
    });
    expect(result.axisScores['skill-namespacing'].score).toBe(1);
    expect(result.axisScores['skill-selection-overlap'].score).toBe(1);
    // Non-skill axes still grade what IS measurable.
    expect(result.axisScores['interface-hygiene'].score).toBe(10);
  });
});

describe('lintCard on the clean fixture', () => {
  const result = lintCard(clean);

  it('scores 10 on every axis with zero error findings', () => {
    for (const axis of CARD_AXIS_NAMES) {
      const axisScore = result.axisScores[axis];
      expect(axisScore.score, `${axis} score`).toBe(10);
      expect(
        axisScore.findings.filter((f) => f.severity === 'error'),
        `${axis} errors`,
      ).toEqual([]);
    }
    expect(result.aggregate.lintScore).toBe(10);
  });

  it('grants the structural signature tier without claiming crypto validity', () => {
    expect(result.signature.present).toBe(true);
    expect(result.signature.tier).toBe('structural');
  });

  it('identifies the card', () => {
    expect(result.card).toEqual({ name: 'Recipe Research Agent', version: '2.1.0' });
  });
});

describe('lintCard on the strawman fixture (red side of the demo)', () => {
  const result = lintCard(strawman);

  it('scores materially below the clean card', () => {
    expect(result.aggregate.lintScore).toBeLessThan(6);
  });

  it('raises REQUIRED-field floor errors under card-completeness (spec: REQUIRED-field floor)', () => {
    const findings = result.axisScores['card-completeness'].findings;
    const missing = findings
      .filter((f) => f.ruleId === 'card-required-fields')
      .map((f) => f.field);
    expect(missing).toContain('description');
    expect(missing).toContain('version');
    expect(missing).toContain('defaultInputModes');
    expect(missing).toContain('defaultOutputModes');
  });

  it('flags the duplicate skill id', () => {
    const overlap = result.axisScores['skill-selection-overlap'].findings;
    expect(overlap.some((f) => f.ruleId === 'duplicate-skill-ids')).toBe(true);
  });

  it('flags the undeclared security scheme referenced via the legacy `security` spelling', () => {
    const sec = result.axisScores['security-declaration-consistency'].findings;
    expect(
      sec.some(
        (f) => f.ruleId === 'undeclared-security-scheme' && f.message.includes('corpSso'),
      ),
    ).toBe(true);
  });

  it('flags interface problems: missing protocolVersion, http url, unknown binding', () => {
    const iface = result.axisScores['interface-hygiene'].findings;
    expect(iface.some((f) => f.field === 'supportedInterfaces[0].protocolVersion')).toBe(true);
    expect(iface.some((f) => f.severity === 'warning' && f.message.includes('http'))).toBe(true);
    expect(iface.some((f) => f.ruleId === 'unknown-protocol-binding')).toBe(true);
  });

  it('flags the uri-less required extension and reports the unsigned card', () => {
    const ext = result.axisScores['extension-hygiene'].findings;
    expect(ext.some((f) => f.ruleId === 'extension-invalid-uri' && f.severity === 'error')).toBe(
      true,
    );
    expect(result.signature.present).toBe(false);
    expect(result.signature.tier).toBeNull();
  });
});
