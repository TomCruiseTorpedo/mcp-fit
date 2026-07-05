/**
 * Card scorer + artifact schema tests (ADR-F1/F3).
 *
 * The scorecard emitted for BOTH fixtures must validate against
 * schemas/card-compat.schema.json — the schema is the published contract.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { scoreCardLintOnly } from '../card-scorer.js';
import { validateCardScorecardSchema } from '../emit.js';
import { CARD_SCHEMA_VERSION } from '../card-types.js';
import { CARD_AXIS_WEIGHTS, weightedCardAggregate } from '../card-axes.js';
import { CARD_AXIS_NAMES } from '../card-types.js';
import type { CardAxisName } from '../card-types.js';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../fixtures/agent-cards/${name}`, import.meta.url), 'utf8'),
  );

describe('scoreCardLintOnly', () => {
  it('emits the pinned schema version', () => {
    expect(scoreCardLintOnly(fixture('clean-card.json')).schemaVersion).toBe(CARD_SCHEMA_VERSION);
  });

  it('produces schema-valid scorecards for both fixtures', () => {
    for (const name of ['clean-card.json', 'strawman-card.json']) {
      const result = validateCardScorecardSchema(scoreCardLintOnly(fixture(name)));
      expect(result.errors, name).toEqual([]);
      expect(result.valid, name).toBe(true);
    }
  });

  it('keeps lintScore and weighted identical in v1 (no eval split on cards)', () => {
    const scorecard = scoreCardLintOnly(fixture('strawman-card.json'));
    expect(scorecard.aggregate.lintScore).toBe(scorecard.aggregate.weighted);
  });

  it('shows the red→green fixture delta', () => {
    const red = scoreCardLintOnly(fixture('strawman-card.json')).aggregate.lintScore;
    const green = scoreCardLintOnly(fixture('clean-card.json')).aggregate.lintScore;
    expect(green).toBe(10);
    expect(red).toBeLessThan(6);
  });
});

describe('weightedCardAggregate (ADR-F3)', () => {
  it('weights completeness up and signature down', () => {
    expect(CARD_AXIS_WEIGHTS['card-completeness']).toBeGreaterThan(1);
    expect(CARD_AXIS_WEIGHTS['signature-hygiene']).toBeLessThan(1);
  });

  it('is a weighted mean rounded to one decimal', () => {
    const uniform = {} as Record<CardAxisName, number>;
    for (const axis of CARD_AXIS_NAMES) uniform[axis] = 7;
    expect(weightedCardAggregate(uniform)).toBe(7);
  });
});
