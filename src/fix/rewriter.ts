/**
 * mcp-fit fix-mode rewriter (B-007).
 *
 * Uses Claude to auto-rewrite tool and parameter descriptions based on lint
 * findings. Applies via the re-presentation proxy (ADR-D): behaviour unchanged,
 * descriptions/metadata only.
 *
 * No-op honesty: if the server is already clean (no error/warning findings),
 * returns empty overrides with a "no material improvement available" message.
 *
 * Spec: Fix Mode (specs/mcp-fit/spec.md)
 * Owns: src/fix/
 */

import Anthropic from '@anthropic-ai/sdk';
import type { DescriptionOverride, Finding, ToolDef } from '../types.js';
import type { LintResult } from '../lint/engine.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for the rewriter. */
export interface RewriterOptions {
  /** Injectable Anthropic client (useful for tests — avoids live API calls). */
  client?: Anthropic;
  /** Anthropic API key. Defaults to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /**
   * Model for description rewriting.
   * Defaults to claude-3-5-haiku-20241022 (fast + cheap).
   */
  model?: string;
  /** Max tokens per LLM call. Default 1024. */
  maxTokens?: number;
  /**
   * Weighted lint score threshold for no-op honesty.
   * If lintScore >= threshold AND no error-severity findings, return
   * "no material improvement available". Default 9.0.
   */
  noOpThreshold?: number;
}

/** Result of a rewrite run. */
export interface RewriterResult {
  /** Description overrides to apply via the proxy. Empty when no-op. */
  overrides: DescriptionOverride[];
  /** Human-readable message about the operation. */
  message: string;
  /** Whether any improvements were generated. */
  hasImprovements: boolean;
}

// ---------------------------------------------------------------------------
// No-op detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the server is already clean and no rewrites are warranted.
 *
 * Condition: weighted lint score >= threshold AND zero error-severity findings.
 * Info-level findings (no-output-schema, no-error-docs) are not considered
 * actionable — they cannot be fixed by description overrides alone.
 */
export function isAlreadyClean(
  lintResult: LintResult,
  threshold = 9.0,
): boolean {
  if (lintResult.aggregate.lintScore < threshold) return false;
  for (const tool of lintResult.tools) {
    for (const finding of tool.findings) {
      if (finding.severity === 'error' || finding.severity === 'warning') {
        return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rule-based fallback
// ---------------------------------------------------------------------------

/**
 * Generate a DescriptionOverride for a single tool using rule-based heuristics.
 *
 * Used when the LLM is unavailable (no API key, network error, etc.).
 * Produces generic but syntactically valid descriptions that fix error findings.
 */
export function buildRuleBasedOverride(
  tool: ToolDef,
  findings: readonly Finding[],
): DescriptionOverride | null {
  const params: Record<string, string> = {};
  let description: string | undefined;

  const ruleIds = new Set(findings.map((f) => f.ruleId));

  // Fix missing tool description
  if (ruleIds.has('no-missing-tool-description')) {
    const readable = tool.name.replace(/[_\-]/g, ' ');
    description = `Performs the ${readable} operation. Returns an error if the operation fails.`;
  }

  // Fix missing required param descriptions
  const missingParamFindings = findings.filter(
    (f) => f.ruleId === 'no-required-param-description' && typeof f.param === 'string',
  );
  for (const f of missingParamFindings) {
    if (typeof f.param === 'string') {
      params[f.param] = `The ${f.param} for this operation.`;
    }
  }

  if (description === undefined && Object.keys(params).length === 0) {
    return null;
  }

  const override: DescriptionOverride = { tool: tool.name };
  if (description !== undefined) override.description = description;
  if (Object.keys(params).length > 0) override.params = params;
  return override;
}

// ---------------------------------------------------------------------------
// LLM prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the LLM prompt for rewriting a single tool's descriptions.
 */
function buildRewritePrompt(
  tool: ToolDef,
  findings: readonly Finding[],
  allToolNames: readonly string[],
): string {
  const findingLines = findings
    .map((f) => `  [${f.severity}] ${f.ruleId ?? f.axis}: ${f.message}`)
    .join('\n');

  const paramLines =
    tool.inputSchema.properties && Object.keys(tool.inputSchema.properties).length > 0
      ? Object.entries(tool.inputSchema.properties)
          .map(([n, p]) => `  - ${n} (${p['type'] ?? 'unknown'}): ${p['description'] ?? '(no description)'}`)
          .join('\n')
      : '  (no parameters)';

  const otherTools = allToolNames.filter((n) => n !== tool.name);
  const otherToolsLine =
    otherTools.length > 0 ? `OTHER TOOLS IN SERVER: ${otherTools.join(', ')}` : '';

  return `You are rewriting an MCP tool's descriptions to fix agent-usability issues.
Only tool and param DESCRIPTIONS change — behaviour, schema structure, and tool names are UNCHANGED.

TOOL: ${tool.name}
CURRENT DESCRIPTION: ${tool.description ?? '(none)'}
PARAMETERS:
${paramLines}
${otherToolsLine}

FINDINGS TO FIX:
${findingLines}

Produce improved descriptions. Output ONLY valid JSON (no markdown fences, no commentary):
{
  "description": "<improved tool description>",
  "params": {
    "<paramName>": "<improved param description>"
  }
}

Guidelines:
- description: start with an action verb; mention what the tool does, what it returns, and error behaviour
- description: ≤ 200 characters; be specific and concise
- params: only include params that need fixing; ≤ 80 characters each
- If this tool overlaps semantically with another, clearly differentiate their purpose`;
}

// ---------------------------------------------------------------------------
// LLM response parser
// ---------------------------------------------------------------------------

/**
 * Parse an LLM response into description and param override fields.
 * Returns empty object on any parse failure (caller uses rule-based fallback).
 */
function parseRewriteResponse(
  text: string,
): { description?: string; params?: Record<string, string> } {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return {};
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const result: { description?: string; params?: Record<string, string> } = {};
  const obj = parsed as Record<string, unknown>;

  if (typeof obj['description'] === 'string' && obj['description'].trim().length > 0) {
    result.description = obj['description'].trim();
  }

  if (
    obj['params'] !== null &&
    obj['params'] !== undefined &&
    typeof obj['params'] === 'object' &&
    !Array.isArray(obj['params'])
  ) {
    const paramsMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj['params'] as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim().length > 0) {
        paramsMap[k] = v.trim();
      }
    }
    if (Object.keys(paramsMap).length > 0) {
      result.params = paramsMap;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Rewrite tool and parameter descriptions to fix lint findings.
 *
 * Algorithm:
 *   1. Check no-op threshold — return early if server is already clean.
 *   2. Identify tools with actionable (error/warning) findings.
 *   3. For each such tool, call Claude to generate an improved description.
 *   4. Fall back to rule-based heuristics if the LLM is unavailable.
 *   5. Return the set of DescriptionOverride records.
 *
 * The returned overrides are applied by `revalidate()` via the re-presentation
 * proxy (ADR-D). Behaviour is guaranteed unchanged.
 *
 * @param tools       Full tool definitions (needed for inputSchema details).
 * @param lintResult  Lint result providing per-tool findings.
 * @param options     Configuration (injectable client, model, thresholds).
 */
export async function rewrite(
  tools: readonly ToolDef[],
  lintResult: LintResult,
  options: RewriterOptions = {},
): Promise<RewriterResult> {
  const {
    model = 'claude-3-5-haiku-20241022',
    maxTokens = 1024,
    noOpThreshold = 9.0,
  } = options;

  // ── No-op honesty path ────────────────────────────────────────────────────
  if (isAlreadyClean(lintResult, noOpThreshold)) {
    return {
      overrides: [],
      message: 'No material improvement available — server descriptions are already clean.',
      hasImprovements: false,
    };
  }

  // ── Build per-tool actionable findings map ────────────────────────────────
  const toolFindingsMap = new Map<string, Finding[]>();
  for (const toolReport of lintResult.tools) {
    const actionable = toolReport.findings.filter(
      (f) => f.severity === 'error' || f.severity === 'warning',
    );
    if (actionable.length > 0) {
      toolFindingsMap.set(toolReport.name, actionable);
    }
  }

  if (toolFindingsMap.size === 0) {
    return {
      overrides: [],
      message: 'No actionable (error/warning) findings to fix.',
      hasImprovements: false,
    };
  }

  const allToolNames = tools.map((t) => t.name);

  // ── Resolve Anthropic client (injectable for tests) ───────────────────────
  const client: Anthropic | null = options.client ?? (() => {
    const key = options.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (!key) return null;
    return new Anthropic({ apiKey: key });
  })();

  // ── Generate overrides per tool ───────────────────────────────────────────
  const overrides: DescriptionOverride[] = [];

  for (const tool of tools) {
    const findings = toolFindingsMap.get(tool.name);
    if (!findings || findings.length === 0) continue;

    let override: DescriptionOverride | null = null;

    // Try LLM first
    if (client !== null) {
      try {
        const prompt = buildRewritePrompt(tool, findings, allToolNames);
        const response = await client.messages.create({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        });
        const text = response.content
          .filter((b) => b.type === 'text')
          .map((b): string => (b as { type: 'text'; text: string }).text)
          .join('');
        const parsed = parseRewriteResponse(text);
        if (parsed.description !== undefined || parsed.params !== undefined) {
          override = { tool: tool.name, ...parsed };
        }
      } catch {
        // LLM call failed — fall through to rule-based
      }
    }

    // Rule-based fallback
    if (override === null) {
      override = buildRuleBasedOverride(tool, findings);
    }

    if (override !== null) {
      overrides.push(override);
    }
  }

  if (overrides.length === 0) {
    return {
      overrides: [],
      message: 'No improvements could be generated.',
      hasImprovements: false,
    };
  }

  return {
    overrides,
    message: `Generated ${overrides.length} description override(s) to fix lint findings.`,
    hasImprovements: true,
  };
}
