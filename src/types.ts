/**
 * mcp-fit shared types — canonical contract (ADR-A).
 *
 * This is the single source of truth for all scorecard, finding, axis, trace,
 * MCP-wire, and introspection types. Every other bead imports from here and
 * never redefines these contracts. Changing this file is a new ADR.
 *
 * Spec: Machine-Readable Output (specs/mcp-fit/spec.md)
 * ADR: ADR-A (docs/adr/ADR-A-scorecard-schema.md)
 *
 * Integration note (B-009): Guzzle (B-004) is the canonical authority per ADR-A.
 * Extended with:
 *   - ruleId on Finding (lint rule traceability, optional)
 *   - McpParam, McpInputSchema, McpTool (B-002 lint input shapes)
 *   - ToolDef, ResourceDef, PromptDef, ServerIntrospection (B-001 connector)
 *   - DescriptionOverride (B-001 proxy / B-007 fix-mode)
 */

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

/** Bump this when the compat.json shape changes in a breaking way. */
export const COMPAT_SCHEMA_VERSION = '1.0.0';

/** Bump this when the evals.jsonl entry shape changes in a breaking way. */
export const EVALS_SCHEMA_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Server metadata
// ---------------------------------------------------------------------------

export type TransportKind = 'stdio' | 'sse' | 'http';

export interface ServerMeta {
  name: string;
  version: string;
  transport: TransportKind;
}

// ---------------------------------------------------------------------------
// Scorecard axes (spec §Requirement: Scorecard)
// ---------------------------------------------------------------------------

/**
 * The five agent-usability axes.
 * Lineage traces to the provider-side dual of the RubricRefine taxonomy
 * (arXiv 2605.09730).
 */
export type AxisName =
  | 'namespacing'
  | 'tool-selection-confusion'
  | 'param-strictness'
  | 'output-leanness'
  | 'error-helpfulness';

/** Every axis in a fixed order for iteration. */
export const AXIS_NAMES: readonly AxisName[] = [
  'namespacing',
  'tool-selection-confusion',
  'param-strictness',
  'output-leanness',
  'error-helpfulness',
] as const;

/**
 * Axes the deterministic static lint can meaningfully assess. Axes NOT listed
 * here are eval-only: their quality is behavioural (output shape, error
 * helpfulness, tool-selection confusion at runtime) and cannot be graded
 * statically. Eval-only axes are excluded from the deterministic aggregate and
 * carry a null deterministic `score` until `--eval` populates them — so the
 * badge never claims a verdict it did not measure.
 */
export const DETERMINISTIC_AXES: ReadonlySet<AxisName> = new Set<AxisName>([
  'namespacing',
  'param-strictness',
]);

/**
 * RubricRefine provider-side contract category each axis traces to.
 *
 * | Axis                        | Lineage          |
 * |-----------------------------|------------------|
 * | namespacing                 | tool-choice      |
 * | tool-selection-confusion    | tool-choice      |
 * | param-strictness            | call-signature   |
 * | output-leanness             | output-contract  |
 * | error-helpfulness           | provider-only    |
 */
export type LineageCategory =
  | 'tool-choice'
  | 'call-signature'
  | 'output-contract'
  | 'provider-only';

/** Whether a score was produced by deterministic lint or stochastic eval. */
export type ScoreKind = 'deterministic' | 'eval';

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type FindingSeverity = 'error' | 'warning' | 'info';

/**
 * A single diagnostic finding from lint or eval, tagged to an axis.
 * `tool` and `param` are optional for findings that don't target a specific
 * tool or parameter.
 *
 * `ruleId` is optional — set by lint rules for traceability; absent for
 * eval-derived findings.
 */
export interface Finding {
  /** Lint rule identifier, e.g. 'no-missing-tool-description'. Optional. */
  ruleId?: string;
  axis: AxisName;
  severity: FindingSeverity;
  message: string;
  /** Offending tool name, if applicable. */
  tool?: string;
  /** Offending parameter name, if applicable. */
  param?: string;
}

// ---------------------------------------------------------------------------
// Axis score
// ---------------------------------------------------------------------------

/**
 * Score for a single axis.
 * - `score`: ordinal 1–10; 10 = trivially correct, 1–4 = very easy to get wrong.
 * - `kind`: 'deterministic' for lint-derived scores (reproducible, badge-able);
 *           'eval' for LLM-judge scores (reported with variance).
 * - `variance`: required when `kind === 'eval'`; used to guard before/after claims.
 */
export interface AxisScore {
  /** 1–10 ordinal, or null when the axis is eval-only and no eval has run. */
  score: number | null;
  lineage: LineageCategory;
  kind: ScoreKind;
  findings: Finding[];
  /** Variance / confidence reported for stochastic eval scores. */
  variance?: number;
}

// ---------------------------------------------------------------------------
// Aggregate score
// ---------------------------------------------------------------------------

/** Mean ± stdev over N eval runs. */
export interface EvalScore {
  mean: number;
  stdev: number;
  n: number;
}

/**
 * Aggregate scorecard scores (ADR-C weights).
 * - `lintScore`: deterministic headline — the badge-able number.
 * - `evalScore`: stochastic eval aggregate with variance (optional; absent
 *   when eval was not run).
 * - `weighted`: combined weighted aggregate (output-leanness ×1.5,
 *   param-strictness capped, rest ×1.0).
 */
export interface AggregateScore {
  lintScore: number;
  evalScore?: EvalScore;
  weighted: number;
}

// ---------------------------------------------------------------------------
// Per-tool report
// ---------------------------------------------------------------------------

/** Findings for a single server tool. */
export interface ToolReport {
  name: string;
  findings: Finding[];
}

// ---------------------------------------------------------------------------
// Scorecard — root shape for compat.json
// ---------------------------------------------------------------------------

/**
 * The complete compatibility scorecard emitted as `compat.json`.
 * Validates against `schemas/compat.schema.json`.
 */
export interface Scorecard {
  schemaVersion: string;
  server: ServerMeta;
  axes: Record<AxisName, AxisScore>;
  aggregate: AggregateScore;
  tools: ToolReport[];
}

// ---------------------------------------------------------------------------
// Task traces — one entry per line in evals.jsonl
// ---------------------------------------------------------------------------

/** Whether an agent argument was derivable from context or was hallucinated. */
export type ProvenanceEventType = 'fabricated' | 'traced' | 'literal';

/**
 * A provenance event records whether an agent-supplied tool argument was
 * traceable to a prior tool return or task literal ('traced' | 'literal'),
 * or was fabricated by the model ('fabricated').
 * Fabricated events feed the v1.1 data-provenance axis.
 */
export interface ProvenanceEvent {
  type: ProvenanceEventType;
  tool: string;
  param: string;
  value?: unknown;
}

/**
 * The result of the contract-rubric judge loop for one task.
 * - `score`: ordinal 1–10.
 * - `round`: the round at which scoring completed (early-stop at 10 or patience).
 */
export interface RubricResult {
  score: number;
  round: number;
}

/**
 * One task execution trace — a single line in `evals.jsonl`.
 * Validates against `schemas/evals.schema.json`.
 *
 * - `multiStep`: true when the task requires ≥2 sequential tool calls.
 * - `lowSignal`: true when the task is a trivial single-call (flagged per
 *   the selectivity principle — does not dominate the aggregate).
 */
export interface TaskTrace {
  taskId: string;
  multiStep: boolean;
  lowSignal: boolean;
  pass: boolean;
  tokenCost: number;
  chosenTools: string[];
  provenanceEvents: ProvenanceEvent[];
  rubric: RubricResult;
}

// ---------------------------------------------------------------------------
// MCP wire types — raw tool shape from the MCP protocol
// ---------------------------------------------------------------------------

/**
 * A single parameter definition from an MCP tool's inputSchema.
 * Index signature allows arbitrary JSON Schema extensions.
 */
export interface McpParam {
  type?: string;
  description?: string;
  enum?: unknown[];
  [key: string]: unknown;
}

/**
 * The inputSchema of an MCP tool — always a JSON Schema object type.
 * Index signature allows additional JSON Schema keywords.
 */
export interface McpInputSchema {
  type: 'object';
  properties?: Record<string, McpParam>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * Raw MCP tool definition as returned by tools/list.
 * This is the canonical shape for the lint engine input.
 * `outputSchema` is optional — declared by well-behaved servers to improve
 * output-leanness scores.
 */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: McpInputSchema;
  /** Optional output schema — tools declaring this score better on output-leanness. */
  outputSchema?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Introspection types — enriched tool and server shapes (B-001 connector)
// ---------------------------------------------------------------------------

/**
 * A tool definition enriched with lint findings.
 * Extends McpTool so it can be passed directly to the lint engine.
 * `findings` starts empty at introspection time and is populated by lint.
 */
export interface ToolDef extends McpTool {
  findings: Finding[];
}

/** A resource entry from MCP resources/list. */
export interface ResourceDef {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** A prompt entry from MCP prompts/list. */
export interface PromptDef {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/**
 * The complete result of introspecting an MCP server.
 * Returned by `introspect()` in src/connect/introspect.ts.
 */
export interface ServerIntrospection {
  server: ServerMeta;
  tools: ToolDef[];
  resources: ResourceDef[];
  prompts: PromptDef[];
}

// ---------------------------------------------------------------------------
// Description overrides — for the re-presentation proxy and fix-mode (B-001/B-007)
// ---------------------------------------------------------------------------

/**
 * An override record for a single tool's description and/or parameter
 * descriptions. Applied by the McpProxy and the fix-mode rewriter.
 */
export interface DescriptionOverride {
  /** Name of the tool to override. */
  tool: string;
  /** Replacement tool description (omit to leave unchanged). */
  description?: string;
  /** Map of param name → replacement description. */
  params?: Record<string, string>;
}
