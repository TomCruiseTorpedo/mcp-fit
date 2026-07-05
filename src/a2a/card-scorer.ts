/**
 * A2A Agent Card scorer (ADR-F).
 *
 * Assembles a CardScorecard (the card-compat.json shape) from the card lint
 * engine output. The card side has no eval split in v1 — every axis is
 * deterministic — so this is the whole scoring story, mirroring
 * `scoreLintOnly()` on the MCP side (src/score/scorer.ts).
 *
 * Pure, synchronous, keyless, offline.
 *
 * Spec: A2A Agent Card Scoring (specs/mcp-fit/spec.md)
 * ADR: ADR-F (docs/adr/ADR-F-a2a-card-scoring.md)
 */

import type { CardScorecard } from './card-types.js';
import { CARD_SCHEMA_VERSION } from './card-types.js';
import type { CardLintResult } from './card-engine.js';
import { lintCard } from './card-engine.js';

/**
 * Produce a card scorecard from a parsed Agent Card JSON value.
 *
 * @example
 * ```ts
 * const scorecard = scoreCardLintOnly(JSON.parse(cardJson));
 * console.log(scorecard.aggregate.lintScore, scorecard.signature.tier);
 * ```
 */
export function scoreCardLintOnly(input: unknown): CardScorecard {
  const result: CardLintResult = lintCard(input);
  return {
    schemaVersion: CARD_SCHEMA_VERSION,
    card: result.card,
    axes: result.axisScores,
    aggregate: result.aggregate,
    skills: result.skills,
    signature: result.signature,
  };
}
