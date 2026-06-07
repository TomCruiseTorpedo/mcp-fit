/**
 * mcp-fit fix-mode delta emitter (B-007).
 *
 * Computes a before/after delta from two LintResult values, emitting
 * per-axis score changes and a token-waste delta.
 *
 * Spec: Fix Mode (specs/mcp-fit/spec.md)
 * "emit before/after per-axis and token-waste delta"
 * Owns: src/fix/
 */

import type { AxisName } from '../types.js';
import { AXIS_NAMES } from '../types.js';
import type { LintResult } from '../lint/engine.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-axis score change. */
export interface AxisDelta {
  axis: AxisName;
  /** Deterministic 1–10 score, or null for eval-only axes. */
  before: number | null;
  after: number | null;
  /** Positive = improvement, negative = regression; null when either side is eval-only. */
  delta: number | null;
}

/**
 * Full before/after fix-mode comparison.
 *
 * - `axes`: per-axis score breakdown.
 * - `before`/`after`: overall weighted lint score.
 * - `scoreDelta`: aggregate improvement (positive = better).
 * - `tokenWasteDelta`: output-leanness axis delta (describes-lean-output improvement).
 * - `findingsEliminated`: error + warning findings resolved (actionable metric).
 * - `hasMaterialImprovement`: true when any meaningful improvement occurred.
 */
export interface FixDelta {
  axes: AxisDelta[];
  before: number;
  after: number;
  /** Change in weighted lint score, rounded to one decimal. */
  scoreDelta: number;
  /**
   * Change in output-leanness axis score (proxy for token-waste reduction).
   * That axis is eval-only, so this is null without --eval — output-shape
   * quality is a runtime property static lint cannot grade.
   */
  tokenWasteDelta: number | null;
  /** Number of error/warning findings eliminated. */
  findingsEliminated: number;
  /**
   * True when the aggregate score improved OR at least one finding
   * was eliminated. False for a genuine no-op.
   */
  hasMaterialImprovement: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count error and warning findings in a LintResult. Info findings are excluded. */
function countActionableFindings(lintResult: LintResult): number {
  let count = 0;
  for (const tool of lintResult.tools) {
    for (const f of tool.findings) {
      if (f.severity === 'error' || f.severity === 'warning') {
        count++;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Compute a before/after delta from two LintResult values.
 *
 * @param before  Lint result from the original (pre-fix) tool definitions.
 * @param after   Lint result after applying description overrides.
 */
export function computeDelta(before: LintResult, after: LintResult): FixDelta {
  const axes: AxisDelta[] = AXIS_NAMES.map((axis) => {
    const b = before.axisScores[axis].score;
    const a = after.axisScores[axis].score;
    // Eval-only axes (null) carry no deterministic delta.
    const delta = a === null || b === null ? null : a - b;
    return { axis, before: b, after: a, delta };
  });

  const beforeWeighted = before.aggregate.weighted;
  const afterWeighted = after.aggregate.weighted;

  // Token-waste delta = improvement on the output-leanness axis, which is
  // eval-only (a runtime output-shape property static lint cannot grade) → the
  // deterministic delta is null; --eval measures the real change.
  const olAfter = after.axisScores['output-leanness'].score;
  const olBefore = before.axisScores['output-leanness'].score;
  const tokenWasteDelta = olAfter === null || olBefore === null ? null : olAfter - olBefore;

  const beforeFindings = countActionableFindings(before);
  const afterFindings = countActionableFindings(after);
  const findingsEliminated = Math.max(0, beforeFindings - afterFindings);

  const hasMaterialImprovement =
    afterWeighted > beforeWeighted || findingsEliminated > 0;

  return {
    axes,
    before: beforeWeighted,
    after: afterWeighted,
    scoreDelta: Math.round((afterWeighted - beforeWeighted) * 10) / 10,
    tokenWasteDelta,
    findingsEliminated,
    hasMaterialImprovement,
  };
}

// ---------------------------------------------------------------------------
// Human-readable formatter
// ---------------------------------------------------------------------------

/**
 * Format a FixDelta as a human-readable multi-line summary.
 *
 * Only shows axes that changed. Shows a "no material improvement" line when
 * the fix had no effect.
 */
export function formatDelta(delta: FixDelta): string {
  const lines: string[] = [];

  const sign = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

  lines.push(
    `Fix-mode delta: ${delta.before.toFixed(1)} → ${delta.after.toFixed(1)}` +
      ` (${sign(delta.scoreDelta)})`,
  );

  for (const axis of delta.axes) {
    // Eval-only axes (null delta) have no deterministic change to report.
    if (axis.delta === null || axis.delta === 0) continue;
    lines.push(`  ${axis.axis}: ${axis.before} → ${axis.after} (${sign(axis.delta)})`);
  }

  if (delta.findingsEliminated > 0) {
    lines.push(`  Findings eliminated: ${delta.findingsEliminated}`);
  }

  if (!delta.hasMaterialImprovement) {
    lines.push('  No material improvement available.');
  }

  return lines.join('\n');
}
