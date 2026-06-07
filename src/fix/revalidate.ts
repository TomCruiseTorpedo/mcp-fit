/**
 * mcp-fit fix-mode re-validation (B-007).
 *
 * Applies description overrides via the re-presentation proxy and re-runs
 * the static lint engine to produce an updated LintResult.
 *
 * This is the second step in the fix pipeline:
 *   1. rewrite()    → overrides
 *   2. revalidate() → updated scorecard (this file)
 *   3. delta()      → before/after comparison
 *
 * Behaviour-unchanged guarantee: only descriptions change. The tool's
 * inputSchema structure (type, required, property names) is preserved verbatim.
 *
 * Spec: Fix Mode (specs/mcp-fit/spec.md)
 * Owns: src/fix/
 */

import type { DescriptionOverride, ServerIntrospection, ToolDef } from '../types.js';
import type { LintResult } from '../lint/engine.js';
import { lint } from '../lint/engine.js';
import { applyOverridesToIntrospection } from '../connect/proxy.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of re-validating a server after applying description overrides. */
export interface RevalidateResult {
  /** Updated lint result produced from the rewritten tool definitions. */
  lintResult: LintResult;
  /** The rewritten tool definitions (overrides applied, behaviour unchanged). */
  tools: ToolDef[];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Apply description overrides to a `ServerIntrospection` and re-run lint.
 *
 * Uses `applyOverridesToIntrospection` (same function as the runtime proxy)
 * so the behaviour-unchanged guarantee is enforced at the structural level:
 * only `description` fields in tools and their parameters are touched.
 *
 * @param introspection  Original server introspection result.
 * @param overrides      Description overrides from `rewrite()`.
 * @returns Updated lint result and the rewritten tool definitions.
 */
export function revalidate(
  introspection: ServerIntrospection,
  overrides: DescriptionOverride[],
): RevalidateResult {
  // Apply overrides via the same proxy logic used at runtime.
  // applyOverridesToIntrospection is a pure function — no mutation.
  const updated = applyOverridesToIntrospection(introspection, overrides);

  // Re-run the deterministic lint engine on the updated tools.
  const lintResult = lint(updated.tools);

  return {
    lintResult,
    tools: updated.tools,
  };
}

/**
 * Convenience overload: re-validate a flat tools array without a full
 * `ServerIntrospection` wrapper.
 *
 * Useful for unit tests and pipeline stages that have tools but not the
 * full introspection result.
 */
export function revalidateTools(
  tools: readonly ToolDef[],
  overrides: DescriptionOverride[],
): RevalidateResult {
  const introspection: ServerIntrospection = {
    server: { name: 'unknown', version: '0.0.0', transport: 'stdio' },
    tools: tools as ToolDef[],
    resources: [],
    prompts: [],
  };
  return revalidate(introspection, overrides);
}
