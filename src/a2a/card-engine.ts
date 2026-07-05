/**
 * A2A Agent Card lint engine (ADR-F).
 *
 * Runs all card rules plus the structural signature analysis against one
 * Agent Card JSON document and produces:
 *  - per-skill findings
 *  - per-axis scores (deterministic, 1–10 — every card axis is deterministic)
 *  - a weighted aggregate card score (ADR-F3 weights)
 *  - the SignatureReport (ADR-F4 structural tier)
 *
 * Determinism guarantee: given the same card JSON, `lintCard()` always returns
 * structurally-identical output. No randomness, no I/O, no global mutable state.
 * Mirrors src/lint/engine.ts mechanics (severity deductions, floor 1, weighted
 * mean to one decimal).
 */

import { SEVERITY_DEDUCTION } from '../lint/engine.js';
import type {
  AgentCardJson,
  CardAxisName,
  CardAxisScore,
  CardFinding,
  CardMeta,
  SignatureReport,
  SkillReport,
} from './card-types.js';
import { CARD_AXIS_NAMES } from './card-types.js';
import { ALL_CARD_RULES, skillKey } from './card-rules.js';
import { analyseSignatures } from './signature.js';
import { weightedCardAggregate } from './card-axes.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Full result returned by lintCard(). */
export interface CardLintResult {
  /** Identity of the scored card (unknowns fall back to 'unknown'). */
  card: CardMeta;
  /** Per-skill findings (sorted by skill key for determinism). */
  skills: SkillReport[];
  /** Per-axis deterministic scores. */
  axisScores: Readonly<Record<CardAxisName, CardAxisScore>>;
  /** Weighted aggregate (ADR-F3). */
  aggregate: { lintScore: number; weighted: number };
  /** Structural signature analysis (ADR-F4). */
  signature: SignatureReport;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Compute a raw 1–10 axis score from its findings (same math as MCP lint). */
function axisScore(findings: readonly CardFinding[]): number {
  let deduction = 0;
  for (const f of findings) {
    deduction += SEVERITY_DEDUCTION[f.severity];
  }
  return Math.max(1, 10 - deduction);
}

/** True when the value is a plain (non-array) object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the card lint engine against a parsed Agent Card JSON value.
 *
 * Accepts `unknown`: a non-object input is treated as an empty card (every
 * REQUIRED-field rule fires) plus an explicit invalid-document finding — the
 * caller always gets a scorecard, never a throw.
 *
 * @example
 * ```ts
 * import { lintCard } from './src/a2a/card-engine.js';
 * const result = lintCard(JSON.parse(readFileSync('agent-card.json', 'utf8')));
 * console.log(result.aggregate.lintScore); // e.g. 6.1
 * ```
 */
export function lintCard(input: unknown): CardLintResult {
  const invalidDocument = !isPlainObject(input);
  const card: AgentCardJson = invalidDocument ? {} : (input as AgentCardJson);

  // ── 1. Collect findings from all rules + signature analysis ──────────────
  const findings: CardFinding[] = [];

  if (invalidDocument) {
    findings.push({
      ruleId: 'invalid-card-document',
      axis: 'card-completeness',
      severity: 'error',
      message: 'Input is not a JSON object — an Agent Card must be a single JSON document.',
    });
  }

  for (const rule of ALL_CARD_RULES) {
    findings.push(...rule.check(card));
  }

  const signature = analyseSignatures(card);
  findings.push(...signature.findings);

  // ── 2. Aggregate findings by axis ─────────────────────────────────────────
  const byAxis = {} as Record<CardAxisName, CardFinding[]>;
  for (const axis of CARD_AXIS_NAMES) byAxis[axis] = [];
  for (const finding of findings) byAxis[finding.axis].push(finding);

  // ── 3. Build per-axis scores ──────────────────────────────────────────────
  //
  // Badge-inflation guard (the run-1 strawman lesson, card edition): an axis
  // with nothing to grade must not award a vacuous 10.
  //  - invalid document → nothing is measurable → every axis floors to 1.
  //  - zero skills      → the skill axes have no material → they floor to 1
  //    (skills are REQUIRED; a card that gives agents nothing to select is a
  //    defect, not a clean sheet — completeness carries the explicit finding).
  const skillList = Array.isArray(card.skills) ? card.skills : [];
  const noSkills = skillList.length === 0;
  const SKILL_AXES: ReadonlySet<CardAxisName> = new Set([
    'skill-namespacing',
    'skill-selection-overlap',
  ]);

  const axisScores = {} as Record<CardAxisName, CardAxisScore>;
  for (const axis of CARD_AXIS_NAMES) {
    const ungradable = invalidDocument || (noSkills && SKILL_AXES.has(axis));
    axisScores[axis] = {
      score: ungradable ? 1 : axisScore(byAxis[axis]),
      kind: 'deterministic',
      findings: byAxis[axis],
    };
  }

  // ── 4. Build per-skill reports (sorted by key for determinism) ────────────
  const reports: SkillReport[] = skillList
    .map((skill, i) => {
      const key = skillKey(isPlainObject(skill) ? skill : {}, i);
      return {
        id: key,
        findings: findings.filter((f) => f.skill === key),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  // ── 5. Weighted aggregate (ADR-F3) ────────────────────────────────────────
  const perAxisNumbers = {} as Record<CardAxisName, number>;
  for (const axis of CARD_AXIS_NAMES) perAxisNumbers[axis] = axisScores[axis].score;
  const weighted = weightedCardAggregate(perAxisNumbers);

  return {
    card: {
      name: typeof card.name === 'string' && card.name.length > 0 ? card.name : 'unknown',
      version:
        typeof card.version === 'string' && card.version.length > 0 ? card.version : 'unknown',
    },
    skills: reports,
    axisScores,
    aggregate: {
      lintScore: weighted, // deterministic headline — every card axis is deterministic
      weighted,
    },
    signature,
  };
}
