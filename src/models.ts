/**
 * Centralized model selection + model-error helpers for the score engine.
 *
 * One source of truth for the default Claude model, so a model retirement is a
 * single-line edit instead of a scatter of inline literals across harness,
 * rubric, and rewriter.
 *
 * History: the previous default (`claude-3-5-haiku-20241022`) was retired on
 * 2026-02-19 and now returns 404. Because the rubric/scoring catch blocks
 * swallowed every error and fell back to canned output, the break was invisible
 * — scores silently degraded to pass/fail-derived numbers. {@link isModelConfigError}
 * exists so callers can refuse to mask that class of failure.
 */

/**
 * Default model for harness runs, rubric generation, and scoring.
 *
 * Fast + cheap successor to the retired `claude-3-5-haiku-20241022`. Override
 * per call via the `model` option on any of the score-engine entry points.
 */
export const DEFAULT_SCORE_MODEL = 'claude-haiku-4-5';

/**
 * True when an error is a *configuration* error that must NOT be silently
 * swallowed: a retired/unknown model (404), or a missing/invalid API key
 * (401/403). These mean the setup is broken — surfacing them is correct;
 * falling back to canned output hides the breakage. Transient errors
 * (429/5xx/network) are deliberately excluded so resilient fallbacks still
 * apply to them.
 */
export function isModelConfigError(err: unknown): boolean {
  const status = (err as { status?: number } | null | undefined)?.status;
  return status === 404 || status === 401 || status === 403;
}
