/**
 * Card-axis weight constants and aggregate math (ADR-F3).
 *
 * Mirrors src/score/axes.ts for the card-scoring side. The weights are an
 * mcp-fit convention, not spec-derived — the A2A spec has no normative text on
 * description quality. This file is the sanctioned tuning point.
 *
 * Spec: A2A Agent Card Scoring (specs/mcp-fit/spec.md)
 * ADR: ADR-F3 (docs/adr/ADR-F-a2a-card-scoring.md)
 */

import type { CardAxisName } from './card-types.js';
import { CARD_AXIS_NAMES } from './card-types.js';

/**
 * ADR-F3 scoring weights:
 *  - card-completeness × 1.25 (REQUIRED violations are spec noncompliance)
 *  - signature-hygiene × 0.75 (signing is recommended-not-required in v1.0)
 *  - all others        × 1.0
 */
export const CARD_AXIS_WEIGHTS: Readonly<Record<CardAxisName, number>> = {
  'card-completeness': 1.25,
  'skill-namespacing': 1.0,
  'skill-selection-overlap': 1.0,
  'signature-hygiene': 0.75,
  'security-declaration-consistency': 1.0,
  'extension-hygiene': 1.0,
  'interface-hygiene': 1.0,
};

/**
 * Compute the weighted aggregate card score (1–10, one decimal place).
 *
 * Formula: Σ(score_i × weight_i) / Σ(weight_i) — identical mechanics to the
 * MCP-side weightedAggregate (src/score/axes.ts), applied to the card axes.
 */
export function weightedCardAggregate(
  scores: Readonly<Record<CardAxisName, number>>,
): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const axis of CARD_AXIS_NAMES) {
    weightedSum += scores[axis] * CARD_AXIS_WEIGHTS[axis];
    totalWeight += CARD_AXIS_WEIGHTS[axis];
  }
  return Math.round((weightedSum / totalWeight) * 10) / 10;
}
