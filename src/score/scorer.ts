/**
 * mcp-fit scorer — B-006
 *
 * Combines deterministic lint sub-scores (B-002) with the stochastic
 * contract-rubric eval scores (rubric.ts) into a unified Scorecard.
 *
 * The deterministic lint aggregate is the badge-able headline.
 * The stochastic eval aggregate is reported separately with variance.
 * Both are written into compat.json via emitCompat (B-004).
 *
 * Spec: Scorecard (specs/mcp-fit/spec.md §Requirement: Scorecard)
 * ADR: ADR-C (weights), ADR-A (Scorecard shape)
 * Owns: src/score/
 */

import type {
  AxisName,
  AxisScore,
  AggregateScore,
  EvalScore,
  Finding,
  Scorecard,
  ServerMeta,
  TaskTrace,
  ToolReport,
} from '../types.js';
import { AXIS_NAMES, COMPAT_SCHEMA_VERSION } from '../types.js';
import type { LintResult } from '../lint/engine.js';
import { AXIS_LINEAGE, AXIS_WEIGHTS, weightedAggregate } from './axes.js';
import type { RubricLoopOptions, RubricLoopResult } from './rubric.js';
import { runRubricLoop } from './rubric.js';
import type { EvalTask } from '../eval/harness.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Input to the scorer: lint result + optional eval traces + task corpus.
 * Both the server meta and tool reports come from the lint pipeline.
 */
export interface ScorerInput {
  /** Server metadata from introspection. */
  server: ServerMeta;
  /** Lint result from the static lint engine (B-002). */
  lintResult: LintResult;
  /**
   * Eval traces from the dynamic eval runner (B-005), paired with their
   * source tasks (needed for rubric generation). Omit to produce a
   * lint-only scorecard.
   */
  evalTraces?: Array<{ task: EvalTask; trace: TaskTrace }>;
  /** All tool names the server exposes (for rubric generation context). */
  toolNames?: string[];
  /** Options for the contract-rubric loop. Omit to use defaults. */
  rubricOptions?: RubricLoopOptions;
}

/**
 * Full scorer output — wraps the Scorecard (compat.json shape) plus any
 * per-task rubric details for downstream use.
 */
export interface ScorerResult {
  scorecard: Scorecard;
  /** Rubric loop results per task (empty when eval was not run). */
  rubricResults: RubricLoopResult[];
}

// ---------------------------------------------------------------------------
// Internal: build per-axis stochastic scores from rubric results
// ---------------------------------------------------------------------------

/**
 * Map rubric loop results onto axis scores.
 *
 * The rubric judge scores overall agent quality, not per-axis quality, so we
 * use a pragmatic approach: distribute the rubric score uniformly across all
 * axes but weight it by how much each axis contributes to agent usability.
 *
 * The intent: the stochastic component reflects "did the agent succeed?", with
 * the per-axis split informing the `evalScore` aggregate.
 *
 * Returns a per-axis mean and variance derived from the rubric results.
 */
function rubricToAxisScores(
  results: RubricLoopResult[],
): { perAxisMean: Record<AxisName, number>; overallMean: number; overallStdev: number } {
  if (results.length === 0) {
    const perAxisMean = {} as Record<AxisName, number>;
    for (const axis of AXIS_NAMES) perAxisMean[axis] = 5;
    return { perAxisMean, overallMean: 5, overallStdev: 0 };
  }

  // Compute overall mean and stdev across all task rubric scores
  const allScores = results.map((r) => r.mean);
  const overallMean =
    allScores.reduce((a, b) => a + b, 0) / allScores.length;
  const overallVariance =
    allScores.reduce((sum, s) => sum + (s - overallMean) ** 2, 0) / allScores.length;
  const overallStdev = Math.sqrt(overallVariance);

  // Distribute the overall score uniformly across axes (rubric is holistic)
  const perAxisMean = {} as Record<AxisName, number>;
  for (const axis of AXIS_NAMES) {
    perAxisMean[axis] = Math.round(overallMean * 10) / 10;
  }

  return {
    perAxisMean,
    overallMean: Math.round(overallMean * 10) / 10,
    overallStdev: Math.round(overallStdev * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Internal: merge lint and eval axis scores
// ---------------------------------------------------------------------------

/**
 * Produce the final AxisScore record.
 *
 * - Deterministic (lint) axis scores are taken directly from LintResult.
 * - Stochastic (eval) axis scores are computed from rubric results.
 * - The `kind` field distinguishes the two for compat.json consumers.
 * - When eval is absent, all axes are 'deterministic'.
 */
function buildAxisScores(
  lintResult: LintResult,
  rubricResults: RubricLoopResult[],
): Record<AxisName, AxisScore> {
  const hasEval = rubricResults.length > 0;
  const { perAxisMean, overallStdev } = rubricToAxisScores(rubricResults);

  const axisScores = {} as Record<AxisName, AxisScore>;

  for (const axis of AXIS_NAMES) {
    const lintAxisScore = lintResult.axisScores[axis];
    const lintFindings: Finding[] = lintAxisScore.findings;

    if (!hasEval) {
      // Lint-only mode: preserve the engine's per-axis kind — eval-only axes
      // stay 'eval' with a null score (no deterministic verdict), so the badge
      // never claims a score it did not measure.
      axisScores[axis] = {
        score: lintAxisScore.score,
        lineage: AXIS_LINEAGE[axis],
        kind: lintAxisScore.kind,
        findings: lintFindings,
      };
    } else {
      // Blended mode: report the stochastic eval score with variance.
      // The lint score is preserved in findings; the reported score is eval.
      axisScores[axis] = {
        score: Math.round(perAxisMean[axis]),
        lineage: AXIS_LINEAGE[axis],
        kind: 'eval',
        findings: lintFindings,
        variance: overallStdev,
      };
    }
  }

  return axisScores;
}

// ---------------------------------------------------------------------------
// Internal: build AggregateScore
// ---------------------------------------------------------------------------

function buildAggregate(
  lintResult: LintResult,
  rubricResults: RubricLoopResult[],
): AggregateScore {
  const lintScore = lintResult.aggregate.lintScore;

  if (rubricResults.length === 0) {
    // Lint-only: weighted = lintScore
    return {
      lintScore,
      weighted: lintScore,
    };
  }

  // Stochastic eval aggregate
  const { overallMean, overallStdev } = rubricToAxisScores(rubricResults);

  const evalScore: EvalScore = {
    mean: overallMean,
    stdev: overallStdev,
    n: rubricResults.length,
  };

  // Combined weighted aggregate: blend lint and eval scores (equal weight)
  // Lint is the deterministic baseline; eval reflects actual agent behaviour.
  // The combined score applies ADR-C axis weights to the eval per-axis scores
  // but anchors the lint dimension.
  const evalAxisScores = {} as Record<AxisName, number>;
  for (const axis of AXIS_NAMES) {
    // All axes share the overall eval mean (rubric is holistic)
    evalAxisScores[axis] = Math.round(overallMean);
  }
  const evalWeighted = weightedAggregate(evalAxisScores);

  // The combined "weighted" score is the average of lint and eval weighted scores,
  // rounded to one decimal place.
  const combined =
    Math.round(((lintScore + evalWeighted) / 2) * 10) / 10;

  return {
    lintScore,
    evalScore,
    weighted: combined,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Score an MCP server by combining deterministic lint results with an optional
 * stochastic contract-rubric eval loop.
 *
 * When `evalTraces` is omitted (or empty), the result is a lint-only scorecard:
 * all axis scores are deterministic and `evalScore` is absent from the aggregate.
 *
 * When `evalTraces` is provided, the contract-rubric loop is run for each
 * non-low-signal trace, and the result includes both lint and eval scores with
 * variance.
 *
 * @example
 * ```ts
 * // Lint-only scorecard (cheap, deterministic)
 * const { scorecard } = await score({ server, lintResult });
 *
 * // Full scorecard with eval
 * const { scorecard, rubricResults } = await score({
 *   server,
 *   lintResult,
 *   evalTraces: traces.map((trace, i) => ({ task: tasks[i], trace })),
 *   toolNames: serverToolNames,
 * });
 * ```
 */
export async function score(input: ScorerInput): Promise<ScorerResult> {
  const { server, lintResult, evalTraces = [], toolNames = [], rubricOptions } = input;

  // ── 1. Run the contract-rubric loop for non-low-signal traces ─────────────
  const rubricResults: RubricLoopResult[] = [];

  // Low-signal tasks (trivial single-call) are excluded per the selectivity
  // principle — they do not dominate the aggregate (spec §Dynamic Eval).
  const highSignalTraces = evalTraces.filter(({ trace }) => !trace.lowSignal);

  for (const { task, trace } of highSignalTraces) {
    const result = await runRubricLoop(task, trace, toolNames, rubricOptions);
    rubricResults.push(result);
  }

  // ── 2. Build per-axis scores ──────────────────────────────────────────────
  const axes = buildAxisScores(lintResult, rubricResults);

  // ── 3. Build aggregate ────────────────────────────────────────────────────
  const aggregate = buildAggregate(lintResult, rubricResults);

  // ── 4. Build tool reports (from lint) ─────────────────────────────────────
  const tools: ToolReport[] = lintResult.tools;

  // ── 5. Assemble the Scorecard ─────────────────────────────────────────────
  const scorecard: Scorecard = {
    schemaVersion: COMPAT_SCHEMA_VERSION,
    server,
    axes,
    aggregate,
    tools,
  };

  return { scorecard, rubricResults };
}

// ---------------------------------------------------------------------------
// Convenience: lint-only score (synchronous) — no LLM calls
// ---------------------------------------------------------------------------

/**
 * Produce a lint-only scorecard synchronously (no LLM calls, zero latency).
 *
 * Useful for CI gates, badges, and smoke tests where eval is not needed.
 * The returned scorecard has deterministic axis scores and no `evalScore`.
 */
export function scoreLintOnly(server: ServerMeta, lintResult: LintResult): Scorecard {
  // Build axis scores from lint only
  const axes: Record<AxisName, AxisScore> = {} as Record<AxisName, AxisScore>;
  for (const axis of AXIS_NAMES) {
    const la = lintResult.axisScores[axis];
    axes[axis] = {
      score: la.score,
      lineage: AXIS_LINEAGE[axis],
      // Preserve the engine's kind: eval-only axes stay 'eval' with a null score.
      kind: la.kind,
      findings: la.findings,
    };
  }

  const lintScore = lintResult.aggregate.lintScore;

  return {
    schemaVersion: COMPAT_SCHEMA_VERSION,
    server,
    axes,
    aggregate: {
      lintScore,
      weighted: lintScore,
    },
    tools: lintResult.tools,
  };
}

// ---------------------------------------------------------------------------
// Re-export axis metadata for consumers that only need the weights/lineage
// ---------------------------------------------------------------------------

export { AXIS_LINEAGE, AXIS_WEIGHTS, weightedAggregate } from './axes.js';
